const axios = require('axios');
const crypto = require('crypto'); // <--- ADDED for unique IDs
const { getAccessToken, normalizeToMsisdn } = require('./darajaService');
const { withRetry } = require('../utils/retryHelper'); // <--- ADDED

// B2C can run against a different Daraja environment than STK Push.
function b2cEnv() {
  return process.env.DARAJA_B2C_ENV
    || (process.env.DARAJA_ENV === 'production' ? 'production' : 'sandbox');
}

function b2cBaseUrl() {
  return b2cEnv() === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

function b2cConsumerKey() {
  return process.env.DARAJA_B2C_CONSUMER_KEY || process.env.DARAJA_CONSUMER_KEY;
}

function b2cConsumerSecret() {
  return process.env.DARAJA_B2C_CONSUMER_SECRET || process.env.DARAJA_CONSUMER_SECRET;
}

function missingConfig() {
  const required = [
    'DARAJA_B2C_INITIATOR_NAME',
    'DARAJA_B2C_SECURITY_CREDENTIAL',
    'DARAJA_B2C_SHORTCODE',
    'DARAJA_B2C_RESULT_URL',
    'DARAJA_B2C_TIMEOUT_URL',
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (!b2cConsumerKey()) missing.push('DARAJA_B2C_CONSUMER_KEY (or DARAJA_CONSUMER_KEY)');
  if (!b2cConsumerSecret()) missing.push('DARAJA_B2C_CONSUMER_SECRET (or DARAJA_CONSUMER_SECRET)');
  return missing;
}

function isConfigured() {
  return missingConfig().length === 0;
}

async function b2cPayment({ phoneNumber, amount, remarks, occasion, originatorConversationId }) {
  const missing = missingConfig();
  if (missing.length > 0) {
    throw new Error(`B2C is not configured. Missing: ${missing.join(', ')}`);
  }

  const msisdn = normalizeToMsisdn(phoneNumber); // 2547XXXXXXXX
  const env = b2cEnv();

  const token = await getAccessToken({
    env,
    consumerKey: b2cConsumerKey(),
    consumerSecret: b2cConsumerSecret(),
  });

  const payload = {
    InitiatorName: process.env.DARAJA_B2C_INITIATOR_NAME,
    SecurityCredential: process.env.DARAJA_B2C_SECURITY_CREDENTIAL,
    CommandID: 'BusinessPayment',
    Amount: Math.round(Number(amount)), // whole KES only
    PartyA: process.env.DARAJA_B2C_SHORTCODE,
    PartyB: msisdn,
    Remarks: (remarks || 'KEMRI SACCO Loan Disbursement').slice(0, 100),
    QueueTimeOutURL: process.env.DARAJA_B2C_TIMEOUT_URL,
    ResultURL: process.env.DARAJA_B2C_RESULT_URL,
    Occassion: (occasion || 'Loan Disbursement').slice(0, 100),
    // 2026-11-02: Crucial for retries. If we retry a timed-out request, 
    // Safaricom will reject the duplicate instead of paying the member twice.
    OriginatorConversationID: originatorConversationId || crypto.randomUUID(),
  };

  try {
    // 2026-11-02: Wrapped in retry logic
    const response = await withRetry(async () => {
      return await axios.post(
        `${b2cBaseUrl()}/mpesa/b2c/v1/paymentrequest`,
        payload,
        {
          headers: { Authorization: `Bearer ${token}` },
          // Cap the wait at 8s. The B2C request itself is fast when
          // Safaricom is healthy, but this call sits inside the USSD
          // request handler, so we can't wait forever.
          timeout: 8000,
        }
      );
    });

    if (String(response.data?.ResponseCode) !== '0') {
      console.error(`❌ Daraja B2C request rejected (${env}):`, response.data);
    }

    return response.data;
  } catch (error) {
    console.error(`❌ Daraja B2C transport error (${env}):`, error.response?.data || error.message);
    throw error;
  }
}

module.exports = { b2cPayment, isConfigured, missingConfig };