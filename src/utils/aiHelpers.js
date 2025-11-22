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


function makeFingerprint(
  { projectId, jobId, pipelineId = '', commitSha = '', excerpt = '' },
  { excerptSliceLength = 200, useHmac = true } = {}
) {
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
    return h.digest('hex').slice(0, 12);
  }

  const h = crypto.createHash('sha256');
  h.update(piece);
  return h.digest('hex').slice(0, 12);
}


function isValidAnalysis(obj) {
  if (!obj || typeof obj !== 'object') return false;

  // If we have deterministic findings, treat as valid
  if (obj._detectorSummary) return true;

  if (!obj.stage || !obj.root_cause || obj.confidence === undefined) return false;
  if (typeof obj.root_cause !== 'string') return false;
  if (typeof obj.suggested_fix !== 'string') return false;

  return true;
}

function buildDetectorSummary(detectorResult) {
  if (!detectorResult || typeof detectorResult !== 'object') return null;

  const summary = {
    repoHits: Array.isArray(detectorResult.repoHits)
      ? detectorResult.repoHits.map((h) => ({
          file: h.file,
          line: h.line,
          match: h.match,
          verified: !!h.verified
        }))
      : [],

    dependencyHigh: Array.isArray(detectorResult.dependencyHigh)
      ? detectorResult.dependencyHigh.map((d) => ({
          package: d.package,
          version: d.version,
          severity: d.severity || 'high',
          verified: true
        }))
      : []
  };

  return summary;
}


function isDeterministicFinding(detectorSummary) {
  if (!detectorSummary) return false;

  if (Array.isArray(detectorSummary.repoHits)) {
    if (detectorSummary.repoHits.some((x) => x.verified)) return true;
  }

  if (Array.isArray(detectorSummary.dependencyHigh)) {
    if (detectorSummary.dependencyHigh.length > 0) return true;
  }

  return false;
}


function hashContent(str, slice = 200) {
  if (!str) return '';
  const h = crypto.createHash('sha256');
  h.update(String(str).slice(0, slice));
  return h.digest('hex').slice(0, 16); // 16 hex chars (~64 bits)
}

module.exports = {
  clampConfidence,
  makeFingerprint,
  isValidAnalysis,
  normStr,

  // New helpers
  buildDetectorSummary,
  isDeterministicFinding,
  hashContent
};
