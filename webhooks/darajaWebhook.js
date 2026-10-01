const express = require('express');
const router = express.Router();
const paymentService = require('../services/paymentService');
const disbursementService = require('../services/disbursementService');

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

// Safaricom posts here with the OUTCOME of a B2C disbursement. This is
// asynchronous — the request was initiated seconds earlier by a staff
// click, Safaricom returned "accepted" then, and this callback is where
// the real result (success or failure) arrives.
//
// The payload contains a Result.ConversationID that matches the
// ConversationID we stored on the loan when we moved it to 'disbursing'.
// The service uses that to find and resolve the loan.
//
// Idempotency: Safaricom retries on non-2xx. The service detects
// already-resolved callbacks and returns without re-applying side effects.
// See DisbursementService.handleB2CResult() for the guard.
router.post('/daraja/b2c/result', async (req, res) => {
  try {
    await disbursementService.handleB2CResult(req.body);
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('B2C result webhook error:', err);
    res.status(500).json({ ResultCode: 1, ResultDesc: 'Internal error, please retry' });
  }
});

// Safaricom posts here when a B2C request could not be completed within
// its processing window (member's phone off, network down, etc). Treat as
// failure: roll the loan back to 'approved' so staff can retry or
// disburse manually.
router.post('/daraja/b2c/timeout', async (req, res) => {
  try {
    await disbursementService.handleB2CTimeout(req.body);
    res.status(200).json({ ResultCode: 0, ResultDesc: 'Accepted' });
  } catch (err) {
    console.error('B2C timeout webhook error:', err);
    res.status(500).json({ ResultCode: 1, ResultDesc: 'Internal error, please retry' });
  }
});

module.exports = router;