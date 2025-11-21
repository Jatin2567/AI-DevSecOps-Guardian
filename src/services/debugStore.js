// backend/src/services/debugStore.js
'use strict';

const fs = require('fs').promises;
const fssync = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEBUG_DIR = process.env.DEBUG_DIR || path.join(process.cwd(), 'debug');

/**
 * Ensure debug directory exists (synchronous helper for early bootstrap)
 */
function ensureDebugDirSync() {
  try {
    fssync.mkdirSync(DEBUG_DIR, { recursive: true });
  } catch (e) {
    // ignore
  }
}

/**
 * Ensure debug directory exists (async)
 */
async function ensureDebugDir() {
  try {
    await fs.mkdir(DEBUG_DIR, { recursive: true });
  } catch (e) {
    // ignore
  }
}

/**
 * Write a raw webhook payload JSON to debug directory.
 * Returns { path, hash } where hash is sha256 hex of the raw JSON.
 */
async function writeRawWebhookPayload(event) {
  await ensureDebugDir();
  try {
    const raw = JSON.stringify(event, null, 2);
    const hash = crypto.createHash('sha256').update(raw).digest('hex');
    const filename = path.join(DEBUG_DIR, `webhook-${hash}.json`);
    // write only if not exists
    try {
      await fs.access(filename);
      // exists
      return { path: filename, hash };
    } catch {
      await fs.writeFile(filename, raw, 'utf8');
      return { path: filename, hash };
    }
  } catch (err) {
    return { path: null, hash: null, error: err.message || String(err) };
  }
}

/**
 * Write a run snapshot for a traceHash.
 * data is an object; it'll be stringified.
 * If a file already exists, this will NOT overwrite unless replace=true.
 * Returns path.
 */
async function writeRunSnapshot(traceHash, data = {}, replace = false) {
  await ensureDebugDir();
  const filename = path.join(DEBUG_DIR, `run-${traceHash}.json`);
  try {
    if (!replace) {
      try {
        await fs.access(filename);
        // exists, append a timestamped file instead
        const alt = path.join(DEBUG_DIR, `run-${traceHash}-${Date.now()}.json`);
        await fs.writeFile(alt, JSON.stringify(data, null, 2), 'utf8');
        return { path: alt };
      } catch {
        // file does not exist, continue to write
      }
    }
    await fs.writeFile(filename, JSON.stringify(data, null, 2), 'utf8');
    return { path: filename };
  } catch (err) {
    return { path: null, error: err.message || String(err) };
  }
}

/**
 * Append detector results into an existing run snapshot.
 * If run file doesn't exist, creates it.
 * detectorObj will be placed under "detector" key.
 */
async function appendDetectorToRun(traceHash, detectorObj) {
  await ensureDebugDir();
  const filename = path.join(DEBUG_DIR, `run-${traceHash}.json`);
  try {
    let existing = {};
    try {
      const raw = await fs.readFile(filename, 'utf8');
      existing = JSON.parse(raw);
    } catch {
      existing = { meta: {}, trace_tail: '', created_at: new Date().toISOString() };
    }
    existing.detector = detectorObj;
    existing.updated_at = new Date().toISOString();
    await fs.writeFile(filename, JSON.stringify(existing, null, 2), 'utf8');
    return { path: filename };
  } catch (err) {
    return { path: null, error: err.message || String(err) };
  }
}

/**
 * Append AI analysis to run snapshot.
 */
async function appendAiToRun(traceHash, aiObj) {
  await ensureDebugDir();
  const filename = path.join(DEBUG_DIR, `run-${traceHash}.json`);
  try {
    let existing = {};
    try {
      const raw = await fs.readFile(filename, 'utf8');
      existing = JSON.parse(raw);
    } catch {
      existing = { meta: {}, trace_tail: '', created_at: new Date().toISOString() };
    }
    existing.ai = aiObj;
    existing.updated_at = new Date().toISOString();
    await fs.writeFile(filename, JSON.stringify(existing, null, 2), 'utf8');
    return { path: filename };
  } catch (err) {
    return { path: null, error: err.message || String(err) };
  }
}

/**
 * Save arbitrary detector debug file (returns file path).
 * Useful to store detector-{hash}.json as in detectorService.
 */
async function writeDetectorDebug(obj) {
  await ensureDebugDir();
  try {
    const summaryHash = crypto.createHash('sha256').update(JSON.stringify(obj || {})).digest('hex').slice(0, 12);
    const filename = path.join(DEBUG_DIR, `detector-${summaryHash}.json`);
    // write if not exists
    try {
      await fs.access(filename);
      return { path: filename };
    } catch {
      await fs.writeFile(filename, JSON.stringify(obj, null, 2), 'utf8');
      return { path: filename };
    }
  } catch (err) {
    return { path: null, error: err.message || String(err) };
  }
}

/**
 * Read a debug file by filename (relative to debug dir).
 * Returns { content, path } or { error }.
 */
async function readDebugFile(filename) {
  await ensureDebugDir();
  const filePath = path.join(DEBUG_DIR, filename);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return { content, path: filePath };
  } catch (err) {
    return { error: err.message || String(err) };
  }
}

/**
 * List debug files (basic).
 */
async function listDebugFiles() {
  await ensureDebugDir();
  try {
    const files = await fs.readdir(DEBUG_DIR);
    return files.sort();
  } catch (err) {
    return [];
  }
}

// Ensure directory exists at require-time for convenience
ensureDebugDirSync();

module.exports = {
  DEBUG_DIR,
  ensureDebugDir,
  writeRawWebhookPayload,
  writeRunSnapshot,
  appendDetectorToRun,
  appendAiToRun,
  writeDetectorDebug,
  readDebugFile,
  listDebugFiles
};
