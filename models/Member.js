const pool = require('../config/database');

// Run this once to set up the table (or move into a migrations folder later)
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
  created_at TIMESTAMP DEFAULT NOW()
);
`;

async function init() {
  await pool.query(createTableQuery);
}

async function create(member) {
  const { full_name, id_number, phone_number, nationality, age, employer, scheme } = member;
  const result = await pool.query(
    `INSERT INTO members (full_name, id_number, phone_number, nationality, age, employer, scheme)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [full_name, id_number, phone_number, nationality, age, employer, scheme]
  );
  return result.rows[0];
}

async function findByPhone(phone_number) {
  const result = await pool.query('SELECT * FROM members WHERE phone_number = $1', [phone_number]);
  return result.rows[0];
}

async function findById(id) {
  const result = await pool.query('SELECT * FROM members WHERE id = $1', [id]);
  return result.rows[0];
}

async function findAll() {
  const result = await pool.query('SELECT * FROM members ORDER BY created_at DESC');
  return result.rows;
}

module.exports = { init, create, findByPhone, findById, findAll };
