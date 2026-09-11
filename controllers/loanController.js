const LoanService = require('../services/loanService');
const Member = require('../models/Member');
const Loan = require('../models/Loan');
const smsService = require('../services/smsService');
const AuditLog = require('../models/AuditLog');

// ============================================================
// 1. Apply for a loan (Web or USSD)
// ============================================================
exports.applyLoan = async (req, res) => {
    try {
        const { memberId, amount } = req.body;
        if (!memberId || !amount) {
            return res.status(400).json({ error: 'memberId and amount required' });
        }

        const result = await LoanService.apply(memberId, amount);
        if (!result.success) {
            return res.status(400).json({ error: result.message });
        }

        res.status(201).json(result);
    } catch (err) {
        console.error('Apply loan error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

// ============================================================
// 2. Admin: Approve loan (sends SMS)
// ============================================================
exports.approveLoan = async (req, res) => {
    try {
        const { loanId } = req.params;
        const { adminNotes } = req.body;

        const result = await LoanService.approveLoan(loanId, adminNotes);

        if (!result.success) {
            return res.status(400).json({ error: result.message });
        }

        const member = await Member.findById(result.loan.member_id);
        await AuditLog.log({
            actorId: req.user.id,
            actorUsername: req.user.username,
            action: 'Approved loan',
            category: 'loan_decision',
            targetType: 'loan',
            targetId: loanId,
            targetLabel: member ? `${member.full_name} (loan #${loanId})` : `loan #${loanId}`,
            details: `Approved KES ${result.loan.principal} loan.${adminNotes ? ' Notes: ' + adminNotes : ''}`,
        });

        res.json(result);
    } catch (err) {
        console.error('Approve loan error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

// ============================================================
// 2b. Admin: Reject loan (sends SMS)
// ============================================================
exports.rejectLoan = async (req, res) => {
    try {
        const { loanId } = req.params;
        const { adminNotes } = req.body;

        const result = await LoanService.rejectLoan(loanId, adminNotes);

        if (!result.success) {
            return res.status(400).json({ error: result.message });
        }

        const member = await Member.findById(result.loan.member_id);
        await AuditLog.log({
            actorId: req.user.id,
            actorUsername: req.user.username,
            action: 'Rejected loan',
            category: 'loan_decision',
            targetType: 'loan',
            targetId: loanId,
            targetLabel: member ? `${member.full_name} (loan #${loanId})` : `loan #${loanId}`,
            details: `Rejected KES ${result.loan.principal} loan application.${adminNotes ? ' Reason: ' + adminNotes : ''}`,
        });

        res.json(result);
    } catch (err) {
        console.error('Reject loan error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

// ============================================================
// 3. Member: Get active loan status
// ============================================================
exports.getActiveLoan = async (req, res) => {
    try {
        const { memberId } = req.params;
        const loan = await Loan.getActiveLoan(memberId);
        if (!loan) {
            return res.status(404).json({ message: 'No active loan' });
        }
        res.json(loan);
    } catch (err) {
        console.error('Get active loan error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

// ============================================================
// 4. Get loan history for a member
// ============================================================
exports.getLoanHistory = async (req, res) => {
    try {
        const { memberId } = req.params;
        const history = await Loan.getHistory(memberId);
        res.json(history);
    } catch (err) {
        console.error('Get loan history error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

// ============================================================
// 5. Member: Repay loan (initiate STK push for installment)
// ============================================================
exports.repayLoan = async (req, res) => {
    try {
        const { memberId } = req.body;
        const repaymentInfo = await LoanService.repayLoan(memberId);
        if (!repaymentInfo.success) {
            return res.status(400).json({ error: repaymentInfo.message });
        }

        // Get member's phone number to trigger STK push
        const member = await Member.findById(memberId);
        if (!member) {
            return res.status(404).json({ error: 'Member not found' });
        }

        // Reuse your existing Daraja STK Push logic from paymentService
        const { initiatePayment } = require('../services/paymentService');
        
        const paymentResult = await initiatePayment({
            memberId: member.id,
            phoneNumber: member.phone_number,
            amount: repaymentInfo.dueAmount,
            loanId: repaymentInfo.loan.id, // Pass loanId for repayment tracking
            description: 'Loan repayment for KEMRI SACCO'
        });

        res.json({
            success: true,
            message: 'STK Push sent for loan repayment.',
            dueAmount: repaymentInfo.dueAmount,
            paymentResult
        });
    } catch (err) {
        console.error('Repay loan error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

// ============================================================
// 6. Admin: Mark loan as manually disbursed (Phase 1)
// ============================================================
exports.markDisbursed = async (req, res) => {
    try {
        const { loanId } = req.params;
        const { mpesaReceipt } = req.body;

        if (!loanId) {
            return res.status(400).json({ error: 'Loan ID required' });
        }

        // 1. Mark loan as disbursed
        const loan = await Loan.markDisbursed(loanId, mpesaReceipt || null);
        
        if (!loan) {
            return res.status(404).json({ error: 'Loan not found' });
        }

        // 2. Get member details for SMS
        const member = await Member.findById(loan.member_id);
        if (!member) {
            return res.status(404).json({ error: 'Member not found' });
        }

        // 3. Send loan disbursed SMS
        try {
            const disbursementDate = new Date().toLocaleDateString('en-GB', {
                day: '2-digit',
                month: 'short',
                year: 'numeric'
            });
            
            await smsService.sendSMS(
                member.phone_number,
                smsService.templates.loanDisbursed(
                    member.full_name,
                    loan.principal,
                    loan.total_repayment,
                    disbursementDate
                )
            );
        } catch (smsErr) {
            console.error('Loan disbursement SMS failed (loan still disbursed):', smsErr.message);
        }

        await AuditLog.log({
            actorId: req.user.id,
            actorUsername: req.user.username,
            action: 'Disbursed loan',
            category: 'loan_decision',
            targetType: 'loan',
            targetId: loanId,
            targetLabel: `${member.full_name} (loan #${loanId})`,
            details: `Disbursed KES ${loan.principal} to ${member.full_name}.${mpesaReceipt ? ' Receipt: ' + mpesaReceipt : ''}`,
        });

        res.json({
            success: true,
            message: 'Loan marked as manually disbursed. SMS sent to member.',
            loan,
        });
    } catch (err) {
        console.error('Manual disbursement error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

// ============================================================
// 7. Admin: Get all loans for dashboard
// ============================================================
exports.getAdminLoans = async (req, res) => {
    try {
        const loans = await Loan.findAllForAdmin();
        res.json(loans);
    } catch (err) {
        console.error('Admin loan list error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

// ============================================================
// 8. Admin: Get pending loans only
// ============================================================
exports.getPendingLoans = async (req, res) => {
    try {
        const loans = await Loan.findPending();
        res.json(loans);
    } catch (err) {
        console.error('Pending loans error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};