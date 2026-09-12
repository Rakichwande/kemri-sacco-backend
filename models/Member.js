const pool = require('../config/database');

// Create the members table with loan-related columns
const createTableQuery = `
CREATE TABLE IF NOT EXISTS members (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(150) NOT NULL,
  id_number VARCHAR(20) UNIQUE NOT NULL,
  phone_number VARCHAR(15) UNIQUE NOT NULL,
  nationality VARCHAR(50),
  age INT,
  employer VARCHAR(150),
  scheme VARCHAR(100) DEFAULT 'holiday_savings',
  status VARCHAR(20) DEFAULT 'pending',
  -- Loan-related fields
  credit_limit INTEGER DEFAULT 10000,
  total_outstanding_balance INTEGER DEFAULT 0,
  successful_repayments INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT NOW()
);
`;

async function init() {
  await pool.query(createTableQuery);
}

// Create a new member with default loan fields
async function create(member) {
  const { full_name, id_number, phone_number, nationality, age, employer, scheme } = member;
  const result = await pool.query(
    `INSERT INTO members 
      (full_name, id_number, phone_number, nationality, age, employer, scheme, credit_limit, total_outstanding_balance, successful_repayments)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) 
     RETURNING *`,
    [
      full_name,
      id_number,
      phone_number,
      nationality || null,
      age || null,
      employer || null,
      scheme || 'holiday_savings',
      10000, // default credit_limit for new members
      0,     // total_outstanding_balance
      0      // successful_repayments
    ]
  );
  return result.rows[0];
}

// Find by phone number (used in USSD and other places)
async function findByPhone(phone_number) {
  const result = await pool.query('SELECT * FROM members WHERE phone_number = $1', [phone_number]);
  return result.rows[0];
}

// Find by ID (used by loan module)
async function findById(id) {
  const result = await pool.query('SELECT * FROM members WHERE id = $1', [id]);
  return result.rows[0];
}

// Find by either phone or ID number (used for duplicate registration checks)
async function findByPhoneOrId(phone_number, id_number) {
  const result = await pool.query(
    'SELECT * FROM members WHERE phone_number = $1 OR id_number = $2',
    [phone_number, id_number]
  );
  return result.rows[0];
}

// Get all members (admin use)
async function findAll() {
  const result = await pool.query('SELECT * FROM members ORDER BY created_at DESC');
  return result.rows;
}

// One query, all members, with computed savings balance and current loan
// status - for the Member Directory page. Avoids an N+1 query per member.
async function findAllForDirectory() {
  const result = await pool.query(`
    SELECT
      m.*,
      COALESCE(sav.balance, 0) AS savings_balance,
      loan.status AS current_loan_status
    FROM members m
    LEFT JOIN LATERAL (
      SELECT SUM(amount) AS balance
      FROM payments p
      WHERE p.member_id = m.id AND p.status = 'completed' AND p.loan_id IS NULL
    ) sav ON true
    LEFT JOIN LATERAL (
      SELECT status
      FROM loans l
      WHERE l.member_id = m.id AND l.status IN ('pending', 'approved', 'disbursed')
      ORDER BY l.applied_at DESC
      LIMIT 1
    ) loan ON true
    ORDER BY m.created_at DESC
  `);
  return result.rows;
}

// Admin edit of member profile fields. `updates` is a plain object whose keys
// are already whitelisted by the controller - this function trusts its caller
// on that, but still builds the query parametrically rather than interpolating.
async function update(id, updates) {
  const keys = Object.keys(updates);
  const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
  const values = keys.map((key) => updates[key]);
  const result = await pool.query(
    `UPDATE members SET ${setClause} WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return result.rows[0];
}

// Update the member's total outstanding balance (add amount)
async function updateOutstandingBalance(memberId, amount) {
  const result = await pool.query(
    `UPDATE members 
     SET total_outstanding_balance = total_outstanding_balance + $1 
     WHERE id = $2 
     RETURNING *`,
    [amount, memberId]
  );
  return result.rows[0];
}

// Increment successful repayments and update credit limit (optional helper)
async function incrementRepayments(memberId) {
  const result = await pool.query(
    `UPDATE members 
     SET successful_repayments = successful_repayments + 1,
         credit_limit = CASE 
           WHEN successful_repayments >= 1 THEN 20000 
           ELSE 10000 
         END
     WHERE id = $1 
     RETURNING *`,
    [memberId]
  );
  return result.rows[0];
}

module.exports = {
  init,
  create,
  findByPhone,
  findById,
  findByPhoneOrId,
  findAll,
  findAllForDirectory,
  update,
  updateOutstandingBalance,
  incrementRepayments,
};