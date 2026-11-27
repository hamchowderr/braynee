#!/usr/bin/env node
// beads-commit-actor.test.js (cp-uif3.5)
//
// The pure `decide` cases pin when the hook writes. The hook cases spawn the
// real hook against a real env file. The last case is the one that matters:
// with bd's own git hooks installed, a commit made with the env file sourced
// carries `Executed-By: claude`, and one made without it does not. It is
// skipped (not failed) where bd or a POSIX shell is missing.
//
// Pure Node, no deps. Exit 0 = pass, 1 = fail.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decide, LINE } = require('./beads-commit-actor.js');

const HOOK = path.join(__dirname, 'beads-commit-actor.js');
let pass = 0, fail = 0;
const fails = [];
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; fails.push(`${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`); }
}

// ── decide ──────────────────────────────────────────────────────────────────
eq('no env file -> skip', decide({}, ''), 'skip:no-env-file');
eq('fresh env file -> write', decide({ CLAUDE_ENV_FILE: '/x' }, ''), 'write');
eq('user BD_ACTOR wins', decide({ CLAUDE_ENV_FILE: '/x', BD_ACTOR: 'me' }, ''), 'skip:actor-already-set');
eq('user BEADS_ACTOR wins', decide({ CLAUDE_ENV_FILE: '/x', BEADS_ACTOR: 'me' }, ''), 'skip:actor-already-set');
eq('already written -> skip', decide({ CLAUDE_ENV_FILE: '/x' }, `export FOO=1\n${LINE}\n`), 'skip:already-written');
eq('other vars only -> write', decide({ CLAUDE_ENV_FILE: '/x' }, 'export FOO=1\n'), 'write');

// ── the real hook ───────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'braynee-commit-actor-'));
const envFile = path.join(tmp, 'env.sh');
function runHook(extraEnv) {
  const env = { ...process.env, CLAUDE_ENV_FILE: envFile, BRAYNEE_HOOK_LOG: path.join(tmp, 'hooks.log'), ...extraEnv };
  delete env.BD_ACTOR; delete env.BEADS_ACTOR; delete env.MASTRA_HOOK_EVENT;
  Object.assign(env, extraEnv);
  for (const k of Object.keys(extraEnv)) if (extraEnv[k] === undefined) delete env[k];
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: 't', hook_event_name: 'SessionStart', source: 'startup', cwd: tmp }),
    encoding: 'utf8', env, timeout: 15000,
  });
}

fs.writeFileSync(envFile, 'export FOO=1');
let r = runHook({});
eq('hook exits 0', r.status, 0);
eq('hook prints nothing', r.stdout, '');
eq('appends the line after existing content', fs.readFileSync(envFile, 'utf8'), `export FOO=1\n${LINE}\n`);
runHook({});
eq('second run (resume/compact) does not duplicate', fs.readFileSync(envFile, 'utf8'), `export FOO=1\n${LINE}\n`);

fs.writeFileSync(envFile, '');
runHook({ BEADS_ACTOR: 'owner' });
eq('a user-set actor is left alone', fs.readFileSync(envFile, 'utf8'), '');

fs.writeFileSync(envFile, '');
runHook({ MASTRA_HOOK_EVENT: 'SessionStart' });
eq('non-Claude-Code host writes nothing', fs.readFileSync(envFile, 'utf8'), '');

// ── end to end: bd's prepare-commit-msg + the env file ──────────────────────
const haveBd = spawnSync('bd', ['version'], { encoding: 'utf8' }).status === 0;
const haveSh = process.platform !== 'win32' && spawnSync('sh', ['-c', 'true']).status === 0;
if (!haveBd || !haveSh) {
  console.log('  (skipped end-to-end commit case: needs bd and sh)');
} else {
  const repo = path.join(tmp, 'repo');
  fs.mkdirSync(repo);
  const sh = (cmd, env = {}) => spawnSync('sh', ['-c', cmd], {
    cwd: repo, encoding: 'utf8', timeout: 60000,
    env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'BD_ACTOR' && k !== 'BEADS_ACTOR')), ...env },
  });
  const init = sh('git init -q && git config user.email t@t && git config user.name t && bd init --prefix tt -q >/dev/null 2>&1; bd hooks install >/dev/null 2>&1; git config core.hooksPath');
  if (!init.stdout.trim()) {
    console.log('  (skipped end-to-end commit case: bd hooks did not install)');
  } else {
    fs.writeFileSync(envFile, '');
    runHook({});
    sh('echo a > a && git add a && git commit -qm "feat: without env file"');
    eq('commit without the env file has no trailer', /Executed-By:/.test(sh('git log -1 --format=%B').stdout), false);
    sh(`. "${envFile}" && echo b > a && git commit -qam "feat: with env file"`);
    eq('commit with the env file carries Executed-By: claude', /^Executed-By: claude$/m.test(sh('git log -1 --format=%B').stdout), true);
  }
}

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
if (fail) { console.error(fails.join('\n')); console.error(`beads-commit-actor.test: ${pass} passed, ${fail} failed`); process.exit(1); }
console.log(`beads-commit-actor.test: ${pass} passed`);
