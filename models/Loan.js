const db = require('../config/database');
const Member = require('./Member');

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

// Older deployments may already have the table without this column.
const addRejectedAtColumnQuery = `
ALTER TABLE loans ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP;
`;

// LoanService.canApply() checks "does this member already have an active
// loan?" before create() is called, but there's a gap between that read
// and the write: two near-simultaneous applications (e.g. a member
// double-tapping "Apply" on a slow USSD session) can both read "no active
// loan" before either has created one, giving the member two active loans
// at once. A partial unique index closes this at the database level - it's
// physically impossible for a second loan to exist in one of these
// statuses for the same member, regardless of how many requests race each
// other. The application-level canApply() check stays in place as a fast,
// friendly rejection for the common (non-racing) case; this index is the
// real guarantee for the rare concurrent case.
const addOneActiveLoanPerMemberIndexQuery = `
CREATE UNIQUE INDEX IF NOT EXISTS loans_one_active_per_member
ON loans (member_id)
WHERE status IN ('pending', 'approved', 'disbursed');
`;

async function init() {
  await db.query(createLoansTableQuery);
  await db.query(addRejectedAtColumnQuery);
  await db.query(addOneActiveLoanPerMemberIndexQuery);
}

// Postgres error code for "unique_violation" - raised when the partial
// unique index above rejects a second concurrent application.
const UNIQUE_VIOLATION = '23505';

