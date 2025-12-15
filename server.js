// server.js - Versão V8 (Persistência Agressiva e Tolerância a Falhas)
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
    delay // Importante para dar tempo ao disco
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal');
const NodeCache = require('node-cache');

const app = express();
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

// Mantemos a pasta V5
const SESSION_PATH = '/data/session_v5_nova'; 

// Cache para retry de mensagens
const msgRetryCounterCache = new NodeCache();

// Variável para controlar tentativas de erro 401 antes de desistir
let unauthorizedCount = 0;

let socket = null;
let qrCode = '';
let connectionState = { status: 'disconnected', phoneNumber: '', isConnecting: false };

const safeDeleteSession = async () => {
    console.log(`🗑️ Limpando SESSÃO DEFINITIVAMENTE em: ${SESSION_PATH}`);
    try {
        await fs.rm(SESSION_PATH, { recursive: true, force: true });
        console.log('✅ Sessão removida.');
        unauthorizedCount = 0; // Reseta contador
    } catch (err) {
        console.error('❌ Erro ao limpar:', err);
    }
};

const connectToWhatsApp = async () => {
    console.log(`🔌 Iniciando conexão V8... Tentativa de 401 atual: ${unauthorizedCount}`);

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
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        // Configurações vitais para evitar quedas no início
        browser: Browsers.macOS('Chrome'), 
        syncFullHistory: false, 
        markOnlineOnConnect: false, // Não ficar online imediatamente ajuda a estabilizar
        connectTimeoutMs: 60000, 
        defaultQueryTimeoutMs: undefined, // Deixa o Baileys decidir
        keepAliveIntervalMs: 10000,
        retryRequestDelayMs: 5000
    });

    socket.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            // Se gerou QR Code, reseta o contador de erros 401, pois é uma nova tentativa limpa
            unauthorizedCount = 0;
            qrCode = qr;
            connectionState.status = 'connecting';
            console.log('\n🟡 QR Code V8 Gerado (Escaneie Rápido):\n');
            qrcodeTerminal.generate(qr, { small: true });
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = lastDisconnect?.error?.shouldReconnect;
            
            console.log(`🔴 Conexão fechada. Código: ${statusCode} | Deve Reconectar: ${shouldReconnect}`);

            socket = null;
            connectionState.status = 'disconnected';
            connectionState.isConnecting = false;
            qrCode = '';

            // Lógica de Tratamento de Erros V8
            if (statusCode === DisconnectReason.loggedOut || statusCode === 401 || statusCode === 403) {
                
                // Se for 401, damos uma segunda chance antes de apagar tudo
                if (statusCode === 401 && unauthorizedCount < 2) {
                    unauthorizedCount++;
                    console.log(`⚠️ Erro 401 detectado (${unauthorizedCount}/2). Chave pode estar desatualizada. Tentando reconectar sem limpar...`);
                    setTimeout(startConnectionProcess, 2000);
                } else {
                    console.log(`⛔ Erro fatal ou limite de 401 atingido. Limpando sessão...`);
                    await safeDeleteSession();
                    console.log('🔄 Reiniciando processo limpo em 3s...');
                    setTimeout(startConnectionProcess, 3000);
                }

            } else if (statusCode === 515) {
                console.log('🔵 Erro 515 (Restart Required). Isso é normal! Reconectando em 2s...');
                // NÃO APAGA NADA AQUI
                setTimeout(startConnectionProcess, 2000);
            } else {
                console.log('🟡 Desconexão temporária. Reconectando...');
                setTimeout(startConnectionProcess, 3000);
            }

        } else if (connection === 'open') {
            connectionState.status = 'connected';
            connectionState.phoneNumber = socket.user?.id?.split(':')[0];
            connectionState.isConnecting = false;
            unauthorizedCount = 0; // Sucesso! Reseta contador
            qrCode = '';
            console.log(`✅ CONEXÃO V8 ESTABELECIDA E ESTÁVEL: ${connectionState.phoneNumber}`);
        }
    });

    // Salva as credenciais sempre que atualizarem
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
    res.json({ success: true, message: 'Iniciando V8...' });
});

app.get('/api/wpp/qr-code', (req, res) => {
    if (qrCode) res.json({ qrCode });
    else res.status(404).json({ error: 'Aguardando QR...' });
});

app.get('/api/wpp/status', (req, res) => res.json(connectionState));

app.post('/api/wpp/reset-session', async (req, res) => {
    if (socket) { socket.end(undefined); socket = null; }
    await safeDeleteSession();
    res.json({ success: true, message: 'Reset manual V8 executado.' });
});

app.listen(8000, '0.0.0.0', () => console.log(`🚀 V8 Rodando na porta 8000`));
