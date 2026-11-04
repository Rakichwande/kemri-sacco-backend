const Member = require('../models/Member');
const Loan = require('../models/Loan');
const smsService = require('./smsService');
const notificationService = require('./notificationService');
const emailService = require('./emailService');
const db = require('../config/database'); 

const MIN_LOAN_AMOUNT = 1000;

class LoanService {
  static async canApply(memberId, purpose = 'mobile') {
    const member = await Member.findById(memberId);
    if (!member) {
      return { allowed: false, reason: 'Member not found.' };
    }

    // 1. SCENARIO B: Check for active loans OF THE SAME PURPOSE FIRST.
    const activeLoansRes = await db.query(
      `SELECT id FROM loans 
       WHERE member_id = $1 AND purpose = $2 AND status IN ('pending', 'approved', 'disbursing', 'disbursed')
       LIMIT 1`,
      [memberId, purpose]
    );
    
    if (activeLoansRes.rows.length > 0) {
      return { 
        allowed: false, 
        reason: `You already have an active or pending ${purpose.toUpperCase()} loan. Please clear it before applying for another.` 
      };
    }

    // 2. Block if limit is 0 (Only applies to Mobile loans)
    const creditLimit = Number(member.credit_limit || 0);
    if (purpose === 'mobile' && creditLimit === 0) {
      return { allowed: false, reason: 'You are currently not eligible to take a Mobile loan. Please contact the SACCO office.' };
    }

    return { allowed: true, creditLimit, member, reason: 'Eligible to apply.' };
  }

  static calculateRepaymentSchedule(principal, purpose) {
    let interestRate = 6;
    let tenureMonths = 1;

    if (purpose === 'emergency' || purpose === 'school') {
      interestRate = 16; // 16% flat per annum
      tenureMonths = 12; // 1 year
    }

    const totalInterest = Math.round(principal * (interestRate / 100) * tenureMonths);
    const totalRepayment = principal + totalInterest;

    return {
      principal,
      interestRate,
      tenureMonths,
      totalInterest,
      totalRepayment,
      monthlyInstallment: totalRepayment, // User pays at their own pace
    };
  }

