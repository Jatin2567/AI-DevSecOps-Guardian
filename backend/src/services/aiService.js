// backend/src/services/aiService.js
const fetch = require('node-fetch');

const GITLAB_API = process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4';
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const AI_PROVIDER = (process.env.AI_PROVIDER || 'gitlab_duo').toLowerCase();

// Helper headers for GitLab requests (works for both REST and Duo AI endpoints)
function gitlabAuthHeaders() {
  return {
    'Authorization': `Bearer ${GITLAB_TOKEN}`, // GitLab accepts Bearer for OAuth / modern tokens
    'PRIVATE-TOKEN': GITLAB_TOKEN,            // keep PAT compatibility
    'Content-Type': 'application/json'
  };
}

// High-level analyzeFailure: routes to provider-specific implementation
async function analyzeFailure({ projectId, pipelineId, jobId, jobName, logs }) {
  if (AI_PROVIDER === 'gitlab_duo') {
    return analyzeWithGitLabDuo({ projectId, pipelineId, jobId, jobName, logs });
  } else {
    return analyzeWithOpenAI({ projectId, pipelineId, jobId, jobName, logs });
  }
}

// Implementation: call GitLab Duo AI endpoint (pluggable path)
async function analyzeWithGitLabDuo({ projectId, pipelineId, jobId, jobName, logs }) {
  // NOTE: the Duo endpoint path below is configurable. If your GitLab Duo API path differs,
  // set DUO_AI_PATH environment variable (e.g., "/ai/analyze" or "/duo/v1/analyze")
  const duoPath = process.env.DUO_AI_PATH || '/ai/analysis';
  const url = `${GITLAB_API}${duoPath}`;

  const payload = {
    // Schema: adapt to the Duo API contract your GitLab instance expects.
    // Keep payload concise — include metadata and sanitized log excerpt.
    project_id: projectId,
    pipeline_id: pipelineId,
    job_id: jobId,
    job_name: jobName,
    logs: logs,
    // request structured JSON response
    response_format: 'json',
    schema: {
      stage: 'string',
      root_cause: 'string',
      suggested_fix: 'string',
      confidence: 'number',
      explain: 'string',
      suggested_patch: 'string'
    }
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: gitlabAuthHeaders(),
    body: JSON.stringify(payload)
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`GitLab Duo call failed ${resp.status}: ${text}`);
  }

  // Duo may return JSON body directly or wrap in { content: "...json..." }
  const data = await resp.json();

  // Defensive parsing: accept either direct JSON or text-to-json content
  if (data && typeof data === 'object') {
    // if API returns the parsed analysis directly
    if (data.root_cause || data.suggested_fix) return data;
    // if API wraps the JSON as string in content:
    if (data.content) {
      try { return JSON.parse(data.content); } catch (e) { return { explain: data.content, confidence: 0.0 }; }
    }
  }

  // fallback: return raw text as explanation
  const raw = JSON.stringify(data).slice(0, 10000);
  return { stage: jobName, root_cause: 'unparsed response', suggested_fix: 'manual review', explain: raw, confidence: 0.0 };
}



module.exports = { analyzeFailure };
