const express = require('express');
const router = express.Router();
const Repayment = require('../models/Repayment');
const { authenticate, requireAdmin } = require('../middleware/auth');

router.get('/', authenticate, requireAdmin, async (req, res) => {
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
