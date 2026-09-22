const express = require('express');
const router = express.Router();
const AuditLog = require('../models/AuditLog');
const { authenticate, requirePermission } = require('../middleware/auth');

router.get('/', authenticate, requirePermission('audit:read'), async (req, res) => {
  try {
    const { search, category, limit, offset } = req.query;
    const entries = await AuditLog.list({
      search,
      category,
      limit: limit ? Math.min(Number(limit), 200) : 50,
      offset: offset ? Number(offset) : 0,
    });
    res.json(entries);
  } catch (err) {
    console.error('Audit log fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

module.exports = router;