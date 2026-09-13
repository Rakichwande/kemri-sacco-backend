const db = require('../config/database');
const Member = require('./Member');

const createTableQuery = `
CREATE TABLE IF NOT EXISTS repayments (
  id SERIAL PRIMARY KEY,
  loan_id INT NOT NULL REFERENCES loans(id),
  member_id INT NOT NULL REFERENCES members(id),
  amount NUMERIC(10, 2) NOT NULL,
  channel VARCHAR(20) DEFAULT 'mpesa',
  mpesa_receipt VARCHAR(50),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_repayments_loan_id ON repayments(loan_id);
CREATE INDEX IF NOT EXISTS idx_repayments_member_id ON repayments(member_id);
CREATE INDEX IF NOT EXISTS idx_repayments_created_at ON repayments(created_at DESC);
`;

async function init() {
  await db.query(createTableQuery);
}

// Called once per confirmed repayment - one row per actual M-Pesa transaction,
// as opposed to the loan's running balance which only holds the current total.
async function create({ loan_id, member_id, amount, channel = 'mpesa', mpesa_receipt = null }) {
  const result = await db.query(
    `INSERT INTO repayments (loan_id, member_id, amount, channel, mpesa_receipt)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [loan_id, member_id, amount, channel, mpesa_receipt]
  );
  return result.rows[0];
}

async function findAll({ search, from, to, channel, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const values = [];
  let i = 1;

  if (search) {
    conditions.push(`(m.full_name ILIKE $${i} OR CAST(r.loan_id AS TEXT) ILIKE $${i})`);
    values.push(`%${search}%`);
    i++;
  }
  if (from) {
    conditions.push(`r.created_at >= $${i++}`);
    values.push(from);
  }
  if (to) {
    conditions.push(`r.created_at <= $${i++}`);
    values.push(to);
  }
  if (channel && channel !== 'all') {
    conditions.push(`r.channel = $${i++}`);
    values.push(channel);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitParam = i++;
  const offsetParam = i++;
  values.push(limit, offset);

  const result = await db.query(
    `SELECT r.*, m.full_name AS member_name, ${Member.REFERENCE_SQL} AS member_reference
     FROM repayments r
     LEFT JOIN members m ON r.member_id = m.id
     ${where}
     ORDER BY r.created_at DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    values
  );
  return result.rows;
}

// Monthly totals for the last N months, zero-filled by the caller the same
// way Dashboard.getSummary() already zero-fills contributions.
async function getMonthlyTotals(monthsBack = 6) {
  const result = await db.query(
    `SELECT date_trunc('month', created_at) AS month, SUM(amount)::bigint AS total
     FROM repayments
     WHERE created_at >= NOW() - ($1 || ' months')::interval
     GROUP BY month
     ORDER BY month`,
    [monthsBack]
  );
  return result.rows;
}

module.exports = { init, create, findAll, getMonthlyTotals };
