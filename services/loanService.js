const Member = require('../models/Member');
const Loan = require('../models/Loan');

const MAX_ABSOLUTE_LIMIT = 20000;
const MIN_LOAN_AMOUNT = 1000;
const INTEREST_RATE = 6.0;
const TENURE_MONTHS = 6;

class LoanService {
  static calculateCreditLimit(successfulRepayments) {
    if (successfulRepayments === 0) {
      return 10000;
    }
    return MAX_ABSOLUTE_LIMIT;
  }

  static async canApply(memberId) {
    const member = await Member.findById(memberId);
    if (!member) {
      return { allowed: false, reason: 'Member not found.' };
    }

    const activeLoan = await Loan.getActiveLoan(memberId);
    if (activeLoan) {
      return {
        allowed: false,
        reason: `You have an active loan of KES ${Number(activeLoan.outstanding_balance).toLocaleString()}. Clear it first.`,
        activeLoan,
      };
    }

    const successfulRepayments = await Loan.countRepaidByMember(memberId);
    const creditLimit = this.calculateCreditLimit(successfulRepayments);

    return { allowed: true, creditLimit, member, reason: 'Eligible to apply.' };
  }

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
    };
  }

  static async apply(memberId, requestedAmount) {
    const eligibility = await this.canApply(memberId);
    if (!eligibility.allowed) {
      return { success: false, message: eligibility.reason };
    }

    if (requestedAmount < MIN_LOAN_AMOUNT) {
      return { success: false, message: `Minimum loan is KES ${MIN_LOAN_AMOUNT}.` };
    }
    if (requestedAmount > eligibility.creditLimit) {
      return {
        success: false,
        message: `Your current limit is KES ${eligibility.creditLimit.toLocaleString()}. Requested KES ${requestedAmount.toLocaleString()}.`,
      };
    }

    const loan = await Loan.create({
      member_id: memberId,
      principal: requestedAmount,
      interest_rate: INTEREST_RATE,
      tenure_months: TENURE_MONTHS,
    });

    return { success: true, message: 'Loan application submitted successfully.', loan };
  }

  static async approveLoan(loanId) {
    const loan = await Loan.approve(loanId);
    return {
      success: true,
      loan,
      message: 'Loan approved. Disbursement is manual until M-Pesa B2C is approved by Safaricom.',
    };
  }

  static async repayLoan(memberId) {
    const activeLoan = await Loan.getActiveLoan(memberId);
    if (!activeLoan) {
      return { success: false, message: 'No active loan found.' };
    }

    const dueAmount = Math.min(Number(activeLoan.monthly_installment), Number(activeLoan.outstanding_balance));

    return {
      success: true,
      loan: activeLoan,
      dueAmount,
      message: `Outstanding balance: KES ${Number(activeLoan.outstanding_balance).toLocaleString()}.`,
    };
  }
}

module.exports = LoanService;
