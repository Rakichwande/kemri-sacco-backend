const db = require('../config/database');
const darajaService = require('./darajaService');
const smsService = require('./smsService');
const Payment = require('../models/Payment');
const Member = require('../models/Member');
const Loan = require('../models/Loan');
const Repayment = require('../models/Repayment');
const Withdrawal = require('../models/Withdrawal');
const notificationService = require('./notificationService');
const emailService = require('./emailService');

// 2026-11-02: Added savingsType parameter
async function initiatePayment({ memberId, phoneNumber, amount, loanId, savingsType = 'ordinary' }) {
  try {
    const isRepayment = !!loanId;
    const accountReference = isRepayment ? `LOAN-${loanId}` : `SACCO-${memberId}`;
    const description = isRepayment ? 'Loan repayment' : `${savingsType} Savings`;

    const stkResponse = await darajaService.stkPush({
      phoneNumber,
      amount,
      accountReference,
      description,
    });

    await Payment.create({
      member_id: memberId,
      amount,
      phone: phoneNumber,
      account_reference: accountReference,
      description,
      checkout_request_id: stkResponse.CheckoutRequestID,
      loan_id: loanId || null,
      savings_type: savingsType,
    });

    return stkResponse;
  } catch (error) {
    console.error('❌ initiatePayment error:', error.response?.data || error.message);
    throw error;
  }
}

// 2026-10-09: Withdrawal feature retired per board instruction. This
// function is now dormant - no caller invokes it. Retained so that if the
// board reinstates withdrawals, the orchestration logic is recoverable
// without rewriting from scratch.
async function requestWithdrawal({ memberId, amount }) {
  const balance = await Payment.getMemberBalance(memberId);
  if (amount > balance) {
    return { success: false, message: 'Insufficient balance for this withdrawal.' };
  }

  const existing = await Withdrawal.getPendingForMember(memberId);
  if (existing) {
    return {
      success: false,
      message: `You already have a pending withdrawal of KES ${Number(existing.amount).toLocaleString()}.`,
    };
  }

  const withdrawal = await Withdrawal.create({ member_id: memberId, amount });
  if (!withdrawal) {
    return { success: false, message: 'You already have a pending withdrawal request.' };
  }

  return { success: true, withdrawal };
}

async function notifyRepaymentSuccess(member, payment, updatedLoan, mpesaReceipt) {
  try {
    await smsService.sendSMS(
      member.phone_number,
      smsService.templates.loanRepaymentConfirmed(
        member.full_name,
        payment.amount,
        updatedLoan.outstanding_balance,
        mpesaReceipt,
        updatedLoan.reference
      )
    );
    await notificationService.notifyStaff({
      smsText: smsService.templates.staffRepayment(member.full_name, payment.amount, updatedLoan.reference),
      emailContent: emailService.staffTemplates.repayment(member.full_name, payment.amount, updatedLoan.reference),
    });
  } catch (notifyErr) {
    console.error('Repayment notification failed (repayment itself still applied):', notifyErr.message);
  }
}

async function notifyDepositSuccess(member, payment, mpesaReceipt) {
  try {
    const savingsType = payment.savings_type || 'ordinary';
    let smsText;

    // 2026-11-02: Select the correct SMS template and calculate unlock date
    if (savingsType === 'jipange') {
      const unlockDate = new Date();
      unlockDate.setMonth(unlockDate.getMonth() + 6);
      const formattedDate = unlockDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      
      smsText = smsService.templates.depositJipange(
        member.full_name, payment.amount, mpesaReceipt, formattedDate
      );
    } else if (savingsType === 'holiday') {
      const unlockDate = new Date();
      unlockDate.setMonth(unlockDate.getMonth() + 6);
      const formattedDate = unlockDate.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      
      smsText = smsService.templates.depositHoliday(
        member.full_name, payment.amount, mpesaReceipt, formattedDate
      );
    } else {
      smsText = smsService.templates.depositOrdinary(
        member.full_name, payment.amount, mpesaReceipt
      );
    }

    await smsService.sendSMS(member.phone_number, smsText);
    
    await notificationService.notifyStaff({
      smsText: smsService.templates.staffDeposit(member.full_name, payment.amount, savingsType),
      emailContent: emailService.staffTemplates.deposit(member.full_name, payment.amount),
    });
  } catch (notifyErr) {
    console.error('Deposit notification failed (deposit itself still recorded):', notifyErr.message);
  }
}

