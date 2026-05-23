// session-summary.js — throttled, single-flight scheduler for auto-distilling
// Claude Code session transcripts into structured per-project vault notes.
//
// Braynee exports a RAW transcript on every Stop (session-export-qmd.js), but
// the *useful* structured summary (TL;DR / Outcome / Decisions) was only ever
// produced by manually running the session-backfill skill. This wires that
// distillation into the Stop hook on a throttle so per-project history stays
// current automatically. See beads cp-z0c.
//
// Distillation shells out to `claude -p` (the user's Claude Code subscription,
// NO API billing), so it is throttled (default 6 h), single-flight, and
// detached — a session Stop never blocks on it and Claude calls never pile up.
// The detached runner (scripts/session-summary-runner.js) does the work and
// bounds itself to recent sessions (--since-hours) so it never distills the
// entire history in one sweep.

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// Co-locate control files with the qmd cache (same convention as
// qmd-reindex.js), falling back to the OS temp dir if absent.
function controlDir() {
  const cacheDir = path.join(os.homedir(), '.cache', 'qmd');
  try {
    if (fs.existsSync(cacheDir)) return cacheDir;
  } catch { /* ignore */ }
  return os.tmpdir();
}

const LOCK_FILE = path.join(controlDir(), '.braynee-session-summary.lock');
const STAMP_FILE = path.join(controlDir(), '.braynee-session-summary.stamp');

// A lock older than this is presumed dead. A summary sweep across recent
// sessions can legitimately run for minutes (claude -p per new session), so
// keep this generous.
const LOCK_STALE_MS = 30 * 60 * 1000; // 30 min

// Minimum spacing between summary sweeps. The sweep is idempotent and
// incremental (only distills sessions newer than the last run), so this just
// prevents back-to-back claude -p bursts. Overridable for testing.
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h

function intervalMs() {
  const raw = process.env.BRAYNEE_SUMMARY_INTERVAL_MS;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_INTERVAL_MS;
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Atomic single-flight acquire via exclusive create ('wx'). Steals a
// stale/dead lock once. Mirrors qmd-reindex.js#acquireLock.
function acquireLock(op) {
  const payload = JSON.stringify({ pid: process.pid, op, ts: Date.now() });
  try {
    fs.writeFileSync(LOCK_FILE, payload, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') return false;
  }
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    const stale = !cur || (Date.now() - (cur.ts || 0)) > LOCK_STALE_MS;
    if (stale || !pidAlive(cur.pid)) {
      fs.writeFileSync(LOCK_FILE, payload);
      return true;
    }
  } catch {
    try { fs.writeFileSync(LOCK_FILE, payload); return true; } catch { /* ignore */ }
  }
  return false;
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
}

function lastSweepTs() {
  try { return Number(fs.readFileSync(STAMP_FILE, 'utf8').trim()) || 0; }
  catch { return 0; }
}

// Throttle check + fire-and-forget. The detached runner does its own locking,
// distillation, and stamping so the Stop hook returns instantly. Returns a
// small status object for logging.
function scheduleSummaryBackfill() {
  const since = Date.now() - lastSweepTs();
  if (since < intervalMs()) {
    return { scheduled: false, reason: 'throttled', sinceMs: since };
  }
  const runner = path.join(__dirname, '..', '..', 'scripts', 'session-summary-runner.js');
  try {
    const child = spawn(process.execPath, [runner], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return { scheduled: true };
  } catch (e) {
    return { scheduled: false, reason: 'spawn-failed', error: e.message };
  }
}

module.exports = {
  scheduleSummaryBackfill,
  // exported for the detached runner + tests
  acquireLock,
  releaseLock,
  lastSweepTs,
  intervalMs,
  LOCK_FILE,
  STAMP_FILE,
};
