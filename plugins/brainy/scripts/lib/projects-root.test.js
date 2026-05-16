#!/usr/bin/env node
// projects-root.test.js — verifies the configurable projects-root resolver and
// the PRD<->repo join across a NON-~/code root (cp-qr9 acceptance test).
//
// Pure Node, no deps, cross-platform. Exit 0 = all pass, 1 = a failure.
// Run directly (`node projects-root.test.js`) or via brainy-self-test.

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const {
  getProjectsDir,
  isProjectsDirConfigured,
  projectRepoPath,
  expandHome,
} = require('./projects-root.js');

let pass = 0;
let fail = 0;
const fails = [];

function ok(name, cond) {
  if (cond) { pass++; }
  else { fail++; fails.push(name); }
}
function eq(name, got, want) {
  ok(`${name} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`, got === want);
}

// ── Unit: resolution precedence ──────────────────────────────────────────────
const HOME = os.homedir();

eq('default = <home>/code when nothing set',
   getProjectsDir({}), path.join(HOME, 'code'));

eq('default is NOT configured',
   isProjectsDirConfigured({}), false);

const customRoot = path.join(os.tmpdir(), 'qr9-projects-root');
eq('BRAINY_PROJECTS_DIR wins',
   getProjectsDir({ BRAINY_PROJECTS_DIR: customRoot }),
   path.resolve(customRoot));

eq('BRAINY_PROJECTS_DIR marks configured',
   isProjectsDirConfigured({ BRAINY_PROJECTS_DIR: customRoot }), true);

eq('BEADS_CODE_DIR honored as legacy override',
   getProjectsDir({ BEADS_CODE_DIR: customRoot }),
   path.resolve(customRoot));

eq('BRAINY_PROJECTS_DIR takes precedence over BEADS_CODE_DIR',
   getProjectsDir({ BRAINY_PROJECTS_DIR: customRoot, BEADS_CODE_DIR: '/other' }),
   path.resolve(customRoot));

eq('blank/whitespace env falls through to default',
   getProjectsDir({ BRAINY_PROJECTS_DIR: '   ' }), path.join(HOME, 'code'));

eq('~ expands to home',
   expandHome('~'), HOME);
eq('~/x expands under home',
   expandHome('~/x'), path.join(HOME, 'x'));

eq('projectRepoPath joins under configured root',
   projectRepoPath('my-app', { BRAINY_PROJECTS_DIR: customRoot }),
   path.join(path.resolve(customRoot), 'my-app'));

// ── Integration: PRD<->repo join resolves under a NON-~/code root ────────────
// Build a fake projects root in tmp (definitively not ~/code), a fake repo
// inside it, and a fake vault with a PRD whose `folder:` points at that repo.
// prd-audit must NOT warn about a missing folder when the env var points here.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'qr9-'));
try {
  const projectsRoot = path.join(sandbox, 'my-repos');     // NOT ~/code
  const repoSlug = 'sample-app';
  const repoDir = path.join(projectsRoot, repoSlug);
  fs.mkdirSync(repoDir, { recursive: true });

  // env-driven join points at the real sandbox repo
  eq('join resolves repo under non-~/code root',
     projectRepoPath(repoSlug, { BRAINY_PROJECTS_DIR: projectsRoot }),
     repoDir);
  ok('resolved repo dir actually exists in sandbox',
     fs.existsSync(projectRepoPath(repoSlug, { BRAINY_PROJECTS_DIR: projectsRoot })));

  // Drive prd-audit.mjs end-to-end against a vault with one PRD.
  const vault = path.join(sandbox, 'vault');
  const prdDir = path.join(vault, '2. Areas', 'Product Manager', 'PRDs');
  const projDir = path.join(vault, '1. Projects');
  fs.mkdirSync(prdDir, { recursive: true });
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'Sample App.md'), '# Sample App\n');
  fs.writeFileSync(path.join(prdDir, 'Sample App.md'),
    [
      '---',
      'type: prd',
      'name: Sample App PRD',
      'project: "[[1. Projects/Sample App]]"',
      `folder: ${repoSlug}`,
      'status: active',
      'build_status: in-progress',
      'seeded: false',
      'seeded_at: null',
      'seeded_count: 0',
      '---',
      '',
      '## Acceptance Criteria',
      '',
      '- [ ] **[P0] Thing** — does the thing',
      '',
    ].join('\n'), 'utf-8');

  const auditPath = path.join(__dirname, '..', 'prd-audit.mjs');
  const run = (env) => JSON.parse(execSync(
    `node "${auditPath}" --json --vault "${vault}"`,
    { encoding: 'utf8', env: { ...process.env, ...env } }
  ));

  // With BRAINY_PROJECTS_DIR pointed at the sandbox root, the folder resolves
  // → NO "folder not found" warning.
  const withEnv = run({ BRAINY_PROJECTS_DIR: projectsRoot, BEADS_CODE_DIR: '' });
  const r1 = withEnv.find(r => r.file.endsWith('Sample App.md'));
  ok('prd-audit found the Sample App PRD', !!r1);
  ok('no folder-missing warning when BRAINY_PROJECTS_DIR is set correctly',
     r1 && !r1.warnings.some(w => /not found at/.test(w)));
  ok('no folder issue when join resolves',
     r1 && !r1.issues.some(i => /folder/.test(i)));

  // Without the env var (default ~/code), the same repo is NOT under ~/code,
  // so prd-audit SHOULD warn — proving the join is genuinely root-driven and
  // the ~/code default still behaves as before (back-compat).
  const noEnv = run({ BRAINY_PROJECTS_DIR: '', BEADS_CODE_DIR: '' });
  const r2 = noEnv.find(r => r.file.endsWith('Sample App.md'));
  ok('default ~/code root warns the sandbox repo is missing (back-compat)',
     r2 && r2.warnings.some(w => /not found at/.test(w)));
  ok('back-compat warning mentions BRAINY_PROJECTS_DIR hint',
     r2 && r2.warnings.some(w => /BRAINY_PROJECTS_DIR/.test(w)));
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

// ── Report ───────────────────────────────────────────────────────────────────
if (fail === 0) {
  console.log(`projects-root.test.js: ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`projects-root.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
