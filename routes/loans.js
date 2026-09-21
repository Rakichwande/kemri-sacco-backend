const express = require('express');
const router = express.Router();
const loanController = require('../controllers/loanController');
const { authenticate, requirePermission } = require('../middleware/auth');

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

// Staff/admin routes, now gated by permission rather than a single binary
// admin/not-admin check - see middleware/permissions.js for exactly which
// roles carry each permission. Super Administrator, SACCO Administrator,
// and Loans Officer can all reach these; Finance Officer, Member Support,
// Auditor, and legacy Staff cannot approve or disburse (Auditor and Staff
// can still read loan records elsewhere, just not act on them).
router.post('/approve/:loanId', authenticate, requirePermission('loans:approve'), loanController.approveLoan);
router.post('/reject/:loanId', authenticate, requirePermission('loans:approve'), loanController.rejectLoan);
router.post('/disburse/:loanId', authenticate, requirePermission('loans:disburse'), loanController.markDisbursed);
router.get('/admin/list', authenticate, requirePermission('loans:read'), loanController.getAdminLoans);
router.get('/admin/pending', authenticate, requirePermission('loans:read'), loanController.getPendingLoans);

module.exports = router;