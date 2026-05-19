#!/usr/bin/env node
'use strict';

// beads-batch-reconcile.js
// Hook: PostToolBatch — after a full batch of parallel tool calls resolves,
// reconcile beads → TaskNotes for the current repo.
//
// HD-2.5 / HD-3.3 / cp-ks9 (robust fix for the cp-8ru class): the per-call
// PostToolUse mirror parses `data.tool_response.stdout` for `Created issue:`.
// A batched / piped `bd create … && bd create … | tail` strips that line, so
// beads-status-sync AND beads-todo-reminder both miss the new issues — no
// TaskNote gets created. Stacking more per-call parsers can't fix this (they
// share the same brittle input — HD-3.3). A single PostToolBatch sweep of
// `bd list` for the repo is structurally immune to batch shaping: it mirrors
// any issue that has no TaskNote yet, however it was created.
//
// Idempotent: ensureMtnTask() dedupes by bd issue ID via a filesystem scan of
// the TaskNotes dir, so re-running every batch only ever creates the missing
// mirrors. Registered async (no model-call latency cost).
//
// Scope-safe: runs `bd list --json` at the repo's .beads root (findBeadsRoot,
// which EXCLUDES the global ~/.beads). NEVER uses `--all` (cp-o4g: --all
// overrides the per-repo filter on the shared Dolt server and spans every
// project's namespace).

const { execSync } = require('child_process');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { findBeadsRoot, findCodeRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));
const TN = require(path.join(__dirname, 'lib', 'tasknotes-mirror.js'));

const HOOK = 'beads-batch-reconcile';

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, ...opts }).trim();
  } catch { return null; }
}

// Resolve the project display-name from a vault project file, mirroring the
// derivation beads-status-sync uses, so the +project tag matches.
function projectSlugFor(beadsRoot) {
  const folderName = path.basename(beadsRoot);
  // Reuse the shared slug derivation (Title-Cased-With-Dashes).
  return TN.projectSlugFrom(folderName);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }

    // Only do work if a bd-touching tool actually ran in this batch — cheap
    // guard so the common (no-beads) batch costs nothing.
    const calls = Array.isArray(data.tool_calls) ? data.tool_calls : [];
    const sawBeads = calls.some(c => {
      const ti = c && c.tool_input;
      const cmd = ti && (ti.command || ti.cmd);
      return typeof cmd === 'string' && /\bbd\s+create\b/.test(cmd);
    });
    // If we can't see the batch shape (older CC may omit tool_calls), fall
    // through and reconcile anyway — the sweep is idempotent and cheap.
    if (calls.length && !sawBeads) { process.exit(0); }

    // Per-batch event: react to where the batch ran, but resolve the repo's
    // .beads root by walking up (excludes global ~/.beads). Prefer the event
    // cwd; fall back to the session-anchored dir.
    const eventCwd = data.cwd || process.cwd();
    const beadsRoot = findBeadsRoot(eventCwd) || findBeadsRoot(sessionDir(data));
    if (!beadsRoot) { process.exit(0); }

    // NEVER --all (cp-o4g). Repo-scoped list at the .beads root.
    const raw = run('bd list --json', { cwd: beadsRoot });
    if (!raw) { process.exit(0); }

    let issues;
    try { issues = JSON.parse(raw); } catch { process.exit(0); }
    if (!Array.isArray(issues) || issues.length === 0) { process.exit(0); }

    const codeRoot = findCodeRoot(beadsRoot) || beadsRoot;
    const projectSlug = projectSlugFor(codeRoot);

    let created = 0;
    for (const it of issues) {
      if (!it || !it.id || !it.title) continue;
      // Skip closed issues — only mirror live work (matches the create-time
      // mirror behavior; closed issues are completed in TaskNotes via the
      // close-side sync).
      if (it.status === 'closed') continue;
      // ensureMtnTask is idempotent (dedupes by issue ID); it only creates a
      // TaskNote when none exists for that ID.
      const before = TN.findTasknoteForIssueId(it.id);
      if (before) continue;
      TN.ensureMtnTask(it.id, it.title, TN.normalizePriority(it.priority), projectSlug);
      if (TN.findTasknoteForIssueId(it.id)) created++;
    }

    if (created > 0) {
      log.info(HOOK, `reconciled ${created} unmirrored beads issue(s) → TaskNotes for ${projectSlug}`);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolBatch',
          additionalContext:
            `Beads→TaskNotes reconcile: ${created} beads issue(s) for "${projectSlug}" had no TaskNote (created in a batched/piped command that bypassed the per-call mirror) and were mirrored now. The three-way task mirror is consistent.`,
        },
      }));
    } else {
      log.info(HOOK, `no unmirrored issues for ${projectSlug}`);
    }
  } catch (e) {
    try { log.error(HOOK, `crash: ${e.message}`); } catch {}
  }
  process.exit(0);
});
