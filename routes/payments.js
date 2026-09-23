const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const paymentController = require('../controllers/paymentController');
const Payment = require('../models/Payment');
const { validatePaymentInitiation } = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');

const paymentInitiateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment attempts. Please wait a few minutes and try again.' },
});

const paymentStatusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many status checks. Please wait a moment.' },
});

router.post('/initiate', paymentInitiateLimiter, validatePaymentInitiation, paymentController.initiatePayment);
router.get('/status/:checkoutRequestId', paymentStatusLimiter, paymentController.getPaymentStatus);

router.get('/admin/list', authenticate, requirePermission('payments:read'), async (req, res) => {
  try {
    const { search, from, to, limit, offset } = req.query;
    const contributions = await Payment.findAllAdmin({
      search, from, to,
      limit: limit ? Math.min(Number(limit), 200) : 50,
      offset: offset ? Number(offset) : 0,
    });
    res.json(contributions);
  } catch (err) {
    console.error('Contribution logs fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch contributions' });
  }
});

router.get('/:id/receipt', authenticate, requirePermission('payments:read'), async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }
    if (payment.status !== 'completed') {
      return res.status(400).json({ error: 'Receipt is only available for completed payments.' });
    }
    res.json(payment);
  } catch (err) {
    console.error('Receipt fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch receipt' });
  }
});

router.get('/receipt-by-receipt/:mpesaReceipt', authenticate, requirePermission('payments:read'), async (req, res) => {
  try {
    const payment = await Payment.findByMpesaReceipt(req.params.mpesaReceipt);
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found for that M-Pesa receipt.' });
    }
    if (payment.status !== 'completed') {
      return res.status(400).json({ error: 'Receipt is only available for completed payments.' });
    }
    res.json(payment);
  } catch (err) {
    console.error('Receipt-by-receipt fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch receipt' });
  }
});

module.exports = router;