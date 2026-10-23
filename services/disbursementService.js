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
const INSTANT_WITHDRAWAL_LIMIT = 5000;

class DisbursementService {
  // Initiate disbursement of an approved loan via B2C. Called by staff
  // clicking the "Disburse" button in the admin console.
  static async disburseLoan(loanId) {
    const loan = await Loan.findById(loanId);
    if (!loan) return { success: false, message: 'Loan not found.' };
    if (loan.status !== 'approved') {
      return { success: false, message: `Loan is currently '${loan.status}' — only approved loans can be disbursed via B2C.` };
    }

    const member = await Member.findById(loan.member_id);
    if (!member) return { success: false, message: 'Member not found.' };
    if (!member.phone_number) {
      return { success: false, message: 'Member has no phone number on file. Disburse manually and record the M-Pesa receipt.' };
    }

    if (!darajaB2CService.isConfigured()) {
      return { success: false, message: `B2C is not configured (missing: ${darajaB2CService.missingConfig().join(', ')}). Disburse manually.` };
    }

    let response;
    try {
      response = await darajaB2CService.b2cPayment({
        phoneNumber: member.phone_number,
        amount: loan.principal,
        remarks: `KEMRI SACCO Loan ${loan.reference || 'LN-' + String(loan.id).padStart(5, '0')}`,
      });
    } catch (err) {
      return { success: false, message: `Could not reach Safaricom: ${err.message}. Loan remains approved.` };
    }

    if (String(response.ResponseCode) !== '0') {
      return { success: false, message: `Safaricom rejected the disbursement: ${response.ResponseDescription || 'unknown reason'}. Loan remains approved.` };
    }

    const updated = await Loan.markDisbursing(loanId, response.ConversationID);

    if (!updated) {
      console.error(`⚠️ Race: loan ${loanId} was not in 'approved' when marking disbursing. B2C ConversationID ${response.ConversationID} is live.`);
      return { success: false, message: 'Loan was modified during disbursement. Check the Disbursement Log.' };
    }

    return { success: true, loan: updated, conversationId: response.ConversationID, message: 'Disbursement initiated.' };
  }

  // 2026-10-23: New method for M-Shwari Wallet withdrawals.
  // When a member withdraws from their SACCO Wallet, we trigger this to send
  // the money to their M-Pesa. Unlike a loan, there is no specific table row
  // for this payout in our system (the transaction is just logged in the wallet ledger).
  static async disburseWalletToMpesa(member, amount) {
    if (!darajaB2CService.isConfigured()) {
      throw new Error('B2C is not configured. Wallet withdrawals are temporarily unavailable.');
    }

    let response;
    try {
      response = await darajaB2CService.b2cPayment({
        phoneNumber: member.phone_number,
        amount: amount,
        remarks: `KEMRI SACCO Wallet Withdrawal`,
      });
    } catch (err) {
      throw new Error(`Could not reach Safaricom: ${err.message}`);
    }

    if (String(response.ResponseCode) !== '0') {
      throw new Error(`Safaricom rejected the withdrawal: ${response.ResponseDescription || 'unknown reason'}`);
    }

    return { success: true, conversationId: response.ConversationID };
  }

