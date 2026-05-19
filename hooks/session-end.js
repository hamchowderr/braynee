// session-end.js
// Hook: SessionEnd — Marks the active session note done, writes ended timestamp.
// Also runs `bd prime` so the next session inherits beads context.
//
// The bulk of the session-note write (Goal, Progress from commits, Session
// Summary) is already done by session-auto-close.js on every Stop. This hook
// just performs the final status flip and timestamp write so SessionStart on
// the next launch doesn't try to resume a stale session.
//
// cp-qqp: this hook is registered SYNCHRONOUS (no "async":true in hooks.json) —
// an async SessionEnd hook races process death on `Ctrl+D` exit and loses the
// close. cp-9kw: the close logic now lives in lib/session-close.js, shared
// with the StopFailure hook (an API-error turn-end never fires SessionEnd).

const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { closeActiveSession } = require(path.join(__dirname, 'lib', 'session-close.js'));

const HOOK = 'session-end';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }

    // F-3.2a + F-3.2b: closeActiveSession resolves the SESSION's code root
    // (anchored at SessionStart, detected structurally) — not a ~/code prefix
    // on the transient cwd — then runs `bd prime` and closes the note.
    const r = closeActiveSession(data);
    if (r.closed) {
      log.info(HOOK, `closed session ${r.file} for ${r.project}`);
      process.stderr.write(`Session note closed: ${r.file}\n`);
    } else if (r.project) {
      log.info(HOOK, `no active session for ${r.project} — nothing to close`);
    }
  } catch (e) {
    try { log.error(HOOK, `crash: ${e.message}`); } catch {}
  }
  process.exit(0);
});
