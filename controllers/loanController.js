const LoanService = require('../services/loanService');
const DisbursementService = require('../services/disbursementService');
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
// This is the MANUAL path: a staff member sends the money to the member
// themselves (via M-Pesa app, bank, whatever), then records the receipt
// here to close the loan out and trigger the member SMS. It stays in
// place after B2C is live because B2C can fail or be unavailable — see
// disburseLoan() below for the automatic path.
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

        // 2. Get member details for SMS. Fetched AFTER markDisbursed()
        //    above, so member.total_outstanding_balance already includes
        //    this loan's contribution — that's the number the SMS should
        //    show, because it's what the member actually owes across all
        //    their loans.
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
            
            // Third argument is the member's running outstanding total,
            // NOT this loan's total_repayment. The two are the same only
            // for a member with a single lifetime loan; for anyone with
            // history, sending loan.total_repayment understated what they
            // owe. Matches the B2C path (disbursementService.handleB2CResult),
            // which already re-read the member for the same reason.
            await smsService.sendSMS(
                member.phone_number,
                smsService.templates.loanDisbursed(
                    member.full_name,
                    loan.principal,
                    member.total_outstanding_balance,
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
// 6b. Admin: Disburse loan automatically via M-Pesa B2C (Phase 2)
// ============================================================
// Distinct from markDisbursed() above. This triggers the automatic payout
// through Safaricom's B2C API — no staff member sends money manually.
//
// IMPORTANT: this endpoint is ASYNCHRONOUS. A 200 response here means
// "Safaricom accepted the request", not "the member has the money". The
// loan moves to 'disbursing' and sits there for 5–30 seconds while
// Safaricom processes the transfer. The real outcome arrives at
// /webhooks/daraja/b2c/result and resolves the loan — either to
// 'disbursed' (success, balance incremented, member SMS sent) or back to
// 'approved' (failure, staff notified).
//
// The frontend should show a "Disbursing…" state on the row after this
// returns, and poll (or wait for the next fetch) until the loan resolves.
// A staff member clicking Disburse again while the loan is already
// disbursing will get a 400 explaining that — the service checks the
// current status before initiating.
exports.disburseLoan = async (req, res) => {
    try {
        const { loanId } = req.params;

        const result = await DisbursementService.disburseLoan(loanId);

        if (!result.success) {
            // Log the failed attempt. A failed disbursement is as much a
            // business event as a successful one — if a member complains
            // they never received their loan, the audit trail needs to
            // show that staff tried and why it didn't work.
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

        // Accepted by Safaricom — loan is now in 'disbursing'
        const member = await Member.findById(result.loan.member_id);
        await AuditLog.log({
            actorId: req.user.id,
            actorUsername: req.user.username,
            action: 'Initiated B2C disbursement',
            category: 'loan_decision',
            targetType: 'loan',
            targetId: loanId,
            targetLabel: member ? `${member.full_name} (loan #${loanId})` : `loan #${loanId}`,
            details: `Initiated B2C disbursement of KES ${result.loan.principal}. ConversationID: ${result.conversationId}. Awaiting Safaricom confirmation.`,
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
// A loan sits in 'disbursing' when Safaricom accepted the B2C request
// but the result callback never arrived (or failed to match). The admin
// console surfaces a "Resolve" action on any disbursing row older than
// 5 minutes; this endpoint handles the outcome.
//
// Body: { outcome: 'received' | 'not_received', receipt?, reason? }
//
//   outcome='received'       Staff verified on M-Pesa that the member
//                            received the funds. Requires a receipt.
//                            Loan → disbursed, balance incremented,
//                            member SMS fired.
//
//   outcome='not_received'   Staff verified on M-Pesa that the funds
//                            never moved. Loan → approved, ready to
//                            retry from the portal. No balance change.
//
// Both paths audit-log the actor, the choice, the original ConversationID
// (preserved in admin_notes for reconciliation), and the timestamp.
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

        // Require a receipt when confirming the member received funds.
        // Without it, we have no proof the payout actually happened —
        // the whole point of this override path is a human confirming
        // against M-Pesa with the receipt as evidence.
        if (outcome === 'received' && (!receipt || !receipt.trim())) {
            return res.status(400).json({
                error: 'An M-Pesa receipt is required when confirming the member received the funds.',
            });
        }

        const member = await Member.findById(loan.member_id);

        let result;
        if (outcome === 'received') {
            // markDisbursed() moves the loan to 'disbursed' and increments
            // the member's running outstanding total in one transaction.
            // source='manual' produces the standard "Manually disbursed"
            // note; the audit log records that this was a stuck-resolution.
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

        // Send member SMS on the "received" path — the money moved and the
        // member needs to know their new outstanding balance and the
        // receipt. The "not received" path doesn't send an SMS, because
        // from the member's perspective nothing has changed; their loan
        // is still approved and awaiting disbursement.
        if (outcome === 'received' && member) {
            try {
                const updatedMember = await Member.findById(loan.member_id);
                await smsService.sendSMS(
                    member.phone_number,
                    smsService.templates.loanDisbursed(
                        member.full_name,
                        loan.principal,
                        updatedMember?.total_outstanding_balance || loan.total_repayment,
                        new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
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