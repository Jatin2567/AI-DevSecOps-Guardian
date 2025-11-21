// backend/src/services/issueService.js
const gitlab = require('./gitlabService');
const { makeFingerprint, normStr, isValidAnalysis } = require('../utils/aiHelpers');
const fpStore = require('../db/fingerprintStore');

const MIN_CONF_TO_AUTOCREATE = Number(process.env.MIN_CONF_CREATE || 0.6);
const GITLAB_BASE_URL = process.env.GITLAB_BASE_URL || 'https://gitlab.com';

/**
 * Verify AI-provided file/line claim by fetching the file at commitSha and ensuring
 * the claimed snippet or at least the claimed line exists.
 *
 * analysis may contain fields like: analysis.file, analysis.line, analysis.match (optional)
 *
 * Returns { verified: boolean, reason?: string }
 */
async function verifyFileClaim({ projectId, filePath, line, match, commitSha }) {
  if (!projectId || !filePath || !commitSha) {
    return { verified: false, reason: 'missing_parameters' };
  }

  try {
    const content = await gitlab.getFileAtCommit(projectId, filePath, commitSha);
    if (!content) return { verified: false, reason: 'file_not_found_at_commit' };

    const lines = content.split('\n');
    const lineno = Number(line) || null;
    if (lineno && lines[lineno - 1] !== undefined) {
      const lineContent = lines[lineno - 1];
      if (!match) {
        // if no explicit match provided, presence of the line is acceptable evidence
        return { verified: true, reason: 'line_exists' };
      }
      if (lineContent.includes(match) || content.includes(match)) {
        return { verified: true, reason: 'match_found' };
      }
      return { verified: false, reason: 'match_not_found_on_line' };
    }

    // fallback: if match exists somewhere in file, accept
    if (match && content.includes(match)) {
      return { verified: true, reason: 'match_found_elsewhere' };
    }

    return { verified: false, reason: 'evidence_not_found' };
  } catch (err) {
    return { verified: false, reason: `fetch_error: ${err && err.message ? err.message : String(err)}` };
  }
}

