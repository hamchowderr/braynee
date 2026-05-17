// stop-failure.js
// Hook: StopFailure — runs when a turn ends due to an API error
// (rate_limit / authentication_failed / billing_error / server_error / ...).
//
// HD-2.9 / cp-9kw: on an API error the turn ends via StopFailure, NOT Stop or
// SessionEnd. All of Brainy's session-note close + mtn-timer-stop logic lives
// on Stop/SessionEnd, so an API-error end leaves the session note status:active
// and the mtn timer running until the next SessionStart sweep (cp-re1). This
// hook performs the same close + timer-stop as session-end.js (shared via
// lib/session-close.js) so the failure is healed at the failure, not a session
// later.
//
// Per the hooks reference, StopFailure output and exit code are IGNORED — this
// hook is side-effect only (note write + timer stop + log). It emits nothing
// to stdout.

'use strict';

const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { closeActiveSession } = require(path.join(__dirname, 'lib', 'session-close.js'));

const HOOK = 'stop-failure';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }
    const errType = data.error_type || data.reason || 'unknown';

    // stopTimer:true — Stop's timer-stop hooks never ran on this path.
    const r = closeActiveSession(data, { stopTimer: true });
    if (r.closed) {
      log.info(HOOK, `API error (${errType}) — closed session ${r.file} for ${r.project}, stopped timer`);
    } else {
      log.info(HOOK, `API error (${errType}) — no active session to close (timer stop attempted)`);
    }
  } catch (e) {
    try { log.error(HOOK, `crash: ${e.message}`); } catch {}
  }
  process.exit(0);
});
