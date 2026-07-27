#!/usr/bin/env node
'use strict';

// beads-dr-sync.js
// Hook: SessionStart — keeps the beads backup destinations from rotting
// (cp-uif3.2).
//
// This hook exists because of a measurement, not a theory. `bd backup sync` is
// MANUAL: bd's config shows `enabled=true … interval=15m0s`, but that interval
// belongs to bd's own internal auto-backup, NOT to pushing the Dolt-native
// backup to its destination. Nothing schedules the push. Observed on braynee —
// the one repo that HAD a destination:
//
//   Last backup: 8h ago        <- internal auto-backup, reassuring
//   Last sync:   35h43m ago    <- the destination, and the one that protects you
//
// It was synced during a session and was already a day and a half stale by the
// next one. Fleet-wide the same pattern is worse: internal backups 23 days old
// across most repos. Configuring destinations without scheduling the push would
// have produced exactly this — a directory that looks like a backup and silently
// stops being one.
//
// SessionStart, throttled to once a day, in a DETACHED child. The sweep walks
// ~36 repos and shells out to bd for each, which is far too heavy to run inline
// on a hook that fires whenever a session opens: the same reasoning that moved
// the mirror fleet sweep out of beads-batch-reconcile after it blew its budget.
// The hook returns immediately; the child owns its own clock.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'beads-dr-sync';

const STAMP = path.join(os.homedir(), '.claude', 'braynee-beads-dr-sync');
// Daily. The threat is a corrupted database, so the exposure window is "work
// done since the last sync" — a day is a sane ceiling for that, and the sweep is
// too heavy to run more often.
const INTERVAL_MS = 24 * 60 * 60 * 1000;

function due() {
  try {
    const last = Number(String(fs.readFileSync(STAMP, 'utf8')).trim()) || 0;
    return Date.now() - last >= INTERVAL_MS;
  } catch {
    return true;   // no stamp yet → first run
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    if (!due()) process.exit(0);

    const script = path.join(__dirname, '..', 'scripts', 'beads-dr.mjs');
    if (!fs.existsSync(script)) process.exit(0);

    // --sync only: this hook never CONFIGURES a destination. Rolling out backup
    // config across the fleet is a deliberate, reviewable act (`--init`), not
    // something a session-open hook should do behind the user's back.
    const child = spawn(process.execPath, [script, '--sync', '--quiet'], {
      detached: true,
      stdio: 'ignore',      // a detached child writing to stdout would corrupt the hook protocol
      windowsHide: true,
      env: process.env,
    });
    child.unref();

    // Stamped on SPAWN, not on completion: the child owns its outcome, and
    // stamping here is what keeps this to one sweep per day rather than one per
    // session. A failed sweep is visible in the next audit, which reports
    // staleness directly rather than trusting this stamp.
    try { fs.writeFileSync(STAMP, String(Date.now())); }
    catch (err) { log.debug(HOOK, `could not write stamp: ${err && err.message}`); }

    log.info(HOOK, 'spawned daily beads backup sync');
  } catch (e) {
    try { log.error(HOOK, `crash: ${e.message}`); } catch { /* logging must never break the hook */ }
  }
  process.exit(0);
});
