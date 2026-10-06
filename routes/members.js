const express = require('express');
const router = express.Router();
const memberController = require('../controllers/memberController');
const { validateMemberRegistration } = require('../middleware/validate');
const { authenticate, requirePermission } = require('../middleware/auth');

const Member = require('../models/Member');
const Payment = require('../models/Payment');
const Loan = require('../models/Loan');
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
    // modal, which is what staff and members actually want to see when
    // checking a member's position. Without it, the statement only showed
    // savings — hiding the member's debt entirely.
    const [deposits, disbursements, withdrawals, activeLoan] = await Promise.all([
      Payment.getStatementLines(member.id),
      Loan.getStatementLines(member.id),
      Withdrawal.getStatementLines(member.id),
      // getActiveLoan() returns a pending/approved/disbursing/disbursed
      // loan — i.e. anything not yet repaid or rejected. Returns undefined
      // for a member with no current obligation, which the response
      // reflects as activeLoan: null.
      Loan.getActiveLoan(member.id),
    ]);

    // Merge and sort chronologically. Running balance only reflects
    // savings movement (deposits add, withdrawals subtract) - loan
    // disbursements/repayments are shown as informational lines with
    // their own amount, but don't move the savings balance, since
    // borrowed money isn't the member's own savings.
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

    res.json({
      member: {
        full_name: member.full_name,
        reference: member.reference,
        phone_number: member.phone_number,
        // The member's running total across all active loans. Maintained
        // by markDisbursed() (increment on disbursement) and
        // applyRepayment() (decrement on repayment). Returned as a Number
        // so the frontend never has to guess the type — pg returns
        // INTEGER columns as strings in some configurations, and the modal
        // does arithmetic on this value (Net Position = savings − outstanding).
        total_outstanding_balance: Number(member.total_outstanding_balance || 0),
        credit_limit: member.credit_limit,
      },
      // Active loan detail, or null. The frontend renders a compact panel
      // when present and omits it entirely when null, so savers without
      // loans get a clean statement.
      activeLoan: activeLoan
        ? {
            id: activeLoan.id,
            reference: activeLoan.reference,
            principal: Number(activeLoan.principal),
            outstanding_balance: Number(activeLoan.outstanding_balance),
            amount_paid: Number(activeLoan.amount_paid),
            monthly_installment: Number(activeLoan.monthly_installment),
            tenure_months: activeLoan.tenure_months,
            status: activeLoan.status,
            disbursed_at: activeLoan.disbursed_at,
          }
        : null,
      openingBalance: 0, // no pre-system balances - see models/Member.js's bulkImport note
      closingBalance: runningBalance,
      lines: withBalance,
    });
  } catch (err) {
    console.error('Member statement fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch statement' });
  }
});

// Public - member self-registration, unchanged
router.post('/', validateMemberRegistration, memberController.registerMember);

// Staff/admin routes, gated by permission rather than a single binary
// admin/not-admin check. Super Administrator, SACCO Administrator, and
// Member Support can create/edit member records; Finance Officer, Loans
// Officer, Auditor, and legacy Staff can view but not modify.
router.post('/admin', authenticate, requirePermission('members:write'), validateMemberRegistration, memberController.adminCreateMember);
router.post('/import', authenticate, requirePermission('members:write'), memberController.importMembers);
router.get('/:id', authenticate, requirePermission('members:read'), memberController.getMember);
router.get('/', authenticate, requirePermission('members:read'), memberController.listMembers);
router.patch('/:id', authenticate, requirePermission('members:write'), memberController.updateMember);

// Board/staff status grant/revoke. Deliberately gated on its OWN permission
// (members:set_board_status), not the broader members:write — this is the
// one member field that changes loan policy for that person (auto-approved
// vs. normal review), so it must be grantable only to roles trusted with
// that decision (Super Administrator, SACCO Administrator), independent of
// who can generally edit member records.
//
// The general PATCH /:id above cannot reach is_board_staff: the controller's
// EDITABLE_FIELDS whitelist excludes it, and Member.update() throws if it's
// ever passed there anyway. This route is the only entry point.
router.patch('/:id/board-staff', authenticate, requirePermission('members:set_board_status'), memberController.setBoardStaff);

// Member deletion. Destructive and irreversible — gated on its OWN
// permission (members:delete), separate from members:write so a role that
// can edit profiles cannot also permanently delete records. Granted only
// to Super Administrator and SACCO Administrator.
//
// The controller refuses with 409 if the member has any transaction
// history (deposits, loans, repayments, withdrawals). That is a legitimate
// business outcome, not an error: the frontend shows the specific reason
// and leaves the member record intact. See Member.remove() for the check.
router.delete('/:id', authenticate, requirePermission('members:delete'), memberController.deleteMember);

module.exports = router;