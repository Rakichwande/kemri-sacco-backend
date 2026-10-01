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
  -- Set the moment we move a loan to 'disbursing' (B2C request accepted
  -- by Safaricom, awaiting the result callback). Null for loans disbursed
  -- manually before B2C, and for any loan not yet disbursed.
  disbursing_at TIMESTAMP,
  disbursed_at TIMESTAMP,
  repaid_at TIMESTAMP,
  -- B2C correlation key. Populated when a loan moves to 'disbursing' and
  -- left as-is for the audit trail even after the loan resolves. The
  -- result callback matches on this to find the loan. UNIQUE where not
  -- null so a duplicate or misrouted callback can be detected.
  b2c_conversation_id VARCHAR(64),
  next_payment_due DATE,
  purpose TEXT DEFAULT 'General loan',
  admin_notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_loans_member_id ON loans(member_id);
CREATE INDEX IF NOT EXISTS idx_loans_status ON loans(status);
`;

// Older deployments may already have the table without these columns.
const addRejectedAtColumnQuery = `
ALTER TABLE loans ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMP;
`;

// B2C correlation + audit columns. Added via ALTER for existing
// deployments; also in CREATE TABLE above for fresh databases.
const addB2CColumnsQuery = `
ALTER TABLE loans ADD COLUMN IF NOT EXISTS disbursing_at TIMESTAMP;
ALTER TABLE loans ADD COLUMN IF NOT EXISTS b2c_conversation_id VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS loans_b2c_conversation_id_unique
  ON loans (b2c_conversation_id) WHERE b2c_conversation_id IS NOT NULL;
`;

// LoanService.canApply() checks "does this member already have an active
// loan?" before create() is called, but there's a gap between that read
// and the write: two near-simultaneous applications (e.g. a member
// double-tapping "Apply" on a slow USSD session) can both read "no active
// loan" before either has created one, giving the member two active loans
// at once. A partial unique index closes this at the database level - it's
// physically impossible for a second loan to exist in one of these
// statuses for the same member, regardless of how many requests race each
// other.
//
// 'disbursing' was added when B2C support was introduced. Between the
// moment we ask Safaricom to send money and the moment the result
// callback resolves the loan (5-30 seconds in practice), the loan sits
// in 'disbursing'. Without including it here, a member whose disbursement
// was in flight could apply for a second loan during that window - the
// application would see "no active loan" and succeed, giving them two
// loans against a single principal.
//
// DROP-then-CREATE rather than CREATE IF NOT EXISTS: Postgres will not
// replace an existing index just because the WHERE clause on a new
// CREATE differs, so the previous three-status index would silently
// remain in force otherwise.
const enforceOneActiveLoanPerMemberQuery = `
DROP INDEX IF EXISTS loans_one_active_per_member;
CREATE UNIQUE INDEX IF NOT EXISTS loans_one_active_per_member
  ON loans (member_id)
  WHERE status IN ('pending', 'approved', 'disbursing', 'disbursed');
