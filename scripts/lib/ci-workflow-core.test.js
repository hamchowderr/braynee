#!/usr/bin/env node
'use strict';

// ci-workflow-core.test.js — unit tests for the ci-harness workflow generator
// (cp-asf). Locks the no-vacuous-green contract: a repo with no checks gets a
// FAILING workflow, a repo with real scripts gets those steps, and the advisory
// reviewer workflow is recognized for gate exclusion.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { scriptCmd, detectStack, composeWorkflow, isAdvisoryWorkflow } = require('./ci-workflow-core.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

function tmpRepo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-core-'));
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, 'utf8');
  }
  return dir;
}

// ── scriptCmd ────────────────────────────────────────────────────────────────
test('scriptCmd uses `npm run` but bare pnpm/yarn', () => {
  assert.strictEqual(scriptCmd('npm', 'lint'), 'npm run lint');
  assert.strictEqual(scriptCmd('pnpm', 'test'), 'pnpm test');
  assert.strictEqual(scriptCmd('yarn', 'typecheck'), 'yarn typecheck');
});

// ── detectStack ──────────────────────────────────────────────────────────────
test('detects pnpm + package.json scripts', () => {
  const dir = tmpRepo({
    'pnpm-lock.yaml': '',
    'package.json': JSON.stringify({ scripts: { lint: 'biome check .', typecheck: 'tsc', test: 'vitest' } }),
  });
  const s = detectStack(dir);
  assert.strictEqual(s.pm, 'pnpm');
  assert.strictEqual(s.install, 'pnpm install --frozen-lockfile');
  assert.strictEqual(s.lint, 'pnpm lint');
  assert.strictEqual(s.typecheck, 'pnpm typecheck');
  assert.strictEqual(s.test, 'pnpm test');
});

test('falls back to detected tools when no scripts (biome + tsconfig)', () => {
  const dir = tmpRepo({ 'biome.json': '{}', 'tsconfig.json': '{}', 'package.json': '{}' });
  const s = detectStack(dir);
  assert.strictEqual(s.pm, 'npm');
  assert.match(s.lint, /biome/);
  assert.match(s.typecheck, /tsc --noEmit/);
  assert.strictEqual(s.test, null);
});

test('empty repo detects nothing runnable', () => {
  const s = detectStack(tmpRepo({ 'package.json': '{}' }));
  assert.deepStrictEqual([s.lint, s.typecheck, s.test], [null, null, null]);
});

// ── composeWorkflow ──────────────────────────────────────────────────────────
test('emits the real check steps and names the workflow "CI" (not the advisory one)', () => {
  const y = composeWorkflow({ pm: 'npm', install: 'npm ci', lint: 'npm run lint', typecheck: 'npx tsc --noEmit', test: 'npm test' });
  assert.match(y, /^name: CI$/m);
  assert.ok(!/^name: Claude/m.test(y)); // the workflow's NAME isn't the advisory reviewer
  assert.match(y, /run: npm run lint/);
  assert.match(y, /run: npx tsc --noEmit/);
  assert.match(y, /run: npm test/);
});

test('no-vacuous-green: a stack with no checks produces a FAILING guard step', () => {
  const y = composeWorkflow({ pm: 'npm', install: 'npm ci', lint: null, typecheck: null, test: null });
  assert.match(y, /exit 1/);
  assert.match(y, /No real checks detected/);
});

// ── isAdvisoryWorkflow ───────────────────────────────────────────────────────
test('recognizes the advisory Claude Code Review workflow for gate exclusion', () => {
  assert.ok(isAdvisoryWorkflow('Claude Code Review'));
  assert.ok(isAdvisoryWorkflow('claude-code-review.yml'));
  assert.ok(!isAdvisoryWorkflow('CI'));
  assert.ok(!isAdvisoryWorkflow('ci.yml'));
});

// ── cp-0wyf: shared PR standards workflow ────────────────────────────────────
const { reusablePrWorkflow, callerWorkflow, validPrefixes } = require('./ci-workflow-core.js');
const { spawnSync } = require('child_process');

