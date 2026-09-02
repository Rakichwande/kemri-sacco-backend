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
 * Initiate STK push (M-Pesa payment request)
 */
async function stkPush({ phoneNumber, amount, accountReference, description }) {
  try {
    // Clean phone number (remove +, spaces, etc.)
    const cleanPhone = String(phoneNumber).replace(/\D/g, '');

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

    const payload = {
      BusinessShortCode: shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amount,
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