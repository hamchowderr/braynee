#!/usr/bin/env node
'use strict';

// beads-close-gate.test.js — unit tests for the pure helpers behind the
// verify-before-close gate (cp-9f2.5). The gate's flag/block decision is driven
// by these, so a regression would either nag on every close or let an
// unverified close through silently.

const assert = require('assert');
const { parseClose, hasVerifyEvidence, VERIFY_RE, GATED_TYPES } = require('./beads-close-gate.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── parseClose ───────────────────────────────────────────────────────────────
test('parseClose reads a single id', () => {
  const p = parseClose('bd close cp-9f2.7');
  assert.deepStrictEqual(p.ids, ['cp-9f2.7']);
  assert.strictEqual(p.force, false);
});

test('parseClose reads multiple ids + reason, and stops ids at the first flag', () => {
  const p = parseClose('bd close cp-1 cp-2 cp-wisp-q8r --reason "all tests green"');
  assert.deepStrictEqual(p.ids, ['cp-1', 'cp-2', 'cp-wisp-q8r']);
  assert.strictEqual(p.reason, 'all tests green');
});

test('parseClose does not pull ids out of the --reason text', () => {
  const p = parseClose('bd close cp-1 --reason "supersedes cp-2 and cp-3"');
  assert.deepStrictEqual(p.ids, ['cp-1']);
});

test('parseClose detects --force / -f', () => {
  assert.strictEqual(parseClose('bd close cp-1 --force').force, true);
  assert.strictEqual(parseClose('bd close cp-1 -f').force, true);
});

test('parseClose handles `bd update <id> --status closed`', () => {
  const p = parseClose('bd update cp-9 --status closed');
  assert.deepStrictEqual(p.ids, ['cp-9']);
});

test('parseClose returns null for a non-close command', () => {
  assert.strictEqual(parseClose('bd update cp-9 --claim'), null);
  assert.strictEqual(parseClose('bd ready'), null);
});

// ── VERIFY_RE ────────────────────────────────────────────────────────────────
test('VERIFY_RE matches recorded-evidence language', () => {
  for (const s of ['VERIFY: ran self-test', 'sandbox-verified', 'tests are green',
                   'all green', 'preview live at ...', 'behaviour-verified']) {
    assert.ok(VERIFY_RE.test(s), `should match: ${s}`);
  }
});

test('VERIFY_RE does not match a bare task description', () => {
  assert.ok(!VERIFY_RE.test('Build the core feature and wire the routes'));
});

// ── hasVerifyEvidence ────────────────────────────────────────────────────────
test('hasVerifyEvidence true when the close reason carries verify language', () => {
  assert.ok(hasVerifyEvidence({ notes: '' }, 'done; sandbox-verified'));
});

test('hasVerifyEvidence true when the issue notes carry a VERIFY step', () => {
  assert.ok(hasVerifyEvidence({ notes: 'VERIFY: self-test 246/0' }, ''));
});

test('hasVerifyEvidence false when neither notes nor reason show evidence', () => {
  assert.ok(!hasVerifyEvidence({ notes: 'started the work' }, 'looks done'));
});

test('hasVerifyEvidence ignores acceptance_criteria (the plan, not evidence)', () => {
  // acceptance_criteria says "verified via self-test" but it is the PLAN — the
  // gate must not treat that as evidence, so an evidence-free close still flags.
  assert.ok(!hasVerifyEvidence({ notes: '', acceptance_criteria: 'verified via self-test' }, ''));
});

// ── GATED_TYPES ──────────────────────────────────────────────────────────────
test('GATED_TYPES covers code/build types, exempts epic/decision', () => {
  for (const t of ['feature', 'task', 'bug']) assert.ok(GATED_TYPES.has(t));
  for (const t of ['epic', 'decision', 'chore']) assert.ok(!GATED_TYPES.has(t));
});

// ── runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL: ${name}\n  ${err.message}`); failed++; }
}
console.log(`beads-close-gate: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
