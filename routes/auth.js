const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const Admin = require('../models/Admin');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { JWT_SECRET } = require('../config/env');
const AuditLog = require('../models/AuditLog');

const JWT_EXPIRY = '8h';
const VALID_ROLES = ['admin', 'staff'];

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const admin = await Admin.findByUsername(username);
    if (!admin) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const valid = await Admin.verifyPassword(admin, password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { id: admin.id, username: admin.username, role: admin.role },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRY }
    );
    res.json({
      token,
      user: {
        id: admin.id,
        username: admin.username,
        full_name: admin.full_name,
        role: admin.role,
        must_change_password: admin.must_change_password,
      },
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// Any logged-in user can change their OWN password. Requires proving the
// current password first - never a silent overwrite.
router.post('/change-password', authenticate, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'currentPassword and newPassword are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }
    if (newPassword === currentPassword) {
      return res.status(400).json({ error: 'New password must be different from the current one' });
    }

    const admin = await Admin.findByIdWithHash(req.user.id);
    if (!admin) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const validCurrent = await Admin.verifyPassword(admin, currentPassword);
    if (!validCurrent) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    await Admin.updatePassword(admin.id, newPassword);
    res.json({ message: 'Password updated successfully' });
  } catch (err) {
    console.error('Password change error:', err);
    res.status(500).json({ error: 'Failed to update password' });
  }
});

router.post('/register', authenticate, requireAdmin, async (req, res) => {
  try {
    const { username, password, full_name, role } = req.body;

    if (!username || !password || !full_name || !role) {
      return res.status(400).json({ error: 'username, password, full_name, and role are required' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await Admin.findByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'This username is already taken' });
    }

    const newAccount = await Admin.create({ username, password, full_name, role });
    await AuditLog.log({
      actorId: req.user.id,
      actorUsername: req.user.username,
      action: 'Created staff account',
      category: 'staff_management',
      targetType: 'admin',
      targetId: newAccount.id,
      targetLabel: full_name,
      details: `Created account "${username}" with role "${role}".`,
    });
    res.status(201).json(newAccount);
  } catch (err) {
    console.error('Account creation error:', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

router.get('/users', authenticate, requireAdmin, async (req, res) => {
  try {
    const users = await Admin.findAll();
    res.json(users);
  } catch (err) {
    console.error('Failed to list accounts:', err);
    res.status(500).json({ error: 'Failed to list accounts' });
  }
});

// Change another account's role. Guards against removing the last admin -
// otherwise a mistaken demotion could lock every admin out of the console
// with no way to promote anyone back.
router.patch('/users/:id/role', authenticate, requireAdmin, async (req, res) => {
  try {
    const { role } = req.body;
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }

    const target = await Admin.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Account not found' });

    if (target.role === 'admin' && role !== 'admin') {
      const allAdmins = (await Admin.findAll()).filter((a) => a.role === 'admin');
      if (allAdmins.length <= 1) {
        return res.status(400).json({ error: 'Cannot demote the last remaining admin account.' });
      }
    }

    const updated = await Admin.updateRole(req.params.id, role);
    await AuditLog.log({
      actorId: req.user.id,
      actorUsername: req.user.username,
      action: 'Changed staff role',
      category: 'staff_management',
      targetType: 'admin',
      targetId: req.params.id,
      targetLabel: target.full_name,
      details: `Changed role from ${target.role} to ${role}.`,
    });
    res.json(updated);
  } catch (err) {
    console.error('Role update error:', err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

// Remove a staff/admin account. Guards against removing yourself and against
// removing the last admin, for the same reason as above.
router.delete('/users/:id', authenticate, requireAdmin, async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'You cannot remove your own account.' });
    }

    const target = await Admin.findById(targetId);
    if (!target) return res.status(404).json({ error: 'Account not found' });

    if (target.role === 'admin') {
      const allAdmins = (await Admin.findAll()).filter((a) => a.role === 'admin');
      if (allAdmins.length <= 1) {
        return res.status(400).json({ error: 'Cannot remove the last remaining admin account.' });
      }
    }

    await Admin.remove(targetId);
    await AuditLog.log({
      actorId: req.user.id,
      actorUsername: req.user.username,
      action: 'Removed staff account',
      category: 'staff_management',
      targetType: 'admin',
      targetId: targetId,
      targetLabel: target.full_name,
      details: `Removed account "${target.username}" (${target.role}).`,
    });
    res.json({ message: 'Account removed.' });
  } catch (err) {
    console.error('Account removal error:', err);
    res.status(500).json({ error: 'Failed to remove account' });
  }
});

module.exports = router;