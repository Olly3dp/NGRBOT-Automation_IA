const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middlewares/auth');
const whatsappService = require('../services/whatsapp');

router.post('/connect', requireAuth, async (req, res) => {
  console.log(`[WhatsApp Route] POST /connect - usuario ${req.session.userId}`);
  try {
    const result = await whatsappService.connect(req.session.userId);
    console.log(`[WhatsApp Route] Resposta para usuario ${req.session.userId}:`, JSON.stringify(result));
    res.json(result);
  } catch (error) {
    console.error(`[WhatsApp Route] Erro usuario ${req.session.userId}:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

router.post('/disconnect', requireAuth, async (req, res) => {
  console.log(`[WhatsApp Route] POST /disconnect - usuario ${req.session.userId}`);
  try {
    const result = await whatsappService.disconnect(req.session.userId);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/status', requireAuth, (req, res) => {
  const status = whatsappService.getStatus(req.session.userId);
  res.json(status);
});

module.exports = router;