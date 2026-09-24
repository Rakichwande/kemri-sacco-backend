const crypto = require('crypto');
const db = require('../config/database');

// SHA-256 hash of an invite token before it touches the database. Same
// reasoning as password reset tokens in models/Admin.js: if the DB is ever
// leaked, a stored hash cannot be turned back into a working invite link.
// The plaintext token is only ever known to the invite recipient.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

const UNIQUE_VIOLATION = '23505';

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

// Only one PENDING invite per email at a time. Sending two invites to the
// same person creates two usable tokens, and if both are clicked (or one
// is clicked twice with a script), two admin accounts get created. The
// partial index enforces "at most one live invite per email" at the DB
// level; a resend must either wait for the first to expire or explicitly
// revoke the first (see revoke() below).
const onePendingPerEmailQuery = `
CREATE UNIQUE INDEX IF NOT EXISTS staff_invites_one_pending_per_email
ON staff_invites (LOWER(email)) WHERE status = 'pending';
`;

async function init() {
  await db.query(createTableQuery);
  await db.query(onePendingPerEmailQuery);
}

// Returns { ...row, rawToken } on success. rawToken is the ONLY time the
// plaintext token exists in the caller's hands - the row's own `token`
// column contains the hash, which is useless for building the invite link.
// Callers MUST use `invite.rawToken` (not `invite.token`) in the URL.
//
// Returns null if a pending invite already exists for this email (unique
// violation on the partial index above).
async function create({ email, role, invitedBy }) {
  const rawToken = crypto.randomBytes(24).toString('base64url');
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  try {
    const result = await db.query(
      `INSERT INTO staff_invites (email, role, token, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [email, role, tokenHash, invitedBy, expiresAt]
    );
    return { ...result.rows[0], rawToken };
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION && err.constraint === 'staff_invites_one_pending_per_email') {
      return null;
    }
    throw err;
  }
}

// Callers pass the RAW token from the invite link. This hashes it before
// comparing - the DB never sees the plaintext.
async function findByToken(rawToken) {
  const result = await db.query(
    'SELECT * FROM staff_invites WHERE token = $1',
    [hashToken(rawToken)]
  );
  return result.rows[0];
}

// Atomically claims a pending invite for acceptance. The WHERE
// status = 'pending' AND expires_at > NOW() guard means two concurrent
// requests with the same token cannot both succeed - the second gets 0 rows
// and knows someone else won the race. Mirrors Payment.claimForProcessing().
//
// The caller must claim BEFORE creating the admin account. If account
// creation then fails, call revertToPending() to release the claim.
async function claimForAcceptance(id) {
  const result = await db.query(
    `UPDATE staff_invites
     SET status = 'accepted', accepted_at = NOW()
     WHERE id = $1 AND status = 'pending' AND expires_at > NOW()
     RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

// Releases a claim if the caller's subsequent work (account creation)
// failed. Only touches rows still in 'accepted' state - won't clobber an
// invite someone else has since processed.
async function revertToPending(id) {
  const result = await db.query(
    `UPDATE staff_invites
     SET status = 'pending', accepted_at = NULL
     WHERE id = $1 AND status = 'accepted'
     RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

// Admin-initiated cancellation - kills a pending invite so its link can no
// longer be used. Only pending invites can be revoked; already-accepted
// ones are historical.
async function revoke(id) {
  const result = await db.query(
    `UPDATE staff_invites
     SET status = 'revoked', accepted_at = NOW()
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id]
  );
  return result.rows[0] || null;
}

// Kept for backward-compatibility with any code still calling it.
// Prefer claimForAcceptance for the accept flow.
async function markAccepted(id) {
  await db.query(
    `UPDATE staff_invites SET status = 'accepted', accepted_at = NOW() WHERE id = $1`,
    [id]
  );
}

async function findPending() {
  const result = await db.query(
    `SELECT * FROM staff_invites WHERE status = 'pending' AND expires_at > NOW() ORDER BY created_at DESC`
  );
  return result.rows;
}

module.exports = {
  init,
  create,
  findByToken,
  claimForAcceptance,
  revertToPending,
  revoke,
  markAccepted,
  findPending,
};