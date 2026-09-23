// Verifies that a request to a USSD-facing route actually came from Africa's
// Talking's platform, not from anyone who discovers the URL directly.
//
// These routes (loans.js "member routes", repayments.js equivalents) were
// previously marked "no auth required - USSD uses these" with nothing
// actually checking that. A member-level JWT isn't the right fix here -
// USSD sessions are server-to-server (AT posts to us on the member's
// behalf) and never carry a per-member token. What we need instead is
// confirmation that the CALLER is genuinely Africa's Talking.
//
// WHY NOT IP WHITELISTING: an earlier version of this middleware also
// checked the caller's source IP against AT_USSD_ALLOWED_IPS. That check
// was removed because it cannot work correctly on Render. This app sits
// behind Render's edge + internal load balancer, so req.ip resolves to a
// private 10.x.x.x address (confirmed in production logs: 10.197.20.133,
// 10.192.163.192, 10.195.91.69), never to AT's actual public egress IP.
// A correctly-configured AT_USSD_ALLOWED_IPS list would therefore reject
// 100% of legitimate traffic and take USSD offline for every member.
// Express's `trust proxy` setting cannot fix this without knowing exactly
// how many hops Render's chain has, which is not documented and could
// change without notice.
//
// WHAT WE USE INSTEAD: a shared secret. Africa's Talking's dashboard
// "Callback URL" field is a plain URL with no way to attach a custom
// header, so the secret is embedded in the URL's query string and arrives
// on every real callback as req.query.key.
//
// The secret is treated as the sole authentication for this endpoint.
// Because query-string secrets end up in HTTP access logs (Render's, AT's,
// any intermediate proxy), it MUST be:
//   - long: at least 32 characters, base64-encoded random bytes, not a
//     human-memorable phrase
//   - rotated periodically (quarterly is a reasonable cadence)
//   - treated as semi-public: the real defense against abuse is monitoring
//     for unexpected call volume, not the secrecy of the key itself
//
// Set AT_USSD_SHARED_SECRET in Render's environment (see config/env.js,
// which fails fast at boot if it's missing or weak) and register the
// callback URL in the AT dashboard as:
//   https://kemri-sacco-backend.onrender.com/ussd?key=<AT_USSD_SHARED_SECRET>

const crypto = require('crypto');
const { AT_USSD_SHARED_SECRET } = require('../config/env');

// Constant-time comparison so a response-time difference can't leak the
// secret byte-by-byte. The practical risk over a public internet link is
// very low, but this is a two-line change and it's the right habit for
// comparing secrets anywhere in the codebase.
function secretsMatch(a, b) {
  if (!a || !b) return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function verifyUssdSource(req, res, next) {
  const providedSecret = req.query.key;

  if (!secretsMatch(providedSecret, AT_USSD_SHARED_SECRET)) {
    console.warn(
      `USSD route: rejected request with missing or invalid shared secret from ${req.ip}.`
    );
    // Return a valid USSD response in the format AT expects (plain text,
    // "END ..."), not a JSON 403. AT shows a generic "Service unavailable"
    // to the member when it gets anything other than a well-formed USSD
    // body, which looks identical to a real outage. Returning 200 with a
    // proper END message gives the member a clear, actionable response.
    // (HTTP status is intentionally 200 — AT's retry behavior on 4xx/5xx
    // is inconsistent and can amplify a misconfiguration into a loop.)
    res.set('Content-Type', 'text/plain');
    return res.status(200).send('END Service temporarily unavailable. Please try again shortly.');
  }

  next();
}

module.exports = { verifyUssdSource };