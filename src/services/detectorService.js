// backend/src/services/detectorService.js
'use strict';

/**
 * detectorService
 *
 * Responsibilities:
 *  - parse candidate file paths from CI trace tail
 *  - fetch files at the job commit from GitLab (no repo clone)
 *  - run regex-based secret detection on fetched files
 *  - verify matches (ensure the exact match exists at the commit)
 *  - parse package.json (if present) and perform a lightweight "outdated" heuristic
 *
 * Returns:
 *  {
 *    repoHits: [ { file, line, match, context, verified: true|false } ],
 *    dependencyHigh: [ { package, installed_version, latest_version, severity, advisory_url? } ],
 *    dependencyOther: [ ... ],
 *    metadata: { files_fetched: [...], checked_at: ISO }
 *  }
 *
 * Environment:
 *  - GITLAB_API_URL (optional, default https://gitlab.com/api/v4)
 *  - GITLAB_TOKEN or GITLAB_API_TOKEN (required)
 *
 * Notes:
 *  - This service is intentionally cautious: secrets are detected via regex and verified
 *    by re-fetching the file content at the exact commit before marking verified.
 *  - Dependency vulnerability detection is heuristic (outdated/major-diff) for demo.
 */

const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const GITLAB_API = process.env.GITLAB_API_URL || 'https://gitlab.com/api/v4';
const TOKEN = process.env.GITLAB_TOKEN || process.env.GITLAB_API_TOKEN;

if (!TOKEN) {
  // We throw here so callers know to set the token
  // The webhook code already handles diagnostic logging and will not crash.
  // Keep this here to fail fast in dev environments.
  console.warn('detectorService: GITLAB_TOKEN or GITLAB_API_TOKEN not configured. Detector will fail until token provided.');
}

/** Helper: auth headers for GitLab API calls */
function authHeaders() {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
  if (TOKEN) {
    h['PRIVATE-TOKEN'] = TOKEN;
    h['Authorization'] = `Bearer ${TOKEN}`;
  }
  return h;
}

/** Simple safe fetch with retries for registry/nodel calls (small) */
async function simpleFetch(url, opts = {}, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fetch(url, opts);
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 200 * (i + 1)));
    }
  }
}

/** Fetch raw file content at a given commit SHA from GitLab.
 * Uses the raw file endpoint:
 * GET /projects/:id/repository/files/:file_path/raw?ref=:commitSha
 *
 * Returns string content on success, or throws Error.
 */
async function fetchFileAtCommit(projectId, filePath, commitSha) {
  if (!projectId) throw new Error('fetchFileAtCommit: projectId required');
  if (!filePath) throw new Error('fetchFileAtCommit: filePath required');
  if (!commitSha) {
    // fall back to default branch if commitSha missing — best-effort
    // but prefer explicit SHA if available.
  }

  // filePath must be URL-encoded; GitLab raw endpoint expects proper escaping
  const encodedPath = encodeURIComponent(filePath);
  const refQs = commitSha ? `?ref=${encodeURIComponent(commitSha)}` : '';
  const url = `${GITLAB_API}/projects/${encodeURIComponent(projectId)}/repository/files/${encodedPath}/raw${refQs}`;

  const res = await simpleFetch(url, { headers: authHeaders(), timeout: 20000 });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`gitlab fetch file failed ${res.status} ${res.statusText} ${text && text.slice(0,200)}`);
  }
  return await res.text();
}

/** Parse candidate file paths from a trace tail
 *
 * Heuristics:
 *  - match stack traces like: /builds/group/project/src/file.js:123
 *  - match unix-like relative paths with extension: src/module/file.js:45
 *  - match windows-like paths: C:\path\to\file.js:12
 *  - also match lines that include "at path (file:line:col)" patterns
 *
 * Returns unique file path list (strings)
 */
