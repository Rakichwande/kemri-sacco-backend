const Loan = require('../models/Loan');
const Withdrawal = require('../models/Withdrawal');
const Member = require('../models/Member');
const smsService = require('./smsService');
const notificationService = require('./notificationService');
const emailService = require('./emailService');
const darajaB2CService = require('./darajaB2CService');

// Maximum withdrawal amount that can be paid out instantly via B2C
// without staff review. Below this threshold, a USSD withdrawal request
// triggers an immediate B2C payout. At or above it, the request goes
// straight to the staff queue as before.
//
// Chosen to cover day-to-day member needs (transport, small emergencies)
// while keeping staff oversight on amounts that would meaningfully drain
// the SACCO's M-Pesa float from a single fraudulent or mistaken request.
// If this number changes, only this constant needs updating — the USSD
// controller reads it via DisbursementService.INSTANT_WITHDRAWAL_LIMIT.
const INSTANT_WITHDRAWAL_LIMIT = 5000;

// Orchestrates the B2C disbursement flow end to end for BOTH loans and
// withdrawals. The split of responsibility with LoanService is:
//
//   LoanService        — decisions about loans (who can borrow, how much,
//                        when to approve/reject). Understands policy.
//   DisbursementService — moving money out. Understands the mechanics of
//                        Safaricom's B2C API and the async callback dance.
//                        Handles both loan disbursements and instant
//                        withdrawals — both are "money out" operations
//                        with identical mechanics.
//
// All member- and staff-facing SMS text lives in services/smsService.js's
// templates object. This file only decides WHEN to send, not what to say —
// wording changes belong in smsService.js, not here.
class DisbursementService {
  // Initiate disbursement of an approved loan via B2C. Called by staff
  // clicking the "Disburse" button in the admin console.
  //
  // Flow:
  //   1. Load the loan, verify it's in 'approved'
  //   2. Load the member for their phone number
  //   3. Call B2C
  //   4. If Safaricom accepts (ResponseCode 0): move loan to 'disbursing',
  //      return success + ConversationID
  //   5. If Safaricom rejects or the transport fails: leave loan as
  //      'approved', return the error
  //
  // On return, the loan is either still 'approved' (any failure) or
  // 'disbursing' (accepted, awaiting callback). The caller does NOT need
  // to distinguish the two — the DB reflects the truth.
  static async disburseLoan(loanId) {
    // 1. Load and check state
    const loan = await Loan.findById(loanId);
    if (!loan) {
      return { success: false, message: 'Loan not found.' };
    }
    if (loan.status !== 'approved') {
      return {
        success: false,
        message: `Loan is currently '${loan.status}' — only approved loans can be disbursed via B2C.`,
      };
    }

    // 2. Member phone
    const member = await Member.findById(loan.member_id);
    if (!member) {
      return { success: false, message: 'Member not found.' };
    }
    if (!member.phone_number) {
      return {
        success: false,
        message: 'Member has no phone number on file. Disburse manually and record the M-Pesa receipt.',
      };
    }

    // 3. B2C config check — fail fast with a clear message rather than
    // letting darajaB2CService throw a low-level error.
    if (!darajaB2CService.isConfigured()) {
      return {
        success: false,
        message: `B2C is not configured (missing: ${darajaB2CService.missingConfig().join(', ')}). Disburse manually.`,
      };
    }

    // 4. Call Safaricom
    let response;
    try {
      response = await darajaB2CService.b2cPayment({
        phoneNumber: member.phone_number,
        amount: loan.principal, // disburse the principal, not total_repayment
        remarks: `KEMRI SACCO Loan ${loan.reference || 'LN-' + String(loan.id).padStart(5, '0')}`,
      });
    } catch (err) {
      // Transport failure — request never reached Safaricom. Loan stays
      // in 'approved', nothing changed.
      return {
        success: false,
        message: `Could not reach Safaricom: ${err.message}. Loan remains approved.`,
      };
    }

    // 5. Safaricom rejected the request outright
    if (String(response.ResponseCode) !== '0') {
      return {
        success: false,
        message: `Safaricom rejected the disbursement: ${response.ResponseDescription || 'unknown reason'}. Loan remains approved.`,
      };
    }

    // 6. Safaricom accepted — move loan to 'disbursing'
    const updated = await Loan.markDisbursing(loanId, response.ConversationID);

    if (!updated) {
      // Race: two staff clicked "Disburse" simultaneously, or the loan
      // changed state between our read and our write. The B2C request has
      // ALREADY been sent to Safaricom — we can't un-send it. Log loudly
      // for reconciliation; the callback will resolve the loan if the
      // money moves.
      console.error(
        `⚠️ Race: loan ${loanId} was not in 'approved' when marking disbursing. ` +
        `B2C ConversationID ${response.ConversationID} is live and unrecorded. ` +
        `The result callback will attempt to resolve it via findByB2CConversationId.`
      );
      return {
        success: false,
        message: 'Loan was modified during disbursement. Check the Disbursement Log — Safaricom may still deliver the funds.',
      };
    }

    return {
      success: true,
      loan: updated,
      conversationId: response.ConversationID,
      message: 'Disbursement initiated. The loan will be marked disbursed once Safaricom confirms.',
    };
  }

