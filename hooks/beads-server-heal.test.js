#!/usr/bin/env node
'use strict';

// beads-server-heal.test.js — unit tests for the pure helpers that drive the
// wedged/squatted Dolt-server heal (cp-6j5). The heal's kill path is gated on
// these, so a regression here would either miss a wedged server or risk killing
// the wrong process — both worth locking down.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  parseStartError, isDbNotFound, pidLooksLikeDolt, pidOnPort, beadsLooksInitialized,
} = require('./beads-server-heal.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── parseStartError ──────────────────────────────────────────────────────────
test('parseStartError extracts port + PID from bd refusal', () => {
  const err = "cannot start dolt server on port 3308: port 3308 is in use by " +
    "another project's dolt server (PID 17864).";
  const r = parseStartError(err);
  assert.strictEqual(r.port, 3308);
  assert.strictEqual(r.pid, 17864);
  assert.strictEqual(r.isPortInUse, true);
});

test('parseStartError flags non-port-in-use errors', () => {
  const r = parseStartError('some other failure');
  assert.strictEqual(r.isPortInUse, false);
  assert.strictEqual(r.pid, null);
});

test('parseStartError tolerates empty/undefined', () => {
  const r = parseStartError(undefined);
  assert.strictEqual(r.port, null);
  assert.strictEqual(r.pid, null);
  assert.strictEqual(r.isPortInUse, false);
});

// ── isDbNotFound ─────────────────────────────────────────────────────────────
test('isDbNotFound matches the real not-found message', () => {
  assert.ok(isDbNotFound('Error: failed to open database: database "cp" not found on Dolt server'));
  assert.ok(isDbNotFound('database cp not found'));
});

test('isDbNotFound ignores unrelated errors', () => {
  assert.ok(!isDbNotFound('connection refused'));
  assert.ok(!isDbNotFound(''));
});

// ── pidLooksLikeDolt (injected runner — no real processes) ───────────────────
test('pidLooksLikeDolt true for a dolt process (win32 tasklist CSV)', () => {
  const runner = () => '"dolt.exe","17864","Console","1","112,000 K"';
  assert.ok(pidLooksLikeDolt(17864, runner, 'win32'));   // force the win32 parse path on any OS
});

test('pidLooksLikeDolt true for a dolt process (posix ps comm)', () => {
  const runner = () => 'dolt\n';
  assert.ok(pidLooksLikeDolt(17864, runner, 'linux'));   // force the posix parse path on any OS
});

test('pidLooksLikeDolt false for a non-dolt process', () => {
  const runner = () => '"node.exe","1234","Console","1","50,000 K"';
  assert.ok(!pidLooksLikeDolt(1234, runner, 'win32'));
});

test('pidLooksLikeDolt false when lookup throws (never kill the unknown)', () => {
  const runner = () => { throw new Error('no such pid'); };
  assert.ok(!pidLooksLikeDolt(9999, runner));
});

test('pidLooksLikeDolt false for a missing/zero pid', () => {
  assert.ok(!pidLooksLikeDolt(0));
  assert.ok(!pidLooksLikeDolt(null));
});

// ── pidOnPort (injected runner) ──────────────────────────────────────────────
test('pidOnPort parses the LISTENING PID', () => {
  if (process.platform === 'win32') {
    const runner = () =>
      '  TCP    127.0.0.1:3308   0.0.0.0:0   LISTENING   17864\n' +
      '  TCP    127.0.0.1:3308   127.0.0.1:5  TIME_WAIT   0\n';
    assert.strictEqual(pidOnPort(3308, runner), 17864);
  } else {
    const runner = () => '17864\n';
    assert.strictEqual(pidOnPort(3308, runner), 17864);
  }
});

test('pidOnPort returns null for no listener / no port', () => {
  assert.strictEqual(pidOnPort(0), null);
  assert.strictEqual(pidOnPort(3308, () => ''), null);
});

// ── beadsLooksInitialized (temp dirs) ────────────────────────────────────────
test('beadsLooksInitialized false for a bare marker .beads/', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-marker-'));
  fs.mkdirSync(path.join(root, '.beads'), { recursive: true });
  try { assert.ok(!beadsLooksInitialized(root)); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('beadsLooksInitialized true when metadata.json present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'heal-real-'));
  fs.mkdirSync(path.join(root, '.beads'), { recursive: true });
  fs.writeFileSync(path.join(root, '.beads', 'metadata.json'), '{}');
  try { assert.ok(beadsLooksInitialized(root)); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// ── runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL: ${name}\n  ${err.message}`); failed++; }
}
console.log(`beads-server-heal: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
