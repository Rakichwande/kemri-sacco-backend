const axios = require('axios');
const { getAccessToken, normalizeToMsisdn } = require('./darajaService');

// B2C can run against a different Daraja environment than STK Push.
// The practical case: KEMRI's production app handles real STK Push while
// B2C is tested against a separate sandbox Daraja account. A single
// DARAJA_ENV cannot serve both — setting it to sandbox breaks live STK
// Push, and setting it to production makes B2C test against live money.
//
// DARAJA_B2C_ENV overrides the environment for B2C only. If unset, B2C
// follows the shared DARAJA_ENV — identical to the behaviour before this
// split, so a single-environment setup needs no changes.
//
// Same fallback applies to consumer credentials. DARAJA_B2C_CONSUMER_KEY
// and DARAJA_B2C_CONSUMER_SECRET are only required when B2C targets a
// different Daraja account than STK Push (e.g. a personal sandbox app
// while STK uses the production app's keys). When unset, B2C reuses the
// shared DARAJA_CONSUMER_KEY / DARAJA_CONSUMER_SECRET.
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

// Everything B2C needs to work. Consumer key/secret count as missing only
// if BOTH the B2C-specific and the shared values are unset — the fallback
// in b2cConsumerKey()/b2cConsumerSecret() handles the common case where
// B2C shares credentials with STK Push.
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

// Returns true only when every required value is present. Used by the
// disburse endpoint to fail fast with a specific message rather than
// letting the request reach Safaricom and bounce back a cryptic 401.
function isConfigured() {
  return missingConfig().length === 0;
}

// Initiate a B2C payment (money out). Resolves with Safaricom's immediate
// acceptance response, which includes a ConversationID that the result
// callback will use to identify the transaction. A ResponseCode of '0'
// means the request was accepted for processing — NOT that the money has
// been sent. The actual outcome arrives asynchronously at the ResultURL.
//
// Throws on transport failure or missing config. Callers should treat a
// thrown error as "the request never reached Safaricom" and keep the
// loan in whatever state it was in before the attempt.
async function b2cPayment({ phoneNumber, amount, remarks, occasion }) {
  const missing = missingConfig();
  if (missing.length > 0) {
    throw new Error(`B2C is not configured. Missing: ${missing.join(', ')}`);
  }

  const msisdn = normalizeToMsisdn(phoneNumber); // 2547XXXXXXXX
  const env = b2cEnv();

  // Pass B2C's own environment + credentials so getAccessToken caches a
  // token for THIS environment, independent of the one STK Push uses.
  // Without this the shared cache would hand B2C a production token while
  // it called the sandbox endpoint — the exact shape of the 401.002.01
  // "Invalid Access Token" error we hit before this split.
  const token = await getAccessToken({
    env,
    consumerKey: b2cConsumerKey(),
    consumerSecret: b2cConsumerSecret(),
  });

  const payload = {
    InitiatorName: process.env.DARAJA_B2C_INITIATOR_NAME,
    SecurityCredential: process.env.DARAJA_B2C_SECURITY_CREDENTIAL,
    CommandID: 'BusinessPayment', // standard B2C to a registered customer
    Amount: Math.round(Number(amount)), // whole KES only
    PartyA: process.env.DARAJA_B2C_SHORTCODE, // the merged paybill/shortcode
    PartyB: msisdn, // recipient
    Remarks: (remarks || 'KEMRI SACCO Loan Disbursement').slice(0, 100),
    QueueTimeOutURL: process.env.DARAJA_B2C_TIMEOUT_URL,
    ResultURL: process.env.DARAJA_B2C_RESULT_URL,
    Occassion: (occasion || 'Loan Disbursement').slice(0, 100), // Safaricom's typo, kept verbatim
  };

  try {
    const response = await axios.post(
      `${b2cBaseUrl()}/mpesa/b2c/v1/paymentrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Expected success shape:
    // {
    //   ConversationID: 'AG_20231001_...',
    //   OriginatorConversationID: '...',
    //   ResponseCode: '0',
    //   ResponseDescription: 'Accept the service request successfully.'
    // }
    //
    // A non-'0' ResponseCode means Safaricom rejected the request outright
    // (wrong credentials, insufficient balance on the SACCO's account,
    // malformed MSISDN, etc). No callback will come for a rejected request,
    // so the caller must NOT move the loan to 'disbursing' in that case.
    if (String(response.data?.ResponseCode) !== '0') {
      console.error(`❌ Daraja B2C request rejected (${env}):`, response.data);
    }

    return response.data;
  } catch (error) {
    // Log the environment in the error so a Render log line immediately
    // shows which side of the split failed — production or sandbox —
    // instead of needing to look up env vars to disambiguate.
    console.error(`❌ Daraja B2C transport error (${env}):`, error.response?.data || error.message);
    throw error;
  }
}

module.exports = { b2cPayment, isConfigured, missingConfig };