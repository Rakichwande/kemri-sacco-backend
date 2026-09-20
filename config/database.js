const { Pool } = require('pg');

// NOTE: search_path used to be forced here via `options: '-c search_path=public'`.
// That worked fine against Render's Postgres, but Neon's pooled (PgBouncer)
// endpoint explicitly rejects that startup parameter - "unsupported startup
// parameter in options: search_path" - which made the app unable to boot at
// all after migrating to Neon. The fix is set at the database role level
// instead (ALTER ROLE neondb_owner SET search_path = public;), which the
// pooler does support and which persists across connections without
// needing anything passed at connection time. If this project ever moves
// off a pooled/PgBouncer-style connection, this app-level override could be
// reintroduced safely - just don't combine it with a pooled endpoint.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

pool.on('connect', () => {
  console.log('✅ Database connected successfully');
});

pool.on('error', (err) => {
  console.error('❌ Unexpected database error:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};