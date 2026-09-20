const axios = require('axios');
require('dotenv').config();

const BASE_URL = process.env.DARAJA_ENV === 'production'
  ? 'https://api.safaricom.co.ke'
  : 'https://sandbox.safaricom.co.ke';

// In-memory token cache
let cachedToken = null;
let tokenExpiry = 0;

/**
 * Get OAuth access token from Daraja
 */
async function getAccessToken() {
  // Return cached token if still valid
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  try {
    const consumerKey = process.env.DARAJA_CONSUMER_KEY;
    const consumerSecret = process.env.DARAJA_CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret) {
      throw new Error('Missing DARAJA_CONSUMER_KEY or DARAJA_CONSUMER_SECRET in environment');
    }

    const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');

    const response = await axios.get(
      `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
      { headers: { Authorization: `Basic ${credentials}` } }
    );

    cachedToken = response.data.access_token;
    tokenExpiry = Date.now() + 55 * 60 * 1000; // refresh 5 min before expiry
    return cachedToken;
  } catch (error) {
    console.error('❌ Daraja OAuth error:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Generate current timestamp in Daraja format (YYYYMMDDHHmmss)
 */
function getTimestamp() {
  const now = new Date();
  const pad = (n) => n.toString().padStart(2, '0');
  return (
    now.getFullYear().toString() +
    pad(now.getMonth() + 1) +
    pad(now.getDate()) +
    pad(now.getHours()) +
    pad(now.getMinutes()) +
    pad(now.getSeconds())
  );
}

/**
 * Normalizes a Kenyan phone number to the 254XXXXXXXXX format Daraja
 * requires (12 digits, country code, no leading + or 0).
 *
 * Member phone numbers are validated at registration to accept EITHER
 * 07XXXXXXXX/01XXXXXXXX or 2547XXXXXXXX/254 1XXXXXXXX (see
 * middleware/validate.js's isValidKenyanPhone) - nothing normalizes them
 * to one consistent stored format. Previously this function only stripped
 * non-digit characters, so a member stored as "0712345678" would be sent
 * to Safaricom exactly as "0712345678" - 10 digits, wrong format - which
 * Daraja does not accept as a valid MSISDN. That would very likely have
 * caused STK pushes to fail for any member who registered with a plain
 * 0-prefixed number, i.e. the way most people naturally type their own
 * number.
 *
 * Throws if the input isn't a recognizable Kenyan number after cleaning,
 * rather than silently sending something malformed to Safaricom.
 */
function normalizeToMsisdn(phoneNumber) {
  const digitsOnly = String(phoneNumber).replace(/\D/g, '');

  if (/^254(7|1)\d{8}$/.test(digitsOnly)) {
    return digitsOnly; // already correct: 2547XXXXXXXX or 2541XXXXXXXX
  }
  if (/^0(7|1)\d{8}$/.test(digitsOnly)) {
    return '254' + digitsOnly.slice(1); // 07XXXXXXXX -> 2547XXXXXXXX
  }
  if (/^(7|1)\d{8}$/.test(digitsOnly)) {
    return '254' + digitsOnly; // 7XXXXXXXX -> 2547XXXXXXXX (bare, no leading 0/254)
  }

  throw new Error(`Cannot normalize phone number to a valid Daraja MSISDN: ${phoneNumber}`);
}

/**
 * Initiate STK push (M-Pesa payment request)
 */
async function stkPush({ phoneNumber, amount, accountReference, description }) {
  try {
    const cleanPhone = normalizeToMsisdn(phoneNumber);

    // Validate required environment variables
    const shortcode = process.env.DARAJA_SHORTCODE;
    const passkey = process.env.DARAJA_PASSKEY;
    const callbackUrl = process.env.DARAJA_CALLBACK_URL;

    if (!shortcode || !passkey || !callbackUrl) {
      throw new Error('Missing Daraja environment variables: DARAJA_SHORTCODE, DARAJA_PASSKEY, or DARAJA_CALLBACK_URL');
    }

    const token = await getAccessToken();
    const timestamp = getTimestamp();

    // Generate password
    const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');

    // Daraja requires a whole-number amount - round defensively in case a
    // caller ever passes a decimal (e.g. a member typing "500.50" on USSD).
    const wholeAmount = Math.round(Number(amount));

    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: wholeAmount,
      PartyA: cleanPhone,
      PartyB: shortcode,
      PhoneNumber: cleanPhone,
      CallBackURL: callbackUrl,
      AccountReference: accountReference || 'SACCO',
      TransactionDesc: description || 'SACCO payment',
    };

    const response = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    return response.data;
  } catch (error) {
    console.error('❌ Daraja STK Push error:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = { getAccessToken, stkPush };