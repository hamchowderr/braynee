#!/usr/bin/env node
'use strict';

// check-beads-init.test.js — the create-time guard a fresh `bd init` gets.
// validationGuardValue decides whether bd is called at all, so a misread would
// either overwrite a repo's chosen value or leave the guard off.

const assert = require('assert');
const { validationGuardValue, GUARD_VALUE } = require('./check-beads-init.js');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('the default a fresh repo gets is error (block), not warn', () => {
  assert.strictEqual(GUARD_VALUE, 'error');
});

test('reads the flat quoted form bd 1.3.0 writes', () => {
  assert.strictEqual(validationGuardValue('# comment\nvalidation.on-create: "error"\n'), 'error');
  assert.strictEqual(validationGuardValue("validation.on-create: 'warn'\n"), 'warn');
  assert.strictEqual(validationGuardValue('validation.on-create: warn\n'), 'warn');
});

test('reads the nested block form', () => {
  assert.strictEqual(validationGuardValue('validation:\n    on-create: error\n'), 'error');
});

test('absent, commented-out or empty config reads as none', () => {
  assert.strictEqual(validationGuardValue(''), 'none');
  assert.strictEqual(validationGuardValue(null), 'none');
  assert.strictEqual(validationGuardValue('# validation.on-create: error\nexport:\n    auto: true\n'), 'none');
});

test('a value bd does not honour is reported as-is (so the caller treats it as off)', () => {
  // bd 1.3.0 accepts any string on `config set` but only acts on warn / error.
  assert.strictEqual(validationGuardValue('validation.on-create: "strict"\n'), 'strict');
});

// ── runner ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try { fn(); passed++; }
  catch (err) { console.error(`FAIL: ${name}\n  ${err.message}`); failed++; }
}
console.log(`check-beads-init: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
