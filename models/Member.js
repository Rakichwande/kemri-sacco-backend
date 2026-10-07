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

const MAX_PIN_ATTEMPTS = 5;
const PIN_LOCKOUT_MINUTES = 30;
const PIN_HASH_ROUNDS = 10;

function normalizePhone(input) {
  if (input === null || input === undefined) return null;
  let digits = String(input).replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('254')) digits = digits.slice(3);
  if (digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length !== 9) return null;
  if (!digits.startsWith('7') && !digits.startsWith('1')) return null;

  return `+254${digits}`;
}

async function init() {
  await pool.query(createTableQuery);

  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS imported_reference VARCHAR(30);`);

  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS pin_hash VARCHAR(255);`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS pin_failed_attempts INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMP;`);

  await pool.query(`ALTER TABLE members ALTER COLUMN phone_number DROP NOT NULL;`);

  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS is_board_staff BOOLEAN NOT NULL DEFAULT FALSE;`);

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_members_board_staff ON members (id) WHERE is_board_staff;`);

  await pool.query(`CREATE SEQUENCE IF NOT EXISTS sacco_member_reference_seq;`);

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
      phone_number,
      nationality || null,
      age || null,
      employer || null,
      scheme || 'holiday_savings',
      10000,
      0,
      0,
      imported_reference || null,
      created_at || null,
    ]
  );
  return result.rows[0];
}

async function findByPhone(phone_number) {
  if (!phone_number) return null;
  const normalized = normalizePhone(phone_number);
  if (!normalized) {
    return null;
  }
  const local = normalized.slice(4);
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

function isPinLocked(member) {
  return !!member.pin_locked_until && new Date(member.pin_locked_until) > new Date();
}

async function verifyPin(member, plainPin) {
  if (!member.pin_hash) return false;
  return bcrypt.compare(String(plainPin), member.pin_hash);
}

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

async function resetPinAttempts(memberId) {
  await pool.query(
    `UPDATE members SET pin_failed_attempts = 0, pin_locked_until = NULL WHERE id = $1`,
    [memberId]
  );
}

function toTitleCase(name) {
  if (!name) return name;
  const trimmed = String(name).trim();
  const upperCount = (trimmed.match(/[A-Z]/g) || []).length;
  const letterCount = (trimmed.match(/[A-Za-z]/g) || []).length;
  if (letterCount === 0 || upperCount / letterCount < 0.8) return trimmed;

  return trimmed
    .split(/\s+/)
    .map((word) => {
      if (word.length <= 2 && /^[A-Z]\.?$/.test(word)) return word.toUpperCase();
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join(' ');
}

async function bulkImport(rows) {
  const results = { created: 0, skipped: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
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
        phone_number,
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

async function findByPhoneOrId(phone_number, id_number) {
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

async function findAll() {
  const result = await pool.query('SELECT * FROM members ORDER BY created_at DESC');
  return result.rows;
}

const REFERENCE_SQL = `COALESCE(m.imported_reference, 'KEMRI-' || EXTRACT(YEAR FROM m.created_at)::text || '-' || LPAD(m.id::text, 4, '0'))`;

async function findById(id) {
  const result = await pool.query(
    `SELECT m.*, ${REFERENCE_SQL} AS reference FROM members m WHERE m.id = $1`,
    [id]
  );
  return result.rows[0];
}

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
      WHERE l.member_id = m.id AND l.status IN ('pending', 'approved', 'disbursing', 'disbursed')
      ORDER BY l.applied_at DESC
      LIMIT 1
    ) loan ON true
    ORDER BY m.created_at DESC
  `);
  return result.rows;
}

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

async function isBoardStaff(memberId) {
  const result = await pool.query(
    'SELECT is_board_staff FROM members WHERE id = $1',
    [memberId]
  );
  return result.rows[0]?.is_board_staff === true;
}

// --- Member deletion ---

