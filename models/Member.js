const pool = require('../config/database');
const bcrypt = require('bcryptjs');
const { isValidKenyanPhone, isValidIdNumber } = require('../middleware/validate');

const createTableQuery = `
CREATE TABLE IF NOT EXISTS members (
  id SERIAL PRIMARY KEY,
  full_name VARCHAR(150) NOT NULL,
  id_number VARCHAR(20) UNIQUE NOT NULL,
  phone_number VARCHAR(15) UNIQUE,
  nationality VARCHAR(50),
  age INT,
  employer VARCHAR(150),
  scheme VARCHAR(100) DEFAULT 'holiday_savings',
  status VARCHAR(20) DEFAULT 'active',
  -- Loan-related fields
  credit_limit INTEGER DEFAULT 10000,
  total_outstanding_balance INTEGER DEFAULT 0,
  successful_repayments INTEGER DEFAULT 0,
  -- Board/Staff flag. TRUE for the 17 board and staff members who are
  -- auto-approved for loans under SACCO policy agreed 25 Sept 2026.
  -- Defaults to FALSE for everyone else — including any member who
  -- self-registers via USSD or the portal. Promotion to TRUE happens only
  -- through setBoardStaffStatus(), never through create() or update().
  is_board_staff BOOLEAN NOT NULL DEFAULT FALSE,
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

// Normalizes any Kenyan phone input to the canonical +2547XXXXXXXX form.
// Accepts: 0722321019, 722321019, 254722321019, +254722321019, and any
// variant with spaces/dashes. Returns null if the input isn't a plausible
// Kenyan mobile number after normalization.
//
// This exists because different data sources use different conventions:
// USSD (Africa's Talking) sends +254..., the admin Settings form lets
// staff type 07..., and the CEO's member spreadsheet has 7... (Excel
// stripped the leading zero when the cell was treated as a number).
// Storing one canonical form means a member registered via one path can
// still be found by lookup from another.
function normalizePhone(input) {
  if (input === null || input === undefined) return null;
  let digits = String(input).replace(/\D/g, '');
  if (!digits) return null;

  // Strip leading country code and reduce to a 9-digit local part
  if (digits.startsWith('254')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);

  // At this point a valid Kenyan mobile should be 9 digits, starting 7 or 1
  if (digits.length !== 9) return null;
  if (!digits.startsWith('7') && !digits.startsWith('1')) return null;

  return `+254${digits}`;
}

async function init() {
  await pool.query(createTableQuery);

  // imported_reference holds the SACCO member number for EVERY member. It
  // was originally named for the import use case only (values pasted in
  // from a legacy register), but it now serves both that purpose AND the
  // issuance of fresh numbers to new members via the shared sequence
  // below. The name is kept for backward compatibility; the UNIQUE
  // constraint on this column guarantees no two members can share a
  // reference, however it was assigned.
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS imported_reference VARCHAR(30);`);

  // PIN auth. pin_hash is nullable - existing members (and anyone created
  // before this feature) have none yet and are prompted to set one on
  // their next USSD session (see hasPinSet()/the USSD controller's PIN
  // setup flow), rather than being locked out immediately. Never store the
  // PIN itself - only a bcrypt hash of it.
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS pin_hash VARCHAR(255);`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS pin_failed_attempts INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMP;`);

  // Allow importing members from a legacy register who have no phone number
  // on file (the CEO's spreadsheet has several rows with a blank phone
  // cell). Postgres treats NULL as "not present" in UNIQUE columns, so
  // multiple NULL phones coexist fine alongside the existing UNIQUE
  // constraint. Their USSD/SMS will simply not work until they add a phone
  // via the admin portal.
  await pool.query(`ALTER TABLE members ALTER COLUMN phone_number DROP NOT NULL;`);

  // Board/Staff flag. Added via ALTER (rather than only in the CREATE
  // TABLE above) so existing databases pick it up on the next boot without
  // a manual migration. Existing members all default to FALSE on add; the
  // current 17 board/staff are backfilled separately (one-off UPDATE, or
  // setBoardStaffByReferences() from an admin script).
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS is_board_staff BOOLEAN NOT NULL DEFAULT FALSE;`);

  // Partial index. Only the handful of TRUE rows are indexed, so lookups
  // like "is this member board/staff?" stay constant-time as the member
  // table grows to thousands, without bloating the index for the 99% of
  // rows that are FALSE.
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_members_board_staff ON members (id) WHERE is_board_staff;`);

  // Monotonic member reference counter. Every new member created via
  // Member.create() draws its imported_reference from this sequence, so
  // references continue the SACCO's existing numbering (starting from the
  // highest imported P/NO) instead of starting a competing format.
  //
  // Sequence gaps are expected and fine (e.g. if an insert rolls back
  // after calling nextval). References being contiguous is not required;
  // references being unique and growing is.
  await pool.query(`CREATE SEQUENCE IF NOT EXISTS sacco_member_reference_seq;`);

  // Align the sequence with the highest existing reference on every boot.
  // Idempotent: if the sequence is already ahead of every stored value,
  // this is a no-op. If a later import ever inserts numbers above the
  // sequence's current position (e.g. the CEO sends a batch of members
  // with higher legacy numbers), this realigns on the next restart so
  // fresh nextval() calls can't collide with values that already exist.
  //
  // Skipped entirely if no numeric references are stored yet (fresh DB) -
  // in that case the sequence keeps its default starting position.
  await pool.query(`
    DO $$
    BEGIN
      IF (SELECT COUNT(*) FROM members WHERE imported_reference ~ '^[0-9]+$') > 0 THEN
        PERFORM setval(
          'sacco_member_reference_seq',
          GREATEST(
            (SELECT last_value FROM sacco_member_reference_seq),
            (SELECT MAX(imported_reference::int) FROM members WHERE imported_reference ~ '^[0-9]+$')
          )
        );
      END IF;
    END $$;
  `);
}

