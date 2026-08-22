require('dotenv').config();

const africastalking = require('africastalking')({
  apiKey: process.env.AT_API_KEY,
  username: process.env.AT_USERNAME,
});

const sms = africastalking.SMS;

function normalizePhone(phone) {
  // Africa's Talking requires E.164 format (leading +). Members/curl tests
  // often submit bare 254... numbers, so normalize here rather than
  // requiring every caller to remember the format.
  const digitsOnly = phone.replace(/\D/g, '');
  return digitsOnly.startsWith('254') ? `+${digitsOnly}` : `+254${digitsOnly.replace(/^0/, '')}`;
}

async function sendSMS(to, message) {
  try {
    const response = await sms.send({
      to: [normalizePhone(to)],
      message,
      from: process.env.AT_SENDER_ID || undefined,
    });
    return response;
  } catch (err) {
    console.error('SMS send failed:', err.message);
    throw err;
  }
}

// Templates kept here so wording can be changed in one place
const templates = {
  paymentConfirmed: (name, amount, accountRef, receipt) =>
    `Dear ${name}, we have received your payment of KES ${Number(amount).toLocaleString()} for account ${accountRef}. M-Pesa ref: ${receipt}. Thank you for saving with KEMRI SACCO.`,
  paymentFailed: (name) =>
    `Hi ${name}, your recent payment attempt to KEMRI SACCO was not completed. Please try again or contact us for help.`,
  applicationReceived: (name) =>
    `Hi ${name}, your application to KEMRI SACCO has been received and is being processed.`,
};

module.exports = { sendSMS, templates };
