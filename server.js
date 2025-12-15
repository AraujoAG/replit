// server.js - Versão V5 (Caminho Novo + Debug de Arquivos)
const fs = require('fs/promises');
const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');

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

// --- CONSTANTE DO CAMINHO ---
// MUDANÇA CRÍTICA: Nome novo para fugir do cache/arquivos travados do Docker/SO
const SESSION_PATH = '/data/session_v5_nova'; 

let socket = null;
let qrCode = '';
let connectionState = {
    status: 'disconnected',
    phoneNumber: '',
    isConnecting: false
};

// Função auxiliar para deletar pasta com segurança
const safeDeleteSession = async () => {
    console.log(`🗑️ Tentando apagar pasta: ${SESSION_PATH}`);
    try {
        await fs.rm(SESSION_PATH, { recursive: true, force: true });
        console.log('✅ Pasta removida com sucesso.');
    } catch (err) {
        console.error('❌ Erro ao limpar pasta (pode estar bloqueada):', err);
    }
};

const connectToWhatsApp = async () => {
    console.log(`🔌 Iniciando processo de conexão em: ${SESSION_PATH}`);

    // --- DEBUG: Verifica se o arquivo já existe antes de conectar ---
    try {
        await fs.access(`${SESSION_PATH}/creds.json`);
        console.log('📂 AVISO: Arquivo de sessão (creds.json) ENCONTRADO. Tentando recuperar sessão...');
    } catch (e) {
        console.log('✨ INFO: Nenhum arquivo de sessão encontrado. Isso deve gerar um NOVO QR Code.');
    }
    // ---------------------------------------------------------------

    try {
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

        socket = makeWASocket({
            auth: state,
            printQRInTerminal: false, // Desativado (usaremos o manual abaixo)
            logger: pino({ level: 'silent' }),
            browser: ["Ubuntu", "Chrome", "20.0.04"], // Identidade estável
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
                console.log('\n🟡 QR Code gerado! Escaneie abaixo:\n');
                qrcodeTerminal.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔴 Conexão fechada. Motivo: ${statusCode || 'Desconhecido'}`);

                const shouldWipe = statusCode === 401 || statusCode === 405 || statusCode === 403;

                // Limpa referência do socket
                socket = null;
                connectionState.status = 'disconnected';
                connectionState.isConnecting = false;
                connectionState.phoneNumber = '';
                qrCode = '';

                if (shouldWipe) {
                    console.log(`⚠️ Sessão inválida (${statusCode}). Limpando tudo...`);
                    // Delay para garantir desbloqueio do arquivo
                    setTimeout(async () => {
                        await safeDeleteSession();
                        console.log('🔴 Sessão limpa. Reinicie o processo ou chame /start-session.');
                    }, 2000);
                } else if (statusCode !== DisconnectReason.loggedOut) {
                    console.log('🟡 Reconectando em 5s...');
                    setTimeout(startConnectionProcess, 5000);
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
        console.error('❌ Erro fatal ao criar socket:', error);
        connectionState.isConnecting = false;
        connectionState.status = 'error';
    }
};

const startConnectionProcess = () => {
    if (connectionState.isConnecting || (socket && connectionState.status === 'connected')) return;
    
    connectionState.isConnecting = true;
    console.log('⏳ Aguardando 2s para iniciar...');
    setTimeout(() => {
        connectToWhatsApp().catch(err => {
            console.error("❌ Falha na inicialização:", err);
            connectionState.isConnecting = false;
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
    else res.status(404).json({ error: 'QR Code indisponível.' });
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
    if (socket) {
        try { await socket.logout(); } catch (e) { socket.end(undefined); }
    }
    res.json({ success: true });
});

app.post('/api/wpp/reset-session', async (req, res) => {
    console.log('🟡 Reset manual solicitado...');
    if (socket) { 
        socket.ev.removeAllListeners();
        socket.end(undefined); 
        socket = null; 
    }
    connectionState = { status: 'disconnected', phoneNumber: '', isConnecting: false };
    qrCode = '';

    setTimeout(async () => {
        await safeDeleteSession();
        console.log('✨ Reset concluído na pasta nova.');
    }, 1000);

    res.json({ success: true, message: 'Resetado.' });
});

app.get('/health', (req, res) => res.json({ status: 'ok', whatsapp: connectionState }));

const port = process.env.PORT || 8000;
app.listen(port, '0.0.0.0', () => console.log(`🚀 Servidor rodando na porta ${port}`));
