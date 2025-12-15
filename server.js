// server.js - Versão V4 (Blindada contra Cache e File Lock)
const fs = require('fs/promises');
const express = require('express');
const cors = require('cors');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const pino = require('pino');
const qrcodeTerminal = require('qrcode-terminal'); // Renomeado para evitar confusão

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
const SESSION_PATH = '/data/session_final_v3'; 

let socket = null;
let qrCode = '';
let connectionState = {
    status: 'disconnected',
    phoneNumber: '',
    isConnecting: false
};

// Função auxiliar para deletar pasta com segurança (evita erro de arquivo preso)
const safeDeleteSession = async () => {
    console.log('🗑️ Iniciando limpeza dos arquivos de sessão...');
    try {
        // Tenta apagar a pasta
        await fs.rm(SESSION_PATH, { recursive: true, force: true });
        console.log('✅ Pasta de sessão removida com sucesso.');
    } catch (err) {
        console.error('❌ Erro ao limpar pasta (pode estar bloqueada):', err);
    }
};

const connectToWhatsApp = async () => {
    console.log(`🔌 Iniciando conexão usando a pasta: ${SESSION_PATH}`);

    try {
        const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);

        socket = makeWASocket({
            auth: state,
            printQRInTerminal: false, // Desativado para evitar o aviso deprecated
            logger: pino({ level: 'silent' }),
            // Usando uma string fixa ajuda na estabilidade
            browser: ["Ubuntu", "Chrome", "20.0.04"], 
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
                console.log('🟡 QR Code gerado abaixo:');
                // Gerador manual para substituir o printQRInTerminal
                qrcodeTerminal.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔴 Conexão fechada. Motivo: ${statusCode || 'Desconhecido'}`);

                const shouldWipe = statusCode === 401 || statusCode === 405 || statusCode === 403;

                // Limpa a referência do socket imediatamente para liberar memória/arquivos
                socket = null;
                connectionState.status = 'disconnected';
                connectionState.isConnecting = false;
                connectionState.phoneNumber = '';
                qrCode = '';

                if (shouldWipe) {
                    console.log(`⚠️ Sessão inválida (${statusCode}). Preparando limpeza...`);
                    // Pequeno delay para garantir que o processo soltou o arquivo
                    setTimeout(async () => {
                        await safeDeleteSession();
                        console.log('🔴 Sessão encerrada e limpa. Aguardando comando manual.');
                    }, 1000);
                } else if (statusCode !== DisconnectReason.loggedOut) {
                    console.log('🟡 Tentando reconectar em 5 segundos...');
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
    
    // Delay de segurança
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
    res.json({ success: true, message: 'Iniciando processo de conexão...' });
});

app.get('/api/wpp/qr-code', (req, res) => {
    if (qrCode && connectionState.status !== 'connected') res.json({ qrCode });
    else res.status(404).json({ error: 'QR Code indisponível (ou já conectado).' });
});

app.get('/api/wpp/status', (req, res) => res.json(connectionState));

app.post('/api/wpp/send-message', async (req, res) => {
    const { phone, message } = req.body;
    if (!socket || connectionState.status !== 'connected') return res.status(400).json({ error: 'Bot desconectado.' });
    try {
        const id = `${phone.replace(/\D/g, '')}@s.whatsapp.net`;
        const [exists] = await socket.onWhatsApp(id);
        if (!exists?.exists) return res.status(400).json({ error: 'Número não possui WhatsApp.' });
        await socket.sendMessage(id, { text: message });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post('/api/wpp/close-session', async (req, res) => {
    if (socket) {
        try { 
            await socket.logout(); 
            // O evento 'close' cuidará da limpeza
        } catch (e) {
            socket.end(undefined); // Força o fim se o logout falhar
        }
    }
    res.json({ success: true, message: 'Encerrando sessão...' });
});

app.post('/api/wpp/reset-session', async (req, res) => {
    console.log('🟡 Reset manual solicitado...');
    
    // 1. Destrói o socket e remove listeners para soltar o arquivo
    if (socket) { 
        socket.ev.removeAllListeners();
        socket.end(undefined); 
        socket = null; 
    }

    connectionState = { status: 'disconnected', phoneNumber: '', isConnecting: false };
    qrCode = '';

    // 2. Delay para o SO liberar o arquivo
    setTimeout(async () => {
        // 3. Apaga a pasta
        await safeDeleteSession();
        console.log('✨ Reset concluído. Pronto para iniciar nova sessão.');
    }, 1000);

    res.json({ success: true, message: 'Sessão resetada. Chame /start-session novamente.' });
});

app.get('/health', (req, res) => res.json({ status: 'ok', whatsapp: connectionState }));

const port = process.env.PORT || 8000;
app.listen(port, '0.0.0.0', () => console.log(`🚀 Servidor rodando na porta ${port}`));
