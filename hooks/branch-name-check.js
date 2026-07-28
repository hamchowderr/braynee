// branch-name-check.js
// Hook: PreToolUse (Bash, if Bash(git push *)) — soft warning when pushing a
// branch whose name doesn't follow the feat|feature/*, fix/*, chore/* convention.
// Never blocks (exit 0). Issues a stderr warning that Claude can relay to the user.

const { execSync } = require('child_process');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'branch-name-check';
// `feat` is the conventional-commits type, so branches routinely use it as the
// short form of `feature`; `spike` covers time-boxed investigation branches.
const ALLOWED = /^(feat|feature|fix|chore|hotfix|refactor|docs|test|spike)\//;

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
        windowsHide: true,
      }).trim();
    } catch { process.exit(0); }

    // Main/master is handled by check-no-main-push; this hook only cares about other oddly-named branches.
    if (['main', 'master', 'HEAD'].includes(branch)) process.exit(0);

    if (!ALLOWED.test(branch)) {
      log.info(HOOK, `non-conventional branch name: ${branch}`);
      // cp-psc/HD-4.2: exit-0 stderr is NOT surfaced to Claude on PreToolUse;
      // the documented channel is hookSpecificOutput.additionalContext.
      // Factual phrasing (not an imperative) so it isn't treated as an
      // out-of-band command. The push still proceeds (exit 0, no block).
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext:
            `Branch '${branch}' does not follow the feat/*, feature/*, fix/*, chore/*, hotfix/*, refactor/*, docs/*, test/*, spike/* naming convention. ` +
            `The push is allowed; renaming the branch would make it consistent with the convention.`,
        },
      }));
    }
    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