// Pull one job's run: script out of the generated YAML and run it with bash, the
// shell GitHub's ubuntu runner uses, so the test exercises the real script text.
function jobScript(job) {
  const yml = reusablePrWorkflow();
  const start = yml.indexOf('\n  ' + job + ':');
  const run = yml.indexOf('run: |\n', start) + 'run: |\n'.length;
  const end = yml.indexOf('\n\n', run);
  return yml.slice(run, end === -1 ? undefined : end).split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
}
function runJob(job, env) {
  const r = spawnSync('bash', ['-c', jobScript(job)], { env: { ...process.env, ...env }, encoding: 'utf8' });
  return r.status;
}

test('committed pr-standards.yml equals the generator output', () => {
  const file = path.join(__dirname, '..', '..', '.github', 'workflows', 'pr-standards.yml');
  assert.strictEqual(fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), reusablePrWorkflow());
});

test('pr-issue passes when the title or body names an accepted beads id', () => {
  assert.strictEqual(runJob('pr-issue', { PR_TITLE: 'fix: x', PR_BODY: 'Refs: locus-hn3', PREFIXES: 'locus' }), 0);
  assert.strictEqual(runJob('pr-issue', { PR_TITLE: 'feat: blocks page (waas-api-0ow.8)', PR_BODY: '', PREFIXES: 'waas waas-api' }), 0);
  assert.strictEqual(runJob('pr-issue', { PR_TITLE: 'fix(practice): scenario', PR_BODY: 'Closes: acme-agents-i5z', PREFIXES: 'acme-agents' }), 0);
});

test('pr-issue fails without an accepted id, including look-alike branch names', () => {
  assert.strictEqual(runJob('pr-issue', { PR_TITLE: 'feat: delete an account', PR_BODY: 'Branch claude/project-thread-akcttf', PREFIXES: 'takewon' }), 1);
  assert.strictEqual(runJob('pr-issue', { PR_TITLE: 'feat: x (waas-api-0ow)', PR_BODY: '', PREFIXES: 'waas' }), 1);
  assert.strictEqual(runJob('pr-issue', { PR_TITLE: 'feat: x', PR_BODY: '', PREFIXES: 'locus' }), 1);
});

test('pr-issue refuses a prefixes input that is not a plain prefix list', () => {
  assert.strictEqual(runJob('pr-issue', { PR_TITLE: 'fix: x locus-hn3', PR_BODY: '', PREFIXES: 'locus; echo hi' }), 1);
  assert.ok(!validPrefixes('locus; rm -rf /'));
  assert.ok(validPrefixes('waas-api waas'));
  assert.throws(() => callerWorkflow('Locus', 'example/plugin'));
  assert.throws(() => callerWorkflow('locus', 'not a repo'));
});

test('pr-title fails a plain-sentence title and passes a Conventional one', () => {
  assert.strictEqual(runJob('pr-title', { PR_TITLE: 'Copy Button block and Carousel fade' }), 1);
  assert.strictEqual(runJob('pr-title', { PR_TITLE: 'feat(blocks): add Copy Button block' }), 0);
});

test('bot PRs are skipped by every job', () => {
  const yml = reusablePrWorkflow();
  const ifs = yml.match(/^ {4}if: .*$/gm);
  assert.strictEqual(ifs.length, 3);
  for (const l of ifs) assert.ok(l.includes("github.event.pull_request.user.type != 'Bot'"), l);
});

test('callerWorkflow pins a tag and passes the prefixes', () => {
  const c = callerWorkflow('waas-api waas', 'example/plugin');
  assert.ok(c.includes('uses: example/plugin/.github/workflows/pr-standards.yml@pr-standards-v1'));
  assert.ok(c.includes('prefixes: "waas-api waas"'));
  assert.ok(c.includes('types: [opened, edited, synchronize, reopened]'));
});

// ── runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL: ${name}\n  ${err.message}`); failed++; }
}
console.log(`ci-workflow-core: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
