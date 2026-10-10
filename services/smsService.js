require('dotenv').config();
const axios = require('axios');

// SMS TRANSPORT: KEMRI SACCO's own provider (Infinity Tech, powered by Tiara).
// (unchanged header comment)

const SMS_API_URL = process.env.SMS_PROVIDER_API_URL;
const SMS_API_KEY = process.env.SMS_PROVIDER_API_KEY;
const SMS_SENDER_ID = process.env.SMS_PROVIDER_SENDER_ID;

function isConfigured() {
  return !!(SMS_API_URL && SMS_API_KEY && SMS_SENDER_ID);
}

function normalizePhone(phoneNumber) {
  if (!phoneNumber) return null;
  let cleaned = String(phoneNumber).replace(/\D/g, '');

  if (cleaned.startsWith('0')) {
    cleaned = '254' + cleaned.slice(1);
  } else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
    cleaned = '254' + cleaned;
  }

  if (cleaned.length !== 12) {
    console.warn('Phone number after normalization has length', cleaned.length, 'expected 12:', cleaned);
    return null;
  }

  return cleaned;
}

const formatKES = (amount) => `KES ${Number(amount).toLocaleString()}`;

function firstName(fullName) {
  if (!fullName) return '';
  return String(fullName).trim().split(/\s+/)[0];
}

