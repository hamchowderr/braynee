// qmd-reindex.js — shared QMD reindex helpers for braynee hooks.
//
// Two operations with very different cost profiles:
//   • keyword update (`qmd update -c vault`) — cheap, content-hash incremental.
//     Run synchronously on the Stop hook (existing behaviour).
//   • embed (`qmd embed`)                    — expensive, model inference.
//     Throttled + detached so it never blocks a session stop and never
//     thrashes. Braynee previously never ran this at all, so vectors drifted
//     stale (~47% pending observed). See beads cp-8xq.
//
// Single-flight lockfile guards BOTH operations so a `qmd update` and a
// `qmd embed` can never write the SQLite index concurrently (corruption
// risk). The lock + throttle stamp live next to the qmd index.

const { execSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

// qmd keeps its index at ~/.cache/qmd/index.sqlite; co-locate control files
// there, falling back to the OS temp dir if that directory is absent.
function controlDir() {
  const cacheDir = path.join(os.homedir(), '.cache', 'qmd');
  try {
    if (fs.existsSync(cacheDir)) return cacheDir;
  } catch { /* ignore */ }
  return os.tmpdir();
}

const LOCK_FILE = path.join(controlDir(), '.braynee-qmd-reindex.lock');
const STAMP_FILE = path.join(controlDir(), '.braynee-qmd-embed.stamp');

// A lock older than this is presumed dead (process crashed mid-embed). A
// large embed backlog can legitimately run for several minutes, so keep
// this generous to avoid stealing a lock from a live embed.
const LOCK_STALE_MS = 30 * 60 * 1000; // 30 min

// Minimum spacing between embed runs. Embed only processes *pending* docs so
// cost scales with churn, not interval — this just prevents back-to-back
// runs. Overridable for testing / power users.
const DEFAULT_EMBED_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h

function embedIntervalMs() {
  const raw = process.env.BRAYNEE_QMD_EMBED_INTERVAL_MS;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_EMBED_INTERVAL_MS;
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Atomic single-flight acquire via exclusive create ('wx'). Returns true if
// this process now holds the lock. Steals a stale/dead lock once.
function acquireLock(op) {
  const payload = JSON.stringify({ pid: process.pid, op, ts: Date.now() });
  try {
    fs.writeFileSync(LOCK_FILE, payload, { flag: 'wx' });
    return true;
  } catch (e) {
    if (e.code !== 'EEXIST') return false;
  }
  // Lock exists — steal only if clearly stale or owner is dead.
  try {
    const cur = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    const stale = !cur || (Date.now() - (cur.ts || 0)) > LOCK_STALE_MS;
    if (stale || !pidAlive(cur.pid)) {
      fs.writeFileSync(LOCK_FILE, payload); // overwrite dead lock
      return true;
    }
  } catch {
    // Corrupt lock file → treat as stale.
    try { fs.writeFileSync(LOCK_FILE, payload); return true; } catch { /* ignore */ }
  }
  return false;
}

function releaseLock() {
  try { fs.unlinkSync(LOCK_FILE); } catch { /* already gone */ }
}

// Synchronous, non-blocking-on-error BM25 reindex. Skips entirely if a
// reindex (e.g. a detached embed) is already in flight — keyword staleness
// for one session is acceptable; index corruption is not.
function runKeywordUpdate(qmdWrapper) {
  if (!acquireLock('update')) return { ran: false, reason: 'locked' };
  try {
    execSync(`"${process.execPath}" "${qmdWrapper}" update -c vault`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 30000,
    });
    return { ran: true };
  } catch {
    return { ran: false, reason: 'error' }; // index catches up next run
  } finally {
    releaseLock();
  }
}

function lastEmbedTs() {
  try { return Number(fs.readFileSync(STAMP_FILE, 'utf8').trim()) || 0; }
  catch { return 0; }
}

// Throttle check + fire-and-forget. The detached runner does its own
// locking, embedding, and stamping so the Stop hook returns instantly.
// Returns a small status object for logging.
function scheduleEmbed() {
  const since = Date.now() - lastEmbedTs();
  const interval = embedIntervalMs();
  if (since < interval) {
    return { scheduled: false, reason: 'throttled', sinceMs: since };
  }
  const runner = path.join(__dirname, '..', '..', 'scripts', 'qmd-embed-runner.js');
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
  runKeywordUpdate,
  scheduleEmbed,
  // exported for the detached runner + tests
  acquireLock,
  releaseLock,
  LOCK_FILE,
  STAMP_FILE,
};
