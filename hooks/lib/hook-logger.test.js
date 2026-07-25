#!/usr/bin/env node
// hook-logger.test.js — cp-ccsh.10 / B10. Prerequisite for B9: 90 swallowed
// catch blocks are about to depend on this module, so its contract needs locking
// first — especially "never throws" and "never writes to stdout", since either
// would turn a best-effort log line into a hook failure or corrupt protocol
// output.
//
// Pure Node, no deps, cross-platform. Exit 0 = pass, 1 = fail.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
function eq(name, got, want) {
  if (got === want) pass++;
  else { fail++; fails.push(`${name}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); }
}
function ok(name, cond) {
  if (cond) pass++; else { fail++; fails.push(name); }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hooklog-'));
try {
  const LOG = path.join(sandbox, 'braynee-hooks.log');
  process.env.BRAYNEE_HOOK_LOG = LOG;
  const log = require('./hook-logger.js');

  // ── the override is honored, and resolved per call (not at module load) ─────
  eq('logFile() honors $BRAYNEE_HOOK_LOG', log.logFile(), LOG);
  {
    const other = path.join(sandbox, 'switched.log');
    process.env.BRAYNEE_HOOK_LOG = other;
    eq('logFile() re-reads the env var per call', log.logFile(), other);
    process.env.BRAYNEE_HOOK_LOG = LOG;
  }

  // ── every level writes a parseable line ────────────────────────────────────
  log.debug('my-hook', 'a swallowed failure');
  log.info('my-hook', 'something happened');
  log.warn('my-hook', 'a warning');
  log.error('my-hook', 'a crash');

  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  eq('one line written per call', lines.length, 4);

  const LINE_RE = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) (DEBUG|INFO |WARN |ERROR) \[([^\]]+)\] (.*)$/;
  ok('every line matches the timestamp/level/hook/message shape',
     lines.every(l => LINE_RE.test(l)));
  ok('the hook name is recorded', lines.every(l => LINE_RE.exec(l)[3] === 'my-hook'));
  ok('levels appear in call order',
     lines.map(l => LINE_RE.exec(l)[2].trim()).join(',') === 'DEBUG,INFO,WARN,ERROR');
  ok('the message survives verbatim', lines[0].endsWith('a swallowed failure'));
  ok('timestamps are ISO-8601 and parseable',
     lines.every(l => !Number.isNaN(Date.parse(LINE_RE.exec(l)[1]))));

  // B9 depends on this level existing.
  eq('debug is exported as a function', typeof log.debug, 'function');
  ok('DEBUG is distinguishable from INFO in the log', /\bDEBUG\b/.test(lines[0]));

  // ── appends, never truncates ────────────────────────────────────────────────
  log.info('other-hook', 'later line');
  const after = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  eq('a later call appends rather than truncating', after.length, 5);
  ok('earlier lines are still present', after[0].endsWith('a swallowed failure'));

  // ── creates a missing directory rather than losing the line ────────────────
  {
    const nested = path.join(sandbox, 'does', 'not', 'exist', 'hooks.log');
    process.env.BRAYNEE_HOOK_LOG = nested;
    log.warn('mkdir-hook', 'into a missing directory');
    ok('writes into a not-yet-existing directory', fs.existsSync(nested));
    ok('the line landed in the new file',
       /into a missing directory/.test(fs.readFileSync(nested, 'utf8')));
    process.env.BRAYNEE_HOOK_LOG = LOG;
  }

  // ── rotation at MAX_SIZE ───────────────────────────────────────────────────
  {
    const rot = path.join(sandbox, 'rotate.log');
    process.env.BRAYNEE_HOOK_LOG = rot;
    fs.writeFileSync(rot, 'x'.repeat(log.MAX_SIZE + 10), 'utf8');
    log.info('rot-hook', 'after the cap');
    ok('oversized log is rotated to .old', fs.existsSync(rot + '.old'));
    const fresh = fs.readFileSync(rot, 'utf8');
    ok('the new log starts fresh with just the new line',
       fresh.split('\n').filter(Boolean).length === 1 && /after the cap/.test(fresh));
    ok('the rotated file kept the old content',
       fs.statSync(rot + '.old').size > log.MAX_SIZE);
    process.env.BRAYNEE_HOOK_LOG = LOG;
  }

  // ── contract for 90 upcoming call sites: never throws, never touches stdout ─
  // Run in a child so an unwritable path and a real process's stdout are
  // observed, not simulated.
  {
    const script = `
      process.env.BRAYNEE_HOOK_LOG = ${JSON.stringify(path.join(sandbox, 'child.log'))};
      const log = require(${JSON.stringify(path.join(__dirname, 'hook-logger.js').replace(/\\/g, '/'))});
      log.debug('c', 'one'); log.info('c', 'two'); log.warn('c', 'three'); log.error('c', 'four');
      // hostile inputs — a swallowed error message can be anything
      log.debug(undefined, undefined);
      log.info('c', { toString() { throw new Error('boom'); } });
      log.error('c', 'multi\\nline\\nmessage');
      log.debug('c', new Error('a real error object'));
      log.warn('c', Object.create(null));
      process.stdout.write('SENTINEL');
    `;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true });
    eq('logging never throws, even on hostile input (child exit 0)', r.status, 0);
    eq('nothing is written to stdout beyond the test sentinel', r.stdout, 'SENTINEL');

    // One record per line — a multi-line message must not fake extra records.
    const childLines = fs.readFileSync(path.join(sandbox, 'child.log'), 'utf8')
      .split('\n').filter(Boolean);
    eq('a multi-line message stays on one line', childLines.length, 9);
    ok('newlines in a message are flattened',
       childLines.some(l => /multi line message$/.test(l)));
    ok('an Error value logs its message, not [object Object]',
       childLines.some(l => /a real error object$/.test(l)));
  }

  // ── unwritable path falls back to stderr instead of throwing ───────────────
  {
    // A path whose PARENT is an existing FILE can never be created.
    const blocker = path.join(sandbox, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const script = `
      process.env.BRAYNEE_HOOK_LOG = ${JSON.stringify(path.join(blocker, 'nope.log'))};
      const log = require(${JSON.stringify(path.join(__dirname, 'hook-logger.js').replace(/\\/g, '/'))});
      log.error('fallback-hook', 'could not open the log');
    `;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true });
    eq('an unwritable log path still exits 0', r.status, 0);
    ok('the line falls back to stderr', /could not open the log/.test(r.stderr));
    eq('the fallback writes nothing to stdout', r.stdout, '');
  }
} finally {
  delete process.env.BRAYNEE_HOOK_LOG;
  fs.rmSync(sandbox, { recursive: true, force: true });
}

if (fail === 0) {
  console.log(`hook-logger.test.js: ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`hook-logger.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