// Permanently delete a member record. Refuses if the member has any
// FINANCIAL history — completed deposits, repayments, or loans/withdrawals
// that actually moved money. Records that carry no financial consequence
// do NOT block deletion; they are removed alongside the member.
//
// What blocks deletion (financial history):
//   - payments with status = 'completed'      real money arrived
//   - repayments (any row)                    real money arrived
//   - loans in 'disbursing'/'disbursed'/'repaid'  real money left or is in flight
//   - withdrawals in 'disbursing'/'processed'     same
//
// What does NOT block (no financial consequence):
//   - payments with status = 'pending' or 'failed'  an STK push was
//     attempted but never completed. The row is proof of an ATTEMPT,
//     not of money movement. Counting these blocked deletion of members
//     who had only tried and failed to deposit, which defeats the
//     purpose of the rule — protect real records, not abandoned
//     attempts. (A member whose STK push was cancelled by mistake on
//     their side should not be undeletable forever.)
//   - loans in 'pending'/'rejected'           an application, not an obligation
//   - withdrawals in 'pending'/'rejected'     a request, not a payout
//
// Why the distinction matters: a financial record has to survive for
// audit and reconciliation because reversing it would break reports and
// remove evidence of real money movement. A pending application or a
// failed payment attempt carries no such weight — deleting it removes
// nothing that ever mattered.
//
// Reference numbers are NEVER reused. Deleting a member does not roll
// back sacco_member_reference_seq — the sequence continues, so the next
// new member never inherits a deleted member's number. Same for loan
// ids: LN-00010 once issued is retired permanently.
//
// Return values:
//   { deleted: true, member, removedLoans, removedWithdrawals }
//                                        — deletion succeeded
//   { deleted: false, code: 'HAS_HISTORY', message, counts }
//                                        — blocked; member record intact
//   null                                 — member does not exist
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

    // Count BLOCKING history. Every subquery is filtered to statuses
    // that represent actual or in-flight money movement. Pending and
    // failed records (payment attempts, loan applications, withdrawal
    // requests) are excluded — they carry no financial consequence and
    // are cleaned up below if present.
    const histRes = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM payments    WHERE member_id = $1
            AND status = 'completed') AS payments,
         (SELECT COUNT(*) FROM loans       WHERE member_id = $1
            AND status IN ('disbursing', 'disbursed', 'repaid')) AS loans,
         (SELECT COUNT(*) FROM repayments  WHERE member_id = $1) AS repayments,
         (SELECT COUNT(*) FROM withdrawals WHERE member_id = $1
            AND status IN ('disbursing', 'processed')) AS withdrawals`,
      [memberId]
    );

    const counts = histRes.rows[0];
    const total = Object.values(counts).reduce((sum, n) => sum + Number(n), 0);

    if (total > 0) {
      await client.query('ROLLBACK');

      // Singular / plural: "1 payment" not "1 payments". Each table name
      // ends in 's', so stripping a trailing 's' for n===1 is safe.
      const parts = Object.entries(counts)
        .filter(([, n]) => Number(n) > 0)
        .map(([table, n]) => `${n} ${Number(n) === 1 ? table.replace(/s$/, '') : table}`)
        .join(', ');

      return {
        deleted: false,
        code: 'HAS_HISTORY',
        message: `This member has financial history (${parts}) and cannot be deleted. Their record must be retained for audit and financial accuracy.`,
        counts,
      };
    }

    // No blocking history. Now clear the NON-BLOCKING records that
    // reference this member via foreign key. These carry no financial
    // consequence but do have FK constraints that would prevent the
    // member delete:
    //
    //   - pending/rejected loans      (applications, not obligations)
    //   - pending/rejected withdrawals (requests, not payouts)
    //   - pending/failed payments      (STK attempts, not payments)
    //
    // Payments must be removed too, otherwise the FK constraint on
    // payments.member_id would block the member delete. The order
    // matters: loans first (payments.loan_id may reference loans), then
    // payments, then withdrawals, then the member.
    const removedLoansRes = await client.query(
      `DELETE FROM loans WHERE member_id = $1 AND status IN ('pending', 'rejected')
       RETURNING id, status`,
      [memberId]
    );

    const removedPaymentsRes = await client.query(
      `DELETE FROM payments WHERE member_id = $1 AND status IN ('pending', 'failed')
       RETURNING id, status`,
      [memberId]
    );

    const removedWithdrawalsRes = await client.query(
      `DELETE FROM withdrawals WHERE member_id = $1 AND status IN ('pending', 'rejected')
       RETURNING id, status`,
      [memberId]
    );

    // Delete the member itself.
    await client.query('DELETE FROM members WHERE id = $1', [memberId]);
    await client.query('COMMIT');

    return {
      deleted: true,
      member,
      removedLoans: removedLoansRes.rows,
      removedPayments: removedPaymentsRes.rows,
      removedWithdrawals: removedWithdrawalsRes.rows,
    };
  } catch (err) {
    await client.query('ROLLBACK');

    // FK violation from a table we didn't account for above (e.g.
    // audit_log with a hard FK, ussd_sessions with a RESTRICT reference).
    // Treat as "has related records" — same outcome, cleaner message,
    // no 500.
    if (err.code === '23503') {
      return {
        deleted: false,
        code: 'HAS_HISTORY',
        message: 'This member has related records and cannot be deleted. Their record must be retained for audit and financial accuracy.',
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
  hasPinSet,
  setPin,
  isPinLocked,
  verifyPin,
  recordFailedPinAttempt,
  resetPinAttempts,
  setBoardStaffStatus,
  setBoardStaffByReferences,
  isBoardStaff,
  remove,
};