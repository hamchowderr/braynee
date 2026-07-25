// tasknotes-mirror.js — shared TaskNotes (mtn) mirror for beads issues.
//
// Extracted verbatim from beads-status-sync.js so the PostToolUse status
// hook AND prd-seed.mjs use ONE implementation. cp-8ru: prd-seed creates
// issues via internal execSync (not Bash tool-calls), so the PostToolUse
// hook never saw them and seeded backlogs got zero TaskNotes. The mirror
// was never code-vs-vault gated — the gap was the seed path bypassing it.
//
// Behavior is identical to the original inline helpers; do not "improve"
// the regexes/format here without updating both call sites + tests.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const { getVaultRoot } = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'vault-root.js'));
const { resolveProjectLink } = require(path.join(__dirname, 'project-resolver.js'));
const VAULT_DIR = getVaultRoot();
const TASKNOTES_DIR = path.join(VAULT_DIR, '2. Areas', 'TaskNotes', 'Tasks');

// 0–4 → name (matches beads-status-sync PRIORITY_MAP). Also tolerates the
// already-named and `P1` forms that bd --json / CLI flags can emit.
const PRIORITY_MAP = { 0: 'critical', 1: 'high', 2: 'medium', 3: 'low', 4: 'low' };
function normalizePriority(raw) {
  if (raw === undefined || raw === null || raw === '') return 'medium';
  const s = String(raw).trim();
  if (/^[0-4]$/.test(s)) return PRIORITY_MAP[parseInt(s, 10)];
  if (/^P[0-4]$/i.test(s)) return PRIORITY_MAP[parseInt(s.replace(/^P/i, ''), 10)] || 'medium';
  const w = s.toLowerCase();
  return ['critical', 'high', 'medium', 'low'].includes(w) ? w : 'medium';
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, ...opts }).trim();
  } catch { return null; }
}