  // Initiate an instant withdrawal payout via B2C (DORMANT - legacy withdrawal feature).
  static async disburseWithdrawal(withdrawalId) {
    const withdrawal = await Withdrawal.findById(withdrawalId);
    if (!withdrawal) return { success: false, message: 'Withdrawal not found.' };
    if (withdrawal.status !== 'pending') {
      return { success: false, message: `Withdrawal is currently '${withdrawal.status}' — only pending withdrawals can be auto-paid.` };
    }

    const amount = Number(withdrawal.amount);
    if (amount > INSTANT_WITHDRAWAL_LIMIT) {
      return { success: false, message: `Amount KES ${amount.toLocaleString()} exceeds the instant-payout limit. This withdrawal requires staff processing.` };
    }

    const member = await Member.findById(withdrawal.member_id);
    if (!member) return { success: false, message: 'Member not found.' };
    if (!member.phone_number) {
      return { success: false, message: 'Member has no phone number on file. Withdrawal stays pending for staff processing.' };
    }

    if (!darajaB2CService.isConfigured()) {
      return { success: false, message: `B2C is not configured. Withdrawal stays pending.` };
    }

    let response;
    try {
      response = await darajaB2CService.b2cPayment({
        phoneNumber: member.phone_number,
        amount,
        remarks: `KEMRI SACCO Withdrawal #${withdrawal.id}`,
      });
    } catch (err) {
      return { success: false, message: `Could not reach Safaricom: ${err.message}. Withdrawal stays pending for staff processing.` };
    }

    if (String(response.ResponseCode) !== '0') {
      return { success: false, message: `Safaricom rejected the instant payout: ${response.ResponseDescription || 'unknown reason'}. Withdrawal stays pending.` };
    }

    const updated = await Withdrawal.markDisbursing(withdrawalId, response.ConversationID);

    if (!updated) {
      console.error(`⚠️ Race: withdrawal ${withdrawalId} was not in 'pending' when marking disbursing.`);
      return { success: false, message: 'Withdrawal was modified during payout. Check the Withdrawal Queue.' };
    }

    return { success: true, withdrawal: updated, conversationId: response.ConversationID, message: 'Instant withdrawal initiated.' };
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

    // Note: If a Wallet withdrawal comes back here, it won't match a loan or legacy withdrawal.
    // That is expected. We just log it and consider it handled.
    console.log(`B2C result callback: Wallet withdrawal for ConversationID ${result.ConversationID} processed.`);
    return { handled: true, reason: 'Wallet Withdrawal' };
  }

  static async _handleLoanB2CResult(loan, result) {
    if (loan.status !== 'disbursing') {
      console.log(`B2C result callback: loan ${loan.id} already ${loan.status}; ignoring duplicate.`);
      return { handled: true, loan, alreadyResolved: true };
    }

    const member = await Member.findById(loan.member_id);

    if (Number(result.ResultCode) !== 0) {
      const reason = result.ResultDesc || `ResultCode ${result.ResultCode}`;
      const rolledBack = await Loan.rollbackDisbursing(loan.id, reason);

      console.error(`B2C disbursement failed for loan ${loan.id}: ${reason}`);

      if (member) {
        try {
          await smsService.sendSMS(member.phone_number, smsService.templates.loanDisbursementFailed(member.full_name));
        } catch (err) {
          console.error('B2C failure SMS to member failed:', err.message);
        }
      }

      try {
        await notificationService.notifyStaff({
          smsText: smsService.templates.staffLoanDisbursementFailed(member?.full_name || 'a member', loan.reference, reason),
          emailContent: null,
        });
      } catch (err) {
        console.error('B2C failure staff notification failed:', err.message);
      }

      return { handled: true, loan: rolledBack, failed: true, reason };
    }

    const params = result.ResultParameters?.ResultParameter || [];
    const receipt = params.find((p) => p.Key === 'TransactionReceipt')?.Value || null;

    const disbursed = await Loan.markDisbursed(loan.id, receipt, 'b2c');

    console.log(`✅ B2C disbursement confirmed for loan ${loan.id}, receipt ${receipt}`);

    if (member) {
      const updatedMember = await Member.findById(loan.member_id);
      const amountOutstanding = updatedMember?.total_outstanding_balance || loan.total_repayment;

      const dueDateFormatted = disbursed.next_payment_due
        ? new Date(disbursed.next_payment_due).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        : '—';

      try {
        await smsService.sendSMS(
          member.phone_number,
          smsService.templates.loanDisbursed(member.full_name, loan.principal, amountOutstanding, dueDateFormatted)
        );
      } catch (err) {
        console.error('B2C success SMS to member failed:', err.message);
      }
    }

    try {
      await notificationService.notifyStaff({
        smsText: smsService.templates.staffLoanDisbursed(member?.full_name || 'a member', loan.reference, receipt),
        emailContent: null,
      });
    } catch (err) {
      console.error('B2C success staff notification failed:', err.message);
    }

    return { handled: true, loan: disbursed, failed: false, receipt };
  }

