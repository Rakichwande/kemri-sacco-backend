const express = require('express');
const router = express.Router();
const Repayment = require('../models/Repayment');
const { authenticate, requirePermission } = require('../middleware/auth');

// 2026-10-17: Changed from `requireAdmin` to `requirePermission('loans:read')`.
// This allows roles like Finance Officer and Loans Officer to view the 
// repayment ledger, while still blocking unauthorized roles.
router.get('/', authenticate, requirePermission('loans:read'), async (req, res) => {
  try {
    const { search, from, to, channel, limit, offset } = req.query;
    const repayments = await Repayment.findAll({
      search, from, to, channel,
      limit: limit ? Math.min(Number(limit), 200) : 50,
      offset: offset ? Number(offset) : 0,
    });
    res.json(repayments);
  } catch (err) {
    console.error('Repayments fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch repayments' });
  }
});

module.exports = router;