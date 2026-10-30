const Member = require('../models/Member');
const Loan = require('../models/Loan');
const smsService = require('./smsService');
const notificationService = require('./notificationService');
const emailService = require('./emailService');
const db = require('../config/database'); 

// 2026-10-19: Board policy dictates that the maximum loan limit is strictly
// KES 10,000 for ALL members (board/staff and regular alike).
const MAX_ABSOLUTE_LIMIT = 10000;
const MIN_LOAN_AMOUNT = 1000;
const INTEREST_RATE = 6.0;
const TENURE_MONTHS = 1;

class LoanService {
  static calculateCreditLimit(successfulRepayments) {
    return MAX_ABSOLUTE_LIMIT;
  }

  static async canApply(memberId) {
    const member = await Member.findById(memberId);
    if (!member) {
      return { allowed: false, reason: 'Member not found.' };
    }

    // 2026-10-30: Removed the activeLoan check. Members can now have multiple loans 
    // (e.g., an Emergency loan while they still have a Mobile loan).

    const successfulRepayments = await Loan.countRepaidByMember(memberId);
    const creditLimit = this.calculateCreditLimit(successfulRepayments);

    return { allowed: true, creditLimit, member, reason: 'Eligible to apply.' };
  }

  static calculateRepaymentSchedule(principal) {
    const totalInterest = Math.round(principal * (INTEREST_RATE / 100) * TENURE_MONTHS);
    const totalRepayment = principal + totalInterest;
    const amountPayable = totalRepayment; 

    return {
      principal,
      interestRate: INTEREST_RATE,
      tenureMonths: TENURE_MONTHS,
      totalInterest,
      totalRepayment,
      monthlyInstallment: amountPayable,
    };
  }

  static async apply(memberId, requestedAmount, purpose = 'general') {
    const amount = Number(requestedAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: 'Invalid loan amount.' };
    }

    const eligibility = await this.canApply(memberId);
    if (!eligibility.allowed) {
      return { success: false, message: eligibility.reason };
    }

    if (amount < MIN_LOAN_AMOUNT) {
      return { success: false, message: `Minimum loan principal is KES ${MIN_LOAN_AMOUNT}.` };
    }
    if (amount > eligibility.creditLimit) {
      return {
        success: false,
        message: `Your current credit limit is KES ${eligibility.creditLimit.toLocaleString()}. Requested principal of KES ${amount.toLocaleString()} exceeds this.`,
      };
    }

    // 2026-10-30: ONLY Mobile loans are auto-approved. 
    // Emergency and School loans for EVERYONE (Board/Staff and Regular) go to the Admin Queue.
    const isMobile = purpose === 'mobile';
    const autoApprove = isMobile; 

    const loan = await Loan.create({
      member_id: memberId,
      principal: amount,
      interest_rate: INTEREST_RATE,
      tenure_months: TENURE_MONTHS,
      purpose: purpose,
    });

    const ref = `LN-${String(loan.id).padStart(5, '0')}`;
    const member = eligibility.member;

    // --- Manual review path (Emergency/School for everyone) ---
    if (!autoApprove) {
      await this._notifyApplicationReceived(member, loan, ref);
      return {
        success: true,
        message: 'Loan application submitted successfully.',
        loan,
        autoApproved: false,
      };
    }

    // --- Auto-approval path (Mobile Only) ---
    const approval = await this.approveLoan(loan.id, 'Auto-approved: Mobile Loan', { skipSms: true });

    if (!approval.success) {
      await this._notifyApplicationReceived(member, loan, ref);
      return { success: true, message: 'Loan application submitted successfully.', loan, autoApprovalFailed: true };
    }

    // --- Mobile Loan Routing: B2C to M-Pesa ---
    const DisbursementService = require('./disbursementService');
    let disbursement = { success: false, message: 'B2C not attempted' };
    
    try {
      disbursement = await DisbursementService.disburseLoan(loan.id);
    } catch (err) {
      disbursement = { success: false, message: err.message };
    }

    if (!disbursement.success) {
      return {
        success: true,
        message: 'Mobile loan approved. Disbursement is pending — our team will complete it shortly.',
        loan: approval.loan,
        autoApproved: true,
        disbursementFailed: true,
      };
    }

