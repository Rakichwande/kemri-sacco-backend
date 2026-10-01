const axios = require('axios');
const { getAccessToken, normalizeToMsisdn } = require('./darajaService');

// Reuses darajaService's BASE_URL logic, OAuth token cache, and MSISDN
// normalizer rather than duplicating them. B2C and C2B share the same
// consumer key/secret and hit the same Daraja environment — there is no
// reason to maintain a parallel auth layer.

const BASE_URL = process.env.DARAJA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// All five env vars must be present for B2C to work. Checked explicitly
// here so a misconfiguration produces a clear error at the point of a
// disbursement attempt, not a cryptic Safaricom rejection.
function isConfigured() {
  return !!(
    process.env.DARAJA_B2C_INITIATOR_NAME &&
    process.env.DARAJA_B2C_SECURITY_CREDENTIAL &&
    process.env.DARAJA_B2C_SHORTCODE &&
    process.env.DARAJA_B2C_RESULT_URL &&
    process.env.DARAJA_B2C_TIMEOUT_URL
  );
}

// Returns a list of which config values are missing. Used by the health
// check / system diagnostics page to explain WHY B2C is unavailable, not
// just that it is.
function missingConfig() {
  const required = [
    'DARAJA_B2C_INITIATOR_NAME',
    'DARAJA_B2C_SECURITY_CREDENTIAL',
    'DARAJA_B2C_SHORTCODE',
    'DARAJA_B2C_RESULT_URL',
    'DARAJA_B2C_TIMEOUT_URL',
  ];
  return required.filter((key) => !process.env[key]);
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
  if (!isConfigured()) {
    throw new Error(
      `B2C is not configured. Missing: ${missingConfig().join(', ')}`
    );
  }

  const msisdn = normalizeToMsisdn(phoneNumber); // 2547XXXXXXXX
  const token = await getAccessToken();

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
      `${BASE_URL}/mpesa/b2c/v1/paymentrequest`,
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
      console.error('❌ Daraja B2C request rejected:', response.data);
    }

    return response.data;
  } catch (error) {
    console.error('❌ Daraja B2C transport error:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = { b2cPayment, isConfigured, missingConfig };