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
//
// NOTE: because this is IP-keyed, it only catches attacks from a single
// source. A distributed attack (botnet, IP rotation) needs the account-level
// lockout tracked in models/Admin.js to be effective - this limiter is one
// layer, not the whole story.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

// OTP verification: the account-level otp_attempts counter (5 tries, then
// invalidated - see routes/auth.js verify-otp) already guards a single login
// attempt. This adds a second, IP-based layer against someone hammering many
// different otpTokens. skipSuccessfulRequests so a correct OTP doesn't count
// against the limit.
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

// Resend OTP / forgot password: these trigger a real outbound email each
// time - this is as much about not letting someone spam a mailbox or run up
// Brevo usage as it is about security. IP-based.
const emailActionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

// Per-target-address layer for the same flows. An attacker rotating IPs
// (or a botnet) still can't spam one address, and the same address can't be
// hit more than 3 times an hour regardless of source.
//
// The key is derived from whichever identifier field the route uses:
//   - /forgot-password sends "identifier" (username OR email, user's choice)
//   - /resend-otp sends "otpToken" (no user-supplied identifier at all)
// So this falls back to the raw request IP when no identifier is present,
// which keeps the limiter keyed on something meaningful even for routes
// that don't carry a target address in the body.
//
// In-memory store is fine only because this app runs as a single instance
// (Render sets WEB_CONCURRENCY=1). If that ever changes, swap to a shared
// store (rate-limit-redis or similar) before scaling out - otherwise each
// instance has its own counter and the effective limit multiplies by the
// number of instances.
const emailPerAddressLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  keyGenerator: (req) => {
    const raw =
      req.body?.email ||
      req.body?.username ||
      req.body?.identifier ||
      '';
    const key = String(raw).trim().toLowerCase();
    // Fall back to IP when no address-shaped field is present (e.g. resend-otp,
    // where the target is derived server-side from the otpToken). This keeps
    // the limiter meaningful rather than throwing every such request into one
    // "email:" bucket.
    return key ? `email:${key}` : `email-ip:${req.ip}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

// Self-service password change. The endpoint requires the current password
// (so a hijacked session can't silently rotate the password), but without a
// limiter the current-password check becomes a brute-force target for
// whoever holds the session token. Small budget: legitimate users change
// their password once, maybe twice.
const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

// Reset-password completion. 24 random bytes means brute-forcing the token
// itself isn't practical, but the endpoint still hits the database on every
// call and is publicly reachable - a light limiter keeps noise and DB load
// bounded without getting in a real user's way.
const resetPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

module.exports = {
  loginLimiter,
  otpLimiter,
  emailActionLimiter,
  emailPerAddressLimiter,
  passwordChangeLimiter,
  resetPasswordLimiter,
};