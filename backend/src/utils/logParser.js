// backend/src/utils/logParser.js
function sanitize(raw) {
  if (!raw) return '';
  // redact typical secrets / tokens
  let s = raw.replace(/(AKIA|AIza)[A-Za-z0-9_\-]+/g, '[REDACTED]');
  // trim to last N characters and include last stack traces
  const max = 6000;
  if (s.length > max) s = '...TRUNCATED...\n' + s.slice(-max);
  return s;
}

module.exports = { sanitize };
