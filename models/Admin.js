const db = require('../config/database');
const bcrypt = require('bcryptjs');

const createAdminTableQuery = `
CREATE TABLE IF NOT EXISTS admins (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  full_name VARCHAR(100) NOT NULL,
  role VARCHAR(20) DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT NOW()
);
`;

async function init() {
  await db.query(createAdminTableQuery);
  const existing = await db.query('SELECT * FROM admins LIMIT 1');
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash('KemriAdmin2026!', 10);
    await db.query(
      `INSERT INTO admins (username, password_hash, full_name)
       VALUES ('admin', $1, 'System Administrator')`,
      [hash]
    );
    console.log('✅ Default admin created: admin / KemriAdmin2026! - CHANGE THIS IMMEDIATELY');
  }
}

async function findByUsername(username) {
  const result = await db.query('SELECT * FROM admins WHERE username = $1', [username]);
  return result.rows[0];
}

async function findById(id) {
  const result = await db.query(
    'SELECT id, username, full_name, role, created_at FROM admins WHERE id = $1',
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
    `INSERT INTO admins (username, password_hash, full_name, role)
     VALUES ($1, $2, $3, $4) RETURNING id, username, full_name, role, created_at`,
    [username, hash, full_name, role]
  );
  return result.rows[0];
}

async function findAll() {
  const result = await db.query(
    'SELECT id, username, full_name, role, created_at FROM admins ORDER BY created_at DESC'
  );
  return result.rows;
}

async function updatePassword(id, newPassword) {
  const hash = await bcrypt.hash(newPassword, 10);
  const result = await db.query(
    `UPDATE admins SET password_hash = $1 WHERE id = $2 RETURNING id, username, full_name, role`,
    [hash, id]
  );
  return result.rows[0];
}

async function findByIdWithHash(id) {
  const result = await db.query('SELECT * FROM admins WHERE id = $1', [id]);
  return result.rows[0];
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
};