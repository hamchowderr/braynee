#!/usr/bin/env node
// no-debug-noise.test.js — cp-yg1o.
//
// The sweep instrumented 38 best-effort catches. Each one is a bet that the
// catch fires only on real failure. If that bet is wrong for even one site,
// the log fills with DEBUG lines on every healthy session and the channel
// becomes useless — which is precisely the failure mode B9's own acceptance
// criterion forbids, and it cannot be caught by reading the diff.
//
// So: run the instrumented hooks against a REAL scaffolded project with healthy
// input, and assert the log stays empty. This is a behavior test, not a source
// scan — hooks/lib/best-effort-logging.test.js already covers the source shape.
//
// Pure Node, no deps, cross-platform. Exit 0 = pass, 1 = fail.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : '')); }
};

const HOOKS = path.join(__dirname, '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'yg1o-'));

try {
  // A realistic, healthy project: git repo + .beads + a vault-ish tree, so the
  // hooks take their normal paths instead of bailing at the first guard.
  const proj = path.join(sandbox, 'demo-project');
  fs.mkdirSync(path.join(proj, '.beads'), { recursive: true });
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  fs.writeFileSync(path.join(proj, '.beads', 'issues.jsonl'), '');
  fs.writeFileSync(path.join(proj, '.beads', 'config.yaml'), 'export:\n    auto: true\n');
  fs.writeFileSync(path.join(proj, 'package.json'), '{"name":"demo-project"}');
  spawnSync('git', ['init', '-q'], { cwd: proj, windowsHide: true });

  const HOME = path.join(sandbox, 'home');
  fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });

  // Healthy payloads, per hook event shape.
  const bash = (command) => ({
    cwd: proj, session_id: 'yg1o-session', tool_name: 'Bash',
    tool_input: { command },
    tool_response: { stdout: '', output: '' },
  });
  const CASES = [
    ['beads-todo-reminder.js', bash('bd create --title="a healthy issue"')],
    ['beads-todo-reminder.js', bash('ls -la')],
    ['beads-status-sync.js', bash('git status')],
    ['beads-dashboard-refresh.js', bash('bd ready')],
    ['check-no-main-push.js', bash('git push origin feature/x')],
    ['check-no-main-push.js', bash('echo hello')],
    ['commit-cadence-nudge.js', bash('git status')],
    ['beads-nudge.js', { cwd: proj, session_id: 'yg1o-session' }],
    ['braynee-heartbeat.js', { cwd: proj, session_id: 'yg1o-session' }],
    ['statusline-state.js', { cwd: proj, session_id: 'yg1o-session' }],
    ['session-note-nudge.js', { cwd: proj, session_id: 'yg1o-session', tool_name: 'Read' }],
    ['task-created-check.js', { cwd: proj, session_id: 'yg1o-session', task_title: 'a healthy task' }],
    ['task-completed-check.js', { cwd: proj, session_id: 'yg1o-session', task_id: 't1', task_title: 'a healthy task' }],
    ['stop-task-verify.js', { cwd: proj, session_id: 'yg1o-session' }],
    ['beads-work-surface.js', { cwd: proj, session_id: 'yg1o-session' }],
    ['post-compact.js', { cwd: proj, session_id: 'yg1o-session' }],
    ['pre-compact-snapshot.js', { cwd: proj, session_id: 'yg1o-session' }],
    ['reinject-after-compact.js', { cwd: proj, session_id: 'yg1o-session' }],
  ];

  const LOG = path.join(sandbox, 'noise.log');
  for (const [hook, payload] of CASES) {
    const file = path.join(HOOKS, hook);
    if (!fs.existsSync(file)) { ok(`${hook} exists`, false); continue; }
    const r = spawnSync(process.execPath, [file], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      cwd: proj,
      env: {
        ...process.env,
        BRAYNEE_HOOK_LOG: LOG,
        HOME,
        USERPROFILE: HOME,
        // Keep the run hermetic: no dashboard spawn, no real vault.
        BRAYNEE_NO_DASHBOARD: '1',
      },
    });
    // A non-zero exit is fine (2 = an intentional block); a CRASH is not.
    ok(`${hook} did not crash on healthy input`, r.status !== null,
       r.signal ? `killed by ${r.signal}` : '');
  }

  const logged = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
  const debugLines = logged.split(/\r?\n/).filter((l) => / DEBUG /.test(l));

  ok(`a healthy run of 18 instrumented hooks logs no DEBUG lines (${debugLines.length} found)`,
     debugLines.length === 0,
     debugLines.slice(0, 6).join(' | '));

  // The inverse: the channel must still WORK. A hook pointed at an unwritable
  // state path has to leave a trace, or the assertion above passes vacuously
  // because nothing was ever capable of logging.
  {
    const LOG2 = path.join(sandbox, 'broken.log');
    const badHome = path.join(sandbox, 'badhome');
    fs.mkdirSync(badHome, { recursive: true });
    // .claude is a FILE, so every ~/.claude/<state>.json write throws.
    fs.writeFileSync(path.join(badHome, '.claude'), 'not a directory');
    const r = spawnSync(process.execPath, [path.join(HOOKS, 'braynee-heartbeat.js')], {
      input: JSON.stringify({ cwd: proj, session_id: 'yg1o-session' }),
      encoding: 'utf8', timeout: 30000, windowsHide: true, cwd: proj,
      env: { ...process.env, BRAYNEE_HOOK_LOG: LOG2, HOME: badHome, USERPROFILE: badHome },
    });
    ok('a hook with an unwritable state dir still exits cleanly', r.status === 0);
    const broken = fs.existsSync(LOG2) ? fs.readFileSync(LOG2, 'utf8') : '';
    ok('...and leaves a DEBUG trace, so the no-noise assertion is not vacuous',
       /DEBUG/.test(broken) && /heartbeat/i.test(broken), broken.slice(0, 200));
  }
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

if (fail === 0) {
  console.log(`no-debug-noise.test.js: ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`no-debug-noise.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
