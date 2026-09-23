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

    const [deposits, disbursements, withdrawals] = await Promise.all([
      Payment.getStatementLines(member.id),
      Loan.getStatementLines(member.id),
      Withdrawal.getStatementLines(member.id),
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
      },
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

module.exports = router;