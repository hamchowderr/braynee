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
const { commandSegments, resolveSegments, shellFor, toNativePath } = require('./git-command.js');

let pass = 0, fail = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : '')); }
};
const eq = (name, got, want) =>
  ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitcmd-'));
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
const fwd = (p) => p.replace(/\\/g, '/');

// The directory the first git segment of `command` runs in.
const gitDir = (command, opts = {}) => {
  const seg = resolveSegments(command, start, { home, ...opts }).find((s) => /^git\s/.test(s.match));
  return seg ? seg.dir : undefined;
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
  eq('--git-dir relocates the repo', gitDir(`git --git-dir=${fwd(a)}/.git status`), start);
  eq('--work-tree relocates the repo', gitDir(`git -C ${fwd(a)} --work-tree ${fwd(ab)} status`), start);
  eq('an inline GIT_DIR relocates the repo', gitDir(`cd ${fwd(a)} && GIT_DIR=x git status`), start);
  eq('an exported GIT_DIR relocates every later git', gitDir(`export GIT_DIR=x; cd ${fwd(a)} && git status`), start);
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
  eq('a cd line inside a heredoc body is never followed',
    gitDir(`cd ${fwd(a)} && cat > notes <<'EOF'\ncd ${fwd(ab)}\nEOF\ngit status`), start);

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
  // commandSegments() callers still see.
  for (const cmd of [
    'git commit -m x',
    'cd . && git push origin main',
    'FOO=1 git commit -m "fix: a; b | c"',
    "git commit -F - <<'EOF'\nfix: x; y | z\nEOF\ngit push",
    'git commit -m "$(cat <<\'EOF\'\nfeat: x\nEOF\n)"',
    '(cd a && git status) || echo "no; really"',
    '  \n;;  ',
  ]) {
    const got = JSON.stringify(resolveSegments(cmd, start).map((s) => s.text));
    const want = JSON.stringify(commandSegments(cmd));
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
