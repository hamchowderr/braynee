#!/usr/bin/env node
'use strict';

// beads-claim-gate.test.js — unit tests for the pure helpers behind the claim
// gate. A parse regression either blocks commands that claim nothing or lets a
// plan-less claim through; a findings regression blocks chores or spikes.

const assert = require('assert');
const path = require('path');
const { parseClaims, blockingFindings, blockMessage } = require('./beads-claim-gate.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
const CWD = path.resolve('/repo');

// ── parseClaims: what counts as a claim ─────────────────────────────────────
test('bd update <id> --claim is a claim', () => {
  const c = parseClaims('bd update cp-1 --claim', CWD);
  assert.strictEqual(c.length, 1);
  assert.deepStrictEqual(c[0].ids, ['cp-1']);
  assert.strictEqual(c[0].kind, 'update');
});

test('every spelling of --status in_progress is a claim', () => {
  for (const cmd of ['bd update cp-1 --status in_progress', 'bd update cp-1 --status=in_progress',
                     'bd update cp-1 -s in_progress', 'bd update --status in_progress cp-1']) {
    const c = parseClaims(cmd, CWD);
    assert.deepStrictEqual(c.length && c[0].ids, ['cp-1'], cmd);
  }
});

test('multiple ids and dotted/child ids are all gated', () => {
  const c = parseClaims('bd update mastra-chat-kit-j0p cp-9f2.7 --claim', CWD);
  assert.deepStrictEqual(c[0].ids, ['mastra-chat-kit-j0p', 'cp-9f2.7']);
});

test('non-claiming commands are not claims', () => {
  for (const cmd of ['bd update cp-1 --status closed', 'bd update cp-1 --design "x"',
                     'bd close cp-1', 'bd ready', 'bd ready --json', 'bd show cp-1',
                     'echo bd update cp-1 --claim', 'git commit -m "bd update cp-1 --claim"',
                     'bd update cp-1 --status open']) {
    assert.deepStrictEqual(parseClaims(cmd, CWD), [], cmd);
  }
});

test('a flag value is not mistaken for an id', () => {
  const c = parseClaims('bd update cp-1 --claim --actor some-agent --title "wire-up"', CWD);
  assert.deepStrictEqual(c[0].ids, ['cp-1']);
});

test('bd ready --claim is a claim that keeps its filters', () => {
  const c = parseClaims('bd ready --claim --json -l milestone:MVP', CWD);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].kind, 'ready');
  assert.deepStrictEqual(c[0].readyArgs, ['-l', 'milestone:MVP']);
});

test('a claim later in a chained command is found, with the cd applied', () => {
  const c = parseClaims('cd ../other && bd update cp-2 --claim', CWD);
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].dir, path.resolve(CWD, '../other'));
});

test('-C picks the directory bd runs in', () => {
  const c = parseClaims('bd -C ../x update cp-3 --claim', CWD);
  assert.strictEqual(c[0].dir, path.resolve(CWD, '../x'));
  assert.deepStrictEqual(c[0].ids, ['cp-3']);
});

test('a claim inside a quoted string is not a claim', () => {
  assert.deepStrictEqual(parseClaims('bd create "run bd update cp-1 --claim && go" --type chore', CWD), []);
});

test('the command supplying --acceptance is recorded', () => {
  const c = parseClaims('bd update cp-1 --claim --acceptance "it works"', CWD);
  assert.strictEqual(c[0].supplies.acceptance, true);
});

// ── blockingFindings: what actually blocks ──────────────────────────────────
const lint = (results) => ({ total: results.length, issues: results.length, results });

test('a task missing Acceptance Criteria blocks', () => {
  const f = blockingFindings(lint([{ id: 'cp-1', type: 'task', missing: ['## Acceptance Criteria'] }]));
  assert.deepStrictEqual(f.map((x) => x.missing), [['Acceptance Criteria']]);
});

test('clean lint (results null, as bd prints for chores and unknown ids) does not block', () => {
  assert.deepStrictEqual(blockingFindings({ total: 0, issues: 0, results: null }), []);
  assert.deepStrictEqual(blockingFindings(null), []);
});

test('a spike is not blocked for Findings, only for Goal', () => {
  const f = blockingFindings(lint([{ id: 'cp-s', type: 'spike', missing: ['## Findings'] }]));
  assert.deepStrictEqual(f, []);
  const g = blockingFindings(lint([{ id: 'cp-s', type: 'spike', missing: ['## Goal', '## Findings'] }]));
  assert.deepStrictEqual(g[0].missing, ['Goal']);
});

test('--acceptance on the same command satisfies Acceptance / Success Criteria', () => {
  const f = blockingFindings(lint([
    { id: 'cp-1', type: 'task', missing: ['## Acceptance Criteria'] },
    { id: 'cp-e', type: 'epic', missing: ['## Success Criteria'] },
  ]), { acceptance: true });
  assert.deepStrictEqual(f, []);
});

test('a description carrying the heading satisfies it; a file/stdin description is trusted', () => {
  const miss = lint([{ id: 'cp-b', type: 'bug', missing: ['## Steps to Reproduce'] }]);
  assert.deepStrictEqual(blockingFindings(miss, { description: 'x\n## Steps to Reproduce\n1. go' }), []);
  assert.deepStrictEqual(blockingFindings(miss, { opaqueDescription: true }), []);
  assert.strictEqual(blockingFindings(miss, { description: 'no heading here' }).length, 1);
});

// ── blockMessage ─────────────────────────────────────────────────────────────
test('the block message names the id, the gap and the exact fix command', () => {
  const m = blockMessage([{ id: 'cp-1', type: 'task', title: 'Stub', missing: ['Acceptance Criteria'] }]);
  assert.ok(m.includes('cp-1'));
  assert.ok(m.includes('Acceptance Criteria'));
  assert.ok(m.includes('bd update cp-1 --design'));
  assert.ok(m.includes('--acceptance'));
  assert.ok(m.includes('BRAYNEE_CLAIM_GATE=off'));
});

test('description-only sections are explained as headings', () => {
  const m = blockMessage([{ id: 'cp-b', type: 'bug', missing: ['Steps to Reproduce', 'Acceptance Criteria'] }]);
  assert.ok(m.includes('"## Steps to Reproduce"'));
});

// ── runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL: ${name}\n  ${err.message}`); failed++; }
}
console.log(`beads-claim-gate: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
