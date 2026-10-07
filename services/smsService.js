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
//   - The notifyStaff(message) function
//
// Callers are unaffected by the template overhaul below — every template
// keeps its existing signature. Only the message text is clearer.

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
//  Conventions followed by every message in this file:
//
//  1. GSM-7 characters ONLY. No em dashes, smart quotes, or special
//     symbols. They force the message into UCS-2 encoding, which splits
//     it into multiple segments and triples the per-message cost. Use
//     plain hyphens and standard characters.
//
//  2. Member messages start with "KEMRI SACCO:" so the brand is visible
//     even if the carrier truncates the sender name in a preview.
//
//  3. Staff messages start with "KEMRI SACCO Admin:" and are dense —
//     name, amount, reference — so staff can triage from the notification
//     preview without opening the portal.
//
//  4. Aim for under 160 characters. Any message longer than that splits
//     into 2 segments and doubles the cost. Some messages need to be
//     longer; those are flagged in comments.
//
//  5. Members are addressed by first word of their full name where the
//     template has access to it. "Hi Joshua, ..." reads better than a
//     bare statement. Full name is used where the reference matters
//     (staff notifications, since staff need to disambiguate members).
// ─────────────────────────────────────────────────────────────────────────

const formatKES = (amount) => `KES ${Number(amount).toLocaleString()}`;

// First word of a full name — "Joshua Rakich Odhiambo" -> "Joshua".
// Falls back to the full string if no space is present. Used by member
// templates that want a friendlier greeting without the surname.
function firstName(fullName) {
  if (!fullName) return '';
  return String(fullName).trim().split(/\s+/)[0];
}

