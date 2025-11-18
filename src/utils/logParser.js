function sanitize(raw) {
  if (!raw) return '';
  let s = String(raw);
  // PEM blocks
  s = s.replace(/-----BEGIN [A-Z ]+-----[^\-]+-----END [A-Z ]+-----/g, '[REDACTED_PEM]');
  // AWS keys
  s = s.replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '[REDACTED_AWS_KEY]');
  // Google API keys
  s = s.replace(/\bAIza[0-9A-Za-z\-_]{35}\b/g, '[REDACTED_GOOGLE_KEY]');
  // Emails, IPs
  s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[REDACTED_EMAIL]');
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[REDACTED_IP]');
  // JWTs and long base64-like tokens
  s = s.replace(/\b[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}\b/g, '[REDACTED_JWT]');
  // Generic long tokens
  s = s.replace(/\b[A-Za-z0-9-_]{40,}\b/g, '[REDACTED_TOKEN]');
  // Truncate long logs, keep trailing context
  const max = 6000;
  if (s.length > max) s = '...TRUNCATED...\n' + s.slice(-max);
  return s;
}

// configuration: monitor by job name and/or by stage
const MONITORED_JOB_NAMES = (process.env.MONITORED_JOB_NAMES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean); // may be empty

const MONITORED_STAGES = (process.env.MONITORED_STAGES || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean); // e.g. "lint,test,build"

// whether to analyze successful jobs/pipelines (string '1' means enabled)
const ENABLE_SUCCESS_PIPELINE_ANALYSIS = String(process.env.ENABLE_SUCCESS_PIPELINE_ANALYSIS || '0') === '1';

// sample 1 in N successful runs (integer >=1). If 1 => analyze every success.
const ANALYZE_SUCCESS_SAMPLING = Math.max(1, parseInt(process.env.ANALYZE_SUCCESS_SAMPLING || '1', 10));

module.exports = { sanitize };
