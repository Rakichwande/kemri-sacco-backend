const Member = require('../models/Member');
const Loan = require('../models/Loan');
const smsService = require('./smsService');
const notificationService = require('./notificationService');
const emailService = require('./emailService');

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
      const principalText = Number(activeLoan.principal).toLocaleString();
      let reason;

      if (activeLoan.status === 'pending') {
        reason = `Your loan application for KES ${principalText} is awaiting review. You'll receive an SMS once it is approved.`;
      } else if (activeLoan.status === 'approved') {
        reason = `Your loan of KES ${principalText} has been approved and is awaiting disbursement. You'll receive an SMS once funds are sent.`;
      } else if (activeLoan.status === 'disbursing') {
        reason = `Your loan of KES ${principalText} is being disbursed. You'll receive an SMS once funds are in your M-Pesa.`;
      } else {
        const outstandingText = Number(activeLoan.outstanding_balance).toLocaleString();
        reason = `You have an outstanding loan of KES ${outstandingText}. Clear it before applying for another.`;
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

  // Apply for a loan.
  //
  // TWO PATHS, chosen by the member's is_board_staff flag:
  //
  //   Regular member  → create as 'pending' → staff review (unchanged)
  //   Board/staff     → create as 'pending' → auto-approve → auto-disburse
  //                     via M-Pesa B2C, all within this single call
  //
  // The board/staff path exists so a board or staff member dialing USSD
  // gets a genuinely instant loan: dial *483*4444#, enter amount, walk
  // away, receive M-Pesa funds shortly after. No staff click required at
  // any step — that's SACCO policy agreed 25 Sept 2026.
  //
  // Safety: if the B2C request fails at any point, the loan stays in the
  // 'approved' state and staff are notified to disburse manually. The
  // member is never left with a phantom disbursement; the worst case is
  // that they wait a few minutes longer than expected.
  //
  // The auto-approval uses approveLoan() — the same method staff call —
  // rather than setting status directly, so every side effect of approval
  // (member SMS, audit trail) lives in one place.
  //
  // MESSAGING: all member SMS and staff notifications for a loan
  // application are sent from here. This function is the only place that
  // knows whether the loan was auto-approved or went to manual review, so
  // it is the only place that can send exactly one, consistent message.
  // The board/staff staff notification fires AFTER the B2C attempt so it
  // can accurately describe what happened (disbursing vs failed vs ready).
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
      return { success: false, message: `Minimum loan is KES ${MIN_LOAN_AMOUNT}.` };
    }
    if (amount > eligibility.creditLimit) {
      return {
        success: false,
        message: `Your current limit is KES ${eligibility.creditLimit.toLocaleString()}. Requested KES ${amount.toLocaleString()}.`,
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
      return { success: false, message: 'You already have an active loan. Clear it before applying again.' };
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
      'Auto-approved: board/staff (SACCO policy, 25 Sept 2026)'
    );

    if (!approval.success) {
      // Should not happen — we just created the loan as 'pending', and
      // approveLoan() only fails when the loan isn't pending or isn't
      // found. If it ever does, fall back to the manual review path so
      // the member gets a clear "we'll review" SMS and the loan appears
      // in the staff queue.
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

    // --- Board/staff: attempt immediate B2C disbursement ---
    //
    // Required here (in-process require) rather than at the top of the
    // file, because disbursementService requires smsService and
    // notificationService — both of which loanService already loads. A
    // top-level require would create a load-order dependency that could
    // bite if either service later requires loanService back.
    const DisbursementService = require('./disbursementService');

    let disbursement = { success: false, message: 'B2C not attempted' };
    try {
      disbursement = await DisbursementService.disburseLoan(loan.id);
    } catch (err) {
      // disburseLoan() catches its own errors and returns a result object,
      // so this is a defensive catch for the impossible case.
      console.error(`Auto-disburse threw unexpectedly for loan ${loan.id}:`, err.message);
      disbursement = { success: false, message: err.message };
    }

    // Notify staff with an accurate status: either the disbursement is
    // in flight, or it failed and needs manual attention.
    await this._notifyAutoApprovedStaff(member, approval.loan, ref, {
      disbursementStatus: disbursement.success ? 'disbursing' : 'failed',
      failureReason: disbursement.success ? null : disbursement.message,
    });

    if (!disbursement.success) {
      return {
        success: true,
        message: 'Loan automatically approved. Disbursement is pending — our team will complete it shortly.',
        loan: approval.loan,
        autoApproved: true,
        disbursementFailed: true,
      };
    }

    return {
      success: true,
      message: 'Loan automatically approved and disbursement initiated. Funds will reach your M-Pesa shortly.',
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

  // Staff notification for the board/staff auto-approval path. Called
  // AFTER the B2C disbursement attempt so the message reflects what
  // actually happened, rather than firing optimistically before we know.
  static async _notifyAutoApprovedStaff(member, loan, ref, opts = {}) {
    const { disbursementStatus, failureReason } = opts;
    try {
      await notificationService.notifyStaff({
        smsText: smsService.templates.staffLoanAutoApproved(member.full_name, loan.principal, ref, {
          status: disbursementStatus,
        }),
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

  static async approveLoan(loanId, adminNotes = '') {
    const loan = await Loan.approve(loanId, adminNotes);
    if (!loan) {
      return { success: false, message: 'Loan not found or not in a pending state.' };
    }

    const member = await Member.findById(loan.member_id);
    if (!member) {
      return { success: false, message: 'Member not found.' };
    }

    try {
      await smsService.sendSMS(
        member.phone_number,
        smsService.templates.loanApproved(
          member.full_name,
          loan.principal,
          loan.monthly_installment,
          loan.tenure_months
        )
      );
    } catch (smsErr) {
      console.error('Loan approval SMS failed (loan still approved):', smsErr.message);
    }

    return {
      success: true,
      loan,
      message: 'Loan approved. Disbursement is manual until M-Pesa B2C is approved by Safaricom.',
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
      message: `Outstanding balance: KES ${Number(activeLoan.outstanding_balance).toLocaleString()}.`,
    };
  }
}

module.exports = LoanService;