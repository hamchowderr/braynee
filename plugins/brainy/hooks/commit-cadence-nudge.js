// commit-cadence-nudge.js
// Hook: PostToolUse (Bash, gated to bd lifecycle commands) — beads is the
// source of truth for units of work, so commits should align with bd boundaries.
//
// Fires when:
//   bd update <id> --claim / bd claim <id>          → "commit prior work before starting <id>"
//   bd close <id> / bd update <id> --status closed  → "commit the work you just finished for <id>"
//
// Stays silent when there are no uncommitted changes. No time/file thresholds —
// the bd command itself is the trigger. State file removed (no longer needed).

const { execSync } = require('child_process');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'commit-cadence-nudge';

function run(cmd, opts = {}) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'], ...opts }).trim(); }
  catch { return null; }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const cmd = (data.tool_input?.command || '').trim();
    const cwd = data.cwd || process.cwd();

    const claimMatch = cmd.match(/^bd\s+(?:update\s+([\w-]+).*--claim|claim\s+([\w-]+))/);
    const closeMatch = !claimMatch && cmd.match(/^bd\s+(?:close\s+([\w-]+)|update\s+([\w-]+).*--status\s+closed)/);
    if (!claimMatch && !closeMatch) process.exit(0);

    const repoRoot = run('git rev-parse --show-toplevel', { cwd });
    if (!repoRoot) process.exit(0);

    const dirty = run('git status --porcelain', { cwd: repoRoot });
    if (!dirty) process.exit(0);

    const fileCount = dirty.split('\n').filter(Boolean).length;
    const stat = run('git diff --shortstat HEAD', { cwd: repoRoot }) || '';

    const issueId = (claimMatch ? (claimMatch[1] || claimMatch[2]) : (closeMatch[1] || closeMatch[2]));
    const phase = claimMatch ? 'claim' : 'close';

    const msg = phase === 'claim'
      ? `📌 Uncommitted changes (${fileCount} file${fileCount === 1 ? '' : 's'}${stat ? ', ' + stat : ''}) before claiming [${issueId}]. Commit prior work first so the new branch starts clean.`
      : `📌 Uncommitted changes (${fileCount} file${fileCount === 1 ? '' : 's'}${stat ? ', ' + stat : ''}) at the moment [${issueId}] was closed. Commit them now so the work is captured under this issue.`;

    log.info(HOOK, `nudge fired (${phase}/${issueId}): ${fileCount} files`);
    process.stdout.write(JSON.stringify({ systemMessage: msg }));
    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
