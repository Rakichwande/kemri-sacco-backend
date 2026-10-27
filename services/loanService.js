const Member = require('../models/Member');
const Loan = require('../models/Loan');
const smsService = require('./smsService');
const notificationService = require('./notificationService');
const emailService = require('./emailService');
const db = require('../config/database'); // Added for transactions

// 2026-10-19: Board policy dictates that the maximum loan limit is strictly
// KES 10,000 for ALL members (board/staff and regular alike).
const MAX_ABSOLUTE_LIMIT = 10000;
const MIN_LOAN_AMOUNT = 1000;
const INTEREST_RATE = 6.0;
const TENURE_MONTHS = 1;

class LoanService {
  static calculateCreditLimit(successfulRepayments) {
    // The limit no longer increases after successful repayments.
    // Everyone is capped at 10,000.
    return MAX_ABSOLUTE_LIMIT;
  }

  static async canApply(memberId) {
    const member = await Member.findById(memberId);
    if (!member) {
      return { allowed: false, reason: 'Member not found.' };
    }

    const activeLoan = await Loan.getActiveLoan(memberId);
    if (activeLoan) {
      const principalText = Number(activeLoan.principal).toLocaleString();
      let reason;

      if (activeLoan.status === 'pending') {
        reason = `Your loan application for a principal of KES ${principalText} is awaiting review. You'll receive an SMS once it is approved.`;
      } else if (activeLoan.status === 'approved') {
        reason = `Your loan of KES ${principalText} has been approved and is awaiting disbursement. You'll receive an SMS once funds are sent.`;
      } else if (activeLoan.status === 'disbursing') {
        reason = `Your loan of KES ${principalText} is being disbursed. You'll receive an SMS once funds are in your M-Pesa.`;
      } else {
        const outstandingText = Number(activeLoan.outstanding_balance).toLocaleString();
        reason = `You have an outstanding balance of KES ${outstandingText} on your current loan. Settle it before applying for another.`;
      }

      return { allowed: false, reason, activeLoan };
    }

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

  static async apply(memberId, requestedAmount) {
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

    const autoApprove = eligibility.member.is_board_staff === true;

    const loan = await Loan.create({
      member_id: memberId,
      principal: amount,
      interest_rate: INTEREST_RATE,
      tenure_months: TENURE_MONTHS,
    });

    if (!loan) {
      return { success: false, message: 'You already have an active loan. Settle it before applying again.' };
    }

    const ref = `LN-${String(loan.id).padStart(5, '0')}`;
    const member = eligibility.member;

    // --- Regular member: manual review path ---
    if (!autoApprove) {
      await this._notifyApplicationReceived(member, loan, ref);
      return {
        success: true,
        message: 'Loan application submitted successfully.',
        loan,
        autoApproved: false,
      };
    }

    // --- Board/staff: auto-approval path ---
    const approval = await this.approveLoan(
      loan.id,
      'Auto-approved: board/staff (SACCO policy, 25 Sept 2026)',
      { skipSms: true }
    );

    if (!approval.success) {
      console.error(
        `Auto-approval failed for board/staff member ${memberId} on loan ${loan.id}: ${approval.message}`
      );
      await this._notifyApplicationReceived(member, loan, ref);
      return {
        success: true,
        message: 'Loan application submitted successfully.',
        loan,
        autoApprovalFailed: true,
      };
    }

    // --- Credit the Wallet Instead of B2C (M-Shwari Model) ---
    // 2026-10-23: CEO approved M-Shwari style. Loans go to the wallet first.
    let loanResult = approval.loan;
    try {
      const client = await db.pool.connect();
      try {
        await client.query('BEGIN');
        
        // 1. Mark the loan as disbursed (updates total_outstanding_balance)
        loanResult = await Loan.markDisbursed(loan.id, 'Wallet Credit', 'wallet', client);
        
        // 2. Credit the member's wallet
        await Member.creditWallet(memberId, loan.principal, 'loan_credit', ref, client);
        
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } catch (dbErr) {
      console.error(`Failed to credit wallet for loan ${loan.id}:`, dbErr.message);
      return { 
        success: false, 
        message: 'Loan approved, but wallet credit failed. Please contact support.' 
      };
    }

    // 3. Send the member the Wallet SMS
    if (member) {
      // Format today's date for the SMS
      const today = new Date().toLocaleDateString('en-GB', { 
        day: '2-digit', month: 'short', year: 'numeric' 
      });

      try {
        await smsService.sendSMS(
          member.phone_number,
          smsService.templates.loanWalletCredited(
            member.full_name, 
            loan.principal, 
            loan.total_repayment,
            today // <-- Added date argument here
          )
        );
      } catch (smsErr) {
        console.error('Wallet credit SMS failed:', smsErr.message);
      }
    }

    // 4. Notify staff that the wallet was credited
    await this._notifyAutoApprovedStaff(member, approval.loan, ref, {
      disbursementStatus: 'wallet_credited',
      failureReason: null,
    });

    return {
      success: true,
      message: 'Loan approved and credited to your SACCO Wallet. Dial *483*4444# to withdraw.',
      loan: loanResult,
      autoApproved: true,
      walletCredited: true,
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