`;

// Loan reference for display. Uses the loan's OWN id (unique per loan),
// not the member's id - the old format used member_id, which meant a
// member taking out a second loan would receive the same reference string
// as their first, and staff couldn't tell the two apart. Format is
// LN-##### — distinct from member references, so a staff member reading
// "LN-00007" vs "21438" knows immediately which record they're looking at.
const REFERENCE_SQL = `'LN-' || LPAD(l.id::text, 5, '0')`;

async function init() {
  await db.query(createLoansTableQuery);
  await db.query(addRejectedAtColumnQuery);
  await db.query(addB2CColumnsQuery);
  await db.query(enforceOneActiveLoanPerMemberQuery);
}

// Postgres error code for "unique_violation" - raised when the partial
// unique index above rejects a second concurrent application.
const UNIQUE_VIOLATION = '23505';

// Returns the created loan, or null if the member already has a
// pending/approved/disbursing/disbursed loan and this insert lost a race
// against another request that created one microseconds earlier. Any
// other database error still throws normally.
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
    `SELECT l.*, ${REFERENCE_SQL} AS reference
     FROM loans l
     WHERE l.member_id = $1 AND l.status IN ('pending', 'approved', 'disbursing', 'disbursed') 
     ORDER BY l.applied_at DESC LIMIT 1`,
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
    `SELECT l.*, ${REFERENCE_SQL} AS reference
     FROM loans l
     WHERE l.member_id = $1 
     ORDER BY l.applied_at DESC 
     LIMIT $2`,
    [member_id, limit]
  );
  return result.rows;
}

// Only returns a loan the member can actually repay today — i.e. one that
// has been DISBURSED (money physically sent to them). A pending, approved,
// or disbursing loan exists in the system but hasn't moved money to the
// member yet (or, in the 'disbursing' case, is in the middle of moving it
// and not yet confirmed), so there's nothing to repay. Kept separate from
// getActiveLoan() because "active" (blocks new applications) and
// "repayable" (money is out) are different concepts — a member who has
// just applied must not be able to send a repayment for funds they
// haven't received.
async function getRepayableLoan(member_id) {
  const result = await db.query(
    `SELECT l.*, ${REFERENCE_SQL} AS reference
     FROM loans l
     WHERE l.member_id = $1 AND l.status = 'disbursed'
     ORDER BY l.disbursed_at DESC LIMIT 1`,
    [member_id]
  );
  return result.rows[0];
}

async function findById(id) {
  const result = await db.query(
    `SELECT l.*, ${REFERENCE_SQL} AS reference
     FROM loans l
     WHERE l.id = $1`,
    [id]
  );
  return result.rows[0];
}

// Look up a loan by the Safaricom B2C ConversationID. Used exclusively by
// the B2C result/timeout webhook handlers to find which loan a callback
// refers to. Returns undefined if no match — which is a legitimate outcome
// for a callback that arrives twice with the same ConversationID after the
// loan has already moved past 'disbursing' (we leave b2c_conversation_id
// set for audit, so this lookup still finds the resolved loan — the caller
// checks status to detect the already-resolved case).
async function findByB2CConversationId(conversationId) {
  if (!conversationId) return undefined;
  const result = await db.query(
    `SELECT l.*, ${REFERENCE_SQL} AS reference
     FROM loans l
     WHERE l.b2c_conversation_id = $1`,
    [conversationId]
  );
  return result.rows[0];
}

// Only a pending loan can be approved. The WHERE status = 'pending' guard
// (combined with FOR UPDATE) makes this safe against a double-click or a
// retried request: a second attempt on an already-approved loan finds zero
// matching rows, rolls back, and returns null.
//
// IMPORTANT: approval does NOT touch the member's outstanding balance.
// That reflects money the member actually owes, and at approval time no
// money has moved yet - approving is a staff decision, not a cash event.
// The balance increment happens in markDisbursed() below, at the moment
// funds are physically sent.
async function approve(loan_id) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    const loanRes = await client.query(
      "SELECT * FROM loans WHERE id = $1 AND status = 'pending' FOR UPDATE",
      [loan_id]
    );
    if (loanRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }

    const updateRes = await client.query(
      `UPDATE loans 
       SET status = 'approved', approved_at = NOW() 
       WHERE id = $1 
       RETURNING *`,
      [loan_id]
    );

    await client.query('COMMIT');
    const updated = updateRes.rows[0];
    return { ...updated, reference: `LN-${String(updated.id).padStart(5, '0')}` };
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

// Move an approved loan into 'disbursing' — the state between "we've
// decided to send money" and "Safaricom has confirmed the money left".
// Called immediately after Daraja accepts a B2C request and returns a
// ConversationID. The loan's balance is NOT touched here; that happens in
// markDisbursed() once the result callback confirms success.
//
// Only 'approved' can move to 'disbursing'. If the loan isn't in that
// state (already disbursing, already disbursed, or rejected), returns
// null — which the caller must handle, because the B2C request has
// already been sent to Safaricom and cannot be un-sent. See
// disbursementService.disburseLoan() for how that rare race is handled.
async function markDisbursing(loan_id, b2c_conversation_id) {
  const result = await db.query(
    `UPDATE loans
     SET status = 'disbursing',
         disbursing_at = NOW(),
         b2c_conversation_id = $2
     WHERE id = $1 AND status = 'approved'
     RETURNING *`,
    [loan_id, b2c_conversation_id]
  );
  return result.rows[0];
}

// Roll a 'disbursing' loan back to 'approved' after a B2C failure (either
// the request was rejected at submission time, or the result callback
// reports ResultCode != 0). The balance was never incremented for a
// disbursing loan, so there's nothing to reverse.
//
// Clears the B2C columns so a subsequent retry can set new ones.
// Preserves the old ConversationID in admin_notes for the audit trail -
// if the loan ever needs to be reconciled against Safaricom records,
// that trail survives.
async function rollbackDisbursing(loan_id, reason = '') {
  const result = await db.query(
    `UPDATE loans
     SET status = 'approved',
         disbursing_at = NULL,
         b2c_conversation_id = NULL,
         admin_notes = COALESCE(admin_notes, '') ||
           ' | B2C disbursement failed (' || COALESCE($2, 'no reason given') || ')' ||
           CASE WHEN b2c_conversation_id IS NOT NULL
                THEN '. ConversationID: ' || b2c_conversation_id
                ELSE '' END
     WHERE id = $1 AND status = 'disbursing'
     RETURNING *`,
    [loan_id, reason]
  );
  return result.rows[0];
}

// Only an approved loan can be marked disbursed — OR a loan already in
// 'disbursing' (the B2C callback path, where the loan was moved to
// disbursing at request time and the callback is now confirming success).
//
// This is the moment money physically leaves the SACCO (or, for the B2C
// case, the moment Safaricom confirms it did): the loan's status
// transition AND the member's outstanding-balance increment are committed
// together in one transaction, so a crash between them can't leave the
// status saying "disbursed" while the member's balance still reads zero
// (or vice versa).
//
// source='manual' (the default) produces an admin_notes line saying the
// loan was manually disbursed and records the staff-entered M-Pesa
// receipt. source='b2c' does the same but with a different note, using
// the TransactionReceipt Safaricom returned in the callback.
async function markDisbursed(loan_id, mpesa_receipt = null, source = 'manual') {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');

    // Accept either 'approved' (manual path: staff clicks the button on an
    // approved loan) or 'disbursing' (B2C path: Safaricom has confirmed).
    const loanRes = await client.query(
      "SELECT * FROM loans WHERE id = $1 AND status IN ('approved', 'disbursing') FOR UPDATE",
      [loan_id]
    );
    if (loanRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return undefined;
    }
    const loan = loanRes.rows[0];

    const noteLine = source === 'b2c'
      ? ' | Auto-disbursed via B2C. Receipt: '
      : ' | Manually disbursed. Receipt: ';

    const updateRes = await client.query(
      `UPDATE loans 
       SET status = 'disbursed', 
           disbursed_at = NOW(),
           admin_notes = COALESCE(admin_notes, '') || $3 || $2
       WHERE id = $1 
       RETURNING *`,
      [loan_id, mpesa_receipt || 'N/A', noteLine]
    );

    // NOW the member owes the money - increment their running outstanding
    // total. total_outstanding_balance is INTEGER, and total_repayment is
    // NUMERIC(10,2) — round to the nearest whole KES, matching the column's
    // actual precision.
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

    // Include the display reference in the returned row, same convention as
    // findById()/getActiveLoan().
    const updated = updateRes.rows[0];
    return { ...updated, reference: `LN-${String(updated.id).padStart(5, '0')}` };
  } catch (err) {
    if (ownsTransaction) await client.query('ROLLBACK');
    throw err;
  } finally {
    if (ownsTransaction) client.release();
  }
}

// Disbursement lines for the member statement - only loans that actually
// reached disbursement (excludes pending/approved/disbursing/rejected,
// which either never released real money to the member or, in the
// disbursing case, are still in flight and unconfirmed).
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
    `SELECT 
       l.*, 
       ${REFERENCE_SQL} AS reference,
       m.full_name as member_name, 
       m.phone_number, 
       ${Member.REFERENCE_SQL} AS member_reference
     FROM loans l
     LEFT JOIN members m ON l.member_id = m.id
     WHERE l.status IN ('pending', 'approved', 'disbursing', 'disbursed', 'repaid', 'rejected')
     ORDER BY l.applied_at DESC
     LIMIT 100`
  );
  return result.rows;
}

async function findPending() {
  const result = await db.query(
    `SELECT 
       l.*, 
       ${REFERENCE_SQL} AS reference,
       m.full_name as member_name, 
       m.phone_number, 
       ${Member.REFERENCE_SQL} AS member_reference
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
  findByB2CConversationId,
  approve,
  reject,
  markDisbursing,
  rollbackDisbursing,
  markDisbursed,
  applyRepayment,
  findAllForAdmin,
  findPending,
  getStatementLines,
  REFERENCE_SQL,
  getRepayableLoan,
};