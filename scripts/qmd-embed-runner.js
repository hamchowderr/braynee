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
const { existsSync, writeFileSync } = require('fs');
const path = require('path');
const os = require('os');

const reindex = require(path.join(__dirname, '..', 'hooks', 'lib', 'qmd-reindex.js'));

function envInt(name, fallback) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// `qmd embed` is RAM-bound, not CPU-bound: it loads an embedding model, a
// reranker and a query-expansion GGUF via llama.cpp. Uncapped it pulls the
// whole pending backlog into memory at once — measured ~5 GB resident, enough
// to exhaust a 16 GB box and thrash. Capping docs/MB per batch holds it near
// ~1.2 GB with no throughput loss, since cost scales with the backlog either
// way. Without these caps users end up disabling the embed hook entirely.
const MAX_DOCS_PER_BATCH = envInt('BRAYNEE_QMD_EMBED_MAX_DOCS', 48);
const MAX_BATCH_MB = envInt('BRAYNEE_QMD_EMBED_MAX_MB', 6);

// Ceiling for one detached embed. Generous because it runs detached and holds
// only the reindex lock — nothing waits on it. A backlog of a few thousand
// docs takes well over the old 15 min, and being killed short meant the run
// never counted as progress (see PROGRESS_MS below).
const EMBED_TIMEOUT_MS = envInt('BRAYNEE_QMD_EMBED_TIMEOUT_MS', 45 * 60 * 1000);

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
  if (!reindex.acquireLock('embed')) process.exit(0);

  try {
    const qmdJs = findQmdJs();
    if (!qmdJs) process.exit(0); // qmd not installed — nothing to do

    const startedAt = Date.now();
    const res = spawnSync(
      process.execPath,
      [
        qmdJs, 'embed',
        '--max-docs-per-batch', String(MAX_DOCS_PER_BATCH),
        '--max-batch-mb', String(MAX_BATCH_MB),
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
    if (res.status === 0 || elapsed >= PROGRESS_MS) {
      try { writeFileSync(reindex.STAMP_FILE, String(Date.now()), 'utf8'); }
      catch { /* non-fatal */ }
    }
  } catch {
    /* best-effort */
  } finally {
    reindex.releaseLock();
  }
  process.exit(0);
}

main();
