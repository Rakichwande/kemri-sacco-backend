const crypto = require('crypto');
const db = require('../config/database');

const createTableQuery = `
CREATE TABLE IF NOT EXISTS staff_invites (
  id SERIAL PRIMARY KEY,
  email VARCHAR(150) NOT NULL,
  role VARCHAR(20) NOT NULL,
  token VARCHAR(64) UNIQUE NOT NULL,
  invited_by INT REFERENCES admins(id) ON DELETE SET NULL,
  status VARCHAR(20) DEFAULT 'pending',
  expires_at TIMESTAMP NOT NULL,
  accepted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_staff_invites_token ON staff_invites(token);
`;

async function init() {
  await db.query(createTableQuery);
}

async function create({ email, role, invitedBy }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  const result = await db.query(
    `INSERT INTO staff_invites (email, role, token, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [email, role, token, invitedBy, expiresAt]
  );
  return result.rows[0];
}

async function findByToken(token) {
  const result = await db.query('SELECT * FROM staff_invites WHERE token = $1', [token]);
  return result.rows[0];
}

async function markAccepted(id) {
  await db.query(`UPDATE staff_invites SET status = 'accepted', accepted_at = NOW() WHERE id = $1`, [id]);
}

async function findPending() {
  const result = await db.query(
    `SELECT * FROM staff_invites WHERE status = 'pending' AND expires_at > NOW() ORDER BY created_at DESC`
  );
  return result.rows;
}

module.exports = { init, create, findByToken, markAccepted, findPending };
