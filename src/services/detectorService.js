// backend/src/services/detectorService.js
'use strict';

/**
 * detectorService
 * Minimal no-op implementation: always returns empty findings, so AI is always used.
 * All previous detection, fetching and regex logic is commented out for clarity and future enhancements.
 */

// const fetch = require('node-fetch');
// const path = require('path');
// const fs = require('fs');
// const crypto = require('crypto');

// const GITLAB_API = process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4';
// const TOKEN = process.env.GITLAB_TOKEN || process.env.GITLAB_API_TOKEN;

// Old helpers for matching, fetching files, and regex detection are commented out below.

/**
 * Main exported function: always returns empty findings.
 * This satisfies interface for AI-only (logs-only) operation.
 */
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

// Export legacy helpers for possible future reactivation (all are unused):
// function extractCandidateFiles(traceTail) { ... }
// function fetchFileAtCommit(projectId, filePath, commitSha) { ... }
// function findSecretsInContent(content) { ... }
// function parsePackageJson(content) { ... }

module.exports = {
  loadAndVerifyArtifacts,
  // extractCandidateFiles,
  // fetchFileAtCommit,
  // findSecretsInContent,
  // parsePackageJson
};
