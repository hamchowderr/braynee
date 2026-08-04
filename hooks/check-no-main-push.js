// check-no-main-push.js
// Hook: PreToolUse (Bash) — protects main/master from direct work.
// Guards THREE ways onto main/master, not just push (cp-3rg):
//   1. git push to/from main/master      -> block
//   2. git commit while HEAD is main/master -> block
//   3. git checkout/switch --orphan main|master -> block (this is how the
//      braynee-web autonomous build slipped a fresh history onto main)
// Exit 2 = block (stderr to Claude), exit 0 = allow.
// Opt-outs for solo repos / no-PR workflows that intentionally work on main:
//   env BRAYNEE_ALLOW_MAIN_COMMITS=1  -> bypass the commit + orphan-checkout guards
//   env BRAYNEE_ALLOW_MAIN_PUSH=1     -> bypass the push-to-main guard
// Each is opt-in and per-invocation. The two are independent so you can allow
// commits-on-main without also allowing direct pushes (or vice versa).
// Moved from ~/.claude/hooks/ into braynee so this enforcement ships with the plugin.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const payload = require(path.join(__dirname, 'lib', 'hook-payload.js'));

// cp-lj73.2: commandSegments (the cp-fznk compound-command fix) and repoAllows
// (the cp-ar0c reachable-opt-out fix) moved to lib/git-command.js when the
// commit/PR format guard needed exactly the same two behaviors. Shared rather
// than copied: a copy lets one guard silently regress while the other stays
// correct. The rationale for each lives with the code there.
const { commandSegments, repoAllows } = require(path.join(__dirname, 'lib', 'git-command.js'));

const HOOK = 'check-no-main-push';

// Per-repo opt-outs, settable mid-session (the env vars still work and win):
//   git config --local braynee.allow-main-commits true
//   git config --local braynee.allow-main-push true
const ENV_ALLOW_MAIN = process.env.BRAYNEE_ALLOW_MAIN_COMMITS === '1';
const ENV_ALLOW_MAIN_PUSH = process.env.BRAYNEE_ALLOW_MAIN_PUSH === '1';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    // Host-neutral view — the shell tool is `Bash` on Claude Code and
    // `execute_command` on Mastra Code, but the payload reads the same (cp-3o3g.3).
    const p = payload.parse(input);
    const command = p.toolInput.command || '';
    const cwd = p.cwd;

    // Resolved per invocation, not at module load: the opt-out is per-repo and
    // `cwd` is only known once the payload is parsed.
    const ALLOW_MAIN = ENV_ALLOW_MAIN || repoAllows(cwd, 'allow-main-commits');
    const ALLOW_MAIN_PUSH = ENV_ALLOW_MAIN_PUSH || repoAllows(cwd, 'allow-main-push');

    // cp-fznk: each guard now inspects the matching SEGMENT, not the raw string.
    const segments = commandSegments(command);
    const pushSeg = segments.find((s) => /^git\s+push/i.test(s));
    const orphanSeg = segments.find((s) => /^git\s+(checkout|switch)\b/i.test(s) && /--orphan\b/.test(s));
    const commitSeg = segments.find((s) => /^git\s+commit\b/i.test(s));

    // ---- 1. push to/from main/master ----
    // Opt-out via env BRAYNEE_ALLOW_MAIN_PUSH=1 (for no-PR workflows where
    // direct main pushes are the intended ship path after green local tests).
    if (pushSeg) {
      if (/git\s+push.*\b(main|master)\b/i.test(pushSeg)) {
        if (ALLOW_MAIN_PUSH) process.exit(0);
        log.warn(HOOK, `blocked explicit push to main/master`);
        process.stderr.write('BLOCKED: Do not push directly to main/master. Create a feature branch and PR instead. Set BRAYNEE_ALLOW_MAIN_PUSH=1 if this repo intentionally uses a no-PR direct-to-main workflow.');
        process.exit(2);
      }
      if (/git\s+push\s*$/.test(pushSeg) || /git\s+push\s+origin\s*$/.test(pushSeg)) {
        try {
          const branch = execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf8', windowsHide: true }).trim();
          if (branch === 'main' || branch === 'master') {
            if (ALLOW_MAIN_PUSH) process.exit(0);
            log.warn(HOOK, `blocked implicit push from ${branch}`);
            process.stderr.write(`BLOCKED: Currently on '${branch}'. Create a feature branch and PR instead of pushing directly. Set BRAYNEE_ALLOW_MAIN_PUSH=1 if this repo intentionally uses a no-PR direct-to-main workflow.`);
            process.exit(2);
          }
        } catch (e) {
          // This is a SAFETY gate. If resolving the branch fails, a bare `git
          // push` from main sails through unguarded and nothing reports why.
          log.debug(HOOK, `could not resolve branch for implicit push: ${e && e.message}`);
        }
      }
      try {
        if (fs.existsSync(path.join(cwd, '.beads'))) {
          // cp-psc/HD-4.3: PreToolUse exit-0 stdout is NOT added to context;
          // use the documented additionalContext channel, factual phrasing.
          // Passing the event keeps that envelope on Claude Code while emitting
          // the flat shape Mastra Code reads (cp-3o3g.9).
          payload.emitContext(
            'This repo uses beads; running `bd preflight --check` before opening a PR catches stale or orphaned issues.',
            'PreToolUse',
          );
        }
      } catch { /* the beads preflight hint is advisory; never delay a push for it */ }
      process.exit(0);
    }

    // ---- 3. git checkout/switch --orphan main|master ----
    // Caught before the commit check because an orphan checkout is the act
    // that puts you onto a fresh main/master with no branch protection.
    if (orphanSeg) {
      if (/--orphan\s+(['"]?)(main|master)\1(\s|$)/i.test(orphanSeg)) {
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
    if (commitSeg) {
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
