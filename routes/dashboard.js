const express = require('express');
const router = express.Router();
const Dashboard = require('../models/Dashboard');
const { authenticate, requireAdmin } = require('../middleware/auth');

router.get('/summary', authenticate, requireAdmin, async (req, res) => {
  try {
    const summary = await Dashboard.getSummary();
    res.json(summary);
  } catch (err) {
    console.error('Dashboard summary error:', err);
    res.status(500).json({ error: 'Failed to load dashboard summary' });
  }
});

module.exports = router;
