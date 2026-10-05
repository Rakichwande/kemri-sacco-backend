require('dotenv').config();
const axios = require('axios');

// SMS TRANSPORT: KEMRI SACCO's own provider (Infinity Tech, powered by Tiara).
//
// This service used to send SMS via Africa's Talking. It now sends via
// Infinity Tech's HTTP API, using KEMRI's approved sender ID (Kemri_Sacco).
// Africa's Talking remains the USSD gateway — that path is unaffected and
// still requires AT_USSD_SHARED_SECRET in the environment.
//
// What did NOT change:
//   - The sendSMS(phoneNumber, message) signature
//   - The { sent, reason } return shape
//   - The "never throws" contract
//   - Every template in the templates object
//   - notifyStaff(message)
//
// Callers are unaffected. This is a transport swap, not an API change.

// ─────────────────────────────────────────────────────────────────────────
//  PROVIDER CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────

const SMS_API_URL = process.env.SMS_PROVIDER_API_URL;
const SMS_API_KEY = process.env.SMS_PROVIDER_API_KEY;
const SMS_SENDER_ID = process.env.SMS_PROVIDER_SENDER_ID;

function isConfigured() {
  return !!(SMS_API_URL && SMS_API_KEY && SMS_SENDER_ID);
}

// ─────────────────────────────────────────────────────────────────────────
//  PHONE NORMALISATION
//
//  Infinity Tech / Tiara requires the format 2547XXXXXXXXX — 12 digits,
//  country code, no leading + and no leading 0. This is the same canonical
//  form the Daraja normaliser produces, so a member registered with any of
//  the accepted local formats (0722..., 722..., +254722..., 254 722...)
//  resolves to the same outgoing value.
//
//  Returns null when the input cannot be resolved to a plausible Kenyan
//  mobile — the caller logs the failure rather than sending a malformed
//  number to the provider (which would return a generic error with no
//  useful detail).
// ─────────────────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────────────────
//  SMS TEMPLATES
//
//  Every template is byte-for-byte identical to the previous version.
//  No message text has changed — members see the same wording, only the
//  sender ID on their phone changes (Kemri_Sacco instead of AFRICASTKNG).
// ─────────────────────────────────────────────────────────────────────────

const formatKES = (amount) => `KES ${Number(amount).toLocaleString()}`;

const templates = {
  applicationReceived: (name) =>
    `Welcome to KEMRI SACCO, ${name}. Your account is active. Dial *483*4444# to save, check balance, or apply for a loan.`,

  paymentConfirmed: (name, amount, reference, receipt) =>
    `KEMRI SACCO: ${formatKES(amount)} deposit received. Receipt: ${receipt}. Ref: ${reference}. Thank you for saving!`,

  paymentFailed: (name) =>
    `KEMRI SACCO: Your deposit was not completed. Please try again or visit our office.`,

  loanApplicationReceived: (name, amount, ref) =>
    `KEMRI SACCO: Loan application of ${formatKES(amount)} received. Ref: ${ref}. We will notify you once reviewed.`,

  loanApproved: (name, amount, installment, tenure) =>
    `KEMRI SACCO: CONGRATULATIONS! Loan of ${formatKES(amount)} approved. Repay ${formatKES(installment)}/month for ${tenure} months. Disbursement pending.`,

  loanDisbursed: (name, amount, totalOutstanding, date) =>
    `KEMRI SACCO: ${formatKES(amount)} loan disbursed to your M-Pesa. Repayment starts ${date}. Outstanding: ${formatKES(totalOutstanding)}.`,

  loanRepaymentConfirmed: (name, amount, newBalance, receipt) =>
    `KEMRI SACCO: Repayment of ${formatKES(amount)} received. Outstanding loan: ${formatKES(newBalance)}. Receipt: ${receipt}. Thank you!`,

  loanRejected: (name, reason) =>
    `KEMRI SACCO: Your loan application was not approved.${reason ? ' Reason: ' + reason : ''} Contact the SACCO office for details.`,

  staffNewMember: (name) =>
    `KEMRI SACCO Admin: New member registered - ${name}.`,

  staffLoanApplication: (name, amount, ref) =>
    `KEMRI SACCO Admin: Loan application ${formatKES(amount)} from ${name}. Ref: ${ref}. Awaiting review.`,

  staffLoanAutoApproved: (name, amount, ref, opts = {}) => {
    const { status } = opts;
    let closing;
    if (status === 'disbursing') {
      closing = 'Auto-approved, B2C disbursement initiated. No action needed.';
    } else if (status === 'failed') {
      closing = 'Auto-approved, but B2C FAILED — manual disbursement required.';
    } else {
      closing = 'Auto-approved — ready for disbursement.';
    }
    return `KEMRI SACCO Admin: Board/Staff loan ${formatKES(amount)} from ${name} (Ref: ${ref}). ${closing}`;
  },

  staffRepayment: (name, amount) =>
    `KEMRI SACCO Admin: Repayment of ${formatKES(amount)} received from ${name}.`,

  staffDeposit: (name, amount) =>
    `KEMRI SACCO Admin: Deposit of ${formatKES(amount)} received from ${name}.`,

  withdrawalRequested: (name, amount) =>
    `KEMRI SACCO: Withdrawal request of ${formatKES(amount)} received. We will process it and contact you once complete. This is not instant.`,

  staffWithdrawalRequest: (name, amount) =>
    `KEMRI SACCO Admin: Withdrawal request of ${formatKES(amount)} from ${name}. Awaiting processing.`,
};

// ─────────────────────────────────────────────────────────────────────────
//  TRANSPORT — Infinity Tech / Tiara SMS Gateway
//
//  Request format (from tiaraconnect.io/developers):
//    POST <endpoint>
//    Authorization: Bearer <API_KEY>
//    Content-Type: application/json
//    Body: { from, to, message } — the minimal accepted payload
//
//  Response format:
//    { status: "SUCCESS" | "FAILED", statusCode: 0, desc, to, msgId,
//      cost, balance, mcc, mnc }
//
//  Success is status === "SUCCESS" and statusCode === 0. Anything else is
//  treated as a delivery failure; the desc field carries the provider's
//  human-readable reason (e.g. "Invalid request. The parameter 'to'
//  cannot be empty."), which is more useful than the raw status code.
//
//  Per-recipient detail: unlike Africa's Talking's multi-recipient
//  response, this endpoint handles ONE recipient per request. So there's
//  no array to iterate — a single failed status IS the per-recipient
//  failure. That simplifies parsing compared to the old implementation.
// ─────────────────────────────────────────────────────────────────────────

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

  // Provider contract: status === "SUCCESS" with statusCode === 0 means
  // delivered. Any other combination — including a missing status field
  // on a 200 response, which would indicate a malformed reply — is a
  // failure worth logging.
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

// ─────────────────────────────────────────────────────────────────────────
//  PUBLIC sendSMS — the API every caller in the platform depends on
// ─────────────────────────────────────────────────────────────────────────

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
    // Network/API-level failure. Logged but returned, never thrown — same
    // contract as the previous Africa's Talking implementation.
    console.error(`❌ SMS sending failed for ${cleanPhone}:`, err.response?.data || err.message);
    return { sent: false, reason: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────
//  notifyStaff — unchanged from the previous version
// ─────────────────────────────────────────────────────────────────────────

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