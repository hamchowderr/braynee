#!/usr/bin/env node
/**
 * fleet-beads-audit.mjs — audit (and optionally heal) every beads repo under a
 * code root, for the three failure classes found in cp-uif3.1:
 *
 *   1. STALE     — .beads/issues.jsonl older than the beads DB, so every braynee
 *                  reader (~10 of them) serves month-old data.
 *   2. TRACKED   — issues.jsonl is git-tracked, so bd's writes stage themselves
 *                  into the user's in-flight branches and block `git checkout`.
 *   3. NO-CONFIG — .beads/ exists but config.yaml does not (never fully
 *                  `bd init`ed), so `bd config set` fails and the SessionStart
 *                  hook cannot self-heal export.auto there.
 *
 * Read-only by default. `--write` applies fixes; each fix is idempotent and is
 * skipped (not retried) when its precondition is already satisfied.
 *
 * Usage:
 *   node scripts/fleet-beads-audit.mjs [--root <dir>] [--write] [--only <class>]
 *                                      [--repo <name>] [--json]
 *
 *   --only untrack|config|export   restrict --write to one fix class
 *   --repo <name>                  restrict to one repo (repeatable)
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const multi = (name) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === name && argv[i + 1]) out.push(argv[i + 1]);
  return out;
};

const ROOT = path.resolve(opt('--root', path.join(os.homedir(), 'code')));
const WRITE = flag('--write');
const AS_JSON = flag('--json');
const ONLY = opt('--only', null);
const ONLY_REPOS = multi('--repo');

const JSONL_REL = '.beads/issues.jsonl';
const GITIGNORE_LINE = '.beads/issues.jsonl';

function sh(cmd, args, cwd, timeoutMs = 20000) {
  const r = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
  });
  return {
    ok: r.status === 0,
    // spawnSync reports a timeout as status===null + SIGTERM, indistinguishable
    // from a crash unless the signal is checked explicitly.
    timedOut: r.status === null && (r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT'),
    out: (r.stdout || '') + (r.stderr || ''),
  };
}

/** Read a top-level scalar from a beads config.yaml without a YAML dependency. */
function readConfigScalar(text, dottedKey) {
  const [head, tail] = dottedKey.split('.');
  if (!tail) {
    const m = text.match(new RegExp('^' + head + ':\\s*(\\S+)\\s*$', 'm'));
    return m ? m[1] : null;
  }
  // nested: find the `head:` block, then the `  tail:` line before dedent.
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp('^' + head + ':\\s*$').test(l));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^\S/.test(l)) break; // dedented out of the block
    const m = l.match(new RegExp('^\\s+' + tail + ':\\s*(\\S+)\\s*$'));
    if (m) return m[1];
  }
  return null;
}

/**
 * Count issue records in a jsonl. `bd remember` memories and template records
 * live in the same file but carry no id+title, so they are excluded — otherwise
 * a repo with memories reads as having MORE issues than its DB.
 */
function countJsonlIssues(file) {
  let n = 0;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o && o.id && o.title) n++;
  }
  return n;
}

/**
 * Issue count from the live DB. Deliberately data-based: an mtime comparison
 * against .beads/embeddeddolt is NOT a staleness signal, because any bd read
 * rewrites the dolt manifest/journal.idx — that heuristic reported 95 of 136
 * repos stale when the real number was far smaller.
 */
function dbIssueCount(repo) {
  // 45s, not 30s: bd may have to auto-start the shared Dolt server on the
  // first touch of a repo, which is slower than a warm read.
  const res = sh('bd', ['stats', '--json'], repo, 45000);
  const m = res.out.match(/"total_issues"\s*:\s*(\d+)/);
  if (m) return { count: Number(m[1]), err: null };
  if (res.timedOut) return { count: null, err: 'TIMEOUT' };
  // Report the first line that looks like a failure. bd routinely emits benign
  // stderr first ("Dolt server endpoint changed: port X -> Y (auto-start)"),
  // so taking line 1 blindly attributes the failure to a warning.
  const lines = res.out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const real = lines.find((l) => /error|failed|cannot|unable|no beads|not found|refus/i.test(l));
  return { count: null, err: real || lines[lines.length - 1] || 'no output' };
}

