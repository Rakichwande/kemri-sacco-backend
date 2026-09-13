const db = require('../config/database');

const createTableQuery = `
CREATE TABLE IF NOT EXISTS ussd_sessions (
  id SERIAL PRIMARY KEY,
  session_id VARCHAR(100),
  phone_number VARCHAR(20),
  service_code VARCHAR(20),
  input_text VARCHAR(200),
  status VARCHAR(20) NOT NULL,
  duration_ms INT,
  message VARCHAR(300),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ussd_sessions_created_at ON ussd_sessions(created_at DESC);
`;

async function init() {
  await db.query(createTableQuery);
}

// Logs one USSD request/response cycle. Every request to the USSD endpoint
// is one hop in a session, not a full session - Africa's Talking calls this
// endpoint once per menu screen the caller sees. Never throws: a logging
// failure must never break the actual USSD response the caller is waiting on.
async function log({ sessionId, phoneNumber, serviceCode, inputText, status, durationMs, message }) {
  try {
    await db.query(
      `INSERT INTO ussd_sessions (session_id, phone_number, service_code, input_text, status, duration_ms, message)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [sessionId, phoneNumber, serviceCode, inputText, status, durationMs, message]
    );
  } catch (err) {
    console.error('USSD session log write failed (request still served):', err.message);
  }
}

async function recent(limit = 20) {
  const result = await db.query(
    `SELECT * FROM ussd_sessions ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return result.rows;
}

// Rough health signal for the System Health page: recent failure rate.
async function recentFailureStats(minutes = 60) {
  const result = await db.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
     FROM ussd_sessions
     WHERE created_at >= NOW() - ($1 || ' minutes')::interval`,
    [minutes]
  );
  return result.rows[0];
}

module.exports = { init, log, recent, recentFailureStats };
