const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const gitlabService = require('../services/gitlabService');
const aiService = require('../services/aiService');
const issueService = require('../services/issueService');
const logParser = require('../utils/logParser');
const detectorService = require('../services/detectorService'); 

const WEBHOOK_SECRET = process.env.GITLAB_WEBHOOK_SECRET || '';
const MONITORED_JOB_NAMES = (process.env.MONITORED_JOB_NAMES || 'lint,test,build')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const MONITORED_STAGES_NAMES = (process.env.MONITORED_STAGES || 'lint,test,build')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

function validWebhookToken(incoming) {
  if (!WEBHOOK_SECRET) return true; 
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



function canonicalJobName(job) {

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
    if (!fs.existsSync(filename)) {
      fs.writeFileSync(filename, raw, { encoding: 'utf8' });
    }
    return { path: filename, hash };
  } catch (e) {
    console.warn('Failed to write debug webhook payload:', e && e.message ? e.message : String(e));
    return { path: null, hash: null };
  }
}

function extractIds(event) {
  const project = event.project || (event.project_id ? { id: event.project_id } : null);
  const projectId = project && project.id;
  const pipelineId = (event.pipeline && event.pipeline.id) || (event.object_attributes && event.object_attributes.id) || (event.build && event.build.pipeline && event.build.pipeline.id) || event.pipeline_id || null;
  // job object may be under many keys depending on event type
  const job = event.build || event.job || event;
  const jobId = job && (job.id || job.build_id || event.build_id || job.job_id || null);
  const commitSha = event.commit.sha || null;
  return { projectId, pipelineId, jobId, job, commitSha };
}


