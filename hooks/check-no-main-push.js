// check-no-main-push.js
// Hook: PreToolUse (Bash) — protects main/master from direct work.
// Guards the ways onto main/master, not just push (cp-3rg):
//   1. git push to/from main/master      -> block
//   2. a commit-making git operation while HEAD is main/master -> block
//      (commit, merge, rebase, cherry-pick, revert, am — cp-qvkv)
//   3. git checkout/switch --orphan main|master -> block (this is how the
//      braynee-web autonomous build slipped a fresh history onto main)
// Exit 2 = block (stderr to Claude), exit 0 = allow.
// Opt-outs for solo repos / no-PR workflows that intentionally work on main:
//   env BRAYNEE_ALLOW_MAIN_COMMITS=1  -> bypass the commit + orphan-checkout guards
//   env BRAYNEE_ALLOW_MAIN_PUSH=1     -> bypass the push-to-main guard
// Each is opt-in and per-invocation. The two are independent so you can allow
// commits-on-main without also allowing direct pushes (or vice versa).
// Moved from ~/.claude/hooks/ into braynee so this enforcement ships with the plugin.

const fs = require('fs');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const payload = require(path.join(__dirname, 'lib', 'hook-payload.js'));

// cp-lj73.2: the parsing every git guard needs lives in lib/git-command.js,
// shared rather than copied so one guard cannot silently regress while another
// stays correct. cp-2jlh: resolveSegments() pairs each segment with the
// directory it runs in. cp-qvkv: it also unwraps the programs a segment really
// runs, resolves --git-dir / GIT_DIR, and projects the branch HEAD will be on.
const {
  resolveSegments, shellFor, gitProbe, branchesOf, parseArgs, rebaseBranch, pushTargetsHead,
} = require(path.join(__dirname, 'lib', 'git-command.js'));

const HOOK = 'check-no-main-push';

// Per-repo opt-outs, settable mid-session (the env vars still work and win):
//   git config --local braynee.allow-main-commits true
//   git config --local braynee.allow-main-push true
const ENV_ALLOW_MAIN = process.env.BRAYNEE_ALLOW_MAIN_COMMITS === '1';
const ENV_ALLOW_MAIN_PUSH = process.env.BRAYNEE_ALLOW_MAIN_PUSH === '1';

const isMain = (b) => b === 'main' || b === 'master';

// cp-qvkv (owner's scope): every operation that creates or rewrites commits on
// the branch it runs on is guarded like `commit`. `git pull` and `git fetch` are
// ordinary sync and are not, and `git rebase main` on a feature branch rewrites
// the FEATURE branch — rebase is judged by the branch it rewrites.
const COMMIT_OPS = new Set(['commit', 'merge', 'rebase', 'cherry-pick', 'revert', 'am']);
// Options that only stop or inspect an operation already under way.
const CONTROL = {
  merge: ['--abort', '--quit'],
  rebase: ['--abort', '--quit', '--edit-todo', '--show-current-patch'],
  'cherry-pick': ['--abort', '--quit'],
  revert: ['--abort', '--quit'],
  am: ['--abort', '--quit', '--show-current-patch'],
};

const PUSH_HATCH = 'Set BRAYNEE_ALLOW_MAIN_PUSH=1 if this repo intentionally uses a no-PR direct-to-main workflow.';
const COMMIT_HATCH = 'Set BRAYNEE_ALLOW_MAIN_COMMITS=1 only if this repo intentionally works on main.';

