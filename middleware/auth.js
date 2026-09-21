const jwt = require('jsonwebtoken');
const { JWT_SECRET } = require('../config/env');
const { roleHasPermission } = require('./permissions');

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
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