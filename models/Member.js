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
  credit_limit INTEGER DEFAULT 0,
  total_outstanding_balance INTEGER DEFAULT 0,
  successful_repayments INTEGER DEFAULT 0,
  wallet_balance INTEGER DEFAULT 0,
  is_board_staff BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW()
);
`;

const createWalletTxTableQuery = `
CREATE TABLE IF NOT EXISTS wallet_transactions (
  id SERIAL PRIMARY KEY,
  member_id INT REFERENCES members(id),
  amount INTEGER NOT NULL,
  transaction_type VARCHAR(30) NOT NULL,
  reference VARCHAR(50),
  wallet_type VARCHAR(30) DEFAULT 'general',
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
  await pool.query(createWalletTxTableQuery);

  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS imported_reference VARCHAR(30);`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS pin_hash VARCHAR(255);`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS pin_failed_attempts INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMP;`);
  await pool.query(`ALTER TABLE members ALTER COLUMN phone_number DROP NOT NULL;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS is_board_staff BOOLEAN NOT NULL DEFAULT FALSE;`);
  
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS wallet_balance_emergency INTEGER DEFAULT 0;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS wallet_balance_school INTEGER DEFAULT 0;`);
  
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS jipange_unlock_date DATE;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS holiday_unlock_date DATE;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS jipange_interest_date DATE;`);
  await pool.query(`ALTER TABLE members ADD COLUMN IF NOT EXISTS holiday_interest_date DATE;`);
  
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
      full_name, id_number, phone_number, nationality || null, age || null, employer || null, scheme || 'holiday_savings',
      0, 0, 0, imported_reference || null, created_at || null,
    ]
  );
  return result.rows[0];
}

async function findByPhone(phone_number) {
  if (!phone_number) return null;
  const normalized = normalizePhone(phone_number);
  if (!normalized) return null;
  const local = normalized.slice(4);
  const variants = [normalized, `0${local}`, `254${local}`, local];

  const result = await pool.query(
    'SELECT * FROM members WHERE phone_number = ANY($1::text[]) LIMIT 1',
    [variants]
  );
  return result.rows[0];
}

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
        results.skipped.push({ row: rowNum, reason: `phone "${phoneRaw}" is not a valid Kenyan number` });
        continue;
      }
      phone_number = normalized;
    }

    try {
      const existing = await findByPhoneOrId(phone_number, id_number);
      if (existing) {
        results.skipped.push({ row: rowNum, reason: `Already exists as "${existing.full_name}"` });
        continue;
      }

      await create({ full_name, id_number, phone_number, employer, imported_reference: reference, created_at: joinDate });
      results.created++;
    } catch (err) {
      results.skipped.push({ row: rowNum, reason: err.code === '23505' ? 'Duplicate ID/phone' : (err.message || 'Save failed') });
    }
  }
  return results;
}

async function findByPhoneOrId(phone_number, id_number) {
  if (phone_number) {
    const result = await pool.query('SELECT * FROM members WHERE phone_number = $1 OR id_number = $2 LIMIT 1', [phone_number, id_number]);
    return result.rows[0];
  }
  const result = await pool.query('SELECT * FROM members WHERE id_number = $1 LIMIT 1', [id_number]);
  return result.rows[0];
}

async function findAll() {
  const result = await pool.query('SELECT * FROM members ORDER BY created_at DESC');
  return result.rows;
}

const REFERENCE_SQL = `COALESCE(m.imported_reference, 'KEMRI-' || EXTRACT(YEAR FROM m.created_at)::text || '-' || LPAD(m.id::text, 4, '0'))`;

async function findById(id) {
  const result = await pool.query(`SELECT m.*, ${REFERENCE_SQL} AS reference FROM members m WHERE m.id = $1`, [id]);
  return result.rows[0];
}

async function findAllForDirectory() {
  const result = await pool.query(`
    SELECT m.*, ${REFERENCE_SQL} AS reference,
      COALESCE(sav.balance, 0) AS savings_balance,
      loan.status AS current_loan_status
    FROM members m
    LEFT JOIN LATERAL (SELECT SUM(amount) AS balance FROM payments p WHERE p.member_id = m.id AND p.status = 'completed' AND p.loan_id IS NULL) sav ON true
    LEFT JOIN LATERAL (SELECT status FROM loans l WHERE l.member_id = m.id AND l.status IN ('pending', 'approved', 'disbursing', 'disbursed') ORDER BY l.applied_at DESC LIMIT 1) loan ON true
    ORDER BY m.created_at DESC
  `);
  return result.rows;
}

async function update(id, updates) {
  if ('is_board_staff' in updates) throw new Error('is_board_staff must be changed via setBoardStaffStatus()');
  const keys = Object.keys(updates);
  const setClause = keys.map((key, i) => `${key} = $${i + 2}`).join(', ');
  const values = keys.map((key) => updates[key]);
  const result = await pool.query(`UPDATE members SET ${setClause} WHERE id = $1 RETURNING *`, [id, ...values]);
  return result.rows[0];
}

async function setBoardStaffStatus(memberId, isBoardStaff) {
  const newLimit = isBoardStaff ? 10000 : 5000;
  const result = await pool.query(
    `UPDATE members SET is_board_staff = $1, credit_limit = $2 WHERE id = $3 
     RETURNING id, full_name, imported_reference, is_board_staff, credit_limit`,
    [!!isBoardStaff, newLimit, memberId]
  );
  return result.rows[0] || null;
}

async function setBoardStaffByReferences(references, isBoardStaff = true) {
  if (!Array.isArray(references) || references.length === 0) return [];
  const newLimit = isBoardStaff ? 10000 : 5000;
  const result = await pool.query(
    `UPDATE members SET is_board_staff = $1, credit_limit = $2 WHERE imported_reference = ANY($3::text[]) 
     RETURNING id, full_name, imported_reference, is_board_staff, credit_limit`, 
    [!!isBoardStaff, newLimit, references.map(String)]
  );
  return result.rows;
}

async function isBoardStaff(memberId) {
  const result = await pool.query('SELECT is_board_staff FROM members WHERE id = $1', [memberId]);
  return result.rows[0]?.is_board_staff === true;
}

const VALID_WALLETS = {
  general: 'wallet_balance',
  emergency: 'wallet_balance_emergency',
  school: 'wallet_balance_school'
};

// 2026-11-07: Added ACID safety to creditWallet
async function creditWallet(memberId, amount, type, reference, walletType = 'general', client = null) {
  const dbClient = client || pool;
  const isTransactionOwner = !client;
  const col = VALID_WALLETS[walletType] || VALID_WALLETS.general;
  const amt = Math.round(Number(amount));

  if (isTransactionOwner) await dbClient.query('BEGIN');

  try {
    await dbClient.query(
      `UPDATE members SET ${col} = ${col} + $1 WHERE id = $2`,
      [amt, memberId]
    );
    
    await dbClient.query(
      `INSERT INTO wallet_transactions (member_id, amount, transaction_type, reference, wallet_type) 
       VALUES ($1, $2, $3, $4, $5)`,
      [memberId, amt, type, reference, walletType]
    );

    if (isTransactionOwner) await dbClient.query('COMMIT');
  } catch (err) {
    if (isTransactionOwner) await dbClient.query('ROLLBACK');
    throw err;
  }
}

// 2026-11-07: Added ACID safety to debitWallet
async function debitWallet(memberId, amount, type, reference, walletType = 'general', client = null) {
  const dbClient = client || pool;
  const isTransactionOwner = !client; // If we own the connection, we manage the transaction
  const col = VALID_WALLETS[walletType] || VALID_WALLETS.general;
  const amt = Math.round(Number(amount));
  
  if (isTransactionOwner) await dbClient.query('BEGIN');
  
  try {
    const res = await dbClient.query(
      `UPDATE members SET ${col} = ${col} - $1 
       WHERE id = $2 AND ${col} >= $1 RETURNING ${col} AS new_balance`,
      [amt, memberId]
    );
    
    if (res.rows.length === 0) throw new Error(`Insufficient ${walletType} wallet balance`);
    
    const ref = reference || `WD-${Date.now()}-${memberId}`;

    await dbClient.query(
      `INSERT INTO wallet_transactions (member_id, amount, transaction_type, reference, wallet_type) 
       VALUES ($1, $2, $3, $4, $5)`,
      [memberId, -amt, type, ref, walletType]
    );

    if (isTransactionOwner) await dbClient.query('COMMIT');
    
    return { wallet_balance: res.rows[0].new_balance, reference: ref };
  } catch (err) {
    if (isTransactionOwner) await dbClient.query('ROLLBACK');
    throw err;
  }
}

// 2026-11-03: Set 6-month unlock and 6-month first interest date
async function setJipangeDates(memberId) {
  await pool.query(
    `UPDATE members 
     SET jipange_unlock_date = (NOW() + INTERVAL '6 months')::date,
         jipange_interest_date = (NOW() + INTERVAL '6 months')::date
     WHERE id = $1 AND jipange_unlock_date IS NULL`,
    [memberId]
  );
}

// 2026-11-03: Set 6-month unlock and 6-month first interest date
async function setHolidayDates(memberId) {
  await pool.query(
    `UPDATE members 
     SET holiday_unlock_date = (NOW() + INTERVAL '6 months')::date,
         holiday_interest_date = (NOW() + INTERVAL '6 months')::date
     WHERE id = $1 AND holiday_unlock_date IS NULL`,
    [memberId]
  );
}

async function getUpcomingUnlocks() {
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + 7);
  const dateString = targetDate.toISOString().split('T')[0];

  const result = await pool.query(
    `SELECT 
       m.id, m.full_name, m.phone_number, m.jipange_unlock_date, m.holiday_unlock_date,
       COALESCE(p_jip.sum, 0) AS jipange_balance,
       COALESCE(p_hol.sum, 0) AS holiday_balance
     FROM members m
     LEFT JOIN LATERAL (SELECT SUM(amount) AS sum FROM payments WHERE member_id = m.id AND savings_type = 'jipange' AND status = 'completed') p_jip ON true
     LEFT JOIN LATERAL (SELECT SUM(amount) AS sum FROM payments WHERE member_id = m.id AND savings_type = 'holiday' AND status = 'completed') p_hol ON true
     WHERE m.jipange_unlock_date = $1 OR m.holiday_unlock_date = $1`,
    [dateString]
  );
  return result.rows;
}

async function getMembersDueForInterest() {
  const result = await pool.query(
    `SELECT 
       m.id, m.full_name, m.phone_number, 
       m.jipange_interest_date, m.holiday_interest_date,
       COALESCE(p_jip.sum, 0) AS jipange_balance,
       COALESCE(p_hol.sum, 0) AS holiday_balance
     FROM members m
     LEFT JOIN LATERAL (SELECT SUM(amount) AS sum FROM payments WHERE member_id = m.id AND savings_type = 'jipange' AND status = 'completed') p_jip ON true
     LEFT JOIN LATERAL (SELECT SUM(amount) AS sum FROM payments WHERE member_id = m.id AND savings_type = 'holiday' AND status = 'completed') p_hol ON true
     WHERE (m.jipange_interest_date <= CURRENT_DATE AND m.jipange_interest_date IS NOT NULL)
        OR (m.holiday_interest_date <= CURRENT_DATE AND m.holiday_interest_date IS NOT NULL)`
  );
  return result.rows;
}

// 2026-11-03: Update the interest date by +6 months (compounding) and fix the date drift bug
async function resetInterestDate(memberId, savingsType, client) {
  const col = savingsType === 'jipange' ? 'jipange_interest_date' : 'holiday_interest_date';
  await client.query(
    `UPDATE members SET ${col} = (${col} + INTERVAL '6 months')::date WHERE id = $1`,
    [memberId]
  );
}

async function remove(memberId) {
  const client = await pool.pool.connect();
  try {
    await client.query('BEGIN');
    const memberRes = await client.query('SELECT id, full_name, imported_reference FROM members WHERE id = $1 FOR UPDATE', [memberId]);
    if (memberRes.rows.length === 0) { await client.query('ROLLBACK'); return null; }
    const member = memberRes.rows[0];

    const histRes = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM payments    WHERE member_id = $1 AND status = 'completed') AS payments,
         (SELECT COUNT(*) FROM loans       WHERE member_id = $1 AND status IN ('disbursing', 'disbursed', 'repaid')) AS loans,
         (SELECT COUNT(*) FROM repayments  WHERE member_id = $1) AS repayments,
         (SELECT COUNT(*) FROM withdrawals WHERE member_id = $1 AND status IN ('disbursing', 'processed')) AS withdrawals`,
      [memberId]
    );

    const counts = histRes.rows[0];
    const total = Object.values(counts).reduce((sum, n) => sum + Number(n), 0);

    if (total > 0) {
      await client.query('ROLLBACK');
      const parts = Object.entries(counts).filter(([, n]) => Number(n) > 0).map(([table, n]) => `${n} ${Number(n) === 1 ? table.replace(/s$/, '') : table}`).join(', ');
      return { deleted: false, code: 'HAS_HISTORY', message: `This member has financial history (${parts}) and cannot be deleted.`, counts };
    }

    await client.query(`DELETE FROM loans WHERE member_id = $1 AND status IN ('pending', 'rejected')`, [memberId]);
    await client.query(`DELETE FROM payments WHERE member_id = $1 AND status IN ('pending', 'failed')`, [memberId]);
    await client.query(`DELETE FROM withdrawals WHERE member_id = $1 AND status IN ('pending', 'rejected')`, [memberId]);
    await client.query('DELETE FROM members WHERE id = $1', [memberId]);
    await client.query('COMMIT');

    return { deleted: true, member };
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23503') return { deleted: false, code: 'HAS_HISTORY', message: 'This member has related records and cannot be deleted.' };
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  init, create, findByPhone, findById, findByPhoneOrId, findAll, findAllForDirectory,
  update, REFERENCE_SQL, bulkImport, normalizePhone, toTitleCase, hasPinSet, setPin,
  isPinLocked, verifyPin, recordFailedPinAttempt, resetPinAttempts, setBoardStaffStatus,
  setBoardStaffByReferences, isBoardStaff, creditWallet, debitWallet, 
  setJipangeDates, setHolidayDates,
  getUpcomingUnlocks, 
  getMembersDueForInterest,
  resetInterestDate,
  remove,
};