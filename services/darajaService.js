const axios = require('axios');
const { withRetry } = require('../utils/retryHelper'); // <--- ADDED
require('dotenv').config();

// Shared Daraja environment. Used by STK Push and — in the absence of a
// B2C-specific override — by B2C too. Read lazily so the module can be
// required before env vars are set without capturing a stale value.
function getSharedEnv() {
  return process.env.DARAJA_ENV === 'production' ? 'production' : 'sandbox';
}

function baseUrlFor(env) {
  return env === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';
}

// Kept for stkPush() below, which targets the shared environment
// unconditionally. Anything that needs per-call environment selection
// (currently only B2C) uses baseUrlFor() directly.
const BASE_URL = baseUrlFor(getSharedEnv());

// Token cache keyed by `${env}:${consumerKey}` so STK Push (shared env,
// e.g. production) and B2C (potentially a different env with different
// credentials, e.g. sandbox) hold independent cached tokens.
const tokenCache = new Map();

/**
 * Get OAuth access token from Daraja.
 */
async function getAccessToken(config = null) {
  const env = config?.env || getSharedEnv();
  const consumerKey = config?.consumerKey || process.env.DARAJA_CONSUMER_KEY;
  const consumerSecret = config?.consumerSecret || process.env.DARAJA_CONSUMER_SECRET;

  if (!consumerKey || !consumerSecret) {
    throw new Error(
      `Missing Daraja consumer credentials for ${env}. ` +
      `Set DARAJA_CONSUMER_KEY / DARAJA_CONSUMER_SECRET ` +
      `(or the B2C-specific overrides for a B2C-only environment).`
    );
  }

  const cacheKey = `${env}:${consumerKey}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  try {
    const credentials = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    
    // 2026-11-02: Wrapped in retry logic
    const response = await withRetry(async () => {
      return await axios.get(
        `${baseUrlFor(env)}/oauth/v1/generate?grant_type=client_credentials`,
        { headers: { Authorization: `Basic ${credentials}` } }
      );
    });

    const token = response.data.access_token;
    // Refresh 5 minutes before Safaricom's own expiry (typically 1h).
    tokenCache.set(cacheKey, {
      token,
      expiresAt: Date.now() + 55 * 60 * 1000,
    });
    return token;
  } catch (error) {
    console.error(`❌ Daraja OAuth error (${env}):`, error.response?.data || error.message);
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
 * Initiate STK push (M-Pesa payment request).
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

    // 2026-11-02: Wrapped in retry logic
    const response = await withRetry(async () => {
      return await axios.post(
        `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
        payload,
        { headers: { Authorization: `Bearer ${token}` } }
      );
    });

    return response.data;
  } catch (error) {
    console.error('❌ Daraja STK Push error:', error.response?.data || error.message);
    throw error;
  }
}

module.exports = { getAccessToken, stkPush, normalizeToMsisdn };