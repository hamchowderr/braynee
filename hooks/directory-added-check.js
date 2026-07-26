#!/usr/bin/env node
'use strict';

// directory-added-check.js
// Hook: DirectoryAdded (CC 2.1.219) — fires after `/add-dir` or the SDK
// `register_repo_root` control request registers a new working directory
// mid-session. cp-hdpr.2.
//
// The gap this closes: braynee tracked location two ways and both were blind to
// a newly REGISTERED root.
//   - cwd-changed-check.js reacts to the cwd MOVING (a `cd` in a Bash call).
//   - lib/is-code-context.js anchors the session at SessionStart and treats
//     later cwd as transient noise.
// `/add-dir` moves nothing and changes no anchor, so after it braynee kept
// resolving projects, beads scope and session attribution against the ORIGINAL
// root while the model worked in a directory braynee had never heard of.
//
// Deliberately does NOT re-anchor the session. cwd-changed-check.js established
// that rule ("anchoring is a SessionStart concern; this only informs") and the
// reasoning holds harder here: adding a reference directory must not drag the
// session away from the project being worked. The issue's original design said
// to re-anchor when the new root looked "better"; that was written before
// reading cwd-changed-check.js and would have contradicted the architecture.
// Informing is the correct behavior; re-anchoring would be a silent surprise.
//
// PAYLOAD CAVEAT: DirectoryAdded is new in 2.1.219 and is NOT in the published
// hooks reference — the field carrying the added path is unverified. So the path
// is read across plausible keys, and every fire records the raw payload at debug
// level so the first real occurrence documents the true shape. Same approach as
// agent-notification-check.js (cp-hdpr.1).

const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { findCodeRoot, findBeadsRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));
const { stateFile, shouldReport } = require(path.join(__dirname, 'lib', 'session-report-state.js'));

const HOOK = 'directory-added-check';
const STATE_FILE = stateFile('braynee-dir-added-reported.json');

// Unverified schema: try the plausible keys in order of likelihood. `cwd` is
// deliberately NOT among them — on this event cwd is the session's directory,
// not the directory being added, so using it would report a false positive on
// every fire.
function addedPath(data) {
  const keys = ['directory', 'directory_path', 'added_directory', 'path',
    'added_path', 'root', 'repo_root', 'dir'];
  for (const k of keys) {
    const v = data[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // Some payloads nest the detail one level down.
  for (const container of ['directory_info', 'detail', 'data']) {
    const c = data[container];
    if (c && typeof c === 'object') {
      for (const k of keys) {
        const v = c[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
  }
  return null;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    let data = {};
    if (input) { try { data = JSON.parse(input); } catch { data = {}; } }

    // Self-gate in JS — never rely on config-level gating alone (CLAUDE.md).
    if (data.hook_event_name && data.hook_event_name !== 'DirectoryAdded') process.exit(0);

    const added = addedPath(data);
    if (!added) {
      // Not silent-and-forget: an unrecognized shape is exactly what the debug
      // channel exists for, otherwise this hook would quietly do nothing forever
      // if CC named the field something we did not guess.
      try {
        log.debug(HOOK, `no directory field found; keys=[${Object.keys(data).join(',')}] raw=${JSON.stringify(data).slice(0, 600)}`);
      } catch { /* never break the hook to log */ }
      process.exit(0);
    }

    const addedRoot = findCodeRoot(added);
    if (!addedRoot) process.exit(0); // a non-code directory: nothing braynee tracks

    const anchoredRoot = findCodeRoot(sessionDir(data));
    // Adding a directory inside the project already anchored is a no-op worth
    // no words.
    if (anchoredRoot && path.resolve(anchoredRoot) === path.resolve(addedRoot)) process.exit(0);

    if (!shouldReport(STATE_FILE, data.session_id || null, addedRoot)) process.exit(0);

    const addedName = path.basename(addedRoot);
    const hasBeads = !!findBeadsRoot(addedRoot);
    log.info(HOOK, `new root registered: ${addedName} (beads=${hasBeads}) anchored=${anchoredRoot ? path.basename(anchoredRoot) : 'none'}`);

    const anchorClause = anchoredRoot
      ? `This session is anchored to "${path.basename(anchoredRoot)}" (${anchoredRoot}), and braynee's session note, beads scope and timer stay attributed there — work done under "${addedName}" will be recorded against "${path.basename(anchoredRoot)}" unless a new session is started for it.`
      : `This session has no anchored project, so nothing is currently attributed to "${addedName}".`;

    const beadsClause = hasBeads
      ? ` "${addedName}" has its own .beads database, so \`bd\` commands run from this session still target the anchored project unless invoked with \`-C ${addedRoot}\`.`
      : ` "${addedName}" has no .beads database.`;

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'DirectoryAdded',
        additionalContext:
          `A new working directory was registered mid-session: "${addedName}" (${addedRoot}), a recognized code project. ` +
          anchorClause + beadsClause,
      },
    }));
  } catch (e) {
    try { log.error(HOOK, `crash: ${e.message}`); } catch { /* logging must never break the hook */ }
  }
  process.exit(0);
});
