const express = require('express');
const router = express.Router();
const loanController = require('../controllers/loanController');
const { authenticate, requireAdmin } = require('../middleware/auth');

// NOTE: The routes that used to live here - POST /apply, GET
// /active/:memberId, GET /history/:memberId, POST /repay - were commented
// "no auth required - USSD uses these", but controllers/ussdController.js
// actually calls LoanService.apply(), Loan.getActiveLoan(), and
// paymentService.initiatePayment() directly as in-process function calls.
// USSD never makes an HTTP request back to this router at all.
//
// That meant these four routes were live, unauthenticated, internet-facing
// endpoints - anyone could apply for a loan, view any member's loan
// status/history, or trigger a repayment STK push for any guessed
// memberId - with no legitimate caller depending on them being open.
//
// They've been removed rather than patched with ad-hoc auth, since nothing
// currently uses them (the portal has no loan features yet). When the
// portal needs member-facing loan actions, re-add them behind real member
// authentication (a member-scoped JWT/session, with the route checking the
// authenticated member's own ID against :memberId - not just "logged in as
// *someone*") rather than reusing the admin `authenticate` middleware as-is.

// Admin routes (authentication required)
router.post('/approve/:loanId', authenticate, requireAdmin, loanController.approveLoan);
router.post('/reject/:loanId', authenticate, requireAdmin, loanController.rejectLoan);
router.post('/disburse/:loanId', authenticate, requireAdmin, loanController.markDisbursed);
router.get('/admin/list', authenticate, requireAdmin, loanController.getAdminLoans);
router.get('/admin/pending', authenticate, requireAdmin, loanController.getPendingLoans);

module.exports = router;