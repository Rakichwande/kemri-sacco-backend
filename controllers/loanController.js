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
            details: `Approved KES ${result.loan.principal} ${result.loan.purpose} loan.${adminNotes ? ' Notes: ' + adminNotes : ''}`,
        });

        // 2026-11-06: Added bizboost and sme to the instant B2C payout flow
        const b2cPurposes = ['mobile', 'bizboost', 'sme'];
        
        if (b2cPurposes.includes(result.loan.purpose)) {
            const disbursement = await DisbursementService.disburseLoan(loanId);
            if (!disbursement.success) {
                return res.status(400).json({ error: disbursement.message });
            }
            return res.json({ 
                success: true, 
                message: `${result.loan.purpose.toUpperCase()} loan approved and B2C initiated.`, 
                loan: disbursement.loan 
            });
        } else {
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
// 6. Admin: Manual Disbursement (Mobile, BizBoost, SME, or Wallet)
// ============================================================
exports.markDisbursed = async (req, res) => {
    try {
        const { loanId } = req.params;
        const { mpesaReceipt } = req.body; // Extract manual M-Pesa receipt if provided
        
        if (!loanId) return res.status(400).json({ error: 'Loan ID required' });

        const loanCheck = await Loan.findById(loanId);
        if (!loanCheck) return res.status(404).json({ error: 'Loan not found.' });

        const client = await db.pool.connect();
        let loan;

        try {
            await client.query('BEGIN');
            
            // 2026-11-06: Group B2C loan types
            const b2cPurposes = ['mobile', 'bizboost', 'sme'];

            if (b2cPurposes.includes(loanCheck.purpose)) {
                // 1. Manual M-Pesa Payment
                loan = await Loan.markDisbursed(loanId, mpesaReceipt || 'Manual M-Pesa', 'manual', client);
            } else {
                // 2. Wallet Credit (Emergency/School)
                loan = await Loan.markDisbursed(loanId, 'Wallet Credit', 'wallet', client);
                
                let walletType = 'general';
                if (loan.purpose === 'emergency') walletType = 'emergency';
                if (loan.purpose === 'school') walletType = 'school';

                const ref = `LN-${String(loan.id).padStart(5, '0')}`;
                await Member.creditWallet(loan.member_id, loan.principal, 'loan_credit', ref, walletType, client);
            }
            
            if (!loan) {
                await client.query('ROLLBACK');
                return res.status(404).json({ error: 'Loan not found or not in approved state.' });
            }

            await client.query('COMMIT');
        } catch (dbErr) {
            await client.query('ROLLBACK');
            console.error('Database error during manual disbursement:', dbErr);
            return res.status(500).json({ error: 'Failed to process manual disbursement.' });
        } finally {
            client.release();
        }

        const member = await Member.findById(loan.member_id);
        if (!member) return res.status(404).json({ error: 'Member not found' });

        const ref = `LN-${String(loan.id).padStart(5, '0')}`;
        const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
        const dueDate = new Date();
        dueDate.setMonth(dueDate.getMonth() + 1);
        const dueDateFormatted = dueDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

        const isB2C = ['mobile', 'bizboost', 'sme'].includes(loan.purpose);

        // 3. Send the correct SMS
        try {
            if (isB2C) {
                await smsService.sendSMS(
                    member.phone_number,
                    smsService.templates.loanManuallyDisbursed(
                        member.full_name, loan.principal, loan.total_repayment, dueDateFormatted, ref, mpesaReceipt || 'Manual Transfer'
                    )
                );
            } else {
                await smsService.sendSMS(
                    member.phone_number,
                    smsService.templates.loanWalletCredited(
                        member.full_name, loan.principal, loan.total_repayment, today, ref, loan.purpose
                    )
                );
            }
        } catch (smsErr) {
            console.error('Loan disbursement SMS failed:', smsErr.message);
        }

        // 4. Notify Staff
        try {
            await notificationService.notifyStaff({
                smsText: isB2C 
                    ? smsService.templates.staffLoanDisbursed(member.full_name, ref, mpesaReceipt)
                    : smsService.templates.staffWalletCredited(member.full_name, loan.principal, ref, loan.purpose),
                emailContent: null,
            });
        } catch (err) {
            console.error('Staff notification failed:', err.message);
        }

        await AuditLog.log({
            actorId: req.user.id,
            actorUsername: req.user.username,
            action: isB2C ? 'Manually disbursed loan' : 'Credited loan to wallet',
            category: 'loan_decision',
            targetType: 'loan',
            targetId: loanId,
            targetLabel: `${member.full_name} (loan #${loanId})`,
            details: `Processed manual disbursement of KES ${loan.principal} for ${loan.purpose} loan.`,
        });

        res.json({
            success: true,
            message: isB2C ? 'Loan marked as manually disbursed.' : `Loan credited to ${loan.purpose} Wallet.`,
            loan,
        });
    } catch (err) {
        console.error('Manual disbursement error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

// ============================================================
// 6b. Admin: Retry Automatic B2C Disbursement
// ============================================================
exports.disburseLoan = async (req, res) => {
    try {
        const { loanId } = req.params;
        
        const loanCheck = await Loan.findById(loanId);
        if (!loanCheck) return res.status(404).json({ error: 'Loan not found' });
        
        const memberCheck = await Member.findById(loanCheck.member_id);
        if (!memberCheck) return res.status(404).json({ error: 'Member not found' });

        const currentLimit = Number(memberCheck.credit_limit || 0);
        const loanAmount = Number(loanCheck.principal);

        // 2026-11-06: BizBoost and SME are open limits. Only check limit for Mobile.
        if (loanCheck.purpose === 'mobile' && loanAmount > currentLimit) {
            return res.status(400).json({ 
                error: `ACTION BLOCKED: Member's limit is KES ${currentLimit.toLocaleString()}. This loan is KES ${loanAmount.toLocaleString()}. Update their limit first.` 
            });
        }

        // 1. Notify member that we are retrying
        try {
            await smsService.sendSMS(
                memberCheck.phone_number,
                smsService.templates.loanRetryB2C(memberCheck.full_name, loanCheck.principal, loanCheck.reference || `LN-${String(loanCheck.id).padStart(5, '0')}`)
            );
        } catch (smsErr) {
            console.error('Retry SMS failed:', smsErr.message);
        }

        // 2. Retry B2C
        const result = await DisbursementService.disburseLoan(loanId);

        if (!result.success) {
            await AuditLog.log({
                actorId: req.user.id,
                actorUsername: req.user.username,
                action: 'Attempted B2C retry',
                category: 'loan_decision',
                targetType: 'loan',
                targetId: loanId,
                targetLabel: `loan #${loanId}`,
                details: `B2C retry failed: ${result.message}`,
            });

            // 2026-11-02: SUGGESTION 2 - Alert staff via SMS immediately
            try {
                await notificationService.notifyStaff({
                    smsText: smsService.templates.staffLoanDisbursementFailed(
                        memberCheck.full_name, loanCheck.reference, result.message
                    ),
                    emailContent: null
                });
            } catch (notifyErr) {
                console.error('Staff B2C failure alert failed:', notifyErr.message);
            }

            return res.status(400).json({ error: result.message });
        }

        const member = await Member.findById(result.loan.member_id);
        await AuditLog.log({
            actorId: req.user.id,
            actorUsername: req.user.username,
            action: 'Initiated B2C retry',
            category: 'loan_decision',
            targetType: 'loan',
            targetId: loanId,
            targetLabel: member ? `${member.full_name} (loan #${loanId})` : `loan #${loanId}`,
            details: `Initiated B2C retry of KES ${result.loan.principal}. ConversationID: ${result.conversationId}.`,
        });

        res.json({
            success: true,
            message: result.message,
            loan: result.loan,
            conversationId: result.conversationId,
        });
    } catch (err) {
        console.error('B2C retry error:', err);
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
            return res.status(400).json({ error: 'outcome must be "received" or "not_received".' });
        }

        const loan = await Loan.findById(loanId);
        if (!loan) return res.status(404).json({ error: 'Loan not found.' });
        if (loan.status !== 'disbursing') {
            return res.status(400).json({ error: `Loan is currently '${loan.status}' — only loans stuck in 'disbursing' can be resolved this way.` });
        }

        if (outcome === 'received' && (!receipt || !receipt.trim())) {
            return res.status(400).json({ error: 'An M-Pesa receipt is required when confirming the member received the funds.' });
        }

        const member = await Member.findById(loan.member_id);

        let result;
        if (outcome === 'received') {
            result = await Loan.markDisbursed(loanId, receipt.trim(), 'manual');
        } else {
            const rollbackReason = reason && reason.trim() ? reason.trim() : 'manual override: callback never arrived';
            result = await Loan.rollbackDisbursing(loanId, rollbackReason);
        }

        if (!result) return res.status(500).json({ error: 'Failed to resolve the stuck disbursement.' });

        await AuditLog.log({
            actorId: req.user.id,
            actorUsername: req.user.username,
            action: outcome === 'received' ? 'Resolved stuck disbursement: member received funds' : 'Resolved stuck disbursement: member did NOT receive funds',
            category: 'loan_decision',
            targetType: 'loan',
            targetId: loanId,
            targetLabel: member ? `${member.full_name} (loan #${loanId})` : `loan #${loanId}`,
            details: outcome === 'received' ? `Manually confirmed receipt ${receipt}. Original ConversationID: ${loan.b2c_conversation_id || 'unknown'}` : `Rolled back to approved. Reason: ${reason || 'callback never arrived'}. Original ConversationID: ${loan.b2c_conversation_id || 'unknown'}`,
        });

        if (outcome === 'received' && member) {
            try {
                const updatedMember = await Member.findById(loan.member_id);
                const dueDateFormatted = result.next_payment_due ? new Date(result.next_payment_due).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

                await smsService.sendSMS(
                    member.phone_number,
                    smsService.templates.loanManuallyDisbursed(
                        member.full_name, loan.principal, updatedMember?.total_outstanding_balance || loan.total_repayment, dueDateFormatted, loan.reference, receipt
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
            message: outcome === 'received' ? 'Loan marked disbursed with the recorded receipt.' : 'Loan rolled back to approved. Ready to retry.',
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

// ============================================================
// 9. Admin: Get loan timeline by month/year
// ============================================================
exports.getLoanTimeline = async (req, res) => {
    try {
        const { year, month } = req.query;
        if (!year || !month) {
            return res.status(400).json({ error: 'Year and month are required' });
        }
        const loans = await Loan.getTimelineByMonth(Number(year), Number(month));
        res.json(loans);
    } catch (err) {
        console.error('Timeline fetch error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};