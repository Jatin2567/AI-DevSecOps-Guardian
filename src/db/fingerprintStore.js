// backend/src/db/fingerprintStore.js
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

const DB_DIR = path.resolve(process.env.FP_DB_DIR || path.join(__dirname, '../../data'));
const DB_PATH = path.join(DB_DIR, process.env.FP_DB_FILE || 'fingerprints.db');

if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

let db;

function init() {
  return new Promise((resolve, reject) => {
    db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);
      const create = `
        CREATE TABLE IF NOT EXISTS fingerprints (
          fingerprint TEXT PRIMARY KEY,
          project_id TEXT,
          issue_iid INTEGER,
          first_seen INTEGER,
          last_seen INTEGER,
          occurrences INTEGER DEFAULT 1
        );
      `;
      db.run(create, (err2) => {
        if (err2) return reject(err2);
        resolve();
      });
    });
  });
}

/**
 * Atomically try to insert a mapping fingerprint -> issue_iid.
 * If it already exists, return the existing mapping.
 * Returns { fingerprint, issue_iid, first_seen, last_seen, occurrences }
 */
function insertMappingAtomic({ fingerprint, projectId, issueIid }) {
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    const insertSql = `
      INSERT INTO fingerprints(fingerprint, project_id, issue_iid, first_seen, last_seen, occurrences)
      VALUES (?, ?, ?, ?, ?, 1)
    `;
    db.run(insertSql, [fingerprint, String(projectId), issueIid, now, now], function (err) {
      if (!err) {
        // Insert succeeded
        return resolve({ fingerprint, issue_iid: issueIid, first_seen: now, last_seen: now, occurrences: 1 });
      }
      // If unique constraint violated, fetch existing row
      if (err && (err.code === 'SQLITE_CONSTRAINT' || err.message.includes('UNIQUE'))) {
        const sel = `SELECT fingerprint, project_id, issue_iid, first_seen, last_seen, occurrences FROM fingerprints WHERE fingerprint = ? LIMIT 1`;
        db.get(sel, [fingerprint], (err2, row) => {
          if (err2) return reject(err2);
          if (!row) return resolve(null);
          return resolve({
            fingerprint: row.fingerprint,
            project_id: row.project_id,
            issue_iid: row.issue_iid,
            first_seen: row.first_seen,
            last_seen: row.last_seen,
            occurrences: row.occurrences
          });
        });
      } else {
        return reject(err);
      }
    });
  });
}

function getByFingerprint(fingerprint) {
  return new Promise((resolve, reject) => {
    const sel = `SELECT fingerprint, project_id, issue_iid, first_seen, last_seen, occurrences FROM fingerprints WHERE fingerprint = ? LIMIT 1`;
    db.get(sel, [fingerprint], (err, row) => {
      if (err) return reject(err);
      resolve(row || null);
    });
  });
}

function bumpOccurrence(fingerprint) {
  return new Promise((resolve, reject) => {
    const now = Math.floor(Date.now() / 1000);
    const sql = `UPDATE fingerprints SET occurrences = occurrences + 1, last_seen = ? WHERE fingerprint = ?`;
    db.run(sql, [now, fingerprint], function (err) {
      if (err) return reject(err);
      // return updated row
      db.get(`SELECT fingerprint, project_id, issue_iid, first_seen, last_seen, occurrences FROM fingerprints WHERE fingerprint = ?`, [fingerprint], (e, row) => {
        if (e) return reject(e);
        resolve(row || null);
      });
    });
  });
}

module.exports = {
  init,
  insertMappingAtomic,
  getByFingerprint,
  bumpOccurrence,
  DB_PATH
};
