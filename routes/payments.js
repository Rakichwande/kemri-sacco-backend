const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');
const Payment = require('../models/Payment');
const { validatePaymentInitiation } = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');

// TODO (confirm before deploying): these two routes currently have NO
// authentication and NO rate limiting - validatePaymentInitiation only
// checks request shape (valid phone format, positive amount), not who's
// calling. As written, anyone can trigger a real M-Pesa STK push to any
// phone number by guessing/inventing a memberId, and anyone can look up
// payment status/amount/receipt for any checkout_request_id. Neither
// ussdController.js (which calls paymentService.initiatePayment directly,
// in-process) nor the portal (registration-only as of this review) appear
// to call these over HTTP - if that's confirmed, remove them the same way
// the equivalent dead loan routes were removed. If something DOES call
// these, they need member-session authentication (checking the caller
// actually IS the member in question, not just "some member") plus a rate
// limiter, before this goes anywhere near real production traffic.
// DISABLED as of 2026-09-20: confirmed exploitable in production - an
// unauthenticated request successfully triggered a real STK push using
// live Daraja credentials. Re-enable only once properly gated behind
// member-session authentication + rate limiting, and only once confirmed
// something legitimate actually needs them over HTTP.
// router.post('/initiate', validatePaymentInitiation, paymentController.initiatePayment);
// router.get('/status/:checkoutRequestId', paymentController.getPaymentStatus);

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

module.exports = router;