const templates = {
  // ───────────────────────────────────────────────────────────────────────
  //  MEMBER-FACING — REGISTRATION
  // ───────────────────────────────────────────────────────────────────────

  applicationReceived: (name) =>
    `Welcome to KEMRI SACCO, ${firstName(name)}. Your account is active. Dial *483*4444# to save, check balance, or apply for a loan.`,

  // ───────────────────────────────────────────────────────────────────────
  //  MEMBER-FACING — DEPOSITS
  // ───────────────────────────────────────────────────────────────────────

  paymentConfirmed: (name, amount, reference, receipt) =>
    `KEMRI SACCO: Hi ${firstName(name)}, we received your deposit of ${formatKES(amount)}. Receipt: ${receipt}. Your savings balance is updated. Ref: ${reference}.`,

  paymentFailed: (name) =>
    `KEMRI SACCO: Hi ${firstName(name)}, your deposit did not go through. Nothing was deducted. Please try again or visit our office.`,

  // ───────────────────────────────────────────────────────────────────────
  //  MEMBER-FACING — LOANS
  // ───────────────────────────────────────────────────────────────────────

  loanApplicationReceived: (name, amount, ref) =>
    `KEMRI SACCO: Hi ${firstName(name)}, we received your loan application of ${formatKES(amount)}. Ref: ${ref}. We'll review it and SMS you the decision shortly.`,

  loanApproved: (name, amount, installment, tenure) =>
    `KEMRI SACCO: Hi ${firstName(name)}, your loan of ${formatKES(amount)} has been approved. Repay ${formatKES(installment)}/month for ${tenure} months. Funds will be sent to your M-Pesa shortly.`,

  loanDisbursed: (name, amount, totalOutstanding, date) =>
    `KEMRI SACCO: Hi ${firstName(name)}, ${formatKES(amount)} has been sent to your M-Pesa. Repayment starts ${date}. Your total outstanding is now ${formatKES(totalOutstanding)}.`,

  loanRepaymentConfirmed: (name, amount, newBalance, receipt) =>
    `KEMRI SACCO: Hi ${firstName(name)}, we received your repayment of ${formatKES(amount)}. New loan balance: ${formatKES(newBalance)}. Receipt: ${receipt}. Thank you.`,

  loanRejected: (name, reason) =>
    `KEMRI SACCO: Hi ${firstName(name)}, your loan application was not approved.${reason ? ' Reason: ' + reason + '.' : ''} Contact our office for details.`,

  // Sent when a B2C disbursement fails at either stage (request-time
  // rejection, or result-callback failure). The member's loan is intact —
  // staff will disburse manually. Wording stays reassuring without
  // promising a specific timeline we can't guarantee.
  loanDisbursementFailed: (name) =>
    `KEMRI SACCO: Hi ${firstName(name)}, we could not complete your loan disbursement right now. Our team will contact you shortly.`,

  // ───────────────────────────────────────────────────────────────────────
  //  MEMBER-FACING — WITHDRAWALS
  // ───────────────────────────────────────────────────────────────────────

  // Sent when a withdrawal is queued for staff (above the instant
  // threshold), OR when an instant attempt failed and fell back to the
  // queue. Same wording works for both — the member's request is
  // recorded either way; only the timeline differs, and that's honest
  // without being alarming.
  withdrawalRequested: (name, amount) =>
    `KEMRI SACCO: Hi ${firstName(name)}, we received your withdrawal request of ${formatKES(amount)}. Our team will process it and SMS you once the funds are sent.`,

  // Instant withdrawal success. Short and unambiguous — the member just
  // watched money arrive, this confirms it with the receipt for their
  // records.
  withdrawalInstantConfirmed: (name, amount, receipt) =>
    `KEMRI SACCO: Hi ${firstName(name)}, ${formatKES(amount)} has been sent to your M-Pesa. Receipt: ${receipt}. Thank you.`,

  // Instant withdrawal failed at request time or timed out. Different from
  // withdrawalRequested because the member's expectation was "instant" —
  // the wording acknowledges the shortfall without apologising unduly.
  withdrawalInstantFailed: (name, amount) =>
    `KEMRI SACCO: Hi ${firstName(name)}, we could not complete your instant withdrawal right now. Your KES ${Number(amount).toLocaleString()} request is queued - our team will process it shortly.`,

  // ───────────────────────────────────────────────────────────────────────
  //  MEMBER-FACING — LOAN REMINDERS
  //
  //  Sent by services/reminderService.js on the cadence described there.
  //  Tone progression: informational at mid-month, positive or factual at
  //  end-of-month, firm but courteous at day-3 overdue.
  // ───────────────────────────────────────────────────────────────────────

  loanReminderMidMonth: (name, balance, paid) =>
    `KEMRI SACCO: Hi ${firstName(name)}, your loan balance is ${formatKES(balance)}. You have paid ${formatKES(paid)} so far. Pay anytime via *483*4444#.`,

  loanReminderEndMonthOnTrack: (name, balance) =>
    `KEMRI SACCO: End-of-month check-in. Loan balance: ${formatKES(balance)}. You are on track - thank you for keeping up with your repayments.`,

  loanReminderEndMonthBehind: (name, balance, amountBehind) =>
    `KEMRI SACCO: End-of-month check-in. Loan balance: ${formatKES(balance)}. You are ${formatKES(amountBehind)} behind schedule. Please pay via *483*4444#.`,

  loanOverdueDay3: (name, amountBehind) =>
    `KEMRI SACCO: You are ${formatKES(amountBehind)} behind on your loan repayment. Please pay via *483*4444# to avoid further reminders.`,

  // ───────────────────────────────────────────────────────────────────────
  //  STAFF-FACING — MEMBERS
  // ───────────────────────────────────────────────────────────────────────

  staffNewMember: (name) =>
    `KEMRI SACCO Admin: New member registered - ${name}.`,

  // ───────────────────────────────────────────────────────────────────────
  //  STAFF-FACING — LOANS
  // ───────────────────────────────────────────────────────────────────────

  staffLoanApplication: (name, amount, ref) =>
    `KEMRI SACCO Admin: Loan request ${formatKES(amount)} from ${name}. Ref: ${ref}. Awaiting review.`,

  // Two states, chosen by the caller via opts.status:
  //   'disbursing' — auto-approved, B2C has been initiated, no action needed
  //   'failed'     — auto-approved but B2C failed, staff must disburse manually
  //   (absent)     — auto-approved but B2C not attempted (e.g. not configured)
  staffLoanAutoApproved: (name, amount, ref, opts = {}) => {
    const { status } = opts;
    let closing;
    if (status === 'disbursing') {
      closing = 'B2C initiated - no action needed.';
    } else if (status === 'failed') {
      closing = 'B2C FAILED - manual disbursement required.';
    } else {
      closing = 'Awaiting disbursement.';
    }
    return `KEMRI SACCO Admin: Board/Staff loan ${formatKES(amount)} for ${name} (Ref: ${ref}). Auto-approved. ${closing}`;
  },

  // Sent when a loan is successfully disbursed via B2C. Staff already got
  // the auto-approval notification; this is the confirmation that money
  // actually moved. Includes the receipt for reconciliation.
  staffLoanDisbursed: (name, reference, receipt) =>
    `KEMRI SACCO Admin: Loan ${reference} for ${name} disbursed via B2C. Receipt: ${receipt || 'N/A'}.`,

  // Sent when a B2C disbursement fails at either stage. Actionable —
  // staff need to disburse manually, so the message says so.
  staffLoanDisbursementFailed: (name, reference, reason) =>
    `KEMRI SACCO Admin: Loan ${reference} for ${name} - B2C FAILED (${reason}). Manual disbursement required.`,

  // Sent when Safaricom times out a B2C request. The loan rolled back to
  // 'approved' so it's still in the Disbursement Log awaiting action, but
  // staff should be aware it timed out in case the member reports funds
  // arriving anyway (rare, but possible).
  staffLoanDisbursementTimedOut: (name, reference) =>
    `KEMRI SACCO Admin: Loan ${reference} for ${name} - B2C TIMED OUT. Verify on M-Pesa and disburse manually if needed.`,

  // ───────────────────────────────────────────────────────────────────────
  //  STAFF-FACING — PAYMENTS AND REPAYMENTS
  // ───────────────────────────────────────────────────────────────────────

  staffRepayment: (name, amount) =>
    `KEMRI SACCO Admin: Repayment of ${formatKES(amount)} received from ${name}.`,

  staffDeposit: (name, amount) =>
    `KEMRI SACCO Admin: Deposit of ${formatKES(amount)} received from ${name}.`,

  // ───────────────────────────────────────────────────────────────────────
  //  STAFF-FACING — WITHDRAWALS
  // ───────────────────────────────────────────────────────────────────────

  // Sent when a withdrawal is queued for staff processing. Actionable —
  // staff need to send the money and mark it processed.
  staffWithdrawalRequest: (name, amount) =>
    `KEMRI SACCO Admin: Withdrawal request of ${formatKES(amount)} from ${name}. Awaiting processing.`,

  // Sent when a small withdrawal pays out instantly via B2C. Informational
  // — no action needed, but staff should have a record for reconciliation.
  staffWithdrawalInstantSuccess: (name, amount, receipt) =>
    `KEMRI SACCO Admin: Withdrawal of ${formatKES(amount)} paid instantly to ${name}. Receipt: ${receipt || 'N/A'}.`,

  // Sent when an instant withdrawal fails and falls back to the staff
  // queue. Actionable — the member is now waiting for manual processing.
  staffWithdrawalInstantFailed: (name, amount) =>
    `KEMRI SACCO Admin: Instant withdrawal FAILED for ${name} (${formatKES(amount)}). Queued for manual processing.`,

  staffWithdrawalInstantTimedOut: (name, amount) =>
    `KEMRI SACCO Admin: Instant withdrawal TIMED OUT for ${name} (${formatKES(amount)}). Queued for manual processing.`,

  // ───────────────────────────────────────────────────────────────────────
  //  STAFF-FACING — REMINDERS
  // ───────────────────────────────────────────────────────────────────────

  staffLoanOverdueAlert: (name, reference, amountBehind) =>
    `KEMRI SACCO Admin: ${name} is ${formatKES(amountBehind)} behind on loan ${reference}. 6 days past month-end - consider calling.`,

  // Weekly digest — one SMS, staff's Monday morning briefing. Only sent
  // when there's something to report. The conditional parts avoid
  // awkward phrasing when one count is zero.
  staffWeeklyDigest: (dueCount, dueTotal, overdueCount) => {
    const duePart = dueCount > 0
      ? `${dueCount} loan${dueCount > 1 ? 's' : ''} due this week (${formatKES(dueTotal)})`
      : null;
    const overduePart = overdueCount > 0 ? `${overdueCount} overdue` : null;
    const parts = [duePart, overduePart].filter(Boolean).join(' | ');
    return `KEMRI SACCO Admin: ${parts}. Log in to the portal for details.`;
  },
};

// ─────────────────────────────────────────────────────────────────────────
//  TRANSPORT — Infinity Tech / Tiara SMS Gateway
//
//  Request format (from tiaraconnect.io/developers):
//    POST <endpoint>
//    Authorization: Bearer <API_KEY>
//    Content-Type: application/json
//    Body: { from, to, message }
//
//  Response format:
//    { status: "SUCCESS" | "FAILED", statusCode: 0, desc, to, msgId,
//      cost, balance, mcc, mnc }
//
//  Success is status === "SUCCESS" and statusCode === 0. Anything else is
//  treated as a delivery failure; the desc field carries the provider's
//  human-readable reason.
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
//  notifyStaff — unchanged
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