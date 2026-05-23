// session-close.js — shared session-note close + bd prime logic.
//
// Extracted from session-end.js so the SessionEnd hook AND the StopFailure
// hook (cp-9kw) use ONE implementation. An API-error turn-end fires
// StopFailure, not SessionEnd/Stop — so without this the session note is left
// status:active and the mtn timer keeps running until the next SessionStart
// sweep (cp-re1). Reusing this from both events closes that gap at the
// failure, not one session later.
//
// Behavior is byte-for-byte the close logic that shipped in session-end.js;
// do not "improve" the frontmatter regexes here without updating session-end.js
// + the StopFailure hook + tests.

'use strict';

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { findCodeRoot, sessionDir } = require(path.join(__dirname, 'is-code-context.js'));

const { getVaultRoot } = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'vault-root.js'));
const VAULT_DIR = getVaultRoot();
const SESSIONS_DIR = path.join(VAULT_DIR, '2. Areas', 'Sessions');

function findProjectName(folderName) {
  const projectsDir = path.join(VAULT_DIR, '1. Projects');
  if (!fs.existsSync(projectsDir)) return null;
  for (const file of fs.readdirSync(projectsDir).filter(f => f.endsWith('.md'))) {
    try {
      const content = fs.readFileSync(path.join(projectsDir, file), 'utf8');
      const folderMatch = content.match(/^folder:\s*"?([^"\n]+)"?$/m);
      if (folderMatch && folderMatch[1].trim().toLowerCase() === folderName.toLowerCase()) {
        const nameMatch = content.match(/^name:\s*"?([^"\n]+)"?$/m);
        if (nameMatch) return nameMatch[1].trim();
        return file.replace('.md', '');
      }
    } catch { continue; }
  }
  return null;
}

function findActiveSession(projectName) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;
  const projectSlug = projectName.replace(/[^a-zA-Z0-9]+/g, '-');

  function walkMd(dir) {
    const results = [];
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          results.push(...walkMd(path.join(dir, entry.name)));
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          results.push(path.join(dir, entry.name));
        }
      }
    } catch {}
    return results;
  }

  const dirs = [path.join(SESSIONS_DIR, projectSlug), SESSIONS_DIR].filter(d => fs.existsSync(d));
  const seen = new Set();
  for (const dir of dirs) {
    for (const filepath of walkMd(dir).sort((a, b) => path.basename(b).localeCompare(path.basename(a)))) {
      if (seen.has(filepath)) continue;
      seen.add(filepath);
      try {
        const content = fs.readFileSync(filepath, 'utf8');
        const statusMatch = content.match(/^status:\s*(\S+)/m);
        if (!statusMatch || statusMatch[1] !== 'active') continue;
        const projectMatch = content.match(/^project:\s*"?\[?\[?([^\]"\n]+)\]?\]?"?/m);
        if (projectMatch && projectMatch[1].trim().toLowerCase() === projectName.toLowerCase()) {
          return { filepath, content };
        }
      } catch { continue; }
    }
  }
  return null;
}

function closeSessionFile(filepath, content) {
  const now = new Date().toISOString();
  let updated = content.replace(/\r\n/g, '\n');
  updated = updated.replace(/^status:\s*active\s*$/m, 'status: done');
  updated = updated.replace(/^ended:\s*null\s*$/m, `ended: ${now}`);
  if (!/^ended:/m.test(updated)) {
    updated = updated.replace(/^(started:\s*[^\n]+)/m, `$1\nended: ${now}`);
  }
  fs.writeFileSync(filepath, updated, 'utf-8');
}

/**
 * Close the active session note for the session's anchored code project and
 * run `bd prime` so the next session inherits beads context. Also stops a
 * dangling mtn timer (the StopFailure path needs this; SessionEnd's prior
 * behavior left timer-stop to the Stop hooks that never ran on an API error).
 *
 * `data` is the parsed hook stdin ({ session_id, cwd, ... }).
 * Returns { closed: bool, project, file } describing what (if anything) it did.
 * Never throws — callers exit 0 regardless.
 */
function closeActiveSession(data, { stopTimer = false } = {}) {
  const result = { closed: false, project: null, file: null };
  try {
    const codeRoot = findCodeRoot(sessionDir(data));
    const folderName = codeRoot ? path.basename(codeRoot) : null;

    if (codeRoot) {
      try {
        execSync('bd prime', { cwd: codeRoot, encoding: 'utf8', timeout: 5000, stdio: 'ignore', windowsHide: true });
      } catch {}
    }

    if (stopTimer) {
      // An unclean end (API error) never ran the Stop timer-stop hooks.
      try {
        execSync('mtn timer stop', { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      } catch {}
    }

    if (!codeRoot || folderName.toLowerCase() === 'workspace') return result;

    const projectName = findProjectName(folderName);
    if (!projectName) return result;
    result.project = projectName;

    const session = findActiveSession(projectName);
    if (!session) return result;

    closeSessionFile(session.filepath, session.content);
    result.closed = true;
    result.file = path.basename(session.filepath);
  } catch {}
  return result;
}

module.exports = {
  VAULT_DIR,
  SESSIONS_DIR,
  findProjectName,
  findActiveSession,
  closeSessionFile,
  closeActiveSession,
};
