#!/usr/bin/env node
// qmd-embed-runner.js — detached, single-flight `qmd embed` runner.
//
// Spawned (detached, unref'd) by hooks/lib/qmd-reindex.js#scheduleEmbed so a
// session Stop never waits on model inference. Holds the shared reindex lock
// for the full embed so it can never overlap a `qmd update` (SQLite
// corruption guard).
//
// Self-contained: no stdin, no args. Exits 0 even on failure (best-effort —
// the next scheduled run catches up).

const { execSync, spawnSync } = require('child_process');
const { existsSync, writeFileSync, readFileSync } = require('fs');
const path = require('path');
const os = require('os');

const reindex = require(path.join(__dirname, '..', 'hooks', 'lib', 'qmd-reindex.js'));
const log = require(path.join(__dirname, '..', 'hooks', 'lib', 'hook-logger.js'));

const LOG_NAME = 'qmd-embed';

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// `qmd embed` is RAM-bound, not CPU-bound: it loads an embedding model, a
// reranker and a query-expansion GGUF via llama.cpp. Uncapped it pulls the
// whole pending backlog into memory at once — enough to exhaust a 16 GB box
// and thrash. Capping docs/MB per batch bounds that, with no throughput loss
// since cost scales with the backlog either way.
//
// These caps bound the TEXT held per batch, NOT the model footprint. Measured
// on a 3.9k-doc backlog: ~0.5-1.3 GB on small notes, but ~3.5 GB once it
// reached large (>1 MB) documents. Do not read these as a memory ceiling —
// that is what the free-memory guard below is for.
const MAX_DOCS_PER_BATCH = envInt('BRAYNEE_QMD_EMBED_MAX_DOCS', 48);
const MAX_BATCH_MB = envInt('BRAYNEE_QMD_EMBED_MAX_MB', 6);

const GB = 1024 * 1024 * 1024;

// Free-memory guard. Starting a ~3.5 GB embed on a machine that is already
// out of memory pushes the whole box into swap — the embed thrashes (one doc
// per 30 min was observed) AND the user's foreground work crawls. braynee is
// what spawns this process, so bounding it is braynee's job.
//
// Derived from total RAM so it adapts to any machine with zero configuration:
// want ~25% of total free, floored at 1.5 GB (a small box still needs real
// headroom) and capped at 3 GB (a 64 GB box should not demand 16 GB).
function minFreeBytes() {
  return Math.min(Math.max(os.totalmem() * 0.25, 1.5 * GB), 3 * GB);
}

// A deferral must NEVER become a silent off-switch. An embed that quietly
// stops running is precisely the failure that let this index drift for five
// weeks while every session reported success. So low memory can only ever
// postpone a run, never cancel it: after this many consecutive deferrals we
// start anyway and let the OS arbitrate.
const MAX_CONSECUTIVE_DEFERRALS = 3;
const DEFER_FILE = path.join(path.dirname(reindex.STAMP_FILE), '.braynee-qmd-embed-defers');

function readDeferrals() {
  try { return Number(readFileSync(DEFER_FILE, 'utf8').trim()) || 0; }
  catch { return 0; }
}

function writeDeferrals(n) {
  try { writeFileSync(DEFER_FILE, String(n), 'utf8'); } catch { /* non-fatal */ }
}

const gb = (bytes) => (bytes / GB).toFixed(1);

// Ceiling for one detached embed. Generous because it runs detached and holds
// only the reindex lock — nothing waits on it. A backlog of a few thousand
// docs takes well over the old 15 min, and being killed short meant the run
// never counted as progress (see PROGRESS_MS below).
const EMBED_TIMEOUT_MS = envInt('BRAYNEE_QMD_EMBED_TIMEOUT_MS', 45 * 60 * 1000);

// Ceiling for the weekly cleanup that follows the embed. It vacuums the SQLite
// file, so it is I/O bound and finishes in seconds on an index this size; the
// cap only exists so a wedged run cannot hold the reindex lock forever.
const CLEANUP_TIMEOUT_MS = envInt('BRAYNEE_QMD_CLEANUP_TIMEOUT_MS', 10 * 60 * 1000);

// Window handed to qmd itself. qmd caps its own embed session (30 min by
// default) and skips whatever is left, so a 45-min run stopped embedding at
// 30. `--timeout <minutes>` (qmd >= 2.6.3) moves that cap; set it one minute
// inside our ceiling so qmd ends the session and exits cleanly instead of
// being SIGTERM'd mid-batch.
const QMD_SESSION_MINUTES = Math.max(1, Math.floor(EMBED_TIMEOUT_MS / 60000) - 1);

// Older qmd does not know the flag and would exit on an unknown option, so
// only pass it when the installed CLI is new enough.
function qmdSupportsTimeout(qmdJs) {
  try {
    const pkg = JSON.parse(readFileSync(path.join(qmdJs, '..', '..', '..', 'package.json'), 'utf8'));
    const [maj, min, pat] = String(pkg.version).split('.').map(Number);
    return maj > 2 || (maj === 2 && (min > 6 || (min === 6 && pat >= 3)));
  } catch {
    return false;
  }
}

// A run that survived this long did real embedding work even if it was later
// killed by the ceiling, so it counts as progress and advances the stamp.
// Anything shorter is a genuine startup failure (qmd broken, models missing)
// and must NOT stamp, so the next Stop retries promptly.
const PROGRESS_MS = 60 * 1000;

