// beads-nudge.js
// Hook: UserPromptSubmit — periodic reminder about the beads workflow.
// Fires every N prompts (default 7, override with BRAINY_BEADS_NUDGE_EVERY)
// when cwd is in ~/code/* AND there is no in_progress beads issue.
// Silent otherwise. Counter resets per session and per nudge.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'beads-nudge';
const CODE_DIR = path.join(os.homedir(), 'code');
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
    return { counter: 0, sessionId: null };
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
    const data = input ? JSON.parse(input) : {};
    const cwd = data.cwd || process.cwd();
    const sessionId = data.session_id || null;

    if (!cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase())) process.exit(0);

    const beadsRoot = findBeadsAncestor(cwd);
    if (!beadsRoot) process.exit(0); // check-beads-init handles missing init

    const state = readState();

    // Reset counter on new session boundary.
    if (state.sessionId !== sessionId) {
      state.counter = 0;
      state.sessionId = sessionId;
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
