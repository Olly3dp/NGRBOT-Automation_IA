const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
require('dotenv').config();

const MP_ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
if (!MP_ACCESS_TOKEN) {
  console.error('[MercadoPago] Faltando MP_ACCESS_TOKEN no ambiente (.env).');
}
const mpClient = new MercadoPagoConfig({ accessToken: MP_ACCESS_TOKEN || '' });

const TRIAL_DAYS = 7;

const PLANS = {
  fluxos: {
    id: 'fluxos',
    name: 'NGR Fluxos',
    description: 'Fluxos automatizados (sem IA)',
    price: 27.90
  },
  pro: {
    id: 'pro',
    name: 'NGR Pro (IA)',
    description: 'Inteligência Artificial + Fluxos',
    price: 56.90
  }
};

async function createSubscription(userId, email, name, planType = 'pro') {
  try {
    const plan = PLANS[planType] || PLANS.pro;

    // Preferences (pagamento único via PIX) - MercadoPago SDK v3
    const preferenceBody = {
      items: [{
        title: `${plan.name} - Assinatura Mensal`,
        description: plan.description,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: plan.price
      }],
      payer: {
        email: email,
        name: name,
        identification: {
          type: 'CPF',
          number: '12345678909'
        }
      },
      payment_methods: {
        included_payment_methods: [{ id: 'pix' }]
      },
      back_urls: {
        success: 'http://localhost:3000/dashboard',
        pending: 'http://localhost:3000/dashboard',
        failure: 'http://localhost:3000/dashboard'
      },
      external_reference: JSON.stringify({ userId: userId, plan: planType }),
      notification_url: 'http://localhost:3000/webhook/mercadopago',
      auto_return: 'approved'
    };
    console.log('[MercadoPago] Enviando preference:', JSON.stringify(preferenceBody));

    const preferenceApi = new Preference(mpClient);
    const result = await preferenceApi.create({ body: preferenceBody });

    console.log('[MercadoPago] Resultado:', JSON.stringify(result).substring(0, 300));

    const response = result.response || result;
    const initPoint = response.init_point || response.sandbox_init_point || response.point_of_interaction?.transaction_data?.ticket_url || response.point_of_interaction?.transaction_data?.url || response.long_url;
    if (!initPoint) {
      throw new Error('URL de pagamento não gerada');
    }

    return {
      preferenceId: response.id,
      initPoint: initPoint,
      plan: planType
    };
  } catch (error) {
    console.error('[MercadoPago] Erro createSubscription:', error.message);
    throw new Error('Erro de conexão com MercadoPago: ' + error.message);
  }
}

async function processWebhook(payload) {
  try {
    if (payload.type !== 'payment') return null;

    const paymentId = payload.data.id;
    const paymentApi = new Payment(mpClient);
    const p = await paymentApi.get({ id: paymentId });

    // SDK v3 pode retornar direto ou em .body
    const status = p.status ?? p.body?.status;
    const externalRef = p.external_reference ?? p.body?.external_reference;

    let userId, plan = 'pro';
    try {
      const parsed = JSON.parse(externalRef);
      userId = parsed.userId;
      plan = parsed.plan || 'pro';
    } catch (e) {
      userId = externalRef;
    }

    return { status, paymentId, userId, plan };
  } catch (error) {
    console.error('Erro MP processWebhook:', error.message);
    return null;
  }
}

function isUserInTrial(user) {
  if (!user || !user.createdAt) return false;
  const createdDate = new Date(user.createdAt);
  const now = new Date();
  const diffTime = Math.abs(now - createdDate);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays <= TRIAL_DAYS;
}

module.exports = { createSubscription, processWebhook, isUserInTrial, PLANS };