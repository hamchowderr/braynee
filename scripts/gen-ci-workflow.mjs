#!/usr/bin/env node
// gen-ci-workflow.mjs — author a real lint+typecheck+test GitHub Actions workflow
// when a repo has none, so the autonomous-ship gh:run gate has substantive checks to
// gate on (no vacuous green). The ci-harness formula step calls this. (cp-asf)
//
// Usage: node gen-ci-workflow.mjs [--repo <dir>] [--name ci.yml] [--branch main] [--dry-run]
// Idempotent: if .github/workflows/<name> already exists, it reports and does nothing.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { detectStack, composeWorkflow } = require(path.join(import.meta.dirname, 'lib', 'ci-workflow-core.js'));

const args = process.argv.slice(2);
const opt = (flag, def) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : def; };
const repoDir = path.resolve(opt('--repo', process.cwd()));
const name = opt('--name', 'ci.yml');
const branch = opt('--branch', 'main');
const dryRun = args.includes('--dry-run');

const wfDir = path.join(repoDir, '.github', 'workflows');
const wfPath = path.join(wfDir, name);

if (fs.existsSync(wfPath)) {
  console.log(`CI workflow already exists: ${path.relative(repoDir, wfPath)} — leaving it untouched.`);
  process.exit(0);
}

const stack = detectStack(repoDir);
const yaml = composeWorkflow(stack, branch);
const checks = ['lint', 'typecheck', 'test'].filter(k => stack[k]);

if (dryRun) {
  console.log(`[dry-run] would write ${path.relative(repoDir, wfPath)} (${stack.pm}; checks: ${checks.join(', ') || 'NONE — failing guard step'})\n`);
  console.log(yaml);
  process.exit(0);
}

fs.mkdirSync(wfDir, { recursive: true });
fs.writeFileSync(wfPath, yaml, 'utf8');
console.log(`Authored ${path.relative(repoDir, wfPath)} (${stack.pm}; checks: ${checks.join(', ') || 'NONE — added a failing guard so the gate cannot go vacuously green'}).`);
if (checks.length === 0) {
  console.log('⚠ No lint/typecheck/test detected — add real checks (or package.json scripts) so CI is meaningful.');
}
