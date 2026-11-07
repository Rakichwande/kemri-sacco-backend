const crypto = require('crypto');
const db = require('../config/database');
const bcrypt = require('bcryptjs');

const createAdminTableQuery = `
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  role VARCHAR(20) DEFAULT 'admin',
  must_change_password BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW()
);
`;

const addMustChangeColumnQuery = `
ALTER TABLE admins ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT true;
`;
const addPhoneColumnQuery = `
ALTER TABLE admins ADD COLUMN IF NOT EXISTS phone VARCHAR(15);
`;
const addNotificationColumnsQuery = `
ALTER TABLE admins ADD COLUMN IF NOT EXISTS email VARCHAR(150);
ALTER TABLE admins ADD COLUMN IF NOT EXISTS notify_sms BOOLEAN DEFAULT true;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS notify_email BOOLEAN DEFAULT false;
`;
const addAuthSecurityColumnsQuery = `
ALTER TABLE admins ADD COLUMN IF NOT EXISTS otp_code VARCHAR(10);
ALTER TABLE admins ADD COLUMN IF NOT EXISTS otp_expires_at TIMESTAMP;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS otp_attempts INT DEFAULT 0;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS reset_token VARCHAR(64);
ALTER TABLE admins ADD COLUMN IF NOT EXISTS reset_token_expires_at TIMESTAMP;
`;

// 2026-11-06: Added TOTP 2FA Columns
const add2FAColumnsQuery = `
ALTER TABLE admins ADD COLUMN IF NOT EXISTS two_factor_secret VARCHAR(255);
ALTER TABLE admins ADD COLUMN IF NOT EXISTS two_factor_enabled BOOLEAN DEFAULT false;
`;

// 2026-11-07: Added Account Lockout Columns
const addLockoutColumnsQuery = `
ALTER TABLE admins ADD COLUMN IF NOT EXISTS failed_login_attempts INT DEFAULT 0;
ALTER TABLE admins ADD COLUMN IF NOT EXISTS locked_until TIMESTAMP;
`;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateRandomPassword() {
  return crypto.randomBytes(24).toString('base64url');
}

async function init() {
  await db.query(createAdminTableQuery);
  await db.query(addMustChangeColumnQuery);
  await db.query(addPhoneColumnQuery);
  await db.query(addNotificationColumnsQuery);
  await db.query(addAuthSecurityColumnsQuery);
  await db.query(add2FAColumnsQuery);
  await db.query(addLockoutColumnsQuery);

  const existing = await db.query('SELECT * FROM admins LIMIT 1');
  if (existing.rows.length > 0) return;

  const bootstrapUsername = process.env.ADMIN_BOOTSTRAP_USERNAME || 'admin';
  const bootstrapPassword = process.env.ADMIN_BOOTSTRAP_PASSWORD || generateRandomPassword();

  const hash = await bcrypt.hash(bootstrapPassword, 10);
  await db.query(
    `INSERT INTO admins (username, password_hash, full_name, must_change_password)
     VALUES ($1, $2, 'System Administrator', true)`,
    [bootstrapUsername, hash]
  );

  if (process.env.ADMIN_BOOTSTRAP_PASSWORD) {
    console.log(`Bootstrap admin created from ADMIN_BOOTSTRAP_USERNAME/PASSWORD (username: ${bootstrapUsername}).`);
  } else {
    console.log('==============================================================');
    console.log('No ADMIN_BOOTSTRAP_PASSWORD set — generated a one-time password.');
    console.log(`  username: ${bootstrapUsername}`);
    console.log(`  password: ${bootstrapPassword}`);
    console.log('Log in and change it immediately. This will not be shown again.');
    console.log('==============================================================');
  }
}

async function findByUsername(username) {
  const result = await db.query('SELECT * FROM admins WHERE username = $1', [username]);
  return result.rows[0];
}

async function findByUsernameOrEmail(identifier) {
  const result = await db.query(
    'SELECT * FROM admins WHERE username = $1 OR email = $1',
    [identifier]
  );
  return result.rows[0];
}

async function setOtp(id, code, expiresAt) {
  await db.query(
    'UPDATE admins SET otp_code = $1, otp_expires_at = $2, otp_attempts = 0 WHERE id = $3',
    [code, expiresAt, id]
  );
}

async function clearOtp(id) {
  await db.query(
    'UPDATE admins SET otp_code = NULL, otp_expires_at = NULL, otp_attempts = 0 WHERE id = $1',
    [id]
  );
}

async function incrementOtpAttempts(id) {
  const result = await db.query(
    'UPDATE admins SET otp_attempts = otp_attempts + 1 WHERE id = $1 RETURNING otp_attempts',
    [id]
  );
  return result.rows[0]?.otp_attempts;
}

async function setResetToken(id, token, expiresAt) {
  await db.query(
    'UPDATE admins SET reset_token = $1, reset_token_expires_at = $2 WHERE id = $3',
    [hashToken(token), expiresAt, id]
  );
}

async function findByResetToken(token) {
  const result = await db.query(
    'SELECT * FROM admins WHERE reset_token = $1 AND reset_token_expires_at > NOW()',
    [hashToken(token)]
  );
  return result.rows[0];
}