    return {
      success: true,
      message: 'Mobile loan approved. Funds will reach your M-Pesa shortly.',
      loan: disbursement.loan || approval.loan,
      autoApproved: true,
      disbursing: true,
    };
  }

  static async _notifyApplicationReceived(member, loan, ref) {
    try {
      await smsService.sendSMS(
        member.phone_number,
        smsService.templates.loanApplicationReceived(member.full_name, loan.principal, ref)
      );
    } catch (smsErr) {
      console.error('Loan application SMS failed (application still recorded):', smsErr.message);
    }

    try {
      await notificationService.notifyStaff({
        smsText: smsService.templates.staffLoanApplication(member.full_name, loan.principal, ref),
        emailContent: emailService.staffTemplates.loanApplication(member.full_name, loan.principal, ref),
      });
    } catch (notifyErr) {
      console.error('Staff notification for loan application failed:', notifyErr.message);
    }
  }

  static async _notifyAutoApprovedStaff(member, loan, ref, opts = {}) {
    const { disbursementStatus, failureReason } = opts;
    
    let smsText;
    if (disbursementStatus === 'wallet_credited') {
      smsText = smsService.templates.staffWalletCredited(member.full_name, loan.principal, ref);
    } else {
      smsText = smsService.templates.staffLoanAutoApproved(member.full_name, loan.principal, ref, {
        status: disbursementStatus,
      });
    }

    try {
      await notificationService.notifyStaff({
        smsText,
        emailContent: emailService.staffTemplates.loanAutoApproved(member.full_name, loan.principal, ref, {
          installment: loan.monthly_installment,
          tenureMonths: loan.tenure_months,
          memberPhone: member.phone_number,
          status: disbursementStatus,
          failureReason,
        }),
      });
    } catch (notifyErr) {
      console.error('Staff notification for auto-approved loan failed:', notifyErr.message);
    }
  }

  static async approveLoan(loanId, adminNotes = '', opts = {}) {
    const { skipSms = false } = opts;

    const loan = await Loan.approve(loanId, adminNotes);
    if (!loan) {
      return { success: false, message: 'Loan not found or not in a pending state.' };
    }

    const member = await Member.findById(loan.member_id);
    if (!member) {
      return { success: false, message: 'Member not found.' };
    }

    if (!skipSms) {
      try {
        await smsService.sendSMS(
          member.phone_number,
          smsService.templates.loanApproved(
            member.full_name,
            loan.principal,
            loan.total_interest,
            loan.total_repayment
          )
        );
      } catch (smsErr) {
        console.error('Loan approval SMS failed (loan still approved):', smsErr.message);
      }
    }

    return {
      success: true,
      loan,
      message: 'Loan approved. Ready for disbursement.',
    };
  }

  static async rejectLoan(loanId, adminNotes = '') {
    const loan = await Loan.reject(loanId, adminNotes);
    if (!loan) {
      return { success: false, message: 'Loan not found or not in a pending state.' };
    }

    const member = await Member.findById(loan.member_id);
    if (member) {
      try {
        await smsService.sendSMS(
          member.phone_number,
          smsService.templates.loanRejected(member.full_name, adminNotes)
        );
      } catch (smsErr) {
        console.error('Loan rejection SMS failed (loan still rejected):', smsErr.message);
      }
    }

    return { success: true, loan, message: 'Loan rejected.' };
  }

  static async repayLoan(memberId) {
    const activeLoan = await Loan.getRepayableLoan(memberId);
    if (!activeLoan) {
      const inFlight = await Loan.getActiveLoan(memberId);
      if (inFlight && inFlight.status === 'pending') {
        return { success: false, message: 'Your loan application is still awaiting approval.' };
      }
      if (inFlight && inFlight.status === 'approved') {
        return { success: false, message: 'Your loan has been approved and is awaiting disbursement.' };
      }
      if (inFlight && inFlight.status === 'disbursing') {
        return { success: false, message: 'Your loan is being disbursed. Please wait for the M-Pesa confirmation.' };
      }
      return { success: false, message: 'No active loan found.' };
    }

    const dueAmount = Math.min(Number(activeLoan.monthly_installment), Number(activeLoan.outstanding_balance));

    return {
      success: true,
      loan: activeLoan,
      dueAmount,
      message: `Amount payable: KES ${Number(activeLoan.outstanding_balance).toLocaleString()}.`,
    };
  }
}

module.exports = LoanService;