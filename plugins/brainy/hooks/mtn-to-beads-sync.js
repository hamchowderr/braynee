// mtn-to-beads-sync.js
// Hook: PostToolUse (Bash) — closes the bd↔mtn loop in the reverse direction.
//
// When the user runs `mtn complete <X>` or `mtn done <X>`, look up the task,
// extract its embedded #bd-<id> tag (set by ensureMtnTask in beads-status-sync.js),
// and run `bd close <id>` if that issue is still open. Re-entry is naturally
// guarded — beads-status-sync only runs mtn complete after bd is already closed,
// so this hook will see no-op state and skip.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'mtn-to-beads-sync';
const CODE_DIR = path.join(os.homedir(), 'code');

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'ignore'], ...opts }).trim();
  } catch { return null; }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const cmd = (data.tool_input?.command || '').trim();
    const cwd = data.cwd || process.cwd();

    // Match `mtn complete <X>` or `mtn done <X>` (mtn's alias)
    const m = cmd.match(/^mtn\s+(?:complete|done)\s+(.+?)\s*$/);
    if (!m) process.exit(0);

    if (!cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase())) process.exit(0);
    if (!fs.existsSync(path.join(cwd, '.beads'))) process.exit(0);

    const target = m[1].replace(/^["']|["']$/g, '');

    // If user passed the bd id directly (e.g. `mtn complete "#bd-42"` or `mtn complete bd-42`)
    let issueId = null;
    const direct = target.match(/(bd-[\w-]+)/);
    if (direct) {
      issueId = direct[1];
    } else {
      // Otherwise resolve via mtn show — its output includes the tags line.
      const showOut = run(`mtn show ${JSON.stringify(target)}`);
      if (showOut) {
        const tagMatch = showOut.match(/(bd-[\w-]+)/);
        if (tagMatch) issueId = tagMatch[1];
      }
    }

    if (!issueId) {
      log.info(HOOK, `no bd issue tag for "${target.slice(0, 40)}" — skip`);
      process.exit(0);
    }

    // Skip if the bd issue is already closed (re-entry guard).
    const showBd = run(`bd show ${issueId} --json`, { cwd });
    if (showBd) {
      try {
        const issue = JSON.parse(showBd);
        if (issue.status === 'closed') {
          log.info(HOOK, `${issueId} already closed — skip`);
          process.exit(0);
        }
      } catch {}
    }

    const result = run(`bd close ${issueId}`, { cwd });
    if (result !== null) {
      log.info(HOOK, `closed ${issueId} via mtn complete`);
      process.stdout.write(`Linked beads issue [${issueId}] closed automatically.\n`);
    } else {
      log.warn(HOOK, `bd close ${issueId} failed`);
    }
    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
