const Member = require('../models/Member');
const Loan = require('../models/Loan');

const MAX_ABSOLUTE_LIMIT = 20000; // Hard cap for KEMRI SACCO
const MIN_LOAN_AMOUNT = 1000;     // Minimum borrowable
const INTEREST_RATE = 6.0;        // % per month
const TENURE_MONTHS = 3;          // Fixed duration

class LoanService {
    // Calculate dynamic credit limit based on repayment history
    static calculateCreditLimit(member) {
        // New member (0 successful repayments)
        if (member.successful_repayments === 0) {
            return 10000;
        }
        // Members with at least 1 successful repayment get max limit
        if (member.successful_repayments >= 1) {
            return MAX_ABSOLUTE_LIMIT;
        }
        return 10000; // fallback
    }

    // Check if a member can apply for a new loan
    static async canApply(memberId) {
        const member = await Member.findById(memberId);
        if (!member) {
            return { allowed: false, reason: 'Member not found.' };
        }

        // Rule 1: Check if they already have an active or pending loan
        const activeLoan = await Loan.getActiveLoan(memberId);
        if (activeLoan) {
            return { 
                allowed: false, 
                reason: `You have an active loan of KES ${activeLoan.outstanding_balance}. Clear it first.`,
                activeLoan 
            };
        }

        // Rule 2: Calculate their dynamic limit
        const creditLimit = this.calculateCreditLimit(member);

        return {
            allowed: true,
            creditLimit,
            member,
            reason: 'Eligible to apply.'
        };
    }

    // Calculate repayment schedule
    static calculateRepaymentSchedule(principal) {
        const totalInterest = Math.round(principal * (INTEREST_RATE / 100) * TENURE_MONTHS);
        const totalRepayment = principal + totalInterest;
        const monthlyInstallment = Math.round(totalRepayment / TENURE_MONTHS);

        return {
            principal,
            interestRate: INTEREST_RATE,
            tenureMonths: TENURE_MONTHS,
            totalInterest,
            totalRepayment,
            monthlyInstallment,
            breakdown: Array.from({ length: TENURE_MONTHS }, (_, i) => ({
                month: i + 1,
                dueAmount: monthlyInstallment,
                // Flat rate means equal installments
            }))
        };
    }

    // Submit loan application
    static async apply(memberId, requestedAmount) {
        // 1. Validate eligibility
        const eligibility = await this.canApply(memberId);
        if (!eligibility.allowed) {
            return { success: false, message: eligibility.reason };
        }

        // 2. Check amount
        if (requestedAmount < MIN_LOAN_AMOUNT) {
            return { success: false, message: `Minimum loan is KES ${MIN_LOAN_AMOUNT}.` };
        }
        if (requestedAmount > eligibility.creditLimit) {
            return { success: false, message: `Your current limit is KES ${eligibility.creditLimit}. Requested KES ${requestedAmount}.` };
        }
        if (requestedAmount > MAX_ABSOLUTE_LIMIT) {
            return { success: false, message: `System max loan is KES ${MAX_ABSOLUTE_LIMIT}.` };
        }

        // 3. Calculate repayment
        const schedule = this.calculateRepaymentSchedule(requestedAmount);

        // 4. Create loan record (status: pending)
        const loan = await Loan.create({
            member_id: memberId,
            principal: requestedAmount,
            interest_rate: INTEREST_RATE,
            tenure_months: TENURE_MONTHS
        });

        return {
            success: true,
            message: 'Loan application submitted successfully.',
            loan,
            schedule
        };
    }

    // Admin: Approve loan (triggers B2C disbursement placeholder)
    static async approveLoan(loanId, adminNotes = '') {
        const loan = await Loan.approve(loanId);
        // TODO: When B2C is approved by Safaricom, call Daraja B2C API here.
        // For now, we just mark it approved in the DB.
        return { success: true, message: 'Loan approved. (B2C disbursement not yet implemented—awaiting Safaricom approval.)' };
    }

    // Member: Repay loan (via STK Push)
    static async repayLoan(memberId) {
        const activeLoan = await Loan.getActiveLoan(memberId);
        if (!activeLoan) {
            return { success: false, message: 'No active loan found.' };
        }

        // Determine the amount due (minimum of monthly installment or outstanding)
        const dueAmount = Math.min(activeLoan.monthly_installment, activeLoan.outstanding_balance);

        return {
            success: true,
            loan: activeLoan,
            dueAmount,
            message: `Please pay KES ${dueAmount} to clear this month's installment. We'll trigger an M-Pesa STK push.`
        };
    }
}

module.exports = LoanService;