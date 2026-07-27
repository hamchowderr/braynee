#!/usr/bin/env node
'use strict';

// commit-hooks-core.test.js — cp-lj73.3.
//
// This installer writes into OTHER people's repos, so the assertions that matter
// most are the ones about what it must NOT do: never clobber an existing
// commit-msg hook, never duplicate its own section on re-install, never write to
// .git/hooks in a repo that redirects core.hooksPath (26 of 50 repos here do),
// and never collide with the five hooks beads owns.
//
// Pure Node, no deps, cross-platform. Exit 0 = pass, 1 = fail.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = require('./commit-hooks-core.js');
const { composeWorkflow, prTitleJob } = require('./ci-workflow-core.js');
const { TYPES } = require('../../hooks/lib/commit-format.js');

let pass = 0, fail = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : '')); }
};
const eq = (name, got, want) =>
  ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'lj733-'));

try {
  // ── mergeHookSection: the do-no-harm contract ─────────────────────────────
  {
    const section = CORE.commitlintHookSection();
    const fresh = CORE.mergeHookSection('', section);
    ok('an empty hook gets a shebang', fresh.startsWith('#!/usr/bin/env sh'));
    ok('an empty hook gets the section', fresh.includes(section));

    const theirs = '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n\nnpm run my-own-check\n';
    const merged = CORE.mergeHookSection(theirs, section);
    ok('an existing hook is PRESERVED', merged.includes('npm run my-own-check'));
    ok('an existing hook keeps its husky sourcing', merged.includes('. "$(dirname "$0")/h"'));
    ok('the section is appended', merged.includes(section));

    // Re-install must replace in place, not stack up.
    const twice = CORE.mergeHookSection(merged, section);
    eq('re-install does not duplicate the section',
      (twice.match(/BEGIN BRAYNEE COMMIT-MSG LINT/g) || []).length, 1);
    ok('re-install still preserves the other hook', twice.includes('npm run my-own-check'));

    // A changed section body must actually take effect on re-install.
    const changed = CORE.mergeHookSection(merged, [CORE.BEGIN, 'echo NEW', CORE.END].join('\n'));
    ok('re-install replaces the section body', changed.includes('echo NEW'));
    ok('...and drops the old body', !changed.includes('npx --no -- commitlint'));
    ok('...while still preserving the other hook', changed.includes('npm run my-own-check'));
  }

  // ── beads coexistence, stated as an assertion rather than a comment ───────
  ok('beads does not own commit-msg', !CORE.BEADS_OWNED_HOOKS.includes('commit-msg'));
  ok('beads does own prepare-commit-msg', CORE.BEADS_OWNED_HOOKS.includes('prepare-commit-msg'));
  {
    // prepare-commit-msg runs BEFORE commit-msg, so beads' trailers are in the
    // message commitlint sees. Footer length must therefore be off, or beads
    // would fail commits for text the committer never wrote.
    const cfg = CORE.commitlintConfig();
    ok('the config disables footer-max-line-length', /'footer-max-line-length':\s*\[0/.test(cfg), cfg);
    ok('the config warns (not errors) on header length', /'header-max-length':\s*\[1/.test(cfg), cfg);
    ok('the config extends config-conventional', cfg.includes('@commitlint/config-conventional'));
    for (const t of TYPES) ok(`the config's type-enum carries "${t}"`, cfg.includes(`"${t}"`));
  }

  // ── gitHooksDir: core.hooksPath must be honored ──────────────────────────
  {
    const repo = path.join(sandbox, 'r');
    eq('unset hooksPath means .git/hooks',
      CORE.gitHooksDir(repo, ''), path.join(repo, '.git', 'hooks'));
    eq('a relative hooksPath resolves against the repo',
      CORE.gitHooksDir(repo, '.husky/_'), path.join(repo, '.husky/_'));
    const abs = path.join(sandbox, 'elsewhere');
    eq('an absolute hooksPath is used as-is', CORE.gitHooksDir(repo, abs), abs);
  }

  // ── planInstall: mode selection ──────────────────────────────────────────
  const mkrepo = (name, files = {}) => {
    const dir = path.join(sandbox, name);
    fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body);
    }
    return dir;
  };
  {
    const plain = mkrepo('plain');
    const p = CORE.planInstall(plain);
    eq('no package.json -> plain mode', p.mode, 'plain');
    ok('plain mode writes into git\'s hooks dir',
      p.files[0].path === path.join(plain, '.git', 'hooks', 'commit-msg'), p.files[0].path);
    ok('plain mode needs no dependencies', p.deps.length === 0 && p.installCmd === null);
    ok('plain mode says it is local-only', p.notes.join(' ').includes('NOT'));

    const npmRepo = mkrepo('npmrepo', { 'package.json': '{"name":"x"}' });
    const n = CORE.planInstall(npmRepo);
    eq('package.json without husky -> npm mode', n.mode, 'npm');
    ok('npm mode adds husky as a dep', n.deps.includes('husky'));
    ok('npm mode writes .husky/commit-msg',
      n.files.some((f) => f.path.endsWith(path.join('.husky', 'commit-msg'))));
    ok('npm mode writes a commitlint config',
      n.files.some((f) => f.path.endsWith('commitlint.config.cjs')));

    const huskyRepo = mkrepo('huskyrepo', {
      'package.json': '{"name":"y"}', '.husky/pre-commit': '#!/bin/sh\n',
    });
    const h = CORE.planInstall(huskyRepo);
    eq('existing .husky -> husky mode', h.mode, 'husky');
    ok('husky mode does NOT re-add husky', !h.deps.includes('husky'));

    // A repo that already configured commitlint made a choice; don't overrule it.
    const cfgRepo = mkrepo('cfgrepo', {
      'package.json': '{"name":"z"}', 'commitlint.config.js': 'module.exports={}',
    });
    const c = CORE.planInstall(cfgRepo);
    ok('an existing commitlint config is left alone',
      !c.files.some((f) => f.path.includes('commitlint.config')), JSON.stringify(c.files.map(f => f.path)));
    ok('...and that is reported', c.notes.join(' ').includes('commitlint.config.js'));

    // pnpm/yarn must get their own install syntax, not npm's.
    const pnpmRepo = mkrepo('pnpmrepo', { 'package.json': '{"name":"p"}', 'pnpm-lock.yaml': '' });
    ok('pnpm gets pnpm syntax', CORE.planInstall(pnpmRepo).installCmd.startsWith('pnpm add -D'),
      CORE.planInstall(pnpmRepo).installCmd);
    const yarnRepo = mkrepo('yarnrepo', { 'package.json': '{"name":"q"}', 'yarn.lock': '' });
    ok('yarn gets yarn syntax', CORE.planInstall(yarnRepo).installCmd.startsWith('yarn add -D'));

    // Re-planning over an already-installed hook reports update, not create.
    const again = CORE.planInstall(huskyRepo);
    const hookFile = again.files.find((f) => f.path.endsWith('commit-msg'));
    eq('a fresh hook is a create', hookFile.action, 'create');
    fs.mkdirSync(path.dirname(hookFile.path), { recursive: true });
    fs.writeFileSync(hookFile.path, hookFile.contents);
    const third = CORE.planInstall(huskyRepo).files.find((f) => f.path.endsWith('commit-msg'));
    eq('an installed hook is an update', third.action, 'update');
  }

  // ── planPackageJson ──────────────────────────────────────────────────────
  {
    const { pkg, changed } = CORE.planPackageJson({ name: 'x' }, ['a', 'b'], { addPrepare: true });
    ok('deps are added', pkg.devDependencies.a === '*' && pkg.devDependencies.b === '*');
    eq('the prepare script is added', pkg.scripts.prepare, 'husky');
    ok('it reports having changed', changed);

    // Never overwrite a pinned version or an existing prepare script.
    const pinned = { devDependencies: { a: '^19.0.0' }, scripts: { prepare: 'echo mine' } };
    const r2 = CORE.planPackageJson(pinned, ['a'], { addPrepare: true });
    eq('a pinned dep version is preserved', r2.pkg.devDependencies.a, '^19.0.0');
    eq('an existing prepare script is preserved', r2.pkg.scripts.prepare, 'echo mine');
    ok('nothing to do reports unchanged', !r2.changed);

    // A dep already in `dependencies` must not be duplicated into devDeps.
    const r3 = CORE.planPackageJson({ dependencies: { a: '1.0.0' } }, ['a'], { addPrepare: false });
    ok('a runtime dep is not duplicated into devDependencies', !r3.pkg.devDependencies.a);
  }

  // ── the sh fallback must actually run (skipped where there is no sh) ──────
  {
    const hook = path.join(sandbox, 'commit-msg');
    fs.writeFileSync(hook, CORE.mergeHookSection('', CORE.regexHookSection()));
    const msg = path.join(sandbox, 'msg.txt');
    const runHook = (text) => {
      fs.writeFileSync(msg, text);
      try {
        execFileSync('sh', [hook, msg], { stdio: 'ignore', timeout: 15000, windowsHide: true });
        return 0;
      } catch (e) { return e.status === undefined ? -1 : e.status; }
    };
    const probe = runHook('feat: probe the harness');
    if (probe === -1) {
      ok('sh is unavailable — fallback execution skipped', true);
    } else {
      eq('a conventional subject is accepted', probe, 0);
      ok('a bare sentence is rejected', runHook('added the login page') !== 0);
      ok('an invented type is rejected', runHook('feature: add login') !== 0);
      eq('a scoped breaking subject is accepted', runHook('feat(api)!: drop v1'), 0);
      // git authors these itself; rejecting them makes merging impossible.
      eq('a merge commit is accepted', runHook('Merge branch main into feature/x'), 0);
      eq('a revert is accepted', runHook('Revert "feat: x"'), 0);
      eq('a fixup is accepted', runHook('fixup! feat: x'), 0);
      // beads' prepare-commit-msg appends trailers BEFORE this hook runs.
      eq('trailers below the subject do not break it',
        runHook('feat(x): add login\n\nRefs: cp-1\nExecuted-By: claude-opus-5\n'), 0);
    }
  }

  // ── the PR-title CI job ──────────────────────────────────────────────────
  {
    const y = composeWorkflow({ pm: 'npm', install: 'npm ci', lint: 'npm run lint' });
    ok('the workflow carries a pr-title job', y.includes('pr-title:'));
    ok('the workflow carries a pr-size job', y.includes('pr-size:'));
    ok('pr jobs only run on pull_request', y.includes("if: github.event_name == 'pull_request'"));

    // Script injection: a PR title is attacker-controlled. Interpolating it into
    // a run: block executes it on the runner.
    const job = prTitleJob(TYPES);
    const runBlocks = job.split('run: |').slice(1).join('\n');
    ok('the PR title never reaches a run: block via ${{ }}',
      !runBlocks.includes('github.event.pull_request.title'), runBlocks.slice(0, 200));
    ok('the PR title is passed through env instead',
      /PR_TITLE: \$\{\{ github\.event\.pull_request\.title \}\}/.test(job));
    for (const t of TYPES) ok(`the CI regex allows type "${t}"`, job.includes(t));
    ok('the size job only warns, never exits non-zero',
      job.includes('::warning title=PR size') && !/pr-size[\s\S]*exit 1/.test(job));

    const off = composeWorkflow({ pm: 'npm', install: 'npm ci', lint: 'npm run lint' }, 'main', { prLint: false });
    ok('--no-pr-lint omits the jobs', !off.includes('pr-title:'));
    ok('...but keeps the real checks', off.includes('npm run lint'));
  }
} catch (e) {
  ok('commit-hooks-core test harness ran', false, e && e.stack);
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

if (fail) {
  console.error(`commit-hooks-core.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log(`commit-hooks-core.test.js: ${pass} passed`);
process.exit(0);
