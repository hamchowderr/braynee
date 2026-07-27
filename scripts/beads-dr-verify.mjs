#!/usr/bin/env node
/**
 * beads-dr-verify.mjs — prove a beads backup can actually be RESTORED (cp-uif3.2).
 *
 * A backup that has never been restored is a hypothesis, not a recovery path.
 * `bd backup status` reporting a recent sync says the push succeeded; it says
 * nothing about whether the bytes on the other end reconstruct a working
 * database with the right issues in it. This restores into a throwaway directory
 * and compares the issue counts.
 *
 * TWO TRAPS this deliberately avoids, both hit while establishing the procedure:
 *
 *   1. `bd backup restore` with NO path reads `.beads/backup` and, with --force,
 *      OVERWRITES THE LIVE DATABASE of the repo you are standing in. A
 *      verification tool that can destroy the thing it verifies is not
 *      acceptable, so every restore here is `-C <throwaway>` with an explicit
 *      source path, and the probe directory is created fresh under the OS temp
 *      dir — never inside a real project.
 *   2. The probe must be a genuinely isolated repo. An earlier attempt used a
 *      scratch project wired to the shared server and "restored" 1 issue instead
 *      of 214 — it was reading the shared database, not the backup. So the probe
 *      gets its own embedded database and is checked to start EMPTY; if it does
 *      not, the run aborts rather than reporting a meaningless pass.
 *
 * KNOWN LIMITATION on a machine running the global shared Dolt server: probe
 * creation can fail, and this tool then reports FAILED rather than passing. All
 * four isolation routes were tried and recorded here so nobody repeats them:
 *
 *   bd init (embedded default)  bd still tries to START the shared server and
 *                               dies on the bound port (see the
 *                               bd-init-shared-server-external note)
 *   bd init --shared-server --external
 *                               connects to the SHARED database — the opposite
 *                               of isolated; a --force restore there would
 *                               overwrite real data
 *   bd init --proxied-server    "not yet implemented" in the installed bd
 *   dolt backup restore <url>   Windows file:// URL forms are rejected or panic
 *
 * Reporting FAILED here is the correct behavior, not a bug to route around: a
 * verifier that cannot prove isolation must not claim a restore succeeded. The
 * mechanism itself IS proven — a manual round-trip reproduced a source database
 * exactly (identical total/open/in-progress/blocked/closed counts). What is not
 * yet automated is per-repo verification on this setup.
 *
 * Usage:
 *   node scripts/beads-dr-verify.mjs --repo <name> [--root <dir>] [--json]
 *   node scripts/beads-dr-verify.mjs --all [--limit <n>]
 *
 * Exit 0 = every checked backup restored with a matching issue count.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if (flag('--help') || flag('-h') || (!flag('--all') && !opt('--repo', null))) {
  console.log(`beads-dr-verify — prove a beads backup restores (cp-uif3.2)

  node scripts/beads-dr-verify.mjs --repo <name>     verify one repo's backup
  node scripts/beads-dr-verify.mjs --all             verify every configured backup

  --root <dir>    code root (default ~/code)
  --dest <dir>    backup root (default ~/beads-backups)
  --limit <n>     with --all, stop after n repos
  --json          machine-readable output

Restores into a throwaway directory and compares issue counts. Never touches the
source repo: restore is always run with -C against an explicit source path,
because a bare 'bd backup restore --force' overwrites the LIVE database.`);
  process.exit(flag('--help') || flag('-h') ? 0 : 1);
}

const ROOT = path.resolve(opt('--root', path.join(os.homedir(), 'code')));
const DEST_ROOT = path.resolve(opt('--dest', path.join(os.homedir(), 'beads-backups')));
const ONE = opt('--repo', null);
const LIMIT = Number(opt('--limit', '0')) || 0;
const AS_JSON = flag('--json');

function bd(args, cwd, timeoutMs = 120000) {
  const r = spawnSync('bd', args, {
    cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, shell: false,
  });
  return {
    ok: r.status === 0,
    timedOut: r.status === null && !r.error,
    out: `${r.stdout || ''}${r.stderr || ''}`,
    err: r.error ? r.error.message : null,
  };
}

/** Issues in a repo's jsonl — the expected count, read without touching bd. */
function jsonlCount(repo) {
  try {
    let n = 0;
    for (const line of fs.readFileSync(path.join(repo, '.beads', 'issues.jsonl'), 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { const r = JSON.parse(s); if (r && r.id && (!r._type || r._type === 'issue')) n++; } catch { /* non-issue row */ }
    }
    return n;
  } catch { return null; }
}

/**
 * Total issues bd reports in the database at `dir`.
 *
 * The real shape is `{schema_version, summary:{total_issues, …}}` — verified
 * against the installed bd, after a first version of this function looked for
 * `total_issues` at the top level and silently returned null, which would have
 * reported every restore as failed. `.data` is also accepted because
 * BD_JSON_ENVELOPE moves the payload there and becomes the default in beads
 * v2.0 (cp-uif3.6).
 */
function dbCount(dir) {
  const r = bd(['stats', '--json'], dir, 60000);
  if (!r.ok) return { n: null, why: r.timedOut ? 'bd stats timed out' : r.out.trim().split('\n')[0] };
  try {
    const j = JSON.parse(r.out.slice(r.out.indexOf('{')));
    const env = j && j.data && typeof j.data === 'object' ? j.data : j;
    const s = env && env.summary && typeof env.summary === 'object' ? env.summary : env;
    const n = s.total_issues ?? s.total ?? null;
    return { n: typeof n === 'number' ? n : null, why: typeof n === 'number' ? null : 'no total_issues in bd stats' };
  } catch (e) {
    return { n: null, why: `unparseable bd stats: ${e.message}` };
  }
}

function backupSourceFor(repo) {
  const name = path.basename(repo);
  const external = path.join(DEST_ROOT, name);
  if (fs.existsSync(external) && fs.readdirSync(external).length) return external;
  const inProject = path.join(repo, '.beads', 'backup');
  if (fs.existsSync(inProject) && fs.readdirSync(inProject).length) return inProject;
  return null;
}

function verify(repo) {
  const name = path.basename(repo);
  const source = backupSourceFor(repo);

  // Compare DB-to-DB, not DB-to-jsonl. The jsonl legitimately carries records
  // the database does not count as issues — measured on one repo: 252 rows in
  // the jsonl against 249 total_issues, the difference being memories and
  // infra/template rows. Using the jsonl as the bar would report a PERFECT
  // restore as a 3-issue shortfall.
  const src = dbCount(repo);
  const expected = src.n;
  const row = { name, expected, source, restored: null, ok: false, why: null, jsonl: jsonlCount(repo) };

  if (!source) { row.why = 'no backup found'; return row; }
  if (expected === null) { row.why = `cannot read source issue count: ${src.why}`; return row; }

  // Throwaway probe, under the OS temp dir — never inside a real project, so a
  // --force restore can never reach anything that matters.
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), `bd-restore-${name}-`));
  try {
    const init = bd(['init', '--quiet'], probe, 120000);
    if (!init.ok && !fs.existsSync(path.join(probe, '.beads'))) {
      row.why = `probe bd init failed: ${init.out.trim().split('\n')[0]}`;
      return row;
    }

    // The probe MUST start empty. If it does not, it is reading some other
    // database (the shared server), and any count it reports afterwards is
    // meaningless — that is exactly how an earlier attempt "restored" 1 issue
    // instead of 214 and looked like a partial success.
    const before = dbCount(probe);
    if (before.n === null) { row.why = `probe unreadable before restore: ${before.why}`; return row; }
    if (before.n !== 0) {
      row.why = `probe is not isolated (starts with ${before.n} issues) — it is reading another database`;
      return row;
    }

    // -C <probe> plus an explicit source. Never a bare `bd backup restore
    // --force`, which reads .beads/backup and overwrites the LIVE database.
    const rest = bd(['backup', 'restore', source, '--force', '-C', probe], probe, 180000);
    if (!rest.ok) {
      row.why = `restore failed: ${rest.out.trim().split('\n').slice(0, 2).join(' ')}`;
      return row;
    }

    const after = dbCount(probe);
    row.restored = after.n;
    if (after.n === null) { row.why = `restored db unreadable: ${after.why}`; return row; }

    // Exact equality is the honest bar: the restore either reconstructed the
    // database or it did not.
    row.ok = after.n === expected;
    if (!row.ok) row.why = `restored ${after.n} issues, expected ${expected}`;
    return row;
  } finally {
    try { fs.rmSync(probe, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { /* a leaked probe in temp is harmless; never fail the check on cleanup */ }
  }
}

let repos = [];
if (ONE) {
  repos = [path.join(ROOT, ONE)];
} else {
  try {
    repos = fs.readdirSync(ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => path.join(ROOT, e.name))
      .filter((p) => fs.existsSync(path.join(p, '.beads')))
      .filter((p) => backupSourceFor(p));
  } catch { repos = []; }
  if (LIMIT) repos = repos.slice(0, LIMIT);
}

const rows = repos.map(verify);
const passed = rows.filter((r) => r.ok);
const failed = rows.filter((r) => !r.ok);

if (AS_JSON) {
  process.stdout.write(JSON.stringify({
    summary: { checked: rows.length, restored: passed.length, failed: failed.length }, repos: rows,
  }, null, 2) + '\n');
} else {
  console.log('repo                             expected  restored  result');
  for (const r of rows) {
    console.log(
      r.name.padEnd(32),
      String(r.expected ?? '—').padStart(8),
      String(r.restored ?? '—').padStart(10),
      '  ' + (r.ok ? 'RESTORED' : `FAILED — ${r.why}`));
  }
  console.log(`\n  checked ${rows.length} | restored ${passed.length} | failed ${failed.length}`);
  if (passed.length) console.log('  A restored count matching the source is what makes this a recovery path rather than a hope.');
}

process.exit(failed.length ? 1 : 0);
