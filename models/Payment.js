const pool = require('../config/database');
const Member = require('./Member');

// Create the payments table if it doesn't exist
async function init() {
  const query = `
    CREATE TABLE IF NOT EXISTS payments (
      id SERIAL PRIMARY KEY,
      member_id INTEGER REFERENCES members(id),
      amount NUMERIC(10, 2) NOT NULL,
      phone_number VARCHAR(15) NOT NULL,
      checkout_request_id VARCHAR(100) NOT NULL,
      mpesa_receipt VARCHAR(50),
      status VARCHAR(20) NOT NULL DEFAULT 'pending',
      created_at TIMESTAMP DEFAULT NOW(),
      loan_id INTEGER REFERENCES loans(id)
    );
  `;
  await pool.query(query);

  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS account_reference VARCHAR(50);`);
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS description TEXT;`);
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP DEFAULT NOW();`);
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS loan_id INTEGER REFERENCES loans(id);`);
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS channel VARCHAR(20) DEFAULT 'mpesa';`);
  
  // 2026-11-02: Added savings_type for Ordinary, Jipange, Holiday
  await pool.query(`ALTER TABLE payments ADD COLUMN IF NOT EXISTS savings_type VARCHAR(30) DEFAULT 'ordinary';`);

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

  await pool.query(`ALTER TABLE payments ALTER COLUMN checkout_request_id SET NOT NULL;`);
  await pool.query(`ALTER TABLE payments ALTER COLUMN status SET NOT NULL;`);
}

async function create({
  member_id,
  amount,
  phone,
  account_reference,
  description,
  checkout_request_id,
  loan_id = null,
  channel = 'mpesa',
  savings_type = 'ordinary', // 2026-11-02: Added
}) {
  const result = await pool.query(
    `INSERT INTO payments 
      (member_id, amount, phone_number, account_reference, description, checkout_request_id, loan_id, channel, status, savings_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending', $9)
     RETURNING *`,
    [member_id, amount, phone, account_reference, description, checkout_request_id, loan_id, channel, savings_type]
  );
  return result.rows[0];
}

async function findByCheckoutId(checkout_request_id) {
  const result = await pool.query(
    'SELECT * FROM payments WHERE checkout_request_id = $1',
    [checkout_request_id]
  );
  return result.rows[0];
}

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

async function findByMpesaReceipt(mpesa_receipt) {
  const result = await pool.query(
    `SELECT p.*, m.full_name AS member_name, m.phone_number AS member_phone,
            ${Member.REFERENCE_SQL} AS member_reference
     FROM payments p
     LEFT JOIN members m ON p.member_id = m.id
     WHERE p.mpesa_receipt = $1
     ORDER BY p.created_at DESC
     LIMIT 1`,
    [mpesa_receipt]
  );
  return result.rows[0];
}

// 2026-11-02: Updated to filter by savings_type
async function getMemberBalance(member_id, savingsType = 'ordinary') {
  let query = `SELECT COALESCE(SUM(amount), 0) as balance FROM payments WHERE member_id = $1 AND status = 'completed' AND loan_id IS NULL`;
  const params = [member_id];

  if (savingsType) {
    query += ` AND savings_type = $2`;
    params.push(savingsType);
  }

  const result = await pool.query(query, params);
  return Number(result.rows[0].balance);
}

// 2026-11-02: Added function to deduct savings on withdrawal
async function withdrawSavings(memberId, amount, savingsType, reference, client = null) {
  const dbClient = client || pool;
  const amt = Math.round(Number(amount));

  // Insert a negative payment to reduce the balance
  const result = await dbClient.query(
    `INSERT INTO payments 
      (member_id, amount, phone_number, account_reference, description, checkout_request_id, loan_id, channel, status, savings_type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [memberId, -amt, 'N/A', 'SAVINGS-WITHDRAWAL', `Withdrawal from ${savingsType}`, `WD-${Date.now()}-${memberId}`, null, 'mpesa', 'completed', savingsType]
  );
  return result.rows[0];
}

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

async function getStatementLines(member_id) {
  const result = await pool.query(
    `SELECT
       CASE WHEN p.loan_id IS NULL THEN 'deposit' ELSE 'repayment' END AS type,
       p.created_at AS date,
       p.amount,
       p.mpesa_receipt AS reference,
       p.status,
       r.principal_paid,
       r.interest_paid
     FROM payments p
     LEFT JOIN repayments r
       ON r.mpesa_receipt = p.mpesa_receipt
      AND r.loan_id = p.loan_id
     WHERE p.member_id = $1 AND p.status = 'completed'
     ORDER BY p.created_at ASC`,
    [member_id]
  );
  return result.rows;
}

async function findAllAdmin({ search, from, to, limit = 50, offset = 0 } = {}) {
  const conditions = [`p.status = 'completed'`, `p.loan_id IS NULL`];
  const values = [];
  let i = 1;

  if (search) {
    conditions.push(`(m.full_name ILIKE $${i} OR p.phone_number ILIKE $${i})`);
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

async function findById(id) {
  const result = await pool.query(
    `SELECT p.*, m.full_name AS member_name, m.phone_number AS member_phone,
            ${Member.REFERENCE_SQL} AS member_reference
     FROM payments p
     LEFT JOIN members m ON p.member_id = m.id
     WHERE p.id = $1`,
    [id]
  );
  return result.rows[0];
}

module.exports = {
  init,
  create,
  findByCheckoutId,
  updateStatus,
  claimForProcessing,
  revertToPending,
  getMemberBalance,
  withdrawSavings, // <--- EXPORTED
  findRecentByMember,
  findAllAdmin,
  getStatementLines,
  findByMpesaReceipt,
  findById,
};