  static async _handleWithdrawalB2CResult(withdrawal, result) {
    if (withdrawal.status !== 'disbursing') {
      console.log(`B2C result callback: withdrawal ${withdrawal.id} already ${withdrawal.status}; ignoring duplicate.`);
      return { handled: true, withdrawal, alreadyResolved: true };
    }

    const member = await Member.findById(withdrawal.member_id);

    if (Number(result.ResultCode) !== 0) {
      const reason = result.ResultDesc || `ResultCode ${result.ResultCode}`;
      const rolledBack = await Withdrawal.rollbackDisbursing(withdrawal.id, reason);

      console.error(`B2C instant withdrawal failed for withdrawal ${withdrawal.id}: ${reason}`);

      if (member) {
        try {
          await smsService.sendSMS(member.phone_number, smsService.templates.withdrawalInstantFailed(member.full_name, withdrawal.amount));
        } catch (err) {
          console.error('Withdrawal failure SMS to member failed:', err.message);
        }
      }

      try {
        await notificationService.notifyStaff({
          smsText: smsService.templates.staffWithdrawalInstantFailed(member?.full_name || 'a member', withdrawal.amount),
          emailContent: null,
        });
      } catch (err) {
        console.error('Withdrawal failure staff notification failed:', err.message);
      }

      return { handled: true, withdrawal: rolledBack, failed: true, reason };
    }

    const params = result.ResultParameters?.ResultParameter || [];
    const receipt = params.find((p) => p.Key === 'TransactionReceipt')?.Value || null;

    const processed = await Withdrawal.markDisbursed(withdrawal.id, receipt);

    console.log(`✅ B2C instant withdrawal confirmed for withdrawal ${withdrawal.id}, receipt ${receipt}`);

    if (member) {
      try {
        await smsService.sendSMS(member.phone_number, smsService.templates.withdrawalInstantConfirmed(member.full_name, withdrawal.amount, receipt));
      } catch (err) {
        console.error('Withdrawal success SMS to member failed:', err.message);
      }
    }

    try {
      await notificationService.notifyStaff({
        smsText: smsService.templates.staffWithdrawalInstantSuccess(member?.full_name || 'a member', withdrawal.amount, receipt),
        emailContent: null,
      });
    } catch (err) {
      console.error('Withdrawal success staff notification failed:', err.message);
    }

    return { handled: true, withdrawal: processed, failed: false, receipt };
  }

  static async handleB2CTimeout(payload) {
    const conversationId = payload?.Result?.ConversationID || payload?.ConversationID;
    if (!conversationId) {
      console.error('B2C timeout callback: no ConversationID', JSON.stringify(payload));
      return { handled: false, reason: 'Malformed timeout payload' };
    }

    const loan = await Loan.findByB2CConversationId(conversationId);
    if (loan) return this._handleLoanB2CTimeout(loan);

    const withdrawal = await Withdrawal.findByB2CConversationId(conversationId);
    if (withdrawal) return this._handleWithdrawalB2CTimeout(withdrawal);

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

    try {
      await notificationService.notifyStaff({
        smsText: smsService.templates.staffLoanDisbursementTimedOut(loan.member_name || 'a member', loan.reference),
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
        await smsService.sendSMS(member.phone_number, smsService.templates.withdrawalInstantFailed(member.full_name, withdrawal.amount));
      } catch (err) {
        console.error('Withdrawal timeout SMS to member failed:', err.message);
      }
    }

    try {
      await notificationService.notifyStaff({
        smsText: smsService.templates.staffWithdrawalInstantTimedOut(member?.full_name || 'a member', withdrawal.amount),
        emailContent: null,
      });
    } catch (err) {
      console.error('Withdrawal timeout staff notification failed:', err.message);
    }

    return { handled: true, withdrawal: rolledBack, failed: true, reason: 'Timeout' };
  }
}

DisbursementService.INSTANT_WITHDRAWAL_LIMIT = INSTANT_WITHDRAWAL_LIMIT;

module.exports = DisbursementService;