async function analyzeSingleJob(eventContext) {
  const { event, projectId, pipelineId, job, jobName, commitSha } = eventContext;
  console.log('[ANALYZE] Start', {
    projectId,
    pipelineId,
    jobId: job && (job.id || job.build_id || job.job_id),
    jobName,
    commitSha
  });


  const buildIdParam = event && (event.build_id || null);
  const jobIdFallback = job && (job.id || job.build_id || job.job_id || null);

  if (!projectId) {
    console.warn(JSON.stringify({ level: 'warn', msg: 'webhook.missing_project', event_summary: event && event.object_kind ? event.object_kind : 'unknown' }));
    return { status: 'ignored', reason: 'missing_project' };
  }


  if (!buildIdParam && !jobIdFallback) {
    const { path: rawPath, hash: rawHash } = writeRawWebhookPayload(event);
    console.warn(JSON.stringify({ level: 'warn', msg: 'webhook.missing_job_id', projectId, pipelineId, raw_payload_hash: rawHash, raw_path: rawPath }));
    return { status: 'ignored', reason: 'missing_job_id', debug: { raw_payload_hash: rawHash, raw_path: rawPath } };
  }


  let logs = '';
  try {
    const traceJobId = buildIdParam || jobIdFallback;
    logs = await gitlabService.getJobTrace(projectId, traceJobId);
  } catch (err) {
    const { path: rawPath, hash: rawHash } = writeRawWebhookPayload(event);
    console.error(JSON.stringify({ level: 'error', msg: 'trace.fetch_failed', projectId, jobId: (event && event.build_id) || (job && job.id) || null, error: err && err.message ? err.message : String(err), raw_payload_hash: rawHash, raw_path: rawPath }));
    return { status: 'failed', reason: 'failed_to_fetch_trace', error: err && err.message ? err.message : String(err), debug: { raw_payload_path: rawPath } };
  }


  const safeLog = logParser.sanitize(logs);
  const lines = safeLog.split('\n');
  const excerpt = lines.slice(-40).join('\n'); 
  const traceTail = lines.slice(-1200).join('\n'); 


  const runDebugDir = path.join(process.cwd(), 'debug');
  try { fs.mkdirSync(runDebugDir, { recursive: true }); } catch (e) {}
  const traceHash = crypto.createHash('sha256').update(traceTail).digest('hex');
  const runDebugPath = path.join(runDebugDir, `run-${traceHash}.json`);
  try {
    const snapshot = {
      meta: { projectId, pipelineId, jobId: (event && event.build_id) || (job && job.id) || null, jobName, commitSha, traceHash },
      trace_tail: traceTail.slice(-10000) 
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
    console.log('[DETECTOR] Completed', {
      projectId,
      pipelineId,
      jobId: (event && event.build_id) || (job && job.id) || null,
      repoHits: (detectorResult.repoHits || []).length,
      dependencyHigh: (detectorResult.dependencyHigh || []).length
    });
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

  const jobStatus = (event.build_status|| '').toLowerCase();

  if (jobStatus === 'success' || jobStatus === 'running') {
    // START: AI-on-success conditions block ----
    // Patterns and threshold for 'suspicious' successful jobs
    const suspiciousPatterns = [
      /flaky/i,
      /deprecation warning/i,
      /deprecated/i,
      /out of memory/i,
      /memory leak/i,
      /retrying/i,
      /could not resolve dependency/i,
      /npm WARN/i,
      /disk quota/i,
      /no space left on device/i,
      /rate limit/i,
      /429/i,
      /throttled/i,
      /skipped/i,
      /quarantined/i,
      /pending/i,
      /build succeeded with warnings/i
    ];

    const matched = suspiciousPatterns.some(pattern => pattern.test(traceTail));
    const warningCount = (traceTail.match(/warn/gi) || []).length;

    if (matched || warningCount > 2) {
      console.log('[AI GUARD] Success job triggers AI', {
        projectId,
        pipelineId,
        jobId: (event && event.build_id) || (job && job.id) || null,
        warningCount,
        matchedPattern: matched
      });
      let analysis = null;
      try {
        analysis = await aiService.analyzeFailure({
          projectId,
          pipelineId,
          jobId: (event && event.build_id) || (job && job.id) || null,
          jobName: jobName || job.name,
          logs: traceTail
        });
        analysis._detectorSummary = { repoHits: detectorResult.repoHits || [], dependencyHigh: detectorResult.dependencyHigh || [], dependencyOther: detectorResult.dependencyOther || [] };
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
      try {
        const issue = await issueService.createIssueFromAnalysis(event , projectId, {
          pipelineId,
          job,
          analysis,
          logExcerpt: excerpt,
          commitSha
        });
        console.log('[ISSUE] Created for success job', {
          projectId,
          pipelineId,
          jobId: (event && event.build_id) || (job && job.id) || null,
          issueId: issue && issue.iid
        });
        return { status: 'issue_created_ai_success', issue, analysis };
      } catch (err) {
        console.error('Failed to create/append issue (AI path - success):', err && err.message ? err.message : String(err));
        return { status: 'failed', reason: 'issue_creation_failed_success', error: err && err.message ? err.message : String(err) };
      }
    }
    // END: AI-on-success conditions block
    console.log('[ANALYZE] Success job skipped (no suspicious signals)', {
      projectId,
      pipelineId,
      jobId: (event && event.build_id) || (job && job.id) || null,
      warningCount
    });
    return { status: 'skipped', reason: 'success-no-deterministic-findings-or-ai-triggers' };
  }

  // Double guard: Only failed jobs (not success, not any other case)
  if (jobStatus !== 'failed' && jobStatus !== 'canceled' && jobStatus !== 'manual') {
    // If job status can't be identified as failure, do not call AI
    console.log('[ANALYZE] Job skipped (non failure state)', {
      projectId,
      pipelineId,
      jobId: (event && event.build_id) || (job && job.id) || null,
      jobStatus
    });
    return { status: 'skipped', reason: `job-status-${jobStatus}-not-failure` };
  }

  // === ONLY HERE: AI called ===
  console.log('[AI GUARD] Failure job triggers AI', { projectId, pipelineId, jobId: (event && event.build_id) || (job && job.id) || null, jobStatus });
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
    const issue = await issueService.createIssueFromAnalysis(event , projectId, {
      pipelineId,
      job,
      analysis,
      logExcerpt: excerpt,
      commitSha
    });
    console.log('[ISSUE] Created for failed job', {
      projectId,
      pipelineId,
      jobId: (event && event.build_id) || (job && job.id) || null,
      issueId: issue && issue.iid
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

    if (event.object_kind === 'build' || event.object_kind === 'job') {
      const job = event.build || event.job || event;
      const project = event.project || (event.project_id ? { id: event.project_id } : null);
      const projectId = project && project.id;
      const jobName = canonicalJobName(job) || '';


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