  // Initiate an instant withdrawal payout via B2C. Called from the USSD
  // controller when a member requests a withdrawal at or below
  // INSTANT_WITHDRAWAL_LIMIT.
  //
  // The threshold is enforced HERE as well as in the USSD controller.
  // Belt-and-braces: the USSD path is the only current caller, but if a
  // future caller tries to bypass the threshold, this method refuses
  // rather than silently paying out a large amount without review.
  //
  // On failure at ANY stage, the withdrawal stays (or returns) to
  // 'pending' so it appears in the staff queue. The member never loses
  // their request — worst case, staff process it a few minutes later.
  //
  // 2026-10-10: DORMANT — the USSD withdrawal option was retired on
  // 2026-10-09 per board instruction, so this method has no live caller.
  // Kept on disk (with the corresponding withdrawal SMS templates) so
  // the code is recoverable if the board ever reinstates the feature.
  static async disburseWithdrawal(withdrawalId) {
    // 1. Load and check state
    const withdrawal = await Withdrawal.findById(withdrawalId);
    if (!withdrawal) {
      return { success: false, message: 'Withdrawal not found.' };
    }
    if (withdrawal.status !== 'pending') {
      return {
        success: false,
        message: `Withdrawal is currently '${withdrawal.status}' — only pending withdrawals can be auto-paid.`,
      };
    }

    // 2. Threshold check — authoritative gate.
    const amount = Number(withdrawal.amount);
    if (amount > INSTANT_WITHDRAWAL_LIMIT) {
      return {
        success: false,
        message: `Amount KES ${amount.toLocaleString()} exceeds the instant-payout limit of KES ${INSTANT_WITHDRAWAL_LIMIT.toLocaleString()}. This withdrawal requires staff processing.`,
      };
    }

    // 3. Member phone
    const member = await Member.findById(withdrawal.member_id);
    if (!member) {
      return { success: false, message: 'Member not found.' };
    }
    if (!member.phone_number) {
      return {
        success: false,
        message: 'Member has no phone number on file. Withdrawal stays pending for staff processing.',
      };
    }

    // 4. B2C config check
    if (!darajaB2CService.isConfigured()) {
      return {
        success: false,
        message: `B2C is not configured (missing: ${darajaB2CService.missingConfig().join(', ')}). Withdrawal stays pending.`,
      };
    }

    // 5. Call Safaricom
    let response;
    try {
      response = await darajaB2CService.b2cPayment({
        phoneNumber: member.phone_number,
        amount,
        remarks: `KEMRI SACCO Withdrawal #${withdrawal.id}`,
      });
    } catch (err) {
      return {
        success: false,
        message: `Could not reach Safaricom: ${err.message}. Withdrawal stays pending for staff processing.`,
      };
    }

    // 6. Safaricom rejected outright (auth, float, invalid recipient)
    if (String(response.ResponseCode) !== '0') {
      return {
        success: false,
        message: `Safaricom rejected the instant payout: ${response.ResponseDescription || 'unknown reason'}. Withdrawal stays pending.`,
      };
    }

    // 7. Safaricom accepted — move withdrawal to 'disbursing'
    const updated = await Withdrawal.markDisbursing(withdrawalId, response.ConversationID);

    if (!updated) {
      console.error(
        `⚠️ Race: withdrawal ${withdrawalId} was not in 'pending' when marking disbursing. ` +
        `B2C ConversationID ${response.ConversationID} is live and unrecorded. ` +
        `The result callback will attempt to resolve it via findByB2CConversationId.`
      );
      return {
        success: false,
        message: 'Withdrawal was modified during payout. Check the Withdrawal Queue — Safaricom may still deliver the funds.',
      };
    }

    return {
      success: true,
      withdrawal: updated,
      conversationId: response.ConversationID,
      message: 'Instant withdrawal initiated. Funds will reach the member shortly.',
    };
  }

