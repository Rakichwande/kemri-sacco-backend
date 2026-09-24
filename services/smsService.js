require('dotenv').config();

const africastalking = require('africastalking')({
  username: process.env.AT_USERNAME || 'sandbox',
  apiKey: process.env.AT_API_KEY,
});

const sms = africastalking.SMS;

// Helper to format currency
const formatKES = (amount) => `KES ${Number(amount).toLocaleString()}`;

// Normalize phone number to international format (254XXXXXXXXX)
function normalizePhone(phoneNumber) {
  if (!phoneNumber) return null;
  // Remove all non-digit characters
  let cleaned = String(phoneNumber).replace(/\D/g, '');

  // If starts with 0, replace with 254
  if (cleaned.startsWith('0')) {
    cleaned = '254' + cleaned.slice(1);
  }
  // If starts with 7 or 1 (common in Kenya), prefix 254
  else if (cleaned.startsWith('7') || cleaned.startsWith('1')) {
    cleaned = '254' + cleaned;
  }
  // If already starts with 254, keep as is

  // Validate length (Kenyan numbers are 12 digits after normalization)
  if (cleaned.length !== 12) {
    console.warn('Phone number after normalization has length', cleaned.length, 'expected 12:', cleaned);
    // Still return it, but we'll log a warning
  }

  return "+" + cleaned;
}

// SMS Templates
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

  // Staff-facing - shorter and more clinical than the member-facing ones,
  // since these land on a staff phone, not a member's.
  staffNewMember: (name) =>
    `KEMRI SACCO Admin: New member registered - ${name}.`,

  staffLoanApplication: (name, amount, ref) =>
    `KEMRI SACCO Admin: Loan application ${formatKES(amount)} from ${name}. Ref: ${ref}. Awaiting review.`,

  staffRepayment: (name, amount) =>
    `KEMRI SACCO Admin: Repayment of ${formatKES(amount)} received from ${name}.`,

  staffDeposit: (name, amount) =>
    `KEMRI SACCO Admin: Deposit of ${formatKES(amount)} received from ${name}.`,

  withdrawalRequested: (name, amount) =>
    `KEMRI SACCO: Withdrawal request of ${formatKES(amount)} received. We will process it and contact you once complete. This is not instant.`,

  staffWithdrawalRequest: (name, amount) =>
    `KEMRI SACCO Admin: Withdrawal request of ${formatKES(amount)} from ${name}. Awaiting processing.`,
};

// Send SMS function.
//
// NEVER THROWS. Always resolves to { sent: boolean, reason?: string }.
//
// This is deliberate: SMS delivery failures are almost always per-recipient
// (the member's SIM is DND-listed, the number is wrong, the phone is off) or
// account-level (Africa's Talking balance is low) - neither is a systemic
// failure that should take the whole server down. Previously this function
// threw on any non-Success recipient status, and a fire-and-forget caller
// (notificationService.notifyStaff, or any await-less call) turning that
// throw into an unhandled rejection killed the process - for every other
// member too. Callers should be able to treat a delivery failure as a
// loggable event, not a fatal error. Same return shape as emailService's
// sendEmail(), so the two notification channels behave consistently.
async function sendSMS(phoneNumber, message) {
  if (!phoneNumber) {
    console.warn('SMS not sent: phoneNumber is empty');
    return { sent: false, reason: 'No phone number provided' };
  }

  const cleanPhone = normalizePhone(phoneNumber);
  if (!cleanPhone) {
    console.warn('SMS not sent: invalid phone number after normalization:', phoneNumber);
    return { sent: false, reason: 'Invalid phone number' };
  }

  if (!cleanPhone.startsWith('+254') || cleanPhone.length < 10) {
    console.warn('SMS not sent: normalized number does not look like a Kenyan number:', cleanPhone);
    return { sent: false, reason: 'Normalized number is not a Kenyan number' };
  }

  try {
    const result = await sms.send({
      to: [cleanPhone],
      message: message,
      from: process.env.AT_SENDER_ID || null,
    });

    // Africa's Talking's SMS API can resolve this promise successfully (no
    // exception) even when the message was NOT actually delivered - the
    // real outcome is per-recipient, inside
    // result.SMSMessageData.Recipients[].status (e.g. "Success",
    // "InsufficientBalance", "UserInBlacklist", "InvalidSenderId", etc).
    const recipient = result?.SMSMessageData?.Recipients?.[0];
    if (recipient && recipient.status !== 'Success') {
      console.error(
        `❌ SMS to ${cleanPhone} was NOT delivered - Africa's Talking status: "${recipient.status}"`,
        `(cost: ${recipient.cost || 'n/a'}). Full response:`, JSON.stringify(result)
      );
      return { sent: false, reason: recipient.status };
    }

    console.log(`✅ SMS delivered to ${cleanPhone} - status: ${recipient?.status || 'unknown'}`);
    return { sent: true };
  } catch (err) {
    // Network/API-level failure (Africa's Talking unreachable, timeout,
    // auth error, etc). Logged but still returned, never thrown - see the
    // function-level comment for the reasoning.
    console.error('❌ SMS sending failed for', cleanPhone, ':', err.message);
    return { sent: false, reason: err.message };
  }
}

async function notifyStaff(message) {
  const Admin = require('../models/Admin'); // required here, not at top, to avoid a require cycle risk
  try {
    const staff = await Admin.findAll();
    const withPhone = staff.filter((s) => s.phone);
    // Promise.allSettled, not Promise.all: one staff member's phone being
    // unreachable must not prevent the others from receiving the
    // notification, and must not cause a rejection to bubble up.
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