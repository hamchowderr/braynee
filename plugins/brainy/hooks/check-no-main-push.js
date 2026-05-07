// check-no-main-push.js
// Hook: PreToolUse (Bash, if Bash(git push *)) — blocks pushes to main/master.
// Exit 2 = block (stderr to Claude), exit 0 = allow.
// Moved from ~/.claude/hooks/ into brainy so this enforcement ships with the plugin.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'check-no-main-push';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const command = data.tool_input?.command || '';
    if (!/^\s*git\s+push/i.test(command)) process.exit(0);

    if (/git\s+push.*\b(main|master)\b/i.test(command)) {
      log.warn(HOOK, `blocked explicit push to main/master`);
      process.stderr.write('BLOCKED: Do not push directly to main/master. Create a feature branch and PR instead.');
      process.exit(2);
    }

    if (/git\s+push\s*$/.test(command) || /git\s+push\s+origin\s*$/.test(command)) {
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', {
          cwd: data.cwd || process.cwd(), encoding: 'utf8',
        }).trim();
        if (branch === 'main' || branch === 'master') {
          log.warn(HOOK, `blocked implicit push from ${branch}`);
          process.stderr.write(`BLOCKED: Currently on '${branch}'. Create a feature branch and PR instead of pushing directly.`);
          process.exit(2);
        }
      } catch {}
    }

    try {
      const cwd = data.cwd || process.cwd();
      if (fs.existsSync(path.join(cwd, '.beads'))) {
        process.stdout.write('Reminder: Run `bd preflight --check` before opening a PR to catch stale/orphaned issues.');
      }
    } catch {}

    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
