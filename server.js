// server.js - Versão Final Alta Linha Móveis
const fs = require('fs/promises');
const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcode = require('qrcode-terminal');

const app = express();

// --- Configuração do Express e CORS ---
const corsOptions = {
    origin: '*',
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    credentials: true,
    optionsSuccessStatus: 204
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));
app.use(express.json());

// --- Variáveis de Estado do WhatsApp ---
let socket = null;
let qrCode = '';
let connectionState = {
    status: 'disconnected',
    phoneNumber: '',
    isConnecting: false
};

// --- Funções de Conexão ---
const connectToWhatsApp = async () => {
    console.log('Iniciando uma nova instância de conexão Baileys...');

    try {
        // Usa a pasta /data/ para persistência no Koyeb ou local
        const { state, saveCreds } = await useMultiFileAuthState('/data/session_nova_v2');

        socket = makeWASocket({
            auth: state,
            printQRInTerminal: true,
            logger: pino({ level: 'silent' }),
            // Configuração anti-bloqueio
            browser: ['Alta Linha Móveis', 'Chrome', '120.0.0'], 
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

                // Se for erro de sessão (401, 403, 405), apaga tudo para resetar
                const shouldWipe = statusCode === 401 || statusCode === 405 || statusCode === 403;

                if (shouldWipe) {
                    console.log(`⚠️ Sessão inválida detectada (${statusCode}). Apagando credenciais antigas...`);
                    try {
                        await fs.rm('/data/auth_info_baileys', { recursive: true, force: true });
                        console.log('✅ Credenciais antigas removidas.');
                    } catch (err) {
                        console.error('❌ Erro ao apagar credenciais:', err);
                    }
                }

                connectionState.isConnecting = false;
                socket = null;
                connectionState.status = 'disconnected';
                connectionState.phoneNumber = '';
                qrCode = '';

                // Reconecta apenas se NÃO foi erro grave de sessão e NÃO foi logout manual
                const shouldReconnect = !shouldWipe && statusCode !== DisconnectReason.loggedOut;

                if (shouldReconnect) {
                    console.log('🟡 Tentando reconectar em 10 segundos...');
                    setTimeout(startConnectionProcess, 10000);
                } else {
                    console.log('🔴 Não será reconectado automaticamente. Sessão encerrada ou inválida.');
                }

            } else if (connection === 'open') {
                connectionState.status = 'connected';
                connectionState.phoneNumber = socket.user?.id?.split(':')[0] || 'Número não disponível';
                connectionState.isConnecting = false;
                qrCode = '';
                console.log(`✅ Conexão estabelecida com o número: ${connectionState.phoneNumber}`);
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
    if (connectionState.isConnecting || (socket && connectionState.status === 'connected')) {
        console.log('🟡 Tentativa de iniciar ignorada: conexão já em andamento.');
        return;
    }
    connectionState.isConnecting = true;
    connectToWhatsApp().catch(err => {
        console.error("❌ Erro fatal ao conectar:", err);
        connectionState.isConnecting = false;
        connectionState.status = 'error';
    });
};

// --- Endpoints da API ---

app.post('/api/wpp/start-session', (req, res) => {
    if (connectionState.status === 'connected') {
        return res.json({ success: true, message: 'Sessão já está conectada.', ...connectionState });
    }
    startConnectionProcess();
    res.json({ success: true, message: 'Iniciando sessão, aguarde o QR Code...' });
});

app.get('/api/wpp/qr-code', (req, res) => {
    if (qrCode && connectionState.status !== 'connected') {
        res.json({ qrCode: qrCode });
    } else {
        res.status(404).json({ error: 'Nenhum QR Code disponível no momento.' });
    }
});

app.get('/api/wpp/status', (req, res) => {
    res.json(connectionState);
});

app.post('/api/wpp/send-message', async (req, res) => {
    const { phone, message } = req.body;
    if (!socket || connectionState.status !== 'connected') return res.status(400).json({ error: 'Sessão desconectada.' });
    if (!phone || !message) return res.status(400).json({ error: 'Número e mensagem obrigatórios.' });

    try {
        const cleanPhone = phone.replace(/\D/g, '');
        const recipientId = `${cleanPhone}@s.whatsapp.net`;
        const [result] = await socket.onWhatsApp(recipientId);
        if (!result || !result.exists) return res.status(400).json({ error: 'Número não existe no WhatsApp.' });

        await socket.sendMessage(recipientId, { text: message });
        console.log(`✉️ Enviado para ${cleanPhone}`);
        res.json({ success: true, message: `Enviado para ${cleanPhone}` });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/wpp/close-session', async (req, res) => {
    if (socket) {
        try { await socket.logout(); } catch (e) {}
    }
    socket = null;
    connectionState.status = 'disconnected';
    qrCode = '';
    res.json({ success: true, message: 'Sessão encerrada.' });
});

app.post('/api/wpp/reset-session', async (req, res) => {
    console.log('🟡 Resetando sessão via API...');
    if (socket) { socket.end(undefined); socket = null; }
    try {
        await fs.rm('/data/auth_info_baileys', { recursive: true, force: true });
    } catch (e) {}
    connectionState = { status: 'disconnected', phoneNumber: '', isConnecting: false };
    qrCode = '';
    res.json({ success: true, message: 'Resetado. Inicie nova conexão.' });
});

app.get('/health', (req, res) => res.json({ status: 'ok', whatsapp: connectionState }));

const port = process.env.PORT || 8000;
app.listen(port, '0.0.0.0', () => console.log(`🚀 Servidor rodando na porta ${port}`));
