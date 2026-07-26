// commit-cadence-nudge.js
// Hook: PostToolUse (Bash, gated to bd close commands) — beads is the source of
// truth for units of work, so commit cadence counts confirmed-closed issues.
// Nudges the user to commit after 15 issues have been closed since the last commit.
//
// State file: ~/.claude/braynee-issue-counter.json
//   { "<repoRoot>": { "closedSince": <int>, "headSha": <sha> } }
//
// Counter resets when the repo's HEAD SHA changes (i.e. when the user actually
// commits). The HEAD-based reset means the counter is robust across sessions.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'commit-cadence-nudge';
const STATE_FILE = path.join(os.homedir(), '.claude', 'braynee-issue-counter.json');
const THRESHOLD = 15;

function run(cmd, opts = {}) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, ...opts }).trim(); }
  catch { return null; }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s), 'utf-8'); }
  catch (e) {
    // Cadence state; a failed write silently resets the counter every run.
    log.debug(HOOK, `could not persist cadence state: ${e && e.message}`);
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const cmd = (data.tool_input?.command || '').trim();
    const cwd = data.cwd || process.cwd();

    const closeMatch = cmd.match(/^bd\s+(?:close\s+([\w.-]+)|update\s+([\w.-]+).*--status\s+closed)/);
    if (!closeMatch) process.exit(0);
    const issueId = closeMatch[1] || closeMatch[2];

    const repoRoot = run('git rev-parse --show-toplevel', { cwd });
    if (!repoRoot) process.exit(0);

    const headSha = run('git rev-parse HEAD', { cwd: repoRoot });
    if (!headSha) process.exit(0);

    const state = loadState();
    const entry = state[repoRoot] || { closedSince: 0, headSha };

    // Reset if HEAD has advanced (a commit happened).
    if (entry.headSha !== headSha) {
      entry.closedSince = 0;
      entry.headSha = headSha;
    }
    entry.closedSince += 1;
    state[repoRoot] = entry;
    saveState(state);

    log.info(HOOK, `${issueId} closed — counter ${entry.closedSince}/${THRESHOLD} since ${headSha.slice(0, 7)}`);

    if (entry.closedSince >= THRESHOLD) {
      const msg = `📌 Commit checkpoint: ${entry.closedSince} bd issues closed since the last commit. Run \`git add\` + \`git commit\` to checkpoint this batch of work — counter will reset on the next commit.`;
      process.stdout.write(JSON.stringify({ systemMessage: msg }));
    }
    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
