// qmd-reindex.js — shared QMD reindex helpers for braynee hooks.
//
// Two operations with very different cost profiles:
//   • keyword update (`qmd update -c vault`) — cheap, content-hash incremental.
//     Run synchronously on the Stop hook (existing behaviour).
//   • embed (`qmd embed`)                    — expensive, model inference.
//     Detached + single-flight-locked so it never blocks a session stop and
//     never thrashes. Runs on every Stop by default (interval 0) to keep the
//     vector index fresh; re-throttle via BRAYNEE_QMD_EMBED_INTERVAL_MS on
//     weaker hardware. Braynee previously never ran this at all, so vectors
//     drifted stale (~47% pending observed). See beads cp-8xq, cp-z0r.
//
// Single-flight lockfile guards BOTH operations so a `qmd update` and a
// `qmd embed` can never write the SQLite index concurrently (corruption
// risk). The lock + throttle stamp live next to the qmd index.

const { execSync, spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const log = require(path.join(__dirname, 'hook-logger.js'));

const LOG_NAME = 'qmd-reindex';

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

// Beads → TaskNote body sync (see scripts/beads-body-sync.js). Beads issue
// description/close_reason live in hidden .beads/issues.jsonl dirs that QMD's
// walker refuses to index, so we copy them into the (already-indexed) vault
// TaskNote bodies before each keyword reindex. Throttled by a stamp so it
// doesn't re-scan every repo on every single Stop — freshness of tens of
// minutes is plenty for decision recall.
const BODY_SYNC_STAMP = path.join(controlDir(), '.braynee-beads-body-sync.stamp');
const BODY_SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 min

// Ceiling for the synchronous keyword update on the Stop path. It was 30s,
// against a run measured at 18s on a 10.6k-document index — 1.6x headroom on a
// number that only grows, and `qmd update` re-walks EVERY collection (it takes
// no -c), so the margin shrinks with any collection the user adds. Past the
// ceiling execSync SIGTERMs it every Stop and the index silently stops updating.
// Three minutes is still bounded but no longer a near-miss.
const UPDATE_TIMEOUT_MS = 3 * 60 * 1000;

// `qmd embed` leaves orphaned vector chunks behind as documents change, and
// nothing in braynee ever reclaimed them: a real index reached 26k orphans —
// 50% of its vector rows and ~35 MB — before anyone ran `qmd cleanup` by hand.
// It is cheap and safe (it also drops inactive document records and vacuums),
// so it rides along with the detached embed on a weekly stamp.
const CLEANUP_STAMP = path.join(controlDir(), '.braynee-qmd-cleanup.stamp');
const CLEANUP_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

function cleanupDue() {
  try {
    const last = Number(fs.readFileSync(CLEANUP_STAMP, 'utf8').trim()) || 0;
    return Date.now() - last >= CLEANUP_INTERVAL_MS;
  } catch {
    return true;   // never run here
  }
}

function markCleanupRun() {
  try { fs.writeFileSync(CLEANUP_STAMP, String(Date.now()), 'utf8'); }
  catch (e) { log.debug(LOG_NAME, `could not write cleanup stamp: ${e && e.message}`); }
}

// A lock older than this is presumed dead (process crashed mid-embed). A
// large embed backlog can legitimately run for several minutes, so keep
// this generous to avoid stealing a lock from a live embed.
const LOCK_STALE_MS = 30 * 60 * 1000; // 30 min

// Minimum spacing between embed runs. Default 0 = embed on every Stop so the
// vector index is "always fresh, even from today" — the single-flight lock in
// qmd-embed-runner.js already prevents overlap/thrashing, and `qmd embed` only
// processes *pending* docs, so cost scales with churn not interval. Set
// BRAYNEE_QMD_EMBED_INTERVAL_MS to a positive value to re-throttle on weaker
// hardware (the pending-count escape hatch below still applies in that case).
const DEFAULT_EMBED_INTERVAL_MS = 0;

function embedIntervalMs() {
  const raw = process.env.BRAYNEE_QMD_EMBED_INTERVAL_MS;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_EMBED_INTERVAL_MS;
}

// Backlog escape hatch: if at least this many docs are pending embedding,
// embed even though we're inside the time-throttle window. Without this,
// a heavy session can pile up hundreds of unembedded docs that then sit
// stale for up to a full interval (the cp-5aq bug: the cp-8xq design
// specced "run if >=N pending OR >=X hours" but only the time half shipped).
const DEFAULT_EMBED_PENDING_THRESHOLD = 200; // docs

function embedPendingThreshold() {
  const raw = process.env.BRAYNEE_QMD_EMBED_PENDING_THRESHOLD;
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_EMBED_PENDING_THRESHOLD;
}

// Best-effort read of the pending-embedding backlog from `qmd status`.
// Returns the count, or null if it can't be determined (caller fails open
// to the plain time throttle so a status hiccup never forces an embed).
//
// NEVER call this from a Stop hook. `qmd status` counts documents and vectors
// across the whole index and gets slow as the index grows — measured 46s on a
// 1.4 GB index. It used to run inline in scheduleEmbed() with a 10s timeout,
// which meant it ALWAYS timed out on a large index: the escape hatch below
// could never fire (defeating cp-5aq a second time) and every throttled Stop
// paid a 10s stall for an answer it never got. It now runs only inside the
// detached runner, which can afford to wait.
const PENDING_COUNT_TIMEOUT_MS = 5 * 60 * 1000;

function pendingEmbedCount(qmdWrapper, timeoutMs = PENDING_COUNT_TIMEOUT_MS) {
  if (!qmdWrapper) return null;
  try {
    const out = execSync(`"${process.execPath}" "${qmdWrapper}" status`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: timeoutMs,
      windowsHide: true,
    });
    const m = out.match(/Pending:\s*(\d+)/i);
    return m ? Number(m[1]) : null;
  } catch {
    return null;
  }
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

// Throttled, best-effort refresh of TaskNote bodies from beads issue data.
// Idempotent (writes only the notes whose issue description/close_reason
// changed), so after the initial backfill each run touches just the churn.
// Never throws — a failure here must not block the vault reindex.
function syncBeadsBodies() {
  try {
    const last = Number(fs.readFileSync(BODY_SYNC_STAMP, 'utf8').trim()) || 0;
    if (Date.now() - last < BODY_SYNC_INTERVAL_MS) return { ran: false, reason: 'throttled' };
  } catch { /* no stamp yet → run */ }
  try {
    const script = path.join(__dirname, '..', '..', 'scripts', 'beads-body-sync.js');
    execSync(`"${process.execPath}" "${script}" --write`, {
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 30000,
      windowsHide: true,
    });
    try { fs.writeFileSync(BODY_SYNC_STAMP, String(Date.now())); }
    catch (e) {
      // The stamp is the throttle. Without it the body sync re-runs on every
      // single invocation instead of once per interval — expensive and silent.
      log.debug(LOG_NAME, `could not write body-sync stamp: ${e && e.message}`);
    }
    return { ran: true };
  } catch (e) {
    // `reason: 'error'` told the caller nothing about WHAT failed. A permanently
    // failing body sync silently stops beads reasoning reaching QMD (cp-ccsh.11).
    log.debug(LOG_NAME, `beads body sync failed: ${e && e.message}`);
    return { ran: false, reason: 'error' }; // notes catch up on the next run
  }
}

// Synchronous, non-blocking-on-error BM25 reindex. Skips entirely if a
// reindex (e.g. a detached embed) is already in flight — keyword staleness
// for one session is acceptable; index corruption is not.
function runKeywordUpdate(qmdWrapper) {
  if (!acquireLock('update')) return { ran: false, reason: 'locked' };
  try {
    // Freshen beads-derived TaskNote bodies before indexing so the vault
    // picks up issue reasoning that QMD can't read from hidden .beads/ dirs.
    syncBeadsBodies();
    // `qmd update` takes no arguments — `case "update": await updateCollections()`
    // — so the `-c vault` this used to pass was silently ignored and every
    // collection was re-walked anyway. Passing a flag the CLI drops is worse
    // than passing none: it reads like the work is scoped when it is not.
    execSync(`"${process.execPath}" "${qmdWrapper}" update`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: UPDATE_TIMEOUT_MS,
      windowsHide: true,
    });
    return { ran: true };
  } catch (e) {
    // A permanently failing keyword update means vault search goes quietly stale
    // — the caller only ever saw reason:'error' (cp-ccsh.11). A TIMEOUT is the
    // likely shape as an index grows, and it is indistinguishable from a crash
    // at debug level, so it is called out by name and logged loud enough to
    // find: an index that stopped updating weeks ago is the failure this
    // codebase has already been bitten by once (see qmd-embed-runner).
    const timedOut = e && (e.killed || e.signal === 'SIGTERM');
    log.warn(LOG_NAME, timedOut
      ? `keyword reindex TIMED OUT after ${UPDATE_TIMEOUT_MS}ms — the vault index is not being updated`
      : `keyword reindex failed: ${e && e.message}`);
    return { ran: false, reason: timedOut ? 'timeout' : 'error' }; // index catches up next run
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
//
// Gating is "embed if >= N docs pending OR >= X hours since last embed":
// the time throttle prevents back-to-back runs, and the pending-count
// escape hatch keeps a heavy session from leaving the index stale for a
// whole interval. `qmdWrapper` is optional — without it we fall open to
// the plain time throttle. The detached runner's single-flight lock still
// guarantees two embeds can never overlap.
function scheduleEmbed(qmdWrapper) {
  const since = Date.now() - lastEmbedTs();
  const interval = embedIntervalMs();
  const throttled = since < interval;

  // Always spawn the detached runner; never decide here. Inside the throttle
  // window we hand it BRAYNEE_QMD_EMBED_CHECK_BACKLOG=1 and it evaluates the
  // pending-count escape hatch itself, where a slow `qmd status` costs nobody
  // anything. Spawning a node process that usually exits in milliseconds is
  // far cheaper on the Stop path than the inline check it replaces, which
  // blocked for its full 10s timeout on any non-trivial index.
  const runner = path.join(__dirname, '..', '..', 'scripts', 'qmd-embed-runner.js');
  try {
    const child = spawn(process.execPath, [runner], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        BRAYNEE_QMD_EMBED_CHECK_BACKLOG: throttled ? '1' : '0',
        BRAYNEE_QMD_WRAPPER: qmdWrapper || '',
      },
    });
    child.unref();
    return { scheduled: true, mode: throttled ? 'backlog-check' : 'due', sinceMs: since };
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
  pendingEmbedCount,
  embedPendingThreshold,
  cleanupDue,
  markCleanupRun,
  LOCK_FILE,
  STAMP_FILE,
  CLEANUP_STAMP,
};
