#!/usr/bin/env node
// session-folder.test.js — cp-g3xp. Session hooks wrote a project's notes to a
// dashed slug of its name (`Sessions/Acme-OS/`) while the vault keeps them under
// the name itself (`Sessions/Acme OS/`), splitting one history across two
// folders so recap/context saw half of it.
//
// For a space name, dotted names and an all-caps name, this covers:
//   1. the name → folder mapping (lib/session-folder.js)
//   2. resolution order over folders on disk, legacy dashed folder included
//   3. the real WRITE path: session-auto-track.js and vault-query.mjs run as
//      processes against a fixture vault — the folder they create is the name
//   4. the real RESOLVE path: session-auto-track.js resumes, and
//      lib/session-close.js closes, the note in a legacy dashed folder rather
//      than a newer note for the same project elsewhere
//   5. no Sessions consumer keeps its own dashed derivation
//   6. a folder whose on-disk casing differs from the project name is read
//      once per note, not once per spelling
//
// Every process runs with $BRAYNEE_VAULT at a fixture vault and $HOME /
// $USERPROFILE at a fixture home, so no real vault, hook log or statusline state
// is touched. npm's global prefix points at an empty dir, so the qmd lookup
// session-auto-track makes finds no qmd instead of this machine's real index.
//
// Pure Node, no deps, cross-platform. Exit 0 = pass, 1 = fail.

'use strict';

const { spawn } = require('child_process');
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
const ROOT = path.join(HOOKS, '..');
const CLOSE = path.join(HOOKS, 'lib', 'session-close.js');
const {
  UNCATEGORIZED, sessionFolderName, legacySessionFolderName, existingSessionFolders,
} = require('./session-folder.js');

// Assembled from fragments: self-test section 13 fails any tracked file that
// spells an owner brand out, this one included.
const RP = 'my' + 'RP';
const CASES = [
  { label: 'space name', name: 'Savant OS', legacy: 'Savant-OS' },
  { label: 'dotted name', name: `${RP}.build`, legacy: `${RP}-build` },
  { label: 'dotted name with spaced dash', name: `${RP}.build - Website`, legacy: `${RP}-build-Website` },
  { label: 'all-caps name', name: 'Mastra CHAT KIT', legacy: 'Mastra-CHAT-KIT' },
];

// Every hook ends by scanning ALL of Sessions/, newest filename first, so a lone
// note in a legacy folder is found even with no legacy lookup at all. A decoy —
// an active note for the SAME project in an unrelated folder, whose filename
// sorts first — is what that scan would return. A resolve test passes only if
// the legacy folder is searched before the full scan. (A note for a different
// project could not do this: it never matches, whatever the search order.)
const LEGACY_FILE = 'legacy-note.md';
const DECOY_DIR = 'Unrelated Folder';
const DECOY_FILE = 'zz-decoy-note.md';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'sessfolder-'));
const HOME = path.join(sandbox, 'home');
fs.mkdirSync(path.join(HOME, '.claude'), { recursive: true });
const NPM_PREFIX = path.join(sandbox, 'npm-prefix');
fs.mkdirSync(NPM_PREFIX, { recursive: true });

