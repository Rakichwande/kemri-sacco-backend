const db = require('../config/database');

// Withdrawals support two payout paths, chosen by amount:
//
//   ≤ INSTANT_WITHDRAWAL_LIMIT (KES 5,000)
//     Attempted via M-Pesa B2C immediately. If B2C accepts, the request
//     moves to 'disbursing' and resolves automatically via webhook
//     callback. If B2C fails (network, float, rejection), the request
//     falls back to 'pending' and appears in the staff queue — no
//     withdrawal is ever lost.
//
//   > INSTANT_WITHDRAWAL_LIMIT
//     Straight to the staff queue as a 'pending' request. A staff member
//     sees it in the admin portal, sends the M-Pesa payment themselves,
//     and marks it processed with the real receipt.
//
// Status values:
//   pending     — awaiting either a B2C attempt or staff action
//   disbursing  — B2C request accepted by Safaricom, awaiting callback
//   processed   — completed (via B2C success OR manual staff payout)
//   rejected    — staff declined the request (no money moved)
//
// The threshold constant lives in services/disbursementService.js where
// the decision is made, not here — this model just persists state.
const createTableQuery = `
CREATE TABLE IF NOT EXISTS withdrawals (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  amount NUMERIC(10, 2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  requested_at TIMESTAMP DEFAULT NOW(),
  processed_at TIMESTAMP,
  processed_by INTEGER REFERENCES admins(id),
  mpesa_receipt VARCHAR(50),
  notes TEXT,
  -- Set when a B2C request has been accepted by Safaricom and the
  -- withdrawal is awaiting the result callback. Null for staff-mediated
  -- withdrawals (which never enter the B2C flow).
  disbursing_at TIMESTAMP,
  -- B2C correlation key. Populated when the withdrawal moves to
  -- 'disbursing' and left as-is for the audit trail even after the
  -- withdrawal resolves. The result callback matches on this to find
  -- the withdrawal. UNIQUE where not null so a duplicate or misrouted
  -- callback can be detected.
  b2c_conversation_id VARCHAR(64)
);
CREATE INDEX IF NOT EXISTS idx_withdrawals_member_id ON withdrawals(member_id); 
CREATE INDEX IF NOT EXISTS idx_withdrawals_status ON withdrawals(status);
`;

// One in-flight withdrawal per member. "In-flight" means pending staff
// action OR awaiting a B2C callback — both states block a new request,
// because the member's savings are effectively committed either way.
//
// Same reasoning as loans_one_active_per_member (see models/Loan.js):
// stops a member from racing multiple requests against the same savings
// balance before the first one resolves, and closes the same
// "two near-simultaneous requests both read no-active-request" race
// condition class we already fixed for loan applications.
//
// DROP-then-CREATE rather than CREATE IF NOT EXISTS: Postgres will not
// replace an existing index just because the WHERE clause on a new
// CREATE differs, so the previous one-status index would silently
// remain in force otherwise.
const enforceOneActiveWithdrawalPerMemberQuery = `
DROP INDEX IF EXISTS withdrawals_one_pending_per_member;
DROP INDEX IF EXISTS withdrawals_one_active_per_member;
CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_one_active_per_member
  ON withdrawals (member_id) WHERE status IN ('pending', 'disbursing');
`;

// Reminder/B2C columns for existing deployments. Also in CREATE TABLE
// above for fresh databases.
const addB2CColumnsQuery = `
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS disbursing_at TIMESTAMP;
ALTER TABLE withdrawals ADD COLUMN IF NOT EXISTS b2c_conversation_id VARCHAR(64);
CREATE UNIQUE INDEX IF NOT EXISTS withdrawals_b2c_conversation_id_unique
  ON withdrawals (b2c_conversation_id) WHERE b2c_conversation_id IS NOT NULL;
`;

async function init() {
  await db.query(createTableQuery);
  await db.query(addB2CColumnsQuery);
  await db.query(enforceOneActiveWithdrawalPerMemberQuery);
}

const UNIQUE_VIOLATION = '23505';

// Returns the created request, or null if the member already has an
// in-flight withdrawal request (pending or disbursing) — lost a race
// against the unique index above. Same convention as Loan.create()
// returning null in the equivalent case.
async function create({ member_id, amount }) {
  try {
    const result = await db.query(
      `INSERT INTO withdrawals (member_id, amount, status) VALUES ($1, $2, 'pending') RETURNING *`,
      [member_id, amount]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === UNIQUE_VIOLATION && err.constraint === 'withdrawals_one_active_per_member') {
      return null;
    }
    throw err;
  }
}

