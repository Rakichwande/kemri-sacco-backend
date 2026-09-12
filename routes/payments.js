const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const Payment = require('../models/Payment');
const { validatePaymentInitiation } = require('../middleware/validate');
const { authenticate, requireAdmin } = require('../middleware/auth');

router.post('/initiate', validatePaymentInitiation, paymentController.initiatePayment);
router.get('/status/:checkoutRequestId', paymentController.getPaymentStatus);

router.get('/admin/list', authenticate, requireAdmin, async (req, res) => {
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

module.exports = router;