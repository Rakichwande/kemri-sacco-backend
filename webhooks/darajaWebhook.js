const express = require('express');
const router = express.Router();
const paymentService = require('../services/paymentService');

// Safaricom posts here after the member responds to the STK push (success, cancel, or timeout)
router.post('/daraja', async (req, res) => {
  try {
    await paymentService.handleCallback(req.body);
    // Safaricom just needs a 200 - it doesn't care about the response body
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('Webhook processing error:', err);
    // Still return 200 so Safaricom doesn't retry endlessly on our internal errors
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }
});

module.exports = router;