// Used before creating a new request, to tell a member "you already have
// one in flight" with the actual amount, rather than a generic failure.
//
// Checks BOTH 'pending' (awaiting staff or awaiting B2C attempt) and
// 'disbursing' (B2C accepted, awaiting callback). From the member's
// perspective both mean "you can't request another right now" — the
// money is effectively committed either way.
async function getPendingForMember(member_id) {
  const result = await db.query(
    `SELECT * FROM withdrawals
     WHERE member_id = $1 AND status IN ('pending', 'disbursing')
     ORDER BY requested_at DESC LIMIT 1`,
    [member_id]
  );
  return result.rows[0];
}

// Admin queue — oldest first, so staff naturally work through requests in
// the order members made them. 'disbursing' withdrawals are NOT included:
// B2C is handling them and no staff action is required. If a B2C attempt
// fails, the withdrawal rolls back to 'pending' and appears here.
async function findPending() {
  const result = await db.query(
    `SELECT w.*, m.full_name, m.phone_number
     FROM withdrawals w
     JOIN members m ON w.member_id = m.id
     WHERE w.status = 'pending'
     ORDER BY w.requested_at ASC`
  );
  return result.rows;
}

// Admin — full history with optional status filter. Used by the
// Withdrawal Queue page's "Processed" / "Rejected" / "All" tabs. Passing
// no status returns everything including 'disbursing' in-flight records.
async function findAll({ status, limit = 100, offset = 0 } = {}) {
  const conditions = [];
  const values = [];
  let i = 1;

  if (status) {
    conditions.push(`w.status = $${i++}`);
    values.push(status);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitParam = i++;
  const offsetParam = i++;
  values.push(limit, offset);

  const result = await db.query(
    `SELECT w.*, m.full_name, m.phone_number, m.id_number AS member_national_id,
            a.full_name AS processed_by_name
     FROM withdrawals w
     JOIN members m ON w.member_id = m.id
     LEFT JOIN admins a ON w.processed_by = a.id
     ${where}
     ORDER BY w.requested_at DESC
     LIMIT $${limitParam} OFFSET $${offsetParam}`,
    values
  );
  return result.rows;
}

// Admin — single withdrawal by id, with member and admin context. Used by
// the process/reject handlers to verify state before transitioning.
async function findById(id) {
  const result = await db.query(
    `SELECT w.*, m.full_name, m.phone_number,
            a.full_name AS processed_by_name
     FROM withdrawals w
     JOIN members m ON w.member_id = m.id
     LEFT JOIN admins a ON w.processed_by = a.id
     WHERE w.id = $1`,
    [id]
  );
  return result.rows[0];
}

// Look up a withdrawal by the Safaricom B2C ConversationID. Used
// exclusively by the B2C result/timeout webhook handlers to find which
// withdrawal a callback refers to. Returns undefined if no match —
// which is a legitimate outcome for a callback that arrives twice with
// the same ConversationID after the withdrawal has already moved past
// 'disbursing'.
async function findByB2CConversationId(conversationId) {
  if (!conversationId) return undefined;
  const result = await db.query(
    `SELECT w.*, m.full_name, m.phone_number
     FROM withdrawals w
     JOIN members m ON w.member_id = m.id
     WHERE w.b2c_conversation_id = $1`,
    [conversationId]
  );
  return result.rows[0];
}

// Admin dashboard stats — counts and totals per status.
async function getSummary() {
  const result = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE status = 'pending')   AS pending_count,
       COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0) AS pending_total,
       COUNT(*) FILTER (WHERE status = 'disbursing') AS disbursing_count,
       COALESCE(SUM(amount) FILTER (WHERE status = 'disbursing'), 0) AS disbursing_total,
       COUNT(*) FILTER (WHERE status = 'processed' AND processed_at >= CURRENT_DATE) AS processed_today,
       COALESCE(SUM(amount) FILTER (WHERE status = 'processed' AND processed_at >= CURRENT_DATE), 0) AS processed_today_total,
       COUNT(*) FILTER (WHERE status = 'processed') AS processed_total_count,
       COUNT(*) FILTER (WHERE status = 'rejected')  AS rejected_count
     FROM withdrawals`
  );
  return result.rows[0];
}

// Staff payout — pending → processed. Only transitions FROM 'pending':
// a 'disbursing' withdrawal is under B2C's control and staff must not
// touch it. If B2C fails, rollbackDisbursing() puts it back to 'pending'
// and staff can process it manually at that point.
async function markProcessed(id, { mpesa_receipt, processed_by, notes } = {}) {
  const result = await db.query(
    `UPDATE withdrawals
     SET status = 'processed', processed_at = NOW(), mpesa_receipt = $2, processed_by = $3, notes = $4
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, mpesa_receipt || null, processed_by || null, notes || null]
  );
  return result.rows[0];
}

