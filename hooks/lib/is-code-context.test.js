#!/usr/bin/env node
// is-code-context.test.js — cp-ccsh.10 / B10, priority 2: this module gates
// behavior for the beads and session hooks and carries 7 silent catches, so a
// wrong answer makes hooks fire in the wrong kind of session (or not at all)
// with no trace.
//
// The interesting cases are the exclusions, because they are what the module
// exists for: a git-backed Obsidian vault must NOT read as a code project, and
// $HOME must not, since `bd init --shared-server` drops a global ~/.beads and
// users keep dotfiles ~/.git.
//
// $HOME-dependent behavior is exercised in a CHILD process with HOME/USERPROFILE
// repointed at a fixture, because the module resolves $HOME at load time and
// sessionDir() writes an anchor file under ~/.claude — a test must not touch the
// real one.
//
// Pure Node, no deps, cross-platform. Exit 0 = pass, 1 = fail.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; fails.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function ok(name, cond) {
  if (cond) pass++; else { fail++; fails.push(name); }
}
const slash = (p) => String(p == null ? p : p).replace(/\\/g, '/');
function eqPath(name, got, want) {
  eq(name, got === null || got === undefined ? got : slash(got), want === null || want === undefined ? want : slash(want));
}

// Strict negative: nothing resolved at all. Usable since cp-9krl, which stopped
// the walk AT $HOME and excluded the OS temp dir as a candidate root. Before
// that, a fixture under %TEMP% resolved to %TEMP% itself on this dev box, where
// stray .beads/ and .git/ dirs left by earlier tooling still live.
function noRoot(name, got) {
  ok(name, got === null);
}

// Tolerant negative, still required for the fake-$HOME child probe below.
// cp-9krl stops the walk at $HOME — but that child sets HOME to a fixture dir
// BELOW the real temp dir, so walking up from it still ascends past the fake
// home toward the real filesystem root, where this process has no say over what
// markers exist. For those cases the module's actual responsibility is "did not
// resolve to anything inside our fixture tree", so assert exactly that.
function notInside(name, got, dir) {
  ok(name, got === null || !slash(got).startsWith(slash(dir)));
}