async function createIssueFromAnalysis(projectId, { pipelineId, job, analysis, logExcerpt = '', commitSha = '' }) {
  // Ensure fingerprint store ready (assumes init called elsewhere)
  const excerptSlice = normStr(logExcerpt).slice(0, 200);
  const fingerprint = makeFingerprint({
    projectId,
    jobId: job && job.id ? job.id : (job && job.build_id ? job.build_id : ''),
    pipelineId,
    commitSha,
    excerpt: excerptSlice
  });

  // 1) Try DB atomic insert fallback: check if exists
  const existing = await fpStore.getByFingerprint(fingerprint).catch(() => null);
  if (existing && existing.issue_iid) {
    // Append comment instead of creating new issue
    const commentBody = buildCommentBody({ pipelineId, job, analysis, logExcerpt });
    await gitlab.createIssueComment(projectId, existing.issue_iid, commentBody).catch((err) => {
      console.error('Failed to append comment for existing fingerprint:', err.message);
    });
    // bump occurrence counter
    await fpStore.bumpOccurrence(fingerprint).catch(() => {});
    // return a lightweight object indicating existing issue
    return { existing: true, issue_iid: existing.issue_iid };
  }

  // 2) If not in DB, search GitLab open issues for fingerprint (fallback)
  let foundRemote = null;
  try {
    const matches = await gitlab.searchOpenIssues(projectId, fingerprint).catch(() => []);
    if (Array.isArray(matches) && matches.length > 0) {
      foundRemote = matches[0];
    }
  } catch (err) {
    console.warn('Issue search failed:', err.message);
  }

  if (foundRemote) {
    // store mapping in DB best-effort
    try {
      await fpStore.insertMappingAtomic({ fingerprint, projectId, issueIid: foundRemote.iid });
    } catch (e) {
      // ignore
    }
    const commentBody = buildCommentBody({ pipelineId, job, analysis, logExcerpt });
    await gitlab.createIssueComment(projectId, foundRemote.iid, commentBody).catch((err) => {
      console.error('Failed to append comment to remote found issue:', err.message);
    });
    return { existing: true, issue_iid: foundRemote.iid };
  }

  // === New verification & gating logic ===

  // If detector supplied deterministic summary (preferred), trust it for auto-create
  let deterministicVerified = false;
  try {
    if (analysis && analysis._detectorSummary) {
      const det = analysis._detectorSummary;
      if (Array.isArray(det.repoHits) && det.repoHits.some(h => h.verified)) {
        deterministicVerified = true;
      }
      if (Array.isArray(det.dependencyHigh) && det.dependencyHigh.length > 0) {
        // treat dependencyHigh from detector as deterministic evidence (heuristic)
        deterministicVerified = true;
      }
    }
  } catch (e) {
    // ignore; keep deterministicVerified false
  }

  // If the AI returned explicit file/line claims, attempt to verify them before auto-create
  let aiClaimVerified = false;
  try {
    if (analysis && typeof analysis === 'object') {
      // Support a few possible AI claim shapes: analysis.file & analysis.line, or analysis.evidence.file
      const filePath = analysis.file || (analysis.evidence && analysis.evidence.file) || null;
      const line = analysis.line || (analysis.evidence && analysis.evidence.line) || null;
      const match = analysis.match || (analysis.evidence && analysis.evidence.match) || null;
      if (filePath) {
        const verify = await verifyFileClaim({ projectId, filePath, line, match, commitSha });
        if (verify && verify.verified) aiClaimVerified = true;
      }
    }
  } catch (e) {
    // verification failure -> treat as unverified
    aiClaimVerified = false;
  }

  // Decide whether to auto-create issue
  const confidence = typeof analysis.confidence === 'number' ? analysis.confidence : 0;
  const labels = ['ai:analysis'];
  if (confidence < MIN_CONF_TO_AUTOCREATE) {
    labels.push('ai:triage');
  }

  // Severity label heuristic (simple)
  if ((analysis.root_cause || '').toLowerCase().includes('secret') || (analysis.root_cause || '').toLowerCase().includes('api key') || deterministicVerified) {
    labels.push('ai:security', 'severity:critical');
  }

  // If deterministicVerified (from detector) or AI claim verified, bypass confidence gating and mark validated
  if (deterministicVerified || aiClaimVerified) {
    // ensure labels include validated flag
    labels.push('ai:validated', 'ai:deterministic');
  } else {
    // not verified by deterministic evidence or AI claim verification
    if (confidence < MIN_CONF_TO_AUTOCREATE) {
      labels.push('ai:unverified');
    }
  }

  // Build title/body (reuse your original format but annotate verification metadata)
  const statusLabel = deterministicVerified
    ? 'VERIFIED'
    : aiClaimVerified
    ? 'AI-VERIFIED'
    : (analysis.stage || job.name || 'CI');
  const shortRoot = (analysis.root_cause || 'Unknown').replace(/[^a-z0-9 ]/gi, '').slice(0, 60) || 'Insight';
  const title = `🚨 ${statusLabel} | ${shortRoot} | ${job.name} | Pipeline ${pipelineId}`;
  const jobUrl = job.web_url || `${GITLAB_BASE_URL}/${projectId}/-/jobs/${job.id}`;
  const pipelineUrl = `${GITLAB_BASE_URL}/${projectId}/-/pipelines/${pipelineId}`;

  // Redact potentially sensitive pieces of logExcerpt: replace long tokens with [REDACTED_TOKEN]
  const redactedExcerpt = (logExcerpt || '').replace(/\b[A-Za-z0-9-_]{40,}\b/g, '[REDACTED_TOKEN]');

  const descriptionParts = [
    '**AI Analysis**',
    `**Stage:** ${analysis.stage || job.name}`,
    `**Root cause:** ${analysis.root_cause || 'unknown'}`,
    `**Suggested fix:** ${analysis.suggested_fix || 'manual review'}`,
    `**Confidence:** ${analysis.confidence ?? 0}`,
    `**Fingerprint:** ${fingerprint}`,
    '',
    '**Verification**'
  ];

  if (deterministicVerified) {
    descriptionParts.push(`- Deterministic evidence detected and verified by detector service (see debug artifacts).`);
  } else if (aiClaimVerified) {
    descriptionParts.push(`- AI-provided file/line evidence verified at commit ${commitSha}.`);
  } else {
    descriptionParts.push(`- No deterministic verification found; issue created based on AI analysis and confidence gating.`);
  }

  descriptionParts.push('', `**Pipeline:** ${pipelineUrl}`, `**Job:** ${jobUrl}`, '', '**Log excerpt:**', '```', redactedExcerpt || '(no excerpt captured)', '```', '', '_This issue was auto-generated by the AI DevOps Assistant. Prompt and response stored for audit._');

  const description = descriptionParts.join('\n');

  // If we are not allowed to auto-create (low confidence & not verified), create as triage (still create issue but label ai:triage)
  const allowAutoCreate = deterministicVerified || aiClaimVerified || (confidence >= MIN_CONF_TO_AUTOCREATE);

  if (!allowAutoCreate) {
    // Create a triage issue (we still create it, but with ai:triage label — original code did this too)
    labels.push('ai:triage');
  }

  // 4) Create issue on GitLab
  let newIssue;
  try {
    newIssue = await gitlab.createIssue(projectId, title, description, labels).catch((err) => {
      throw new Error(`Failed to create issue: ${err.message}`);
    });
  } catch (err) {
    throw err;
  }

  // 5) Atomically insert mapping into DB. If another process raced and inserted, insertMappingAtomic will return existing mapping.
  try {
    const mapping = await fpStore.insertMappingAtomic({ fingerprint, projectId, issueIid: newIssue.iid });
    // mapping returned either the new mapping or existing mapping if race occurred
    if (mapping && mapping.issue_iid && mapping.issue_iid !== newIssue.iid) {
      // race: another process created the mapping first — append a comment to the winner and optionally close duplicate (not doing deletion here)
      const winnerIid = mapping.issue_iid;
      const commentBody = `Duplicate issue created (race). Consolidating evidence into existing issue #${winnerIid}.`;
      // Append comment to newIssue to indicate consolidation
      await gitlab.createIssueComment(projectId, newIssue.iid, commentBody).catch(() => {});
      // Also append real evidence to the winning issue
      const realEvidence = buildCommentBody({ pipelineId, job, analysis, logExcerpt });
      await gitlab.createIssueComment(projectId, winnerIid, realEvidence).catch(() => {});
      // You may choose to close the duplicate newIssue programmatically if policy allows.
      return { existing: true, issue_iid: winnerIid, duplicate_created: newIssue.iid };
    }
  } catch (err) {
    // mapping insert failed unexpectedly — log but keep issue
    console.warn('Mapping insert warning:', err.message);
  }

  return newIssue;
}

function buildCommentBody({ pipelineId, job, analysis, logExcerpt }) {
  const jobUrl = job.web_url || '';
  return [
    `**New occurrence detected**`,
    `**Pipeline:** ${pipelineId}`,
    `**Job:** ${job.name} (${job.id})`,
    `**Root cause:** ${analysis.root_cause || 'unknown'}`,
    `**Confidence:** ${analysis.confidence ?? 0}`,
    '',
    '**Log excerpt:**',
    '```',
    logExcerpt || '(no excerpt captured)',
    '```',
    '',
    '_Appended automatically by AI Guardian._'
  ].join('\n');
}

module.exports = { createIssueFromAnalysis };
