const Member = require('../models/Member');
const Loan = require('../models/Loan');
const smsService = require('./smsService');

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

  // Returns { allowed, reason, creditLimit?, member?, activeLoan? }.
  //
  // getActiveLoan() matches any loan in pending / approved / disbursed, so
  // each of those states blocks a new application — but for a different
  // reason, and the member deserves to know WHICH reason applies to them:
  //
  //   pending   — we haven't reviewed it yet; nothing to repay
  //   approved  — we've said yes but no money has been sent yet
  //   disbursed — money is in their hands, they owe it
  //
  // Before this change the same "You have an active loan of KES X. Clear
  // it first." message was used for all three, which was nonsensical for
  // the first two — it told members to repay a loan that hadn't been
  // funded, and there was no action they could take to unblock themselves.
  //
  // IMPORTANT: for pending/approved loans the message references the
  // PRINCIPAL (what the member applied for), not outstanding_balance.
  // When a loan is created, outstanding_balance is set to total_repayment
  // (principal + interest) because that is the amount that will eventually
  // need to be repaid — but quoting it to the member at the pending stage
  // reads as if a larger loan than they asked for was created without
  // their consent. Principal is the number they will recognise from their
  // own application. For a DISBURSED loan, outstanding_balance IS the
  // correct figure (interest is now legitimately owed), and that case is
  // unchanged below.
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
      } else {
        // disbursed — here outstanding_balance is the right concept, since
        // interest is now part of what they legitimately owe
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

  static async apply(memberId, requestedAmount) {
    // requestedAmount arrives as whatever the caller sent - a USSD digit
    // string, JSON from a future web client, etc. Comparing a non-numeric
    // value with < or > silently coerces to NaN, and EVERY comparison
    // involving NaN evaluates to false - not an error, not a rejection,
    // just false. That means a bad amount ("abc", null-as-string, etc.)
    // would previously sail straight past both the MIN_LOAN_AMOUNT and
    // creditLimit checks below without tripping either one. Normalizing
    // and validating up front, before any business-rule check, closes
    // that gap.
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

    const loan = await Loan.create({
      member_id: memberId,
      principal: amount,
      interest_rate: INTEREST_RATE,
      tenure_months: TENURE_MONTHS,
    });

    // canApply() already checked for an active loan, but that check and
    // this insert aren't atomic - a second, near-simultaneous application
    // could have created one in between. Loan.create() returns null in
    // exactly that case (the database's partial unique index rejected the
    // insert), so this isn't a bug, it's the rare race actually being
    // caught rather than silently corrupting data.
    if (!loan) {
      return { success: false, message: 'You already have an active loan. Clear it before applying again.' };
    }

    return { success: true, message: 'Loan application submitted successfully.', loan };
  }

  static async approveLoan(loanId, adminNotes = '') {
    // 1. Approve the loan (changes status to 'approved')
    const loan = await Loan.approve(loanId);
    if (!loan) {
      return { success: false, message: 'Loan not found or not in a pending state.' };
    }

    // 2. Get the member details
    const member = await Member.findById(loan.member_id);
    if (!member) {
      return { success: false, message: 'Member not found.' };
    }

    // 4. Send SMS to member (Loan Approved)
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

  // Only a DISBURSED loan is repayable. Using getActiveLoan here would let
  // a member whose loan is still pending or approved trigger a real
  // repayment via the /api/loans/repay endpoint before any money has moved
  // to them. getRepayableLoan() filters to status='disbursed' only.
  //
  // When there's no disbursed loan but there IS one in flight, surface a
  // specific, actionable message instead of the previous blunt "no active
  // loan" - the member knows their application is being processed and
  // won't assume they need to reapply.
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