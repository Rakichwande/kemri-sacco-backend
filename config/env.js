// Fails fast at boot if a secret the app depends on for security isn't set,
// instead of silently falling back to a value that's sitting in source
// control (and therefore public, since this repo is public).
const REQUIRED = ['JWT_SECRET', 'DATABASE_URL'];

function loadEnv() {
  const missing = REQUIRED.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    console.error(
      `Missing required environment variable(s): ${missing.join(', ')}.\n` +
      `Set these in Render's environment settings (never in source) before starting the server.`
    );
    process.exit(1);
  }

  if (process.env.JWT_SECRET.length < 32) {
    console.error('JWT_SECRET is set but too short (< 32 chars) to be a safe signing secret.');
    process.exit(1);
  }

  return {
    JWT_SECRET: process.env.JWT_SECRET,
    DATABASE_URL: process.env.DATABASE_URL,
  };
}

module.exports = loadEnv();
