// beads-nudge.js
// Hook: UserPromptSubmit — periodic reminder about the beads workflow.
// Fires every N prompts (default 7, override with BRAYNEE_BEADS_NUDGE_EVERY)
// when the session is working on code AND there is no in_progress beads issue.
// Silent otherwise. Counter resets per session and per nudge.
//
// "Working on code" is detected structurally via lib/is-code-context.js
// (a language/project manifest or source files in an ancestor) — NOT a
// hardcoded ~/code path, since braynee is a universal plugin.
//
// The per-event cwd is transient: skill base dirs and `bash cd` flip it
// mid-session. The gate keys off the SESSION's working directory via
// lib/is-code-context.js sessionDir() (anchored at SessionStart, cached per
// session_id), so a vault-rooted session stays silent for the whole session
// regardless of where a subprocess cd's.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { findCodeRoot, findBeadsRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

const HOOK = 'beads-nudge';
const STATE_FILE = path.join(os.homedir(), '.claude', 'beads-nudge-state.json');
const THRESHOLD = Math.max(1, parseInt(process.env.BRAYNEE_BEADS_NUDGE_EVERY || '7', 10));

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { counter: 0, sessionId: null };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch (e) {
    // State is what throttles the nudge. A failed write means every run reads
    // the default and the nudge either repeats forever or never fires again.
    log.debug(HOOK, `could not persist nudge state: ${e && e.message}`);
  }
}

function hasInProgress(beadsRoot) {
  try {
    const out = execSync('bd list --status in_progress --json', {
      cwd: beadsRoot, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
    }).trim();
    const list = JSON.parse(out);
    return Array.isArray(list) && list.length > 0;
  } catch {
    return false;
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    // F-3.4: a malformed/over-escaped stdin payload must not silently kill the
    // nudge for the rest of the session. Guard the parse and fall back to {}
    // so the remaining logic (cwd default, state, threshold) still runs.
    let data = {};
    if (input) {
      try {
        data = JSON.parse(input);
      } catch (parseErr) {
        log.warn(HOOK, `unparseable stdin, using empty payload: ${parseErr.message}`);
        data = {};
      }
    }

    const sessionId = data.session_id || null;

    // F-3.2a + F-3.2b: gate on the SESSION's working directory, not this
    // event's transient cwd. sessionDir() anchors the cwd seen at SessionStart
    // and returns it for every later hook in the session — so a vault-rooted
    // session stays silent even if a subprocess cd'd into a code project.
    // findCodeRoot() then detects a code context structurally (no ~/code).
    const sessDir = sessionDir(data);
    const codeRoot = findCodeRoot(sessDir);

    const state = readState();

    // Reset counter on a new session boundary.
    if (state.sessionId !== sessionId) {
      state.counter = 0;
      state.sessionId = sessionId;
    }

    if (!codeRoot) {
      writeState(state);
      process.exit(0); // not a code session — stay silent
    }

    // Resolve the .beads/ root from the session's code root (excludes the
    // global ~/.beads from `bd init --shared-server`).
    const beadsRoot = findBeadsRoot(codeRoot);
    if (!beadsRoot) {
      writeState(state);
      process.exit(0); // check-beads-init handles missing init
    }

    state.counter += 1;

    if (state.counter >= THRESHOLD) {
      // Threshold reached. Only nudge if work isn't already tracked.
      if (!hasInProgress(beadsRoot)) {
        process.stdout.write(
          `## Beads Reminder (every ${THRESHOLD} prompts)\n\n` +
          `${state.counter} prompts without a claimed beads issue. ` +
          `Before any code change, confirm an \`in_progress\` issue exists (\`bd list --status in_progress\`). ` +
          `If none, ask the user what to work on, then \`bd create\` and \`bd update <id> --claim\`.\n`
        );
        log.info(HOOK, `nudged after ${state.counter} prompts (no in_progress)`);
      }
      state.counter = 0; // reset regardless — silent when work is tracked
    }

    writeState(state);
    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