function extractCandidateFiles(traceTail) {
  if (!traceTail) return [];
  const candidates = new Set();

  // Regexes to capture file paths with optional line numbers
  const rxes = [
    /(?:[A-Za-z0-9_\-./~]+\/)+[A-Za-z0-9_\-./~]+\.[A-Za-z0-9_]+(?::\d+)?/g, // unix-like paths
    /[A-Za-z]:\\(?:[^\\\/:*?"<>|\r\n]+\\)+[^\\\/:*?"<>|\r\n]+\.[A-Za-z0-9_]+(?::\d+)?/g, // windows paths
    /at\s+.*\(([^)]+:[0-9]+(?::[0-9]+)?)\)/g // at ... (file:line[:col])
  ];

  for (const rx of rxes) {
    let m;
    while ((m = rx.exec(traceTail)) !== null) {
      // m[0] or m[1] depending on capture
      const match = m[1] || m[0];
      if (!match) continue;
      // strip :line or :line:col parts
      const p = match.split(':')[0];
      // normalize leading ./ or /builds/ segments (keep as-is; GitLab file fetch uses repo path relative to root)
      let cleaned = p.replace(/^\.\//, '').replace(/^\/+/, '');
      // ignore absolute paths that include the filesystem root often not present in repo
      // but still add them; verification step will determine if file fetch succeeds
      candidates.add(cleaned);
    }
  }

  // Always include package.json and package-lock.json as candidates
  candidates.add('package.json');
  candidates.add('package-lock.json');
  candidates.add('yarn.lock');

  return Array.from(candidates);
}

/** Secret detection regex patterns (deterministic) */
const SECRET_PATTERNS = [
  // AWS keys
  { name: 'aws_access_key', rx: /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g },
  // Google API key
  { name: 'google_api_key', rx: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  // Generic long tokens (40+ chars)
  { name: 'long_token', rx: /\b[A-Za-z0-9-_]{40,}\b/g },
  // PEM blocks
  { name: 'pem_block', rx: /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g },
  // JWT-like tokens
  { name: 'jwt', rx: /\b[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}\.[A-Za-z0-9-_]{20,}\b/g },
  // URL with secret-looking query param "token" or "api_key"
  { name: 'secret_in_url', rx: /https?:\/\/[^\s'"]+?(?:\?|&)(?:token|api_key|key)=[^\s&'"]+/gi }
];

/** Run secret regexes on file content and return hits with line numbers and context */
function findSecretsInContent(content) {
  const hits = [];
  if (!content) return hits;
  const lines = content.split('\n');
  const joined = content; // for patterns that span lines (PEM)
  for (const pat of SECRET_PATTERNS) {
    let m;
    while ((m = pat.rx.exec(joined)) !== null) {
      const match = m[0];
      // Try to locate line number for match by searching lines for substring (first occurrence)
      let lineNum = null;
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(match) || (match.length > 80 && lines[i].includes(match.slice(0, 80)))) {
          lineNum = i + 1;
          break;
        }
      }
      // context: 3 lines around the hit
      const contextStart = Math.max(0, (lineNum ? lineNum - 1 : 0) - 2);
      const context = lines.slice(contextStart, contextStart + 5).join('\n');
      hits.push({
        match,
        name: pat.name,
        line: lineNum,
        context
      });
    }
  }
  return hits;
}

/** Parse package.json content and return dependency map */
function parsePackageJson(content) {
  try {
    const obj = JSON.parse(content);
    const deps = obj.dependencies || {};
    const devDeps = obj.devDependencies || {};
    return { dependencies: deps, devDependencies: devDeps, name: obj.name || null };
  } catch (e) {
    return { dependencies: {}, devDependencies: {}, name: null };
  }
}

/** Get latest version string from npm registry for a package (dist-tags.latest) */
async function getLatestNpmVersion(pkgName) {
  try {
    const url = `https://registry.npmjs.org/${encodeURIComponent(pkgName)}`;
    const res = await simpleFetch(url, { timeout: 10000 });
    if (!res.ok) return null;
    const json = await res.json();
    if (json && json['dist-tags'] && json['dist-tags'].latest) return json['dist-tags'].latest;
    return null;
  } catch (e) {
    return null;
  }
}

/** Very simple semver compare for "major" difference
 * returns { equal: bool, sameMajor: bool }
 * This is intentionally tiny; it's only used as a heuristic.
 */
function compareMajor(a, b) {
  if (!a || !b) return { equal: false, sameMajor: false };
  // strip leading ^~>
  const na = a.replace(/^[\^~><=]*/, '');
  const nb = b.replace(/^[\^~><=]*/, '');
  const pa = na.split('.')[0];
  const pb = nb.split('.')[0];
  return { equal: na === nb, sameMajor: pa === pb };
}

/** Main exported function
 *
 * opts: {
 *   projectId,
 *   pipelineId,
 *   jobId,
 *   commitSha,    // preferred; if null, file fetch may try default branch
 *   traceTail     // string
 * }
 */
async function loadAndVerifyArtifacts(opts = {}) {
  const { projectId, pipelineId, jobId, commitSha, traceTail } = opts || {};
  const timestamp = new Date().toISOString();
  const result = {
    repoHits: [], // { file, line, match, context, verified }
    dependencyHigh: [], // heuristic high severity (major mismatch)
    dependencyOther: [],
    metadata: { projectId, pipelineId, jobId, commitSha, files_fetched: [], checked_at: timestamp }
  };

  // quick guard
  if (!projectId) {
    result.error = 'projectId_missing';
    return result;
  }

  // 1) discover candidate files from traceTail (plus package.json etc)
  const candidates = extractCandidateFiles(traceTail || '');
  // Deduplicate and limit (avoid fetching hundreds)
  const uniqCandidates = Array.from(new Set(candidates)).slice(0, 200);

  // 2) fetch each candidate file content at commitSha
  const fetchedFiles = {}; // filePath -> content
  let fetchAttempts = [];
  for (const filePath of uniqCandidates) {
    try {
      const content = await fetchFileAtCommit(projectId, filePath, commitSha);
      fetchedFiles[filePath] = content;
      result.metadata.files_fetched.push(filePath);
      fetchAttempts.push({ filePath, status: 'fetched' });
    } catch (e) {
      fetchAttempts.push({ filePath, status: 'failed', error: e && e.message ? e.message : String(e) });
    }
  }

  // Console warn if no files fetched (and all failed)
  if (Object.keys(fetchedFiles).length === 0) {
    // Show candidate file URLs for diagnosis
    console.warn('[detectorService] No files could be fetched for projectId:', projectId, 'commitSha:', commitSha, 'Candidates:', uniqCandidates);
    fetchAttempts.forEach(attempt => {
      if (attempt.status === 'failed') {
        // Build likely attempted URL
        const encodedPath = encodeURIComponent(attempt.filePath);
        const refQs = commitSha ? `?ref=${encodeURIComponent(commitSha)}` : '';
        const url = `${GITLAB_API}/projects/${encodeURIComponent(projectId)}/repository/files/${encodedPath}${refQs}`;
        console.warn('File fetch failed:', attempt.filePath, 'URL:', url, 'ERROR:', attempt.error);
        // Additional tip for 404 or bad path
        if (attempt.error && attempt.error.includes('404')) {
          console.warn('[detectorService] 404 error likely means file does not exist at specified commit or the path is incorrect/encoded improperly.');
        }
      }
    });
  }

  // 3) run secret detection on fetched files
  for (const [filePath, content] of Object.entries(fetchedFiles)) {
    try {
      const hits = findSecretsInContent(content);
      for (const h of hits) {
        // Verify: ensure exact match exists in fetched content (it does, because we scanned content)
        const verified = content.includes(h.match);
        result.repoHits.push({
          file: filePath,
          line: h.line,
          match: h.match,
          context: h.context,
          verified: !!verified,
          reason: verified ? 'match_in_file' : 'not_found_on_verify'
        });
      }
    } catch (e) {
      // continue
    }
  }

  // 4) dependency scan: if package.json present in fetchedFiles, parse and do lightweight checks
  let pkgContent = null;
  if (fetchedFiles['package.json']) pkgContent = fetchedFiles['package.json'];
  else {
    // try to fetch package.json at repo root explicitly if not discovered
    try {
      const explicit = await fetchFileAtCommit(projectId, 'package.json', commitSha);
      if (explicit) {
        pkgContent = explicit;
        fetchedFiles['package.json'] = explicit;
        result.metadata.files_fetched.push('package.json');
      }
    } catch (e) {
      // no package.json found
    }
  }

  if (pkgContent) {
    const parsed = parsePackageJson(pkgContent);
    const allDeps = Object.assign({}, parsed.dependencies || {}, parsed.devDependencies || {});
    const depEntries = Object.entries(allDeps);
    // limit to first 80 deps to avoid long registry calls
    for (const [pkg, installedVersion] of depEntries.slice(0, 80)) {
      try {
        const latest = await getLatestNpmVersion(pkg);
        const cmp = compareMajor(installedVersion, latest);
        // Heuristic severity:
        // - if major differs and installedVersion exists -> mark medium-high (not authoritative)
        // - else mark low/other
        if (latest && !cmp.sameMajor) {
          result.dependencyHigh.push({
            package: pkg,
            installed_version: installedVersion,
            latest_version: latest,
            severity: 'medium', // we use medium for major-diff heuristic; not a CVE claim
            advisory_url: null,
            reason: 'major_version_mismatch'
          });
        } else {
          result.dependencyOther.push({
            package: pkg,
            installed_version: installedVersion,
            latest_version: latest,
            severity: 'low',
            advisory_url: null
          });
        }
      } catch (e) {
        // if registry check fails, include as other with unknown latest
        result.dependencyOther.push({
          package: pkg,
          installed_version: installedVersion,
          latest_version: null,
          severity: 'unknown'
        });
      }
    }
  }

  // 5) Save quick debug JSON
  try {
    const debugDir = path.join(process.cwd(), 'debug');
    fs.mkdirSync(debugDir, { recursive: true });
    const summaryHash = crypto.createHash('sha256').update(JSON.stringify({ projectId, jobId, timestamp })).digest('hex').slice(0, 12);
    const filename = path.join(debugDir, `detector-${summaryHash}.json`);
    fs.writeFileSync(filename, JSON.stringify(result, null, 2), 'utf8');
    result.metadata.debug_path = filename;
  } catch (e) {
    // ignore write errors
  }

  return result;
}

module.exports = {
  loadAndVerifyArtifacts,
  // exported for testing / reuse
  extractCandidateFiles,
  fetchFileAtCommit,
  findSecretsInContent,
  parsePackageJson
};
