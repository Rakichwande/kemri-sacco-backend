// Verifies that a request to a USSD-facing route actually came from Africa's
// Talking's platform, not from anyone who discovers the URL directly.
//
// ... (Keep all your existing comments above) ...

const crypto = require('crypto');
const { AT_USSD_SHARED_SECRET } = require('../config/env');

// Constant-time comparison so a response-time difference can't leak the
// secret byte-by-byte.
function secretsMatch(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyUssdSource(req, res, next) {
  // 2026-11-01: BYPASS FOR STAGING/SANDBOX ONLY
  // When testing on the AT Simulator, we don't attach the ?key= query param.
  // If we are in a sandbox environment, we allow the request through.
  if (process.env.NODE_ENV === 'staging' || process.env.DARAJA_ENV === 'sandbox') {
    return next();
  }

  const providedSecret = req.query.key;

  if (!secretsMatch(providedSecret, AT_USSD_SHARED_SECRET)) {
    console.warn(
      `USSD route: rejected request with missing or invalid shared secret from ${req.ip}.`
    );
    res.set('Content-Type', 'text/plain');
    return res.status(200).send('END Service temporarily unavailable. Please try again shortly.');
  }

  next();
}

module.exports = { verifyUssdSource };