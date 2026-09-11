const express = require('express');
const router = express.Router();
const loanController = require('../controllers/loanController');
const { authenticate, requireAdmin } = require('../middleware/auth');

// Member routes (no auth required - USSD uses these)
router.post('/apply', loanController.applyLoan);
router.get('/active/:memberId', loanController.getActiveLoan);
router.get('/history/:memberId', loanController.getLoanHistory);
router.post('/repay', loanController.repayLoan);

// Admin routes (authentication required)
router.post('/approve/:loanId', authenticate, requireAdmin, loanController.approveLoan);
router.post('/reject/:loanId', authenticate, requireAdmin, loanController.rejectLoan);
router.post('/disburse/:loanId', authenticate, requireAdmin, loanController.markDisbursed);
router.get('/admin/list', authenticate, requireAdmin, loanController.getAdminLoans);
router.get('/admin/pending', authenticate, requireAdmin, loanController.getPendingLoans);

module.exports = router;