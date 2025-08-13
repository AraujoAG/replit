// server.js - Versão Final para Replit com CORS explícito
const express = require('express');
const cors = require('cors');
const { create } = require('@wppconnect-team/wppconnect');

const app = express();

// --- INÍCIO DA CONFIGURAÇÃO DE CORS CORRIGIDA ---
// Define as opções de CORS para ser mais explícito
const corsOptions = {
  origin: '*', // Permite qualquer origem.
  methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
  credentials: true,
  optionsSuccessStatus: 204 // Retorna status 204 para requisições de permissão (preflight)
};

// Aplica o middleware de CORS com as opções
app.use(cors(corsOptions));

// Garante que as requisições OPTIONS (preflight) sejam tratadas antes de qualquer outra rota
app.options('*', cors(corsOptions));
// --- FIM DA CONFIGURAÇÃO DE CORS CORRIGIDA ---


app.use(express.json());

let client = null;
let qrBase64 = '';
let isConnected = false;
let currentPhoneNumber = null;

// Iniciar sessão WhatsApp
app.post('/api/wpp/start-session', async (req, res) => {
  console.log('Recebida requisição para iniciar sessão...');
  try {
    if (client) {
      console.log('Sessão já iniciada anteriormente.');
      return res.json({ success: true, message: 'Sessão já iniciada' });
    }

    client = await create({
      session: 'cobrancas',
      autoClose: 0,
      catchQR: (base64Qr) => {
        qrBase64 = base64Qr;
        isConnected = false;
        console.log('🟡 QR Code recebido. Aguardando escaneamento...');
      },
      statusFind: (statusSession, session) => {
        console.log('📡 Status da sessão:', statusSession, `(${session})`);
      },
      onConnected: (sessionInfo) => {
        isConnected = true;
        currentPhoneNumber = sessionInfo?.wid?.user || null;
        console.log('✅ Sessão conectada com', currentPhoneNumber);
      }
    });

    res.json({ success: true, message: 'Sessão iniciada, aguardando QR Code...' });
  } catch (error) {
    console.error('❌ Erro detalhado ao iniciar sessão:', error);
    res.status(500).json({ error: error.message });
  }
});

// Obter QR Code atual
app.get('/api/wpp/qr-code', (req, res) => {
  if (qrBase64) {
    res.json({ qrCode: qrBase64 });
    qrBase64 = ''; 
  } else {
    res.status(404).json({ error: 'QR Code ainda não disponível ou já foi utilizado.' });
  }
});

// Verificar status da sessão
app.get('/api/wpp/status', (req, res) => {
  if (isConnected && client) {
    res.json({ status: 'connected', phoneNumber: currentPhoneNumber });
  } else {
    res.json({ status: 'disconnected' });
  }
});

// Enviar mensagem
app.post('/api/wpp/send-message', async (req, res) => {
  const { phone, message } = req.body;

  if (!client || !isConnected) {
    return res.status(400).json({ error: 'Sessão não iniciada ou não conectada.' });
  }

  try {
    await client.sendText(phone, message);
    res.json({ success: true });
  } catch (error) {
    console.error('❌ Erro detalhado ao enviar mensagem:', error);
    res.status(500).json({ error: error.message });
  }
});

// Encerrar sessão
app.post('/api/wpp/close-session', async (req, res) => {
  try {
    if (!client) {
      return res.status(400).json({ error: 'Nenhuma sessão ativa para encerrar.' });
    }

    await client.close();
    client = null;
    qrBase64 = '';
    isConnected = false;
    currentPhoneNumber = null;

    console.log('🔴 Sessão encerrada com sucesso.');
    res.json({ success: true, message: 'Sessão encerrada' });
  } catch (error) {
    console.error('❌ Erro detalhado ao encerrar sessão:', error);
    res.status(500).json({ error: error.message });
  }
});

// O Replit define a porta através de uma variável de ambiente
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 Servidor WPPConnect rodando na porta ${port}`);
});