function discover() {
  let entries;
  try {
    entries = fs.readdirSync(ROOT, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(ROOT, e.name))
    .filter((p) => fs.existsSync(path.join(p, '.beads')))
    .filter((p) => !ONLY_REPOS.length || ONLY_REPOS.includes(path.basename(p)));
}

function inspect(repo) {
  const name = path.basename(repo);
  const beads = path.join(repo, '.beads');
  const cfgPath = path.join(beads, 'config.yaml');
  const jsonl = path.join(repo, JSONL_REL);

  const r = {
    name,
    repo,
    hasConfig: fs.existsSync(cfgPath),
    exportAuto: null,
    exportGitAdd: null,
    hasJsonl: fs.existsSync(jsonl),
    jsonlAgeH: null,
    jsonlIssues: null,
    dbIssues: null,
    dbErr: null,
    hasDb: false,
    isGit: fs.existsSync(path.join(repo, '.git')),
    tracked: false,
    ignored: false,
    branch: null,
    stale: false,
    problems: [],
  };

  if (r.hasConfig) {
    const text = fs.readFileSync(cfgPath, 'utf8');
    r.exportAuto = readConfigScalar(text, 'export.auto');
    r.exportGitAdd = readConfigScalar(text, 'export.git-add');
  }

  // Whether a DB exists cannot be decided from the directory listing: a repo
  // may be embedded (.beads/embeddeddolt), shared-server (.beads/dolt, or NO
  // local dolt dir at all — the data lives in the central server), or sqlite.
  // Guessing from names reported 28 repos as having no database when bd read
  // all of them fine. `bd stats` is the only authority.
  r.sharedServer =
    r.hasConfig && /^dolt\.shared-server:\s*true/m.test(fs.readFileSync(cfgPath, 'utf8'));
  r.localDbDir =
    fs.existsSync(path.join(beads, 'embeddeddolt')) ||
    fs.existsSync(path.join(beads, 'dolt')) ||
    fs.readdirSync(beads).some((f) => /\.(db|sqlite3?)$/.test(f));

  if (r.hasJsonl) {
    r.jsonlAgeH = Math.round((Date.now() - fs.statSync(jsonl).mtimeMs) / 36e5);
    r.jsonlIssues = countJsonlIssues(jsonl);
  }
  const { count, err } = dbIssueCount(repo);
  r.dbIssues = count;
  r.dbErr = err;
  r.hasDb = count != null;
  // Stale = the DB holds issues the jsonl does not. Extra jsonl records are
  // fine (memories/templates); missing ones are what serve braynee bad data.
  r.stale = count != null && r.jsonlIssues != null && r.jsonlIssues < count;

  if (r.isGit) {
    r.branch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD'], repo).out.trim() || null;
    r.tracked = sh('git', ['ls-files', '--error-unmatch', JSONL_REL], repo).ok;
    const gi = path.join(repo, '.gitignore');
    r.ignored =
      fs.existsSync(gi) &&
      fs
        .readFileSync(gi, 'utf8')
        .split(/\r?\n/)
        .some((l) => l.trim() === GITIGNORE_LINE);
  }

  if (!r.hasConfig) r.problems.push('NO-CONFIG');
  else if (r.exportAuto !== 'true') r.problems.push('EXPORT-OFF');
  if (r.tracked) r.problems.push('TRACKED');
  if (r.stale) r.problems.push('STALE');
  // Only a repo that actually holds issues can have an unreadable DB worth
  // reporting; an empty .beads/ that bd declines to read is inert.
  if (r.dbErr && (r.jsonlIssues || 0) > 0) r.problems.push('DB-ERR');
  return r;
}

/* ---------------------------------------------------------------- fixes ---- */

function fixUntrack(r, log) {
  if (!r.tracked) return 'skip';
  // Order matters: ignore first, so the index removal cannot be undone by a
  // later `git add -A` before the user commits.
  const gi = path.join(r.repo, '.gitignore');
  if (!r.ignored) {
    // Append to the repo-ROOT .gitignore, NOT .beads/.gitignore, which
    // `bd doctor --fix` rewrites from its own template.
    let text = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
    if (text.length && !text.endsWith('\n')) text += '\n';
    text += `\n# beads local read-cache — regenerated by bd, must not be tracked (cp-uif3.1)\n${GITIGNORE_LINE}\n`;
    fs.writeFileSync(gi, text);
    log.push('  + .gitignore <- ' + GITIGNORE_LINE);
  }
  const rm = sh('git', ['rm', '--cached', '--quiet', JSONL_REL], r.repo);
  if (!rm.ok) {
    log.push('  ! git rm --cached failed: ' + rm.out.trim().split('\n')[0]);
    return 'fail';
  }
  log.push('  + untracked (staged deletion — rides your next commit)');
  return 'done';
}

function fixConfig(r, log) {
  if (!r.hasConfig) {
    log.push('  - no config.yaml: needs `bd init` (not done automatically)');
    return 'skip';
  }
  let changed = false;
  for (const [key, want] of [
    ['export.auto', 'true'],
    ['export.git-add', 'false'],
  ]) {
    const have = key === 'export.auto' ? r.exportAuto : r.exportGitAdd;
    if (have === want) continue;
    const res = sh('bd', ['config', 'set', key, want], r.repo, 30000);
    if (!res.ok) {
      log.push('  ! bd config set ' + key + ' failed: ' + res.out.trim().split('\n')[0]);
      return 'fail';
    }
    log.push('  + ' + key + ' = ' + want + (have ? ' (was ' + have + ')' : ''));
    changed = true;
  }
  return changed ? 'done' : 'skip';
}

function fixExport(r, log) {
  if (!r.hasDb) {
    log.push('  - no beads DB: nothing to export from');
    return 'skip';
  }
  if (!r.stale) return 'skip';
  // --include-memories, or the export drops `bd remember` records and the
  // shrink guard rejects the write on the next run.
  const res = sh(
    'bd',
    ['export', '--all', '--include-memories', '-o', JSONL_REL],
    r.repo,
    120000,
  );
  if (!res.ok) {
    log.push('  ! export failed' + (res.timedOut ? ' (TIMEOUT)' : '') + ': ' + res.out.trim().split('\n')[0]);
    return 'fail';
  }
  log.push('  + fresh export');
  return 'done';
}

/* ----------------------------------------------------------------- main ---- */

const repos = discover();
const rows = repos.map(inspect);

if (AS_JSON) {
  console.log(JSON.stringify({ root: ROOT, count: rows.length, repos: rows }, null, 2));
  process.exit(0);
}

const tally = (p) => rows.filter((r) => r.problems.includes(p)).length;
console.log(`beads repos under ${ROOT}: ${rows.length}`);
console.log(`  NO-CONFIG (never bd init'ed, cannot self-heal): ${tally('NO-CONFIG')}`);
console.log(`  EXPORT-OFF (has config, export.auto != true):   ${tally('EXPORT-OFF')}`);
console.log(`  TRACKED   (issues.jsonl is git-tracked):        ${tally('TRACKED')}`);
console.log(`  STALE     (jsonl is MISSING issues the DB has): ${tally('STALE')}`);
console.log(`  DB-ERR    (holds issues but bd cannot read):    ${tally('DB-ERR')}`);
console.log(`  clean:                                          ${rows.filter((r) => !r.problems.length).length}`);
const empty = rows.filter((r) => !(r.jsonlIssues || 0) && !(r.dbIssues || 0)).length;
console.log(`  (of all ${rows.length}, ${empty} hold zero issues — inert .beads/ dirs)`);

if (!WRITE) {
  console.log('\n--- repos with problems (read-only; pass --write to fix) ---');
  for (const r of rows.filter((x) => x.problems.length)) {
    const counts =
      r.dbIssues != null || r.jsonlIssues != null
        ? ` jsonl=${r.jsonlIssues ?? '-'}/db=${r.dbIssues ?? '?'}`
        : '';
    console.log(
      `${r.name.padEnd(28)} ${r.problems.join(',').padEnd(26)}${counts.padEnd(18)}${r.dbErr ? '  ' + r.dbErr.slice(0, 60) : ''}`,
    );
  }
  process.exit(0);
}

const results = { done: [], skip: [], fail: [] };
for (const r of rows) {
  if (!r.problems.length) continue;
  const log = [];
  const ran = [];
  if (!ONLY || ONLY === 'config') ran.push(fixConfig(r, log));
  if (!ONLY || ONLY === 'untrack') ran.push(fixUntrack(r, log));
  if (!ONLY || ONLY === 'export') ran.push(fixExport(r, log));

  const verdict = ran.includes('fail') ? 'fail' : ran.includes('done') ? 'done' : 'skip';
  results[verdict].push(r.name);
  if (log.length) {
    console.log(`\n${r.name}  [${r.problems.join(',')}]`);
    for (const l of log) console.log(l);
  }
}

console.log(
  `\nfixed=${results.done.length}  nothing-to-do=${results.skip.length}  failed=${results.fail.length}`,
);
if (results.fail.length) console.log('FAILED: ' + results.fail.join(', '));
