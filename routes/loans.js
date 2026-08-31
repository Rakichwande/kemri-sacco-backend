const express = require('express');
const router = express.Router();
const loanController = require('../controllers/loanController');
const { requireApiKey } = require('../middleware/requireApiKey');

// Member routes (protected by API key)
router.post('/apply', requireApiKey, loanController.applyLoan);
router.get('/active/:memberId', requireApiKey, loanController.getActiveLoan);
router.get('/history/:memberId', requireApiKey, loanController.getLoanHistory);
router.post('/repay', requireApiKey, loanController.repayLoan);

// Admin routes (add admin middleware in production)
router.post('/approve/:loanId', requireApiKey, loanController.approveLoan);

module.exports = router;