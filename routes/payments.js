const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const paymentController = require('../controllers/paymentController');
const Payment = require('../models/Payment');
const { validatePaymentInitiation } = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');

// This route has no login by design - a brand-new member completing their
// first contribution right after registering has no account yet, so
// staff-style JWT auth doesn't apply. It was previously disabled entirely
// after an unauthenticated request was confirmed to trigger a real STK
// push to an arbitrary phone number using live Daraja credentials. The
// real fix (in controllers/paymentController.js) is that the phone number
// now always comes from the member's own stored record, never from the
// request body - the caller can no longer choose who receives the prompt,
// only which existing member's own STK push to trigger. This rate limiter
// is the second layer: even with that fixed, nothing should allow rapid
// repeated triggering.
const paymentInitiateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment attempts. Please wait a few minutes and try again.' },
});

const paymentStatusLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60, // status polling happens automatically every few seconds while waiting
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

module.exports = router;