// commit-cadence-nudge.js
// Hook: PostToolUse (Write|Edit) — nudges the user to commit if 5+ files have
// been edited since the last commit and 2h+ have elapsed.
//
// State file: ~/.claude/brainy-commit-cadence.json
//   { "<repoRoot>": { "lastCommitSeen": <iso>, "editedSince": [<paths>] } }
// State is per repo (git toplevel) so multi-repo work doesn't cross-contaminate.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'commit-cadence-nudge';
const STATE_FILE = path.join(os.homedir(), '.claude', 'brainy-commit-cadence.json');
const FILE_THRESHOLD = 5;
const TIME_THRESHOLD_MS = 2 * 60 * 60 * 1000;

function run(cmd, opts = {}) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'], ...opts }).trim(); }
  catch { return null; }
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch { return {}; }
}
function saveState(s) {
  try { fs.writeFileSync(STATE_FILE, JSON.stringify(s), 'utf-8'); } catch {}
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const cwd = data.cwd || process.cwd();
    const filePath = data.tool_input?.file_path;
    if (!filePath) process.exit(0);

    const repoRoot = run('git rev-parse --show-toplevel', { cwd });
    if (!repoRoot) process.exit(0);

    const lastCommitIso = run('git log -1 --format=%cI', { cwd: repoRoot });
    if (!lastCommitIso) process.exit(0);

    const state = loadState();
    const entry = state[repoRoot] || { lastCommitSeen: null, editedSince: [] };

    // Reset the tracked list whenever a new commit lands.
    if (entry.lastCommitSeen !== lastCommitIso) {
      entry.lastCommitSeen = lastCommitIso;
      entry.editedSince = [];
    }

    if (!entry.editedSince.includes(filePath)) entry.editedSince.push(filePath);
    state[repoRoot] = entry;
    saveState(state);

    const elapsed = Date.now() - new Date(lastCommitIso).getTime();
    if (entry.editedSince.length >= FILE_THRESHOLD && elapsed >= TIME_THRESHOLD_MS) {
      const hours = (elapsed / 3_600_000).toFixed(1);
      log.info(HOOK, `nudge fired: ${entry.editedSince.length} files, ${hours}h since last commit`);
      const msg = `⏱ Commit cadence nudge: ${entry.editedSince.length} files edited since last commit (${hours}h ago). Consider \`git add\` + \`git commit\` to checkpoint.`;
      process.stdout.write(JSON.stringify({ systemMessage: msg }));
    }
    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
