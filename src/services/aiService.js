'use strict';

const util = require('util');
const Groq = require('groq-sdk');
const aiHelpers = require('../utils/aiHelpers');

const API_KEY = process.env.GROQ_API_KEY;
if (!API_KEY) {
  throw new Error('GROQ_API_KEY is not set in environment');
}

const MODEL = process.env.GROQ_MODEL || 'llama3-8b-8192';
const MAX_RETRIES = Math.max(0, parseInt(process.env.GROQ_MAX_RETRIES || '3', 10));
const TIMEOUT_MS = Math.max(1000, parseInt(process.env.GROQ_TIMEOUT_MS || '30000', 10));
const BASE_BACKOFF_MS = Math.max(100, parseInt(process.env.GROQ_BASE_BACKOFF_MS || '400', 10));
const MAX_BACKOFF_MS = Math.max(1000, parseInt(process.env.GROQ_MAX_BACKOFF_MS || '8000', 10));
const CONCURRENCY_LIMIT = Math.max(1, parseInt(process.env.GROQ_CONCURRENCY_LIMIT || '4', 10));
const DEMO_FALLBACK = String(process.env.DEMO_FALLBACK || '0') === '1';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function jitter(max) { return Math.floor(Math.random() * max); }
function backoffDelay(attempt) {
  const exp = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt));
  return Math.min(MAX_BACKOFF_MS, exp) + jitter(300);
}
function safeTruncate(s, max = 2000) {
  const str = (typeof s === 'string') ? s : util.inspect(s, { depth: 4 });
  if (str.length <= max) return str;
  return str.slice(0, max) + '...[truncated]';
}

// concurrency throttle
let currentConcurrency = 0;
const waitForSlot = () => new Promise(resolve => {
  const attempt = () => {
    if (currentConcurrency < CONCURRENCY_LIMIT) {
      currentConcurrency++;
      return resolve();
    }
    setTimeout(attempt, 50);
  };
  attempt();
});
const releaseSlot = () => { currentConcurrency = Math.max(0, currentConcurrency - 1); };


const client = new Groq({ apiKey: API_KEY });

/**
 * Build a strict prompt using the tail of logs and optional verified evidence.
 *
 * - logs: full trace (we will use the last `maxLines` lines)
 * - evidence (optional): { repoHits: [...], dependencyFindings: [...] }
 *
 * The prompt explicitly instructs the model:
 *  - Return ONLY valid JSON matching the schema.
 *  - Do NOT invent file names, CVEs, or line numbers.
 *  - If insufficient evidence, return a JSON with root_cause: "INSUFFICIENT_EVIDENCE".
 */
function buildPrompt({ jobName, logs, evidence = null, maxLines = 1200 }) {
  const header =
`You are an expert DevOps CI/CD assistant. You will be given sanitized CI logs and optional verified evidence.
You MUST respond ONLY with valid JSON matching this exact schema (no extra text, no markdown):

{
  "stage": "<pipeline stage or job name>",
  "root_cause": "<one sentence explanation or the literal string INS UFFICIENT_EVIDENCE if you cannot determine>",
  "suggested_fix": "<short fix steps or an explicit 'insufficient_evidence' value>",
  "confidence": <0.0 - 1.0>,
  "explain": "<2-3 sentence explanation>"
}

IMPORTANT SAFEGUARDS (do not remove):
- Do NOT invent file names, line numbers, CVE identifiers, or package advisory URLs that are not present in the provided evidence.
- If there is not enough concrete evidence in the logs or the supplied verified evidence to determine a root cause, you MUST return root_cause: "INSUFFICIENT_EVIDENCE" and confidence: 0.0.
- Keep the explanation truthful, concise, and only based on the provided logs/evidence.

Here is the evidence (if any). Only use verified items listed here:

`;
  let evText = '';
  if (evidence && typeof evidence === 'object') {
    try {
      evText += JSON.stringify({
        repo_hits: (evidence.repoHits || []).filter(Boolean).map(h => ({ file: h.file, verified: !!h.verified, reason: h.reason || null })),
        dependencies: (evidence.dependencyHigh || []).concat(evidence.dependencyOther || [])
      }, null, 2);
    } catch (e) {
      evText += '"[evidence serialization failed]"';
    }
    evText += '\n\n';
  }

  const safelyTruncated = (String(logs || '')).split('\n').slice(-maxLines).join('\n');

  const footer =
`\n\nLogs (sanitized tail):\n`;

  return `${header}${evText}${footer}${safelyTruncated}\n\nReturn only JSON that strictly conforms to the schema above.`;
}


