const Loan = require('../models/Loan');
const Member = require('../models/Member');
const smsService = require('./smsService');
const notificationService = require('./notificationService');
const emailService = require('./emailService');
const darajaB2CService = require('./darajaB2CService');

// Orchestrates the B2C disbursement flow end to end. The split of
// responsibility with LoanService is:
//
//   LoanService        — decisions about loans (who can borrow, how much,
//                        when to approve/reject). Understands policy.
//   DisbursementService — moving money out. Understands the mechanics of
//                        Safaricom's B2C API and the async callback dance.
//
// Keeping them separate means the loan lifecycle logic can be reasoned
// about and unit-tested without mocking HTTP, and the disbursement flow
// can be retried/rewritten without touching policy.
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
  // Idempotency: Safaricom retries callbacks on non-200 responses. If the
  // callback arrives twice for the same ConversationID, the second call
  // sees the loan already past 'disbursing' and returns without
  // re-incrementing the balance or re-sending SMS. This is critical —
  // without it, a retried success callback would double the member's
  // outstanding balance.
  static async handleB2CResult(payload) {
    const result = payload?.Result;
    if (!result || !result.ConversationID) {
      console.error('B2C result callback: malformed payload', JSON.stringify(payload));
      return { handled: false, reason: 'Malformed payload' };
    }

    const loan = await Loan.findByB2CConversationId(result.ConversationID);
    if (!loan) {
      console.error(`B2C result callback: no loan for ConversationID ${result.ConversationID}`);
      return { handled: false, reason: 'Unknown ConversationID' };
    }

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

  // Handle the B2C timeout callback. Safaricom sends this when the request
  // could not complete within its processing window (usually because the
  // member's phone was off, the network was down, or Safaricom's own
  // systems were overloaded). Treat exactly like a failure: roll back to
  // 'approved' so staff can retry or disburse manually.
  //
  // Note: a timeout is not a "will never happen" — it's a "we tried and
  // can't confirm". The money *may* still arrive later in rare cases.
  // Staff should verify against the M-Pesa statement if the member
  // reports receiving funds they shouldn't have.
  static async handleB2CTimeout(payload) {
    // Timeout payload has a slightly different shape — no Result
    // wrapper, but the top-level ConversationID is still present.
    const conversationId = payload?.Result?.ConversationID || payload?.ConversationID;
    if (!conversationId) {
      console.error('B2C timeout callback: no ConversationID', JSON.stringify(payload));
      return { handled: false, reason: 'Malformed timeout payload' };
    }

    const loan = await Loan.findByB2CConversationId(conversationId);
    if (!loan) {
      console.error(`B2C timeout callback: no loan for ConversationID ${conversationId}`);
      return { handled: false, reason: 'Unknown ConversationID' };
    }

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
}

module.exports = DisbursementService;