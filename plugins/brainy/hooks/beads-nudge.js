// beads-nudge.js
// Hook: UserPromptSubmit — periodic reminder about the beads workflow.
// Fires every N prompts (default 7, override with BRAINY_BEADS_NUDGE_EVERY)
// when the session is working on code AND there is no in_progress beads issue.
// Silent otherwise. Counter resets per session and per nudge.
//
// "Working on code" is detected structurally via lib/is-code-context.js
// (a language/project manifest or source files in an ancestor) — NOT a
// hardcoded ~/code path, since brainy is a universal plugin.
//
// The per-event cwd is transient: skill base dirs and `bash cd` flip it
// mid-session. To stay stable we resolve the session's code root once and
// cache it in the state file; later prompts reuse the established root even
// if the current cwd has wandered into a skill dir or unrelated subtree.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { findCodeRoot } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

const HOOK = 'beads-nudge';
const STATE_FILE = path.join(os.homedir(), '.claude', 'beads-nudge-state.json');
const THRESHOLD = Math.max(1, parseInt(process.env.BRAINY_BEADS_NUDGE_EVERY || '7', 10));

function findBeadsAncestor(startDir) {
  let dir = startDir;
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.beads'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return { counter: 0, sessionId: null, codeRoot: null };
  }
}

function writeState(state) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
}

function hasInProgress(beadsRoot) {
  try {
    const out = execSync('bd list --status in_progress --json', {
      cwd: beadsRoot, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe']
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

    const cwd = data.cwd || process.cwd();
    const sessionId = data.session_id || null;

    const state = readState();

    // Reset counter + cached code root on a new session boundary.
    if (state.sessionId !== sessionId) {
      state.counter = 0;
      state.codeRoot = null;
      state.sessionId = sessionId;
    }

    // F-3.2a + F-3.2b: detect a code context structurally instead of a
    // hardcoded ~/code prefix, and prefer the session's stable code root over
    // the transient per-event cwd. The cwd flips when a skill sets its base
    // dir or `bash cd` moves around; the established root does not.
    let codeRoot = findCodeRoot(cwd);
    if (codeRoot) {
      // Found a code root from the current cwd — record it as the session's.
      state.codeRoot = codeRoot;
    } else if (state.codeRoot && fs.existsSync(state.codeRoot)) {
      // cwd wandered out of any project (skill base dir, temp dir, …) but the
      // session already established a code root earlier — keep using it.
      codeRoot = state.codeRoot;
    }

    if (!codeRoot) {
      writeState(state);
      process.exit(0); // not a code session — stay silent
    }

    // Prefer a .beads/ ancestor of the code root; fall back to the code root.
    const beadsRoot = findBeadsAncestor(codeRoot) || findBeadsAncestor(cwd);
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
