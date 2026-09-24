const rateLimit = require('express-rate-limit');

// Generic JSON error shape, consistent with the rest of the API's error
// responses. Also logs to the console so rate-limit hits show up in Render
// logs - otherwise blocked users are invisible until someone complains.
function limitHandler(req, res) {
  console.warn(`Rate limit hit: ${req.method} ${req.path} from ${req.ip}`);
  res.status(429).json({ error: 'Too many attempts. Please wait a while before trying again.' });
}

// Login: generous enough for normal typos, tight enough to block brute-force
// password guessing against a known username/email. skipSuccessfulRequests
// means only failed attempts consume budget - a staff member who logs in
// correctly ten times in fifteen minutes isn't punished for it.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

// OTP verification: the account-level otp_attempts counter (5 tries, then
// invalidated) already guards a single login attempt. This adds a second,
// IP-based layer against someone hammering many different otpTokens.
// skipSuccessfulRequests so a correct OTP doesn't count against the limit.
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

// Resend OTP / forgot password: these trigger a real outbound email each
// time - this is as much about not letting someone spam a mailbox or run
// up Brevo usage as it is about security. IP-based.
const emailActionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

// Per-target-email layer for the same flows - an attacker rotating IPs
// (or a botnet) still can't spam one address, and the same address can't
// be hit more than 3 times an hour regardless of source. In-memory store
// is fine only because this app runs as a single instance (Render sets
// WEB_CONCURRENCY=1). If that ever changes, swap to a shared store
// (rate-limit-redis or similar) before scaling out.
const emailPerAddressLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) =>
    `email:${String(req.body?.email || req.body?.username || '').toLowerCase()}`,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

module.exports = {
  loginLimiter,
  otpLimiter,
  emailActionLimiter,
  emailPerAddressLimiter,
};