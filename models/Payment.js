const pool = require('../config/database');

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
async function updateStatus(checkout_request_id, status, mpesa_receipt = null) {
  const result = await pool.query(
    `UPDATE payments 
     SET status = $1, mpesa_receipt = $2, updated_at = NOW() 
     WHERE checkout_request_id = $3
     RETURNING *`,
    [status, mpesa_receipt, checkout_request_id]
  );
  return result.rows[0];
}

// Get member's total balance (sum of completed payments)
async function getMemberBalance(member_id) {
  const result = await pool.query(
    'SELECT COALESCE(SUM(amount), 0) as balance FROM payments WHERE member_id = $1 AND status = \'completed\'',
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
    `SELECT p.*, m.full_name AS member_name
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
  getMemberBalance,
  findRecentByMember,
  findAllAdmin,
};