const MODULE = path.join(__dirname, 'is-code-context.js');
const {
  findCodeRoot, findBeadsRoot, findGitRoot, isCodeContext, sessionDir, isSessionCodeContext,
} = require(MODULE);

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'iscode-'));
try {
  const mkdir = (...p) => { const d = path.join(sandbox, ...p); fs.mkdirSync(d, { recursive: true }); return d; };
  const touch = (dir, name, body = '') => { fs.writeFileSync(path.join(dir, name), body); return dir; };

  // ── manifest detection ─────────────────────────────────────────────────────
  for (const manifest of ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'Gemfile', 'CMakeLists.txt', 'Makefile']) {
    const d = mkdir('manifests', manifest.replace(/\W/g, '_'));
    touch(d, manifest, '{}');
    eq(`${manifest} marks a project root`, findCodeRoot(d), d);
  }
  {
    const d = mkdir('manifests', 'dotnet');
    touch(d, 'MyApp.csproj', '');
    eq('a *.csproj marks a project root (pattern manifest)', findCodeRoot(d), d);
    const s = mkdir('manifests', 'dotnetsln');
    touch(s, 'MyApp.sln', '');
    eq('a *.sln marks a project root (pattern manifest)', findCodeRoot(s), s);
  }

  // ── source files count at the START dir only ───────────────────────────────
  {
    const d = mkdir('srconly');
    touch(d, 'main.rs', 'fn main() {}');
    eq('bare source files mark the start dir', findCodeRoot(d), d);

    const parent = mkdir('srcparent');
    touch(parent, 'index.ts', '');
    const child = mkdir('srcparent', 'sub');
    noRoot('source files in a PARENT do not mark it (start-dir check only)',
           findCodeRoot(child));
  }

  // ── walking up to the nearest manifest ─────────────────────────────────────
  {
    const root = mkdir('walkup');
    touch(root, 'package.json', '{}');
    const deep = mkdir('walkup', 'a', 'b', 'c');
    eq('walks up to the nearest manifest ancestor', findCodeRoot(deep), root);

    const inner = mkdir('walkup', 'a', 'inner');
    touch(inner, 'go.mod', 'module x');
    eq('the CLOSEST ancestor wins', findCodeRoot(path.join(inner, 'x')), inner);
  }

  // ── corroborating markers are sufficient but not required ──────────────────
  for (const marker of ['.git', '.beads']) {
    const d = mkdir('corroborate', marker.slice(1));
    fs.mkdirSync(path.join(d, marker), { recursive: true });
    eq(`a ${marker} dir alone marks a project root`, findCodeRoot(d), d);
  }
  {
    const d = mkdir('nothing', 'at', 'all');
    noRoot('a directory with no signal at all is not a code context', findCodeRoot(d));
    eq('isCodeContext mirrors findCodeRoot', isCodeContext(d), findCodeRoot(d) !== null);
  }

  // ── an Obsidian vault is NEVER a code project, even git-backed ─────────────
  {
    const vault = mkdir('vault');
    fs.mkdirSync(path.join(vault, '.obsidian'), { recursive: true });
    fs.mkdirSync(path.join(vault, '.git'), { recursive: true });   // vault auto-backup
    touch(vault, 'package.json', '{}');                            // stray manifest
    eq('a git-backed vault root is not a code context', findCodeRoot(vault), null);

    const inside = mkdir('vault', '1. Projects', 'Something');
    touch(inside, 'index.js', '');
    eq('a dir INSIDE a vault is not a code context, even with source files',
       findCodeRoot(inside), null);
    eq('isCodeContext is false inside a vault', isCodeContext(inside), false);
  }

  // ── findBeadsRoot / findGitRoot ────────────────────────────────────────────
  {
    const repo = mkdir('markers', 'repo');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.mkdirSync(path.join(repo, '.beads'), { recursive: true });
    const deep = mkdir('markers', 'repo', 'src', 'deep');
    eq('findGitRoot finds the nearest .git ancestor', findGitRoot(deep), repo);
    eq('findBeadsRoot finds the nearest .beads ancestor', findBeadsRoot(deep), repo);

    const bare = mkdir('markers', 'bare');
    noRoot('findGitRoot finds no .git inside a bare fixture tree', findGitRoot(bare));
    noRoot('findBeadsRoot finds no .beads inside a bare fixture tree', findBeadsRoot(bare));

    const inner = mkdir('markers', 'repo', 'pkg');
    fs.mkdirSync(path.join(inner, '.beads'), { recursive: true });
    eq('the NEAREST .beads wins over an outer one', findBeadsRoot(path.join(inner, 'x')), inner);
  }

  // ── bad input never throws ─────────────────────────────────────────────────
  eq('findCodeRoot(null) → null', findCodeRoot(null), null);
  eq('findCodeRoot("") → null', findCodeRoot(''), null);
  eq('findBeadsRoot(null) → null', findBeadsRoot(null), null);
  eq('findGitRoot(undefined) → null', findGitRoot(undefined), null);
  noRoot('findCodeRoot on a non-existent path resolves nothing',
         findCodeRoot(path.join(sandbox, 'no', 'such', 'dir')));

  // ── sessionDir: no session_id falls back to the event cwd ──────────────────
  {
    const d = mkdir('sessionfallback');
    eq('sessionDir with no session_id returns the event cwd', sessionDir({ cwd: d }), d);
    eq('sessionDir({}) falls back to process.cwd()', sessionDir({}), process.cwd());
    eq('sessionDir(null) falls back to process.cwd()', sessionDir(null), process.cwd());
  }

  // ── $HOME exclusion + the session anchor, in a child with a fake $HOME ─────
  {
    // $HOME is nested one level down so it HAS a marker-bearing ancestor
    // (cp-9krl): `homeouter` carries a .git and a manifest. Nothing above $HOME
    // may ever win, and without the walk stopping at $HOME, `homeouter` does.
    // Kept off the sandbox root deliberately — a marker there would be an
    // ancestor of every other fixture and would break the strict noRoot cases.
    const homeOuter = mkdir('homeouter');
    fs.mkdirSync(path.join(homeOuter, '.git'), { recursive: true });
    touch(homeOuter, 'package.json', '{}');

    const fakeHome = mkdir('homeouter', 'home');
    // Global markers that must NOT make $HOME a project root.
    fs.mkdirSync(path.join(fakeHome, '.beads'), { recursive: true });
    fs.mkdirSync(path.join(fakeHome, '.git'), { recursive: true });
    touch(fakeHome, 'package.json', '{}');
    const repo = path.join(fakeHome, 'code', 'app');
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), '{}');
    const wandered = path.join(fakeHome, 'elsewhere');
    fs.mkdirSync(wandered, { recursive: true });
    const bareBelowHome = path.join(fakeHome, 'bare');
    fs.mkdirSync(bareBelowHome, { recursive: true });

    const script = `
      const M = require(${JSON.stringify(MODULE.replace(/\\/g, '/'))});
      const HOME = ${JSON.stringify(fakeHome.replace(/\\/g, '/'))};
      const REPO = ${JSON.stringify(repo.replace(/\\/g, '/'))};
      const WANDERED = ${JSON.stringify(wandered.replace(/\\/g, '/'))};
      const BARE = ${JSON.stringify(bareBelowHome.replace(/\\/g, '/'))};
      const out = {
        homeIsNotCode: M.findCodeRoot(HOME),
        homeBeadsExcluded: M.findBeadsRoot(HOME),
        homeGitExcluded: M.findGitRoot(HOME),
        repoIsCode: M.findCodeRoot(REPO),
        // A project below $HOME must not resolve UP to the global ~/.beads.
        repoBeads: M.findBeadsRoot(REPO),
        // cp-9krl: the walk must STOP at $HOME, not merely refuse to return it.
        // BARE is empty, and the only marker above it is in $HOME's parent.
        aboveHomeIgnoredCode: M.findCodeRoot(BARE),
        aboveHomeIgnoredGit: M.findGitRoot(BARE),
        // First call anchors the session cwd; later calls keep it even though the
        // per-event cwd has wandered.
        anchor1: M.sessionDir({ session_id: 'sess-A', cwd: REPO }),
        anchor2: M.sessionDir({ session_id: 'sess-A', cwd: WANDERED }),
        sessionIsCodeAfterWander: M.isSessionCodeContext({ session_id: 'sess-A', cwd: WANDERED }),
        // A different session anchors independently.
        otherAnchor: M.sessionDir({ session_id: 'sess-B', cwd: WANDERED }),
        otherIsCode: M.isSessionCodeContext({ session_id: 'sess-B', cwd: WANDERED }),
        anchorFileWritten: require('fs').existsSync(HOME + '/.claude/braynee-session-anchor.json'),
      };
      process.stdout.write(JSON.stringify(out));
    `;
    const r = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    });
    ok('child probe ran cleanly', r.status === 0);
    let o = {};
    try { o = JSON.parse(r.stdout || '{}'); } catch { /* reported below */ }
    ok('child returned parseable output', Object.keys(o).length > 0);

    // $HOME carries a manifest AND .git AND .beads; none of them may make it (or
    // anything in the fixture tree) a project root.
    notInside('$HOME is never a code root, despite a manifest + .git + .beads',
              o.homeIsNotCode, fakeHome);
    notInside('the global ~/.beads is excluded from findBeadsRoot', o.homeBeadsExcluded, fakeHome);
    notInside('a dotfiles ~/.git is excluded from findGitRoot', o.homeGitExcluded, fakeHome);
    eqPath('a real repo below $HOME is a code root', o.repoIsCode, repo);
    notInside('a repo does not inherit the global ~/.beads', o.repoBeads, fakeHome);

    // cp-9krl, defect (a): the walk stops AT $HOME. Strict null is assertable
    // here even in the child, because the answer can only be $HOME's parent —
    // which is inside the fixture tree — or nothing.
    noRoot('findCodeRoot never escapes above $HOME to a parent manifest',
           o.aboveHomeIgnoredCode);
    noRoot('findGitRoot never escapes above $HOME to a parent .git',
           o.aboveHomeIgnoredGit);

    eqPath('the first sessionDir call anchors the session cwd', o.anchor1, repo);
    eqPath('a later call keeps the anchor even though cwd wandered', o.anchor2, repo);
    eq('isSessionCodeContext follows the anchor, not the wandered cwd',
       o.sessionIsCodeAfterWander, true);
    eqPath('a different session anchors independently', o.otherAnchor, wandered);
    eq('the anchor cache is persisted under ~/.claude', o.anchorFileWritten, true);
  }

  // ── a corrupt anchor file degrades instead of throwing ────────────────────
  {
    const fakeHome = mkdir('corrupthome');
    fs.mkdirSync(path.join(fakeHome, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.claude', 'braynee-session-anchor.json'), '{ not json');
    const d = path.join(fakeHome, 'work');
    fs.mkdirSync(d, { recursive: true });
    const script = `
      const M = require(${JSON.stringify(MODULE.replace(/\\/g, '/'))});
      process.stdout.write(M.sessionDir({ session_id: 'x', cwd: ${JSON.stringify(d.replace(/\\/g, '/'))} }));
    `;
    const r = spawnSync(process.execPath, ['-e', script], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, HOME: fakeHome, USERPROFILE: fakeHome },
    });
    eq('a corrupt anchor file does not throw', r.status, 0);
    eq('and the event cwd is used instead', r.stdout.replace(/\\/g, '/'), d.replace(/\\/g, '/'));
  }
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

if (fail === 0) {
  console.log(`is-code-context.test.js: ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`is-code-context.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
