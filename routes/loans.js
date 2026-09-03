const express = require('express');
const router = express.Router();
const loanController = require('../controllers/loanController');

// Member routes
router.post('/apply', loanController.applyLoan);
router.get('/active/:memberId', loanController.getActiveLoan);
router.get('/history/:memberId', loanController.getLoanHistory);
router.post('/repay', loanController.repayLoan);

// Admin routes (add authentication middleware in production)
router.post('/approve/:loanId', loanController.approveLoan);
router.post('/disburse/:loanId', loanController.markDisbursed);
router.get('/admin/list', loanController.getAdminLoans);
router.get('/admin/pending', loanController.getPendingLoans);

module.exports = router;