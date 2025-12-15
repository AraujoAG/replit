// server.js - Versão V9 (COM CACHE DE RETRY E INDICADORES VISUAIS)
console.log("\n\n####################################################");
console.log("🚀 INICIANDO SERVIDOR V9 - VERSÃO COM CORREÇÃO DE CACHE 🚀");
console.log("####################################################\n\n");

const fs = require('fs/promises');
const express = require('express');
const cors = require('cors');
const { 
    default: makeWASocket, 
    useMultiFileAuthState, 
    DisconnectReason, 
    Browsers, 
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const NodeCache = require('node-cache'); // OBRIGATÓRIO

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

// Mantendo a pasta V5
const SESSION_PATH = '/data/session_v5_nova'; 

// --- CORREÇÃO CRÍTICA: CACHE DE MENSAGENS ---
// Sem isso, o celular trava no "Conectando..." e derruba a sessão
const msgRetryCounterCache = new NodeCache();

let unauthorizedCount = 0;
let socket = null;
let qrCode = '';
let connectionState = { status: 'disconnected', phoneNumber: '', isConnecting: false };

const safeDeleteSession = async () => {
    console.log(`🗑️ V9: Limpando sessão em: ${SESSION_PATH}`);
    try {
        await fs.rm(SESSION_PATH, { recursive: true, force: true });
        console.log('✅ Sessão removida.');
        unauthorizedCount = 0;
    } catch (err) {
        console.error('❌ Erro ao limpar:', err);
    }
};

const connectToWhatsApp = async () => {
    console.log(`🔌 V9: Iniciando conexão... Tentativa de erro 401: ${unauthorizedCount}`);

    const { version, isLatest } = await fetchLatestBaileysVersion();
    console.log(`ℹ️ Versão do WhatsApp: v${version.join('.')} (Latest: ${isLatest})`);

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

    socket = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            // Cacheia chaves para performance
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        // --- O SEGREDO ESTÁ AQUI EMBAIXO ---
        msgRetryCounterCache, 
        // -----------------------------------
        generateHighQualityLinkPreview: true,
        // Navegador macOS é o mais estável atualmente
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
            unauthorizedCount = 0; // Resetar contador se pediu QR novo
            qrCode = qr;
            connectionState.status = 'connecting';
            console.log('\n🟡 V9: NOVO QR CODE GERADO:\n');
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            
            console.log(`🔴 V9: Conexão fechada. Código: ${statusCode}`);

            socket = null;
            connectionState.status = 'disconnected';
            connectionState.isConnecting = false;
            qrCode = '';

            // LÓGICA INTELIGENTE DE ERROS
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403) {
                
                // Se der 401, a gente NÃO apaga na primeira vez. Damos uma chance.
                if (statusCode === 401 && unauthorizedCount < 3) {
                    unauthorizedCount++;
                    console.log(`⚠️ V9: Erro 401 (${unauthorizedCount}/3). Ignorando e reconectando...`);
                    // Pequeno delay e tenta de novo sem apagar a pasta
                    setTimeout(startConnectionProcess, 2000);
                } else {
                    console.log(`⛔ V9: Erro fatal persistente. Agora sim vamos limpar.`);
                    await safeDeleteSession();
                    console.log('🔄 Reiniciando limpo em 3s...');
                    setTimeout(startConnectionProcess, 3000);
                }

            } else if (statusCode === 515) {
                console.log('🔵 V9: Erro 515 (Restart Necessário). Isso é normal. Reconectando...');
                setTimeout(startConnectionProcess, 1000);
            } else {
                console.log('🟡 V9: Queda temporária. Voltando...');
                setTimeout(startConnectionProcess, 3000);
            }

        } else if (connection === 'open') {
            connectionState.status = 'connected';
            connectionState.phoneNumber = socket.user?.id?.split(':')[0];
            connectionState.isConnecting = false;
            unauthorizedCount = 0;
            qrCode = '';
            console.log(`✅ V9: CONEXÃO ESTABELECIDA COM SUCESSO: ${connectionState.phoneNumber}`);
        }
    });

    socket.ev.on('creds.update', saveCreds);
};

const startConnectionProcess = () => {
    if (connectionState.isConnecting || (socket && connectionState.status === 'connected')) return;
    connectionState.isConnecting = true;
    connectToWhatsApp().catch(err => {
        console.error("❌ V9: Falha crítica:", err);
        connectionState.isConnecting = false;
    });
};

// Rotas
app.post('/api/wpp/start-session', (req, res) => {
    if (connectionState.status === 'connected') return res.json({ success: true, message: 'Online.' });
    startConnectionProcess();
    res.json({ success: true, message: 'Iniciando V9...' });
});

app.get('/api/wpp/qr-code', (req, res) => {
    if (qrCode) res.json({ qrCode });
    else res.status(404).json({ error: 'Aguardando QR...' });
});

app.get('/api/wpp/status', (req, res) => res.json(connectionState));

app.post('/api/wpp/reset-session', async (req, res) => {
    if (socket) { socket.end(undefined); socket = null; }
    await safeDeleteSession();
    res.json({ success: true, message: 'Reset V9 executado.' });
});

app.listen(8000, '0.0.0.0', () => console.log(`🚀 SERVIDOR V9 RODANDO NA PORTA 8000`));
