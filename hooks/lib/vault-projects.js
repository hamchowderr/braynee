'use strict';

// vault-projects.js — the ONE lookup from a code-repo folder name to its vault
// project note. cp-7kfh.
//
// Why this module exists: the same ~15-line findProjectName was copy-pasted into
// 8 hooks, and a NINTH flat read sat in session-auto-track.js. Every copy did
// `fs.readdirSync('1. Projects')` — reading only notes sitting DIRECTLY in that
// folder. `1. Projects/` has 17 subdirectories, and 51 notes carrying a
// `folder:` field live inside them, braynee's own included
// (`1. Projects/Braynee/Braynee.md`). All 51 were unfindable.
//
// The bug was already fixed ONCE: db558b1 (2026-05-28, "subfolder resolution")
// added a recursive walkMdFiles to session-auto-track.js and cited the
// recursive-audit rule in its comment. It fixed one of nine call sites — and not
// even the whole file, since session-auto-track kept a flat read of the same
// directory at line 599. That is precisely why this is a shared module and not a
// tenth copy: the failure mode here is partial application, not bad logic.
//
// Symptom it produced: session-auto-track (recursive) resolved a project while
// session-auto-close (flat) did not, 187ms apart in the same session — so those
// sessions were never closed and piled up as "active", and session-auto-track
// auto-created duplicate project notes for projects that already had one.

const fs = require('fs');
const path = require('path');

const PROJECTS_SUBDIR = '1. Projects';
// Frontmatter lives at the top; reading the head beats reading whole notes now
// that we walk the entire tree rather than one flat level.
const HEAD_BYTES = 4096;

function projectsDir(vaultDir) {
  return path.join(vaultDir, PROJECTS_SUBDIR);
}

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
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

// Every .md under `1. Projects`, depth-first, shallowest level first so callers
// get a stable, predictable order. Dot-directories are skipped. Never throws:
// an unreadable directory yields nothing rather than taking a hook down.
function walkProjectNotes(dir) {
  const out = [];
  const levels = [[dir]];
  while (levels.length) {
    const current = levels.shift();
    const next = [];
    for (const d of current) {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
      // Files before directories at each level keeps shallowest-first ordering.
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.md')) out.push(path.join(d, e.name));
      }
      for (const e of entries) {
        if (e.isDirectory() && !e.name.startsWith('.')) next.push(path.join(d, e.name));
      }
    }
    if (next.length) levels.push(next);
  }
  return out;
}

function frontmatterField(head, field) {
  const m = head.match(new RegExp(`^${field}:\\s*"?([^"\\n]+)"?$`, 'm'));
  return m ? m[1].trim() : null;
}

// folderName (a repo directory basename) -> the project note's `name:`, or null.
// Matching is case-insensitive on the note's `folder:` field, unchanged from the
// copies this replaces. Shallowest match wins, so a top-level note beats a
// nested one and the answer does not depend on filesystem ordering.
function findProjectName(folderName, vaultDir) {
  if (!folderName || !vaultDir) return null;
  const dir = projectsDir(vaultDir);
  if (!fs.existsSync(dir)) return null;
  const target = String(folderName).toLowerCase();
  for (const filepath of walkProjectNotes(dir)) {
    try {
      const head = readHead(filepath);
      const folder = frontmatterField(head, 'folder');
      if (folder && folder.toLowerCase() === target) {
        return frontmatterField(head, 'name') || path.basename(filepath, '.md');
      }
    } catch { continue; }
  }
  return null;
}

// Every note carrying a `folder:` field, for callers that list rather than look
// up (session-auto-track's "what is trackable" listing).
function listProjectNotes(vaultDir) {
  if (!vaultDir) return [];
  const dir = projectsDir(vaultDir);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const filepath of walkProjectNotes(dir)) {
    try {
      const head = readHead(filepath);
      const folder = frontmatterField(head, 'folder');
      if (!folder) continue;
      out.push({
        filepath,
        file: path.basename(filepath),
        folder,
        name: frontmatterField(head, 'name') || path.basename(filepath, '.md'),
        status: frontmatterField(head, 'status'),
      });
    } catch { continue; }
  }
  return out;
}

module.exports = {
  PROJECTS_SUBDIR,
  HEAD_BYTES,
  projectsDir,
  readHead,
  walkProjectNotes,
  frontmatterField,
  findProjectName,
  listProjectNotes,
};
