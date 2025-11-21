// backend/src/routes/webhook.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const gitlabService = require('../services/gitlabService');
const aiService = require('../services/aiService');
const issueService = require('../services/issueService');
const logParser = require('../utils/logParser');
const detectorService = require('../services/detectorService'); // integration point (server-side deterministics)

const WEBHOOK_SECRET = process.env.GITLAB_WEBHOOK_SECRET || '';
// MONITORED_JOB_NAMES env: comma-separated list (e.g. "unit_tests,lint,ai_scan")
const MONITORED_JOB_NAMES = (process.env.MONITORED_JOB_NAMES || 'unit_tests,lint,ai_scan')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const MONITORED_STAGES_NAMES = (process.env.MONITORED_STAGES || 'unit_tests,lint,ai_scan')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
// whether to analyze successful jobs/pipelines (string '1' means enabled)
const ENABLE_SUCCESS_PIPELINE_ANALYSIS = String(process.env.ENABLE_SUCCESS_PIPELINE_ANALYSIS || '0') === '1';

// sample 1 in N successful runs (integer >=0). If 0 => analyze no successes. If 1 => analyze every success.
const rawSampling = process.env.ANALYZE_SUCCESS_SAMPLING;
const ANALYZE_SUCCESS_SAMPLING = rawSampling === undefined ? 1 : Math.max(0, parseInt(rawSampling || '0', 10));

