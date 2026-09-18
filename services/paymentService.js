const db = require('../config/database');
const darajaService = require('./darajaService');
const smsService = require('./smsService');
const Payment = require('../models/Payment');
const Member = require('../models/Member');
const Loan = require('../models/Loan');
const Repayment = require('../models/Repayment');
const notificationService = require('./notificationService');
const emailService = require('./emailService');

/**
 * Initiate a payment (deposit or loan repayment)
 * @param {Object} params
 * @param {number} params.memberId
 * @param {string} params.phoneNumber
 * @param {number} params.amount
 * @param {number} [params.loanId] - If provided, this is a loan repayment
 */
async function initiatePayment({ memberId, phoneNumber, amount, loanId }) {
  try {
    // Determine transaction type and description
    const isRepayment = !!loanId;
    const accountReference = isRepayment ? `LOAN-${loanId}` : `SACCO-${memberId}`;
    const description = isRepayment ? 'Loan repayment' : 'Holiday Savings Scheme contribution';

    const stkResponse = await darajaService.stkPush({
      phoneNumber,
      amount,
      accountReference,
      description,
    });

    // Save payment record, tagging it with loan_id when this is a repayment
    await Payment.create({
      member_id: memberId,
      amount,
      phone: phoneNumber,
      account_reference: accountReference,
      description,
      checkout_request_id: stkResponse.CheckoutRequestID,
      loan_id: loanId || null,
    });

    return stkResponse;
  } catch (error) {
    console.error('❌ initiatePayment error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Send the member/staff notifications for a completed transaction.
 * Isolated in its own try/catch so an SMS/email outage can never look like
 * a genuine processing failure to the caller - the financial state has
 * already been committed by the time this runs, and a notification hiccup
 * shouldn't trigger a webhook retry or an "unclaim" of an otherwise
 * successfully processed payment.
 */
async function notifyRepaymentSuccess(member, payment, updatedLoan, mpesaReceipt) {
  try {
    await smsService.sendSMS(
      member.phone_number,
      smsService.templates.loanRepaymentConfirmed(
        member.full_name,
        payment.amount,
        updatedLoan.outstanding_balance,
        mpesaReceipt
      )
    );
    await notificationService.notifyStaff({
      smsText: smsService.templates.staffRepayment(member.full_name, payment.amount),
      emailContent: emailService.staffTemplates.repayment(member.full_name, payment.amount),
    });
  } catch (notifyErr) {
    console.error('Repayment notification failed (repayment itself still applied):', notifyErr.message);
  }
}

async function notifyDepositSuccess(member, payment, mpesaReceipt) {
  try {
    await smsService.sendSMS(
      member.phone_number,
      smsService.templates.paymentConfirmed(
        member.full_name,
        payment.amount,
        payment.account_reference,
        mpesaReceipt
      )
    );
    await notificationService.notifyStaff({
      smsText: smsService.templates.staffDeposit(member.full_name, payment.amount),
      emailContent: emailService.staffTemplates.deposit(member.full_name, payment.amount),
    });
  } catch (notifyErr) {
    console.error('Deposit notification failed (deposit itself still recorded):', notifyErr.message);
  }
}

async function notifyPaymentFailed(member, payment, isRepayment) {
  try {
    const message = isRepayment
      ? `KEMRI SACCO: Your loan repayment of KES ${payment.amount} failed. Please try again or visit our office.`
      : smsService.templates.paymentFailed(member.full_name);
    await smsService.sendSMS(member.phone_number, message);
  } catch (notifyErr) {
    console.error('Payment-failed notification failed:', notifyErr.message);
  }
}

/**
 * Handle Daraja webhook callback (both deposits and repayments)
 */
async function handleCallback(callbackBody) {
  // Log the raw payload before anything else can fail, so a genuine
  // processing error downstream never means the original callback is gone
  // without a trace - this line survives regardless of what happens next.
  console.log('Daraja callback received:', JSON.stringify(callbackBody));

  const stkCallback = callbackBody.Body.stkCallback;
  const checkoutRequestId = stkCallback.CheckoutRequestID;
  const resultCode = stkCallback.ResultCode; // 0 = success

  const payment = await Payment.findByCheckoutId(checkoutRequestId);
  if (!payment) {
    console.error('Webhook received for unknown checkout ID:', checkoutRequestId);
    return; // Nothing to retry - malformed/unrecognized, not a processing failure.
  }

  // Daraja is documented to sometimes resend the same callback (network
  // retries on Safaricom's end). This atomically claims the payment for
  // processing - if it's already been claimed (by this exact request
  // arriving twice, or two near-simultaneous deliveries), this returns
  // nothing and we skip entirely rather than double-applying the payment.
  const claimed = await Payment.claimForProcessing(checkoutRequestId);
  if (!claimed) {
    console.log(`Duplicate/concurrent webhook for checkout ${checkoutRequestId} - already claimed, ignoring.`);
    return;
  }

  const member = await Member.findById(payment.member_id);
  const isRepayment = !!payment.loan_id; // Check if this payment is for a loan repayment

  try {
    if (resultCode === 0) {
      // --- SUCCESSFUL PAYMENT ---
      const items = stkCallback.CallbackMetadata.Item;
      const mpesaReceipt = items.find((i) => i.Name === 'MpesaReceiptNumber')?.Value;

      if (isRepayment) {
        // --- REPAYMENT SUCCESS ---
        // Payment status and the loan's outstanding balance are committed
        // together in one transaction. Previously these were two separate
        // writes; a crash between them could leave a payment marked
        // 'completed' with the loan balance never actually reduced - real
        // money "received" but never credited. Now either both land or
        // neither does.
        const client = await db.pool.connect();
        let updatedLoan;
        try {
          await client.query('BEGIN');
          await Payment.updateStatus(checkoutRequestId, 'completed', mpesaReceipt, client);
          updatedLoan = await Loan.applyRepayment(payment.loan_id, payment.amount, client);
          if (!updatedLoan) {
            // loan_id pointed at a loan that doesn't exist - shouldn't
            // happen given the FK, but guard anyway. Rolling back means
            // the payment stays 'processing' momentarily, then gets
            // reverted to 'pending' by the catch block below for a retry
            // (which won't help here since the loan genuinely doesn't
            // exist, but keeps behavior consistent and loud rather than
            // silently marking a payment completed with nothing applied).
            throw new Error(`Loan repayment failed: loan not found for ID ${payment.loan_id}`);
          }
          await client.query('COMMIT');
        } catch (txErr) {
          await client.query('ROLLBACK');
          throw txErr;
        } finally {
          client.release();
        }

        // One row per confirmed repayment transaction - backs Repayment
        // History and the dashboard chart. Never blocks the repayment
        // itself if it fails; this is audit/reporting data, not the
        // financial state itself.
        try {
          await Repayment.create({
            loan_id: payment.loan_id,
            member_id: payment.member_id,
            amount: payment.amount,
            channel: 'mpesa',
            mpesa_receipt: mpesaReceipt,
          });
        } catch (repaymentLogErr) {
          console.error('Repayment log write failed (repayment itself still applied):', repaymentLogErr.message);
        }

        if (member) {
          await notifyRepaymentSuccess(member, payment, updatedLoan, mpesaReceipt);
        }
      } else {
        // --- DEPOSIT SUCCESS ---
        await Payment.updateStatus(checkoutRequestId, 'completed', mpesaReceipt);

        if (member) {
          await notifyDepositSuccess(member, payment, mpesaReceipt);
        }
      }
    } else {
      // --- PAYMENT FAILED ---
      await Payment.updateStatus(checkoutRequestId, 'failed');

      if (member) {
        await notifyPaymentFailed(member, payment, isRepayment);
      }
    }
  } catch (err) {
    // A genuine processing failure reached here - a DB error, the
    // loan-not-found guard above, etc. Notification failures are isolated
    // in notifyRepaymentSuccess/notifyDepositSuccess/notifyPaymentFailed
    // above and never propagate to this point, so nothing here is a false
    // alarm from an SMS outage.
    //
    // Revert the claim so a Safaricom retry of this same callback can
    // actually reprocess it. Without this, the payment would stay stuck at
    // 'processing' forever - claimForProcessing only claims 'pending'
    // payments, so a retry would silently hit the "already claimed,
    // ignoring" branch above and the callback would be lost for good.
    console.error(`handleCallback processing failed for checkout ${checkoutRequestId}:`, err.message);
    try {
      await Payment.revertToPending(checkoutRequestId);
    } catch (revertErr) {
      console.error(`Failed to revert payment ${checkoutRequestId} to pending after processing error:`, revertErr.message);
    }
    throw err; // propagate so the webhook route returns 5xx and Safaricom retries
  }
}

module.exports = { initiatePayment, handleCallback };