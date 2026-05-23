#!/usr/bin/env node
// session-summary-runner.js — detached, single-flight session-summary sweep.
//
// Spawned (detached, unref'd) by hooks/lib/session-summary.js#scheduleSummaryBackfill
// so a session Stop never waits on `claude -p` distillation. Runs the
// session-backfill skill's backfill.py across RECENT CC sessions only
// (--since-hours), bounded so it never tries to distill the entire history in
// one sweep (which would be a quota bomb on first run). backfill.py is
// idempotent — it skips sessions that already have a structured note — so the
// only `claude -p` cost is genuinely new sessions. Stamps on success so the
// throttle holds. See beads cp-z0c.
//
// Self-contained: no stdin, no args. Exits 0 even on failure (best-effort —
// the next scheduled sweep catches up).

const { spawnSync } = require('child_process');
const { existsSync, writeFileSync } = require('fs');
const path = require('path');

const summary = require(path.join(__dirname, '..', 'hooks', 'lib', 'session-summary.js'));

const BACKFILL = path.join(
  __dirname, '..', 'skills', 'session-backfill', 'scripts', 'backfill.py'
);

// First-run window (no prior stamp): how far back to look. Bounds the very
// first sweep so it distills recent activity, not years of history. A full
// historical backfill is a deliberate manual `backfill.py --all`.
function firstWindowHours() {
  const raw = process.env.BRAYNEE_SUMMARY_FIRST_WINDOW_HOURS;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 48;
}

// Safety cap on sessions per project per sweep (belt-and-suspenders alongside
// --since-hours). Overridable.
function perProjectLimit() {
  const raw = process.env.BRAYNEE_SUMMARY_LIMIT;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 8;
}

// Skip sessions touched within the last N minutes — a still-open session has
// a fresh mtime, and summarizing it would lock in a premature "done" note
// (the sweep is idempotent and won't refresh it). A settled session gets
// picked up by a later sweep once it's been quiet this long.
function minAgeMinutes() {
  const raw = process.env.BRAYNEE_SUMMARY_MIN_AGE_MINUTES;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : 30;
}

// Window passed to --since-hours: cover everything since the last successful
// sweep, plus a buffer so a skipped/failed sweep never leaves a permanent
// gap. Falls back to the first-run window when there's no stamp.
function sinceHours() {
  const last = summary.lastSweepTs();
  if (!last) return firstWindowHours();
  const hours = (Date.now() - last) / (60 * 60 * 1000);
  return Math.max(hours + 4, summary.intervalMs() / (60 * 60 * 1000));
}

// Resolve a Python interpreter: prefer python3, fall back to python (Windows).
function pythonCmd() {
  for (const cmd of ['python3', 'python']) {
    try {
      const r = spawnSync(cmd, ['--version'], { stdio: 'ignore', windowsHide: true });
      if (r.status === 0) return cmd;
    } catch { /* try next */ }
  }
  return null;
}

function main() {
  // Single-flight: bail if another summary sweep already holds the lock.
  if (!summary.acquireLock('summary')) process.exit(0);

  try {
    if (!existsSync(BACKFILL)) process.exit(0);
    const py = pythonCmd();
    if (!py) process.exit(0); // no Python — nothing to do

    const res = spawnSync(
      py,
      [
        BACKFILL,
        '--all',
        '--since-hours', String(sinceHours()),
        '--min-age-minutes', String(minAgeMinutes()),
        '--limit', String(perProjectLimit()),
      ],
      {
        stdio: 'ignore',
        timeout: 30 * 60 * 1000, // 30 min ceiling
        windowsHide: true,
      }
    );

    // Stamp only on a clean run so a failed/killed sweep retries next cycle.
    if (res.status === 0) {
      try { writeFileSync(summary.STAMP_FILE, String(Date.now()), 'utf8'); }
      catch { /* non-fatal */ }
    }
  } catch {
    /* best-effort */
  } finally {
    summary.releaseLock();
  }
  process.exit(0);
}

main();