  // Handle the B2C result callback from Safaricom. Routes by ConversationID
  // against both tables — a ConversationID belongs to exactly one.
  static async handleB2CResult(payload) {
    const result = payload?.Result;
    if (!result || !result.ConversationID) {
      console.error('B2C result callback: malformed payload', JSON.stringify(payload));
      return { handled: false, reason: 'Malformed payload' };
    }

    const loan = await Loan.findByB2CConversationId(result.ConversationID);
    if (loan) {
      return this._handleLoanB2CResult(loan, result);
    }

    const withdrawal = await Withdrawal.findByB2CConversationId(result.ConversationID);
    if (withdrawal) {
      return this._handleWithdrawalB2CResult(withdrawal, result);
    }

    console.error(`B2C result callback: no loan or withdrawal for ConversationID ${result.ConversationID}`);
    return { handled: false, reason: 'Unknown ConversationID' };
  }

  static async _handleLoanB2CResult(loan, result) {
    // Already resolved — duplicate callback.
    if (loan.status !== 'disbursing') {
      console.log(`B2C result callback: loan ${loan.id} already ${loan.status}; ignoring duplicate.`);
      return { handled: true, loan, alreadyResolved: true };
    }

    const member = await Member.findById(loan.member_id);

    // --- Failure: ResultCode != 0 ---
    if (Number(result.ResultCode) !== 0) {
      const reason = result.ResultDesc || `ResultCode ${result.ResultCode}`;
      const rolledBack = await Loan.rollbackDisbursing(loan.id, reason);

      console.error(`B2C disbursement failed for loan ${loan.id}: ${reason}`);

      // Notify the member — their loan was approved but money didn't move.
      if (member) {
        try {
          await smsService.sendSMS(
            member.phone_number,
            smsService.templates.loanDisbursementFailed(member.full_name)
          );
        } catch (err) {
          console.error('B2C failure SMS to member failed:', err.message);
        }
      }

      // Notify staff — this needs human action.
      try {
        await notificationService.notifyStaff({
          smsText: smsService.templates.staffLoanDisbursementFailed(
            member?.full_name || 'a member',
            loan.reference,
            reason
          ),
          emailContent: emailService.staffTemplates.loanAutoApproved
            ? emailService.staffTemplates.loanAutoApproved(member?.full_name || 'a member', loan.principal, loan.reference)
            : null,
        });
      } catch (err) {
        console.error('B2C failure staff notification failed:', err.message);
      }

      return { handled: true, loan: rolledBack, failed: true, reason };
    }

    // --- Success: extract receipt and complete the disbursement ---
    const params = result.ResultParameters?.ResultParameter || [];
    const receipt = params.find((p) => p.Key === 'TransactionReceipt')?.Value || null;

    const disbursed = await Loan.markDisbursed(loan.id, receipt, 'b2c');

    console.log(`✅ B2C disbursement confirmed for loan ${loan.id}, receipt ${receipt}`);

    // Notify the member.
    //
    // 2026-10-10: Fixed the due-date source. Previously the fourth
    // argument was `new Date().toLocaleDateString(...)` — i.e. TODAY's
    // date, evaluated at the moment of the callback. Every loan
    // disbursed via B2C was showing its disbursement date as the due
    // date, so a loan disbursed on 8 Oct reported "due 08 Oct" when the
    // correct date was 8 Nov. Now reads disbursed.next_payment_due,
    // which Loan.markDisbursed() sets correctly to
    // (NOW() + INTERVAL '1 month').
    //
    // The outstanding balance is re-read from the DB because markDisbursed
    // just incremented members.total_outstanding_balance — the `member`
    // object above predates that write. Pulled out of the argument list
    // into named variables to keep the SMS call readable.
    if (member) {
      const updatedMember = await Member.findById(loan.member_id);
      const amountOutstanding =
        updatedMember?.total_outstanding_balance || loan.total_repayment;

      const dueDateFormatted = disbursed.next_payment_due
        ? new Date(disbursed.next_payment_due).toLocaleDateString('en-GB', {
            day: '2-digit', month: 'short', year: 'numeric',
          })
        : '—';

      try {
        await smsService.sendSMS(
          member.phone_number,
          smsService.templates.loanDisbursed(
            member.full_name,
            loan.principal,
            amountOutstanding,
            dueDateFormatted
          )
        );
      } catch (err) {
        console.error('B2C success SMS to member failed:', err.message);
      }
    }

    // Staff get a record of the disbursement with the receipt — useful
    // for end-of-day reconciliation.
    try {
      await notificationService.notifyStaff({
        smsText: smsService.templates.staffLoanDisbursed(
          member?.full_name || 'a member',
          loan.reference,
          receipt
        ),
        emailContent: null,
      });
    } catch (err) {
      console.error('B2C success staff notification failed:', err.message);
    }

    return { handled: true, loan: disbursed, failed: false, receipt };
  }

