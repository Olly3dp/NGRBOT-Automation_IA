const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const Groq = require('groq-sdk');
const BotConfig = require('../models/BotConfig');
const User = require('../models/User');
const Subscription = require('../models/Subscription');
const ConversationHistory = require('../models/ConversationHistory');

class WhatsAppService {
  constructor() {
    this.clients = {};
    this.connecting = {};
    this.io = null;
    this.conversations = {}; // Armazena últimas 6 mensagens por usuário
  }

  setIO(io) {
    this.io = io;
  }

  getSessionPath(userId) {
    const sessionDir = path.join(__dirname, '../../sessions', `user_${userId}`);
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    return sessionDir;
  }

  async connect(userId) {
    if (this.clients[userId]) {
      return { alreadyConnected: true };
    }
    if (this.connecting[userId]) {
      return { connecting: true };
    }

    this.connecting[userId] = true;
    const sessionPath = this.getSessionPath(userId);

    try {
      const client = new Client({
        authStrategy: new LocalAuth({ dataPath: sessionPath }),
        puppeteer: {
          headless: 'new',
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu',
            '--disable-extensions'
          ]
        },
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        webVersionCache: {
          type: 'remote',
          remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html'
        }
      });

      client.on('qr', async (qr) => {
        try {
          const qrBase64 = await qrcode.toDataURL(qr);
          console.log(`[WhatsApp] QR Code gerado para usuario ${userId}`);
          if (this.io) {
            this.io.to(`user_${userId}`).emit('qr', qrBase64);
          }
        } catch (err) {
          console.error(`[WhatsApp] Erro ao processar QR:`, err.message);
        }
      });

      client.on('ready', () => {
        console.log(`[WhatsApp] Conectado: usuario ${userId}`);
        this.connecting[userId] = false;
        this.clients[userId] = client;
        if (this.io) {
          this.io.to(`user_${userId}`).emit('status', { connected: true, message: 'WhatsApp conectado!' });
          this.io.to(`user_${userId}`).emit('qr', null);
        }
      });

      client.on('auth_failure', (msg) => {
        console.error(`[WhatsApp] Falha autenticacao usuario ${userId}:`, msg);
        this.connecting[userId] = false;
        this.cleanup(userId);
        if (this.io) {
          this.io.to(`user_${userId}`).emit('status', { connected: false, message: `Falha: ${msg}` });
        }
      });

      client.on('disconnected', async (reason) => {
        console.log(`[WhatsApp] Desconectado usuario ${userId}: ${reason}`);
        this.connecting[userId] = false;
        this.cleanup(userId);
        const sessionPath = this.getSessionPath(userId);
        try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (e) {}
        if (this.io) {
          this.io.to(`user_${userId}`).emit('status', { connected: false, message: 'Desconectado' });
        }
      });

      client.on('message', async (message) => {
        // Filtro: não responde a grupos
        if (message.from.includes('@g.us')) return;
        
        // Filtro: não responde a si mesmo
        if (this.clients[userId] && this.clients[userId].info && this.clients[userId].info.wid) {
          const myNumber = this.clients[userId].info.wid._serialized;
          if (message.from._serialized === myNumber) return;
        }
        
        console.log('[NGR] Mensagem recebida:', message.body);
        
        try {
          // Busca dados do usuário no SQLite
          const user = await User.findByPk(userId);
          if (!user) return;
          
          const msgLower = message.body.toLowerCase().trim();
          
          // DIAGNÓSTICO
          console.log('[NGR] IA Ativa?', user.ai_active);
          console.log('[NGR] Modelo selecionado:', user.selected_model || 'llama-3.3-70b-versatile');
          
          // 1º PRIORIDADE: Fluxos Manuais (auto_flows)
          const userFlows = (user.auto_flows) || [];
          
          for (var i = 0; i < userFlows.length; i++) {
            var flow = userFlows[i];
            if (flow.keyword && msgLower.includes(flow.keyword.toLowerCase())) {
              console.log('[NGR] >> FLUXO ACIONADO:', flow.keyword);
              await client.sendMessage(message.from, flow.response);
              return;
            }
          }
          
          // 2º PRIORIDADE: Inteligência Artificial
          const iaAtiva = user.ai_active === true || user.ai_active === 1 || user.ai_active === undefined || user.ai_active === null;
          
          // Verifica o plano do usuário
          const subscription = await Subscription.findOne({ where: { userId: userId, status: 'active' } });
          const planType = subscription?.planType || 'fluxos';
          const isSmartPlan = planType === 'fluxos';
          
          if (isSmartPlan) {
            console.log('[NGR] >> PLANO SMART - IA BLOQUEADA');
            await client.sendMessage(message.from, '🔒 *Recurso exclusivo do plano PRO AI*\n\nEntre em contato para fazer o upgrade!');
            return;
          }
          
          if (iaAtiva && user.groq_key) {
            console.log('[NGR] >> CHAMANDO GROQ...');
            
            try {
              // Busca histórico do banco de dados (últimas 5 mensagens)
              const historyRecord = await ConversationHistory.findOne({
                where: { userId: userId, phoneNumber: message.from }
              });
              
              // Prepara mensagens com histórico do banco
              let messages = [];
              if (historyRecord && historyRecord.messages && historyRecord.messages.length > 0) {
                messages = [...historyRecord.messages];
                console.log('[NGR] Histórico do banco:', messages.length, 'mensagens');
              }
              
              const groq = new Groq({ apiKey: user.groq_key });
              const prompt = user.ai_prompt || 'Você é um assistente útil e amigável da NG Ruby. Responda de forma clara e objetiva.';
              
              // Adiciona mensagem atual ao histórico
              messages.push({ role: 'user', content: message.body });
              
              // Prepara mensagens completas para API
              const apiMessages = [
                { role: 'system', content: prompt },
                ...messages
              ];
              
              const model = user.selected_model || 'llama-3.3-70b-versatile';
              console.log('[NGR] Usando modelo:', model);
              console.log('[NGR] Total de mensagens para API:', apiMessages.length);
              
              const completion = await groq.chat.completions.create({
                messages: apiMessages,
                model: model,
                temperature: 0.7,
                max_tokens: 200
              });
              
              const reply = completion.choices[0]?.message?.content;
              if (reply) {
                console.log('[NGR] >> RESPOSTA IA:', reply.substring(0, 50) + '...');
                
                // Adiciona resposta ao histórico
                messages.push({ role: 'assistant', content: reply });
                
                // Salva histórico atualizado no banco (máximo 5 mensagens)
                const messagesToSave = messages.slice(-5);
                
                if (historyRecord) {
                  historyRecord.messages = messagesToSave;
                  await historyRecord.save();
                } else {
                  await ConversationHistory.create({
                    userId: userId,
                    phoneNumber: message.from,
                    messages: messagesToSave
                  });
                }
                
                await client.sendMessage(message.from, reply);
              } else {
                console.log('[NGR] >> Groq sem resposta, enviando menu');
                await client.sendMessage(message.from, 'Olá! 👋 Bem-vindo ao NGR Bot!\n\n1 - Nossos Serviços\n2 - Falar com Suporte');
              }
            } catch (groqErr) {
              console.error('[NGR] ERRO GROQ:', groqErr.message);
              await client.sendMessage(message.from, 'Olá! 👋 Bem-vindo ao NGR Bot!\n\n1 - Nossos Serviços\n2 - Falar com Suporte');
            }
            return;
          }
          
          // 3º PRIORIDADE: Menu de Saudação
          console.log('[NGR] >> ENVIANDO MENU');
          await client.sendMessage(message.from, 'Olá! 👋 Bem-vindo ao NGR Bot!\n\nEscolha uma opção:\n1 - Nossos Serviços\n2 - Falar com Suporte');
          
        } catch (err) {
          console.error('[NGR] ERRO:', err.message);
        }
      });

      client.initialize().catch((err) => {
        console.error(`[WhatsApp] Erro initialize usuario ${userId}:`, err.message);
        this.connecting[userId] = false;
        delete this.clients[userId];
        if (this.io) {
          this.io.to(`user_${userId}`).emit('status', { connected: false, message: `Erro: ${err.message}` });
        }
      });

      console.log(`[WhatsApp] Iniciando conexao para usuario ${userId}...`);
      return { success: true, connecting: true };
    } catch (error) {
      console.error(`[WhatsApp] Erro ao criar cliente usuario ${userId}:`, error.message);
      this.connecting[userId] = false;
      return { error: error.message };
    }
  }

  async disconnect(userId) {
    if (this.clients[userId]) {
      try { await this.clients[userId].destroy(); } catch (e) {}
      this.cleanup(userId);
    }
    this.connecting[userId] = false;
    const sessionPath = this.getSessionPath(userId);
    try { fs.rmSync(sessionPath, { recursive: true, force: true }); } catch (e) {}
    return { success: true };
  }

  getStatus(userId) {
    const client = this.clients[userId];
    const connecting = !!this.connecting[userId];
    if (connecting) return { connected: false, connecting: true };
    return { connected: !!(client && client.info && client.info.pushname), connecting: false };
  }

  cleanup(userId) {
    delete this.clients[userId];
    delete this.connecting[userId];
  }
}

module.exports = new WhatsAppService();