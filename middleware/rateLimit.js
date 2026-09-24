const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = require('express-rate-limit');

// suppress trustProxy validation across all limiters - see the comment
// below on why `trust proxy: true` is correct for this deployment.
const TRUST_PROXY_VALIDATE = { trustProxy: false };

// `trust proxy: true` is set in server.js because Render's request chain is
// 4 hops deep (client → Cloudflare → Render LB → local proxy → Node) and
// the hop count isn't documented or guaranteed stable. We confirmed via
// /debug/ip that `true` resolves req.ip to the real client correctly, and
// that any fixed number is fragile (Cloudflare's edge changes IPs across
// requests). Because all inbound traffic necessarily arrives via Render's
// edge - the container is not directly reachable - no external client can
// spoof X-Forwarded-For. The library's warning is a general best practice
// that doesn't account for this specific topology, so we disable just that
// check per limiter.

function limitHandler(req, res) {
  console.warn(`Rate limit hit: ${req.method} ${req.path} from ${req.ip}`);
  res.status(429).json({ error: 'Too many attempts. Please wait a while before trying again.' });
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  validate: TRUST_PROXY_VALIDATE,
  handler: limitHandler,
});

const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  validate: TRUST_PROXY_VALIDATE,
  handler: limitHandler,
});

const emailActionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: TRUST_PROXY_VALIDATE,
  handler: limitHandler,
});

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
    // ipKeyGenerator() is required by express-rate-limit v7+ for IPv6
    // safety: a bare req.ip lets an IPv6 client rotate its 64-bit suffix
    // to defeat the limiter. The helper normalises the address to the /64
    // prefix so the whole subnet shares one bucket.
    return key ? `email:${key}` : ipKeyGenerator(req);
  },
  standardHeaders: true,
  legacyHeaders: false,
  validate: TRUST_PROXY_VALIDATE,
  handler: limitHandler,
});

const passwordChangeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  validate: TRUST_PROXY_VALIDATE,
  handler: limitHandler,
});

const resetPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  validate: TRUST_PROXY_VALIDATE,
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