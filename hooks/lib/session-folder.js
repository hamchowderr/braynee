'use strict';

// session-folder.js — the ONE mapping from a project name to its folder under
// `2. Areas/Sessions/`. cp-g3xp.
//
// Every session hook derived that folder as
// `projectName.replace(/[^a-zA-Z0-9]+/g, '-')`, so a project named "Acme OS"
// wrote its notes to `Sessions/Acme-OS/` while other writers and the vault's
// own history used `Sessions/Acme OS/`. One project's history split across two
// folders, and recap/context only ever saw half of it. The vault convention is
// Title Case With Spaces with brand casing and real dots kept — which is simply
// the project name as written.
//
//   write   → sessionFolderName(): the verbatim name. Nothing here produces a
//             dashed folder any more.
//   resolve → existingSessionFolders(): the verbatim folder, then the legacy
//             dashed one if it is on disk, so a vault written before this fix
//             still finds its notes.

const fs = require('fs');
const path = require('path');

// Where a session with no project lands (vault-query `session start` without
// --project), and the fallback for a name that sanitizes to nothing.
const UNCATEGORIZED = '_uncategorized';

// Characters Windows refuses in a file or folder name, plus control characters.
const FORBIDDEN_CHARS = /[<>:"/\\|?*\x00-\x1f]/g;

// projectName → the folder name new session notes are written to.
function sessionFolderName(projectName) {
  const name = String(projectName == null ? '' : projectName)
    .replace(FORBIDDEN_CHARS, '')
    // Windows drops trailing dots and spaces from a folder name, so "Foo." is
    // created as "Foo" — strip them so the name we compute is the one on disk.
    .replace(/[. ]+$/, '');
  return name || UNCATEGORIZED;
}

// The pre-cp-g3xp derivation. Resolution only — never a write target.
function legacySessionFolderName(projectName) {
  return String(projectName == null ? '' : projectName).replace(/[^a-zA-Z0-9]+/g, '-');
}

// Folders under sessionsDir that hold this project's notes, in search order:
// the verbatim folder first, then the legacy dashed one. Folders that do not
// exist are omitted, and each folder is listed once.
//
// Each comes back in its ON-DISK spelling, matched case-insensitively. Callers
// walk these and then all of Sessions/, de-duplicating by path string; the full
// scan spells a folder the way the disk does, so returning "Acme CHAT KIT" for a
// folder stored as "Acme Chat Kit" would have every note in it read twice on a
// case-insensitive filesystem.
function existingSessionFolders(sessionsDir, projectName) {
  let dirs;
  try {
    dirs = fs.readdirSync(sessionsDir, { withFileTypes: true }).filter(e => e.isDirectory());
  } catch {
    // No readable Sessions folder: there is nothing to search.
    return [];
  }
  const out = [];
  for (const name of [sessionFolderName(projectName), legacySessionFolderName(projectName)]) {
    if (!name) continue;
    const want = name.toLowerCase();
    // The exact spelling first, then any case variant — a case-sensitive
    // filesystem can hold several.
    const matches = [
      ...dirs.filter(e => e.name === name),
      ...dirs.filter(e => e.name !== name && e.name.toLowerCase() === want),
    ];
    for (const e of matches) {
      const dir = path.join(sessionsDir, e.name);
      if (!out.includes(dir)) out.push(dir);
    }
  }
  return out;
}

module.exports = {
  UNCATEGORIZED,
  sessionFolderName,
  legacySessionFolderName,
  existingSessionFolders,
};
