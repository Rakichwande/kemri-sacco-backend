// utils/retryHelper.js

/**
 * Executes an async function with exponential backoff and jitter.
 * @param {Function} fn - The async function to execute.
 * @param {number} maxRetries - Maximum number of retry attempts (default 3).
 * @param {number} baseDelayMs - Base delay in milliseconds (default 1000).
 */
async function withRetry(fn, maxRetries = 3, baseDelayMs = 1000) {
  let lastError;
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      
      // If it's the last attempt, don't wait, just throw the error
      if (attempt === maxRetries) break;

      // Check if the error is a client error (e.g., 400 Bad Request from Safaricom)
      // We don't want to retry these, as the request will fail again.
      const status = error.response?.status;
      if (status && status >= 400 && status < 500 && status !== 429) {
        throw error; 
      }

      // Exponential backoff: 1s, 2s, 4s + random jitter (0-300ms)
      const delay = (baseDelayMs * Math.pow(2, attempt - 1)) + (Math.random() * 300);
      
      console.warn(`[Retry] Attempt ${attempt} failed. Retrying in ${Math.round(delay)}ms...`, error.message);
      
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError;
}

module.exports = { withRetry };