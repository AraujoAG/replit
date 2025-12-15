// server.js - Versão V7 (Estabilidade com Cache e macOS)
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
const NodeCache = require('node-cache'); // NOVO: Para estabilidade

const app = express();
const corsOptions = { origin: '*', methods: "GET,POST,DELETE", credentials: true };
app.use(cors(corsOptions));
app.use(express.json());

// Usamos a mesma pasta, mas o código vai tentar limpá-la se der erro
const SESSION_PATH = '/data/session_v5_nova'; 

// Cache para mensagens repetidas (evita erro 515)
const msgRetryCounterCache = new NodeCache();

let socket = null;
let qrCode = '';
let connectionState = { status: 'disconnected', phoneNumber: '', isConnecting: false };

const safeDeleteSession = async () => {
    console.log(`🗑️ Limpando sessão em: ${SESSION_PATH}`);
    try {
        await fs.rm(SESSION_PATH, { recursive: true, force: true });
        console.log('✅ Sessão removida.');
    } catch (err) {
        console.error('❌ Erro ao limpar:', err);
    }
};

const connectToWhatsApp = async () => {
    console.log(`🔌 Iniciando conexão V7...`);

    // Busca versão mais recente para evitar ser barrado por versão antiga
    const { version } = await fetchLatestBaileysVersion();
    console.log(`ℹ️ Versão WA: v${version.join('.')}`);

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

    socket = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            // Cacheia as chaves para performance e estabilidade
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        msgRetryCounterCache, // O PULO DO GATO: Evita desconexão por retry
        generateHighQualityLinkPreview: true,
        // Usar macOS é a estratégia mais estável hoje
        browser: Browsers.macOS('Desktop'), 
        syncFullHistory: false, // Desativa sync pesado de histórico para não travar no login
        connectTimeoutMs: 60000,
        keepAliveIntervalMs: 30000 // Mantém a conexão ativa
    });

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            qrCode = qr;
            connectionState.status = 'connecting';
            console.log('\n🟡 QR Code V7 Gerado:\n');
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            console.log(`🔴 Conexão fechada. Motivo: ${statusCode}`);

            const shouldWipe = statusCode === 401 || statusCode === 403;

            socket = null;
            connectionState.status = 'disconnected';
            connectionState.isConnecting = false;
            qrCode = '';

            if (shouldWipe) {
                console.log(`⚠️ Erro fatal (${statusCode}). Resetando...`);
                setTimeout(async () => {
                    await safeDeleteSession();
                    console.log('🔄 Pronto para nova tentativa.');
                }, 2000);
            } else {
                // Se for 515 ou outros erros, reconecta sem apagar
                console.log('🟡 Reconectando automaticamente em 3s...');
                setTimeout(startConnectionProcess, 3000);
            }
        } else if (connection === 'open') {
            connectionState.status = 'connected';
            connectionState.phoneNumber = socket.user?.id?.split(':')[0];
            connectionState.isConnecting = false;
            qrCode = '';
            console.log(`✅ CONEXÃO ESTÁVEL: ${connectionState.phoneNumber}`);
        }
    });

    socket.ev.on('creds.update', saveCreds);
};

const startConnectionProcess = () => {
    if (connectionState.isConnecting || (socket && connectionState.status === 'connected')) return;
    connectionState.isConnecting = true;
    connectToWhatsApp().catch(err => {
        console.error("❌ Falha:", err);
        connectionState.isConnecting = false;
    });
};

// Rotas
app.post('/api/wpp/start-session', (req, res) => {
    if (connectionState.status === 'connected') return res.json({ success: true, message: 'Online.' });
    startConnectionProcess();
    res.json({ success: true, message: 'Iniciando...' });
});

app.get('/api/wpp/qr-code', (req, res) => {
    if (qrCode) res.json({ qrCode });
    else res.status(404).json({ error: 'Aguarde o QR Code...' });
});

app.get('/api/wpp/status', (req, res) => res.json(connectionState));

app.post('/api/wpp/reset-session', async (req, res) => {
    if (socket) { socket.end(undefined); socket = null; }
    await safeDeleteSession();
    res.json({ success: true, message: 'Resetado.' });
});

app.listen(8000, '0.0.0.0', () => console.log(`🚀 V7 Rodando na porta 8000`));