async function resetPasswordWithToken(token, newPassword) {
  const hash = await bcrypt.hash(newPassword, 10);
  const result = await db.query(
    `UPDATE admins
     SET password_hash = $1,
         must_change_password = false,
         reset_token = NULL,
         reset_token_expires_at = NULL,
         failed_login_attempts = 0,
         locked_until = NULL
     WHERE reset_token = $2 AND reset_token_expires_at > NOW()
     RETURNING id, username`,
    [hash, hashToken(token)]
  );
  return result.rows[0] || null;
}

async function findById(id) {
  const result = await db.query(
    'SELECT id, username, full_name, role, phone, email, notify_sms, notify_email, two_factor_enabled, must_change_password, created_at FROM admins WHERE id = $1',
    [id]
  );
  return result.rows[0];
}

async function findByIdWithAuthFields(id) {
  const result = await db.query('SELECT * FROM admins WHERE id = $1', [id]);
  return result.rows[0];
}

async function verifyPassword(admin, password) {
  return await bcrypt.compare(password, admin.password_hash);
}

async function create({ username, password, full_name, role, phone, email, notify_sms, notify_email }) {
  const hash = await bcrypt.hash(password, 10);
  const result = await db.query(
    `INSERT INTO admins (username, password_hash, full_name, role, phone, email, notify_sms, notify_email, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true)
     RETURNING id, username, full_name, role, phone, email, notify_sms, notify_email, must_change_password, created_at`,
    [
      username, hash, full_name, role, phone || null, email || null,
      notify_sms === undefined ? true : notify_sms,
      notify_email === undefined ? false : notify_email,
    ]
  );
  return result.rows[0];
}

async function updateNotificationPreferences(id, { notify_sms, notify_email, phone, email, full_name }) {
  const result = await db.query(
    `UPDATE admins SET
       notify_sms = COALESCE($1, notify_sms),
       notify_email = COALESCE($2, notify_email),
       phone = COALESCE($3, phone),
       email = COALESCE($4, email),
       full_name = COALESCE($5, full_name)
     WHERE id = $6
     RETURNING id, username, full_name, role, phone, email, notify_sms, notify_email, two_factor_enabled`,
    [notify_sms, notify_email, phone, email, full_name, id]
  );
  return result.rows[0];
}

async function findAll() {
  const result = await db.query(
    'SELECT id, username, full_name, role, phone, email, notify_sms, notify_email, two_factor_enabled, must_change_password, created_at FROM admins ORDER BY created_at DESC'
  );
  return result.rows;
}

async function updatePassword(id, newPassword) {
  const hash = await bcrypt.hash(newPassword, 10);
  const result = await db.query(
    `UPDATE admins SET password_hash = $1, must_change_password = false, failed_login_attempts = 0, locked_until = NULL WHERE id = $2
     RETURNING id, username, full_name, role, must_change_password`,
    [hash, id]
  );
  return result.rows[0];
}

async function findByIdWithHash(id) {
  const result = await db.query('SELECT * FROM admins WHERE id = $1', [id]);
  return result.rows[0];
}

async function updateRole(id, role) {
  const result = await db.query(
    `UPDATE admins SET role = $1 WHERE id = $2
     RETURNING id, username, full_name, role, must_change_password, created_at`,
    [role, id]
  );
  return result.rows[0];
}

async function remove(id) {
  await db.query('DELETE FROM admins WHERE id = $1', [id]);
}

async function setTwoFactorSecret(id, secret) {
  await db.query(
    'UPDATE admins SET two_factor_secret = $1 WHERE id = $2',
    [secret, id]
  );
}

async function enableTwoFactor(id) {
  await db.query(
    'UPDATE admins SET two_factor_enabled = true WHERE id = $1',
    [id]
  );
}

async function disableTwoFactor(id) {
  await db.query(
    'UPDATE admins SET two_factor_enabled = false, two_factor_secret = NULL WHERE id = $1',
    [id]
  );
}

// 2026-11-07: Account Lockout Helpers
function isAccountLocked(admin) {
  return !!admin.locked_until && new Date(admin.locked_until) > new Date();
}

async function recordFailedLogin(adminId) {
  // Increment failed attempts. If it reaches 5, lock the account for 30 minutes.
  const result = await db.query(
    `UPDATE admins
     SET failed_login_attempts = failed_login_attempts + 1,
         locked_until = CASE 
           WHEN failed_login_attempts + 1 >= 5 THEN NOW() + INTERVAL '30 minutes'
           ELSE locked_until 
         END
     WHERE id = $1
     RETURNING failed_login_attempts, locked_until`,
    [adminId]
  );
  return result.rows[0];
}

async function resetLoginAttempts(adminId) {
  await db.query(
    'UPDATE admins SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1',
    [adminId]
  );
}

module.exports = {
  init,
  findByUsername,
  findById,
  findByIdWithHash,
  findByIdWithAuthFields,
  verifyPassword,
  create,
  findAll,
  updatePassword,
  updateRole,
  remove,
  updateNotificationPreferences,
  findByUsernameOrEmail,
  setOtp,
  clearOtp,
  incrementOtpAttempts,
  setResetToken,
  findByResetToken,
  resetPasswordWithToken,
  setTwoFactorSecret,
  enableTwoFactor,
  disableTwoFactor,
  isAccountLocked,
  recordFailedLogin,
  resetLoginAttempts,
};