// Mirror qmd-wrapper.mjs#findQmdJs — locate the global @tobilu/qmd CLI.
function findQmdJs() {
  let globalRoot;
  try {
    globalRoot = execSync('npm root -g', { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return null;
  }
  const qmdPath = path.join(globalRoot, '@tobilu', 'qmd', 'dist', 'cli', 'qmd.js');
  return existsSync(qmdPath) ? qmdPath : null;
}

function main() {
  // Single-flight: bail immediately if a reindex (update or another embed)
  // already holds the lock.
  if (!reindex.acquireLock('embed')) {
    log.debug(LOG_NAME, 'skipped: another reindex holds the lock');
    process.exit(0);
  }

  // NOTE: every early exit below must `return`, never process.exit(). We hold
  // the lock from here on, and process.exit() skips `finally` — so exiting
  // directly leaks the lockfile and every later reindex has to wait out the
  // 30-min staleness window (or match a dead PID) before it can proceed.
  try {
    const qmdJs = findQmdJs();
    if (!qmdJs) {
      log.debug(LOG_NAME, 'skipped: qmd CLI not installed');
      return;
    }

    // scheduleEmbed spawns us on every Stop. When it was inside the time
    // throttle it sets CHECK_BACKLOG=1, meaning "only embed if the backlog is
    // big enough to justify jumping the queue". Evaluating that needs a
    // `qmd status`, which is far too slow for a Stop hook but perfectly fine
    // here — we're detached and nothing is waiting on us.
    if (process.env.BRAYNEE_QMD_EMBED_CHECK_BACKLOG === '1') {
      const pending = reindex.pendingEmbedCount(process.env.BRAYNEE_QMD_WRAPPER || null);
      const threshold = reindex.embedPendingThreshold();
      if (pending == null || pending < threshold) {
        log.debug(LOG_NAME, `skipped: throttled (pending=${pending}, threshold=${threshold})`);
        return;
      }
      log.info(LOG_NAME, `backlog escape hatch: pending=${pending} >= ${threshold}, embedding now`);
    }

    // Free-memory guard — postpone (never cancel) when the box has no room.
    const free = os.freemem();
    const minFree = minFreeBytes();
    if (free < minFree) {
      const deferrals = readDeferrals();
      if (deferrals < MAX_CONSECUTIVE_DEFERRALS) {
        writeDeferrals(deferrals + 1);
        log.info(
          LOG_NAME,
          `deferred: ${gb(free)}GB free < ${gb(minFree)}GB needed ` +
          `(${deferrals + 1}/${MAX_CONSECUTIVE_DEFERRALS} — runs anyway after that)`,
        );
        return;
      }
      log.warn(
        LOG_NAME,
        `low memory (${gb(free)}GB free < ${gb(minFree)}GB) but hit ` +
        `${MAX_CONSECUTIVE_DEFERRALS} deferrals — embedding anyway rather than stalling`,
      );
    }
    writeDeferrals(0);

    const startedAt = Date.now();
    const res = spawnSync(
      process.execPath,
      [
        qmdJs, 'embed',
        '--max-docs-per-batch', String(MAX_DOCS_PER_BATCH),
        '--max-batch-mb', String(MAX_BATCH_MB),
        ...(qmdSupportsTimeout(qmdJs) ? ['--timeout', String(QMD_SESSION_MINUTES)] : []),
      ],
      {
        stdio: 'ignore',
        timeout: EMBED_TIMEOUT_MS,
        windowsHide: true, // no console-window flash on Windows
        // Pin HOME so qmd embeds into the SAME ~/.cache/qmd index the rest of
        // braynee reads. Without this, a CC-hook-spawned runner (empty HOME on
        // Windows) embeds into a /tmp fallback index nobody queries.
        // See qmd-wrapper.mjs + vault memory reference_qmd_home_cache_split.
        env: { ...process.env, HOME: process.env.HOME || os.homedir() },
      },
    );

    // Stamp on a clean run OR on a run that embedded for a meaningful stretch
    // before hitting the ceiling. Stamping ONLY on exit 0 deadlocks a large
    // backlog: the run gets killed, never stamps, and the throttle treats the
    // index as never-embedded forever — so the stamp froze for weeks while
    // every session re-ran a doomed embed from scratch.
    const elapsed = Date.now() - startedAt;
    const stamped = res.status === 0 || elapsed >= PROGRESS_MS;
    if (stamped) {
      try { writeFileSync(reindex.STAMP_FILE, String(Date.now()), 'utf8'); }
      catch { /* non-fatal */ }
    }
    // Log every outcome. The runner used to be completely silent, so an embed
    // that never ran for weeks was invisible — the only signal was a stamp
    // file nobody looks at. qmd's own session cap now matches our window (see
    // QMD_SESSION_MINUTES), so a large backlog ends with a clean exit and a
    // "Session expired" line rather than a surprise non-zero status.
    log.info(
      LOG_NAME,
      `embed finished: exit=${res.status} elapsed=${Math.round(elapsed / 1000)}s stamped=${stamped}`,
    );

    // Weekly `qmd cleanup`, riding along under the lock we already hold. Embeds
    // orphan vector chunks as documents change and nothing reclaimed them: a
    // real index reached 26k orphans — half its vector rows — before anyone ran
    // this by hand. Failure is non-fatal and unstamped, so it retries next run.
    if (reindex.cleanupDue()) {
      const clean = spawnSync(process.execPath, [qmdJs, 'cleanup'], {
        stdio: 'ignore',
        timeout: CLEANUP_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, HOME: process.env.HOME || os.homedir() },
      });
      if (clean.status === 0) reindex.markCleanupRun();
      log.info(LOG_NAME, `qmd cleanup: exit=${clean.status}`);
    }
  } catch (e) {
    log.debug(LOG_NAME, `embed errored: ${e && e.message}`);
  } finally {
    reindex.releaseLock();
  }
  process.exit(0);
}

main();
