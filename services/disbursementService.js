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
// Keeping policy separate from mechanics means the loan lifecycle logic
// can be reasoned about without mocking HTTP, and the B2C callback
// routing can change without touching policy.
//
// The B2C callback handler resolves an incoming ConversationID against
// BOTH tables. A ConversationID belongs to exactly one of them — loans
// and withdrawals each write their own to the unique index — so the
// lookup is deterministic. Loookup order is loans first (the older use
// case, slightly more common in practice) then withdrawals.
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
  //
  // The 5-30 second window between success and callback is normal and
  // expected. During it, the frontend shows "Disbursing...". A separate
  // result/timeout callback resolves the loan.
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
      // ALREADY been sent to Safaricom (that's why we're here) — we can't
      // un-send it. Log loudly for reconciliation; the callback will
      // resolve the loan if the money moves. Return an error so the
      // second staff member knows the request didn't take effect from
      // their perspective.
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
  // future caller (web portal, admin action) tries to bypass the
  // threshold, this method refuses rather than silently paying out a
  // large amount without review.
  //
  // On failure at ANY stage, the withdrawal stays (or returns) to
  // 'pending' so it appears in the staff queue. The member never loses
  // their request — worst case, staff process it a few minutes later.
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

    // 2. Threshold check — see the comment above. This method is the
    //    authoritative gate; the USSD check just avoids a pointless round
    //    trip for above-threshold requests.
    const amount = Number(withdrawal.amount);
    if (amount > INSTANT_WITHDRAWAL_LIMIT) {
      return {
        success: false,
        message: `Amount KES ${amount.toLocaleString()} exceeds the instant-payout limit of KES ${INSTANT_WITHDRAWAL_LIMIT.toLocaleString()}. This withdrawal requires staff processing.`,
      };
    }

    // 3. Member phone — findById in Withdrawal already joins the member,
    //    but we re-fetch for a clean phone_number value (the model returns
    //    it as a joined column, not on a member object). Keeping the fetch
    //    explicit makes the dependency obvious.
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
      // Transport failure — request never reached Safaricom. Withdrawal
      // stays pending, will appear in the staff queue.
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
      // Race: another instant attempt or staff action changed the state
      // between our read and our write. Same treatment as the loan race.
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

  // Handle the B2C result callback from Safaricom. Called by the webhook
  // route with the raw POST body. Payload shape (from Safaricom docs):
  //
  //   {
  //     Result: {
  //       ResultType: 0,
  //       ResultCode: 0,          // 0 = success, anything else = failure
  //       ResultDesc: '...',
  //       OriginatorConversationID: '...',
  //       ConversationID: 'AG_...',
  //       TransactionID: 'SJJ...',
  //       ResultParameters: { ResultParameter: [ { Key, Value }, ... ] },
  //       ReferenceData: { ... }
  //     }
  //   }
  //
  // Routing: the ConversationID is unique across BOTH the loans and
  // withdrawals tables (each has its own partial unique index). Check
  // loans first, then withdrawals. Whichever matches owns the callback.
  //
  // Idempotency: Safaricom retries callbacks on non-200 responses. If the
  // callback arrives twice for the same ConversationID, the second call
  // sees the record already past its in-flight state and returns without
  // re-applying side effects. Critical for loans (double balance
  // increment) and for withdrawals (double SMS + double M-Pesa receipt
  // recording).
  static async handleB2CResult(payload) {
    const result = payload?.Result;
    if (!result || !result.ConversationID) {
      console.error('B2C result callback: malformed payload', JSON.stringify(payload));
      return { handled: false, reason: 'Malformed payload' };
    }

    // Route: loan first, then withdrawal. A ConversationID belongs to
    // exactly one of them.
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

  // Loan branch of the B2C result callback. Extracted so the routing at
  // the top of handleB2CResult() stays readable.
  static async _handleLoanB2CResult(loan, result) {
    // Already resolved — nothing to do. Return handled so the webhook
    // responds 200 and Safaricom stops retrying.
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

      // Notify the member (their loan was approved but the disbursement
      // hit a snag — they need to know not to expect the money today).
      if (member) {
        try {
          await smsService.sendSMS(
            member.phone_number,
            `KEMRI SACCO: We could not complete your loan disbursement right now. Our team will contact you shortly.`
          );
        } catch (err) {
          console.error('B2C failure SMS to member failed:', err.message);
        }
      }

      // Notify staff — this needs human action.
      try {
        await notificationService.notifyStaff({
          smsText: `KEMRI SACCO Admin: B2C disbursement FAILED for loan ${loan.reference}. ${reason}. Manual disbursement may be required.`,
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

    // Notify the member
    if (member) {
      try {
        await smsService.sendSMS(
          member.phone_number,
          smsService.templates.loanDisbursed(
            member.full_name,
            loan.principal,
            // The member's running total outstanding *after* this
            // disbursement — read fresh from the DB rather than guessing.
            (await Member.findById(loan.member_id))?.total_outstanding_balance || loan.total_repayment,
            new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
          )
        );
      } catch (err) {
        console.error('B2C success SMS to member failed:', err.message);
      }
    }

    // Notify staff (for their records)
    try {
      await notificationService.notifyStaff({
        smsText: `KEMRI SACCO Admin: Loan ${loan.reference} disbursed via B2C. Receipt ${receipt || 'N/A'}.`,
        emailContent: null, // no template for this; SMS is enough
      });
    } catch (err) {
      console.error('B2C success staff notification failed:', err.message);
    }

    return { handled: true, loan: disbursed, failed: false, receipt };
  }

  // Withdrawal branch of the B2C result callback.
  //
  // Success: withdrawal moves disbursing → processed, member SMS with the
  // receipt, no member balance update (withdrawals don't touch the loans
  // balance field, and the savings balance is computed from the payments
  // table rather than stored).
  //
  // Failure: withdrawal rolls back disbursing → pending and appears in
  // the staff queue. Staff notification fires so they know a member is
  // waiting. Member SMS is informational only — they'll get a second
  // message once staff actually pay.
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

      // Member SMS — gentle, apologetic, sets expectations correctly.
      // They get a second SMS once staff complete the payout.
      if (member) {
        try {
          await smsService.sendSMS(
            member.phone_number,
            `KEMRI SACCO: We could not complete your instant withdrawal right now. Your request is queued and our team will process it shortly.`
          );
        } catch (err) {
          console.error('Withdrawal failure SMS to member failed:', err.message);
        }
      }

      // Staff notification — the withdrawal is now in their queue and
      // needs their action.
      try {
        await notificationService.notifyStaff({
          smsText: `KEMRI SACCO Admin: Instant withdrawal FAILED for ${member?.full_name || 'a member'} (KES ${Number(withdrawal.amount).toLocaleString()}). Queued for manual processing.`,
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

    // Notify the member
    if (member) {
      try {
        await smsService.sendSMS(
          member.phone_number,
          `KEMRI SACCO: KES ${Number(withdrawal.amount).toLocaleString()} has been sent to your M-Pesa. Receipt: ${receipt || 'N/A'}. Thank you.`
        );
      } catch (err) {
        console.error('Withdrawal success SMS to member failed:', err.message);
      }
    }

    // Staff get a brief FYI — not an action item, but useful for the
    // day's record-keeping.
    try {
      await notificationService.notifyStaff({
        smsText: `KEMRI SACCO Admin: Withdrawal of KES ${Number(withdrawal.amount).toLocaleString()} paid instantly to ${member?.full_name || 'a member'}. Receipt ${receipt || 'N/A'}.`,
        emailContent: null,
      });
    } catch (err) {
      console.error('Withdrawal success staff notification failed:', err.message);
    }

    return { handled: true, withdrawal: processed, failed: false, receipt };
  }

  // Handle the B2C timeout callback. Safaricom sends this when the request
  // could not complete within its processing window (usually because the
  // member's phone was off, the network was down, or Safaricom's own
  // systems were overloaded). Treat exactly like a failure: roll back to
  // the pre-in-flight state so staff can act.
  //
  // Note: a timeout is not a "will never happen" — it's a "we tried and
  // can't confirm". The money *may* still arrive later in rare cases.
  // Staff should verify against the M-Pesa statement if a member reports
  // receiving funds they shouldn't have.
  static async handleB2CTimeout(payload) {
    // Timeout payload has a slightly different shape — no Result
    // wrapper, but the top-level ConversationID is still present.
    const conversationId = payload?.Result?.ConversationID || payload?.ConversationID;
    if (!conversationId) {
      console.error('B2C timeout callback: no ConversationID', JSON.stringify(payload));
      return { handled: false, reason: 'Malformed timeout payload' };
    }

    // Route: loan first, then withdrawal.
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

    // Notify staff — manual intervention may be needed.
    try {
      await notificationService.notifyStaff({
        smsText: `KEMRI SACCO Admin: B2C disbursement TIMED OUT for loan ${loan.reference}. Verify on M-Pesa and disburse manually if needed.`,
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
          `KEMRI SACCO: Your instant withdrawal did not complete in time. Your request is queued and our team will process it shortly.`
        );
      } catch (err) {
        console.error('Withdrawal timeout SMS to member failed:', err.message);
      }
    }

    try {
      await notificationService.notifyStaff({
        smsText: `KEMRI SACCO Admin: Instant withdrawal TIMED OUT for ${member?.full_name || 'a member'} (KES ${Number(withdrawal.amount).toLocaleString()}). Queued for manual processing.`,
        emailContent: null,
      });
    } catch (err) {
      console.error('Withdrawal timeout staff notification failed:', err.message);
    }

    return { handled: true, withdrawal: rolledBack, failed: true, reason: 'Timeout' };
  }
}

// Exported on the class so the USSD controller and any future caller can
// reference the threshold without re-declaring it. Changing the number in
// one place updates every check.
DisbursementService.INSTANT_WITHDRAWAL_LIMIT = INSTANT_WITHDRAWAL_LIMIT;

module.exports = DisbursementService;