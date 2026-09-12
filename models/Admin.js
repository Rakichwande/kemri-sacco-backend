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

// Older deployments may already have the table without this column.
const addMustChangeColumnQuery = `
ALTER TABLE admins ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN DEFAULT true;
`;

function generateRandomPassword() {
  // 24 random bytes -> 32-char base64url string. Not memorable by design:
  // it only ever needs to be typed once, immediately followed by a change.
  return crypto.randomBytes(24).toString('base64url');
}

async function init() {
  await db.query(createAdminTableQuery);
  await db.query(addMustChangeColumnQuery);

  const existing = await db.query('SELECT * FROM admins LIMIT 1');
  if (existing.rows.length > 0) return;

  // No admin exists yet (fresh database). Bootstrap one account.
  //
  // Preferred: set ADMIN_BOOTSTRAP_USERNAME / ADMIN_BOOTSTRAP_PASSWORD in
  // Render's environment (never in source) before first boot.
  //
  // Fallback: generate a random password and print it once to the server
  // log. Render's logs are private to the account, unlike a committed file,
  // and the account is flagged must_change_password so it can't stay in use
  // long-term.
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

async function findById(id) {
  const result = await db.query(
    'SELECT id, username, full_name, role, must_change_password, created_at FROM admins WHERE id = $1',
    [id]
  );
  return result.rows[0];
}

async function verifyPassword(admin, password) {
  return await bcrypt.compare(password, admin.password_hash);
}

async function create({ username, password, full_name, role }) {
  const hash = await bcrypt.hash(password, 10);
  const result = await db.query(
    `INSERT INTO admins (username, password_hash, full_name, role, must_change_password)
     VALUES ($1, $2, $3, $4, true) RETURNING id, username, full_name, role, must_change_password, created_at`,
    [username, hash, full_name, role]
  );
  return result.rows[0];
}

async function findAll() {
  const result = await db.query(
    'SELECT id, username, full_name, role, must_change_password, created_at FROM admins ORDER BY created_at DESC'
  );
  return result.rows;
}

async function updatePassword(id, newPassword) {
  const hash = await bcrypt.hash(newPassword, 10);
  const result = await db.query(
    `UPDATE admins SET password_hash = $1, must_change_password = false WHERE id = $2
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

module.exports = {
  init,
  findByUsername,
  findById,
  findByIdWithHash,
  verifyPassword,
  create,
  findAll,
  updatePassword,
  updateRole,
  remove,
};