async function notifyPaymentFailed(member, payment, isRepayment) {
  try {
    const message = isRepayment
      ? `KEMRI SACCO: Hi ${member.full_name.split(' ')[0]}, your repayment for Loan ID ${payment.loan_id} failed. Please try again or visit our office.`
      : smsService.templates.paymentFailed(member.full_name);
    await smsService.sendSMS(member.phone_number, message);
  } catch (notifyErr) {
    console.error('Payment-failed notification failed:', notifyErr.message);
  }
}

async function handleCallback(callbackBody) {
  console.log('Daraja callback received:', JSON.stringify(callbackBody));

  const stkCallback = callbackBody.Body.stkCallback;
  const checkoutRequestId = stkCallback.CheckoutRequestID;
  const resultCode = stkCallback.ResultCode;

  const payment = await Payment.findByCheckoutId(checkoutRequestId);
  if (!payment) {
    console.error('Webhook received for unknown checkout ID:', checkoutRequestId);
    return;
  }

  const claimed = await Payment.claimForProcessing(checkoutRequestId);
  if (!claimed) {
    console.log(`Duplicate/concurrent webhook for checkout ${checkoutRequestId} - already claimed, ignoring.`);
    return;
  }

  const member = await Member.findById(payment.member_id);
  const isRepayment = !!payment.loan_id;

  try {
    if (resultCode === 0) {
      const items = stkCallback.CallbackMetadata.Item;
      const mpesaReceipt = items.find((i) => i.Name === 'MpesaReceiptNumber')?.Value;

      if (isRepayment) {
        // --- REPAYMENT SUCCESS ---
        const client = await db.pool.connect();
        let updatedLoan;
        try {
          await client.query('BEGIN');
          await Payment.updateStatus(checkoutRequestId, 'completed', mpesaReceipt, client);
          updatedLoan = await Loan.applyRepayment(payment.loan_id, payment.amount, client);
          if (!updatedLoan) {
            throw new Error(`Loan repayment failed: loan not found for ID ${payment.loan_id}`);
          }
          await Repayment.create(
            {
              loan_id: payment.loan_id,
              member_id: payment.member_id,
              amount: payment.amount,
              channel: 'mpesa',
              mpesa_receipt: mpesaReceipt,
              principal_paid: updatedLoan.principal_paid_this,
              interest_paid: updatedLoan.interest_paid_this,
            },
            client
          );
          await client.query('COMMIT');
        } catch (txErr) {
          await client.query('ROLLBACK');
          throw txErr;
        } finally {
          client.release();
        }

        if (member) {
          await notifyRepaymentSuccess(member, payment, updatedLoan, mpesaReceipt);
        }
      } else {
        // --- DEPOSIT SUCCESS ---
        await Payment.updateStatus(checkoutRequestId, 'completed', mpesaReceipt);

        if (member) {
          // 2026-11-02: Set 6-month/12-month dates on first deposit
          if (payment.savings_type === 'jipange' && !member.jipange_unlock_date) {
            await Member.setJipangeDates(member.id);
          }
          if (payment.savings_type === 'holiday' && !member.holiday_unlock_date) {
            await Member.setHolidayDates(member.id);
          }
          
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
    console.error(`handleCallback processing failed for checkout ${checkoutRequestId}:`, err.message);
    try {
      await Payment.revertToPending(checkoutRequestId);
    } catch (revertErr) {
      console.error(`Failed to revert payment ${checkoutRequestId} to pending after processing error:`, revertErr.message);
    }
    throw err;
  }
}

module.exports = { initiatePayment, handleCallback, requestWithdrawal };