// Create a new member with default loan fields.
//
// imported_reference is assigned here for EVERY new member:
//   - If the caller passes one explicitly (used by bulkImport to preserve a
//     legacy P/NO from the SACCO's register), that value wins.
//   - Otherwise, nextval() pulls the next available number from the shared
//     sequence, so freshly-registered members continue the same numbering
//     the SACCO has been using for years, not a separate KEMRI-YYYY-XXXX
//     scheme.
//
// nextval() is called inside the INSERT's VALUES clause, so the number is
// allocated atomically with the row. Two simultaneous registrations cannot
// receive the same reference.
//
// SECURITY BOUNDARY: this function deliberately does NOT accept
// is_board_staff. Every member created here — via USSD self-registration,
// the web portal, the admin console, or bulk import — lands as FALSE
// (the database default). Promotion to board/staff happens only through
// setBoardStaffStatus(), called from a route gated by
// members:set_board_status, so the auto-approved-loan privilege can never
// be granted by accident through any other code path.
async function create(member) {
  const { full_name, id_number, phone_number, nationality, age, employer, scheme, imported_reference, created_at } = member;
  const result = await pool.query(
    `INSERT INTO members 
      (full_name, id_number, phone_number, nationality, age, employer, scheme,
       credit_limit, total_outstanding_balance, successful_repayments,
       imported_reference, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
             COALESCE($11, nextval('sacco_member_reference_seq')::text),
             COALESCE($12, NOW())) 
     RETURNING *`,
    [
      full_name,
      id_number,
      phone_number, // may be null - see init()'s DROP NOT NULL
      nationality || null,
      age || null,
      employer || null,
      scheme || 'holiday_savings',
      10000, // default credit_limit for new members
      0,     // total_outstanding_balance
      0,     // successful_repayments
      imported_reference || null, // null -> sequence provides the next number
      created_at || null, // null -> defaults to NOW() via COALESCE above
    ]
  );
  return result.rows[0];
}

