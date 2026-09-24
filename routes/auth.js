const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();
const Admin = require('../models/Admin');
const { authenticate, requireAdmin, requirePermission } = require('../middleware/auth');
const { ROLES, canAssignRole } = require('../middleware/permissions');
const { JWT_SECRET } = require('../config/env');
const AuditLog = require('../models/AuditLog');
const StaffInvite = require('../models/StaffInvite');
const emailService = require('../services/emailService');
const crypto = require('crypto');
const {
  loginLimiter,
  otpLimiter,
  emailActionLimiter,
  emailPerAddressLimiter,
  passwordChangeLimiter,
  resetPasswordLimiter,
} = require('../middleware/rateLimit');

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://kemri-sacco-portal.onrender.com';
const OTP_EXPIRY_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;
const RESET_EXPIRY_MINUTES = 60;
const JWT_EXPIRY = '8h';

function issueSessionToken(admin) {
  const token = jwt.sign(
    { id: admin.id, username: admin.username, role: admin.role },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
  return {
    token,
    user: {
      id: admin.id,
      username: admin.username,
      full_name: admin.full_name,
      role: admin.role,
      must_change_password: admin.must_change_password,
    },
  };
}

function generateOtpCode() {
  return String(crypto.randomInt(100000, 999999)); // 6 digits
}

// All role values this app currently recognizes. 'admin' (Super
// Administrator) and 'staff' (legacy) are the original two; the rest are
// the board-approved roles added on top of them. See
// middleware/permissions.js for what each can actually do, and for
// canAssignRole(), which restricts who is allowed to grant which of these
// to someone else.
const VALID_ROLES = [
  ROLES.SUPER_ADMIN,      // 'admin'
  ROLES.SACCO_ADMIN,      // 'sacco_admin'
  ROLES.FINANCE_OFFICER,  // 'finance_officer'
  ROLES.LOANS_OFFICER,    // 'loans_officer'
  ROLES.MEMBER_SUPPORT,   // 'member_support'
  ROLES.AUDITOR,          // 'auditor'
  ROLES.STAFF_LEGACY,     // 'staff'
];

router.post('/login', loginLimiter, async (req, res) => {
  try {
    const { username, password } = req.body; // `username` field accepts username OR email
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const admin = await Admin.findByUsernameOrEmail(username);
    if (!admin) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const valid = await Admin.verifyPassword(admin, password);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // OTP only kicks in when the account has opted into email notifications,
    // has a real email on file, AND email sending is actually configured.
    // Any one of those missing falls back to normal password-only login -
    // this can never lock an account out over something outside its control.
    const otpEligible = admin.notify_email && admin.email && emailService.isConfigured();

    if (!otpEligible) {
      return res.json(issueSessionToken(admin));
    }

    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
    await Admin.setOtp(admin.id, code, expiresAt);

    const { subject, html, text } = emailService.otpEmailContent(code);
    await emailService.sendEmail({ to: admin.email, subject, html, text });

    // Short-lived token identifying WHICH login attempt this OTP belongs to -
    // not a session token, can't be used to access anything until verified.
    const otpToken = jwt.sign({ id: admin.id, purpose: 'otp' }, JWT_SECRET, { expiresIn: '15m' });

    res.json({
      otpRequired: true,
      otpToken,
      message: `A verification code was sent to ${admin.email.replace(/(.{2}).+(@.+)/, '$1***$2')}.`,
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/verify-otp', otpLimiter, async (req, res) => {
  try {
    const { otpToken, code } = req.body;
    if (!otpToken || !code) {
      return res.status(400).json({ error: 'otpToken and code are required' });
    }

    let payload;
    try {
      payload = jwt.verify(otpToken, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'This verification session has expired. Please log in again.' });
    }
    if (payload.purpose !== 'otp') {
      return res.status(401).json({ error: 'Invalid verification session.' });
    }

    const admin = await Admin.findById(payload.id);
    if (!admin || !admin.otp_code) {
      return res.status(401).json({ error: 'No pending verification. Please log in again.' });
    }
    if (new Date(admin.otp_expires_at) < new Date()) {
      await Admin.clearOtp(admin.id);
      return res.status(401).json({ error: 'This code has expired. Please log in again.' });
    }
    if (admin.otp_attempts >= OTP_MAX_ATTEMPTS) {
      await Admin.clearOtp(admin.id);
      return res.status(401).json({ error: 'Too many incorrect attempts. Please log in again.' });
    }

    if (code !== admin.otp_code) {
      const attempts = await Admin.incrementOtpAttempts(admin.id);
      return res.status(401).json({ error: `Incorrect code. ${Math.max(0, OTP_MAX_ATTEMPTS - attempts)} attempt(s) left.` });
    }

    await Admin.clearOtp(admin.id);
    res.json(issueSessionToken(admin));
  } catch (err) {
    console.error('OTP verification error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/resend-otp', emailActionLimiter, emailPerAddressLimiter, async (req, res) => {
  try {
    const { otpToken } = req.body;
    let payload;
    try {
      payload = jwt.verify(otpToken, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'This verification session has expired. Please log in again.' });
    }
    const admin = await Admin.findById(payload.id);
    if (!admin || !admin.email) {
      return res.status(401).json({ error: 'No pending verification. Please log in again.' });
    }

    const code = generateOtpCode();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
    await Admin.setOtp(admin.id, code, expiresAt);

    const { subject, html, text } = emailService.otpEmailContent(code);
    await emailService.sendEmail({ to: admin.email, subject, html, text });

    res.json({ message: 'A new code has been sent.' });
  } catch (err) {
    console.error('Resend OTP error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Deliberately responds the same way whether or not the account/email
// exists - standard practice, avoids letting someone probe which
// usernames or emails are registered.
router.post('/forgot-password', emailActionLimiter, emailPerAddressLimiter, async (req, res) => {
  const genericResponse = { message: 'If an account with that username or email exists and has an email on file, a reset link has been sent.' };
  try {
    const { identifier } = req.body;
    if (!identifier) return res.json(genericResponse);

    const admin = await Admin.findByUsernameOrEmail(identifier);
    if (admin && admin.email && emailService.isConfigured()) {
      const token = crypto.randomBytes(24).toString('base64url');
      const expiresAt = new Date(Date.now() + RESET_EXPIRY_MINUTES * 60 * 1000);
      await Admin.setResetToken(admin.id, token, expiresAt);

      const resetLink = `${FRONTEND_URL}/reset-password/${token}`;
      const { subject, html, text } = emailService.passwordResetEmailContent(resetLink);
      await emailService.sendEmail({ to: admin.email, subject, html, text });
    } else if (admin && !admin.email) {
      console.log(`Password reset requested for "${identifier}" but no email is on file - cannot send a reset link.`);
    }

    res.json(genericResponse);
  } catch (err) {
    console.error('Forgot password error:', err);
    res.json(genericResponse); // still generic, even on an internal error
  }
});

router.get('/reset-password/:token', async (req, res) => {
  try {
    const admin = await Admin.findByResetToken(req.params.token);
    if (!admin) return res.status(404).json({ error: 'This reset link is invalid or has already been used.' });
    if (new Date(admin.reset_token_expires_at) < new Date()) {
      return res.status(400).json({ error: 'This reset link has expired.' });
    }
    res.json({ valid: true, username: admin.username });
  } catch (err) {
    console.error('Reset token check error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/reset-password/:token', resetPasswordLimiter, async (req, res) => {
  try {
    const admin = await Admin.findByResetToken(req.params.token);
    if (!admin) return res.status(404).json({ error: 'This reset link is invalid or has already been used.' });
    if (new Date(admin.reset_token_expires_at) < new Date()) {
      return res.status(400).json({ error: 'This reset link has expired.' });
    }
    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }
    await Admin.resetPasswordWithToken(admin.id, newPassword);
    res.json({ message: 'Password updated. You can now log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/me', authenticate, async (req, res) => {
  try {
    const admin = await Admin.findById(req.user.id);
    if (!admin) return res.status(404).json({ error: 'Account not found' });
    res.json({ user: admin });
  } catch (err) {
    console.error('Fetch current user error:', err);
    res.status(500).json({ error: 'Failed to load account' });
  }
});

// Self-service - any logged-in staff/admin can update their own notification
// preferences and contact details, without needing another admin to do it.
router.patch('/me/notifications', authenticate, async (req, res) => {
  try {
    const { notify_sms, notify_email, phone, email, full_name } = req.body;
    const updated = await Admin.updateNotificationPreferences(req.user.id, { notify_sms, notify_email, phone, email, full_name });
    res.json(updated);
  } catch (err) {
    console.error('Notification preferences update error:', err);
    res.status(500).json({ error: 'Failed to update preferences' });
  }
});

// Any logged-in user can change their OWN password. Requires proving the
// current password first - never a silent overwrite. Rate-limited so a
// hijacked session can't brute-force the current password through this
// endpoint.
router.post('/change-password', authenticate, passwordChangeLimiter, async (req, res) => {
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

// Was requireAdmin (role === 'admin' only) - now requirePermission so a
// SACCO Administrator can also create staff accounts, not just Super
// Administrators. canAssignRole() below is what actually stops a SACCO
// Administrator from creating another Super Administrator or SACCO
// Administrator - staff:manage alone only gets you into this route, it
// doesn't mean you can grant any role to anyone.
router.post('/register', authenticate, requirePermission('staff:manage'), async (req, res) => {
  try {
    const { username, password, full_name, role, phone } = req.body;

    if (!username || !password || !full_name || !role) {
      return res.status(400).json({ error: 'username, password, full_name, and role are required' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }
    if (!canAssignRole(req.user.role, role)) {
      return res.status(403).json({ error: `Your role is not permitted to create an account with role "${role}".` });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existing = await Admin.findByUsername(username);
    if (existing) {
      return res.status(409).json({ error: 'This username is already taken' });
    }

    const newAccount = await Admin.create({ username, password, full_name, role, phone });
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

// --- Invite flow: admin sends an invite (email only + role), recipient
// picks their own username/password when they accept it. ---

router.post('/invites', authenticate, requirePermission('staff:manage'), async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email || !role) {
      return res.status(400).json({ error: 'email and role are required' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }
    if (!canAssignRole(req.user.role, role)) {
      return res.status(403).json({ error: `Your role is not permitted to invite someone as "${role}".` });
    }

    const invite = await StaffInvite.create({ email, role, invitedBy: req.user.id });
    const inviteLink = `${FRONTEND_URL}/accept-invite/${invite.token}`;

    const { subject, html, text } = emailService.inviteEmailContent({
      inviteLink, role, inviterName: req.user.username,
    });
    const emailResult = await emailService.sendEmail({ to: email, subject, html, text });

    await AuditLog.log({
      actorId: req.user.id,
      actorUsername: req.user.username,
      action: 'Invited staff member',
      category: 'staff_management',
      targetType: 'invite',
      targetId: invite.id,
      targetLabel: email,
      details: `Invited ${email} as ${role}.${emailResult.sent ? '' : ' Email not sent: ' + emailResult.reason}`,
    });

    res.status(201).json({
      invite: { id: invite.id, email: invite.email, role: invite.role, expiresAt: invite.expires_at },
      inviteLink,
      emailSent: emailResult.sent,
      emailReason: emailResult.reason || null,
    });
  } catch (err) {
    console.error('Invite creation error:', err);
    res.status(500).json({ error: 'Failed to create invite' });
  }
});

// Public - lets the accept-invite page show who invited them / what role,
// before asking them to set a password.
router.get('/invites/:token', async (req, res) => {
  try {
    const invite = await StaffInvite.findByToken(req.params.token);
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (invite.status !== 'pending') return res.status(400).json({ error: 'This invite has already been used' });
    if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'This invite has expired' });
    res.json({ email: invite.email, role: invite.role });
  } catch (err) {
    console.error('Invite lookup error:', err);
    res.status(500).json({ error: 'Failed to look up invite' });
  }
});

// Public - the recipient completes their own account setup
router.post('/invites/:token/accept', async (req, res) => {
  try {
    const invite = await StaffInvite.findByToken(req.params.token);
    if (!invite) return res.status(404).json({ error: 'Invite not found' });
    if (invite.status !== 'pending') return res.status(400).json({ error: 'This invite has already been used' });
    if (new Date(invite.expires_at) < new Date()) return res.status(400).json({ error: 'This invite has expired' });

    const { full_name, username, password, phone, notify_sms, notify_email } = req.body;
    if (!full_name || !username || !password) {
      return res.status(400).json({ error: 'full_name, username, and password are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    const existingUsername = await Admin.findByUsername(username);
    if (existingUsername) {
      return res.status(409).json({ error: 'This username is already taken' });
    }

    const newAccount = await Admin.create({
      username, password, full_name, role: invite.role, phone,
      email: invite.email, // captured automatically from the invite, not re-typed
      notify_sms, notify_email,
    });
    // The account they just set a real password for doesn't need the
    // must-change-password flag that bootstrap/admin-created accounts get.
    await Admin.updatePassword(newAccount.id, password);
    await StaffInvite.markAccepted(invite.id);

    await AuditLog.log({
      actorId: newAccount.id,
      actorUsername: newAccount.username,
      action: 'Accepted staff invite',
      category: 'staff_management',
      targetType: 'admin',
      targetId: newAccount.id,
      targetLabel: full_name,
      details: `Accepted invite as "${username}" (${invite.role}), invited to ${invite.email}.`,
    });

    res.status(201).json({ message: 'Account created. You can now log in.' });
  } catch (err) {
    console.error('Invite accept error:', err);
    res.status(500).json({ error: 'Failed to accept invite' });
  }
});

router.get('/users', authenticate, requirePermission('staff:manage'), async (req, res) => {
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
// with no way to promote anyone back. Also now checks canAssignRole(), so
// a SACCO Administrator can move someone between the operational roles but
// cannot promote anyone to Super Administrator or SACCO Administrator.
router.patch('/users/:id/role', authenticate, requirePermission('staff:manage'), async (req, res) => {
  try {
    const { role } = req.body;
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of: ${VALID_ROLES.join(', ')}` });
    }
    if (!canAssignRole(req.user.role, role)) {
      return res.status(403).json({ error: `Your role is not permitted to assign "${role}".` });
    }

    const target = await Admin.findById(req.params.id);
    if (!target) return res.status(404).json({ error: 'Account not found' });

    // canAssignRole() above only checked the NEW role - without this check
    // too, a SACCO Administrator could still demote or otherwise act on an
    // EXISTING Super Administrator or SACCO Administrator account, even
    // though they could never have created one. Both the target's current
    // role and the role being assigned have to be within what this actor
    // is allowed to touch.
    if (!canAssignRole(req.user.role, target.role)) {
      return res.status(403).json({ error: `Your role is not permitted to modify an account with role "${target.role}".` });
    }

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
router.delete('/users/:id', authenticate, requirePermission('staff:manage'), async (req, res) => {
  try {
    const targetId = Number(req.params.id);
    if (targetId === req.user.id) {
      return res.status(400).json({ error: 'You cannot remove your own account.' });
    }

    const target = await Admin.findById(targetId);
    if (!target) return res.status(404).json({ error: 'Account not found' });

    // Same reasoning as the role-change route above: prevents a lower-tier
    // account (e.g. SACCO Administrator) from removing a Super
    // Administrator or another SACCO Administrator, even though staff:manage
    // alone would otherwise let them reach this route.
    if (!canAssignRole(req.user.role, target.role)) {
      return res.status(403).json({ error: `Your role is not permitted to remove an account with role "${target.role}".` });
    }

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