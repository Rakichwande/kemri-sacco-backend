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
// Two independent checks, both required:
//   1. Source IP is one of Africa's Talking's published outbound ranges.
//   2. A shared secret, configured independently in the AT dashboard
//      (as a custom header on the USSD callback) and in our own env vars,
//      is present and matches.
//
// Neither check alone is sufficient long-term: IP ranges can change without
// much notice, and a secret alone protects nothing if it ever leaks (a log
// line, a committed .env, a misconfigured proxy). Together, both have to
// hold for a request to be trusted as genuine USSD traffic.

const { AT_USSD_SHARED_SECRET, AT_USSD_ALLOWED_IPS } = require('../config/env');

// IMPORTANT: Africa's Talking's actual callback source IPs are NOT
// hardcoded here. A web search while writing this middleware did not turn
// up an authoritative, current list from AT's own docs - guessing at IP
// addresses for a security control is worse than not having one, since a
// wrong list either lets an attacker straight through or silently blocks
// AT's real traffic and breaks USSD for every member.
//
// Get the current list directly from Africa's Talking before deploying
// this: ask their support (help.africastalking.com) or your account rep
// for the callback/outbound IP ranges to whitelist for USSD, then set
//   AT_USSD_ALLOWED_IPS=1.2.3.4,5.6.7.8
// in your env vars. Until that's set, the IP check below is skipped
// (logged loudly) and the shared secret becomes your only real defense -
// which is why the secret is treated as required, not optional.

function getAllowedIps() {
  if (!AT_USSD_ALLOWED_IPS) return null;
  return AT_USSD_ALLOWED_IPS.split(',').map((ip) => ip.trim()).filter(Boolean);
}

function getClientIp(req) {
  // If you're behind a proxy/load balancer (Render, most PaaS hosts are),
  // req.ip alone may report the proxy's IP, not the real caller. Express's
  // `trust proxy` setting (set in server.js) makes req.ip resolve correctly
  // from X-Forwarded-For - make sure that's configured, or this check will
  // always fail (or always pass, if misconfigured the other way).
  return req.ip;
}

function verifyUssdSource(req, res, next) {
  const clientIp = getClientIp(req);
  const allowedIps = getAllowedIps();

  if (allowedIps) {
    if (!allowedIps.includes(clientIp)) {
      console.warn(`USSD route: rejected request from unrecognized IP: ${clientIp}`);
      return res.status(403).json({ error: 'Forbidden' });
    }
  } else {
    // No IP list configured yet - don't block on it, but make this loud
    // and impossible to miss in logs/monitoring until AT_USSD_ALLOWED_IPS
    // is set from a confirmed list.
    console.warn(
      `USSD route: AT_USSD_ALLOWED_IPS is not configured - skipping IP check ` +
      `for request from ${clientIp}. Get the real IP list from Africa's Talking ` +
      `support and set this env var before relying on this middleware.`
    );
  }

  // Africa's Talking's dashboard "Callback URL" field is a plain URL with
  // no way to attach a custom header from their side - so the secret can't
  // be sent as a header the way it could with a webhook provider that lets
  // you configure one. What AT WILL do is call exactly the URL you
  // register, including its query string, every time. So the secret is
  // embedded there instead: register the callback URL in AT's dashboard as
  //   https://your-backend.example.com/api/ussd?key=<AT_USSD_SHARED_SECRET>
  // and it arrives on every real callback as req.query.key.
  const providedSecret = req.query.key;
  if (!AT_USSD_SHARED_SECRET || providedSecret !== AT_USSD_SHARED_SECRET) {
    console.warn(`USSD route: rejected request with missing/invalid shared secret from IP: ${clientIp}`);
    return res.status(403).json({ error: 'Forbidden' });
  }

  next();
}

module.exports = { verifyUssdSource };