/** Validate incoming webhook token using timingSafeEqual */
function validWebhookToken(incoming) {
  if (!WEBHOOK_SECRET) return true; // allow dev use when secret not configured
  if (!incoming) return false;
  try {
    const a = Buffer.from(incoming);
    const b = Buffer.from(WEBHOOK_SECRET);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

/** Decide whether to analyze a successful event based on sampling config */
function shouldSampleSuccess() {
  if (!ENABLE_SUCCESS_PIPELINE_ANALYSIS) return false; // global off
  // If sampling explicitly set to 0, treat it as "no successes sampled"
  if (ANALYZE_SUCCESS_SAMPLING === 0) return false;
  if (ANALYZE_SUCCESS_SAMPLING <= 1) return true; // analyze every successful job
  // random sampling: approximate 1 in N
  return (Math.floor(Math.random() * ANALYZE_SUCCESS_SAMPLING) === 0);
}

/** Helper: canonicalize job name */
function canonicalJobName(job) {
  // job may have different fields depending on event type
  return job && (job.name || job.build_name || job.stage || job.job_name) ? (job.name || job.build_name || job.stage || job.job_name) : '';
}

/** Ensure debug directory exists and write raw webhook payload */
function writeRawWebhookPayload(event) {
  try {
    const debugDir = path.join(process.cwd(), 'debug');
    fs.mkdirSync(debugDir, { recursive: true });
    const raw = JSON.stringify(event, null, 2);
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const filename = path.join(debugDir, `webhook-${hash}.json`);
    // write file if not exists (avoid overwriting)
    if (!fs.existsSync(filename)) {
      fs.writeFileSync(filename, raw, { encoding: 'utf8' });
    }
    return { path: filename, hash };
  } catch (e) {
    console.warn('Failed to write debug webhook payload:', e && e.message ? e.message : String(e));
    return { path: null, hash: null };
  }
}

/** Helper: extract canonical ids from event */
function extractIds(event) {
  const project = event.project || (event.project_id ? { id: event.project_id } : null);
  const projectId = project && project.id;
  const pipelineId = (event.pipeline && event.pipeline.id) || (event.object_attributes && event.object_attributes.id) || (event.build && event.build.pipeline && event.build.pipeline.id) || event.pipeline_id || null;
  // job object may be under many keys depending on event type
  const job = event.build || event.job || event;
  const jobId = job && (job.id || job.build_id || event.build_id || job.job_id || null);
  const commitSha = event.checkout_sha || (event.commit && (event.commit.id || event.commit.sha)) || null;
  return { projectId, pipelineId, jobId, job, commitSha };
}

/** Analyze a single job (used by job event flow and pipeline loops) */
async function analyzeSingleJob(eventContext) {
  const { event, projectId, pipelineId, job, jobName, commitSha } = eventContext;

  // Use event.build_id first when calling getJobTrace to preserve existing semantics
  const buildIdParam = event && (event.build_id || null);
  const jobIdFallback = job && (job.id || job.build_id || job.job_id || null);

  if (!projectId) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'webhook.missing_project', event_summary: event && event.object_kind ? event.object_kind : 'unknown' }));
    return { status: 'ignored', reason: 'missing_project' };
  }

  // If both are missing, persist raw payload and bail out
  if (!buildIdParam && !jobIdFallback) {
    const { path: rawPath, hash: rawHash } = writeRawWebhookPayload(event);
    console.warn(JSON.stringify({ level: 'warn', msg: 'webhook.missing_job_id', projectId, pipelineId, raw_payload_hash: rawHash, raw_path: rawPath }));
    return { status: 'ignored', reason: 'missing_job_id', debug: { raw_payload_hash: rawHash, raw_path: rawPath } };
  }

  // Fetch job trace/logs — preserve build_id first per your existing flow
  let logs = '';
  try {
    // IMPORTANT: use event.build_id (buildIdParam) first, then fallback to jobIdFallback to remain compatible
    const traceJobId = buildIdParam || jobIdFallback;
    logs = await gitlabService.getJobTrace(projectId, traceJobId);
  } catch (err) {
    const { path: rawPath, hash: rawHash } = writeRawWebhookPayload(event);
    console.error(JSON.stringify({ level: 'error', msg: 'trace.fetch_failed', projectId, jobId: (event && event.build_id) || (job && job.id) || null, error: err && err.message ? err.message : String(err), raw_payload_hash: rawHash, raw_path: rawPath }));
    // fail-safe: respond with diagnostic; don't retry webhook infinitely
    return { status: 'failed', reason: 'failed_to_fetch_trace', error: err && err.message ? err.message : String(err), debug: { raw_payload_path: rawPath } };
  }

  // Sanitize and take tail excerpt (last N lines)
  const safeLog = logParser.sanitize(logs);
  const lines = safeLog.split('\n');
  const excerpt = lines.slice(-40).join('\n'); // last 40 lines for quick view
  const traceTail = lines.slice(-1200).join('\n'); // larger tail for analysis

  // compute trace hash and save run-level debug artifact
  const runDebugDir = path.join(process.cwd(), 'debug');
  try { fs.mkdirSync(runDebugDir, { recursive: true }); } catch (e) {}
  const traceHash = crypto.createHash('sha256').update(traceTail).digest('hex');
  const runDebugPath = path.join(runDebugDir, `run-${traceHash}.json`);
  try {
    const snapshot = {
      meta: { projectId, pipelineId, jobId: (event && event.build_id) || (job && job.id) || null, jobName, commitSha, traceHash },
      trace_tail: traceTail.slice(-10000) // keep limited
    };
    if (!fs.existsSync(runDebugPath)) {
      fs.writeFileSync(runDebugPath, JSON.stringify(snapshot, null, 2), 'utf8');
    }
  } catch (e) {
    console.warn('Failed to write run debug file:', e && e.message ? e.message : String(e));
  }

  // Deterministic detection via detectorService (fetch files at commit, verify matches, detect deps)
  let detectorResult = null;
  try {
    detectorResult = await detectorService.loadAndVerifyArtifacts({
      projectId,
      pipelineId,
      jobId: (event && event.build_id) || (job && job.id) || null,
      commitSha,
      traceTail
    });
    // store part of detector result to run debug file for audit
    try {
      const existing = JSON.parse(fs.readFileSync(runDebugPath, 'utf8'));
      existing.detector = { summary: { repoHits: (detectorResult.repoHits || []).length, dependencyHigh: (detectorResult.dependencyHigh || []).length } , details: detectorResult };
      fs.writeFileSync(runDebugPath, JSON.stringify(existing, null, 2), 'utf8');
    } catch (e) {
      // ignore write errors
    }
  } catch (e) {
    console.warn('Detector service failed:', e && e.message ? e.message : String(e));
    detectorResult = { repoHits: [], dependencyHigh: [], dependencyOther: [], error: e && e.message ? e.message : String(e) };
  }

  // Deterministic findings: secrets/dependencies
  if (Array.isArray(detectorResult.repoHits) && detectorResult.repoHits.some(h => h.verified)) {
    const verifiedHits = detectorResult.repoHits.filter(h => h.verified);
    const analysis = {
      stage: jobName || job.name || job.stage || 'unknown',
      root_cause: 'HARD_CODED_SECRET',
      suggested_fix: 'Remove hardcoded secrets from repository, rotate affected credentials, and use a secrets manager. See attached artifact for verified occurrences.',
      confidence: 0.99,
      explain: `Detected ${verifiedHits.length} verified hardcoded secret(s) in repository files at commit ${commitSha || 'unknown'}.`
    };
    const issue = await issueService.createIssueFromAnalysis(projectId, {
      pipelineId,
      job,
      analysis,
      logExcerpt: excerpt,
      commitSha
    });
    return { status: 'issue_created', reason: 'hardcoded_secret', issue };
  }

  if (Array.isArray(detectorResult.dependencyHigh) && detectorResult.dependencyHigh.length > 0) {
    const highDeps = detectorResult.dependencyHigh;
    const pkgList = highDeps.map(d => `${d.package}@${d.installed_version || 'unknown'}`).join(', ');
    const analysis = {
      stage: jobName || job.name || job.stage || 'unknown',
      root_cause: 'DEPENDENCY_VULNERABILITY',
      suggested_fix: `Upgrade affected packages: ${pkgList}. Refer to advisories included in detector findings.`,
      confidence: 0.95,
      explain: `Detected ${highDeps.length} high/critical dependency vulnerability(ies).`
    };
    const issue = await issueService.createIssueFromAnalysis(projectId, {
      pipelineId,
      job,
      analysis,
      logExcerpt: excerpt,
      commitSha
    });
    return { status: 'issue_created', reason: 'dependency_high', issue };
  }

  // Enforce: Only call AI for failed jobs!
  const jobStatus = (job && (job.status || job.state || '') || (event && (event.status || event.state || ''))).toLowerCase();
  if (jobStatus === 'success') {
    return { status: 'skipped', reason: 'success-no-deterministic-findings' };
  }

  // Double guard: Only failed jobs (not success, not any other case)
  if (jobStatus !== 'failed' && jobStatus !== 'canceled' && jobStatus !== 'manual') {
    // If job status can't be identified as failure, do not call AI
    return { status: 'skipped', reason: `job-status-${jobStatus}-not-failure` };
  }

  // === ONLY HERE: AI called ===
  console.log('[AI GUARD] Calling AI for failed job:', { projectId, pipelineId, jobId: (event && event.build_id) || (job && job.id) || null, jobStatus });
  let analysis = null;
  try {
    analysis = await aiService.analyzeFailure({
      projectId,
      pipelineId,
      jobId: (event && event.build_id) || (job && job.id) || null,
      jobName: jobName || job.name,
      logs: traceTail
    });
    // attach detector summary for audit
    analysis._detectorSummary = {
      repoHits: detectorResult.repoHits || [],
      dependencyHigh: detectorResult.dependencyHigh || [],
      dependencyOther: detectorResult.dependencyOther || []
    };
    // store AI result in debug run file
    try {
      const existing = JSON.parse(fs.readFileSync(runDebugPath, 'utf8'));
      existing.ai = { analysis: analysis };
      fs.writeFileSync(runDebugPath, JSON.stringify(existing, null, 2), 'utf8');
    } catch (e) {}
  } catch (err) {
    console.error('AI analyze failure:', err && err.message ? err.message : String(err));
    analysis = {
      stage: jobName || job.name,
      root_cause: 'AI_UNAVAILABLE',
      suggested_fix: 'Manual triage required',
      confidence: 0,
      explain: err && err.message ? err.message : String(err)
    };
  }

  // Create or append to issue (dedupe done inside service) — AI path
  try {
    const issue = await issueService.createIssueFromAnalysis(projectId, {
      pipelineId,
      job,
      analysis,
      logExcerpt: excerpt,
      commitSha
    });
    return { status: 'issue_created_ai', issue, analysis };
  } catch (err) {
    console.error('Failed to create/append issue (AI path):', err && err.message ? err.message : String(err));
    return { status: 'failed', reason: 'issue_creation_failed', error: err && err.message ? err.message : String(err) };
  }
}

