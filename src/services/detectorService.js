'use strict';

async function loadAndVerifyArtifacts(opts = {}) {
  const { projectId, pipelineId, jobId, commitSha } = opts || {};
  const timestamp = new Date().toISOString();
  return {
    repoHits: [],
    dependencyHigh: [],
    dependencyOther: [],
    metadata: { projectId, pipelineId, jobId, commitSha, checked_at: timestamp }
  };
}


module.exports = {
  loadAndVerifyArtifacts,
};
