const fetch = require('node-fetch');

async function fetchWithRetries(url, opts = {}, retries = 3, initialDelay = 300) {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(url, opts);
      // Retry on 429 or 5xx
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        throw new RetryableError(`retryable status ${res.status}`, res.status);
      }
      return res;
    } catch (err) {
      attempt++;
      if (attempt > retries || !(err instanceof RetryableError || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.name === 'FetchError')) {
        throw err;
      }
      const delay = initialDelay * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

class RetryableError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

module.exports = fetchWithRetries;