function sanitizeTitle(title) {
  return title.replace(/:/g, ' -').replace(/[/\\*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// Filesystem dedupe — scans tasknote files for one whose frontmatter `tags:`
// array contains the bd issue ID. `mtn search` for a `#<tag>` query returned
// empty on Windows even when the task existed (verified 2026-05-12 against
// sophon-sdk-python-test-bb4). bd IDs are workspace-namespaced so this is a
// unique key; scanning ~hundreds of small .md files is cheap enough.
function findTasknoteForIssueId(issueId) {
  if (!issueId) return null;
  if (!fs.existsSync(TASKNOTES_DIR)) return null;

  // Candidate ids: the exact id, plus the Brainy<->Braynee rename swap — task
  // tags and beads ids diverged across that rename (tag `braynee-web-x`, beads
  // id `brainy-web-x`), so a close of one must still find the note of the other.
  const ids = [issueId];
  if (issueId.startsWith('braynee')) ids.push(issueId.replace(/^braynee/, 'brainy'));
  else if (issueId.startsWith('brainy')) ids.push(issueId.replace(/^brainy/, 'braynee'));

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // tags appear as a YAML flow array `tags: [a, b]` or a block list of `- tag`.
  const tagRe = (id) => new RegExp(`(^|[\\s,\\[])${esc(id)}([\\s,\\]]|$)`, 'm');

  let notes;
  try {
    notes = fs.readdirSync(TASKNOTES_DIR).filter((n) => n.endsWith('.md')).map((name) => {
      const filepath = path.join(TASKNOTES_DIR, name);
      let fm = '';
      // BOM- and CRLF-tolerant, matching completeMtnTaskByIssueId's regex below.
      // This used to be /^---\n([\s\S]*?)\n---/ (LF only, no BOM), so on Windows
      // a CRLF task note was invisible to the mirror: it could never be found,
      // which meant ensureMtnTask created a DUPLICATE note for an issue that
      // already had one, and completeMtnTaskByIssueId silently no-op'd so closed
      // work stayed "open". Found by tasknotes-mirror.test.js (cp-ccsh.10).
      try { fm = (fs.readFileSync(filepath, 'utf8').match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/) || [, ''])[1]; } catch {}
      return { filepath, fm };
    });
  } catch { return null; }

  // Pass 1: exact tag match for any candidate id.
  for (const { filepath, fm } of notes) {
    if (fm && ids.some((id) => tagRe(id).test(fm))) return filepath;
  }
  // Pass 2: sub-issue. beads closes the full `parent.N`, but the task note tags
  // the PARENT id and carries the `.N` in its title — match parent tag + `.N`.
  for (const id of ids) {
    const sub = id.match(/^(.+)\.(\d+)$/);
    if (!sub) continue;
    const parentRe = tagRe(sub[1]);
    const titleRe = new RegExp(`\\s\\.${sub[2]}\\s*['"]?\\s*$`, 'm');
    for (const { filepath, fm } of notes) {
      if (fm && parentRe.test(fm) && titleRe.test((fm.match(/^title:\s*(.+)$/m) || [, ''])[1])) return filepath;
    }
  }
  return null;
}

function findMtnTaskByIssueId(issueId) {
  // Used by close-side to decide whether to call `mtn complete`.
  // Returns a string mtn can resolve back to the task (the `#<issueId>` tag).
  return findTasknoteForIssueId(issueId) ? '#' + issueId : null;
}

// Mark the mirrored task note done. The previous version ran `mtn complete
// "#<id>"`, but `mtn complete` takes <pathOrTitle> — a `#tag` never resolves
// (and mtn complete crashes on some Windows paths), so every completion was a
// silent no-op and finished work stayed "open". Write the canonical done state
// (status: done + completedDate) straight to the note's frontmatter instead.
function completeMtnTaskByIssueId(issueId) {
  const file = findTasknoteForIssueId(issueId);
  if (!file) return;
  try {
    const content = fs.readFileSync(file, 'utf8');
    const m = content.match(/^(﻿?---\r?\n)([\s\S]*?)(\r?\n---)/);
    if (!m) return;
    let fm = m[2];
    const date = new Date().toISOString().slice(0, 10);
    fm = /^status:.*$/m.test(fm) ? fm.replace(/^status:.*$/m, 'status: done') : fm + '\nstatus: done';
    fm = /^completedDate:.*$/m.test(fm) ? fm.replace(/^completedDate:.*$/m, `completedDate: '${date}'`) : fm + `\ncompletedDate: '${date}'`;
    fs.writeFileSync(file, m[1] + fm + m[3] + content.slice(m[0].length));
  } catch { /* non-fatal: leave task as-is */ }
}

// Create the matching TaskNote if one does not already exist for this issue.
// Dedupe by bd issue ID, not by title prefix. Workspaces with identical task
// titles would otherwise collide on the first chars and silently skip.
// Returns the sanitized title (the mtn-resolvable name).
function ensureMtnTask(issueId, title, priority, projectSlug) {
  if (findTasknoteForIssueId(issueId)) return sanitizeTitle(title);
  const safeTitle = sanitizeTitle(title);
  const mtnText = `${safeTitle} +${projectSlug} [${priority}] #task #${issueId}`;
  run(`mtn create ${JSON.stringify(mtnText)}`);
  // Post-create cleanup of the note mtn just wrote (best-effort):
  //  - repoint the project from mtn's non-resolving `[[projects/<slug>]]` to the
  //    real vault note so the task isn't a graph orphan.
  //  - guarantee a `status` field. Older mtn omitted it, which renders as the
  //    "none" status and drops the task out of Open/Today/Overdue Base filters.
  try {
    const file = findTasknoteForIssueId(issueId);
    if (file) {
      let content = fs.readFileSync(file, 'utf8');
      let changed = false;
      const target = resolveProjectLink(projectSlug, VAULT_DIR);
      if (target && /\[\[projects\/[^\]]+\]\]/.test(content)) {
        content = content.replace(/\[\[projects\/[^\]]+\]\]/g, `[[${target}]]`);
        changed = true;
      }
      const m = content.match(/^(﻿?---\r?\n)([\s\S]*?)(\r?\n---)/);
      if (m && !/^status:/m.test(m[2])) {
        content = m[1] + m[2] + '\nstatus: open' + m[3] + content.slice(m[0].length);
        changed = true;
      }
      if (changed) fs.writeFileSync(file, content);
    }
  } catch { /* non-fatal: keep mtn's output as-is */ }
  return safeTitle;
}

// Derive the +project tag the same way beads-status-sync does:
// Title-Cased-With-Dashes from the project/folder name.
function projectSlugFrom(name) {
  return String(name || '')
    .split(/[-_\s]/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-');
}

module.exports = {
  VAULT_DIR,
  TASKNOTES_DIR,
  PRIORITY_MAP,
  normalizePriority,
  run,
  sanitizeTitle,
  findTasknoteForIssueId,
  findMtnTaskByIssueId,
  completeMtnTaskByIssueId,
  ensureMtnTask,
  projectSlugFrom,
};
