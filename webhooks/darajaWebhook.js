const express = require('express');
const router = express.Router();
const paymentService = require('../services/paymentService');

// Safaricom posts here after the member responds to the STK push (success, cancel, or timeout)
router.post('/daraja', async (req, res) => {
  try {
    await paymentService.handleCallback(req.body);
    // Safaricom just needs a 200 - it doesn't care about the response body.
    // Reached whenever handleCallback completes normally: a genuine
    // success, a malformed/unrecognized checkout ID (nothing to retry), or
    // an already-claimed duplicate delivery (already being/been handled).
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    // handleCallback only throws for a genuine processing failure (a DB
    // error, a data-integrity problem) - malformed payloads and duplicate
    // deliveries are handled internally above and return normally without
    // throwing. So anything that reaches here is worth Safaricom actually
    // retrying: a 5xx tells Safaricom's own retry mechanism to try again
    // later, instead of always returning 200 and silently losing a
    // callback that was never actually processed.
    console.error('Webhook processing error:', err);
    res.status(500).json({ ResultCode: 1, ResultDesc: 'Internal error, please retry' });
  }
});

module.exports = router;