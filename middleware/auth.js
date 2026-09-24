const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const { roleHasPermission } = require('./permissions');

// Full-path allowlist for requests that must remain reachable even when the
// caller's JWT carries must_change_password: true. These are the endpoints
// the user needs in order to actually resolve that state:
//   - /api/auth/change-password: lets them set a new password
//   - /api/auth/me: lets the frontend see who they are and show the
//     password-change prompt (needs to work BEFORE the password is changed)
//
// Paths here are matched against req.originalUrl with the query string
// stripped, because this middleware sits behind routers mounted at
// different prefixes (e.g. app.use('/api/auth', authRoutes)) and req.path
// would be relative to the mount point rather than the full request path.
const MUST_CHANGE_EXEMPT_PATHS = new Set([
  '/api/auth/change-password',
  '/api/auth/me',
]);

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  let decoded;
  try {
    decoded = jwt.verify(token, JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }

  req.user = decoded;

  // Enforce must_change_password. The flag is baked into the JWT at issue
  // time (see routes/auth.js issueSessionToken), so this runs without any
  // DB lookup per request. A token minted before a password change still
  // carries must_change_password: true - so the user's old token keeps them
  // restricted to the allowlisted paths above until they log in again to
  // receive a fresh token with the flag cleared. That is intentional: it
  // closes the window where a stale token could be used to skip the check.
  //
  // Note: tokens issued BEFORE this mechanism was deployed don't carry the
  // flag at all, so they pass through unrestricted until they expire
  // naturally. Not a problem - the flag takes effect from the next login.
  if (req.user.must_change_password) {
    const fullPath = (req.originalUrl || '').split('?')[0];
    if (!MUST_CHANGE_EXEMPT_PATHS.has(fullPath)) {
      return res.status(403).json({
        error: 'Password change required before accessing this resource.',
        must_change_password: true,
      });
    }
  }

  next();
}

// Unchanged from before - existing routes using requireAdmin keep working
// exactly as they do today. Left in place rather than rewritten so nothing
// currently gated by it needs to change at the same time as the new role
// system is introduced.
function requireAdmin(req, res, next) {
  if (req.user && req.user.role === 'admin') {
    next();
  } else {
    res.status(403).json({ error: 'Admin access required' });
  }
}

// New: gate a route by a specific permission (see middleware/permissions.js
// for the full role -> permission map) rather than a single binary
// admin/not-admin check. Usage:
//   router.post('/approve/:loanId', authenticate, requirePermission('loans:approve'), ...)
function requirePermission(permission) {
  return function (req, res, next) {
    if (req.user && roleHasPermission(req.user.role, permission)) {
      return next();
    }
    return res.status(403).json({ error: `Missing required permission: ${permission}` });
  };
}

module.exports = { authenticate, requireAdmin, requirePermission };