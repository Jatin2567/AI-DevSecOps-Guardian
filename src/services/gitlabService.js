// backend/src/services/gitlabService.js
const fetch = require('node-fetch');
const { fetchWithRetries } = require('../utils/');

const GITLAB_API = process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4';
const TOKEN = process.env.GITLAB_TOKEN;

function authHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (!TOKEN) throw new Error('GITLAB_TOKEN not configured');
  headers['PRIVATE-TOKEN'] = TOKEN;
  headers['Authorization'] = `Bearer ${TOKEN}`;
  return headers;
}

async function getPipelineJobs(projectId, pipelineId) {
  const perPage = 100;
  let page = 1;
  const allJobs = [];
  for (;;) {
    const url = `${GITLAB_API}/projects/${encodeURIComponent(projectId)}/pipelines/${pipelineId}/jobs?per_page=${perPage}&page=${page}`;
    const res = await fetchWithRetries(url, { headers: authHeaders() });
    if (!res.ok) throw new Error(`Failed to fetch jobs: ${res.status}`);
    const jobs = await res.json();
    if (!Array.isArray(jobs) || jobs.length === 0) break;
    allJobs.push(...jobs);
    if (jobs.length < perPage) break;
    page++;
  }
  return allJobs;
}

async function getJobTrace(projectId, jobId) {
  const url = `${GITLAB_API}/projects/${encodeURIComponent(projectId)}/jobs/${jobId}/trace`;
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) throw new Error('Failed to fetch job trace');
  return res.text();
}

async function createIssue(projectId, title, description, labels = []) {
  const url = `${GITLAB_API}/projects/${encodeURIComponent(projectId)}/issues`;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ title, description, labels: labels.join(',') })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to create issue: ${res.status} ${text}`);
  }
  return res.json();
}

async function createIssueComment(projectId, issueIid, body) {
  const url = `${GITLAB_API}/projects/${encodeURIComponent(projectId)}/issues/${issueIid}/notes`;
  const res = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ body })
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to add comment: ${res.status} ${text}`);
  }
  return res.json();
}

/**
 * Search open issues using GitLab search API.
 * Note: search matches title/body; keep fingerprint short and unique.
 */
async function searchOpenIssues(projectId, search) {
  const url = `${GITLAB_API}/projects/${encodeURIComponent(projectId)}/issues?state=opened&search=${encodeURIComponent(search)}&per_page=20`;
  const res = await fetchWithRetries(url, { headers: authHeaders() });
  if (!res.ok) throw new Error(`Failed to search issues: ${res.status}`);
  return res.json();
}

module.exports = {
  getPipelineJobs,
  getJobTrace,
  createIssue,
  searchOpenIssues,
  createIssueComment
};
