// server.js - Versão V11 (CORREÇÃO PARA KOYEB/DEPLOY)
console.log("🚀 INICIANDO V11 - AJUSTADO PARA DEPLOY KOYEB...");

const fs = require('fs/promises');
const express = require('express');
const cors = require('cors');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    Browsers, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const NodeCache = require('node-cache');

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

// --- MUDANÇA 1: Caminho relativo (Mais seguro para Koyeb/Containers) ---
const SESSION_PATH = './session_auth_info'; 

const msgRetryCounterCache = new NodeCache();
let unauthorizedCount = 0;
let socket = null;
let qrCode = '';
let connectionState = { status: 'disconnected', phoneNumber: '', isConnecting: false };

// --- MUDANÇA 2: Rota Raiz para o Health Check do Koyeb ---
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head><title>WhatsApp Bot V11</title></head>
            <body style="font-family: sans-serif; text-align: center; padding-top: 50px;">
                <h1>🟢 Servidor Online (V11)</h1>
                <p>Status: <b>${connectionState.status}</b></p>
                <p>Para conectar, verifique o terminal ou a rota /api/wpp/qr-code</p>
            </body>
        </html>
    `);
});

const safeDeleteSession = async () => {
    console.log(`🗑️ Limpando sessão em: ${SESSION_PATH}`);
    try {
        await fs.rm(SESSION_PATH, { recursive: true, force: true });
        unauthorizedCount = 0;
    } catch (err) {}
};

const connectToWhatsApp = async () => {
    console.log(`🔌 V11: Iniciando socket...`);
    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

    socket = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false, // Em produção, melhor ver pelo log ou endpoint
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        browser: Browsers.macOS('Chrome'),
        syncFullHistory: false, 
        markOnlineOnConnect: false,
        connectTimeoutMs: 60000, 
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 2000
    });

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            unauthorizedCount = 0;
            qrCode = qr;
            connectionState.status = 'connecting';
            console.log('\n🟡 QR CODE DISPONÍVEL (Verifique logs ou API)\n');
            // Mantemos o print para debug, mas em deploy as vezes corta linhas longas
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`🔴 Conexão fechada. Código: ${statusCode}`);

            socket = null;
            connectionState.status = 'disconnected';
            connectionState.isConnecting = false;
            qrCode = '';

            if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403) {
                if (statusCode === 401 && unauthorizedCount < 3) {
                    unauthorizedCount++;
                    console.log(`⚠️ Erro 401 (${unauthorizedCount}/3). Reconectando...`);
                    setTimeout(startConnectionProcess, 2000);
                } else {
                    console.log(`⛔ Erro fatal. Limpando...`);
                    await safeDeleteSession();
                    setTimeout(startConnectionProcess, 3000);
                }
            } else if (statusCode === 515) {
                console.log('🔵 Erro 515. Reconectando...');
                setTimeout(startConnectionProcess, 1000);
            } else {
                setTimeout(startConnectionProcess, 3000);
            }
        } else if (connection === 'open') {
            connectionState.status = 'connected';
            connectionState.phoneNumber = socket.user?.id?.split(':')[0];
            connectionState.isConnecting = false;
            unauthorizedCount = 0;
            qrCode = '';
            console.log(`✅ CONEXÃO ESTABELECIDA: ${connectionState.phoneNumber}`);
        }
    });

    socket.ev.on('creds.update', saveCreds);
};

const startConnectionProcess = () => {
    if (connectionState.isConnecting || (socket && connectionState.status === 'connected')) return;
    connectionState.isConnecting = true;
    connectToWhatsApp().catch(err => {
        console.error("❌ Falha crítica:", err);
        connectionState.isConnecting = false;
    });
};

app.post('/api/wpp/start-session', (req, res) => {
    if (connectionState.status === 'connected') return res.json({ success: true, message: 'Online.' });
    startConnectionProcess();
    res.json({ success: true, message: 'Iniciando V11...' });
});

app.get('/api/wpp/qr-code', (req, res) => {
    if (qrCode) res.json({ qrCode });
    else res.status(404).json({ error: 'Aguardando QR...' });
});

app.get('/api/wpp/status', (req, res) => res.json(connectionState));

app.post('/api/wpp/reset-session', async (req, res) => {
    if (socket) { socket.end(undefined); socket = null; }
    await safeDeleteSession();
    res.json({ success: true, message: 'Reset executado.' });
});

// Health check endpoint explícito
app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

const port = process.env.PORT || 8000;
app.listen(port, '0.0.0.0', () => console.log(`🚀 SERVIDOR V11 RODANDO NA PORTA ${port}`));
