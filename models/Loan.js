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
  status VARCHAR(30) DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  disbursed_at TIMESTAMP
);
`;

async function init() {
  await pool.query(createLoansTableQuery);
}

async function create({ member_id, principal, interest_rate, tenure_months }) {
  const totalInterest = Math.round(principal * (interest_rate / 100) * tenure_months);
  const totalRepayment = Number(principal) + totalInterest;
  const monthlyInstallment = Math.round(totalRepayment / tenure_months);

  const result = await pool.query(
    `INSERT INTO loans (
       member_id, principal, interest_rate, tenure_months,
       total_interest, total_repayment, monthly_installment, outstanding_balance
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
    [member_id, principal, interest_rate, tenure_months, totalInterest, totalRepayment, monthlyInstallment, totalRepayment]
  );
  return result.rows[0];
}

async function getActiveLoan(member_id) {
  const result = await pool.query(
    `SELECT * FROM loans WHERE member_id = $1 AND status IN ('pending', 'approved', 'disbursed') ORDER BY created_at DESC LIMIT 1`,
    [member_id]
  );
  return result.rows[0];
}

async function countRepaidByMember(member_id) {
  const result = await pool.query(
    `SELECT COUNT(*) FROM loans WHERE member_id = $1 AND status = 'repaid'`,
    [member_id]
  );
  return Number(result.rows[0].count);
}

async function approve(loan_id) {
  const result = await pool.query(
    `UPDATE loans SET status = 'approved' WHERE id = $1 RETURNING *`,
    [loan_id]
  );
  return result.rows[0];
}

async function markDisbursed(loan_id) {
  const result = await pool.query(
    `UPDATE loans SET status = 'disbursed', disbursed_at = NOW() WHERE id = $1 RETURNING *`,
    [loan_id]
  );
  return result.rows[0];
}

async function applyRepayment(loan_id, amount) {
  const loan = await findById(loan_id);
  if (!loan) return null;

  const newBalance = Math.max(0, Number(loan.outstanding_balance) - Number(amount));
  const newStatus = newBalance <= 0 ? 'repaid' : loan.status;

  const result = await pool.query(
    `UPDATE loans SET outstanding_balance = $1, status = $2 WHERE id = $3 RETURNING *`,
    [newBalance, newStatus, loan_id]
  );
  return result.rows[0];
}

async function findById(id) {
  const result = await pool.query('SELECT * FROM loans WHERE id = $1', [id]);
  return result.rows[0];
}

module.exports = {
  init,
  create,
  getActiveLoan,
  countRepaidByMember,
  approve,
  markDisbursed,
  applyRepayment,
  findById,
};
