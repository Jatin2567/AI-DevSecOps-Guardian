// backend/src/routes/webhook.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');

const gitlabService = require('../services/gitlabService');
const aiService = require('../services/aiService');
const issueService = require('../services/issueService');
const logParser = require('../utils/logParser');

const WEBHOOK_SECRET = process.env.GITLAB_WEBHOOK_SECRET || '';
// MONITORED_JOB_NAMES env: comma-separated list (e.g. "unit_tests,lint,ai_scan")
const MONITORED_JOB_NAMES = (process.env.MONITORED_JOB_NAMES || 'unit_tests,lint,ai_scan')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// whether to analyze successful jobs/pipelines (string '1' means enabled)
const ENABLE_SUCCESS_PIPELINE_ANALYSIS = String(process.env.ENABLE_SUCCESS_PIPELINE_ANALYSIS || '0') === '1';

// sample 1 in N successful runs (integer >=1). If 1 => analyze every success. If 10 => analyze ~10% of successes.
const ANALYZE_SUCCESS_SAMPLING = Math.max(1, parseInt(process.env.ANALYZE_SUCCESS_SAMPLING || '1', 10));

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
  if (ANALYZE_SUCCESS_SAMPLING <= 1) return true; // analyze every successful job
  // random sampling: approximate 1 in N
  return (Math.floor(Math.random() * ANALYZE_SUCCESS_SAMPLING) === 0);
}

/** Helper: canonicalize job name */
function canonicalJobName(job) {
  // job may have different fields depending on event type
  return job && (job.name || job.build_name || job.stage || job.job_name) ? (job.name || job.build_name || job.stage || job.job_name) : '';
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
      const isMonitoredByStage = MONITORED_STAGES.length > 0 ? MONITORED_STAGES.includes((jobStage || '').toString()) : false;

      if (!isMonitoredByName && !isMonitoredByStage) {
        return res.status(200).json({ ok: true, msg: 'job-not-monitored', job: jobName, stage: jobStage });
      }
      
      // If job succeeded and success-analysis not enabled, maybe sample; otherwise skip
      const status = (job.status || job.state || '').toLowerCase();
      if (status === 'success' && !shouldSampleSuccess()) {
        return res.status(200).json({ ok: true, msg: 'success-sampled-out', job: jobName });
      }

      // Fetch job trace/logs
      let logs = '';
      try {
        logs = await gitlabService.getJobTrace(projectId, job.id);
      } catch (err) {
        console.error('Failed to fetch job trace:', err.message);
        // fail-safe: respond 200 so webhook is not retried infinitely; also create a triage alert if necessary
        return res.status(200).json({ ok: false, msg: 'failed_to_fetch_trace', error: err.message });
      }

      const safeLog = logParser.sanitize(logs);
      const excerpt = safeLog.split('\n').slice(0, 40).join('\n'); // first 40 lines

      // Call AI analyzer
      let analysis;
      try {
        analysis = await aiService.analyzeFailure({
          projectId,
          pipelineId: event.pipeline ? event.pipeline.id : (event.build && event.build.pipeline ? event.build.pipeline : undefined),
          jobId: job.id,
          jobName: jobName,
          logs: safeLog
        });
      } catch (err) {
        console.error('AI analyze failure:', err.message);
        analysis = {
          stage: jobName,
          root_cause: 'AI_UNAVAILABLE',
          suggested_fix: 'Manual triage required',
          confidence: 0,
          explain: err.message
        };
      }

      // Create or append to issue (dedupe done inside service)
      try {
        const commitSha = event.checkout_sha || (event.commit && (event.commit.id || event.commit.sha)) || '';
        const issue = await issueService.createIssueFromAnalysis(projectId, {
          pipelineId: event.pipeline ? event.pipeline.id : (job.pipeline && job.pipeline ? job.pipeline : undefined),
          job,
          analysis,
          logExcerpt: excerpt,
          commitSha
        });
        // log result for visibility
        if (issue && issue.issue_iid) {
          console.log('✓ Issue created/found:', issue.issue_iid);
        } else if (issue && issue.existing) {
          console.log('✓ Existing issue appended:', issue.issue_iid);
        } else {
          console.log('✓ Issue service returned:', issue);
        }
      } catch (err) {
        console.error('Failed to create/append issue:', err.message);
      }

      return res.status(200).json({ ok: true, msg: 'job-analyzed', job: jobName });
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
            const logs = await gitlabService.getJobTrace(projectId, job.id);
            const safeLog = logParser.sanitize(logs);
            const excerpt = safeLog.split('\n').slice(0, 40).join('\n');

            let analysis;
            try {
              analysis = await aiService.analyzeFailure({
                projectId,
                pipelineId,
                jobId: job.id,
                jobName: job.name,
                logs: safeLog
              });
            } catch (err) {
              console.error('AI analyze failure (pipeline failed branch):', err.message);
              analysis = {
                stage: job.name,
                root_cause: 'AI_UNAVAILABLE',
                suggested_fix: 'Manual triage required',
                confidence: 0,
                explain: err.message
              };
            }

            await issueService.createIssueFromAnalysis(projectId, {
              pipelineId,
              job,
              analysis,
              logExcerpt: excerpt,
              commitSha: event.checkout_sha || ''
            });
          } catch (err) {
            console.error('Failed to analyze a failed job in pipeline:', err.message);
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
            const logs = await gitlabService.getJobTrace(projectId, job.id);
            const safeLog = logParser.sanitize(logs);
            const excerpt = safeLog.split('\n').slice(0, 40).join('\n');

            let analysis;
            try {
              analysis = await aiService.analyzeFailure({
                projectId,
                pipelineId,
                jobId: job.id,
                jobName: job.name,
                logs: safeLog
              });
            } catch (err) {
              console.error('AI analyze failure (pipeline success sampling):', err.message);
              analysis = {
                stage: job.name,
                root_cause: 'AI_UNAVAILABLE',
                suggested_fix: 'Manual triage required',
                confidence: 0,
                explain: err.message
              };
            }

            await issueService.createIssueFromAnalysis(projectId, {
              pipelineId,
              job,
              analysis,
              logExcerpt: excerpt,
              commitSha: event.checkout_sha || ''
            });
          } catch (err) {
            console.error('Failed to analyze a job (pipeline success sampling):', err.message);
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
