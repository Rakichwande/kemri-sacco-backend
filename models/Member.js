const pool = require('../config/database');
const bcrypt = require('bcryptjs');
const { isValidKenyanPhone, isValidIdNumber } = require('../middleware/validate');

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

// PIN brute-force protection: 5 wrong attempts locks PIN entry for 30
// minutes. A 4-digit PIN only has 10,000 possible values, so without a
// lockout, anyone holding a member's phone (lost, stolen, borrowed, or via
// SIM-swap fraud) could just try PINs repeatedly across USSD sessions.
const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MINUTES = 30;
const PIN_HASH_ROUNDS = 10; // matches Admin.js's bcrypt cost, for consistency

async function init() {
  await pool.query(createTableQuery);
  // Nullable - only ever set by bulk import, for members who already had a
  // real SACCO membership number before this system existed. Members
  // created normally (self-registration or admin New Member) leave this
  // null and get the computed KEMRI-{year}-{id} reference instead.
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS imported_reference VARCHAR(30);`);

  // PIN auth. pin_hash is nullable - existing members (and anyone created
  // before this feature) have none yet and are prompted to set one on
  // their next USSD session (see hasPinSet()/the USSD controller's PIN
  // setup flow), rather than being locked out immediately. Never store the
  // PIN itself - only a bcrypt hash of it.
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS pin_hash VARCHAR(255);`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS pin_failed_attempts INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMP;`);
}

// Create a new member with default loan fields
async function create(member) {
  const { full_name, id_number, phone_number, nationality, age, employer, scheme, imported_reference, created_at } = member;
  const result = await pool.query(
    `INSERT INTO members 
      (full_name, id_number, phone_number, nationality, age, employer, scheme, credit_limit, total_outstanding_balance, successful_repayments, imported_reference, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, COALESCE($12, NOW())) 
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
      0,     // successful_repayments
      imported_reference || null,
      created_at || null, // null -> defaults to NOW() via COALESCE above
    ]
  );
  return result.rows[0];
}

// Find by phone number (used in USSD and other places)
async function findByPhone(phone_number) {
  const result = await pool.query('SELECT * FROM members WHERE phone_number = $1', [phone_number]);
  return result.rows[0];
}

// --- PIN authentication ---

function hasPinSet(member) {
  return !!member.pin_hash;
}

// Sets (or changes) a member's PIN. Always call this rather than writing
// pin_hash directly - never store the PIN itself. Resets any lockout, since
// setting a fresh PIN is itself proof of legitimate access (either the
// member just verified their old PIN to get here, or this is first-time
// setup right after OTP/registration verification).
async function setPin(memberId, plainPin) {
  const hash = await bcrypt.hash(String(plainPin), PIN_HASH_ROUNDS);
  const result = await pool.query(
    `UPDATE members
     SET pin_hash = $1, pin_failed_attempts = 0, pin_locked_until = NULL
     WHERE id = $2
     RETURNING id, full_name, phone_number`,
    [hash, memberId]
  );
  return result.rows[0];
}

// Is this member currently locked out of PIN entry from too many failed
// attempts? Locks expire on their own after PIN_LOCKOUT_MINUTES - no
// separate unlock step needed.
function isPinLocked(member) {
  return !!member.pin_locked_until && new Date(member.pin_locked_until) > new Date();
}

// Verifies a submitted PIN against the stored hash. Returns true/false -
// does NOT itself update attempt counters; call recordFailedPinAttempt()
// or resetPinAttempts() based on the result, so the USSD controller stays
// in control of exactly when each happens.
async function verifyPin(member, plainPin) {
  if (!member.pin_hash) return false;
  return bcrypt.compare(String(plainPin), member.pin_hash);
}

