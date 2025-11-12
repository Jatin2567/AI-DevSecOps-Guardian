// backend/src/routes/webhook.js
const express = require('express');
const router = express.Router();
const gitlabService = require('../services/gitlabService');
const aiService = require('../services/aiService');
const issueService = require('../services/issueService');
const logParser = require('../utils/logParser');

router.post('/', async (req, res) => {
  try {
    const event = req.body; // assume GitLab pipeline event
    // Basic validation
    if (!event.object_kind || event.object_kind !== 'pipeline') {
      return res.status(200).send({ ok: true, msg: 'ignored' });
    }

    const projectId = event.project.id;
    const pipelineId = event.object_attributes.id;
    const status = event.object_attributes.status;

    if (status !== 'failed') {
      return res.status(200).send({ ok: true, msg: 'no-failure' });
    }

    // Fetch failing jobs for pipeline
    const jobs = await gitlabService.getPipelineJobs(projectId, pipelineId);
    const failedJobs = jobs.filter(j => j.status === 'failed');

    for (const job of failedJobs) {
      const logs = await gitlabService.getJobTrace(projectId, job.id);
      const safeLog = logParser.sanitize(logs);
      // ask the AI for structured analysis
      const analysis = await aiService.analyzeFailure({
        projectId, pipelineId, jobId: job.id, jobName: job.name, logs: safeLog
      });

      // create issue with analysis
      const issue = await issueService.createIssueFromAnalysis(projectId, {
        pipelineId, job, analysis
      });

      // persist/notify (DB or message bus) - omitted for brevity
    }

    return res.status(200).send({ ok: true });
  } catch (err) {
    console.error('Webhook error', err);
    return res.status(500).send({ ok: false, error: err.message });
  }
});

module.exports = router;
