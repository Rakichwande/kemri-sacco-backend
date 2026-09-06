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
};

// Send SMS function with enhanced validation and logging
async function sendSMS(phoneNumber, message) {
  if (!phoneNumber) {
    console.warn('SMS not sent: phoneNumber is empty');
    return;
  }

  const cleanPhone = normalizePhone(phoneNumber);
  if (!cleanPhone) {
    console.warn('SMS not sent: invalid phone number after normalization:', phoneNumber);
    return;
  }

  // Optionally, you can enforce that cleanPhone starts with '254' and length >= 10
  if (!cleanPhone.startsWith('254') || cleanPhone.length < 10) {
    console.warn('SMS not sent: normalized number does not look like a Kenyan number:', cleanPhone);
    return;
  }

  try {
    const result = await sms.send({
      to: [cleanPhone],
      message: message,
      from: process.env.AT_SENDER_ID || null,
    });
    console.log('✅ SMS sent successfully to', cleanPhone, ':', result);
  } catch (err) {
    console.error('❌ SMS sending failed for', cleanPhone, ':', err.message);
    // Optionally re-throw if you want the caller to handle the error
  }
}

module.exports = { sendSMS, templates };