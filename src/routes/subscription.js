const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const { requireAuth, ADMIN_EMAIL, getTrialDaysRemaining, hasActivePaidSubscription } = require('../middlewares/auth');
const { User, Subscription } = require('../models');
const mercadoPagoService = require('../services/mercadopago');

router.get('/plans', (req, res) => {
  res.json(mercadoPagoService.PLANS);
});

// Rate limit para checkout: 5 tentativas a cada 15 minutos
const checkoutLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Muitas tentativas de pagamento. Tente novamente em 15 minutos.' },
  standardHeaders: true,
  legacyHeaders: false
});

router.post('/create-checkout', checkoutLimiter, requireAuth, async (req, res) => {
  try {
    const { plan } = req.body;
    const user = await User.findByPk(req.session.userId);
    if (!user) return res.status(404).json({ error: 'Usuário não encontrado' });
    if (user.email === ADMIN_EMAIL) {
      return res.json({ success: true, isAdmin: true, message: 'Admin - acesso permanente' });
    }
    
    // VALIDAÇÃO SERVER-SIDE (Anti-Fraude) - Ignora preço do frontend
    // O servidor força o preço correto baseado no plano
    let planType = 'pro';
    if (plan === 'fluxos' || plan === 'smart' || plan === 'NGR Smart') {
      planType = 'fluxos'; // R$ 27,90 forçado pelo servidor
    } else if (plan === 'pro' || plan === 'pro-ia' || plan === 'NGR Pro AI') {
      planType = 'pro'; // R$ 56,90 forçado pelo servidor
    } else {
      // Default: pro
      planType = 'pro';
    }
    
    console.log(`[Checkout] Plano recebido: ${plan} -> Forçado para: ${planType} (preço definido pelo servidor)`);
    
    // Verifica se está em período de trial - pode fazer upgrade
    const inTrial = mercadoPagoService.isUserInTrial(user);
    if (inTrial) {
      console.log(`[Checkout] Usuário ${user.id} em trial, gerando PIX para upgrade`);
    }
    
    console.log(`[Checkout] Criando preferência para usuario ${user.id}, plano: ${planType}`);
    
    const result = await mercadoPagoService.createSubscription(user.id, user.email, user.name, planType);
    console.log(`[Checkout] Preferência criada: ${result.preferenceId}`);
    
    await Subscription.update({ mpPreferenceId: result.preferenceId, planType }, { where: { userId: user.id } });
    res.json({ success: true, checkoutUrl: result.initPoint });
  } catch (error) {
    console.error('Erro checkout:', error.message);
    res.status(500).json({ error: error.message || 'Erro ao criar checkout - verifique sua conexão' });
  }
});

router.get('/status', requireAuth, async (req, res) => {
  try {
    const user = await User.findByPk(req.session.userId);
    console.log(`[Subscription Status] Usuario ${req.session.userId}`);
    
    if (user && user.email === ADMIN_EMAIL) {
      return res.json({ status: 'active', validUntil: 'indefinido', isActive: true, isAdmin: true, planName: 'Admin Premium' });
    }
    
    // Verifica se tem assinatura ativa (paga)
    const hasPaid = await hasActivePaidSubscription(req.session.userId);
    if (hasPaid) {
      const sub = await Subscription.findOne({ where: { userId: req.session.userId, status: 'active' } });
      const planName = sub.planType === 'fluxos' ? 'NGR Smart' : 'NGR Pro AI';
      const daysRemaining = Math.ceil((new Date(sub.validUntil) - new Date()) / (1000 * 60 * 60 * 24));
      console.log(`[Subscription Status] ASSINATURA ATIVA - ${planName}, ${daysRemaining} dias`);
      return res.json({ 
        status: 'active', 
        planType: sub.planType,
        planName: planName,
        validUntil: sub.validUntil, 
        isActive: true, 
        daysRemaining: daysRemaining
      });
    }
    
    // Verifica trial
    const daysRemaining = getTrialDaysRemaining(user);
    if (daysRemaining > 0) {
      console.log(`[Subscription Status] TRIAL ATIVO - ${daysRemaining} dias restantes`);
      return res.json({ 
        status: 'trial', 
        planName: 'Trial',
        validUntil: new Date(user.createdAt.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(), 
        isActive: true, 
        isTrial: true,
        daysRemaining: daysRemaining
      });
    }
    
    // Trial expirou
    console.log(`[Subscription Status] TRIAL EXPIRADO - Acesso bloqueado`);
    return res.json({ 
      status: 'expired', 
      trialExpired: true,
      planName: 'Nenhum',
      isActive: false, 
      isTrial: false,
      daysRemaining: 0,
      message: 'Seu período de teste gratuito acabou. Escolha um plano para continuar usando o NGR BOT.'
    });
  } catch (error) {
    console.error('Erro status:', error.message);
    res.status(500).json({ error: 'Erro interno' });
  }
});

router.post('/webhook', async (req, res) => {
  try {
    const result = await mercadoPagoService.processWebhook(req.body);
    if (result && result.status === 'approved') {
      const userId = parseInt(result.userId);
      const planType = result.plan || 'pro';
      if (userId) {
        const validUntil = new Date();
        validUntil.setDate(validUntil.getDate() + 30);
        await Subscription.update(
          { status: 'active', mpPaymentId: result.paymentId, validUntil, planType },
          { where: { userId } }
        );
        console.log(`Assinatura ativada para usuario ${userId} - Plano: ${planType}`);
      }
    }
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Erro webhook:', error.message);
    res.status(500).json({ error: 'Erro' });
  }
});

module.exports = router;