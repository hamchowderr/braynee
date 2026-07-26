// beads-claim-to-branch.js
// Hook: PostToolUse (Bash, if Bash(bd update * --claim) || Bash(bd claim *)) —
// auto-creates a feature/<id>-<slug> or fix/<id>-<slug> branch when an issue is
// claimed, gated by a per-repo setting at .claude/braynee.local.md.
//
// Settings file (Markdown frontmatter parsed manually — keep it dumb on purpose):
//   ---
//   beads_claim_auto_branch: true   # default false
//   ---
// Branch prefix is derived from issue type (bug → fix/, otherwise feature/).
// Skips if not on main/master (assume the user is intentionally on a branch already).

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'beads-claim-to-branch';
const { overCap } = require(path.join(__dirname, 'lib', 'dolt-guard.js'));

function run(cmd, opts = {}) {
  try { return execSync(cmd, { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, ...opts }).trim(); }
  catch { return null; }
}

function readSetting(repoRoot, key) {
  const settingsPath = path.join(repoRoot, '.claude', 'braynee.local.md');
  if (!fs.existsSync(settingsPath)) return null;
  try {
    const content = fs.readFileSync(settingsPath, 'utf-8');
    const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
    if (!fmMatch) return null;
    const line = fmMatch[1].split('\n').find(l => l.startsWith(`${key}:`));
    if (!line) return null;
    const val = line.split(':').slice(1).join(':').trim().toLowerCase();
    return val === 'true' || val === 'yes' || val === '1';
  } catch { return null; }
}

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const cmd = (data.tool_input?.command || '').trim();
    const cwd = data.cwd || process.cwd();

    const m = cmd.match(/^bd\s+(?:update\s+([\w.-]+).*--claim|claim\s+([\w.-]+))/);
    if (!m) process.exit(0);
    const issueId = m[1] || m[2];

    const repoRoot = run('git rev-parse --show-toplevel', { cwd });
    if (!repoRoot) process.exit(0);

    if (!readSetting(repoRoot, 'beads_claim_auto_branch')) {
      log.info(HOOK, `${issueId}: auto-branch disabled (set beads_claim_auto_branch: true in .claude/braynee.local.md to enable)`);
      process.exit(0);
    }

    const currentBranch = run('git rev-parse --abbrev-ref HEAD', { cwd: repoRoot });
    if (!['main', 'master'].includes(currentBranch)) {
      log.info(HOOK, `${issueId}: already on ${currentBranch}, skipping auto-branch`);
      process.exit(0);
    }

    // dolt-guard: skip the bd query during a dolt-server flood (fall back to defaults).
    const showJson = overCap() ? null : run(`bd show ${issueId} --json`, { cwd });
    let title = issueId, type = 'feature';
    if (showJson) {
      try {
        const issue = JSON.parse(showJson);
        title = issue.title || issueId;
        type = (issue.issue_type || issue.type || '').toLowerCase() === 'bug' ? 'fix' : 'feature';
      } catch { /* bd returned unparseable JSON — fall back to the id-only branch name */ }
    }

    const branch = `${type}/${issueId}-${slugify(title)}`;
    const created = run(`git checkout -b ${branch}`, { cwd: repoRoot });
    if (created !== null) {
      log.info(HOOK, `created branch ${branch} for ${issueId}`);
      process.stdout.write(`Auto-created branch \`${branch}\` for claimed issue [${issueId}].\n`);
    } else {
      log.warn(HOOK, `failed to create branch ${branch}`);
    }
    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
