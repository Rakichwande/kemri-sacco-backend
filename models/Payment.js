const pool = require('../config/database');

const createTableQuery = `
CREATE TABLE IF NOT EXISTS payments (
  id SERIAL PRIMARY KEY,
  member_id INT REFERENCES members(id),
  amount NUMERIC(10, 2) NOT NULL,
  phone_number VARCHAR(15) NOT NULL,
  checkout_request_id VARCHAR(100) UNIQUE,
  mpesa_receipt VARCHAR(50),
  status VARCHAR(20) DEFAULT 'pending', -- pending | completed | failed
  created_at TIMESTAMP DEFAULT NOW()
);
`;

async function init() {
  await pool.query(createTableQuery);
}

async function create({ member_id, amount, phone_number, checkout_request_id }) {
  const result = await pool.query(
    `INSERT INTO payments (member_id, amount, phone_number, checkout_request_id)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [member_id, amount, phone_number, checkout_request_id]
  );
  return result.rows[0];
}

async function updateStatus(checkout_request_id, status, mpesa_receipt = null) {
  const result = await pool.query(
    `UPDATE payments SET status = $1, mpesa_receipt = $2 WHERE checkout_request_id = $3 RETURNING *`,
    [status, mpesa_receipt, checkout_request_id]
  );
  return result.rows[0];
}

async function findByCheckoutId(checkout_request_id) {
  const result = await pool.query('SELECT * FROM payments WHERE checkout_request_id = $1', [checkout_request_id]);
  return result.rows[0];
}

module.exports = { init, create, updateStatus, findByCheckoutId };
