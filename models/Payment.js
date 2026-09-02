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
}

// Create a new payment record
async function create({ member_id, amount, phone, account_reference, description, checkout_request_id }) {
  const result = await pool.query(
    `INSERT INTO payments 
      (member_id, amount, phone, account_reference, description, checkout_request_id, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'pending')
     RETURNING *`,
    [member_id, amount, phone, account_reference, description, checkout_request_id]
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

module.exports = {
  init,
  create,
  findByCheckoutId,
  updateStatus,
  getMemberBalance,
  findRecentByMember,
};