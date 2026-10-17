const express = require('express');
const router = express.Router();
const Dashboard = require('../models/Dashboard');
const { authenticate } = require('../middleware/auth');

// 2026-10-17: Changed from `requireAdmin` to just `authenticate`.
// The Dashboard is the landing page for everyone. Previously, roles like
// Finance Officer and Loans Officer were blocked with an "Admin access
// required" error when they tried to load it. The underlying data is
// read-only aggregates (savings, loans, etc.), so all staff need to see it.
router.get('/summary', authenticate, async (req, res) => {
  try {
    const summary = await Dashboard.getSummary();
    res.json(summary);
  } catch (err) {
    console.error('Dashboard summary error:', err);
    res.status(500).json({ error: 'Failed to load dashboard summary' });
  }
});

module.exports = router;