  static async _handleWithdrawalB2CResult(withdrawal, result) {
    // Already resolved — duplicate callback.
    if (withdrawal.status !== 'disbursing') {
      console.log(`B2C result callback: withdrawal ${withdrawal.id} already ${withdrawal.status}; ignoring duplicate.`);
      return { handled: true, withdrawal, alreadyResolved: true };
    }

    const member = await Member.findById(withdrawal.member_id);

    // --- Failure ---
    if (Number(result.ResultCode) !== 0) {
      const reason = result.ResultDesc || `ResultCode ${result.ResultCode}`;
      const rolledBack = await Withdrawal.rollbackDisbursing(withdrawal.id, reason);

      console.error(`B2C instant withdrawal failed for withdrawal ${withdrawal.id}: ${reason}`);

      // Member SMS — acknowledges the delay and confirms the queue.
      if (member) {
        try {
          await smsService.sendSMS(
            member.phone_number,
            smsService.templates.withdrawalInstantFailed(member.full_name, withdrawal.amount)
          );
        } catch (err) {
          console.error('Withdrawal failure SMS to member failed:', err.message);
        }
      }

      // Staff notification — the withdrawal is now in their queue and
      // needs their action.
      try {
        await notificationService.notifyStaff({
          smsText: smsService.templates.staffWithdrawalInstantFailed(
            member?.full_name || 'a member',
            withdrawal.amount
          ),
          emailContent: null,
        });
      } catch (err) {
        console.error('Withdrawal failure staff notification failed:', err.message);
      }

      return { handled: true, withdrawal: rolledBack, failed: true, reason };
    }

    // --- Success ---
    const params = result.ResultParameters?.ResultParameter || [];
    const receipt = params.find((p) => p.Key === 'TransactionReceipt')?.Value || null;

    const processed = await Withdrawal.markDisbursed(withdrawal.id, receipt);

    console.log(`✅ B2C instant withdrawal confirmed for withdrawal ${withdrawal.id}, receipt ${receipt}`);

    if (member) {
      try {
        await smsService.sendSMS(
          member.phone_number,
          smsService.templates.withdrawalInstantConfirmed(
            member.full_name,
            withdrawal.amount,
            receipt
          )
        );
      } catch (err) {
        console.error('Withdrawal success SMS to member failed:', err.message);
      }
    }

    // Staff FYI — informational, no action needed.
    try {
      await notificationService.notifyStaff({
        smsText: smsService.templates.staffWithdrawalInstantSuccess(
          member?.full_name || 'a member',
          withdrawal.amount,
          receipt
        ),
        emailContent: null,
      });
    } catch (err) {
      console.error('Withdrawal success staff notification failed:', err.message);
    }

    return { handled: true, withdrawal: processed, failed: false, receipt };
  }

