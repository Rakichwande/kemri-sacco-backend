const LoanService = require('../services/loanService');
const DisbursementService = require('../services/disbursementService');
const Member = require('../models/Member');
const Loan = require('../models/Loan');
const smsService = require('../services/smsService');
const notificationService = require('../services/notificationService');
const AuditLog = require('../models/AuditLog');
const db = require('../config/database'); 

// ============================================================
// 1. Apply for a loan (Web or USSD)
// ============================================================
exports.applyLoan = async (req, res) => {
    try {
        const { memberId, amount, purpose } = req.body;
        if (!memberId || !amount) {
            return res.status(400).json({ error: 'memberId and amount required' });
        }

        const result = await LoanService.apply(memberId, amount, purpose);
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
// 2. Admin: Approve loan (Routes to B2C or Wallet based on purpose)
// ============================================================
exports.approveLoan = async (req, res) => {
    try {
        const { loanId } = req.params;
        const { adminNotes } = req.body;

        // This call now includes the strict credit limit check in loanService
        const result = await LoanService.approveLoan(loanId, adminNotes);

        // If the limit check fails, it throws the specific error message here
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
            details: `Approved KES ${result.loan.principal} ${result.loan.purpose} loan.${adminNotes ? ' Notes: ' + adminNotes : ''}`,
        });

        // 2026-10-31: Route based on loan type
        if (result.loan.purpose === 'mobile') {
            // Mobile Loan: Send directly to M-Pesa via Safaricom B2C
            const disbursement = await DisbursementService.disburseLoan(loanId);
            if (!disbursement.success) {
                // Loan is approved, but B2C failed. Admin will see this error.
                return res.status(400).json({ error: disbursement.message });
            }
            return res.json({ 
                success: true, 
                message: 'Mobile loan approved and B2C initiated.', 
                loan: disbursement.loan 
            });
        } else {
            // Emergency/School Loan: Credit to Wallet
            req.params.loanId = loanId;
            return exports.markDisbursed(req, res);
        }

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

        const member = await Member.findById(memberId);
        if (!member) {
            return res.status(404).json({ error: 'Member not found' });
        }

        const { initiatePayment } = require('../services/paymentService');
        
        const paymentResult = await initiatePayment({
            memberId: member.id,
            phoneNumber: member.phone_number,
            amount: repaymentInfo.dueAmount,
            loanId: repaymentInfo.loan.id,
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
// 6. Admin: Credit Loan to Member's Wallet (M-Shwari Model)
// ============================================================
exports.markDisbursed = async (req, res) => {
    try {
        const { loanId } = req.params;
        if (!loanId) {
            return res.status(400).json({ error: 'Loan ID required' });
        }

        const client = await db.pool.connect();
        let loan;

        try {
            await client.query('BEGIN');
            
            // 1. Mark loan as disbursed (updates outstanding balance)
            loan = await Loan.markDisbursed(loanId, 'Wallet Credit', 'wallet', client);
            
            if (!loan) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Loan not found or not in approved state.' });
            }

            // 2. Credit the member's wallet
            const ref = `LN-${String(loan.id).padStart(5, '0')}`;
            await Member.creditWallet(loan.member_id, loan.principal, 'loan_credit', ref, client);
            
            await client.query('COMMIT');
        } catch (dbErr) {
            await client.query('ROLLBACK');
            console.error('Database error crediting wallet:', dbErr);
            return res.status(500).json({ error: 'Failed to credit wallet due to database error.' });
        } finally {
            client.release();
        }

        const member = await Member.findById(loan.member_id);
        if (!member) {
            return res.status(404).json({ error: 'Member not found' });
        }

        const ref = `LN-${String(loan.id).padStart(5, '0')}`;
        
        // 2. Format the date for the SMS
        const today = new Date().toLocaleDateString('en-GB', { 
            day: '2-digit', month: 'short', year: 'numeric' 
        });

        // 3. Send the Wallet Credit SMS to Member
        try {
            await smsService.sendSMS(
                member.phone_number,
                smsService.templates.loanWalletCredited(
                    member.full_name,
                    loan.principal,
                    loan.total_repayment,
                    today,
                    ref,
                    loan.purpose // <--- Added this
                )
            );
        } catch (smsErr) {
            console.error('Loan wallet credit SMS failed:', smsErr.message);
        }

        // 4. Send the Wallet Credit SMS to Staff
        try {
            await notificationService.notifyStaff({
                smsText: smsService.templates.staffWalletCredited(
                    member.full_name,
                    loan.principal,
                    ref,
                    loan.purpose // <--- Added this
                ),
                emailContent: null,
            });
        } catch (err) {
            console.error('Staff wallet credit notification failed:', err.message);
        }

        await AuditLog.log({
            actorId: req.user.id,
            actorUsername: req.user.username,
            action: 'Credited loan to wallet',
            category: 'loan_decision',
            targetType: 'loan',
            targetId: loanId,
            targetLabel: `${member.full_name} (loan #${loanId})`,
            details: `Credited KES ${loan.principal} to SACCO Wallet for ${member.full_name}.`,
        });

        res.json({
            success: true,
            message: 'Loan credited to member SACCO Wallet. SMS sent to member.',
            loan,
        });
    } catch (err) {
        console.error('Wallet credit error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

// ============================================================
// 6b. Admin: Disburse loan automatically (Manual trigger)
// ============================================================
exports.disburseLoan = async (req, res) => {
    try {
        const { loanId } = req.params;
        const result = await DisbursementService.disburseLoan(loanId);

        if (!result.success) {
            await AuditLog.log({
                actorId: req.user.id,
                actorUsername: req.user.username,
                action: 'Attempted B2C disbursement',
                category: 'loan_decision',
                targetType: 'loan',
                targetId: loanId,
                targetLabel: `loan #${loanId}`,
                details: `B2C disbursement failed: ${result.message}`,
            });
            return res.status(400).json({ error: result.message });
        }

        const member = await Member.findById(result.loan.member_id);
        await AuditLog.log({
            actorId: req.user.id,
            actorUsername: req.user.username,
            action: 'Initiated B2C disbursement',
            category: 'loan_decision',
            targetType: 'loan',
            targetId: loanId,
            targetLabel: member ? `${member.full_name} (loan #${loanId})` : `loan #${loanId}`,
            details: `Initiated B2C disbursement of KES ${result.loan.principal}. ConversationID: ${result.conversationId}.`,
        });

        res.json({
            success: true,
            message: result.message,
            loan: result.loan,
            conversationId: result.conversationId,
        });
    } catch (err) {
        console.error('B2C disbursement error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

// ============================================================
// 6c. Admin: Resolve a stuck B2C disbursement
// ============================================================
exports.resolveStuckDisbursement = async (req, res) => {
    try {
        const { loanId } = req.params;
        const { outcome, receipt, reason } = req.body;

        if (!['received', 'not_received'].includes(outcome)) {
            return res.status(400).json({
                error: 'outcome must be "received" or "not_received".',
            });
        }

        const loan = await Loan.findById(loanId);
        if (!loan) {
            return res.status(404).json({ error: 'Loan not found.' });
        }
        if (loan.status !== 'disbursing') {
            return res.status(400).json({
                error: `Loan is currently '${loan.status}' — only loans stuck in 'disbursing' can be resolved this way.`,
            });
        }

        if (outcome === 'received' && (!receipt || !receipt.trim())) {
            return res.status(400).json({
                error: 'An M-Pesa receipt is required when confirming the member received the funds.',
            });
        }

        const member = await Member.findById(loan.member_id);

        let result;
        if (outcome === 'received') {
            result = await Loan.markDisbursed(loanId, receipt.trim(), 'manual');
        } else {
            const rollbackReason = reason && reason.trim()
                ? reason.trim()
                : 'manual override: callback never arrived';
            result = await Loan.rollbackDisbursing(loanId, rollbackReason);
        }

        if (!result) {
            return res.status(500).json({ error: 'Failed to resolve the stuck disbursement.' });
        }

        await AuditLog.log({
            actorId: req.user.id,
            actorUsername: req.user.username,
            action: outcome === 'received'
                ? 'Resolved stuck disbursement: member received funds'
                : 'Resolved stuck disbursement: member did NOT receive funds',
            category: 'loan_decision',
            targetType: 'loan',
            targetId: loanId,
            targetLabel: member ? `${member.full_name} (loan #${loanId})` : `loan #${loanId}`,
            details: outcome === 'received'
                ? `Manually confirmed receipt ${receipt}. Original ConversationID: ${loan.b2c_conversation_id || 'unknown'}`
                : `Rolled back to approved. Reason: ${reason || 'callback never arrived'}. Original ConversationID: ${loan.b2c_conversation_id || 'unknown'}`,
        });

        if (outcome === 'received' && member) {
            try {
                const updatedMember = await Member.findById(loan.member_id);
                
                const dueDateFormatted = result.next_payment_due
                    ? new Date(result.next_payment_due).toLocaleDateString('en-GB', {
                        day: '2-digit', month: 'short', year: 'numeric',
                      })
                    : '—';

                await smsService.sendSMS(
                    member.phone_number,
                    smsService.templates.loanDisbursed(
                        member.full_name,
                        loan.principal,
                        updatedMember?.total_outstanding_balance || loan.total_repayment,
                        dueDateFormatted,
                        loan.reference // <--- Added this
                    )
                );
            } catch (err) {
                console.error('Resolve-disbursement SMS failed:', err.message);
            }
        }

        res.json({
            success: true,
            outcome,
            loan: result,
            message: outcome === 'received'
                ? 'Loan marked disbursed with the recorded receipt.'
                : 'Loan rolled back to approved. Ready to retry.',
        });
    } catch (err) {
        console.error('Resolve stuck disbursement error:', err);
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