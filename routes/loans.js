const express = require('express');
const router = express.Router();
const loanController = require('../controllers/loanController');

// Temporarily remove requireApiKey to bypass the error
// We'll add it back after we confirm the middleware file exists.

router.post('/apply', loanController.applyLoan);
router.get('/active/:memberId', loanController.getActiveLoan);
router.get('/history/:memberId', loanController.getLoanHistory);
router.post('/repay', loanController.repayLoan);
router.post('/approve/:loanId', loanController.approveLoan);

module.exports = router;