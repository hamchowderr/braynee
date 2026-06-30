#!/usr/bin/env node
'use strict';

// beads-gate-check.test.js — unit tests for the pure helpers behind the Stop-hook
// gate auto-advance (cp-8d9). These drive the "is there work to do / did a gate
// resolve" decision; a regression would either poll GitHub every turn for nothing
// or miss a resolved gate (so a merged PR never unblocks `ship`).

const assert = require('assert');
const { countOpenGates, hasOpenGates, gatesResolved } = require('./beads-gate-check.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

const LIST_2 = `Open gates (2):
  cp-x  ci-green  type:gh:run  await_id:123  timeout:2h
  cp-y  ship      type:gh:pr   await_id:45   timeout:24h`;
const LIST_1 = `Open gates (1):
  cp-y  ship      type:gh:pr   await_id:45   timeout:24h`;

// ── countOpenGates ───────────────────────────────────────────────────────────
test('countOpenGates counts one per gate line (timeout marker)', () => {
  assert.strictEqual(countOpenGates(LIST_2), 2);
  assert.strictEqual(countOpenGates(LIST_1), 1);
});
test('countOpenGates is 0 for empty / null', () => {
  assert.strictEqual(countOpenGates(''), 0);
  assert.strictEqual(countOpenGates(null), 0);
});

// ── hasOpenGates ─────────────────────────────────────────────────────────────
test('hasOpenGates true for a real gate list', () => {
  assert.ok(hasOpenGates(LIST_2));
});
test('hasOpenGates false for the no-open-gates sentinel, empty, or non-gate output', () => {
  assert.ok(!hasOpenGates('No open gates'));
  assert.ok(!hasOpenGates('no open gates found'));
  assert.ok(!hasOpenGates(''));
  assert.ok(!hasOpenGates(null));
  assert.ok(!hasOpenGates('warning: something unrelated'));
});

// ── gatesResolved ────────────────────────────────────────────────────────────
test('gatesResolved reports how many gates closed between snapshots', () => {
  assert.strictEqual(gatesResolved(LIST_2, LIST_1), 1); // one gate resolved
  assert.strictEqual(gatesResolved(LIST_2, LIST_2), 0); // nothing changed
});
test('gatesResolved clamps to 0 (never negative if a gate was added)', () => {
  assert.strictEqual(gatesResolved(LIST_1, LIST_2), 0);
});

// ── runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL: ${name}\n  ${err.message}`); failed++; }
}
console.log(`beads-gate-check: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
