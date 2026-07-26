#!/usr/bin/env node
// best-effort-logging.test.js — cp-ccsh.11 / B9.
//
// braynee's hooks are written never to throw, which is correct. But the
// best-effort catches discarded the error entirely, so a hook that silently
// stopped working was invisible until someone measured its output. The systemic
// example the audit named: resyncAllMemoryNotes ended in
// `catch { /* best-effort */ }`, so a regeneration that produced an OVERSIZED
// MEMORY.md reported nothing (that is how cp-ccsh.2 / B1 shipped).
//
// This locks B9's two acceptance criteria as behavior, not as a diff:
//   1. a deliberately broken operation leaves a diagnosable trace
//   2. no new user-visible output in the normal path (nothing on stdout/stderr)
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

const HOOKS = path.join(__dirname, '..');
const q = (p) => JSON.stringify(String(p).replace(/\\/g, '/'));

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'b9-'));
try {
  // ── 1. a deliberately broken operation leaves a trace ──────────────────────
  // Break resyncAllMemoryNotes by making its target unwritable: point the memory
  // dir at a path whose MEMORY.md is a DIRECTORY, so writeFileSync throws.
  {
    const LOG = path.join(sandbox, 'broken.log');
    const memDir = path.join(sandbox, 'memdir');
    fs.mkdirSync(path.join(memDir, 'MEMORY.md'), { recursive: true }); // a dir, not a file
    fs.writeFileSync(path.join(memDir, 'user_a.md'),
      '---\nname: user_a\ndescription: d\ntype: user\n---\n\nbody\n');

    const script = `
      process.env.BRAYNEE_HOOK_LOG = ${q(LOG)};
      const M = require(${q(path.join(HOOKS, 'lib', 'memory-index.js'))});
      const s = M.resyncAllMemoryNotes({ autoMemoryDirectory: ${q(memDir)} });
      process.stdout.write(JSON.stringify(s));
    `;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true });

    eq('a broken resync still exits 0 (never throws)', r.status, 0);
    ok('a broken resync still returns its summary', /"scanned"/.test(r.stdout));
    ok('the log file was created', fs.existsSync(LOG));
    const logged = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
    ok('the failure left a DEBUG trace', /DEBUG/.test(logged));
    ok('the trace names the module', /\[memory-index\]/.test(logged));
    ok('the trace names the failing operation', /resyncAllMemoryNotes failed/.test(logged));
    ok('the trace carries the underlying error text', logged.trim().length > 60);
    eq('nothing extra reached stderr', r.stderr, '');
  }

  // ── 2. the B1 archetype: an oversized regeneration now reports itself ──────
  // This is the specific silence that let B1 ship. A resync that produces a file
  // over the startup-load cap must leave a trace even though it "succeeded".
  {
    const LOG = path.join(sandbox, 'oversize.log');
    const memDir = path.join(sandbox, 'oversize');
    fs.mkdirSync(memDir, { recursive: true });
    // Enough notes with long names that the regenerated index blows the ~25KB cap.
    // The 100-char name is deliberate: with a 24-char filename the prefix reaches
    // 133, past the point where the line budget can be honored, so this fixture
    // also exercises the prefix-dominated (B1a) reporting path. At 90 chars the
    // lines land on exactly 150 and are NOT over-long.
    for (let i = 0; i < 300; i++) {
      const nm = `feedback-a-deliberately-long-memory-note-name-${String(i).padStart(3, '0')}-`.padEnd(100, 'z');
      fs.writeFileSync(path.join(memDir, `feedback_oversize_${String(i).padStart(3, '0')}.md`),
        `---\nname: ${nm}\ndescription: ${'D'.repeat(200)}\ntype: feedback\n---\n\nbody\n`);
    }
    const script = `
      process.env.BRAYNEE_HOOK_LOG = ${q(LOG)};
      const M = require(${q(path.join(HOOKS, 'lib', 'memory-index.js'))});
      M.resyncAllMemoryNotes({ autoMemoryDirectory: ${q(memDir)} });
      process.stdout.write('done');
    `;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true });
    eq('the oversize resync itself succeeds', r.stdout, 'done');
    const logged = fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8') : '';
    ok('an over-cap regeneration is recorded', /over the ~24985 startup-load cap/.test(logged));
    ok('the record includes the actual byte count', /is \d{5,} bytes/.test(logged));
    ok('over-long index lines are reported too', /exceed MAX_LINE_LEN/.test(logged));
  }

  // ── 3. no new user-visible output in the NORMAL path ──────────────────────
  // A healthy resync must write nothing to stdout/stderr and leave no DEBUG line.
  {
    const LOG = path.join(sandbox, 'healthy.log');
    const memDir = path.join(sandbox, 'healthy');
    fs.mkdirSync(memDir, { recursive: true });
    fs.writeFileSync(path.join(memDir, 'user_a.md'),
      '---\nname: user_a\ndescription: who the user is\ntype: user\n---\n\nbody\n');
    fs.writeFileSync(path.join(memDir, 'feedback_b.md'),
      '---\nname: feedback_b\ndescription: a short note\ntype: feedback\n---\n\nbody\n');

    const script = `
      process.env.BRAYNEE_HOOK_LOG = ${q(LOG)};
      const M = require(${q(path.join(HOOKS, 'lib', 'memory-index.js'))});
      M.resyncAllMemoryNotes({ autoMemoryDirectory: ${q(memDir)} });
      M.resyncAllMemoryNotes({ autoMemoryDirectory: ${q(memDir)} }); // idempotent second run
      process.stdout.write('OK');
    `;
    const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', windowsHide: true });
    eq('a healthy resync writes nothing to stdout beyond the sentinel', r.stdout, 'OK');
    eq('a healthy resync writes nothing to stderr', r.stderr, '');
    ok('a healthy resync leaves no DEBUG noise in the log',
       !fs.existsSync(LOG) || !/DEBUG/.test(fs.readFileSync(LOG, 'utf8')));
    ok('the index was still written correctly',
       /- \[user_a\]\(user_a\.md\) — who the user is/.test(
         fs.readFileSync(path.join(memDir, 'MEMORY.md'), 'utf8')));
  }

  // ── 4. instrumented modules must keep their logging channel ────────────────
  // Guards the regression where a refactor drops the require and quietly returns
  // these files to bare `catch {}`.
  {
    const instrumented = [
      ['lib/memory-index.js', /log\.debug\(/],
      ['lib/session-close.js', /log\.debug\(/],
      ['lib/qmd-reindex.js', /log\.debug\(/],
      ['lib/is-code-context.js', /\.debug\('is-code-context'/],
      ['context-budget-warn.js', /log\.debug\(/],
      ['stop-task-verify.js', /log\.debug\(/],
      ['statusline.js', /\.debug\('statusline'/],
      // cp-yg1o — the remainder of the B9 sweep.
      ['beads-work-surface.js', /log\.debug\(/],
      ['beads-status-sync.js', /log\.debug\(/],
      ['beads-dashboard-refresh.js', /log\.debug\(/],
      ['beads-nudge.js', /log\.debug\(/],
      ['beads-todo-reminder.js', /log\.debug\(/],
      ['braynee-heartbeat.js', /log\.debug\(/],
      ['check-no-main-push.js', /log\.debug\(/],
      ['commit-cadence-nudge.js', /log\.debug\(/],
      ['ensure-dashboard.js', /log\.debug\(/],
      ['post-compact.js', /log\.debug\(/],
      ['pre-compact-snapshot.js', /log\.debug\(/],
      ['reinject-after-compact.js', /\.debug\('reinject-after-compact'/],
      ['session-auto-close.js', /log\.debug\(/],
      ['session-auto-track.js', /log\.debug\(/],
      ['session-note-nudge.js', /log\.debug\(/],
      ['statusline-resync.js', /\.debug\('statusline-resync'/],
      ['statusline-state.js', /log\.debug\(/],
      ['task-completed-check.js', /log\.debug\(/],
      ['task-created-check.js', /log\.debug\(/],
      ['lib/dolt-guard.js', /\.debug\('dolt-guard'/],
      ['lib/ignore-folders.js', /\.debug\('ignore-folders'/],
      ['lib/session-report-state.js', /log\.debug\(/],
      ['lib/tasknotes-mirror.js', /log\.debug\(/],
    ];
    for (const [rel, re] of instrumented) {
      const src = fs.readFileSync(path.join(HOOKS, rel), 'utf8');
      ok(`${rel} routes a best-effort failure to hook-logger`, re.test(src));
      ok(`${rel} requires hook-logger`, /hook-logger/.test(src));
    }
  }

  // ── 6. every remaining bare catch must say WHY it stays bare ──────────────
  // cp-yg1o's acceptance criterion. The sweep deliberately leaves ~74 catches
  // uninstrumented (control flow, existence probes, cleanup, and the
  // logging-the-logger guard) — logging those would fire on every healthy run
  // and bury the signal. An UNCOMMENTED bare catch is the ambiguous case: it
  // reads identically whether it was classified or simply missed.
  {
    const walk = (dir, out = []) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else if (e.name.endsWith('.js') && !e.name.endsWith('.test.js')) out.push(p);
      }
      return out;
    };
    const BARE = /catch\s*(\([^)]*\))?\s*\{(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*\}/g;
    const undocumented = [];
    for (const file of walk(HOOKS)) {
      const src = fs.readFileSync(file, 'utf8');
      const lines = src.split(/\r?\n/);
      let m;
      BARE.lastIndex = 0;
      while ((m = BARE.exec(src))) {
        if (/\/[/*]/.test(m[0])) continue;                       // comment inside the braces
        const ln = src.slice(0, m.index).split(/\r?\n/).length;
        if (/\/\/|\*/.test((lines[ln - 2] || '') + (lines[ln - 3] || ''))) continue; // comment just above
        undocumented.push(`${path.relative(HOOKS, file)}:${ln}`);
      }
    }
    ok(`every bare catch records why it stays bare (${undocumented.length} undocumented: ${undocumented.slice(0, 5).join(', ')})`,
       undocumented.length === 0);
  }

  // ── 5. instrumentation must not write to stdout ───────────────────────────
  // Any hook-logger call on a hook's stdout would corrupt the hook protocol.
  {
    const src = fs.readFileSync(path.join(HOOKS, 'lib', 'hook-logger.js'), 'utf8');
    ok('hook-logger never writes to stdout', !/process\.stdout/.test(src));
    ok('hook-logger uses stderr only as a last resort',
       (src.match(/process\.stderr/g) || []).length === 1);
  }
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

if (fail === 0) {
  console.log(`best-effort-logging.test.js: ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`best-effort-logging.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
