// server.js - Versão Final V3 (Correção de Pastas e Anti-405)
const fs = require('fs/promises');
const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const app = express();

const corsOptions = {
    origin: '*',
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    credentials: true,
    optionsSuccessStatus: 204
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

// --- CONSTANTE DO CAMINHO (Para garantir que lemos e apagamos o mesmo lugar) ---
// Mudamos para v3 para garantir zero arquivos velhos
const SESSION_PATH = '/data/session_final_v3'; 

let socket = null;
let qrCode = '';
let connectionState = {
    status: 'disconnected',
    phoneNumber: '',
    isConnecting: false
};

const connectToWhatsApp = async () => {
    console.log(`Iniciando conexão usando a pasta: ${SESSION_PATH}`);

    try {
        // Usa a constante SESSION_PATH
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

        socket = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            // --- CORREÇÃO: Navegador Ubuntu (Mais aceito pelo WhatsApp) ---
            browser: Browsers.ubuntu('Chrome'), 
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            markOnlineOnConnect: false
        });

        socket.ev.on('connection.update', async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCode = qr;
                connectionState.status = 'connecting';
                console.log('🟡 QR Code gerado. Escaneie para conectar.');
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔴 Conexão fechada. Motivo: ${statusCode || 'Desconhecido'}`);

                const shouldWipe = statusCode === 401 || statusCode === 405 || statusCode === 403;

                if (shouldWipe) {
                    console.log(`⚠️ Sessão inválida (${statusCode}). Limpando pasta de sessão...`);
                    try {
                        // --- CORREÇÃO: Apaga a variável SESSION_PATH correta ---
                        await fs.rm(SESSION_PATH, { recursive: true, force: true });
                        console.log('✅ Pasta de sessão removida com sucesso.');
                    } catch (err) {
                        console.error('❌ Erro ao limpar pasta:', err);
                    }
                }

                connectionState.isConnecting = false;
                socket = null;
                connectionState.status = 'disconnected';
                connectionState.phoneNumber = '';
                qrCode = '';

                if (!shouldWipe && statusCode !== DisconnectReason.loggedOut) {
                    console.log('🟡 Tentando reconectar em 10 segundos...');
                    setTimeout(startConnectionProcess, 10000);
                } else {
                    console.log('🔴 Sessão encerrada. Aguardando comando manual.');
                }

            } else if (connection === 'open') {
                connectionState.status = 'connected';
                connectionState.phoneNumber = socket.user?.id?.split(':')[0] || 'Desconhecido';
                connectionState.isConnecting = false;
                qrCode = '';
                console.log(`✅ Conexão estabelecida: ${connectionState.phoneNumber}`);
            }
        });

        socket.ev.on('creds.update', saveCreds);
        socket.ev.on('messages.upsert', () => {});

    } catch (error) {
        console.error('❌ Erro ao criar socket:', error);
        connectionState.isConnecting = false;
        connectionState.status = 'error';
    }
};

const startConnectionProcess = () => {
    if (connectionState.isConnecting || (socket && connectionState.status === 'connected')) return;
    
    connectionState.isConnecting = true;
    
    // --- CORREÇÃO: Delay de 2s para garantir estabilidade do disco ---
    console.log('⏳ Aguardando 2s para iniciar conexão...');
    setTimeout(() => {
        connectToWhatsApp().catch(err => {
            console.error("❌ Erro fatal:", err);
            connectionState.isConnecting = false;
            connectionState.status = 'error';
        });
    }, 2000);
};

// --- Endpoints ---

app.post('/api/wpp/start-session', (req, res) => {
    if (connectionState.status === 'connected') return res.json({ success: true, message: 'Já conectado.', ...connectionState });
    startConnectionProcess();
    res.json({ success: true, message: 'Iniciando...' });
});

app.get('/api/wpp/qr-code', (req, res) => {
    if (qrCode && connectionState.status !== 'connected') res.json({ qrCode });
    else res.status(404).json({ error: 'Sem QR Code.' });
});

app.get('/api/wpp/status', (req, res) => res.json(connectionState));

app.post('/api/wpp/send-message', async (req, res) => {
    const { phone, message } = req.body;
    if (!socket || connectionState.status !== 'connected') return res.status(400).json({ error: 'Desconectado.' });
    try {
        const id = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
        const [exists] = await socket.onWhatsApp(id);
        if (!exists?.exists) return res.status(400).json({ error: 'Número inválido.' });
        await socket.sendMessage(id, { text: message });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/wpp/close-session', async (req, res) => {
    if (socket) try { await socket.logout(); } catch (e) {}
    socket = null;
    connectionState.status = 'disconnected';
    qrCode = '';
    res.json({ success: true });
});

app.post('/api/wpp/reset-session', async (req, res) => {
    console.log('🟡 Reset manual...');
    if (socket) { socket.end(undefined); socket = null; }
    try { 
        // --- CORREÇÃO: Apaga a variável SESSION_PATH correta ---
        await fs.rm(SESSION_PATH, { recursive: true, force: true }); 
    } catch (e) {}
    connectionState = { status: 'disconnected', phoneNumber: '', isConnecting: false };
    qrCode = '';
    res.json({ success: true });
});

app.get('/health', (req, res) => res.json({ status: 'ok', whatsapp: connectionState }));

const port = process.env.PORT || 8000;
app.listen(port, '0.0.0.0', () => console.log(`🚀 Porta ${port}`));