// Find by phone number (used in USSD and other places). Tries several
// storage formats so a member registered under one convention is still
// found when the lookup comes in under another (see normalizePhone).
async function findByPhone(phone_number) {
  if (!phone_number) return null;
  const normalized = normalizePhone(phone_number);
  if (!normalized) {
    // Not a plausible Kenyan number - return nothing rather than throwing,
    // since callers like the USSD flow pass in whatever AT sends.
    return null;
  }
  const local = normalized.slice(4); // strip '+254'
  const variants = [normalized, `0${local}`, `254${local}`, local];

  const result = await pool.query(
    'SELECT * FROM members WHERE phone_number = ANY($1::text[]) LIMIT 1',
    [variants]
  );
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

// Title-case a name that was pasted from an all-caps spreadsheet. Preserves
// initials (e.g. "JUSTUS W. KINYUNGU" -> "Justus W. Kinyungu"). Falls back
// to the original if the input doesn't look like an all-caps name.
function toTitleCase(name) {
  if (!name) return name;
  const trimmed = String(name).trim();
  // Only rewrite if the string is mostly uppercase - a name that's already
  // mixed-case (e.g. "McDonald") shouldn't be mangled.
  const upperCount = (trimmed.match(/[A-Z]/g) || []).length;
  const letterCount = (trimmed.match(/[A-Za-z]/g) || []).length;
  if (letterCount === 0 || upperCount / letterCount < 0.8) return trimmed;

  return trimmed
    .split(/\s+/)
    .map((word) => {
      // Preserve single-letter initials with the trailing period
      if (word.length <= 2 && /^[A-Z]\.?$/.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

// Bulk import for pre-existing members (e.g. from a paper register or old
// system). Deliberately does NOT touch savings/loan balances - those must
// come from real transaction records (payments/repayments), not a lump-sum
// figure with no transaction trail behind it, or every financial report
// built on summing real transactions would stop reconciling.
//
// Accepts either key style for the same field (national_id / id_number,
// phone / phone_number), so a client can send whichever shape it prefers
// without the backend having to care.
//
// Each row may optionally include a `sourceRow` (the physical row number
// in the source file) - if present, that's what appears in error reports,
// so "row 5" in the report corresponds to row 5 in the CEO's spreadsheet.
// If absent, we fall back to positional numbering within the array.
//
// NOTE: imported members land as is_board_staff = FALSE, same as everyone
// else. Promotion of the 17 board/staff is a separate one-off step (see
// setBoardStaffByReferences), deliberately kept out of the importer so a
// routine member upload can never grant auto-approved-loan privileges.
async function bulkImport(rows) {
  const results = { created: 0, skipped: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // Prefer the source file's own row number when the caller provides one
    // (the file's real layout often has a title row before the header, so
    // positional numbering inside the parsed array is misleading).
    const rowNum = Number.isFinite(row.sourceRow) ? row.sourceRow : i + 2;

    const rawName = row.full_name || row.fullName || row.NAME;
    const rawId = row.national_id || row.id_number || row.National_Id || row.ID;
    const rawPhone = row.phone || row.phone_number || row.PHONE;

    const full_name = toTitleCase(rawName);
    const id_number = rawId != null ? String(rawId).trim() : null;
    const employer = (row.employer || row.Employer || '').trim() || null;
    const reference = (row.reference_number || row.PNO || row.P_NO || row['P/NO'] || '').trim() || null;
    const joinDate = (row.join_date || row.joinDate || '').trim() || null;

    if (!full_name || !id_number) {
      results.skipped.push({ row: rowNum, reason: 'Missing full_name or national_id' });
      continue;
    }
    if (!isValidIdNumber(id_number)) {
      results.skipped.push({ row: rowNum, reason: 'national_id must be 6-10 digits' });
      continue;
    }

    // Phone is optional now. If the cell is present but malformed (e.g.
    // contains letters), that's an error - but a blank cell just means the
    // member didn't have a phone on file, which is a legitimate state for
    // pre-existing members from a legacy register.
    let phone_number = null;
    const phoneRaw = rawPhone != null ? String(rawPhone).trim() : '';
    if (phoneRaw) {
      const normalized = normalizePhone(phoneRaw);
      if (!normalized) {
        results.skipped.push({
          row: rowNum,
          reason: `phone "${phoneRaw}" is not a valid Kenyan number`,
        });
        continue;
      }
      phone_number = normalized;
    }

    try {
      const existing = await findByPhoneOrId(phone_number, id_number);
      if (existing) {
        results.skipped.push({
          row: rowNum,
          reason: `Already exists as "${existing.full_name}" (matched on ${
            existing.id_number === id_number ? 'national ID' : 'phone number'
          })`,
        });
        continue;
      }

      await create({
        full_name,
        id_number,
        phone_number, // may be null
        employer,
        imported_reference: reference,
        created_at: joinDate,
      });
      results.created++;
    } catch (err) {
      results.skipped.push({
        row: rowNum,
        reason: err.code === '23505' ? 'Duplicate ID, phone, or reference number' : (err.message || 'Save failed'),
      });
    }
  }

  return results;
}

// Find by either phone or ID number (used for duplicate registration checks)
async function findByPhoneOrId(phone_number, id_number) {
  // phone_number may be null (see bulkImport). In that case, only the ID is
  // checked - passing null for a NULL comparison would silently match
  // nothing anyway, but building the query this way is clearer.
  if (phone_number) {
    const result = await pool.query(
      'SELECT * FROM members WHERE phone_number = $1 OR id_number = $2 LIMIT 1',
      [phone_number, id_number]
    );
    return result.rows[0];
  }
  const result = await pool.query(
    'SELECT * FROM members WHERE id_number = $1 LIMIT 1',
    [id_number]
  );
  return result.rows[0];
}

// Get all members (admin use)
async function findAll() {
  const result = await pool.query('SELECT * FROM members ORDER BY created_at DESC');
  return result.rows;
}

// The reference-code expression, reused everywhere a member reference needs
// to be shown. imported_reference is populated for every member - imported
// members get their legacy P/NO, new members get the next sequence value.
// The COALESCE fallback only ever fires for a hypothetical pre-migration
// row that somehow has no reference; it's kept as a defence so a display
// query can never return NULL or break the UI.
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
//
// SELECT m.* means is_board_staff flows through to the API automatically -
// no change needed here when the flag is added. The frontend uses it to
// render the "Board/Staff" badge in the Member Directory.
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
//
// The one exception to that trust: is_board_staff is rejected outright here,
// even if a controller passes it. That field grants auto-approved loans, so
// it's the one column that must not be reachable from the general edit path.
// All changes go through setBoardStaffStatus(), which is called from a route
// gated by members:set_board_status, so the privilege cannot be granted by
// a controller that forgot to exclude the field from its whitelist.
async function update(id, updates) {
  if ('is_board_staff' in updates) {
    throw new Error('is_board_staff must be changed via setBoardStaffStatus(), not update()');
  }

  const keys = Object.keys(updates);
  const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
  const values = keys.map((key) => updates[key]);
  const result = await pool.query(
    `UPDATE members SET ${setClause} WHERE id = $1 RETURNING *`,
    [id, ...values]
  );
  return result.rows[0];
}

// --- Board/Staff flag ---

// Promote (or demote) a single member to board/staff. This is the ONLY
// write path for is_board_staff - call it from a route gated by
// members:set_board_status (Super Administrator and SACCO Administrator
// only). Returns the updated member row so the caller can write an audit
// entry with the before/after state, and so the UI can update immediately.
//
// A demotion (setBoardStaffStatus(id, false)) is deliberately allowed:
// board composition changes, and the alternative - leaving the flag stuck
// on - would silently keep auto-approval for someone who no longer holds
// the privilege.
async function setBoardStaffStatus(memberId, isBoardStaff) {
  const result = await pool.query(
    `UPDATE members
     SET is_board_staff = $1
     WHERE id = $2
     RETURNING id, full_name, imported_reference, is_board_staff`,
    [!!isBoardStaff, memberId]
  );
  return result.rows[0] || null;
}

// Batch variant, used for the one-off backfill of the current 17 board
// and staff members and for any future bulk correction. Matches on
// imported_reference (the SACCO's own member number), because that is the
// identifier the SACCO's register uses - the internal `id` is not
// meaningful to the board and would be error-prone in a hand-typed list.
//
// Returns the rows that were actually updated, so the caller can confirm
// the expected count (e.g. "17 of 17 matched") and spot any reference in
// the list that did not correspond to a live member. References that do
// not match are silently absent from the result rather than throwing -
// the caller decides whether a mismatch is fatal.
async function setBoardStaffByReferences(references, isBoardStaff = true) {
  if (!Array.isArray(references) || references.length === 0) return [];
  const result = await pool.query(
    `UPDATE members
     SET is_board_staff = $1
     WHERE imported_reference = ANY($2::text[])
     RETURNING id, full_name, imported_reference, is_board_staff`,
    [!!isBoardStaff, references.map(String)]
  );
  return result.rows;
}

// Lookup used by loanService.apply() to decide auto-approval. Reads only
// the flag column, so it stays cheap even if apply() is already holding a
// full member row and only needs to re-check this one field.
//
// Note: loanService.apply() currently reads the flag from the member row
// that canApply() already loaded, rather than calling this. This function
// exists for any future caller that needs the answer without loading the
// whole member.
async function isBoardStaff(memberId) {
  const result = await pool.query(
    'SELECT is_board_staff FROM members WHERE id = $1',
    [memberId]
  );
  return result.rows[0]?.is_board_staff === true;
}

// --- Member deletion ---

// Permanently delete a member record. Refuses if the member has ANY
// transaction history - deposits, loans, repayments, or withdrawals are
// financial records that must be retained for audit and reconciliation.
//
// Return values:
//   { deleted: true, member }            — deletion succeeded
//   { deleted: false, code: 'HAS_HISTORY', message, counts }
//                                        — blocked; member record intact
//   null                                 — member does not exist
//
// Design notes:
//
//   • The history check and the DELETE run inside one transaction, with
//     the member row locked FOR UPDATE. Without the lock, a payment could
//     land between "check finds zero" and "DELETE runs", orphaning the
//     payment via a cascade. The lock makes that impossible.
//
//   • References are NEVER reused. Deleting a member does not roll back
//     sacco_member_reference_seq — the sequence continues, so the next
//     new member never inherits a deleted member's number. This mirrors
//     the SACCO's paper register: a retired number stays retired.
//
//   • A foreign-key violation (code 23503) that slips past the pre-check
//     — e.g. a table we don't count here, like ussd_sessions, holding a
//     RESTRICT reference to this member — is converted to the same
//     "HAS_HISTORY" response rather than surfacing as a 500. The member
//     record is intact either way; the caller gets a usable message.
//
// The config module exports both a `.query()` proxy and the underlying pg
// Pool as `.pool`, so getting a dedicated client for the transaction means
// `pool.pool.connect()` — the name collides because Member.js imports the
// module as `pool`. Loan.js reads more naturally (`db.pool.connect()`)
// because it aliases the module as `db`. Same mechanism.
async function remove(memberId) {
  const client = await pool.pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the member row so a concurrent payment insert cannot slip
    // between the history check and the delete.
    const memberRes = await client.query(
      'SELECT id, full_name, imported_reference FROM members WHERE id = $1 FOR UPDATE',
      [memberId]
    );
    if (memberRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return null;
    }
    const member = memberRes.rows[0];

    // One round-trip, four counts. Covers every table that carries member
    // financial history. If the total is non-zero, deletion is blocked.
    const histRes = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM payments    WHERE member_id = $1) AS payments,
         (SELECT COUNT(*) FROM loans       WHERE member_id = $1) AS loans,
         (SELECT COUNT(*) FROM repayments  WHERE member_id = $1) AS repayments,
         (SELECT COUNT(*) FROM withdrawals WHERE member_id = $1) AS withdrawals`,
      [memberId]
    );

    const counts = histRes.rows[0];
    const total = Object.values(counts).reduce((sum, n) => sum + Number(n), 0);

    if (total > 0) {
      await client.query('ROLLBACK');
      const parts = Object.entries(counts)
        .filter(([, n]) => Number(n) > 0)
        .map(([table, n]) => `${n} ${table}`)
        .join(', ');
      return {
        deleted: false,
        code: 'HAS_HISTORY',
        message: `This member has transaction history (${parts}) and cannot be deleted. Their record must be retained for audit and financial accuracy.`,
        counts,
      };
    }

    await client.query('DELETE FROM members WHERE id = $1', [memberId]);
    await client.query('COMMIT');

    return { deleted: true, member };
  } catch (err) {
    await client.query('ROLLBACK');

    // FK violation from a table we didn't count above (e.g. audit_log,
    // ussd_sessions). Treat as "has related records" — same outcome,
    // cleaner message, no 500.
    if (err.code === '23503') {
      return {
        deleted: false,
        code: 'HAS_HISTORY',
        message: 'This member has related records and cannot be deleted.',
      };
    }

    throw err;
  } finally {
    client.release();
  }
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
  REFERENCE_SQL,
  bulkImport,
  normalizePhone,
  toTitleCase,
  // PIN authentication
  hasPinSet,
  setPin,
  isPinLocked,
  verifyPin,
  recordFailedPinAttempt,
  resetPinAttempts,
  // Board/Staff flag
  setBoardStaffStatus,
  setBoardStaffByReferences,
  isBoardStaff,
  // Deletion
  remove,
};