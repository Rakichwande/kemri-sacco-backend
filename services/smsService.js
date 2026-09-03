require('dotenv').config();

// services/smsService.js
const africastalking = require('africastalking')({
  username: process.env.AT_USERNAME || 'sandbox',
  apiKey: process.env.AT_API_KEY,
});

const sms = africastalking.SMS;

// Helper to format currency nicely (optional)
const formatKES = (amount) => `KES ${Number(amount).toLocaleString()}`;

// SMS Templates
const templates = {
  // 1. Registration
  applicationReceived: (name) =>
    `Welcome to KEMRI SACCO, ${name}. Your account is active. Dial *483*4444# to save, check balance, or apply for a loan.`,

  // 2. Deposit / Savings
  paymentConfirmed: (name, amount, reference, receipt) =>
    `KEMRI SACCO: ${formatKES(amount)} deposit received. Receipt: ${receipt}. Ref: ${reference}. Thank you for saving!`,

  paymentFailed: (name) =>
    `KEMRI SACCO: Your deposit of was not completed. Please try again or visit our office.`,

  // 3. Loan Application
  loanApplicationReceived: (name, amount, ref) =>
    `KEMRI SACCO: Loan application of ${formatKES(amount)} received. Ref: ${ref}. We will notify you once reviewed.`,

  // 4. Loan Approved (before money is sent)
  loanApproved: (name, amount, installment, tenure) =>
    `KEMRI SACCO: CONGRATULATIONS! Loan of ${formatKES(amount)} approved. Repay ${formatKES(installment)}/month for ${tenure} months. Disbursement pending.`,

  // 5. Loan Disbursed (money sent manually or via B2C)
  loanDisbursed: (name, amount, totalOutstanding, date) =>
    `KEMRI SACCO: ${formatKES(amount)} loan disbursed to your M-Pesa. Repayment starts ${date}. Outstanding: ${formatKES(totalOutstanding)}.`,

  // 6. Loan Repayment
  loanRepaymentConfirmed: (name, amount, newBalance, receipt) =>
    `KEMRI SACCO: Repayment of ${formatKES(amount)} received. Outstanding loan: ${formatKES(newBalance)}. Receipt: ${receipt}. Thank you!`,
};

// Send SMS function (remains the same)
async function sendSMS(phoneNumber, message) {
  if (!phoneNumber) return;
  const cleanPhone = String(phoneNumber).replace(/\D/g, '');
  if (!cleanPhone.startsWith('254')) {
    console.warn('SMS not sent: invalid phone number format', phoneNumber);
    return;
  }

  try {
    const result = await sms.send({ to: [cleanPhone], message, from: process.env.AT_SENDER_ID || null });
    console.log('SMS sent successfully:', result);
  } catch (err) {
    console.error('SMS sending failed:', err.message);
  }
}

module.exports = { sendSMS, templates };