const templates = {
  // ─── MEMBER-FACING — REGISTRATION ───
  applicationReceived: (name) =>
    `Welcome to KEMRI SACCO, ${firstName(name)}. Your account is active. Dial *483*4444# to save, check balance, or apply for a loan.`,

  // ─── MEMBER-FACING — DEPOSITS ───
  paymentConfirmed: (name, amount, reference, receipt) =>
    `KEMRI SACCO: Hi ${firstName(name)}, we received your deposit of ${formatKES(amount)}. Receipt: ${receipt}. Your savings balance is updated. Ref: ${reference}.`,

  paymentFailed: (name) =>
    `KEMRI SACCO: Hi ${firstName(name)}, your deposit did not go through. Nothing was deducted. Please try again or visit our office.`,

  // ─── MEMBER-FACING — LOANS ───
  loanApplicationReceived: (name, principal, ref) =>
    `KEMRI SACCO: Hi ${firstName(name)}, we received your loan application for a principal of ${formatKES(principal)}. Ref: ${ref}. We'll review it and SMS you the decision shortly.`,

    // Args: (name, principal, interest, totalPayable)
  //
  // 2026-10-10: wording updated. Previously ended with "Funds will be sent
  // to your M-Pesa shortly" — a passive phrasing that reads as automatic.
  // In reality, a regular member's approved loan sits in 'approved' until
  // staff click Disburse. Board/staff loans skip this SMS entirely now
  // (see loanService.apply), so this template is only ever sent to regular
  // members going through manual review. "Our team will send" reflects
  // that a human action is pending.
  loanApproved: (name, principal, interest, totalPayable) =>
    `KEMRI SACCO: Hi ${firstName(name)}, your loan is approved. Principal: ${formatKES(principal)}. Interest: ${formatKES(interest)}. Total amount payable: ${formatKES(totalPayable)}. Our team will send the funds to your M-Pesa shortly.`,

  // 2026-10-10: Rewritten per board feedback. The previous wording was
  // ambiguous about which date the member was looking at — and the CALLER
  // was passing today's date instead of next_payment_due, so every loan
  // showed its disbursement date as the due date. Both fixed in the same
  // commit. See disbursementService._handleLoanB2CResult for the caller.
  //
  // 194 chars at typical values = 2 SMS segments. Same cost as the manual
  // version the board approved. Do NOT add asterisks expecting bold —
  // SMS is plain text and they render literally.
  //
  // Args: (name, principal, totalPayable, dueDate)
  //   totalPayable = member's running amount outstanding AFTER this
  //                  disbursement (from members.total_outstanding_balance)
  //   dueDate      = disbursement date + 1 month, formatted DD Mon YYYY
  loanDisbursed: (name, principal, totalPayable, dueDate) =>
    `KEMRI SACCO: Hi ${firstName(name)}, ${formatKES(principal)} has been disbursed to your M-Pesa. Total amount payable: ${formatKES(totalPayable)}, due ${dueDate}. Please settle on or before the due date. Thank you for choosing KEMRI SACCO.`,

  loanRepaymentConfirmed: (name, amountPaid, amountOutstanding, receipt) =>
    `KEMRI SACCO: Hi ${firstName(name)}, we received your payment of ${formatKES(amountPaid)}. Amount outstanding: ${formatKES(amountOutstanding)}. Receipt: ${receipt}.`,

  loanRejected: (name, reason) =>
    `KEMRI SACCO: Hi ${firstName(name)}, your loan application was not approved.${reason ? ' Reason: ' + reason + '.' : ''} Contact our office for details.`,

  loanDisbursementFailed: (name) =>
    `KEMRI SACCO: Hi ${firstName(name)}, we could not complete your loan disbursement right now. Our team will contact you shortly.`,

  // ─── MEMBER-FACING — WITHDRAWALS (dormant — feature retired) ───
  withdrawalRequested: (name, amount) =>
    `KEMRI SACCO: Hi ${firstName(name)}, we received your withdrawal request of ${formatKES(amount)}. Our team will process it and SMS you once the funds are sent.`,

  withdrawalInstantConfirmed: (name, amount, receipt) =>
    `KEMRI SACCO: Hi ${firstName(name)}, ${formatKES(amount)} has been sent to your M-Pesa. Receipt: ${receipt}. Thank you.`,

  withdrawalInstantFailed: (name, amount) =>
    `KEMRI SACCO: Hi ${firstName(name)}, we could not complete your instant withdrawal right now. Your KES ${Number(amount).toLocaleString()} request is queued - our team will process it shortly.`,

  // ─── MEMBER-FACING — LOAN REMINDERS ───
  loanReminderMidMonth: (name, amountOutstanding, amountPaid) =>
    `KEMRI SACCO: Hi ${firstName(name)}, amount outstanding on your loan: ${formatKES(amountOutstanding)}. Amount paid so far: ${formatKES(amountPaid)}. Settle anytime via *483*4444#.`,

  loanReminderEndMonthOnTrack: (name, amountOutstanding) =>
    `KEMRI SACCO: End-of-month check-in. Amount outstanding: ${formatKES(amountOutstanding)}. You are on track - thank you for keeping up with your payments.`,

  loanReminderEndMonthBehind: (name, amountOutstanding, amountBehind) =>
    `KEMRI SACCO: End-of-month check-in. Amount outstanding: ${formatKES(amountOutstanding)}. You are ${formatKES(amountBehind)} behind schedule. Please settle via *483*4444#.`,

  loanOverdueDay3: (name, amountBehind) =>
    `KEMRI SACCO: You are ${formatKES(amountBehind)} behind on your loan settlement. Please settle via *483*4444# to avoid further reminders.`,

  // ─── STAFF-FACING ───
  staffNewMember: (name) =>
    `KEMRI SACCO Admin: New member registered - ${name}.`,

  staffLoanApplication: (name, principal, ref) =>
    `KEMRI SACCO Admin: Loan application, principal ${formatKES(principal)}, from ${name}. Ref: ${ref}. Awaiting review.`,

  staffLoanAutoApproved: (name, principal, ref, opts = {}) => {
    const { status } = opts;
    let closing;
    if (status === 'disbursing') {
      closing = 'B2C initiated - no action needed.';
    } else if (status === 'failed') {
      closing = 'B2C FAILED - manual disbursement required.';
    } else {
      closing = 'Awaiting disbursement.';
    }
    return `KEMRI SACCO Admin: Board/Staff loan, principal ${formatKES(principal)}, for ${name} (Ref: ${ref}). Auto-approved. ${closing}`;
  },

  staffLoanDisbursed: (name, reference, receipt) =>
    `KEMRI SACCO Admin: Loan ${reference} for ${name} disbursed via B2C. Receipt: ${receipt || 'N/A'}.`,

  staffLoanDisbursementFailed: (name, reference, reason) =>
    `KEMRI SACCO Admin: Loan ${reference} for ${name} - B2C FAILED (${reason}). Manual disbursement required.`,

  staffLoanDisbursementTimedOut: (name, reference) =>
    `KEMRI SACCO Admin: Loan ${reference} for ${name} - B2C TIMED OUT. Verify on M-Pesa and disburse manually if needed.`,

  staffRepayment: (name, amount) =>
    `KEMRI SACCO Admin: Payment of ${formatKES(amount)} received from ${name}.`,

  staffDeposit: (name, amount) =>
    `KEMRI SACCO Admin: Deposit of ${formatKES(amount)} received from ${name}.`,

  staffWithdrawalRequest: (name, amount) =>
    `KEMRI SACCO Admin: Withdrawal request of ${formatKES(amount)} from ${name}. Awaiting processing.`,

  staffWithdrawalInstantSuccess: (name, amount, receipt) =>
    `KEMRI SACCO Admin: Withdrawal of ${formatKES(amount)} paid instantly to ${name}. Receipt: ${receipt || 'N/A'}.`,

  staffWithdrawalInstantFailed: (name, amount) =>
    `KEMRI SACCO Admin: Instant withdrawal FAILED for ${name} (${formatKES(amount)}). Queued for manual processing.`,

  staffWithdrawalInstantTimedOut: (name, amount) =>
    `KEMRI SACCO Admin: Instant withdrawal TIMED OUT for ${name} (${formatKES(amount)}). Queued for manual processing.`,

  staffLoanOverdueAlert: (name, reference, amountBehind) =>
    `KEMRI SACCO Admin: ${name} is ${formatKES(amountBehind)} behind on loan ${reference}. 6 days past month-end - consider calling.`,

  staffWeeklyDigest: (dueCount, dueTotal, overdueCount) => {
    const duePart = dueCount > 0
      ? `${dueCount} loan${dueCount > 1 ? 's' : ''} due this week (${formatKES(dueTotal)})`
      : null;
    const overduePart = overdueCount > 0 ? `${overdueCount} overdue` : null;
    const parts = [duePart, overduePart].filter(Boolean).join(' | ');
    return `KEMRI SACCO Admin: ${parts}. Log in to the portal for details.`;
  },
};

