// Simple shared-secret auth for internal/admin routes (e.g. listing all members).
// This is NOT member login - that's a Phase 2 concern once the web portal exists.
// This just stops the backend from being an open, unauthenticated data dump if
// the URL leaks or gets shared during demos.

function requireApiKey(req, res, next) {
  const providedKey = req.headers['x-api-key'];

  if (!process.env.ADMIN_API_KEY) {
    console.error('ADMIN_API_KEY is not set in .env - refusing to serve protected route');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  if (!providedKey || providedKey !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized - missing or invalid API key' });
  }

  next();
}

module.exports = requireApiKey;