const Member = require('../models/Member');
const Loan = require('../models/Loan');
const smsService = require('./smsService');
const notificationService = require('./notificationService');
const emailService = require('./emailService');

const MAX_ABSOLUTE_LIMIT = 20000;
const MIN_LOAN_AMOUNT = 1000;
const INTEREST_RATE = 6.0;

// Loan tenure. Changed from 6 months to 1 month on 7 October 2026 by SACCO
// board decision. Interest rate remains 6% flat — for a 1-month loan this
// means total interest = principal × 6% × 1. Any existing loan rows are
// recalculated by a one-off SQL migration deployed alongside this change;
// only NEW loans created after this deploy will default to the new tenure
// through this constant.
//
// If tenure ever changes again, the same pattern applies: update this
// constant, update the SMS/email templates if the wording assumes a
// specific term, and run a matching SQL migration for existing loans.
const TENURE_MONTHS = 1;

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

  // Standard SACCO 1-month loan repayment schedule:
  //   interest        = principal × (rate / 100) × tenure
  //   total payable   = principal + interest
  //
  // The field `monthlyInstallment` is retained for database and code
  // compatibility (the loans table has a NOT NULL column by that name),
  // but with a 1-month tenure it is semantically the SAME as
  // totalRepayment — there is only one payment due. Treat it as
  // "amount payable" in all messaging.
  static calculateRepaymentSchedule(principal) {
    const totalInterest = Math.round(principal * (INTEREST_RATE / 100) * TENURE_MONTHS);
    const totalRepayment = principal + totalInterest;
    const amountPayable = totalRepayment; // single payment, no division by tenure

    return {
      principal,
      interestRate: INTEREST_RATE,
      tenureMonths: TENURE_MONTHS,
      totalInterest,
      totalRepayment,
      monthlyInstallment: amountPayable,
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
  // any step — SACCO policy agreed 25 Sept 2026.
  //
  // MESSAGING (2026-10-10): board/staff no longer receive the
  // 'loanApproved' SMS. Previously they got TWO SMS within ~30 seconds:
  // one from approveLoan() ("approved, funds shortly") and one from the
  // B2C callback ("disbursed, due X"). Both said roughly the same thing.
  //
  // Now:
  //   - On B2C success: the callback's 'loanDisbursed' SMS is the single
  //     message the member receives. No duplicate.
  //   - On B2C request-time failure: no callback will fire, so we send
  //     the 'loanApproved' SMS here instead — otherwise the member would
  //     be left in silence.
  //
  // The approveLoan() method gained a { skipSms } option to make this
  // possible; it is used only from the auto-approval path below.
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
    //
    // skipSms: true — the B2C callback will send 'loanDisbursed' shortly.
    // If B2C fails at request time (no callback will fire), the failure
    // branch below sends the 'loanApproved' SMS instead so the member
    // isn't left without any notification.
    const approval = await this.approveLoan(
      loan.id,
      'Auto-approved: board/staff (SACCO policy, 25 Sept 2026)',
      { skipSms: true }
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
    // notificationService — both of which loanService already loads.
    // A top-level require would create a load-order dependency.
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

    // 2026-10-10: If B2C failed at request time, no callback will fire.
    // Send the 'loanApproved' SMS now so the member knows the loan is
    // approved and staff will follow up. On success, we stay silent here
    // and let the callback's 'loanDisbursed' SMS be the single message.
    if (!disbursement.success && member) {
      try {
        await smsService.sendSMS(
          member.phone_number,
          smsService.templates.loanApproved(
            member.full_name,
            approval.loan.principal,
            approval.loan.total_interest,
            approval.loan.total_repayment
          )
        );
      } catch (smsErr) {
        console.error('Board/staff fallback approval SMS failed:', smsErr.message);
      }
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

  // Approve a pending loan.
  //
  // 2026-10-10: gained a third `opts` argument with a `skipSms` flag.
  // Used by the auto-approval path in apply() to suppress the member
  // 'loanApproved' SMS when the loan is about to be B2C-disbursed — the
  // callback's 'loanDisbursed' SMS is the single message the member
  // should see in that case. Manual approval (staff clicking Approve in
  // the queue) never passes skipSms, so the SMS fires as before.
  //
  // Member SMS uses standard SACCO accounting terminology:
  //   Principal             — the amount borrowed
  //   Interest              — the charge for the 1-month term
  //   Total amount payable  — principal + interest
  //
  // The due date is NOT included in this SMS because next_payment_due is
  // only set when the loan is actually disbursed (see Loan.markDisbursed).
  // The disbursement SMS carries the date; the approval SMS just
  // communicates the terms.
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
      // 2026-10-10: previous wording said "Disbursement is manual until
      // M-Pesa B2C is approved by Safaricom" — B2C has been live in
      // production since 5 Oct 2026 and that message was misleading
      // anyone reading the admin portal's approve response.
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

    // With a 1-month loan, the "due amount" is really "the remaining
    // principal balance you owe". Using min(monthly, outstanding) still
    // works — both are the same figure when nothing has been paid, and
    // min picks outstanding when a partial payment was made.
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