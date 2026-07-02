#!/usr/bin/env node
// qmd-embed-runner.js — detached, single-flight `qmd embed` runner.
//
// Spawned (detached, unref'd) by hooks/lib/qmd-reindex.js#scheduleEmbed so a
// session Stop never waits on model inference. Holds the shared reindex lock
// for the full embed so it can never overlap a `qmd update` (SQLite
// corruption guard). Writes the throttle stamp only on success.
//
// Self-contained: no stdin, no args. Exits 0 even on failure (best-effort —
// the next scheduled run catches up).

const { execSync, spawnSync } = require('child_process');
const { existsSync, writeFileSync } = require('fs');
const path = require('path');
const os = require('os');

const reindex = require(path.join(__dirname, '..', 'hooks', 'lib', 'qmd-reindex.js'));

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

    const res = spawnSync(process.execPath, [qmdJs, 'embed'], {
      stdio: 'ignore',
      timeout: 15 * 60 * 1000, // 15 min ceiling for a large backlog
      windowsHide: true, // no console-window flash on Windows
      // Pin HOME so qmd embeds into the SAME ~/.cache/qmd index the rest of
      // braynee reads. Without this, a CC-hook-spawned runner (empty HOME on
      // Windows) embeds into a /tmp fallback index nobody queries.
      // See qmd-wrapper.mjs + vault memory reference_qmd_home_cache_split.
      env: { ...process.env, HOME: process.env.HOME || os.homedir() },
    });

    // Stamp only on a clean run so a failed/killed embed retries next cycle
    // instead of being throttled out.
    if (res.status === 0) {
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