async function sendViaProvider(cleanPhone, message) {
  const payload = {
    from: SMS_SENDER_ID,
    to: cleanPhone,
    message,
  };

  const response = await axios.post(SMS_API_URL, payload, {
    headers: {
      Authorization: `Bearer ${SMS_API_KEY}`,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });

  const data = response.data || {};
  const status = String(data.status || '').toUpperCase();
  const statusCode = String(data.statusCode ?? '');

  if (status !== 'SUCCESS' || (statusCode && statusCode !== '0')) {
    return {
      sent: false,
      reason: data.desc || `Provider status ${status || '(missing)'}${statusCode ? ` (${statusCode})` : ''}`,
    };
  }

  return {
    sent: true,
    msgId: data.msgId,
    cost: data.cost,
    balance: data.balance,
  };
}

async function sendSMS(phoneNumber, message) {
  if (!isConfigured()) {
    console.warn('SMS not sent: provider is not configured (SMS_PROVIDER_API_URL / SMS_PROVIDER_API_KEY / SMS_PROVIDER_SENDER_ID missing)');
    return { sent: false, reason: 'SMS provider is not configured' };
  }

  if (!phoneNumber) {
    console.warn('SMS not sent: phoneNumber is empty');
    return { sent: false, reason: 'No phone number provided' };
  }

  const cleanPhone = normalizePhone(phoneNumber);
  if (!cleanPhone) {
    console.warn('SMS not sent: invalid phone number after normalization:', phoneNumber);
    return { sent: false, reason: 'Invalid phone number' };
  }

  try {
    const result = await sendViaProvider(cleanPhone, message);

    if (!result.sent) {
      console.error(`❌ SMS to ${cleanPhone} was NOT delivered — ${result.reason}`);
    } else {
      console.log(`✅ SMS delivered to ${cleanPhone}${result.msgId ? ` — msgId ${result.msgId}` : ''}${result.cost ? `, cost ${result.cost}` : ''}`);
    }

    return result;
  } catch (err) {
    console.error(`❌ SMS sending failed for ${cleanPhone}:`, err.response?.data || err.message);
    return { sent: false, reason: err.message };
  }
}

async function notifyStaff(message) {
  const Admin = require('../models/Admin');
  try {
    const staff = await Admin.findAll();
    const withPhone = staff.filter((s) => s.phone);
    const results = await Promise.allSettled(
      withPhone.map((s) => sendSMS(s.phone, message))
    );
    const failed = results.filter((r) => r.status === 'rejected').length;
    if (failed > 0) {
      console.warn(`notifyStaff: ${failed} of ${withPhone.length} staff SMS deliveries failed.`);
    }
  } catch (err) {
    console.error('notifyStaff failed to look up staff accounts:', err.message);
  }
}

module.exports = { sendSMS, notifyStaff, templates };