#!/usr/bin/env node
// worktree-root.test.js — cp-4kcp. A session started inside a git worktree was
// filed under the worktree's own folder name: each worktree got an auto-created
// project note and its own Sessions folder instead of the repository's.
//
// Covers:
//   1. mainRepoRoot() on a real repo, a `.claude/worktrees/<name>` worktree, a
//      sibling worktree, and a plain folder
//   2. the path fallback when git cannot answer
//   3. the real write path: session-auto-track.js run in a worktree writes to
//      the repository's Sessions folder and auto-creates no project note; run
//      in the main checkout it does the same as before
//
// Every process runs with $BRAYNEE_VAULT at a fixture vault and $HOME /
// $USERPROFILE at a fixture home. Pure Node + git. Exit 0 = pass, 1 = fail.

'use strict';

const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mainRepoRoot, fromPath } = require('./worktree-root.js');

let pass = 0, fail = 0;
const fails = [];
const norm = (p) => (p ? fs.realpathSync.native(p).toLowerCase() : p);
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; fails.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function ok(name, cond) { if (cond) pass++; else { fail++; fails.push(name); } }

const TRACK = path.join(__dirname, '..', 'session-auto-track.js');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'wtroot-'));
const HOME = path.join(sandbox, 'home');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
const NPM_PREFIX = path.join(sandbox, 'npm-prefix');
fs.mkdirSync(NPM_PREFIX, { recursive: true });

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore', windowsHide: true });

function runTrack(vault, cwd) {
  return new Promise((resolve) => {
    const env = {
      ...process.env, BRAYNEE_VAULT: vault, HOME, USERPROFILE: HOME,
      BRAYNEE_HOOK_LOG: path.join(sandbox, 'hooks.log'), npm_config_prefix: NPM_PREFIX,
    };
    const child = spawn(process.execPath, [TRACK], { cwd, windowsHide: true, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), 25_000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(JSON.stringify({ cwd, source: 'startup' }));
  });
}

function makeVault(id) {
  const vault = path.join(sandbox, `vault-${id}`);
  fs.mkdirSync(path.join(vault, '2. Areas', 'Sessions'), { recursive: true });
  fs.mkdirSync(path.join(vault, '1. Projects'), { recursive: true });
  fs.writeFileSync(path.join(vault, '1. Projects', 'Repo Project.md'),
    '---\nname: "Repo Project"\nfolder: "the-repo"\nstatus: active\n---\n\n# Repo Project\n');
  return vault;
}
const dirs = (d) => fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
const files = (d) => fs.readdirSync(d).sort();

(async () => {
  try {
    // A real repository with one commit, and two linked worktrees.
    const repo = path.join(sandbox, 'code', 'the-repo');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), '{}\n');
    git(repo, 'init', '-q');
    git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
    const claudeWt = path.join(repo, '.claude', 'worktrees', 'happy-turing-abc123');
    git(repo, 'worktree', 'add', '-q', '-b', 'claude/happy-turing-abc123', claudeWt);
    const siblingWt = path.join(sandbox, 'code', 'the-repo-xyz');
    git(repo, 'worktree', 'add', '-q', '-b', 'fix/xyz', siblingWt);
    const plain = path.join(sandbox, 'code', 'not-a-repo');
    fs.mkdirSync(plain, { recursive: true });

    // ── 1. mainRepoRoot ─────────────────────────────────────────────────────
    eq('main checkout resolves to itself', norm(mainRepoRoot(repo)), norm(repo));
    eq('.claude/worktrees worktree resolves to the repo', norm(mainRepoRoot(claudeWt)), norm(repo));
    eq('sibling worktree resolves to the repo', norm(mainRepoRoot(siblingWt)), norm(repo));
    eq('plain folder is unchanged', norm(mainRepoRoot(plain)), norm(plain));

    // ── 2. path fallback ────────────────────────────────────────────────────
    eq('fallback strips .claude/worktrees/<name>',
      fromPath('C:\\code\\acme\\.claude\\worktrees\\brave-bohr-1a2b3c'), 'C:\\code\\acme');
    eq('fallback strips it from a nested path',
      fromPath('/home/u/code/acme/.claude/worktrees/x/src'), '/home/u/code/acme');
    eq('fallback leaves other paths alone', fromPath('/home/u/code/acme'), null);

    // ── 3. session-auto-track write path ────────────────────────────────────
    const wtVault = makeVault('wt');
    const r1 = await runTrack(wtVault, claudeWt);
    eq('worktree session exits 0', r1.status, 0);
    eq('worktree session writes to the repo project folder',
      dirs(path.join(wtVault, '2. Areas', 'Sessions')).join(','), 'Repo Project');
    eq('worktree session auto-creates no project note',
      files(path.join(wtVault, '1. Projects')).join(','), 'Repo Project.md');
    const note = fs.readdirSync(path.join(wtVault, '2. Areas', 'Sessions', 'Repo Project'))[0] || '';
    const body = note ? fs.readFileSync(path.join(wtVault, '2. Areas', 'Sessions', 'Repo Project', note), 'utf8') : '';
    ok('worktree session keeps the worktree branch', body.includes('claude/happy-turing-abc123'));

    const mainVault = makeVault('main');
    const r2 = await runTrack(mainVault, repo);
    eq('main checkout session exits 0', r2.status, 0);
    eq('main checkout session writes to the repo project folder',
      dirs(path.join(mainVault, '2. Areas', 'Sessions')).join(','), 'Repo Project');
    eq('main checkout session auto-creates no project note',
      files(path.join(mainVault, '1. Projects')).join(','), 'Repo Project.md');
  } catch (e) {
    fail++;
    fails.push(`threw: ${e && e.stack}`);
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch { /* disposable */ }
  }

  if (fail === 0) {
    console.log(`worktree-root.test.js: ${pass} passed, 0 failed`);
    process.exit(0);
  } else {
    console.error(`worktree-root.test.js: ${pass} passed, ${fail} FAILED`);
    for (const f of fails) console.error(`  FAIL: ${f}`);
    process.exit(1);
  }
})();
