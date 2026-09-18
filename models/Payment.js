const pool = require('../config/database');
const Member = require('./Member');

// Create the payments table if it doesn't exist
async function init() {
  const query = `
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      amount INTEGER NOT NULL,
      phone VARCHAR(20),
      account_reference VARCHAR(50),
      description TEXT,
      status VARCHAR(20) DEFAULT 'pending',
      mpesa_receipt VARCHAR(50),
      checkout_request_id VARCHAR(100),
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `;
  await pool.query(query);

  // Older deployments (and this table's own original schema) never had this
  // column, even though paymentService.js has always tried to use it to tell
  // a loan repayment apart from a plain savings deposit. Without it, every
  // repayment made via M-Pesa STK push has been silently treated as a
  // deposit instead of updating the loan's balance.
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS loan_id INTEGER REFERENCES loans(id);`);

  // A concurrent/duplicate Daraja webhook delivery could previously result in
  // two payment rows sharing the same checkout_request_id, which weakened the
  // claimForProcessing() idempotency guarantee below (an UPDATE ... WHERE
  // checkout_request_id = $1 would match - and update - both rows at once).
  // This constraint makes that impossible at the database level, and doubles
  // as the index that findByCheckoutId() / claimForProcessing() rely on.
  // Postgres has no ADD CONSTRAINT IF NOT EXISTS, so this DO block is the
  // idempotent equivalent - safe to run on every boot.
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'payments_checkout_request_id_unique'
      ) THEN
        ALTER TABLE payments
          ADD CONSTRAINT payments_checkout_request_id_unique UNIQUE (checkout_request_id);
      END IF;
    END $$;
  `);

  // Every payment is created with checkout_request_id already populated
  // (paymentService.initiatePayment calls Daraja before it ever writes the
  // row), and status always has the 'pending' default, so both are safe to
  // enforce as NOT NULL for defense-in-depth.
  await pool.query(`ALTER TABLE payments ALTER COLUMN checkout_request_id SET NOT NULL;`);
  await pool.query(`ALTER TABLE payments ALTER COLUMN status SET NOT NULL;`);
}

// Create a new payment record
async function create({ member_id, amount, phone, account_reference, description, checkout_request_id, loan_id = null }) {
  const result = await pool.query(
    `INSERT INTO payments 
      (member_id, amount, phone, account_reference, description, checkout_request_id, loan_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
     RETURNING *`,
    [member_id, amount, phone, account_reference, description, checkout_request_id, loan_id]
  );
  return result.rows[0];
}

// Find payment by checkout request ID (for webhook)
async function findByCheckoutId(checkout_request_id) {
  const result = await pool.query(
    'SELECT * FROM payments WHERE checkout_request_id = $1',
    [checkout_request_id]
  );
  return result.rows[0];
}

// Update payment status and optionally M-Pesa receipt
// Atomically claims a pending payment for processing - the WHERE status =
// 'pending' guard means only ONE concurrent request can ever successfully
// claim a given payment, even if Daraja sends the same callback twice at
// nearly the same instant. A second, near-simultaneous claim attempt gets
// back zero rows and knows to back off, instead of both requests racing
// past a separate read-then-write check and double-processing the same
// payment. The unique constraint on checkout_request_id (see init()) backs
// this up by guaranteeing there's only ever one row to claim in the first
// place.
async function claimForProcessing(checkout_request_id) {
  const result = await pool.query(
    `UPDATE payments
     SET status = 'processing', updated_at = NOW()
     WHERE checkout_request_id = $1 AND status = 'pending'
     RETURNING *`,
    [checkout_request_id]
  );
  return result.rows[0];
}

// Reverts a 'processing' payment back to 'pending' after a genuine
// processing failure (a DB error, an unexpected exception - NOT a
// notification hiccup, those are isolated in paymentService and never
// reach this point). Without this, a payment that failed partway through
// handleCallback would be stuck at 'processing' forever: claimForProcessing
// only claims payments still at 'pending', so a Safaricom retry of the same
// callback would find status = 'processing', claim nothing, and the
// "duplicate/already claimed" path would silently ignore the retry -
// permanently losing a callback that was never actually completed. The
// WHERE status = 'processing' guard here ensures this only ever reverts a
// payment that's still mid-processing, never one that's already reached a
// final completed/failed state through some other path.
async function revertToPending(checkout_request_id) {
  const result = await pool.query(
    `UPDATE payments
     SET status = 'pending', updated_at = NOW()
     WHERE checkout_request_id = $1 AND status = 'processing'
     RETURNING *`,
    [checkout_request_id]
  );
  return result.rows[0];
}

// `client` is optional and lets this join a caller-managed transaction
// (see paymentService.handleCallback, which commits this together with the
// loan balance update so a crash between the two can't leave one applied
// without the other). Defaults to the plain pool for existing callers that
// don't need transactional composition (e.g. the failed-payment path,
// which is a single standalone write).
async function updateStatus(checkout_request_id, status, mpesa_receipt = null, client = pool) {
  const result = await client.query(
    `UPDATE payments 
     SET status = $1, mpesa_receipt = $2, updated_at = NOW() 
     WHERE checkout_request_id = $3
     RETURNING *`,
    [status, mpesa_receipt, checkout_request_id]
  );
  return result.rows[0];
}

// Get member's total SAVINGS balance - completed contributions only.
// loan_id IS NULL excludes loan repayments (see findAllAdmin below for the
// same distinction on the admin side); without this guard, a member's
// repayments would inflate what they're told is their savings balance.
async function getMemberBalance(member_id) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(amount), 0) as balance
     FROM payments
     WHERE member_id = $1 AND status = 'completed' AND loan_id IS NULL`,
    [member_id]
  );
  return Number(result.rows[0].balance);
}

// Get recent transactions for a member
async function findRecentByMember(member_id, limit = 5) {
  const result = await pool.query(
    `SELECT * FROM payments 
     WHERE member_id = $1 
     ORDER BY created_at DESC 
     LIMIT $2`,
    [member_id, limit]
  );
  return result.rows;
}

// Admin-facing listing with filters, for the Contribution Logs page.
async function findAllAdmin({ search, from, to, limit = 50, offset = 0 } = {}) {
  const conditions = [`p.status = 'completed'`, `p.loan_id IS NULL`]; // contributions only, not loan repayments
  const values = [];
  let i = 1;

  if (search) {
    conditions.push(`(m.full_name ILIKE $${i} OR p.phone ILIKE $${i})`);
    values.push(`%${search}%`);
    i++;
  }
  if (from) {
    conditions.push(`p.created_at >= $${i++}`);
    values.push(from);
  }
  if (to) {
    conditions.push(`p.created_at <= $${i++}`);
    values.push(to);
  }

  const where = `WHERE ${conditions.join(' AND ')}`;
  const limitParam = i++;
  const offsetParam = i++;
  values.push(limit, offset);

  const result = await pool.query(
    `SELECT p.*, m.full_name AS member_name, ${Member.REFERENCE_SQL} AS member_reference
     FROM payments p
     LEFT JOIN members m ON p.member_id = m.id
     ${where}
     ORDER BY p.created_at DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    values
  );
  return result.rows;
}

module.exports = {
  init,
  create,
  findByCheckoutId,
  updateStatus,
  claimForProcessing,
  revertToPending,
  getMemberBalance,
  findRecentByMember,
  findAllAdmin,
};