// Call after a WRONG PIN attempt. Increments the counter and locks the
// account once MAX_PIN_ATTEMPTS is reached. Returns the updated row so the
// caller can tell the member how many attempts remain, or that they're now
// locked out.
async function recordFailedPinAttempt(memberId) {
  const result = await pool.query(
    `UPDATE members
     SET pin_failed_attempts = pin_failed_attempts + 1,
         pin_locked_until = CASE
           WHEN pin_failed_attempts + 1 >= $2
             THEN NOW() + ($3 || ' minutes')::INTERVAL
           ELSE pin_locked_until
         END
     WHERE id = $1
     RETURNING id, pin_failed_attempts, pin_locked_until`,
    [memberId, MAX_PIN_ATTEMPTS, PIN_LOCKOUT_MINUTES]
  );
  return result.rows[0];
}

// Call after a CORRECT PIN attempt - clears the failed-attempt counter so
// a member isn't a couple of typos away from lockout indefinitely.
async function resetPinAttempts(memberId) {
  await pool.query(
    `UPDATE members SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1`,
    [memberId]
  );
}

// Bulk import for pre-existing members (e.g. from a paper register or old
// system). Deliberately does NOT touch savings/loan balances - those must
// come from real transaction records (payments/repayments), not a lump-sum
// figure with no transaction trail behind it, or every financial report
// built on summing real transactions would stop reconciling.
async function bulkImport(rows) {
  const results = { created: 0, skipped: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2; // +1 for header row, +1 for 1-indexing

    const full_name = row.full_name?.trim();
    const id_number = row.national_id?.trim();
    const phone_number = row.phone?.trim();

    if (!full_name || !id_number || !phone_number) {
      results.skipped.push({ row: rowNum, reason: 'Missing full_name, national_id, or phone' });
      continue;
    }
    if (!isValidIdNumber(id_number)) {
      results.skipped.push({ row: rowNum, reason: 'national_id must be 6-10 digits' });
      continue;
    }
    if (!isValidKenyanPhone(phone_number)) {
      results.skipped.push({ row: rowNum, reason: 'phone must be a valid Kenyan number (e.g. 0712345678)' });
      continue;
    }

    try {
      const existing = await findByPhoneOrId(phone_number, id_number);
      if (existing) {
        results.skipped.push({ row: rowNum, reason: `Already exists (${existing.full_name})` });
        continue;
      }

      await create({
        full_name,
        id_number,
        phone_number,
        employer: row.employer?.trim() || null,
        imported_reference: row.reference_number?.trim() || null,
        created_at: row.join_date?.trim() || null, // e.g. '2022-03-15' - Postgres parses this fine
      });
      results.created++;
    } catch (err) {
      results.skipped.push({ row: rowNum, reason: err.code === '23505' ? 'Duplicate ID or phone' : 'Save failed' });
    }
  }

  return results;
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

// The reference-code expression, reused everywhere a member reference needs
// to be shown. Prefers a real imported reference (from a bulk import of
// pre-existing members) when one exists; otherwise falls back to the
// computed KEMRI-{year}-{id} scheme, which needs no migration and can never
// drift out of sync for members created normally.
const REFERENCE_SQL = `COALESCE(m.imported_reference, 'KEMRI-' || EXTRACT(YEAR FROM m.created_at)::text || '-' || LPAD(m.id::text, 4, '0'))`;

async function findById(id) {
  const result = await pool.query(
    `SELECT m.*, ${REFERENCE_SQL} AS reference FROM members m WHERE m.id = $1`,
    [id]
  );
  return result.rows[0];
}

// One query, all members, with computed savings balance and current loan
// status - for the Member Directory page. Avoids an N+1 query per member.
async function findAllForDirectory() {
  const result = await pool.query(`
    SELECT
      m.*,
      ${REFERENCE_SQL} AS reference,
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

// NOTE: appears to duplicate what Loan.js's applyRepayment() already does
// directly against the members table (with the successful_repayments
// off-by-one already fixed there). Worth confirming nothing still calls
// this - if so it's dead code carrying the OLD, still-buggy version of
// that same logic (successful_repayments >= 1 reads the pre-increment
// value). Left as-is for now since it's outside today's PIN-auth scope.
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
  REFERENCE_SQL,
  bulkImport,
  // PIN authentication
  hasPinSet,
  setPin,
  isPinLocked,
  verifyPin,
  recordFailedPinAttempt,
  resetPinAttempts,
};