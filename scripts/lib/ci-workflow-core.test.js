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

// ── runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL: ${name}\n  ${err.message}`); failed++; }
}
console.log(`ci-workflow-core: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
