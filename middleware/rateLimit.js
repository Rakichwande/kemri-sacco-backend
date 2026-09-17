const rateLimit = require('express-rate-limit');

// Generic JSON error shape, consistent with the rest of the API's error responses.
function limitHandler(req, res) {
  res.status(429).json({ error: 'Too many attempts. Please wait a while before trying again.' });
}

// Login: generous enough for normal typos, tight enough to block brute-force
// password guessing against a known username/email.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

// OTP verification: the account-level otp_attempts counter (5 tries, then
// invalidated) already guards a single login attempt. This adds a second,
// IP-based layer against someone hammering many different otpTokens.
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

// Resend OTP / forgot password: these trigger a real outbound email each
// time - this is as much about not letting someone spam a mailbox or run
// up Brevo usage as it is about security.
const emailActionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  handler: limitHandler,
});

module.exports = { loginLimiter, otpLimiter, emailActionLimiter };
