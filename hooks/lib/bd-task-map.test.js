#!/usr/bin/env node
'use strict';

// bd-task-map.test.js — unit tests for the stable bd<->CC-task id map (cp-ydy).
// The back-prop hooks resolve which beads issue to close from this map, so a
// regression (wrong join, clobbered pair) would close the wrong issue — exactly
// the risk the map exists to remove.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('./bd-task-map.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }
function tmpBeads() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bdmap-'));
  fs.mkdirSync(path.join(d, '.beads'), { recursive: true });
  return path.join(d, '.beads');
}

test('normalizeTitle unescapes, trims, lowercases, collapses whitespace', () => {
  assert.strictEqual(M.normalizeTitle('  Fix  the   \\"Thing\\" '), 'fix the "thing"');
});

test('records a bd_id then binds cc_task_id by title (the bd-create -> complete flow)', () => {
  const b = tmpBeads();
  try {
    // bd create fires first: {bd_id, title}
    M.upsert(b, { bdId: 'cp-9f2.7', title: 'Fix bd flags' }, '2026-06-04T00:00:00Z');
    // TaskCompleted is the first sighting of the cc task id — bind it by title.
    const entry = M.upsert(b, { ccTaskId: 'task-42', title: 'Fix bd flags' }, '2026-06-04T00:01:00Z');
    assert.strictEqual(entry.bd_id, 'cp-9f2.7');
    assert.strictEqual(entry.cc_task_id, 'task-42');
    // Now the lookup is STABLE by id, no title fuzz.
    assert.strictEqual(M.lookupByTaskId(b, 'task-42').bd_id, 'cp-9f2.7');
  } finally { fs.rmSync(path.dirname(b), { recursive: true, force: true }); }
});

test('does not clobber a completed pair when a second same-title issue is recorded', () => {
  const b = tmpBeads();
  try {
    M.upsert(b, { bdId: 'cp-1', title: 'Deploy' }, '2026-06-04T00:00:00Z');
    M.upsert(b, { ccTaskId: 't1', title: 'Deploy' }, '2026-06-04T00:00:01Z'); // completes the first pair
    M.upsert(b, { bdId: 'cp-2', title: 'Deploy' }, '2026-06-04T00:00:02Z');     // a NEW same-title issue
    const data = M.load(b);
    assert.strictEqual(data.entries.length, 2);                                 // two distinct entries, not one clobbered
    assert.strictEqual(M.lookupByTaskId(b, 't1').bd_id, 'cp-1');                 // first pair intact
  } finally { fs.rmSync(path.dirname(b), { recursive: true, force: true }); }
});

test('re-recording the same bd_id is idempotent (no duplicate entry)', () => {
  const b = tmpBeads();
  try {
    M.upsert(b, { bdId: 'cp-1', title: 'A' });
    M.upsert(b, { bdId: 'cp-1', title: 'A' });
    assert.strictEqual(M.load(b).entries.length, 1);
  } finally { fs.rmSync(path.dirname(b), { recursive: true, force: true }); }
});

test('resolve prefers the stable id, falls back to title', () => {
  const b = tmpBeads();
  try {
    M.upsert(b, { bdId: 'cp-1', title: 'Alpha' });
    M.upsert(b, { ccTaskId: 't9', title: 'Alpha' });
    assert.strictEqual(M.resolve(b, { ccTaskId: 't9' }).bd_id, 'cp-1');         // by id
    assert.strictEqual(M.resolve(b, { title: 'ALPHA' }).bd_id, 'cp-1');         // by title (normalized)
    assert.strictEqual(M.resolve(b, { ccTaskId: 'nope', title: 'none' }), null);
  } finally { fs.rmSync(path.dirname(b), { recursive: true, force: true }); }
});

test('persists across reload (survives compaction) and looks up by bd_id', () => {
  const b = tmpBeads();
  try {
    M.upsert(b, { bdId: 'cp-7', ccTaskId: 't7', title: 'Persist me' });
    assert.ok(fs.existsSync(M.mapPath(b)));
    // Fresh read (simulates a later session / post-compaction hook invocation).
    const e = M.lookupByBdId(b, 'cp-7');
    assert.strictEqual(e.cc_task_id, 't7');
    assert.strictEqual(e.title, 'Persist me');
  } finally { fs.rmSync(path.dirname(b), { recursive: true, force: true }); }
});

test('load tolerates a missing / corrupt map file', () => {
  const b = tmpBeads();
  try {
    assert.deepStrictEqual(M.load(b).entries, []);          // missing → empty
    fs.writeFileSync(M.mapPath(b), '{ not json', 'utf8');
    assert.deepStrictEqual(M.load(b).entries, []);          // corrupt → empty, no throw
  } finally { fs.rmSync(path.dirname(b), { recursive: true, force: true }); }
});

// ── runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL: ${name}\n  ${err.message}`); failed++; }
}
console.log(`bd-task-map: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
