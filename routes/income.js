const express = require('express');
const router = express.Router();
const incomeController = require('../controllers/incomeController');
const { authenticate, requirePermission } = require('../middleware/auth');

// Loan Income report — the per-loan breakdown of principal, expected
// interest, and amount repaid to date. Gated on members:read because the
// data is member-loan level, same permission as the statement and
// performance routes. If the board wants this restricted to finance
// roles only, add a reports:read permission in middleware/permissions.js
// and swap the gate here.
router.get('/loans', authenticate, requirePermission('members:read'), incomeController.listLoans);

module.exports = router;