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
  // Seed default admin if none exists
  const existing = await db.query('SELECT * FROM admins LIMIT 1');
  if (existing.rows.length === 0) {
    const hash = await bcrypt.hash('KemriAdmin2026!', 10);
    await db.query(
      `INSERT INTO admins (username, password_hash, full_name) 
       VALUES ('admin', $1, 'System Administrator')`,
      [hash]
    );
    console.log('✅ Default admin created: admin / KemriAdmin2026!');
  }
}

async function findByUsername(username) {
  const result = await db.query('SELECT * FROM admins WHERE username = $1', [username]);
  return result.rows[0];
}

async function verifyPassword(admin, password) {
  return await bcrypt.compare(password, admin.password_hash);
}

module.exports = { init, findByUsername, verifyPassword };
