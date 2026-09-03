const pool = require('../config/database');

const createLoansTableQuery = `
CREATE TABLE IF NOT EXISTS loans (
  id SERIAL PRIMARY KEY,
  member_id INT REFERENCES members(id) NOT NULL,
  principal NUMERIC(10, 2) NOT NULL,
  interest_rate NUMERIC(5, 2) NOT NULL,
  tenure_months INT NOT NULL,
  total_interest NUMERIC(10, 2) NOT NULL,
  total_repayment NUMERIC(10, 2) NOT NULL,
  monthly_installment NUMERIC(10, 2) NOT NULL,
  outstanding_balance NUMERIC(10, 2) NOT NULL,
  amount_paid NUMERIC(10, 2) DEFAULT 0,
  status VARCHAR(30) DEFAULT 'pending',
  applied_at TIMESTAMP DEFAULT NOW(),
  approved_at TIMESTAMP,
  disbursed_at TIMESTAMP,
  repaid_at TIMESTAMP,
  next_payment_due DATE,
  purpose TEXT DEFAULT 'General loan',
  admin_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_loans_member_id ON loans(member_id);
CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
`;

async function init() {
  await pool.query(createLoansTableQuery);
}

// Create a new loan application
async function create({ member_id, principal, interest_rate, tenure_months }) {
  const totalInterest = Math.round(principal * (interest_rate / 100) * tenure_months);
  const totalRepayment = Number(principal) + totalInterest;
  const monthlyInstallment = Math.round(totalRepayment / tenure_months);

  const result = await pool.query(
    `INSERT INTO loans (
       member_id, principal, interest_rate, tenure_months,
       total_interest, total_repayment, monthly_installment, outstanding_balance, amount_paid
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [member_id, principal, interest_rate, tenure_months, totalInterest, totalRepayment, monthlyInstallment, totalRepayment, 0]
  );
  return result.rows[0];
}

// Get the active loan for a member (pending, approved, or disbursed)
async function getActiveLoan(member_id) {
  const result = await pool.query(
    `SELECT * FROM loans 
     WHERE member_id = $1 AND status IN ('pending', 'approved', 'disbursed') 
     ORDER BY applied_at DESC LIMIT 1`,
    [member_id]
  );
  return result.rows[0];
}

// Count how many loans a member has successfully repaid
async function countRepaidByMember(member_id) {
  const result = await pool.query(
    `SELECT COUNT(*) FROM loans WHERE member_id = $1 AND status = 'repaid'`,
    [member_id]
  );
  return Number(result.rows[0].count);
}

// Get loan history for a member
async function getHistory(member_id, limit = 10) {
  const result = await pool.query(
    `SELECT * FROM loans 
     WHERE member_id = $1 
     ORDER BY applied_at DESC 
     LIMIT $2`,
    [member_id, limit]
  );
  return result.rows;
}

// Find a loan by ID
async function findById(id) {
  const result = await pool.query('SELECT * FROM loans WHERE id = $1', [id]);
  return result.rows[0];
}

// Approve a loan (with transaction to update member's outstanding balance)
async function approve(loan_id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get loan details
    const loanRes = await client.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loan_id]);
    if (loanRes.rows.length === 0) throw new Error('Loan not found');
    const loan = loanRes.rows[0];

    // 2. Update loan status to 'approved'
    const updateRes = await client.query(
      `UPDATE loans 
       SET status = 'approved', approved_at = NOW() 
       WHERE id = $1 
       RETURNING *`,
      [loan_id]
    );

    // 3. Update member's total outstanding balance
    await client.query(
      `UPDATE members 
       SET total_outstanding_balance = total_outstanding_balance + $1 
       WHERE id = $2`,
      [loan.total_repayment, loan.member_id]
    );

    await client.query('COMMIT');
    return updateRes.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Mark a loan as manually disbursed (Phase 1 - manual M-Pesa transfer)
async function markDisbursed(loan_id, mpesa_receipt = null) {
  const result = await pool.query(
    `UPDATE loans 
     SET status = 'disbursed', 
         disbursed_at = NOW(),
         admin_notes = COALESCE(admin_notes, '') || ' | Manually disbursed. Receipt: ' || $2
     WHERE id = $1 
     RETURNING *`,
    [loan_id, mpesa_receipt || 'N/A']
  );
  return result.rows[0];
}

// Apply a repayment to a loan
async function applyRepayment(loan_id, amount) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get current loan with FOR UPDATE (lock)
    const loanRes = await client.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loan_id]);
    if (loanRes.rows.length === 0) throw new Error('Loan not found');
    const loan = loanRes.rows[0];

    // 2. Calculate new values
    const newBalance = Math.max(0, Number(loan.outstanding_balance) - Number(amount));
    const newAmountPaid = Number(loan.amount_paid) + Number(amount);
    const newStatus = newBalance <= 0 ? 'repaid' : loan.status;
    const repaidAt = newBalance <= 0 ? 'NOW()' : 'NULL';

    // 3. Update loan
    const updateRes = await client.query(
      `UPDATE loans 
       SET outstanding_balance = $1, 
           amount_paid = $2, 
           status = $3,
           repaid_at = CASE WHEN $4 THEN NOW() ELSE NULL END,
           next_payment_due = CASE WHEN $4 THEN NULL ELSE next_payment_due END
       WHERE id = $5 
       RETURNING *`,
      [newBalance, newAmountPaid, newStatus, newBalance <= 0, loan_id]
    );

    // 4. Update member's outstanding balance
    await client.query(
      `UPDATE members 
       SET total_outstanding_balance = total_outstanding_balance - $1 
       WHERE id = $2`,
      [amount, loan.member_id]
    );

    // 5. If fully repaid, increment successful_repayments and update credit limit
    if (newBalance <= 0) {
      await client.query(
        `UPDATE members 
         SET successful_repayments = successful_repayments + 1,
             credit_limit = CASE 
               WHEN successful_repayments >= 1 THEN 20000 
               ELSE 10000 
             END
         WHERE id = $1`,
        [loan.member_id]
      );
    }

    await client.query('COMMIT');
    return updateRes.rows[0];
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Get all loans for admin dashboard (with member name)
async function findAllForAdmin() {
  const result = await pool.query(
    `SELECT l.*, m.full_name as member_name, m.phone_number 
     FROM loans l
     LEFT JOIN members m ON l.member_id = m.id
     WHERE l.status IN ('pending', 'approved', 'disbursed', 'repaid')
     ORDER BY l.applied_at DESC
     LIMIT 100`
  );
  return result.rows;
}

// Get all pending loans for admin
async function findPending() {
  const result = await pool.query(
    `SELECT l.*, m.full_name as member_name, m.phone_number 
     FROM loans l
     LEFT JOIN members m ON l.member_id = m.id
     WHERE l.status = 'pending'
     ORDER BY l.applied_at ASC`
  );
  return result.rows;
}

module.exports = {
  init,
  create,
  getActiveLoan,
  countRepaidByMember,
  getHistory,
  findById,
  approve,
  markDisbursed,
  applyRepayment,
  findAllForAdmin,
  findPending,
};