function extractTextFromResponse(resp) {
  try {
    if (!resp) return '';
    if (Array.isArray(resp.choices) && resp.choices.length > 0) {
      const c = resp.choices[0];
      if (c.message && typeof c.message.content === 'string') return c.message.content;
      if (typeof c.text === 'string') return c.text;
      if (c.delta && typeof c.delta.content === 'string') return c.delta.content;
    }
    if (Array.isArray(resp.output) && resp.output.length > 0) {
      const out = resp.output[0];
      if (out && typeof out.content === 'string') return out.content;
      if (Array.isArray(out?.content) && out.content.length) {
        return out.content.map(x => x.text || JSON.stringify(x)).join('\n');
      }
    }
    if (typeof resp === 'string') return resp;
    return safeTruncate(JSON.stringify(resp));
  } catch (e) {
    return safeTruncate(String(resp));
  }
}


function parseJsonFromText(text) {
  const cleaned = (typeof text === 'string') ? text.replace(/```/g, '').trim() : String(text || '');
  try {
    const parsed = JSON.parse(cleaned);
    return { parsed, cleaned };
  } catch (e) {
    const m = cleaned.match(/{[\s\S]*}/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]);
        return { parsed, cleaned: m[0] };
      } catch (e2) {
        // fallthrough
      }
    }
  }
  return { parsed: null, cleaned };
}

// Try multiple SDK call shapes
async function callGroq(prompt) {
  const payload = {
    model: MODEL,
    messages: [
      { role: 'system', content: 'You are a helpful assistant specialized in CI/CD failure analysis.' },
      { role: 'user', content: prompt }
    ],
    max_tokens: 1200,
    temperature: 0
  };

  const attempts = [
    async () => client.chat?.completions?.create ? await client.chat.completions.create(payload) : null,
    async () => client.chat?.completions ? await client.chat.completions(payload) : null,
    async () => client.createChatCompletion ? await client.createChatCompletion(payload) : null,
    async () => client.request ? await client.request({ path: 'https://api.groq.com/openai/v1/chat/completions', method: 'POST', body: payload }) : null
  ];

  let lastErr;
  for (const fn of attempts) {
    try {
      const resp = await fn();
      if (resp) return resp;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Groq client did not expose a known chat completion method');
}


function processGroqResponse(rawResp, { jobName = 'unknown', jobId = 'unknown' } = {}) {
  try {
    console.debug(JSON.stringify({ level: 'debug', msg: 'groq.raw_response', resp: safeTruncate(rawResp, 2000) }));
  } catch {
    console.debug('groq.raw_response (string)', safeTruncate(rawResp, 2000));
  }

  const text = extractTextFromResponse(rawResp);
  const { parsed, cleaned } = parseJsonFromText(text);

  if (parsed && typeof parsed === 'object') {
    return parsed;
  }

  // Not parseable: return fallback that includes extracted text for diagnosis
  return {
    stage: jobName || jobId || 'unknown',
    root_cause: 'AI_UNAVAILABLE',
    suggested_fix: 'Manual triage required',
    confidence: 0,
    explain: `Model returned unparseable output. Extracted text (truncated): ${safeTruncate(cleaned, 1500)}`
  };
}


async function analyzeFailure({ projectId, pipelineId, jobId, jobName, logs }, opts = {}) {
  await waitForSlot();
  try {
    // build prompt using tail of logs and optional evidence (verified repoHits / deps)
    const prompt = buildPrompt({ jobName, logs, evidence: opts.evidence || null, maxLines: 1200 });

    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const rawResp = await Promise.race([
          callGroq(prompt),
          (async () => { await sleep(TIMEOUT_MS); throw new Error('groq_timeout'); })()
        ]);

        let analysis = processGroqResponse(rawResp, { jobName, jobId });

        // If parsed result looks valid (has required keys), return it
        if (aiHelpers.isValidAnalysis(analysis)) {
          // clamp confidence to valid range
          analysis.confidence = Number(Math.max(0, Math.min(1, Number(analysis.confidence || 0))));
          return analysis;
        }

        // If not valid, attempt a single corrective retry with an extra strict instruction appended
        try {
          console.warn('aiService: first response invalid or unparsable, attempting one corrective retry');
          const strictPrompt = prompt + '\n\nSTRICT REPEAT: If you are able to produce the JSON that matches the schema, do so now. Otherwise return {"stage": "' + (jobName || 'unknown') + '", "root_cause": "INSUFFICIENT_EVIDENCE", "suggested_fix": "insufficient_evidence", "confidence": 0.0, "explain": "Insufficient evidence to determine root cause." }';
          const rawResp2 = await Promise.race([
            callGroq(strictPrompt),
            (async () => { await sleep(TIMEOUT_MS); throw new Error('groq_timeout'); })()
          ]);
          const analysis2 = processGroqResponse(rawResp2, { jobName, jobId });
          if (aiHelpers.isValidAnalysis(analysis2)) {
            analysis2.confidence = Number(Math.max(0, Math.min(1, Number(analysis2.confidence || 0))));
            return analysis2;
          }
          // fall through to fallback handling below
          analysis = analysis2;
        } catch (retryErr) {
          // log and continue to fallback
          console.warn('aiService: corrective retry failed:', retryErr && retryErr.message ? retryErr.message : String(retryErr));
        }

        // If DEMO_FALLBACK is enabled, return a friendly demo object
        if (DEMO_FALLBACK) {
          return {
            stage: jobName || jobId || 'unknown',
            root_cause: 'Detected failure (demo fallback)',
            suggested_fix: 'Run failing tests locally and inspect logs; check dependency installation',
            confidence: 0.6,
            explain: 'Demo fallback used because model output was unavailable or unparsable'
          };
        }

        // otherwise return whatever we have (likely AI_UNAVAILABLE style object)
        return analysis;
      } catch (err) {
        lastErr = err;
        const msg = (err && err.message) ? err.message : String(err);
        console.warn(`ai.call attempt ${attempt} failed: ${msg}`);

        const transient = /503|429|timeout|overload|unavailable|ECONNRESET|ETIMEDOUT|groq_timeout/i.test(msg);
        if (!transient || attempt === MAX_RETRIES) {
          break;
        }
        const delay = backoffDelay(attempt);
        await sleep(delay);
      }
    }

    // persistent failure -> fallback result (optionally demo fallback)
    console.error('AI persistent failure:', lastErr && lastErr.message ? lastErr.message : String(lastErr));
    if (DEMO_FALLBACK) {
      return {
        stage: jobName || jobId || 'unknown',
        root_cause: 'Detected failure (demo fallback)',
        suggested_fix: 'Run failing tests locally and inspect logs; check dependency installation',
        confidence: 0.6,
        explain: 'Demo fallback used due to persistent AI errors'
      };
    }

    return {
      stage: jobName || jobId || 'unknown',
      root_cause: 'AI_UNAVAILABLE',
      suggested_fix: 'Manual triage required',
      confidence: 0,
      explain: lastErr && lastErr.message ? String(lastErr.message) : 'unknown error'
    };
  } finally {
    releaseSlot();
  }
}

module.exports = { analyzeFailure };
