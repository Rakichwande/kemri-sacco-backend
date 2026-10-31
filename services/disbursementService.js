const db = require('../config/database');
const Loan = require('../models/Loan');
const Withdrawal = require('../models/Withdrawal');
const Member = require('../models/Member');
const smsService = require('./smsService');
const notificationService = require('./notificationService');
const emailService = require('./emailService');
const darajaB2CService = require('./darajaB2CService');

class DisbursementService {
  
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

  static async disburseWalletToMpesa(member, amount, reference) {
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

    // 2026-10-31: Save the ConversationID to the wallet transaction so we can track failures.
    await db.query(
      `UPDATE wallet_transactions SET reference = $1 WHERE reference = $2`,
      [response.ConversationID, reference]
    );

    return { success: true, conversationId: response.ConversationID };
  }

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

    // 2026-10-31: Check if this is a Wallet Withdrawal
    const walletTxRes = await db.query(
      `SELECT * FROM wallet_transactions WHERE reference = $1 AND transaction_type = 'withdrawal'`,
      [result.ConversationID]
    );
    
    if (walletTxRes.rows.length > 0) {
      return this._handleWalletWithdrawalB2CResult(walletTxRes.rows[0], result);
    }

    console.error(`B2C result callback: Unknown ConversationID ${result.ConversationID}`);
    return { handled: false, reason: 'Unknown ConversationID' };
  }

  static async _handleWalletWithdrawalB2CResult(tx, result) {
    const member = await Member.findById(tx.member_id);
    
    if (Number(result.ResultCode) !== 0) {
      // IT FAILED: Refund the wallet
      const reason = result.ResultDesc || `ResultCode ${result.ResultCode}`;
      console.error(`B2C Wallet withdrawal failed for member ${tx.member_id}. Refunding KES ${Math.abs(tx.amount)}.`);
      
      try {
        await Member.creditWallet(tx.member_id, Math.abs(tx.amount), 'withdrawal_refund', 'B2C Failed');
        
        // Update the original failed transaction so it doesn't show as a pending withdrawal
        await db.query(`UPDATE wallet_transactions SET transaction_type = 'withdrawal_failed' WHERE id = $1`, [tx.id]);

        if (member) {
          await smsService.sendSMS(
            member.phone_number,
            `KEMRI SACCO: Hi ${member.full_name.split(' ')[0]}, your wallet withdrawal of KES ${Math.abs(tx.amount)} failed. The funds have been returned to your SACCO Wallet.`
          );
        }
      } catch (err) {
        console.error('Failed to refund wallet after async B2C failure:', err.message);
      }
      return { handled: true, failed: true, reason };
    }

    // SUCCESS
    console.log(`✅ B2C Wallet withdrawal confirmed for member ${tx.member_id}`);
    return { handled: true, failed: false };
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

    if (member) {
      const updatedMember = await Member.findById(loan.member_id);
      const amountOutstanding = updatedMember?.total_outstanding_balance || loan.total_repayment;

      const dueDateFormatted = disbursed.next_payment_due
        ? new Date(disbursed.next_payment_due).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        : '—';

      try {
        // 2026-10-31: Added loan.reference
        await smsService.sendSMS(
          member.phone_number,
          smsService.templates.loanDisbursed(member.full_name, loan.principal, amountOutstanding, dueDateFormatted, loan.reference)
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

    // Check for wallet timeout
    const walletTxRes = await db.query(
      `SELECT * FROM wallet_transactions WHERE reference = $1 AND transaction_type = 'withdrawal'`,
      [conversationId]
    );
    if (walletTxRes.rows.length > 0) {
       const tx = walletTxRes.rows[0];
       await Member.creditWallet(tx.member_id, Math.abs(tx.amount), 'withdrawal_refund', 'B2C Timeout');
       await db.query(`UPDATE wallet_transactions SET transaction_type = 'withdrawal_failed' WHERE id = $1`, [tx.id]);
       return { handled: true, failed: true, reason: 'Timeout' };
    }

    console.error(`B2C timeout callback: unknown ConversationID ${conversationId}`);
    return { handled: false, reason: 'Unknown ConversationID' };
  }

  static async _handleLoanB2CTimeout(loan) {
    if (loan.status !== 'disbursing') {
      return { handled: true, loan, alreadyResolved: true };
    }

    const rolledBack = await Loan.rollbackDisbursing(loan.id, 'Safaricom timeout');
    console.warn(`⚠️ B2C disbursement timed out for loan ${loan.id}. Rolled back to approved.`);

    const member = await Member.findById(loan.member_id);

    try {
      await notificationService.notifyStaff({
        smsText: smsService.templates.staffLoanDisbursementTimedOut(member?.full_name || 'a member', loan.reference),
        emailContent: null,
      });
    } catch (err) {
      console.error('B2C timeout staff notification failed:', err.message);
    }

    return { handled: true, loan: rolledBack, failed: true, reason: 'Timeout' };
  }
}

DisbursementService.INSTANT_WITHDRAWAL_LIMIT = 5000;

module.exports = DisbursementService;