// session-close.js — shared session-note close logic.
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

// SessionEnd is post-action: CC fires it at quit and does NOT wait for it
// before terminating — a hook that overruns the (undocumented, short) shutdown
// window is killed and reported as "failed: Hook cancelled" (cp-15f). So this
// path must stay near-instant. We only need a note's FRONTMATTER to decide
// whether it's the active session, never its body — and session bodies grow
// large. Read just the head for detection; read full content only for the one
// file we actually rewrite.
const HEAD_BYTES = 2048;

function readHead(filepath) {
  let fd;
  try {
    fd = fs.openSync(filepath, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.toString('utf8', 0, n);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch {} }
  }
}

function findProjectName(folderName) {
  const projectsDir = path.join(VAULT_DIR, '1. Projects');
  if (!fs.existsSync(projectsDir)) return null;
  for (const file of fs.readdirSync(projectsDir).filter(f => f.endsWith('.md'))) {
    try {
      // folder:/name: live in frontmatter at the top — head read is enough.
      const content = readHead(path.join(projectsDir, file));
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
        // Detect on the frontmatter head only — bodies can be large and there
        // may be 100s of notes. Read the FULL file only once we've matched.
        const head = readHead(filepath);
        const statusMatch = head.match(/^status:\s*(\S+)/m);
        if (!statusMatch || statusMatch[1] !== 'active') continue;
        const projectMatch = head.match(/^project:\s*"?\[?\[?([^\]"\n]+)\]?\]?"?/m);
        if (projectMatch && projectMatch[1].trim().toLowerCase() === projectName.toLowerCase()) {
          const content = fs.readFileSync(filepath, 'utf8');
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
 * Close the active session note for the session's anchored code project.
 * Optionally stops a dangling mtn timer (the StopFailure path needs this;
 * SessionEnd's prior behavior left timer-stop to the Stop hooks that never ran
 * on an API error). Does NOT run `bd prime` — see note in the body.
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

    // NOTE: no `bd prime` here. Priming at session END is redundant — the next
    // session's SessionStart hook runs `bd prime` itself, and with stdio
    // ignored at quit there is no agent to receive this output anyway. It only
    // added up-to-5s of blocking to a post-action hook CC won't wait for,
    // which is what triggered "Hook cancelled" at quit (cp-15f).

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
