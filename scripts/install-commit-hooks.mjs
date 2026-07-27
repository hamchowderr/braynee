#!/usr/bin/env node
// install-commit-hooks.mjs — git-side commit-message enforcement (cp-lj73.3).
//
// The Claude-side guard (cp-lj73.2) only sees commits the AGENT makes. A human
// committing by hand, a teammate, or any other tool bypasses it completely. This
// installs commitlint on the commit-msg hook so the same grammar applies to
// every committer in the clone, and pairs with the PR-title job that
// gen-ci-workflow writes for the server side.
//
// Usage:
//   node scripts/install-commit-hooks.mjs [--repo <dir>] [--dry-run] [--json]
//
// OPT-IN, one repo at a time — deliberately not a fleet sweep. Retro-fitting
// commit-message enforcement onto repos with existing history and other people's
// workflows is a decision per repo, not a default.
//
// Idempotent: the hook body lives between versioned markers, so a re-install
// replaces only that section and preserves anything else in the file.
//
// Never runs a package install itself: that is slow, needs network, and picks a
// package manager on the user's behalf. It prints the exact command instead.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const CORE = require(path.join(import.meta.dirname, 'lib', 'commit-hooks-core.js'));

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`install-commit-hooks — git-side commit-message enforcement (cp-lj73.3)

  node scripts/install-commit-hooks.mjs [--repo <dir>] [--dry-run] [--json]

Installs commitlint on the commit-msg hook so the commit/PR standard applies to
every committer in the clone, not just the agent. Opt-in per repo; idempotent;
never clobbers an existing commit-msg hook (its section is marker-bracketed).
Prints the dependency install command rather than running it.

  --repo <dir>   repository to install into (default: cwd)
  --dry-run      show the plan, write nothing
  --json         machine-readable output`);
  process.exit(0);
}
const opt = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };
const repoDir = path.resolve(opt('--repo', process.cwd()));
const dryRun = args.includes('--dry-run');
const jsonOut = args.includes('--json');

function fail(msg) {
  if (jsonOut) process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
  else console.error(`install-commit-hooks: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(path.join(repoDir, '.git'))) {
  fail(`${repoDir} is not a git repository (no .git). Pass --repo <dir>.`);
}

// Honor core.hooksPath: husky sets it to `.husky/_`, and a relative value must
// resolve against the repo. Writing blindly to .git/hooks in a redirected repo
// produces a file git never runs.
let hooksPath = '';
try {
  hooksPath = execFileSync('git', ['config', '--get', 'core.hooksPath'], {
    cwd: repoDir, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000, windowsHide: true,
  }).trim();
} catch { /* unset is the common case and git exits 1 for it — not an error */ }

const plan = CORE.planInstall(repoDir, { hooksPath });

// package.json edits (devDeps + the husky prepare script) for the node modes.
let pkgChange = null;
if (plan.mode !== 'plain') {
  const pkgPath = path.join(repoDir, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const { pkg: next, changed } = CORE.planPackageJson(pkg, plan.deps, {
      addPrepare: !fs.existsSync(path.join(repoDir, '.husky')),
    });
    if (changed) pkgChange = { path: pkgPath, contents: JSON.stringify(next, null, 2) + '\n' };
  } catch (e) {
    fail(`could not read package.json: ${e.message}`);
  }
}

const written = [];
if (!dryRun) {
  for (const f of plan.files) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.contents, 'utf8');
    // chmod is a no-op on Windows, and git tracks the bit separately — set it
    // anyway so a repo created here works when cloned on Linux/macOS.
    if (f.executable) { try { fs.chmodSync(f.path, 0o755); } catch { /* best effort */ } }
    written.push({ path: f.path, action: f.action });
  }
  if (pkgChange) {
    fs.writeFileSync(pkgChange.path, pkgChange.contents, 'utf8');
    written.push({ path: pkgChange.path, action: 'update' });
  }
}

const result = {
  ok: true,
  repo: repoDir,
  mode: plan.mode,
  dryRun,
  files: (dryRun ? plan.files : written).map((f) => ({
    path: path.relative(repoDir, f.path) || f.path,
    action: f.action,
  })),
  packageJson: pkgChange ? 'devDependencies + prepare script' : null,
  installCmd: plan.installCmd,
  notes: plan.notes,
};

if (jsonOut) {
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(0);
}

console.log(`install-commit-hooks: ${dryRun ? 'DRY RUN — ' : ''}mode=${plan.mode}  repo=${repoDir}`);
for (const f of result.files) console.log(`  ${f.action.padEnd(6)} ${f.path}`);
// Only in dry-run: on a real run the package.json edit is already in `written`,
// and listing it again read as two separate changes.
if (pkgChange && dryRun) {
  console.log(`  update package.json (devDependencies${plan.mode === 'npm' ? ' + prepare script' : ''})`);
}
if (plan.installCmd) console.log(`\nNext: ${plan.installCmd}`);
for (const n of plan.notes) console.log(`\nNote: ${n}`);
if (dryRun) console.log('\nNothing was written (--dry-run).');
