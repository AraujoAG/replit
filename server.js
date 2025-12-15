// server.js - Versão V10 (FINAL)
console.log("\n\n✅✅✅ CÓDIGO V10 CARREGADO COM SUCESSO ✅✅✅");
console.log("Se você não ver essa mensagem, o arquivo não salvou!\n\n");

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
const NodeCache = require('node-cache'); // ESSENCIAL PARA O CELULAR NÃO GIRAR

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

// Mantemos a pasta V5
const SESSION_PATH = '/data/session_v5_nova'; 

// --- CORREÇÃO DO "GIRANDO" ---
// Esse cache responde aos pings do celular, impedindo que ele desconecte
const msgRetryCounterCache = new NodeCache();

let unauthorizedCount = 0;
let socket = null;
let qrCode = '';
let connectionState = { status: 'disconnected', phoneNumber: '', isConnecting: false };

const safeDeleteSession = async () => {
    console.log(`🗑️ Limpando sessão...`);
    try {
        await fs.rm(SESSION_PATH, { recursive: true, force: true });
        unauthorizedCount = 0;
    } catch (err) {}
};

const connectToWhatsApp = async () => {
    console.log(`🔌 V10: Iniciando conexão...`);

    const { version } = await fetchLatestBaileysVersion();
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

    socket = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        // AQUI ESTÁ A CORREÇÃO:
        msgRetryCounterCache, 
        // ---------------------
        generateHighQualityLinkPreview: true,
        browser: Browsers.macOS('Chrome'), // Identidade estável
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
            console.log('\n🟡 V10: NOVO QR CODE GERADO:\n');
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
                    console.log(`⚠️ Erro 401 (${unauthorizedCount}/3). Reconectando sem limpar...`);
                    setTimeout(startConnectionProcess, 2000);
                } else {
                    console.log(`⛔ Erro fatal. Limpando...`);
                    await safeDeleteSession();
                    setTimeout(startConnectionProcess, 3000);
                }
            } else if (statusCode === 515) {
                console.log('🔵 Erro 515 (Normal). Reconectando...');
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
            console.log(`✅✅✅ CONEXÃO ESTABELECIDA E ESTÁVEL: ${connectionState.phoneNumber} ✅✅✅`);
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

// Rotas
app.post('/api/wpp/start-session', (req, res) => {
    if (connectionState.status === 'connected') return res.json({ success: true, message: 'Online.' });
    startConnectionProcess();
    res.json({ success: true, message: 'Iniciando V10...' });
});

app.get('/api/wpp/qr-code', (req, res) => {
    if (qrCode) res.json({ qrCode });
    else res.status(404).json({ error: 'Aguardando QR...' });
});

app.get('/api/wpp/status', (req, res) => res.json(connectionState));

app.post('/api/wpp/reset-session', async (req, res) => {
    if (socket) { socket.end(undefined); socket = null; }
    await safeDeleteSession();
    res.json({ success: true, message: 'Reset V10 executado.' });
});

const port = process.env.PORT || 8000;
app.listen(port, '0.0.0.0', () => console.log(`🚀 SERVIDOR V10 RODANDO NA PORTA ${port}`));
