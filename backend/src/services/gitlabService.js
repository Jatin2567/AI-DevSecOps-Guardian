// backend/src/services/gitlabService.js
const fetch = require('node-fetch');

const GITLAB_API = process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4';
const TOKEN = process.env.GITLAB_TOKEN;

function authHeaders() {
  return { 'PRIVATE-TOKEN': TOKEN, 'Content-Type': 'application/json' };
}

async function getPipelineJobs(projectId, pipelineId) {
  const url = `${GITLAB_API}/projects/${encodeURIComponent(projectId)}/pipelines/${pipelineId}/jobs`;
  const res = await fetch(url, { headers: authHeaders() });
  return res.ok ? res.json() : Promise.reject(new Error('Failed to fetch jobs'));
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
  return res.json();
}

module.exports = {
  getPipelineJobs,
  getJobTrace,
  createIssue
};
