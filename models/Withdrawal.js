const db = require('../config/database');

// Withdrawals are REQUESTS, not instant payouts - this system has no
// Safaricom B2C (Business-to-Customer) integration, the same reason loan
// disbursement is manual today ("Disbursement is manual until M-Pesa B2C
// is approved by Safaricom" - see services/loanService.js). A member
// requests a withdrawal via USSD; a staff member sees it in the admin
// portal, sends the M-Pesa payment themselves, and marks it processed
// here with the real M-Pesa receipt. This mirrors the existing loan
// disbursement pattern rather than inventing a new one.
const createTableQuery = `
CREATE TABLE IF NOT EXISTS withdrawals (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  amount NUMERIC(10, 2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP,
  processed_by INTEGER REFERENCES admins(id),
  mpesa_receipt VARCHAR(50),
  notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_member_id ON withdrawals(member_id);
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
`;

// Only one pending withdrawal per member at a time - same reasoning as
// loans_one_active_per_member (see models/Loan.js): stops a member from
// racing multiple requests against the same savings balance before staff
// have processed the first one, and closes the same "two near-simultaneous
// requests both read no-pending-request-yet" race condition class we
// already fixed for loan applications.
const oneActivePerMemberIndexQuery = `
CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_one_pending_per_member
ON withdrawals (member_id) WHERE status = 'pending';
`;

async function init() {
  await db.query(createTableQuery);
  await db.query(oneActivePerMemberIndexQuery);
}

const UNIQUE_VIOLATION = '23505';

// Returns the created request, or null if the member already has a
// pending withdrawal request (lost a race against the unique index above -
// same convention as Loan.create() returning null in the equivalent case).
async function create({ member_id, amount }) {
  try {
    const result = await db.query(
      `INSERT INTO withdrawals (member_id, amount, status) VALUES ($1, $2, 'pending') RETURNING *`,
      [member_id, amount]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION && err.constraint === 'withdrawals_one_pending_per_member') {
      return null;
    }
    throw err;
  }
}

// Used before creating a new request, to tell a member "you already have
// one pending" with the actual amount, rather than a generic failure.
async function getPendingForMember(member_id) {
  const result = await db.query(
    `SELECT * FROM withdrawals WHERE member_id = $1 AND status = 'pending' LIMIT 1`,
    [member_id]
  );
  return result.rows[0];
}

// Admin queue - oldest first, so staff naturally work through requests in
// the order members made them.
async function findPending() {
  const result = await db.query(
    `SELECT w.*, m.full_name, m.phone_number
     FROM withdrawals w
     JOIN members m ON w.member_id = m.id
     WHERE w.status = 'pending'
     ORDER BY w.requested_at ASC`
  );
  return result.rows;
}

// Admin - full history with optional status filter. Used by the
// Withdrawal Queue page's "Processed" / "Rejected" / "All" tabs.
async function findAll({ status, limit = 100, offset = 0 } = {}) {
  const conditions = [];
  const values = [];
  let i = 1;

  if (status) {
    conditions.push(`w.status = $${i++}`);
    values.push(status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitParam = i++;
  const offsetParam = i++;
  values.push(limit, offset);

  const result = await db.query(
    `SELECT w.*, m.full_name, m.phone_number, m.id_number AS member_national_id,
            a.full_name AS processed_by_name
     FROM withdrawals w
     JOIN members m ON w.member_id = m.id
     LEFT JOIN admins a ON w.processed_by = a.id
     ${where}
     ORDER BY w.requested_at DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    values
  );
  return result.rows;
}

// Admin - single withdrawal by id, with member and admin context. Used by
// the process/reject handlers to verify state before transitioning.
async function findById(id) {
  const result = await db.query(
    `SELECT w.*, m.full_name, m.phone_number,
            a.full_name AS processed_by_name
     FROM withdrawals w
     JOIN members m ON w.member_id = m.id
     LEFT JOIN admins a ON w.processed_by = a.id
     WHERE w.id = $1`,
    [id]
  );
  return result.rows[0];
}

// Admin dashboard stats - counts and totals per status.
async function getSummary() {
  const result = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')   AS pending_count,
       COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) AS pending_total,
       COUNT(*) FILTER (WHERE status = 'processed' AND processed_at >= CURRENT_DATE) AS processed_today,
       COALESCE(SUM(amount) FILTER (WHERE status = 'processed' AND processed_at >= CURRENT_DATE), 0) AS processed_today_total,
       COUNT(*) FILTER (WHERE status = 'processed') AS processed_total_count,
       COUNT(*) FILTER (WHERE status = 'rejected')  AS rejected_count
     FROM withdrawals`
  );
  return result.rows[0];
}

// Only transitions FROM 'pending' - same double-processing guard as
// Loan.approve()/markDisbursed(). Staff record the real M-Pesa receipt
// once they've actually sent the payout themselves.
async function markProcessed(id, { mpesa_receipt, processed_by, notes } = {}) {
  const result = await db.query(
    `UPDATE withdrawals
     SET status = 'processed', processed_at = NOW(), mpesa_receipt = $2, processed_by = $3, notes = $4
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, mpesa_receipt || null, processed_by || null, notes || null]
  );
  return result.rows[0];
}

// Statement lines for withdrawals - only ones staff actually processed
// (pending/rejected requests never moved real money).
async function getStatementLines(member_id) {
  const result = await db.query(
    `SELECT
       'withdrawal' AS type,
       processed_at AS date,
       amount,
       mpesa_receipt AS reference,
       status
     FROM withdrawals
     WHERE member_id = $1 AND status = 'processed'
     ORDER BY processed_at ASC`,
    [member_id]
  );
  return result.rows;
}

async function reject(id, { processed_by, notes } = {}) {
  const result = await db.query(
    `UPDATE withdrawals
     SET status = 'rejected', processed_at = NOW(), processed_by = $2, notes = $3
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, processed_by || null, notes || null]
  );
  return result.rows[0];
}

module.exports = {
  init,
  create,
  getPendingForMember,
  findPending,
  findAll,
  findById,
  getSummary,
  markProcessed,
  getStatementLines,
  reject,
};