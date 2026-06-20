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
  try {
    for (const name of fs.readdirSync(TASKNOTES_DIR)) {
      if (!name.endsWith('.md')) continue;
      const filepath = path.join(TASKNOTES_DIR, name);
      try {
        const content = fs.readFileSync(filepath, 'utf8');
        const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
        if (!fmMatch) continue;
        // tags appear either as a YAML flow array `tags: [a, b]` or as a
        // block list of `  - tag` lines. Match both with a simple substring
        // check inside the frontmatter block.
        const fm = fmMatch[1];
        const re = new RegExp(`(^|[\\s,\\[])${issueId.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}([\\s,\\]]|$)`, 'm');
        if (re.test(fm)) return filepath;
      } catch { continue; }
    }
  } catch {}
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
  // mtn writes the project as a non-resolving `[[projects/<slug>]]` link. Repoint
  // it at the real vault note so the task isn't a graph orphan. Best-effort: if the
  // slug doesn't map to a project note, leave mtn's default untouched.
  try {
    const file = findTasknoteForIssueId(issueId);
    if (file) {
      const target = resolveProjectLink(projectSlug, VAULT_DIR);
      if (target) {
        const content = fs.readFileSync(file, 'utf8');
        const fixed = content.replace(/\[\[projects\/[^\]]+\]\]/g, `[[${target}]]`);
        if (fixed !== content) fs.writeFileSync(file, fixed);
      }
    }
  } catch { /* non-fatal: keep mtn's link */ }
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