  static async apply(memberId, requestedAmount, purpose = 'mobile') {
    const amount = Number(requestedAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { success: false, message: 'Invalid loan amount.' };
    }

    const eligibility = await this.canApply(memberId, purpose);
    if (!eligibility.allowed) {
      return { success: false, message: eligibility.reason };
    }

    if (amount < MIN_LOAN_AMOUNT) {
      return { success: false, message: `Minimum loan principal is KES ${MIN_LOAN_AMOUNT}.` };
    }

    // 3. Enforce Limits based on purpose
    if (purpose === 'mobile' && amount > eligibility.creditLimit) {
      return {
        success: false,
        message: `Your available credit limit is KES ${eligibility.creditLimit.toLocaleString()}. Requested amount exceeds this.`,
      };
    }
    if (purpose === 'emergency' && amount > 100000) {
      return { success: false, message: 'Maximum Emergency loan is KES 100,000.' };
    }
    if (purpose === 'school' && amount > 300000) {
      return { success: false, message: 'Maximum School Fees loan is KES 300,000.' };
    }

    const schedule = this.calculateRepaymentSchedule(amount, purpose);
    const isMobile = purpose === 'mobile';
    let autoApprove = isMobile; // Only Mobile is auto-approved

    const loan = await Loan.create({
      member_id: memberId,
      principal: amount,
      interest_rate: schedule.interestRate,
      tenure_months: schedule.tenureMonths,
      purpose: purpose,
    });

    const ref = `LN-${String(loan.id).padStart(5, '0')}`;
    const member = eligibility.member;

    if (!autoApprove) {
      await this._notifyApplicationReceived(member, loan, ref);
      return {
        success: true,
        message: 'Loan application submitted successfully. Awaiting SACCO review.',
        loan,
        autoApproved: false,
      };
    }

    const approval = await this.approveLoan(loan.id, 'Auto-approved: Mobile Loan', { skipSms: true });
    if (!approval.success) {
      await this._notifyApplicationReceived(member, loan, ref);
      return { success: true, message: 'Loan application submitted successfully.', loan, autoApprovalFailed: true };
    }

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
        message: 'Mobile loan approved. Disbursement is pending — our team will complete this shortly.',
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
        smsService.templates.loanApplicationReceived(member.full_name, loan.principal, ref, loan.purpose, loan.total_repayment)
      );
    } catch (smsErr) {
      console.error('Loan application SMS failed:', smsErr.message);
    }

    try {
      await notificationService.notifyStaff({
        smsText: smsService.templates.staffLoanApplication(member.full_name, loan.principal, ref, loan.purpose),
        emailContent: emailService.staffTemplates.loanApplication(member.full_name, loan.principal, ref),
      });
    } catch (notifyErr) {
      console.error('Staff notification failed:', notifyErr.message);
    }
  }

  static async approveLoan(loanId, adminNotes = '', opts = {}) {
    const { skipSms = false } = opts;

    const loanCheck = await db.query('SELECT * FROM loans WHERE id = $1', [loanId]);
    if (loanCheck.rows.length === 0) return { success: false, message: 'Loan not found.' };
    const loanData = loanCheck.rows[0];
    if (loanData.status !== 'pending') return { success: false, message: 'Loan is not in a pending state.' };

    const member = await Member.findById(loanData.member_id);
    if (!member) return { success: false, message: 'Member not found.' };

    const creditLimit = Number(member.credit_limit || 0);
    
    const otherLoansRes = await db.query(
      `SELECT id FROM loans 
       WHERE member_id = $1 AND purpose = $2 AND status IN ('pending', 'approved', 'disbursing', 'disbursed') AND id != $3`,
      [loanData.member_id, loanData.purpose, loanId]
    );
    
    if (otherLoansRes.rows.length > 0) {
      return { success: false, message: `ACTION BLOCKED: Member already has an active ${loanData.purpose.toUpperCase()} loan.` };
    }

    if (loanData.purpose === 'mobile' && Number(loanData.principal) > creditLimit) {
      return { 
        success: false, 
        message: `ACTION BLOCKED: Member's limit is KES ${creditLimit.toLocaleString()}. Approving this KES ${Number(loanData.principal).toLocaleString()} loan would exceed their limit.` 
      };
    }

    const loan = await Loan.approve(loanId, adminNotes);
    if (!loan) return { success: false, message: 'Could not approve loan.' };

    if (!skipSms) {
      try {
        await smsService.sendSMS(
          member.phone_number,
          smsService.templates.loanApproved(
            member.full_name,
            loan.principal,
            loan.total_interest,
            loan.total_repayment,
            loan.purpose
          )
        );
      } catch (smsErr) {
        console.error('Loan approval SMS failed:', smsErr.message);
      }
    }

    return { success: true, loan, message: 'Loan approved.' };
  }

  static async rejectLoan(loanId, adminNotes = '') {
    const loan = await Loan.reject(loanId, adminNotes);
    if (!loan) return { success: false, message: 'Loan not found or not pending.' };

    const member = await Member.findById(loan.member_id);
    if (member) {
      try {
        await smsService.sendSMS(member.phone_number, smsService.templates.loanRejected(member.full_name, adminNotes, loan.purpose));
      } catch (smsErr) { console.error('Loan rejection SMS failed:', smsErr.message); }
    }
    return { success: true, loan, message: 'Loan rejected.' };
  }

  static async repayLoan(memberId) {
    const activeLoan = await Loan.getRepayableLoan(memberId);
    if (!activeLoan) {
      const inFlight = await Loan.getActiveLoan(memberId);
      if (inFlight && inFlight.status === 'pending') return { success: false, message: 'Your loan application is still awaiting approval.' };
      if (inFlight && inFlight.status === 'approved') return { success: false, message: 'Your loan has been approved and is awaiting disbursement.' };
      if (inFlight && inFlight.status === 'disbursing') return { success: false, message: 'Your loan is being disbursed. Please wait for the M-Pesa confirmation.' };
      return { success: false, message: 'No active loan found.' };
    }
    return {
      success: true,
      loan: activeLoan,
      dueAmount: Number(activeLoan.outstanding_balance),
      message: `Amount payable: KES ${Number(activeLoan.outstanding_balance).toLocaleString()}.`,
    };
  }
}

module.exports = LoanService;