// Returns the created loan, or null if the member already has a
// pending/approved/disbursed loan and this insert lost a race against
// another request that created one microseconds earlier. Any other
// database error still throws normally.
async function create({ member_id, principal, interest_rate, tenure_months }) {
  const totalInterest = Math.round(principal * (interest_rate / 100) * tenure_months);
  const totalRepayment = Number(principal) + totalInterest;
  const monthlyInstallment = Math.round(totalRepayment / tenure_months);

  try {
    const result = await db.query(
      `INSERT INTO loans (
         member_id, principal, interest_rate, tenure_months,
         total_interest, total_repayment, monthly_installment, outstanding_balance, amount_paid
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [member_id, principal, interest_rate, tenure_months, totalInterest, totalRepayment, monthlyInstallment, totalRepayment, 0]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION && err.constraint === 'loans_one_active_per_member') {
      return null;
    }
    throw err;
  }
}

async function getActiveLoan(member_id) {
  const result = await db.query(
    `SELECT * FROM loans 
     WHERE member_id = $1 AND status IN ('pending', 'approved', 'disbursed') 
     ORDER BY applied_at DESC LIMIT 1`,
    [member_id]
  );
  return result.rows[0];
}

async function countRepaidByMember(member_id) {
  const result = await db.query(
    `SELECT COUNT(*) FROM loans WHERE member_id = $1 AND status = 'repaid'`,
    [member_id]
  );
  return Number(result.rows[0].count);
}

async function getHistory(member_id, limit = 10) {
  const result = await db.query(
    `SELECT * FROM loans 
     WHERE member_id = $1 
     ORDER BY applied_at DESC 
     LIMIT $2`,
    [member_id, limit]
  );
  return result.rows;
}

async function findById(id) {
  const result = await db.query('SELECT * FROM loans WHERE id = $1', [id]);
  return result.rows[0];
}

// Only a pending loan can be approved. The WHERE status = 'pending' guard
// (combined with FOR UPDATE) makes this safe against a double-click or a
// retried request: a second attempt on an already-approved loan finds zero
// matching rows, rolls back, and returns null instead of re-adding
// total_repayment onto the member's outstanding balance a second time.
// Returns null if the loan doesn't exist or isn't pending, so the caller
// can distinguish that from a successful approval (same convention as
// reject() below).
async function approve(loan_id) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Get loan details with FOR UPDATE, only if still pending
    const loanRes = await client.query(
      "SELECT * FROM loans WHERE id = $1 AND status = 'pending' FOR UPDATE",
      [loan_id]
    );
    if (loanRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const loan = loanRes.rows[0];

    // 2. Update loan status
    const updateRes = await client.query(
      `UPDATE loans 
       SET status = 'approved', approved_at = NOW() 
       WHERE id = $1 
       RETURNING *`,
      [loan_id]
    );

    // 3. Update member's outstanding balance. total_outstanding_balance is
    // an INTEGER column, but loan.total_repayment comes back from Postgres
    // as a decimal string (e.g. "6800.00", since it's NUMERIC(10,2)) -
    // passing that directly makes Postgres reject it outright for an
    // integer column. Round to the nearest whole KES, matching the
    // column's actual precision.
    await client.query(
      `UPDATE members 
       SET total_outstanding_balance = total_outstanding_balance + $1 
       WHERE id = $2`,
      [Math.round(Number(loan.total_repayment)), loan.member_id]
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

// Only a pending loan can be rejected - guards against rejecting a loan
// that's already been approved or disbursed. Returns undefined if the loan
// doesn't exist or isn't pending, so the caller can distinguish that from
// a successful rejection.
async function reject(loan_id, adminNotes = '') {
  const result = await db.query(
    `UPDATE loans
     SET status = 'rejected',
         rejected_at = NOW(),
         admin_notes = COALESCE(admin_notes, '') ||
           CASE WHEN $2 <> '' THEN ' | Rejected: ' || $2 ELSE ' | Rejected' END
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [loan_id, adminNotes]
  );
  return result.rows[0];
}

// Only an approved loan can be marked disbursed - guards against disbursing
// a loan that's still pending, was rejected, or has already been disbursed
// (which would otherwise just append a second "Manually disbursed" note
// with no other consequence, but is still a state that shouldn't be
// reachable). Returns undefined if the loan doesn't exist or isn't
// currently approved.
async function markDisbursed(loan_id, mpesa_receipt = null) {
  const result = await db.query(
    `UPDATE loans 
     SET status = 'disbursed', 
         disbursed_at = NOW(),
         admin_notes = COALESCE(admin_notes, '') || ' | Manually disbursed. Receipt: ' || $2
     WHERE id = $1 AND status = 'approved'
     RETURNING *`,
    [loan_id, mpesa_receipt || 'N/A']
  );
  return result.rows[0];
}

// Applies a repayment to a loan. Normally manages its own transaction
// (BEGIN/COMMIT/ROLLBACK, acquiring and releasing its own client) exactly
// as before. If the CALLER is already inside its own transaction and wants
// this repayment applied as part of it - e.g. paymentService.handleCallback
// committing "payment marked completed" and "loan balance reduced"
// together, so a crash between the two can never leave one applied and the
// other not - pass that client in as externalClient. In that mode this
// function does not BEGIN/COMMIT/ROLLBACK/release anything itself; the
// caller owns the whole transaction's lifecycle.
async function applyRepayment(loan_id, amount, externalClient = null) {
  const client = externalClient || (await db.pool.connect());
  const ownsTransaction = !externalClient;

  try {
    if (ownsTransaction) await client.query('BEGIN');

    const loanRes = await client.query('SELECT * FROM loans WHERE id = $1 FOR UPDATE', [loan_id]);
    if (loanRes.rows.length === 0) throw new Error('Loan not found');
    const loan = loanRes.rows[0];

    const newBalance = Math.max(0, Number(loan.outstanding_balance) - Number(amount));
    const newAmountPaid = Number(loan.amount_paid) + Number(amount);
    const newStatus = newBalance <= 0 ? 'repaid' : loan.status;
    const isFullyRepaid = newBalance <= 0;

    const updateRes = await client.query(
      `UPDATE loans 
       SET outstanding_balance = $1, 
           amount_paid = $2, 
           status = $3,
           repaid_at = CASE WHEN $4 THEN NOW() ELSE NULL END
       WHERE id = $5 
       RETURNING *`,
      [newBalance, newAmountPaid, newStatus, isFullyRepaid, loan_id]
    );

    // Update member's outstanding balance
    await client.query(
      `UPDATE members 
       SET total_outstanding_balance = total_outstanding_balance - $1 
       WHERE id = $2`,
      [amount, loan.member_id]
    );

    // If fully repaid, increment successful_repayments and update credit
    // limit. NOTE: within a single UPDATE, every expression on the right
    // of SET is evaluated against the row's values BEFORE the statement
    // runs - they don't see each other's results. The CASE here therefore
    // needs "successful_repayments + 1" (the value it's about to become),
    // not the bare column (its value before this statement), or the limit
    // bump lags a whole repayment behind the board-confirmed rule ("rises
    // to KES 20,000 after one successful repayment").
    if (isFullyRepaid) {
      await client.query(
        `UPDATE members 
         SET successful_repayments = successful_repayments + 1,
             credit_limit = CASE 
               WHEN successful_repayments + 1 >= 1 THEN 20000 
               ELSE 10000 
             END
         WHERE id = $1`,
        [loan.member_id]
      );
    }

    if (ownsTransaction) await client.query('COMMIT');
    return updateRes.rows[0];
  } catch (err) {
    if (ownsTransaction) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (ownsTransaction) client.release();
  }
}

// Disbursement lines for the member statement - only loans that actually
// reached disbursement (excludes pending/approved/rejected, which never
// released real money to the member).
async function getStatementLines(member_id) {
  const result = await db.query(
    `SELECT
       'disbursement' AS type,
       disbursed_at AS date,
       principal AS amount,
       id::text AS reference,
       status
     FROM loans
     WHERE member_id = $1 AND disbursed_at IS NOT NULL
     ORDER BY disbursed_at ASC`,
    [member_id]
  );
  return result.rows;
}

async function findAllForAdmin() {
  const result = await db.query(
    `SELECT l.*, m.full_name as member_name, m.phone_number, ${Member.REFERENCE_SQL} AS member_reference
     FROM loans l
     LEFT JOIN members m ON l.member_id = m.id
     WHERE l.status IN ('pending', 'approved', 'disbursed', 'repaid', 'rejected')
     ORDER BY l.applied_at DESC
     LIMIT 100`
  );
  return result.rows;
}

async function findPending() {
  const result = await db.query(
    `SELECT l.*, m.full_name as member_name, m.phone_number, ${Member.REFERENCE_SQL} AS member_reference
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
  reject,
  markDisbursed,
  applyRepayment,
  findAllForAdmin,
  findPending,
  getStatementLines,
};