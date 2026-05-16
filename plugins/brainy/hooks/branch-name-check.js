// branch-name-check.js
// Hook: PreToolUse (Bash, if Bash(git push *)) — soft warning when pushing a
// branch whose name doesn't follow the feature/*, fix/*, chore/* convention.
// Never blocks (exit 0). Issues a stderr warning that Claude can relay to the user.

const { execSync } = require('child_process');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'branch-name-check';
const ALLOWED = /^(feature|fix|chore|hotfix|refactor|docs|test)\//;

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const command = data.tool_input?.command || '';
    if (!/^\s*git\s+push/i.test(command)) process.exit(0);

    const cwd = data.cwd || process.cwd();
    let branch = null;
    try {
      // cp-16u: ignore git's stderr so `fatal: not a git repository` (and any
      // other git diagnostic) never leaks to this hook's stderr in non-git
      // dirs. stdin=pipe, stdout=pipe, stderr=ignore.
      branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
    } catch { process.exit(0); }

    // Main/master is handled by check-no-main-push; this hook only cares about other oddly-named branches.
    if (['main', 'master', 'HEAD'].includes(branch)) process.exit(0);

    if (!ALLOWED.test(branch)) {
      log.info(HOOK, `non-conventional branch name: ${branch}`);
      process.stderr.write(
        `⚠ Branch '${branch}' doesn't follow the feature/*, fix/*, chore/*, refactor/*, docs/*, test/* convention. ` +
        `Allowing the push, but consider renaming for consistency.`
      );
    }
    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