function block(reason, message) {
  log.warn(HOOK, reason);
  process.stderr.write(message);
  process.exit(2);
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    // Host-neutral view — the shell tool is `Bash` on Claude Code and
    // `execute_command` on Mastra Code, but the payload reads the same (cp-3o3g.3).
    const p = payload.parse(input);
    const command = p.toolInput.command || '';

    // cp-2jlh: p.cwd is the SESSION's directory — only where the command starts.
    // Every check reads the segment's own dir / gitDir instead.
    const probe = gitProbe();
    const segments = resolveSegments(command, p.cwd, { shell: shellFor(p.hostTool), probe });

    // Opt-outs are per-repo, read from the repo each segment acts on, and only
    // for a segment that needs one.
    const allowMain = (seg) => ENV_ALLOW_MAIN || probe.allows(seg, 'allow-main-commits');
    const allowMainPush = (seg) => ENV_ALLOW_MAIN_PUSH || probe.allows(seg, 'allow-main-push');
    const closedMessage = (seg, what) =>
      `BLOCKED: \`${what}\` is given ${seg.closed}, so the repository and branch it acts on cannot be ` +
      `checked. Use a literal path that exists, or run it from inside the repository.`;
    const unknownMessage = (what) =>
      `BLOCKED: \`${what}\` follows a branch switch in the same command whose result cannot be determined ` +
      `here (a variable, \`-\`, or a switch joined with ; || | or &), so it may land on main/master. Run the ` +
      `switch as its own command, or join it with &&, then try again.`;

    // Every matching segment is judged, not just the first of each kind.
    let beadsHint = false;
    for (const seg of segments) {
      if (!seg.git) continue;
      const { sub, args } = seg.git;
      const s = seg.match;

      // ---- 1. push to/from main/master ----
      if (sub === 'push') {
        const explicit = /git\s+push.*\b(main|master)\b/i.test(s);
        const head = !explicit && pushTargetsHead(args);
        if (explicit || head) {
          // A repo that cannot be known has no opt-out to read either.
          if (seg.closed && !ENV_ALLOW_MAIN_PUSH) block('blocked push to an unresolvable repo', closedMessage(seg, 'git push'));
          if (explicit && !allowMainPush(seg)) {
            block('blocked explicit push to main/master',
              `BLOCKED: Do not push directly to main/master. Create a feature branch and PR instead. ${PUSH_HATCH}`);
          }
          if (head) {
            const branches = branchesOf(seg, probe);
            const onMain = branches.find(isMain);
            if (branches.includes(null) && !allowMainPush(seg)) block('blocked push after an unknowable switch', unknownMessage('git push'));
            if (onMain && !allowMainPush(seg)) {
              // cp-qvkv: `git push origin HEAD`, `--all` and `--mirror` name no
              // branch, yet from main they push main.
              block(`blocked push of HEAD from ${onMain}`,
                `BLOCKED: Currently on '${onMain}', and this push sends it (a bare push, HEAD/@, --all or ` +
                `--mirror). Create a feature branch and PR instead of pushing directly. ${PUSH_HATCH}`);
            }
            if (branches.includes(undefined)) {
              // This is a SAFETY gate: a HEAD push whose branch cannot be read
              // goes through unguarded, so leave a trace of why.
              log.debug(HOOK, 'could not resolve the branch for a push that targets HEAD');
            }
          }
        }
        try {
          if (fs.existsSync(path.join(seg.dir, '.beads'))) beadsHint = true;
        } catch { /* the beads preflight hint is advisory; never delay a push for it */ }
        continue;
      }

      // ---- 3. git checkout/switch --orphan main|master ----
      // Caught before the commit check because an orphan checkout is the act
      // that puts you onto a fresh main/master with no branch protection.
      if ((sub === 'checkout' || sub === 'switch') && /--orphan\b/.test(s)) {
        if (/--orphan\s+(['"]?)(main|master)\1(\s|$)/i.test(s) && !allowMain(seg)) {
          block('blocked orphan checkout onto main/master',
            'BLOCKED: `--orphan main/master` starts a fresh history directly on a protected branch. ' +
            'Use a feature branch (e.g. `git checkout --orphan feature/init`) and open a PR. ' +
            'Set BRAYNEE_ALLOW_MAIN_COMMITS=1 only if this repo intentionally works on main.');
        }
        continue;
      }

      // ---- 2. commit-making operations while HEAD is main/master ----
      if (!COMMIT_OPS.has(sub)) continue;
      if (CONTROL[sub] && parseArgs(args).opts.some((o) => CONTROL[sub].includes(o.name))) continue;
      const what = `git ${sub}`;
      if (seg.closed) {
        if (ENV_ALLOW_MAIN) continue;
        block(`blocked ${sub} on an unresolvable repo`, closedMessage(seg, what));
      }
      if (allowMain(seg)) continue;
      // A rebase that names its branch rewrites THAT branch, not the current one.
      const target = sub === 'rebase' ? rebaseBranch(args) : undefined;
      const branches = target !== undefined ? [target] : branchesOf(seg, probe);
      if (branches.includes(null)) block(`blocked ${sub} after an unknowable switch`, unknownMessage(what));
      const onMain = branches.find(isMain);
      if (!onMain) continue;
      if (sub === 'commit') {
        block(`blocked commit on ${onMain}`,
          `BLOCKED: You are committing directly on '${onMain}'. Create a feature branch first ` +
          `(e.g. \`git checkout -b feature/<topic>\`) — the commit will then succeed. ${COMMIT_HATCH}`);
      }
      block(`blocked ${sub} on ${onMain}`,
        `BLOCKED: \`${what}\` would ${sub === 'rebase' ? 'rewrite' : 'add commits to'} '${onMain}' directly. ` +
        `Do this on a feature branch (e.g. \`git checkout -b feature/<topic>\`) and merge through a PR. ` +
        `\`git pull\` and \`git fetch\` stay allowed. ${COMMIT_HATCH}`);
    }

    if (beadsHint) {
      // cp-psc/HD-4.3: PreToolUse exit-0 stdout is NOT added to context;
      // use the documented additionalContext channel, factual phrasing.
      // Passing the event keeps that envelope on Claude Code while emitting
      // the flat shape Mastra Code reads (cp-3o3g.9).
      payload.emitContext(
        'This repo uses beads; running `bd preflight --check` before opening a PR catches stale or orphaned issues.',
        'PreToolUse',
      );
    }
    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
