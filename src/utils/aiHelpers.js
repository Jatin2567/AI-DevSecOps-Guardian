// backend/src/utils/aiHelpers.js
const crypto = require('crypto');

function clampConfidence(v) {
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  return 0;
}

function normStr(s) {
  if (s === undefined || s === null) return '';
  return String(s).trim().replace(/\s+/g, ' ');
}

/**
 * Make a deterministic fingerprint for a finding.
 * - excerptSliceLength: number of chars from the excerpt to include
 * - useHmac: if true and FP_HMAC_KEY env var present, compute HMAC instead of raw hash
 */
function makeFingerprint({ projectId, jobId, pipelineId = '', commitSha = '', excerpt = '' }, { excerptSliceLength = 200, useHmac = true } = {}) {
  const parts = [
    normStr(projectId),
    normStr(pipelineId || jobId),
    normStr(commitSha),
    normStr(excerpt).slice(0, excerptSliceLength)
  ];
  const piece = parts.join(':');
  const hmacKey = process.env.FP_HMAC_KEY || '';
  if (useHmac && hmacKey) {
    const h = crypto.createHmac('sha256', hmacKey);
    h.update(piece);
    return h.digest('hex').slice(0, 12); // 12 hex chars (~48 bits)
  } else {
    const h = crypto.createHash('sha256');
    h.update(piece);
    return h.digest('hex').slice(0, 12);
  }
}

function isValidAnalysis(obj) {
  if (!obj || typeof obj !== 'object') return false;
  if (!obj.stage || !obj.root_cause || obj.confidence === undefined) return false;
  if (typeof obj.root_cause !== 'string') return false;
  if (typeof obj.suggested_fix !== 'string') return false;
  return true;
}

module.exports = {
  clampConfidence,
  makeFingerprint,
  isValidAnalysis,
  normStr
};