// Statement lines for withdrawals — only ones that actually moved real
// money. Both B2C-completed and staff-processed withdrawals end up in
// 'processed' state, so this filter covers both paths.
async function getStatementLines(member_id) {
  const result = await db.query(
    `SELECT
       'withdrawal' AS type,
       processed_at AS date,
       amount,
       mpesa_receipt AS reference,
       status
     FROM withdrawals
     WHERE member_id = $1 AND status = 'processed'
     ORDER BY processed_at ASC`,
    [member_id]
  );
  return result.rows;
}

async function reject(id, { processed_by, notes } = {}) {
  const result = await db.query(
    `UPDATE withdrawals
     SET status = 'rejected', processed_at = NOW(), processed_by = $2, notes = $3
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, processed_by || null, notes || null]
  );
  return result.rows[0];
}

// --- B2C disbursement ---

// Move a pending withdrawal into 'disbursing' — the state between "we
// asked Safaricom to send money" and "Safaricom has confirmed the money
// left." Called immediately after Daraja accepts a B2C request and
// returns a ConversationID. Staff never see a withdrawal in this state
// (they're filtered out of findPending), and no member balance is
// touched here — that happens in markDisbursed() once confirmed.
//
// Only 'pending' can move to 'disbursing'. If the withdrawal isn't in
// that state (already disbursing, already processed, already rejected),
// returns null — the caller must handle this because the B2C request has
// already been sent to Safaricom and cannot be un-sent.
async function markDisbursing(id, b2c_conversation_id) {
  const result = await db.query(
    `UPDATE withdrawals
     SET status = 'disbursing',
         disbursing_at = NOW(),
         b2c_conversation_id = $2
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id, b2c_conversation_id]
  );
  return result.rows[0];
}

// B2C success — disbursing → processed. Called by the webhook handler
// when Safaricom confirms the money has moved. Records the M-Pesa receipt
// from the callback so the statement and audit trail have it.
//
// No member balance update happens here — a withdrawal doesn't change the
// member's running outstanding balance (that field is for loans only).
// The savings balance itself is computed from the payments table, not
// stored, so completing a withdrawal doesn't touch any member column.
async function markDisbursed(id, mpesa_receipt = null) {
  const result = await db.query(
    `UPDATE withdrawals
     SET status = 'processed',
         processed_at = NOW(),
         mpesa_receipt = $2,
         notes = COALESCE(notes, '') || ' | Auto-paid via B2C'
     WHERE id = $1 AND status = 'disbursing'
     RETURNING *`,
    [id, mpesa_receipt]
  );
  return result.rows[0];
}

// B2C failure — disbursing → pending. Called by the webhook handler when
// Safaricom reports a failure, or by the request-time error path if the
// B2C call never reached Safaricom.
//
// The withdrawal returns to the staff queue so nothing is lost — a
// member who asked for KES 3,000 and had the instant attempt fail simply
// waits for staff to process it manually, exactly as if they'd asked for
// an amount above the threshold.
//
// Clears the B2C columns so a future retry (if any) can set new ones.
// Preserves the old ConversationID and failure reason in notes for the
// audit trail.
async function rollbackDisbursing(id, reason = '') {
  const result = await db.query(
    `UPDATE withdrawals
     SET status = 'pending',
         disbursing_at = NULL,
         b2c_conversation_id = NULL,
         notes = COALESCE(notes, '') ||
           ' | B2C instant payout failed (' || COALESCE($2, 'no reason given') || ')' ||
           CASE WHEN b2c_conversation_id IS NOT NULL
                THEN '. ConversationID: ' || b2c_conversation_id
                ELSE '' END
     WHERE id = $1 AND status = 'disbursing'
     RETURNING *`,
    [id, reason]
  );
  return result.rows[0];
}

module.exports = {
  init,
  create,
  getPendingForMember,
  findPending,
  findAll,
  findById,
  findByB2CConversationId,
  getSummary,
  markProcessed,
  getStatementLines,
  reject,
  markDisbursing,
  markDisbursed,
  rollbackDisbursing,
};