let fixtureId = 0;
// A fixture vault whose one project note maps a fresh code dir to `name`.
function makeFixture(name) {
  const id = fixtureId++;
  const vault = path.join(sandbox, `vault-${id}`);
  const sessions = path.join(vault, '2. Areas', 'Sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.mkdirSync(path.join(vault, '1. Projects'), { recursive: true });
  const folder = `repo-${id}`;
  fs.writeFileSync(path.join(vault, '1. Projects', `project-${id}.md`),
    `---\nname: "${name}"\nfolder: "${folder}"\nstatus: active\n---\n\n# ${name}\n`);
  const code = path.join(sandbox, 'code', folder);
  fs.mkdirSync(code, { recursive: true });
  fs.writeFileSync(path.join(code, 'package.json'), '{}\n');
  return { vault, sessions, code };
}

// A session note for `name`, written as Sessions/<dirName>/<file>.
function writeNote(sessions, dirName, name, file = LEGACY_FILE, status = 'active') {
  const dir = path.join(sessions, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const fp = path.join(dir, file);
  fs.writeFileSync(fp,
    `---\ntype: session\nproject: "[[${name}]]"\nstatus: ${status}\n` +
    `started: ${new Date().toISOString()}\nended: null\n---\n\n` +
    `## Goal\nfixture goal\n\n## Progress\n- (session just started)\n`);
  return fp;
}

const read = (fp) => fs.readFileSync(fp, 'utf8');
const listDirs = (d) => fs.readdirSync(d, { withFileTypes: true })
  .filter(e => e.isDirectory()).map(e => e.name).sort();

function runNode(args, { vault, input = '', cwd, env = {} }) {
  return new Promise((resolve) => {
    const childEnv = {
      ...process.env,
      BRAYNEE_VAULT: vault,
      HOME,
      USERPROFILE: HOME,
      BRAYNEE_HOOK_LOG: path.join(sandbox, 'hooks.log'),
      npm_config_prefix: NPM_PREFIX,
    };
    // Windows spells it Path; drop every spelling before overriding it.
    if (env.PATH !== undefined) {
      for (const k of Object.keys(childEnv)) if (/^path$/i.test(k)) delete childEnv[k];
    }
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, env: { ...childEnv, ...env } });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    const timer = setTimeout(() => child.kill(), 25_000);
    child.on('close', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    child.stdin.end(input);
  });
}

function parseJson(s) {
  try { return JSON.parse(s); } catch { return {}; } // asserted on by the caller
}

(async () => {
  try {
    // ── 1. name → folder ────────────────────────────────────────────────────
    for (const c of CASES) {
      eq(`${c.label}: the folder is the project name verbatim`, sessionFolderName(c.name), c.name);
      eq(`${c.label}: the legacy slug is the old dashed form`, legacySessionFolderName(c.name), c.legacy);
    }
    eq('Windows-forbidden characters are stripped', sessionFolderName('A<b>c:d"e/f\\g|h?i*j'), 'Abcdefghij');
    eq('control characters are stripped', sessionFolderName('Tab\tName\x01\x1f'), 'TabName');
    eq('trailing dots and spaces are stripped', sessionFolderName('Acme Inc. . '), 'Acme Inc');
    eq('interior dots, dashes and spaces are kept', sessionFolderName('a.b - c'), 'a.b - c');
    eq('brand casing is kept', sessionFolderName('iOS n8n API'), 'iOS n8n API');
    for (const empty of ['', null, undefined, '...', '<>']) {
      eq(`${String(JSON.stringify(empty))} falls back to ${UNCATEGORIZED}`, sessionFolderName(empty), UNCATEGORIZED);
    }
    {
      const src = fs.readFileSync(path.join(__dirname, 'session-folder.js'));
      ok('lib/session-folder.js holds no raw control bytes (git would treat it as binary)',
        !src.some(b => b < 9 || (b >= 14 && b <= 31)));
    }

    // ── 2. resolution order over folders on disk ────────────────────────────
    {
      const S = path.join(sandbox, 'resolve-sessions');
      for (const c of CASES) {
        fs.mkdirSync(S, { recursive: true });
        const verbatim = path.join(S, c.name);
        const legacy = path.join(S, c.legacy);
        eq(`${c.label}: nothing on disk resolves to no folders`,
          JSON.stringify(existingSessionFolders(S, c.name)), '[]');
        fs.mkdirSync(legacy);
        eq(`${c.label}: a legacy-only vault resolves to the legacy folder`,
          JSON.stringify(existingSessionFolders(S, c.name)), JSON.stringify([legacy]));
        fs.mkdirSync(verbatim);
        eq(`${c.label}: the verbatim folder is searched before the legacy one`,
          JSON.stringify(existingSessionFolders(S, c.name)), JSON.stringify([verbatim, legacy]));
        fs.rmSync(legacy, { recursive: true, force: true });
        eq(`${c.label}: a verbatim-only vault resolves to the verbatim folder`,
          JSON.stringify(existingSessionFolders(S, c.name)), JSON.stringify([verbatim]));
        fs.rmSync(S, { recursive: true, force: true });
      }
      fs.mkdirSync(path.join(S, 'Braynee'), { recursive: true });
      eq('a name whose two forms coincide is listed once', existingSessionFolders(S, 'Braynee').length, 1);
      fs.writeFileSync(path.join(S, 'Plain File'), '');
      eq('a file carrying the folder name is not a search root', existingSessionFolders(S, 'Plain File').length, 0);
      eq('a missing Sessions folder resolves to no folders',
        existingSessionFolders(path.join(sandbox, 'no-such-sessions'), 'Braynee').length, 0);
    }

    // ── 3 + 4. session-auto-track: write path and legacy resume ─────────────
    const TRACK = path.join(HOOKS, 'session-auto-track.js');
    const writes = CASES.map(c => ({ c, fx: makeFixture(c.name) }));
    const resumes = CASES.map(c => {
      const fx = makeFixture(c.name);
      writeNote(fx.sessions, DECOY_DIR, c.name, DECOY_FILE);
      return { c, fx, note: writeNote(fx.sessions, c.legacy, c.name) };
    });
    const trackRuns = await Promise.all([...writes, ...resumes].map(({ fx }) =>
      runNode([TRACK], { vault: fx.vault, input: JSON.stringify({ cwd: fx.code, source: 'startup' }) })));

    writes.forEach(({ c, fx }, i) => {
      const r = trackRuns[i];
      eq(`${c.label}: session-auto-track exits 0`, r.status, 0);
      eq(`${c.label}: session-auto-track creates only the folder named after the project`,
        JSON.stringify(listDirs(fx.sessions)), JSON.stringify([c.name]));
      ok(`${c.label}: session-auto-track creates no dashed folder`,
        !fs.existsSync(path.join(fx.sessions, c.legacy)));
      const dir = path.join(fx.sessions, c.name);
      eq(`${c.label}: one session note is written there`,
        fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 1);
      ok(`${c.label}: the reported session path names that folder`,
        r.stdout.includes(`Session file: 2. Areas/Sessions/${c.name}/`));
    });

    resumes.forEach(({ c, fx }, i) => {
      const r = trackRuns[writes.length + i];
      eq(`${c.label}: session-auto-track exits 0 on a legacy vault`, r.status, 0);
      ok(`${c.label}: session-auto-track resumes the legacy-folder note, not the newer decoy`,
        r.stdout.includes(`RESUMING session: ${LEGACY_FILE}`) &&
        r.stdout.includes(`2. Areas/Sessions/${c.legacy}/${LEGACY_FILE}`));
      eq(`${c.label}: resuming creates no new folder`,
        JSON.stringify(listDirs(fx.sessions)), JSON.stringify([c.legacy, DECOY_DIR].sort()));
    });

    // ── 4. lib/session-close.js: legacy folder, and the folder just written ─
    const closeScript = (code) =>
      `const r = require(${JSON.stringify(CLOSE)}).closeActiveSession({ cwd: ${JSON.stringify(code)} });` +
      'process.stdout.write(JSON.stringify(r));';
    const legacyCloses = CASES.map(c => {
      const fx = makeFixture(c.name);
      const decoy = writeNote(fx.sessions, DECOY_DIR, c.name, DECOY_FILE);
      return { c, fx, decoy, note: writeNote(fx.sessions, c.legacy, c.name) };
    });
    const closeRuns = await Promise.all([
      ...legacyCloses.map(({ fx }) => runNode(['-e', closeScript(fx.code)], { vault: fx.vault })),
      ...writes.map(({ fx }) => runNode(['-e', closeScript(fx.code)], { vault: fx.vault })),
    ]);
    legacyCloses.forEach(({ c, note, decoy }, i) => {
      eq(`${c.label}: session-close closes the legacy-folder note, not the newer decoy`,
        parseJson(closeRuns[i].stdout).file, LEGACY_FILE);
      ok(`${c.label}: that legacy note is now status: done`, /^status: done$/m.test(read(note)));
      ok(`${c.label}: the decoy is left active`, /^status: active$/m.test(read(decoy)));
    });
    writes.forEach(({ c }, i) => {
      eq(`${c.label}: session-close closes the note session-auto-track wrote`,
        parseJson(closeRuns[legacyCloses.length + i].stdout).closed, true);
    });

    // ── 3. vault-query.mjs session start: write path ────────────────────────
    const VQ = path.join(ROOT, 'scripts', 'vault-query.mjs');
    const vq = [
      ...CASES.map(c => ({ label: c.label, project: c.name, want: c.name })),
      { label: 'no --project', project: null, want: UNCATEGORIZED },
    ].map(v => ({ ...v, fx: makeFixture(v.project || 'unused') }));
    const vqRuns = await Promise.all(vq.map(({ project, fx }) => runNode(
      [VQ, 'session', 'start', ...(project ? ['--project', project] : []), '--goal', 'fixture'],
      { vault: fx.vault })));
    vq.forEach(({ label, want, fx }, i) => {
      eq(`${label}: vault-query session start exits 0`, vqRuns[i].status, 0);
      eq(`${label}: vault-query session start writes only the folder named after the project`,
        JSON.stringify(listDirs(fx.sessions)), JSON.stringify([want]));
    });

    // ── 5. no Sessions consumer keeps its own dashed derivation ─────────────
    {
      const LEGACY_DERIVATION = /replace\(\s*\/\[\^a-zA-Z0-9\]\+\/g\s*,\s*['"`]-['"`]\s*\)/;
      const files = [];
      const walk = (d) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
          const p = path.join(d, e.name);
          if (e.isDirectory()) walk(p);
          else if (/\.(c?js|mjs)$/.test(e.name) && !/\.test\.(c?js|mjs)$/.test(e.name)) files.push(p);
        }
      };
      for (const d of ['hooks', 'scripts', 'skills']) walk(path.join(ROOT, d));
      const offenders = [];
      for (const f of files) {
        if (f === path.join(__dirname, 'session-folder.js')) continue; // the legacy form's one home
        const src = fs.readFileSync(f, 'utf8');
        if (!/Sessions/.test(src)) continue;
        src.split(/\r?\n/).forEach((line, i) => {
          if (LEGACY_DERIVATION.test(line)) offenders.push(`${path.relative(ROOT, f)}:${i + 1}`);
        });
      }
      ok(`no Sessions consumer derives a dashed folder itself (${offenders.join(', ')})`, offenders.length === 0);

      const consumers = ['hooks/beads-status-sync.js', 'hooks/lib/session-close.js',
        'hooks/post-compact.js', 'hooks/pre-compact-snapshot.js', 'hooks/session-auto-close.js',
        'hooks/session-auto-track.js', 'hooks/session-note-nudge.js', 'hooks/statusline-state.js',
        'scripts/vault-query.mjs'];
      const notWired = consumers.filter(rel =>
        !fs.readFileSync(path.join(ROOT, rel), 'utf8').includes('session-folder.js'));
      ok(`every Sessions consumer requires lib/session-folder.js (${notWired.join(', ')})`, notWired.length === 0);
    }

    // ── 6. a case-only folder mismatch is read once per note ────────────────
    // The project is "Mastra CHAT KIT"; its folder on disk is "Mastra Chat Kit".
    // On a case-insensitive filesystem both spellings open the same folder. The
    // hooks walk the project's folders and then all of Sessions/, de-duplicating
    // by path string — so a folder returned in the name's spelling is walked a
    // second time by the full scan, which spells it the way the disk does. Every
    // note here is done, so each hook walks all of them; a preload counts reads
    // per note, case-folded.
    {
      const NAME = 'Mastra CHAT KIT';
      const DISK = 'Mastra Chat Kit';
      const S = path.join(sandbox, 'case-sessions');
      fs.mkdirSync(path.join(S, DISK), { recursive: true });
      eq('a case-only match resolves to the on-disk spelling',
        JSON.stringify(existingSessionFolders(S, NAME)), JSON.stringify([path.join(S, DISK)]));
      fs.mkdirSync(path.join(S, 'mastra-chat-kit'));
      eq('a case-only legacy match resolves to its on-disk spelling too',
        JSON.stringify(existingSessionFolders(S, NAME)),
        JSON.stringify([path.join(S, DISK), path.join(S, 'mastra-chat-kit')]));

      const fx = makeFixture(NAME);
      fs.mkdirSync(path.join(fx.code, '.beads'));
      const notes = ['2026-01-01-a.md', '2026-01-02-b.md', '2026-01-03-c.md']
        .map(f => writeNote(fx.sessions, DISK, NAME, f, 'done'));
      const PRELOAD = path.join(sandbox, 'count-reads.js');
      fs.writeFileSync(PRELOAD, [
        "'use strict';",
        "const fs = require('fs');",
        "const path = require('path');",
        'const root = path.resolve(process.env.READ_COUNT_ROOT).toLowerCase();',
        'const counts = {};',
        "for (const fn of ['readFileSync', 'openSync']) {",
        '  const orig = fs[fn];',
        '  fs[fn] = function (p, ...rest) {',
        "    if (typeof p === 'string') {",
        '      const k = path.resolve(p).toLowerCase();',
        "      if (k.startsWith(root) && k.endsWith('.md')) counts[k] = (counts[k] || 0) + 1;",
        '    }',
        '    return orig.call(this, p, ...rest);',
        '  };',
        '}',
        "process.on('exit', () => fs.writeFileSync(process.env.READ_COUNT_OUT, JSON.stringify(counts)));",
        '',
      ].join('\n'));

      // One payload serves all six: post-compact needs a summary, and
      // beads-status-sync a successful, matching bd command.
      const payload = JSON.stringify({
        cwd: fx.code, compact_summary: 'fixture summary', tool_name: 'Bash',
        tool_input: { command: 'bd update zz-1 --status open' }, tool_response: { exit_code: 0 },
      });
      const hooks = [
        ['statusline-state.js', [path.join(HOOKS, 'statusline-state.js')]],
        ['post-compact.js', [path.join(HOOKS, 'post-compact.js')]],
        ['pre-compact-snapshot.js', [path.join(HOOKS, 'pre-compact-snapshot.js')]],
        ['beads-status-sync.js', [path.join(HOOKS, 'beads-status-sync.js')]],
        ['session-auto-close.js', [path.join(HOOKS, 'session-auto-close.js')]],
        ['lib/session-close.js', ['-e', `require(${JSON.stringify(CLOSE)}).findActiveSession(${JSON.stringify(NAME)});`]],
      ];
      const runs = await Promise.all(hooks.map(([label, args], i) => {
        const out = path.join(sandbox, `reads-${i}.json`);
        return runNode(['-r', PRELOAD, ...args], {
          vault: fx.vault, input: payload, cwd: fx.code,
          // Only node on PATH: beads-status-sync runs `bd show` for the command
          // above, and must not reach a real bd or dolt server from a test.
          env: {
            PATH: path.dirname(process.execPath), BRAYNEE_DOLT_CAP: '1',
            READ_COUNT_ROOT: fx.sessions, READ_COUNT_OUT: out,
          },
        }).then(r => ({ label, r, out }));
      }));
      for (const { label, r, out } of runs) {
        eq(`${label}: exits 0 on a case-only folder mismatch`, r.status, 0);
        const counts = fs.existsSync(out) ? parseJson(read(out)) : {};
        eq(`${label}: each note in a case-only-mismatched folder is read once`,
          JSON.stringify(notes.map(n => counts[path.resolve(n).toLowerCase()] || 0)),
          JSON.stringify(notes.map(() => 1)));
      }
    }
  } catch (e) {
    fail++;
    fails.push(`threw: ${e && e.stack}`);
  } finally {
    try {
      fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
    } catch { /* a lingering child can hold a handle on Windows; the temp dir is disposable */ }
  }

  if (fail === 0) {
    console.log(`session-folder.test.js: ${pass} passed, 0 failed`);
    process.exit(0);
  } else {
    console.error(`session-folder.test.js: ${pass} passed, ${fail} FAILED`);
    for (const f of fails) console.error(`  FAIL: ${f}`);
    process.exit(1);
  }
})();
