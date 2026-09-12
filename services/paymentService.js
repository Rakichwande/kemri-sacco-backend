const darajaService = require('./darajaService');
const smsService = require('./smsService');
const Payment = require('../models/Payment');
const Member = require('../models/Member');
const Loan = require('../models/Loan');
const Repayment = require('../models/Repayment');

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

    // Save payment record with optional loan_id
    await Payment.create({
      member_id: memberId,
      amount,
      phone: phoneNumber,
      account_reference: accountReference,
      description,
      checkout_request_id: stkResponse.CheckoutRequestID,
      loan_id: loanId || null, // <-- ADD THIS FIELD
    });

    return stkResponse;
  } catch (error) {
    console.error('❌ initiatePayment error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Handle Daraja webhook callback (both deposits and repayments)
 */
async function handleCallback(callbackBody) {
  const stkCallback = callbackBody.Body.stkCallback;
  const checkoutRequestId = stkCallback.CheckoutRequestID;
  const resultCode = stkCallback.ResultCode; // 0 = success

  const payment = await Payment.findByCheckoutId(checkoutRequestId);
  if (!payment) {
    console.error('Webhook received for unknown checkout ID:', checkoutRequestId);
    return;
  }

  const member = await Member.findById(payment.member_id);
  const isRepayment = !!payment.loan_id; // Check if this payment is for a loan repayment

  if (resultCode === 0) {
    // --- SUCCESSFUL PAYMENT ---
    const items = stkCallback.CallbackMetadata.Item;
    const mpesaReceipt = items.find((i) => i.Name === 'MpesaReceiptNumber')?.Value;

    await Payment.updateStatus(checkoutRequestId, 'completed', mpesaReceipt);

    if (isRepayment) {
      // --- REPAYMENT SUCCESS ---
      // Update the loan's outstanding balance
      const updatedLoan = await Loan.applyRepayment(payment.loan_id, payment.amount);
      if (!updatedLoan) {
        console.error('Loan repayment failed: loan not found for ID', payment.loan_id);
        return;
      }

      // One row per confirmed repayment transaction - backs Repayment History
      // and the dashboard chart. Never blocks the repayment itself if it fails.
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

      // Send repayment confirmation SMS
      if (member) {
        await smsService.sendSMS(
          member.phone_number,
          smsService.templates.loanRepaymentConfirmed(
            member.full_name,
            payment.amount,
            updatedLoan.outstanding_balance,
            mpesaReceipt
          )
        );
      }
    } else {
      // --- DEPOSIT SUCCESS ---
      if (member) {
        await smsService.sendSMS(
          member.phone_number,
          smsService.templates.paymentConfirmed(
            member.full_name,
            payment.amount,
            payment.account_reference,
            mpesaReceipt
          )
        );
      }
    }
  } else {
    // --- PAYMENT FAILED ---
    await Payment.updateStatus(checkoutRequestId, 'failed');

    if (member) {
      let message;
      if (isRepayment) {
        message = `KEMRI SACCO: Your loan repayment of KES ${payment.amount} failed. Please try again or visit our office.`;
      } else {
        message = smsService.templates.paymentFailed(member.full_name);
      }
      await smsService.sendSMS(member.phone_number, message);
    }
  }
}

module.exports = { initiatePayment, handleCallback };