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
    status: 'disconnected', // disconnected, connecting, connected, error
    phoneNumber: '',
    isConnecting: false // Flag para prevenir múltiplas tentativas de conexão
};

// --- Funções de Conexão ---

// Função que efetivamente cria a conexão
const connectToWhatsApp = async () => {
    console.log('Iniciando uma nova instância de conexão Baileys...');

    try {
        // --- ALTERAÇÃO AQUI ---
        // A sessão agora será salva em um disco persistente montado em /data/
        const { state, saveCreds } = await useMultiFileAuthState('/data/auth_info_baileys');

        socket = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: Browsers.macOS('Desktop'),
            logger: pino({ level: 'silent' }),
            connectTimeoutMs: 60000,
            defaultQueryTimeoutMs: 0,
            keepAliveIntervalMs: 10000,
            generateHighQualityLinkPreview: true,
            syncFullHistory: false,
            markOnlineOnConnect: false
        });

    // Listener principal para o estado da conexão
        socket.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                qrCode = qr;
                connectionState.status = 'connecting';
                console.log('🟡 QR Code gerado. Escaneie para conectar.');
                qrcode.generate(qr, { small: true });
            }

            if (connection === 'close') {
                const statusCode = lastDisconnect?.error?.output?.statusCode;
                console.log(`🔴 Conexão fechada. Motivo: ${statusCode || 'Desconhecido'}`);

                // A tentativa de conexão atual terminou
                connectionState.isConnecting = false;
                socket = null;
                connectionState.status = 'disconnected';
                connectionState.phoneNumber = '';
                qrCode = '';

                // Lógica de reconexão inteligente
                const shouldReconnect = statusCode !== DisconnectReason.loggedOut && 
                                        statusCode !== DisconnectReason.connectionReplaced &&
                                        statusCode !== DisconnectReason.multideviceMismatch;

                if (shouldReconnect) {
                    console.log('🟡 Tentando reconectar em 10 segundos...');
                    setTimeout(startConnectionProcess, 10000); 
                } else {
                    console.log('🔴 Não será reconectado automaticamente. Sessão encerrada ou substituída.');
                }

            } else if (connection === 'open') {
                connectionState.status = 'connected';
                connectionState.phoneNumber = socket.user?.id?.split(':')[0] || 'Número não disponível';
                connectionState.isConnecting = false;
                qrCode = '';
                console.log(`✅ Conexão estabelecida com o número: ${connectionState.phoneNumber}`);
            }
        });

        // Listener para salvar as credenciais da sessão
        socket.ev.on('creds.update', saveCreds);

        // Listener para mensagens (para evitar erros)
        socket.ev.on('messages.upsert', (m) => {
            // Apenas processa para evitar warnings no console
        });

    } catch (error) {
        console.error('❌ Erro ao criar socket:', error);
        connectionState.isConnecting = false;
        connectionState.status = 'error';
        throw error;
    }
};

// Função "gatekeeper" para iniciar o processo de conexão
const startConnectionProcess = () => {
    // Previne que múltiplas tentativas de conexão ocorram ao mesmo tempo
    if (connectionState.isConnecting || socket) {
        console.log('🟡 Tentativa de iniciar, mas uma conexão/socket já está em andamento ou existe.');
        return;
    }

    connectionState.isConnecting = true;
    connectToWhatsApp().catch(err => {
        console.error("❌ Erro fatal ao tentar conectar ao WhatsApp:", err);
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
        res.status(404).json({ error: 'Nenhum QR Code disponível.' });
    }
});

app.get('/api/wpp/status', (req, res) => {
    res.json(connectionState);
});

app.post('/api/wpp/send-message', async (req, res) => {
    const { phone, message } = req.body;

    if (!socket || connectionState.status !== 'connected') {
        return res.status(400).json({ error: 'Sessão não está conectada.' });
    }
    if (!phone || !message) {
        return res.status(400).json({ error: 'O número (phone) e a mensagem (message) são obrigatórios.' });
    }

    try {
        // Remove caracteres especiais e garante formato correto
        const cleanPhone = phone.replace(/\D/g, '');
        const recipientId = `${cleanPhone}@s.whatsapp.net`;
        
        // Verifica se o número existe no WhatsApp
        const [result] = await socket.onWhatsApp(recipientId);
        if (!result || !result.exists) {
            return res.status(400).json({ error: 'Número não encontrado no WhatsApp.' });
        }
        
        await socket.sendMessage(recipientId, { text: message });
        console.log(`✉️ Mensagem enviada para ${cleanPhone}`);
        res.json({ success: true, message: `Mensagem enviada para ${cleanPhone}` });
    } catch (error) {
        console.error('❌ Erro ao enviar mensagem:', error);
        res.status(500).json({ success: false, error: 'Falha ao enviar mensagem.', details: error.message });
    }
});

app.post('/api/wpp/close-session', async (req, res) => {
    if (!socket) {
        // Se não há socket, apenas zera o estado e confirma
        connectionState.status = 'disconnected';
        connectionState.phoneNumber = '';
        connectionState.isConnecting = false;
        qrCode = '';
        return res.json({ success: true, message: 'Nenhuma sessão ativa para encerrar.' });
    }
    try {
        await socket.logout();
    } catch (error) {
       console.error('❌ Erro durante o logout (pode ser ignorado se a sessão já estava fechada):', error);
    } finally {
        socket = null;
        connectionState.status = 'disconnected';
        connectionState.phoneNumber = '';
        connectionState.isConnecting = false;
        qrCode = '';
        console.log('🔴 Sessão encerrada pelo usuário.');
        res.json({ success: true, message: 'Sessão encerrada.' });
    }
});

// Endpoint de saúde
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        whatsapp: connectionState 
    });
});

// Endpoint raiz
app.get('/', (req, res) => {
    res.json({ 
        message: 'WhatsApp Bot API - Baileys',
        status: connectionState.status,
        endpoints: [
            'POST /api/wpp/start-session',
            'GET /api/wpp/qr-code',
            'GET /api/wpp/status',
            'POST /api/wpp/send-message',
            'POST /api/wpp/close-session'
        ]
    });
});

const port = process.env.PORT || 5000;
app.listen(port, '0.0.0.0', () => {
    console.log(`🚀 Servidor rodando na porta ${port}`);
});