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

  loanApproved: (name, principal, interest, totalPayable) =>
    `KEMRI SACCO: Hi ${firstName(name)}, your loan is approved. Principal: ${formatKES(principal)}. Interest: ${formatKES(interest)}. Total amount payable: ${formatKES(totalPayable)}. Our team will send the funds to your M-Pesa shortly.`,

  loanDisbursed: (name, principal, totalPayable, dueDate) =>
    `KEMRI SACCO: Hi ${firstName(name)}, ${formatKES(principal)} has been disbursed to your M-Pesa. Total amount payable: ${formatKES(totalPayable)}, due ${dueDate}. Please settle on or before the due date. Thank you for choosing KEMRI SACCO.`,

  // 2026-10-23: New template for the Wallet system.
  // When a loan is approved, it goes to the wallet instead of B2C.
  loanWalletCredited: (name, principal, totalRepayment) =>
    `KEMRI SACCO: Hi ${firstName(name)}, your loan of ${formatKES(principal)} has been approved and credited to your SACCO Wallet. Total amount payable: ${formatKES(totalRepayment)}. Dial *483*4444# and select '2. My Wallet' to withdraw to M-Pesa.`,

  loanRepaymentConfirmed: (name, amountPaid, amountOutstanding, receipt) =>
    `KEMRI SACCO: Hi ${firstName(name)}, we received your payment of ${formatKES(amountPaid)}. Amount outstanding: ${formatKES(amountOutstanding)}. Receipt: ${receipt}.`,

  loanRejected: (name, reason) =>
    `KEMRI SACCO: Hi ${firstName(name)}, your loan application was not approved.${reason ? ' Reason: ' + reason + '.' : ''} Contact our office for details.`,

  loanDisbursementFailed: (name) =>
    `KEMRI SACCO: Hi ${firstName(name)}, we could not complete your loan disbursement right now. Our team will contact you shortly.`,

  // ─── MEMBER-FACING — LOAN REMINDERS ───
  loanReminderBoardApproved: (name, amountOutstanding, amountPaid) => {
    const hasPaid = Number(amountPaid) > 0;
    const paymentStatus = hasPaid
      ? `and you have paid ${formatKES(amountPaid)} to date`
      : 'and no repayments have been received to date';

    return `KEMRI SACCO: Dear ${firstName(name)}, your current outstanding loan balance is ${formatKES(amountOutstanding)}, ${paymentStatus}. Kindly make your repayment at your earliest convenience by dialling *483*4444#. Thank you for saving with KEMRI SACCO.`;
  },

  // ─── STAFF-FACING ───
  staffNewMember: (name) =>
    `KEMRI SACCO Admin: New member registered - ${name}.`,

  staffLoanApplication: (name, principal, ref) =>
    `KEMRI SACCO Admin: Loan application, principal ${formatKES(principal)}, from ${name}. Ref: ${ref}. Awaiting review.`,

  staffLoanAutoApproved: (name, principal, ref, opts = {}) => {
    const { status } = opts;
    let closing;
    if (status === 'disbursing') {
      closing = 'B2C initiated - no action needed.'; // Or Wallet credited
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

  // ─── STAFF-FACING — ACCOUNT MANAGEMENT ───
  staffWelcome: (name, role) =>
    `KEMRI SACCO Admin: Welcome ${name}. Your account has been created. Role: ${role.replace('_', ' ').toUpperCase()}. You can now log in to the portal.`,

  staffRemoved: (name) =>
    `KEMRI SACCO Admin: Hello ${name}, your staff account has been removed by a Super Administrator. You no longer have access to the portal.`,
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
      console.warn(`notifyStaff: ${failed} of ${withPhone.length} staff deliveries failed.`);
    }
  } catch (err) {
    console.error('notifyStaff failed to look up staff accounts:', err.message);
  }
}

module.exports = { sendSMS, notifyStaff, templates };