router.post('/', async (req, res) => {
  try {
    const incomingToken = req.get('X-Gitlab-Token') || req.headers['x-gitlab-token'] || '';
    if (!validWebhookToken(incomingToken)) {
      console.warn(JSON.stringify({ level: 'warn', msg: 'webhook.invalid_token', ip: req.ip }));
      return res.status(401).json({ ok: false, message: 'invalid webhook token' });
    }

    const event = req.body;
    if (!event || typeof event !== 'object') {
      return res.status(200).json({ ok: true, msg: 'ignored' });
    }

    // --- JOB / BUILD event handling (preferred for per-job analysis) ---
    if (event.object_kind === 'build' || event.object_kind === 'job') {
      const job = event.build || event.job || event;
      const project = event.project || (event.project_id ? { id: event.project_id } : null);
      const projectId = project && project.id;
      const jobName = canonicalJobName(job) || '';

      // // Only analyze monitored job names
      // if (!MONITORED_JOB_NAMES.includes(jobName)) {
      //   return res.status(200).json({ ok: true, msg: 'job-not-monitored', job: jobName });
      // }
      const jobStage = job.stage || job.stage_name || job.build_stage || job.stageName || '';
      const isMonitoredByName = MONITORED_JOB_NAMES.length > 0 ? MONITORED_JOB_NAMES.includes(jobName) : false;
      const isMonitoredByStage = MONITORED_STAGES_NAMES.length > 0 ? MONITORED_STAGES_NAMES.includes((jobStage || '').toString()) : false;

      if (!isMonitoredByName && !isMonitoredByStage) {
        return res.status(200).json({ ok: true, msg: 'job-not-monitored', job: jobName, stage: jobStage });
      }
      
      // If job succeeded and success-analysis not enabled, maybe sample; otherwise skip
      const status = (job.status || job.state || '').toLowerCase();
      if (status === 'success' && !shouldSampleSuccess()) {
        return res.status(200).json({ ok: true, msg: 'success-sampled-out', job: jobName });
      }

      // Extract canonical ids and analyze this job
      const { projectId: pId, pipelineId, jobId, job: canonicalJob, commitSha } = extractIds(event);
      const ctx = { event, projectId: pId || projectId, pipelineId, job: canonicalJob, jobName, commitSha };
      const result = await analyzeSingleJob(ctx);

      // Respond 200 with a concise summary for webhook caller (do not expose sensitive info)
      return res.status(200).json({ ok: true, msg: 'job-analyzed', job: jobName, result: { status: result.status, reason: result.reason } });
    }

    // --- PIPELINE event handling (legacy / aggregate) ---
    if (event.object_kind === 'pipeline') {
      const projectId = event.project && event.project.id;
      const pipelineId = event.object_attributes && event.object_attributes.id;
      const status = (event.object_attributes && event.object_attributes.status || '').toLowerCase();

      // If pipeline failed -> analyze failed jobs (existing flow)
      if (status === 'failed') {
        const jobs = await gitlabService.getPipelineJobs(projectId, pipelineId);
        const failedJobs = jobs.filter(j => j.status === 'failed' || j.status === 'canceled' || j.status === 'manual');
        for (const job of failedJobs) {
          try {
            const ctx = { event, projectId, pipelineId, job, jobName: job.name, commitSha: event.checkout_sha || '' };
            // reuse the single-job analyzer
            await analyzeSingleJob(ctx);
          } catch (err) {
            console.error('Failed to analyze a failed job in pipeline:', err && err.message ? err.message : String(err));
            // continue analyzing other failed jobs
          }
        }
        return res.status(200).json({ ok: true, msg: 'pipeline-failed-analyzed' });
      }

      // If pipeline succeeded and analysis of successes is enabled: sample or analyze candidate monitored jobs
      if (status === 'success' && ENABLE_SUCCESS_PIPELINE_ANALYSIS && shouldSampleSuccess()) {
        const jobs = await gitlabService.getPipelineJobs(projectId, pipelineId);
        const candidateJobs = jobs.filter(j => MONITORED_JOB_NAMES.includes(j.name));
        for (const job of candidateJobs) {
          try {
            const ctx = { event, projectId, pipelineId, job, jobName: job.name, commitSha: event.checkout_sha || '' };
            await analyzeSingleJob(ctx);
          } catch (err) {
            console.error('Failed to analyze a job (pipeline success sampling):', err && err.message ? err.message : String(err));
            // continue with others
          }
        }
        return res.status(200).json({ ok: true, msg: 'pipeline-success-sampled' });
      }

      // default: ignore non-failed pipelines unless sampling enabled
      return res.status(200).json({ ok: true, msg: 'pipeline-ignored' });
    }

    // Other event types: ignore
    return res.status(200).json({ ok: true, msg: 'ignored-event-type' });

  } catch (err) {
    console.error('Webhook handler error:', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
});

module.exports = router;
