// check-no-main-push.js
// Hook: PreToolUse (Bash) — protects main/master from direct work.
// Guards THREE ways onto main/master, not just push (cp-3rg):
//   1. git push to/from main/master      -> block
//   2. git commit while HEAD is main/master -> block
//   3. git checkout/switch --orphan main|master -> block (this is how the
//      braynee-web autonomous build slipped a fresh history onto main)
// Exit 2 = block (stderr to Claude), exit 0 = allow.
// Opt-out for solo repos that intentionally work on main:
//   env BRAYNEE_ALLOW_MAIN_COMMITS=1  (applies to the commit/orphan guards;
//   pushing directly to main/master stays blocked regardless).
// Moved from ~/.claude/hooks/ into braynee so this enforcement ships with the plugin.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'check-no-main-push';
const ALLOW_MAIN = process.env.BRAYNEE_ALLOW_MAIN_COMMITS === '1';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const command = data.tool_input?.command || '';
    const cwd = data.cwd || process.cwd();

    // ---- 1. push to/from main/master (original behavior, unchanged) ----
    if (/^\s*git\s+push/i.test(command)) {
      if (/git\s+push.*\b(main|master)\b/i.test(command)) {
        log.warn(HOOK, `blocked explicit push to main/master`);
        process.stderr.write('BLOCKED: Do not push directly to main/master. Create a feature branch and PR instead.');
        process.exit(2);
      }
      if (/git\s+push\s*$/.test(command) || /git\s+push\s+origin\s*$/.test(command)) {
        try {
          const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8', windowsHide: true }).trim();
          if (branch === 'main' || branch === 'master') {
            log.warn(HOOK, `blocked implicit push from ${branch}`);
            process.stderr.write(`BLOCKED: Currently on '${branch}'. Create a feature branch and PR instead of pushing directly.`);
            process.exit(2);
          }
        } catch {}
      }
      try {
        if (fs.existsSync(path.join(cwd, '.beads'))) {
          // cp-psc/HD-4.3: PreToolUse exit-0 stdout is NOT added to context;
          // use the documented additionalContext channel, factual phrasing.
          process.stdout.write(JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PreToolUse',
              additionalContext: 'This repo uses beads; running `bd preflight --check` before opening a PR catches stale or orphaned issues.',
            },
          }));
        }
      } catch {}
      process.exit(0);
    }

    // ---- 3. git checkout/switch --orphan main|master ----
    // Caught before the commit check because an orphan checkout is the act
    // that puts you onto a fresh main/master with no branch protection.
    if (/^\s*git\s+(checkout|switch)\b/i.test(command) && /--orphan\b/.test(command)) {
      if (/--orphan\s+(['"]?)(main|master)\1(\s|$)/i.test(command)) {
        if (ALLOW_MAIN) process.exit(0);
        log.warn(HOOK, `blocked orphan checkout onto main/master`);
        process.stderr.write(
          'BLOCKED: `--orphan main/master` starts a fresh history directly on a protected branch. ' +
          'Use a feature branch (e.g. `git checkout --orphan feature/init`) and open a PR. ' +
          'Set BRAYNEE_ALLOW_MAIN_COMMITS=1 only if this repo intentionally works on main.'
        );
        process.exit(2);
      }
      process.exit(0);
    }

    // ---- 2. git commit while HEAD is main/master ----
    if (/^\s*git\s+commit\b/i.test(command)) {
      if (ALLOW_MAIN) process.exit(0);
      try {
        const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8', windowsHide: true }).trim();
        if (branch === 'main' || branch === 'master') {
          log.warn(HOOK, `blocked commit on ${branch}`);
          process.stderr.write(
            `BLOCKED: You are committing directly on '${branch}'. Create a feature branch first ` +
            `(e.g. \`git checkout -b feature/<topic>\`) — the commit will then succeed. ` +
            `Set BRAYNEE_ALLOW_MAIN_COMMITS=1 only if this repo intentionally works on main.`
          );
          process.exit(2);
        }
      } catch {
        // not a git repo / detached HEAD / git unavailable — don't get in the way
      }
      process.exit(0);
    }

    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
