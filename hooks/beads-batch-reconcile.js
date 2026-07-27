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
// share the same brittle input — HD-3.3). A single PostToolBatch sweep of the
// repo's issues.jsonl is structurally immune to batch shaping: it mirrors any
// issue that has no TaskNote yet, however it was created.
//
// Idempotent: ensureMtnTask() dedupes by bd issue ID via a filesystem scan of
// the TaskNotes dir, so re-running every batch only ever creates the missing
// mirrors. Registered async (no model-call latency cost).
//
// Scope-safe + server-free: reads the repo's .beads/issues.jsonl at the .beads
// root (findBeadsRoot, which EXCLUDES the global ~/.beads). Reading the per-repo
// jsonl is inherently scoped to THIS project (no cp-o4g `--all` trap) and never
// queries the shared Dolt server, so concurrent multi-session batches don't pile
// up orphan dolt servers (cp-6j5 / dolt-guard).

// cp-na6c: this hook only ever swept the CURRENT repo, and only when it saw
// `bd create` in the batch. A repo populated by a scripted run and never opened
// interactively was therefore never reconciled at all — which is how four repos
// reached exactly 0% mirrored. It now also runs a THROTTLED fleet pass so every
// beads repo gets swept regardless of where the session happens to be.
//
// That was only safe to add after the lookup was made fast: findTasknoteForIssueId
// cost 1,105 ms per call (it re-read all 2,067 task notes), so this hook needed
// ~484 s for one repo against its 60 s timeout and was killed mid-sweep on every
// batch — burning its whole budget re-checking issues that were ALREADY mirrored
// and never reaching the missing ones. It is now ~3.8 ms per call.
//
// The fleet pass runs in a DETACHED child (see spawnFleetSweep below), not
// inline: even at ~32 s it is too heavy for a hook that fires after every batch.
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { findBeadsRoot, findCodeRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));
const { readIssues } = require(path.join(__dirname, 'lib', 'read-issues-jsonl.js'));
const TN = require(path.join(__dirname, 'lib', 'tasknotes-mirror.js'));

const HOOK = 'beads-batch-reconcile';

// Resolve the project display-name from a vault project file, mirroring the
// derivation beads-status-sync uses, so the +project tag matches.
function projectSlugFor(beadsRoot) {
  const folderName = path.basename(beadsRoot);
  // Reuse the shared slug derivation (Title-Cased-With-Dashes).
  return TN.projectSlugFrom(folderName);
}

// One reconcile pass over a single repo. Returns how many notes it created.
function reconcileRepo(beadsRoot) {
  const issues = readIssues(beadsRoot);
  if (!issues.length) return 0;
  const codeRoot = findCodeRoot(beadsRoot) || beadsRoot;
  const projectSlug = projectSlugFor(codeRoot);
  let created = 0;
  for (const it of issues) {
    if (!it || !it.id || !it.title) continue;
    // Skip closed issues — only mirror live work. Closed issues are completed in
    // TaskNotes by the close-side sync, never created here. (Counting them as
    // "should be mirrored" is what made coverage look like 46% when live work was
    // at 98%.)
    if (it.status === 'closed') continue;
    if (TN.findTasknoteForIssueId(it.id)) continue;
    TN.ensureMtnTask(it.id, it.title, TN.normalizePriority(it.priority), projectSlug);
    if (TN.findTasknoteForIssueId(it.id)) created++;
  }
  return created;
}

// Throttle stamp for the fleet pass. Co-located with the other braynee runtime
// state under ~/.claude.
const FLEET_STAMP = path.join(os.homedir(), '.claude', 'braynee-mirror-fleet-sweep');
const FLEET_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6h — drift accrues slowly

function fleetSweepDue() {
  try {
    const last = Number(String(fs.readFileSync(FLEET_STAMP, 'utf8')).trim()) || 0;
    return Date.now() - last >= FLEET_INTERVAL_MS;
  } catch {
    return true;   // no stamp yet → first sweep
  }
}

// Retired project families: mirroring their issues would create vault notes for
// work nobody will do.
const DEAD_REPO = /^sophon(-|$)|^comfyui-sophon$/;

// The fleet pass walks ~35 repos and measured ~32 s. Running it INSIDE this hook
// was wrong regardless of budget: a PostToolBatch hook fires after every batch,
// and a wall-clock budget only checks BETWEEN repos, so one large repo still
// overruns it (measured 35 s against a 20 s budget). It also blew the self-test's
// 15 s smoke cap.
//
// So it is spawned DETACHED instead — the same pattern ensure-dashboard uses.
// The hook returns immediately, the sweep runs on its own clock with no timeout
// pressure, and it reuses scripts/mirror-reconcile.mjs so the hook and the manual
// backfill cannot drift apart. Output goes nowhere: a detached child writing to
// the hook's stdout would corrupt the hook protocol.
function spawnFleetSweep() {
  const script = path.join(__dirname, '..', 'scripts', 'mirror-reconcile.mjs');
  if (!fs.existsSync(script)) return false;
  try {
    const child = spawn(process.execPath, [script, '--write'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
    child.unref();
  } catch (err) {
    log.debug(HOOK, `could not spawn fleet sweep: ${err && err.message}`);
    return false;
  }
  // Stamped on SPAWN, not on completion — the child owns its own outcome, and a
  // failed spawn is already reported above. Stamping here is what keeps this to
  // one background sweep per interval rather than one per batch.
  try { fs.writeFileSync(FLEET_STAMP, String(Date.now())); }
  catch (err) {
    log.debug(HOOK, `could not write fleet-sweep stamp: ${err && err.message}`);
  }
  return true;
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

    // Read the repo's issues.jsonl directly — repo-scoped by construction (no
    // cp-o4g --all trap) and server-free, so concurrent sessions don't hammer
    // the shared Dolt server (cp-6j5 / dolt-guard). bd auto-exports to jsonl on
    // create, so freshly-created issues are present by this PostToolBatch sweep.
    const codeRoot = findCodeRoot(beadsRoot) || beadsRoot;
    const projectSlug = projectSlugFor(codeRoot);

    // 1. This repo, every batch — the fast path that keeps the active project
    //    consistent immediately.
    const created = reconcileRepo(beadsRoot);

    // 2. Every OTHER repo, at most every 6h, in a DETACHED child. This is the
    //    part that was missing: a repo never opened in a session was never
    //    reconciled at all, which is how four repos reached exactly 0%.
    let fleetSpawned = false;
    if (fleetSweepDue()) fleetSpawned = spawnFleetSweep();

    if (created > 0) {
      log.info(HOOK, `reconciled ${created} for ${projectSlug}` +
        (fleetSpawned ? ' (fleet sweep spawned)' : ''));
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolBatch',
          additionalContext:
            `Beads→TaskNotes reconcile: ${created} beads issue(s) for "${projectSlug}" had no ` +
            `TaskNote (created in a batched/piped command that bypassed the per-call mirror) ` +
            `and were mirrored now. The three-way task mirror is consistent.`,
        },
      }));
    } else {
      log.info(HOOK, `no unmirrored issues for ${projectSlug}` +
        (fleetSpawned ? ' (fleet sweep spawned)' : ''));
    }
  } catch (e) {
    try { log.error(HOOK, `crash: ${e.message}`); } catch { /* logging must never break the hook */ }
  }
  process.exit(0);
});
