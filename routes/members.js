const express = require('express');
const router = express.Router();
const memberController = require('../controllers/memberController');
const { validateMemberRegistration } = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');

const Member = require('../models/Member');
const Payment = require('../models/Payment');
const Loan = require('../models/Loan');
const Repayment = require('../models/Repayment');
const Withdrawal = require('../models/Withdrawal');

router.get('/:id/statement', authenticate, requirePermission('members:read'), async (req, res) => {
  try {
    const member = await Member.findById(req.params.id);
    if (!member) {
      return res.status(404).json({ error: 'Member not found' });
    }

    // Four queries in parallel — the three statement-line sources plus the
    // member's current active loan. The active loan drives the "Loan
    // Outstanding" and "Net Position" figures at the top of the statement
    // modal. The repayment summary is fetched separately (below) because
    // it doesn't depend on the loan, and its result feeds the split band
    // between the main snapshot and the transaction table.
    const [deposits, disbursements, withdrawals, activeLoan, repaymentSummary] = await Promise.all([
      Payment.getStatementLines(member.id),
      Loan.getStatementLines(member.id),
      Withdrawal.getStatementLines(member.id),
      Loan.getActiveLoan(member.id),
      // 2026-10-09 (Phase 4): per-member split of every repayment — how
      // much of what they've paid went to principal vs interest. Always
      // returned; the frontend hides the display when total is zero.
      Repayment.getSummaryForMember(member.id),
    ]);

    // Merge and sort chronologically. Running balance only reflects
    // savings movement (deposits add, withdrawals subtract) — loan
    // disbursements/repayments are shown as informational lines with
    // their own amount, but don't move the savings balance.
    const lines = [...deposits, ...disbursements, ...withdrawals].sort(
      (a, b) => new Date(a.date) - new Date(b.date)
    );

    let runningBalance = 0;
    const withBalance = lines.map((line) => {
      if (line.type === 'deposit') runningBalance += Number(line.amount);
      if (line.type === 'withdrawal') runningBalance -= Number(line.amount);
      return {
        ...line,
        balance: line.type === 'deposit' || line.type === 'withdrawal' ? runningBalance : null,
      };
    });

    // Active loan split — fetched only when a loan exists. Simpler than
    // joining this into getActiveLoan(), and avoids a schema change to
    // that method's return shape (which callers in other routes rely on).
    let activeLoanWithSplit = null;
    if (activeLoan) {
      const split = await Repayment.getSplitForLoan(activeLoan.id);
      activeLoanWithSplit = {
        id: activeLoan.id,
        reference: activeLoan.reference,
        principal: Number(activeLoan.principal),
        outstanding_balance: Number(activeLoan.outstanding_balance),
        amount_paid: Number(activeLoan.amount_paid),
        monthly_installment: Number(activeLoan.monthly_installment),
        tenure_months: activeLoan.tenure_months,
        status: activeLoan.status,
        disbursed_at: activeLoan.disbursed_at,
        // 2026-10-09 (Phase 4): split of amount_paid so the modal can show
        // "Principal paid X · Interest paid Y" without further queries.
        principal_paid: split.principal_paid,
        interest_paid: split.interest_paid,
      };
    }

    res.json({
      member: {
        full_name: member.full_name,
        reference: member.reference,
        phone_number: member.phone_number,
        total_outstanding_balance: Number(member.total_outstanding_balance || 0),
        credit_limit: member.credit_limit,
      },
      activeLoan: activeLoanWithSplit,
      // 2026-10-09 (Phase 4): repayment split summary. Rendered as a
      // narrow band below the main financial snapshot. Always present;
      // the frontend hides it when total === 0 so pure savers see no
      // extra chrome.
      repaymentSummary,
      openingBalance: 0,
      closingBalance: runningBalance,
      lines: withBalance,
    });
  } catch (err) {
    console.error('Member statement fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch statement' });
  }
});

// Per-member credit performance report — lifetime loan history, on-time
// repayment tally, savings vs outstanding position. Read-only, gated on
// the same members:read permission as the statement. Used by the admin
// portal's Member Performance page.
//
// Returns 404 if the member doesn't exist. Otherwise returns the full
// report — see services/memberPerformanceService.js for the shape.
router.get('/:id/performance', authenticate, requirePermission('members:read'), async (req, res) => {
  try {
    const MemberPerformanceService = require('../services/memberPerformanceService');
    const report = await MemberPerformanceService.getMemberPerformance(req.params.id);
    if (!report) return res.status(404).json({ error: 'Member not found' });
    res.json(report);
  } catch (err) {
    console.error('Member performance error:', err);
    res.status(500).json({ error: 'Failed to fetch member performance' });
  }
});

// Public - member self-registration, unchanged
router.post('/', validateMemberRegistration, memberController.registerMember);

// Staff/admin routes, gated by permission rather than a single binary
// admin/not-admin check.
router.post('/admin', authenticate, requirePermission('members:write'), validateMemberRegistration, memberController.adminCreateMember);
router.post('/import', authenticate, requirePermission('members:write'), memberController.importMembers);
router.get('/:id', authenticate, requirePermission('members:read'), memberController.getMember);
router.get('/', authenticate, requirePermission('members:read'), memberController.listMembers);
router.patch('/:id', authenticate, requirePermission('members:write'), memberController.updateMember);

router.patch('/:id/board-staff', authenticate, requirePermission('members:set_board_status'), memberController.setBoardStaff);

router.delete('/:id', authenticate, requirePermission('members:delete'), memberController.deleteMember);

module.exports = router;