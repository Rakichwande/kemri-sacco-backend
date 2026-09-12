const db = require('../config/database');

const createTableQuery = `
CREATE TABLE IF NOT EXISTS audit_log (
  id SERIAL PRIMARY KEY,
  actor_id INT REFERENCES admins(id),
  actor_username VARCHAR(50) NOT NULL,
  action VARCHAR(60) NOT NULL,
  category VARCHAR(30) NOT NULL,
  target_type VARCHAR(50) NOT NULL,
  target_id VARCHAR(50),
  target_label VARCHAR(150),
  details TEXT,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_created_at ON audit_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_log_category ON audit_log(category);
`;

async function init() {
  await db.query(createTableQuery);

  // Originally this FK blocked deleting an admin account entirely once they'd
  // logged even one action (discovered the hard way trying to delete one).
  // SET NULL lets the account be removed while actor_username - captured at
  // write time - still preserves who did what in the historical record.
  await db.query(`ALTER TABLE audit_log DROP CONSTRAINT IF EXISTS audit_log_actor_id_fkey;`);
  await db.query(`
    ALTER TABLE audit_log ADD CONSTRAINT audit_log_actor_id_fkey
    FOREIGN KEY (actor_id) REFERENCES admins(id) ON DELETE SET NULL;
  `);
}

// Records one audit entry. Deliberately never throws: a failure to log an
// action must never roll back or fail the action itself (approving a loan
// still succeeds even if this insert fails) - it only logs the failure.
async function log({ actorId, actorUsername, action, category, targetType, targetId, targetLabel, details }) {
  try {
    await db.query(
      `INSERT INTO audit_log
        (actor_id, actor_username, action, category, target_type, target_id, target_label, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [actorId, actorUsername, action, category, targetType, String(targetId), targetLabel || null, details || null]
    );
  } catch (err) {
    console.error('Audit log write failed (action still proceeded):', err.message);
  }
}

async function list({ search, category, limit = 50, offset = 0 } = {}) {
  const conditions = [];
  const values = [];
  let i = 1;

  if (category && category !== 'all') {
    conditions.push(`category = $${i++}`);
    values.push(category);
  }
  if (search) {
    conditions.push(
      `(actor_username ILIKE $${i} OR action ILIKE $${i} OR target_label ILIKE $${i} OR details ILIKE $${i})`
    );
    values.push(`%${search}%`);
    i++;
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitParam = i++;
  const offsetParam = i++;
  values.push(limit, offset);

  const result = await db.query(
    `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT $${limitParam} OFFSET $${offsetParam}`,
    values
  );
  return result.rows;
}

module.exports = { init, log, list };
