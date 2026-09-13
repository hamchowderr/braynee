#!/usr/bin/env node
'use strict';

// git-command.test.js — cp-2jlh.
//
// resolveSegments() decides WHICH repo a git guard judges. A wrong answer is
// either a blocked correct commit or a commit onto main let through, so both
// directions are asserted. Existence is part of the contract (a path that does
// not exist is unknowable), so these run against real temporary directories.
// No git is needed here; the guards against real repos are self-test §19b.
//
// Pure Node, no deps, cross-platform. Exit 0 = pass, 1 = fail.

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  commandSegments, resolveSegments, shellFor, toNativePath, stripDataHeredocs, pushTargetsHead, rebaseBranch,
  pushWritesMain, pushesEveryBranch, mainRefEffect,
} = require('./git-command.js');

let pass = 0, fail = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : '')); }
};
const eq = (name, got, want) =>
  ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcmd-'));
// Real git runs for the branch-projection cases. Stop its repo discovery at the
// sandbox, so a repository that happens to enclose the temp dir cannot answer.
process.env.GIT_CEILING_DIRECTORIES = root;
const mk = (...parts) => {
  const d = path.join(root, ...parts);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const start = mk('start');
const a = mk('a');
const ab = mk('a', 'b');
const spaced = mk('with space');
const home = mk('home');
const proj = mk('home', 'proj');
const dotgit = mk('a', '.git'); // a directory is all --git-dir resolution needs
const fwd = (p) => p.replace(/\\/g, '/');

// The directory the first git segment of `command` runs in.
const gitDir = (command, opts = {}) => {
  const seg = resolveSegments(command, start, { home, ...opts }).find((s) => /^git\s/.test(s.match));
  return seg ? seg.dir : undefined;
};
// The first entry that is a git call with a subcommand.
const gitSeg = (command, opts = {}) =>
  resolveSegments(command, start, { home, ...opts }).find((s) => s.git && s.git.sub) || {};
const subOf = (command, opts) => {
  const s = gitSeg(command, opts);
  return s.git ? `${s.git.sub}|${s.match}` : undefined;
};
// The branches the LAST git call may run on, LIVE meaning "as HEAD is now".
const branchesAfter = (command) => {
  const last = resolveSegments(command, start, { home }).filter((s) => s.git && s.git.sub).pop();
  if (!last || !last.branches) return 'LIVE';
  return last.branches.map((b) => (b === null ? 'null' : b.replace('\u0000live', 'LIVE'))).join(',');
};

try {
  // ── cd, absolute and relative ──────────────────────────────────────────────
  eq('a plain git command runs in the payload cwd', gitDir('git status'), start);
  eq('cd <absolute> && git', gitDir(`cd ${fwd(a)} && git status`), a);
  eq('a relative cd is taken from the payload cwd', gitDir('cd ../a && git status'), a);
  eq('cd chains accumulate', gitDir('cd ../a && cd b && git status'), ab);
  eq('cd .. walks back up', gitDir('cd ../a/b && cd .. && git status'), a);
  eq('`;` and newlines separate as well as &&', gitDir('cd ../a; cd b\ngit status'), ab);
  eq('redirections are not arguments', gitDir(`cd ${fwd(a)} >/dev/null 2>&1 && git status`), a);
  eq('`builtin cd` is still a cd', gitDir(`builtin cd ${fwd(a)} && git status`), a);

  // ── quoting ────────────────────────────────────────────────────────────────
  eq('a double-quoted path with a space', gitDir(`cd "${fwd(spaced)}" && git status`), spaced);
  eq('a single-quoted path with a space', gitDir(`cd '${fwd(spaced)}' && git status`), spaced);
  eq('a backslash-escaped space', gitDir('cd ../with\\ space && git status'), spaced);
  eq('a quoted native path keeps its backslashes', gitDir(`cd "${a}" && git status`), a);

  // ── git -C ─────────────────────────────────────────────────────────────────
  eq('git -C <dir>', gitDir(`git -C ${fwd(a)} status`), a);
  eq('git -C is cumulative', gitDir(`git -C ${fwd(a)} -C b status`), ab);
  eq('git -C is taken from a preceding cd', gitDir(`cd ${fwd(a)} && git -C b status`), ab);
  eq('git -C with a quoted, spaced path', gitDir(`git -C "${fwd(spaced)}" status`), spaced);
  {
    const cmd = `git -c k=v -C "${fwd(a)}" --no-pager commit -m "feat: x"`;
    const [seg] = resolveSegments(cmd, start);
    eq('git global options are removed for matching', seg.match, 'git commit -m "feat: x"');
    eq('...the text itself is untouched', seg.text, cmd);
    eq('...and -C still decides the dir', seg.dir, a);
  }
  eq('a subshell-wrapped git matches as git', resolveSegments('(git push)', start)[0].match, 'git push');
  eq('a non-git segment matches as itself',
    resolveSegments('echo "git -C x commit"', start)[0].match, 'echo "git -C x commit"');

  // ── home ───────────────────────────────────────────────────────────────────
  eq('cd ~', gitDir('cd ~ && git status'), home);
  eq('cd ~/sub', gitDir('cd ~/proj && git status'), proj);
  eq('a bare cd goes home', gitDir('cd && git status'), home);
  eq('a QUOTED ~ is literal in POSIX -> unknowable', gitDir('cd "~/proj" && git status'), start);
  eq('~user is somebody else\'s home -> unknowable', gitDir('cd ~nobody && git status'), start);

  // ── fail-safe: anything unknowable is judged at the payload cwd ────────────
  eq('a variable', gitDir('cd "$REPO" && git status'), start);
  eq('command substitution', gitDir('cd $(git rev-parse --show-toplevel) && git status'), start);
  eq('a glob', gitDir('cd ../a* && git status'), start);
  eq('a path that does not exist', gitDir('cd ../no-such-dir && git status'), start);
  eq('a git -C that does not resolve', gitDir('git -C "$D" status'), start);
  // --git-dir / GIT_DIR are resolved, and fail CLOSED when they cannot be (cp-qvkv).
  eq('--git-dir=<literal> resolves to that git dir', gitSeg(`git --git-dir=${fwd(dotgit)} commit -m x`).gitDir, dotgit);
  ok('...and is not closed', !gitSeg(`git --git-dir=${fwd(dotgit)} commit -m x`).closed);
  eq('--git-dir <relative> is taken from -C', gitSeg(`git -C ${fwd(a)} --git-dir .git commit`).gitDir, dotgit);
  eq('--work-tree alone does not move HEAD: -C still decides', gitDir(`git -C ${fwd(a)} --work-tree ${fwd(ab)} status`), a);
  eq('an inline GIT_DIR=<literal> resolves',
    gitSeg(`GIT_DIR=${fwd(dotgit)} GIT_WORK_TREE=${fwd(a)} git commit -m x`).gitDir, dotgit);
  eq('an exported GIT_DIR applies to later git calls', gitSeg(`export GIT_DIR=${fwd(dotgit)}; git commit -m x`).gitDir, dotgit);
  eq('env GIT_DIR=<literal> git resolves', gitSeg(`env GIT_DIR=${fwd(dotgit)} git commit`).gitDir, dotgit);
  ok('unset GIT_DIR clears it', !gitSeg(`export GIT_DIR=${fwd(dotgit)}; unset GIT_DIR; git commit`).gitDir);
  ok('an unresolvable --git-dir fails closed', !!gitSeg('git --git-dir="$X" commit').closed);
  ok('a GIT_DIR that does not exist fails closed', !!gitSeg('GIT_DIR=../no-such/.git git commit').closed);
  ok('PowerShell $env:GIT_DIR = <variable> fails closed', !!gitSeg('$env:GIT_DIR = $x; git commit', { shell: 'powershell' }).closed);
  ok('find -execdir fails closed', !!gitSeg('find . -execdir git commit -m x \\;').closed);
  eq('eval can move anywhere', gitDir(`cd ${fwd(a)} && eval "cd b" && git status`), start);
  eq('source can move anywhere', gitDir(`cd ${fwd(a)} && source ./env.sh && git status`), start);
  eq('an absolute cd recovers from unknown', gitDir(`cd "$X" && cd ${fwd(a)} && git status`), a);
  eq('a relative cd from unknown stays unknown', gitDir('cd "$X" && cd b && git status'), start);

  // ── a cd the shell does not persist ────────────────────────────────────────
  eq('a cd inside ( ) does not leak out', gitDir(`(cd ${fwd(a)}) && git status`), start);
  eq('...but applies inside it', gitDir(`(cd ${fwd(a)} && git status)`), a);
  eq('...and is undone at the close', gitDir(`(cd ${fwd(a)} && true); git status`), start);
  eq('a { } group DOES persist', gitDir(`{ cd ${fwd(a)}; } && git status`), a);
  eq('a piped cd does not persist', gitDir(`cd ${fwd(a)} | cat; git status`), start);
  eq('a backgrounded cd does not persist', gitDir(`cd ${fwd(a)} &\ngit status`), start);
  eq('a cd line inside a data heredoc (cat) is not a command at all',
    gitDir(`cd ${fwd(a)} && cat > notes <<'EOF'\ncd ${fwd(ab)}\nEOF\ngit status`), a);
  eq('a cd line inside a heredoc a SHELL runs makes the directory unknowable',
    gitDir(`cd ${fwd(a)} && bash <<'EOF'\ncd ${fwd(ab)}\nEOF\ngit status`), start);

  // ── the program a segment really runs (cp-qvkv) ──────────────────────────
  eq('git.exe', subOf('git.exe commit -m x'), 'commit|git commit -m x');
  eq('a full POSIX path to git', subOf('/usr/bin/git commit -m x'), 'commit|git commit -m x');
  eq('a quoted Git-Bash path to git', subOf('"/mingw64/bin/git" commit -m x'), 'commit|git commit -m x');
  eq('a quoted Windows path to git.exe', subOf('"C:\\Program Files\\Git\\cmd\\git.exe" commit -m x'), 'commit|git commit -m x');
  eq('PowerShell: & "…\\git.exe"',
    subOf('& "C:\\Program Files\\Git\\cmd\\git.exe" commit -m x', { shell: 'powershell' }), 'commit|git commit -m x');
  eq('env', subOf('env git commit -m x'), 'commit|git commit -m x');
  eq('env -i -u NAME A=b', subOf('env -i -u HOME A=b git commit -m x'), 'commit|git commit -m x');
  eq('sudo -u', subOf('sudo -u root git commit -m x'), 'commit|git commit -m x');
  eq('nice -n', subOf('nice -n 5 git commit -m x'), 'commit|git commit -m x');
  eq('nohup', subOf('nohup git push'), 'push|git push');
  eq('time -p', subOf('time -p git commit -m x'), 'commit|git commit -m x');
  eq('timeout <duration>', subOf('timeout 30 git commit -m x'), 'commit|git commit -m x');
  eq('xargs after a pipe', subOf('echo x | xargs git commit -m'), 'commit|git commit -m');
  eq('xargs -I', subOf('ls | xargs -I {} git commit -m {}'), 'commit|git commit -m {}');
  eq('find -exec … \\;', subOf('find . -maxdepth 0 -exec git commit -m x \\;'), 'commit|git commit -m x \\');
  eq('find -exec … +', subOf('find . -exec git add {} +'), 'add|git add {}');
  eq('bash -c "<commands>"', subOf('bash -c "git commit -m x"'), 'commit|git commit -m x');
  eq("sh -lc '<commands>'", subOf("sh -lc 'git push'"), 'push|git push');
  eq('a bash -c string runs in the tracked directory', gitDir(`cd ${fwd(a)} && bash -c "git status"`), a);
  eq('env -C moves the wrapped command', gitDir(`env -C ${fwd(a)} git status`), a);

  // ── branch projection, push targets, rebase target (cp-qvkv) ─────────────
  eq('switch && commit runs on the switched branch', branchesAfter('git switch main && git commit -m x'), 'main');
  eq('switch -c', branchesAfter('git switch -c feature/x && git commit -m x'), 'feature/x');
  eq('checkout -b', branchesAfter('git checkout -b feature/x && git commit -m x'), 'feature/x');
  eq('branch -m renames the current branch', branchesAfter('git branch -m main && git commit -m x'), 'main');
  eq('switch --detach', branchesAfter('git switch --detach main && git commit -m x'), 'HEAD');
  eq('checkout -- <paths> does not move HEAD', branchesAfter('git checkout -- a.txt && git commit -m x'), 'LIVE');
  eq('checkout <commit> -- <path> does not move HEAD', branchesAfter('git checkout HEAD~1 -- a.txt && git commit -m x'), 'LIVE');
  eq('a switch joined with ; may have failed: either branch', branchesAfter('git switch feature/x; git commit -m x'), 'LIVE,feature/x');
  eq('a variable switch target is unknowable', branchesAfter('git switch "$B" && git commit -m x'), 'null');
  eq('switch - is unknowable', branchesAfter('git switch - && git commit -m x'), 'null');
  eq('checkout <name> outside any repo is unknowable', branchesAfter('git checkout main && git commit -m x'), 'null');
  const argsOf = (command) => gitSeg(command).git.args;
  for (const cmd of ['git push origin HEAD', 'git push -u origin HEAD', 'git push --all', 'git push --mirror',
    'git push origin @', 'git push -u origin', 'git push']) {
    ok(`\`${cmd}\` pushes HEAD's branch`, pushTargetsHead(argsOf(cmd)));
  }
  for (const cmd of ['git push origin HEAD:feature/x', 'git push origin feature/x', 'git push --tags', 'git push origin --delete old']) {
    ok(`\`${cmd}\` does not push HEAD's branch`, !pushTargetsHead(argsOf(cmd)));
  }
  eq('rebase <upstream> rewrites the current branch', rebaseBranch(argsOf('git rebase main')), undefined);
  eq('rebase <upstream> <branch> rewrites <branch>', rebaseBranch(argsOf('git rebase feature/x main')), 'main');

  // ── data heredocs ──────────────────────────────────────────────────────────
  ok('a data heredoc body is removed', !/checkout main/.test(stripDataHeredocs("git commit -F - <<'EOF'\ngit checkout main\nEOF")));
  ok('a heredoc piped into a shell keeps its body', /git push/.test(stripDataHeredocs("cat <<'EOF' | bash\ngit push origin main\nEOF")));
  ok('a heredoc fed to a shell keeps its body', /git push/.test(stripDataHeredocs("bash <<'EOF'\ngit push origin main\nEOF")));
  ok('a quoted << is not a heredoc', stripDataHeredocs('echo "a <<EOF"\ngit commit -m x').includes('git commit'));
  ok('a quote inside one body cannot hide the next, shell-run body',
    /git push/.test(stripDataHeredocs("cat <<'A'\ncat it's\nA\nbash <<'B'\ngit push origin main\nB")));

  // ── pushd / popd / cd - ────────────────────────────────────────────────────
  eq('pushd moves', gitDir(`pushd ${fwd(a)} && git status`), a);
  eq('popd returns', gitDir(`pushd ${fwd(a)} && popd && git status`), start);
  eq('pushd -n does not move', gitDir(`pushd -n ${fwd(a)} && git status`), start);
  eq('popd with no known stack is unknowable', gitDir(`cd ${fwd(a)} && popd && git status`), start);
  eq('cd - returns to the previous directory', gitDir(`cd ${fwd(a)} && cd b && cd - && git status`), a);

  // ── PowerShell ─────────────────────────────────────────────────────────────
  const ps = { shell: 'powershell' };
  eq('PowerShell: cd <native path>', gitDir(`cd ${a}; git status`, ps), a);
  eq('PowerShell: Set-Location -Path \'…\'', gitDir(`Set-Location -Path '${spaced}'; git status`, ps), spaced);
  eq('PowerShell: sl "…"', gitDir(`sl "${spaced}"; git status`, ps), spaced);
  eq('PowerShell: a backtick escapes a space', gitDir('cd ../with` space; git status', ps), spaced);
  eq('PowerShell: Push-Location then Pop-Location', gitDir(`Push-Location ${a}; Pop-Location; git status`, ps), start);
  eq('PowerShell: ( ) does not scope the location', gitDir(`(cd ${a}); git status`, ps), a);
  eq('PowerShell: ~ expands even when quoted', gitDir('cd "~/proj"; git status', ps), proj);
  eq('PowerShell: $env: paths are unknowable', gitDir('cd $env:REPO; git status', ps), start);

  // ── round 2: cmd.exe and Start-Process (cp-4vfe) ────────────────────────────
  const psh = { shell: 'powershell' };
  eq('cmd /c "<commands>"', subOf('cmd /c "git commit -m x"'), 'commit|git commit -m x');
  eq('cmd.exe /k <words>', subOf('cmd.exe /k git push'), 'push|git push');
  eq('Git-Bash cmd //c', subOf('cmd //c "git commit -m x"'), 'commit|git commit -m x');
  eq('cmd /s /c', subOf('cmd /s /c "git commit -m x"'), 'commit|git commit -m x');
  eq('PowerShell: cmd.exe /c "<commands>"', subOf('cmd.exe /c "git commit -m x"', psh), 'commit|git commit -m x');
  eq('cmd: a lone & separates commands (and may follow a failure)',
    branchesAfter('cmd /c "git switch main & git commit -m x"'), 'LIVE,main');
  eq('cmd: %VAR% is unknowable', branchesAfter('cmd /c "git switch %B% && git commit -m x"'), 'null');
  eq('PowerShell: Start-Process git -ArgumentList <list>',
    subOf("Start-Process git -ArgumentList 'commit','-m','x' -Wait", psh), 'commit|git commit -m x');
  eq('PowerShell: Start-Process -FilePath git.exe -ArgumentList "<string>"',
    subOf('Start-Process -FilePath git.exe -ArgumentList "push origin main"', psh), 'push|git push origin main');
  eq('PowerShell: saps with positional arguments', subOf("saps git 'commit -m x'", psh), 'commit|git commit -m x');
  eq('PowerShell: Start-Process cmd -ArgumentList "/c git commit"',
    subOf('Start-Process cmd -ArgumentList "/c git commit -m x"', psh), 'commit|git commit -m x');

  // ── round 2: push destinations, every-branch pushes, main ref rewrites ────
  const pushArgs = (cmd) => gitSeg(cmd).git.args;
  for (const cmd of ['git push origin main', 'git push origin HEAD:main', 'git push origin :main',
    'git push origin +main', 'git push origin refs/heads/main', 'git push origin main~0:main',
    'git push --force-with-lease origin main', 'git push origin --delete main', 'git push origin HEAD:refs/heads/master']) {
    ok(`\`${cmd}\` writes main/master`, !!pushWritesMain(pushArgs(cmd)));
  }
  for (const cmd of ['git push origin feature/main', 'git push origin main2', 'git push origin HEAD:feature/main',
    'git push main', 'git push origin HEAD']) {
    ok(`\`${cmd}\` does not write main/master by name`, !pushWritesMain(pushArgs(cmd)));
  }
  eq('push --all sends every branch', pushesEveryBranch(pushArgs('git push --all')), '--all');
  eq('push --mirror origin', pushesEveryBranch(pushArgs('git push --mirror origin')), '--mirror');
  eq('push origin HEAD is not every branch', pushesEveryBranch(pushArgs('git push origin HEAD')), '');
  const rewrite = (cmd) => {
    const r = mainRefEffect(gitSeg(cmd).git).rewrite;
    return r ? `${r.what}>${r.ref}` : '';
  };
  eq('branch -f main', rewrite('git branch -f main HEAD'), 'git branch --force>main');
  eq('branch --force master', rewrite('git branch --force master'), 'git branch --force>master');
  eq('branch -m <x> main', rewrite('git branch -m feature/x main'), 'git branch -m>main');
  eq('branch -M main renames the current branch onto main', rewrite('git branch -M main'), 'git branch -M>main');
  eq('branch -C <x> main', rewrite('git branch -C feature/x main'), 'git branch -C>main');
  eq('update-ref refs/heads/main', rewrite('git update-ref refs/heads/main HEAD'), 'git update-ref>main');
  eq('update-ref -d refs/heads/master', rewrite('git update-ref -d refs/heads/master'), 'git update-ref>master');
  eq('update-ref --stdin is unreadable', rewrite('git update-ref --stdin'), 'git update-ref --stdin>null');
  eq('update-ref "$REF" is unreadable', rewrite('git update-ref "$REF" HEAD'), 'git update-ref>null');
  for (const cmd of ['git branch -f feature/x HEAD', 'git branch -m feature/x feature/y', 'git branch main',
    'git branch -d main', 'git update-ref refs/heads/feature/x HEAD', 'git update-ref refs/heads/main2 HEAD',
    'git reset --hard origin/main']) {
    eq(`\`${cmd}\` rewrites no main ref`, rewrite(cmd), '');
  }
  ok('`git branch main` still counts as writing the main ref', mainRefEffect(gitSeg('git branch main').git).writes);
  ok('`git fetch origin main:main` writes it', mainRefEffect(gitSeg('git fetch origin main:main').git).writes);
  ok('`git fetch origin main` does not', !mainRefEffect(gitSeg('git fetch origin main').git).writes);
  ok('`git checkout -b main` writes it', mainRefEffect(gitSeg('git checkout -b main').git).writes);

  // ── round 2: a worktree the same command creates ──────────────────────────
  const newWt = path.join(root, 'new-wt'); // never created
  {
    const cmd = `git worktree add -b feature/wt "${fwd(newWt)}" && cd "${fwd(newWt)}" && git commit -m x`;
    const commit = resolveSegments(cmd, start, { home }).filter((s) => s.git && s.git.sub === 'commit').pop();
    eq('a cd into a worktree created earlier resolves before it exists', commit && commit.dir, newWt);
    eq('...and the commit runs on the branch the add created', branchesAfter(cmd), 'feature/wt');
  }
  eq('git -C <new worktree> uses it too',
    branchesAfter('git worktree add -b feature/wt ../new-wt && git -C ../new-wt commit -m x'), 'feature/wt');
  eq('with no commit-ish the branch is named after the path',
    branchesAfter('git worktree add ../main && cd ../main && git commit -m x'), 'main');
  eq('--detach', branchesAfter('git worktree add --detach ../new-wt && cd ../new-wt && git commit -m x'), 'HEAD');
  eq('a subdirectory of the new worktree belongs to it',
    branchesAfter('git worktree add -b feature/wt ../new-wt && cd ../new-wt/src && git commit -m x'), 'feature/wt');
  eq('an add joined with ; may have failed: unknowable too',
    branchesAfter('git worktree add -b feature/wt ../new-wt; cd ../new-wt; git commit -m x'), 'feature/wt,null');

  // ── Windows-only spellings ─────────────────────────────────────────────────
  if (process.platform === 'win32') {
    const gitBash = (p) => fwd(p).replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`);
    eq('Git-Bash /c/... path', gitDir(`cd ${gitBash(a)} && git status`), a);
    eq('Git-Bash /c/... path in git -C', gitDir(`git -C "${gitBash(spaced)}" status`), spaced);
    eq('an UNQUOTED C:\\ path in Bash loses its backslashes -> unknowable', gitDir(`cd ${a} && git status`), start);
    eq('a Git-Bash-rooted path like /tmp is unknowable', gitDir('cd /tmp && git status'), start);
  }

  // ── pure helpers ───────────────────────────────────────────────────────────
  eq('toNativePath: /c/x on win32', toNativePath('/c/Users/x', 'win32'), 'C:/Users/x');
  eq('toNativePath: /cygdrive/d/x on win32', toNativePath('/cygdrive/d/x', 'win32'), 'D:/x');
  eq('toNativePath: a bare drive', toNativePath('/c', 'win32'), 'C:/');
  eq('toNativePath: /tmp is not a drive', toNativePath('/tmp/x', 'win32'), '/tmp/x');
  eq('toNativePath: /c/x means /c/x off Windows', toNativePath('/c/Users/x', 'linux'), '/c/Users/x');
  eq('shellFor: PowerShell', shellFor('PowerShell'), 'powershell');
  eq('shellFor: Bash', shellFor('Bash'), 'posix');
  eq('shellFor: another host\'s shell tool reads as POSIX', shellFor('execute_command'), 'posix');
  eq('shellFor: no tool name', shellFor(undefined), 'posix');

  // ── the same segments as commandSegments(), always ─────────────────────────
  // The guards moved from commandSegments() to resolveSegments(). If the two
  // ever split a command differently, a guard would stop seeing a segment that
  // commandSegments() callers still see. Compared after data heredocs are
  // stripped, and on each segment's own entry (not the `extra` ones).
  for (const cmd of [
    'git commit -m x',
    'cd . && git push origin main',
    'FOO=1 git commit -m "fix: a; b | c"',
    "git commit -F - <<'EOF'\nfix: x; y | z\nEOF\ngit push",
    'git commit -m "$(cat <<\'EOF\'\nfeat: x\nEOF\n)"',
    '(cd a && git status) || echo "no; really"',
    '  \n;;  ',
  ]) {
    const got = JSON.stringify(resolveSegments(cmd, start).filter((s) => !s.extra).map((s) => s.text));
    const want = JSON.stringify(commandSegments(stripDataHeredocs(cmd)));
    ok(`segments match commandSegments for ${JSON.stringify(cmd).slice(0, 40)}`, got === want, `${got} vs ${want}`);
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

if (fail === 0) {
  console.log(`git-command.test.js: ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`git-command.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
