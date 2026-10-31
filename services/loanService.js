const Member = require('../models/Member');
const Loan = require('../models/Loan');
const smsService = require('./smsService');
const notificationService = require('./notificationService');
const emailService = require('./emailService');
const db = require('../config/database'); 

const MIN_LOAN_AMOUNT = 1000;
const INTEREST_RATE = 6.0;
const TENURE_MONTHS = 1;

class LoanService {
  static async canApply(memberId) {
    const member = await Member.findById(memberId);
    if (!member) {
      return { allowed: false, reason: 'Member not found.' };
    }

    const creditLimit = Number(member.credit_limit || 0);

    // 1. Block if limit is 0 (Member not on the 5k list or Board)
    if (creditLimit === 0) {
      return { allowed: false, reason: 'You are currently not eligible to take a loan. Please contact the SACCO office.' };
    }

    // 2. CRITICAL FIX: Check total exposure across ALL active loans.
    // For pending/approved loans, count the PRINCIPAL (since outstanding_balance is 0 until disbursed).
    // For disbursing/disbursed loans, count the OUTSTANDING BALANCE.
    const activeLoansRes = await db.query(
      `SELECT COALESCE(SUM(
        CASE 
          WHEN status IN ('pending', 'approved') THEN principal
          WHEN status IN ('disbursing', 'disbursed') THEN outstanding_balance
          ELSE 0
        END
      ), 0) AS total_exposure 
       FROM loans 
       WHERE member_id = $1 AND status IN ('pending', 'approved', 'disbursing', 'disbursed')`,
      [memberId]
    );
    
    const totalExposure = Number(activeLoansRes.rows[0].total_exposure);
    const availableLimit = creditLimit - totalExposure;

    // 3. Block if they have maxed out their limit (including pending applications)
    if (availableLimit <= 0) {
      return { 
        allowed: false, 
        reason: `You have reached your maximum credit limit of KES ${creditLimit.toLocaleString()}. Please clear your outstanding or pending loans before applying for another.` 
      };
    }

    return { allowed: true, creditLimit: availableLimit, member, reason: 'Eligible to apply.' };
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
    
    // Check against the AVAILABLE limit, not the raw credit limit
    if (amount > eligibility.creditLimit) {
      return {
        success: false,
        message: `Your available credit limit is KES ${eligibility.creditLimit.toLocaleString()}. Requested principal of KES ${amount.toLocaleString()} exceeds this.`,
      };
    }

    // ONLY Board/Staff Mobile loans are auto-approved. 
    const isMobile = purpose === 'mobile';
    const isBoard = eligibility.member.is_board_staff === true;
    
    let autoApprove = false;
    if (isMobile && isBoard && amount <= 10000) {
      autoApprove = true;
    }

    const loan = await Loan.create({
      member_id: memberId,
      principal: amount,
      interest_rate: INTEREST_RATE,
      tenure_months: TENURE_MONTHS,
      purpose: purpose,
    });

    const ref = `LN-${String(loan.id).padStart(5, '0')}`;
    const member = eligibility.member;

    // --- Manual review path ---
    if (!autoApprove) {
      await this._notifyApplicationReceived(member, loan, ref);
      return {
        success: true,
        message: 'Loan application submitted successfully. Awaiting SACCO review.',
        loan,
        autoApproved: false,
      };
    }

    // --- Auto-approval path (Board/Staff Mobile Only) ---
    const approval = await this.approveLoan(loan.id, 'Auto-approved: Board Mobile Loan', { skipSms: true });

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

    // --- CRITICAL FIX: Re-verify limits before approval ---
    // 1. Fetch the pending loan
    const loanCheck = await db.query('SELECT * FROM loans WHERE id = $1', [loanId]);
    if (loanCheck.rows.length === 0) {
      return { success: false, message: 'Loan not found.' };
    }
    const loanData = loanCheck.rows[0];
    if (loanData.status !== 'pending') {
      return { success: false, message: 'Loan is not in a pending state.' };
    }

    // 2. Fetch member and calculate their exposure EXCLUDING this current loan
    const member = await Member.findById(loanData.member_id);
    if (!member) {
      return { success: false, message: 'Member not found.' };
    }

    const creditLimit = Number(member.credit_limit || 0);
    
    const otherLoansRes = await db.query(
      `SELECT COALESCE(SUM(
        CASE 
          WHEN status IN ('pending', 'approved') THEN principal
          WHEN status IN ('disbursing', 'disbursed') THEN outstanding_balance
          ELSE 0
        END
      ), 0) AS total_exposure 
       FROM loans 
       WHERE member_id = $1 AND status IN ('pending', 'approved', 'disbursing', 'disbursed') AND id != $2`,
      [loanData.member_id, loanId]
    );
    
    const otherExposure = Number(otherLoansRes.rows[0].total_exposure);

    // 3. Prevent admin from approving if it exceeds limit
    if (otherExposure + Number(loanData.principal) > creditLimit) {
      return { 
        success: false, 
        message: `ACTION BLOCKED: Member's limit is KES ${creditLimit.toLocaleString()}. They already have KES ${otherExposure.toLocaleString()} in active/pending loans. Approving this KES ${Number(loanData.principal).toLocaleString()} loan would exceed their limit.` 
      };
    }
    // -------------------------------------------------------

    const loan = await Loan.approve(loanId, adminNotes);
    if (!loan) {
      return { success: false, message: 'Loan not found or could not be approved.' };
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