#!/usr/bin/env node
// ignore-folders.test.js — verifies the auto-create ignore-list (cp-qp3).
//
// Pure Node, no deps, cross-platform. Exit 0 = all pass, 1 = a failure.
// Run directly (`node ignore-folders.test.js`) or via braynee-self-test.

'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const {
  DEFAULT_IGNORE_FOLDERS,
  configPath,
  loadIgnoreFolders,
  isIgnoredFolder,
} = require('./ignore-folders.js');

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

// Empty env so the test machine's real BRAYNEE_IGNORE_FOLDERS can't leak in,
// and a homeDir with no config file so the user's real override is ignored.
const EMPTY_ENV = {};
const NO_CONFIG_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'qp3-nohome-'));

// ── Defaults ─────────────────────────────────────────────────────────────────
eq('generic "code" is ignored', isIgnoredFolder('code', EMPTY_ENV, NO_CONFIG_HOME), true);
eq('generic "web" is ignored', isIgnoredFolder('web', EMPTY_ENV, NO_CONFIG_HOME), true);
eq('generic "scripts" is ignored', isIgnoredFolder('scripts', EMPTY_ENV, NO_CONFIG_HOME), true);
eq('match is case-insensitive (CODE)', isIgnoredFolder('CODE', EMPTY_ENV, NO_CONFIG_HOME), true);
eq('surrounding whitespace trimmed', isIgnoredFolder('  web  ', EMPTY_ENV, NO_CONFIG_HOME), true);

eq('real project "foreman" is NOT ignored', isIgnoredFolder('foreman', EMPTY_ENV, NO_CONFIG_HOME), false);
eq('real project "myrp-build-web" is NOT ignored', isIgnoredFolder('myrp-build-web', EMPTY_ENV, NO_CONFIG_HOME), false);

// Monorepo package/subdir names are now DEFAULT-ignored (cp-zpa) — they recurred
// as junk project stubs (e.g. a session from `foreman/packages/agents` stamped
// out an "Agents" project; a `server/` dir stamped out "Server").
eq('"agents" is now a default-ignored monorepo name', isIgnoredFolder('agents', EMPTY_ENV, NO_CONFIG_HOME), true);
eq('"app" is now a default-ignored monorepo name', isIgnoredFolder('app', EMPTY_ENV, NO_CONFIG_HOME), true);
eq('"api" is now a default-ignored monorepo name', isIgnoredFolder('api', EMPTY_ENV, NO_CONFIG_HOME), true);
eq('"packages" is now a default-ignored monorepo name', isIgnoredFolder('packages', EMPTY_ENV, NO_CONFIG_HOME), true);
eq('"server" is now a default-ignored monorepo name', isIgnoredFolder('server', EMPTY_ENV, NO_CONFIG_HOME), true);
eq('"core" is now a default-ignored monorepo name', isIgnoredFolder('core', EMPTY_ENV, NO_CONFIG_HOME), true);
eq('"client" is now a default-ignored monorepo name', isIgnoredFolder('client', EMPTY_ENV, NO_CONFIG_HOME), true);
// Exact-basename match only — a real product whose name merely CONTAINS a
// monorepo word is still tracked (no substring false-positives).
eq('"api-gateway" (real product) is NOT ignored', isIgnoredFolder('api-gateway', EMPTY_ENV, NO_CONFIG_HOME), false);
eq('"core-banking" (real product) is NOT ignored', isIgnoredFolder('core-banking', EMPTY_ENV, NO_CONFIG_HOME), false);

eq('empty string is not ignored', isIgnoredFolder('', EMPTY_ENV, NO_CONFIG_HOME), false);
eq('null is not ignored', isIgnoredFolder(null, EMPTY_ENV, NO_CONFIG_HOME), false);
ok('DEFAULT_IGNORE_FOLDERS is a non-empty array', Array.isArray(DEFAULT_IGNORE_FOLDERS) && DEFAULT_IGNORE_FOLDERS.length > 0);

// ── Env override ─────────────────────────────────────────────────────────────
const ENV_EXTRA = { BRAYNEE_IGNORE_FOLDERS: 'claude-plugins, Frontend ,' };
eq('env adds "claude-plugins"', isIgnoredFolder('claude-plugins', ENV_EXTRA, NO_CONFIG_HOME), true);
eq('env extra is case-insensitive ("frontend")', isIgnoredFolder('frontend', ENV_EXTRA, NO_CONFIG_HOME), true);
eq('env extras do not drop defaults', isIgnoredFolder('code', ENV_EXTRA, NO_CONFIG_HOME), true);
eq('empty env token ignored, unrelated name still false', isIgnoredFolder('sophon', ENV_EXTRA, NO_CONFIG_HOME), false);

// ── Config-file override ─────────────────────────────────────────────────────
const cfgHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qp3-home-'));
try {
  fs.mkdirSync(path.join(cfgHome, '.claude'), { recursive: true });
  fs.writeFileSync(configPath(cfgHome), JSON.stringify(['my-monorepo', 'PLAYGROUND']), 'utf8');

  eq('config file adds "my-monorepo"', isIgnoredFolder('my-monorepo', EMPTY_ENV, cfgHome), true);
  eq('config entry is case-insensitive ("playground")', isIgnoredFolder('playground', EMPTY_ENV, cfgHome), true);
  eq('config override keeps defaults', isIgnoredFolder('code', EMPTY_ENV, cfgHome), true);
  eq('config + env merge (env-added "frontend")', isIgnoredFolder('frontend', ENV_EXTRA, cfgHome), true);

  // Malformed config must not throw and must fall back to defaults.
  fs.writeFileSync(configPath(cfgHome), '{ this is not json', 'utf8');
  let threw = false;
  let stillDefault = false;
  try {
    stillDefault = isIgnoredFolder('code', EMPTY_ENV, cfgHome) === true;
  } catch {
    threw = true;
  }
  ok('malformed config does not throw', !threw);
  ok('malformed config falls back to defaults', stillDefault);
} finally {
  fs.rmSync(cfgHome, { recursive: true, force: true });
  fs.rmSync(NO_CONFIG_HOME, { recursive: true, force: true });
}

// ── Report ───────────────────────────────────────────────────────────────────
if (fail === 0) {
  console.log(`ignore-folders.test.js: ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`ignore-folders.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