  // Handle the B2C timeout callback. Treat as failure: roll back to the
  // pre-flight state so staff can act.
  static async handleB2CTimeout(payload) {
    const conversationId = payload?.Result?.ConversationID || payload?.ConversationID;
    if (!conversationId) {
      console.error('B2C timeout callback: no ConversationID', JSON.stringify(payload));
      return { handled: false, reason: 'Malformed timeout payload' };
    }

    const loan = await Loan.findByB2CConversationId(conversationId);
    if (loan) {
      return this._handleLoanB2CTimeout(loan);
    }

    const withdrawal = await Withdrawal.findByB2CConversationId(conversationId);
    if (withdrawal) {
      return this._handleWithdrawalB2CTimeout(withdrawal);
    }

    console.error(`B2C timeout callback: no loan or withdrawal for ConversationID ${conversationId}`);
    return { handled: false, reason: 'Unknown ConversationID' };
  }

  static async _handleLoanB2CTimeout(loan) {
    if (loan.status !== 'disbursing') {
      console.log(`B2C timeout callback: loan ${loan.id} already ${loan.status}; ignoring.`);
      return { handled: true, loan, alreadyResolved: true };
    }

    const rolledBack = await Loan.rollbackDisbursing(loan.id, 'Safaricom timeout');

    console.warn(`⚠️ B2C disbursement timed out for loan ${loan.id}. Rolled back to approved.`);

    // Staff notification — manual intervention may be needed.
    try {
      await notificationService.notifyStaff({
        smsText: smsService.templates.staffLoanDisbursementTimedOut(
          loan.member_name || 'a member',
          loan.reference
        ),
        emailContent: null,
      });
    } catch (err) {
      console.error('B2C timeout staff notification failed:', err.message);
    }

    return { handled: true, loan: rolledBack, failed: true, reason: 'Timeout' };
  }

  static async _handleWithdrawalB2CTimeout(withdrawal) {
    if (withdrawal.status !== 'disbursing') {
      console.log(`B2C timeout callback: withdrawal ${withdrawal.id} already ${withdrawal.status}; ignoring.`);
      return { handled: true, withdrawal, alreadyResolved: true };
    }

    const rolledBack = await Withdrawal.rollbackDisbursing(withdrawal.id, 'Safaricom timeout');

    console.warn(`⚠️ B2C instant withdrawal timed out for withdrawal ${withdrawal.id}. Rolled back to pending.`);

    const member = await Member.findById(withdrawal.member_id);
    if (member) {
      try {
        await smsService.sendSMS(
          member.phone_number,
          smsService.templates.withdrawalInstantFailed(member.full_name, withdrawal.amount)
        );
      } catch (err) {
        console.error('Withdrawal timeout SMS to member failed:', err.message);
      }
    }

    try {
      await notificationService.notifyStaff({
        smsText: smsService.templates.staffWithdrawalInstantTimedOut(
          member?.full_name || 'a member',
          withdrawal.amount
        ),
        emailContent: null,
      });
    } catch (err) {
      console.error('Withdrawal timeout staff notification failed:', err.message);
    }

    return { handled: true, withdrawal: rolledBack, failed: true, reason: 'Timeout' };
  }
}

// Exported on the class so the USSD controller and any future caller can
// reference the threshold without re-declaring it.
DisbursementService.INSTANT_WITHDRAWAL_LIMIT = INSTANT_WITHDRAWAL_LIMIT;

module.exports = DisbursementService;