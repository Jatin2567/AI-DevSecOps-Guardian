// backend/src/utils/logParser.js
const crypto = require('crypto');

/**
 * Sanitize logs aggressively:
 * - redact secrets / tokens
 * - redact PEM blocks
 * - prevent leaking into GitLab issues
 */
function sanitize(raw) {
  if (!raw) return '';
  let s = String(raw);

  // PEM blocks
  s = s.replace(/-----BEGIN [A-Z ]+-----[\s\S]+?-----END [A-Z ]+-----/g, '[REDACTED_PEM]');

  // AWS Access Keys
  s = s.replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]');

  // Google API keys
  s = s.replace(/\bAIza[0-9A-Za-z\-_]{35}\b/g, '[REDACTED_GOOGLE_KEY]');

  // GitHub tokens (ghp_…)
  s = s.replace(/\bghp_[A-Za-z0-9]{36}\b/g, '[REDACTED_GITHUB_TOKEN]');

  // Slack tokens (xoxb, xoxp)
  s = s.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED_SLACK_TOKEN]');

  // OAuth Client secrets
  s = s.replace(/\b[0-9a-fA-F]{32}\b/g, '[REDACTED_OAUTH_SECRET]');

  // Bearer tokens
  s = s.replace(/Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/gi, 'Bearer [REDACTED_TOKEN]');

  // JWTs
  s = s.replace(/\b[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}\b/g, '[REDACTED_JWT]');

  // Generic long tokens
  s = s.replace(/\b[A-Za-z0-9\-_]{40,}\b/g, '[REDACTED_TOKEN]');

  // Emails
  s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]');

  // IPv4
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]');

  // Env var leaks like KEY=xxxx
  s = s.replace(/\b[A-Z0-9_]{3,}=['"]?[A-Za-z0-9\/+=\-_!@#$%^&*]{10,}['"]?/g, '[REDACTED_ENV_VAR]');

  // Truncate long logs but keep the last context
  const max = 6000;
  if (s.length > max) {
    const tail = s.slice(-max);
    return `...TRUNCATED...\n${tail}`;
  }

  return s;
}

/**
 * NEW: Return sanitized tail of trace (default last 150 lines)
 */
function tailAndSanitize(raw, tailLines = 150) {
  if (!raw) return '';
  const arr = String(raw).split('\n');
  const tail = arr.slice(-tailLines).join('\n');
  return sanitize(tail);
}

/**
 * NEW: Compute short hash of sanitized content (first 2000 chars)
 */
function traceHash(raw) {
  if (!raw) return '';
  const clean = sanitize(raw).slice(0, 2000);
  const h = crypto.createHash('sha256');
  h.update(clean);
  return h.digest('hex').slice(0, 12); // short hash
}

// Existing exports preserved exactly
module.exports = {
  sanitize,

  // new helpers
  tailAndSanitize,
  traceHash
};
