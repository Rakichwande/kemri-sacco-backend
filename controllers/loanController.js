// Temporary minimal version for testing
exports.applyLoan = (req, res) => res.json({ message: 'applyLoan called' });
exports.approveLoan = (req, res) => res.json({ message: 'approveLoan called' });
exports.getActiveLoan = (req, res) => res.json({ message: 'getActiveLoan called' });
exports.getLoanHistory = (req, res) => res.json({ message: 'getLoanHistory called' });
exports.repayLoan = (req, res) => res.json({ message: 'repayLoan called' });

const LoanService = require('../services/loanService');
const Member = require('../models/Member');
const Loan = require('../models/Loan');

// 1. Apply for a loan (Web or USSD)
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

// 2. Admin: Approve loan
exports.approveLoan = async (req, res) => {
    try {
        const { loanId } = req.params;
        const { adminNotes } = req.body;
        
        // In production, add admin authentication middleware here
        const result = await LoanService.approveLoan(loanId, adminNotes);
        res.json(result);
    } catch (err) {
        console.error('Approve loan error:', err);
        res.status(500).json({ error: 'Server error' });
    }
};

// 3. Member: Get active loan status
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

// 4. Get loan history for a member
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

// 5. Member: Repay loan (initiate STK push for installment)
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
        // This expects a payment initiation function that takes phone, amount, account ref
        const { initiatePayment } = require('../services/paymentService');
        
        // Note: Your paymentService might use different function names.
        // If it's called 'initiatePayment', use that.
        // If it's called something else, adjust accordingly.
        const paymentResult = await initiatePayment({
            memberId: member.id,
            phoneNumber: member.phone_number,
            amount: repaymentInfo.dueAmount,
            accountReference: `LOAN-${repaymentInfo.loan.id}`,
            description: `Loan repayment for KEMRI SACCO`
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