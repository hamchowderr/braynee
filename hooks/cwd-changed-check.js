#!/usr/bin/env node
'use strict';

// cwd-changed-check.js
// Hook: CwdChanged — fires whenever the working directory changes (e.g. a
// `cd` inside a Bash tool call).
//
// HD-12.2 / cp-7io: Braynee anchors the session's project at SessionStart
// (sessionDir(), cp-d9g/F-3.2) and treats later cwd as transient noise. The
// failure mode: `cd` from project A into project B and work there mid-session
// → all of B's work is attributed to A's session note + A's beads scope. This
// hook compares the NEW cwd's detected code root against the session-anchored
// code root; if it is a DIFFERENT recognized project, it surfaces a FACTUAL
// note (per cp-psc / HD-R2.2). It deliberately does NOT auto-reanchor or open
// a new session note — anchoring is a SessionStart concern; this only informs.
//
// Dedup: only surfaces when the *project root* actually changes vs the last
// one reported for this session (a state file), so a long sequence of `cd`s
// within one project doesn't spam.

const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { findCodeRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));
// cp-hdpr.2: the dedup state lived here first; it now lives in lib/ so
// directory-added-check.js shares one implementation instead of a second copy
// that drifts. Same file name, same semantics — only the code moved.
const { stateFile, shouldReport } = require(path.join(__dirname, 'lib', 'session-report-state.js'));

const HOOK = 'cwd-changed-check';
const STATE_FILE = stateFile('braynee-cwd-reported.json');

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }
    const newCwd = data.cwd || process.cwd();
    const sid = data.session_id || null;

    // The session's anchored project (do NOT re-anchor — sessionDir reads the
    // existing anchor; it only writes one if none exists yet, which for a
    // CwdChanged event means SessionStart never ran, so there's nothing to
    // compare against).
    const anchoredDir = sessionDir(data);
    const anchoredRoot = findCodeRoot(anchoredDir);
    const newRoot = findCodeRoot(newCwd);

    // Only act when BOTH are recognized code projects and they differ.
    if (!newRoot || !anchoredRoot) { process.exit(0); }
    if (path.resolve(newRoot) === path.resolve(anchoredRoot)) { process.exit(0); }

    // Dedup per session: don't re-report the same crossed-into project.
    if (!shouldReport(STATE_FILE, sid, newRoot)) process.exit(0);

    const anchoredName = path.basename(anchoredRoot);
    const newName = path.basename(newRoot);
    log.info(HOOK, `cwd crossed project boundary: anchored=${anchoredName} now=${newName}`);

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'CwdChanged',
        additionalContext:
          `The working directory moved into a different recognized project. ` +
          `This session is anchored to "${anchoredName}" (${anchoredRoot}); the current directory resolves to "${newName}" (${newRoot}). ` +
          `Braynee's session note, beads scope, and timer remain attributed to "${anchoredName}" — work done here under "${newName}" will be recorded against "${anchoredName}" unless a new session is started for "${newName}".`,
      },
    }));
  } catch (e) {
    try { log.error(HOOK, `crash: ${e.message}`); } catch {}
  }
  process.exit(0);
});
