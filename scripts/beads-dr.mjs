#!/usr/bin/env node
/**
 * beads-dr.mjs — fleet disaster-recovery for beads (cp-uif3.2).
 *
 * The problem: issue history lives in a local Dolt database on one Windows
 * machine. A journal-corrupting unclean shutdown loses it, and there is nothing
 * to restore from.
 *
 * MEASURED STATE when this was written (the issue's own figures were wrong in
 * three ways that changed the plan — measure, don't trust the ticket):
 *
 *   - "531 MB backup" was a MISREAD. `bd backup status` prints
 *     `Database size: 548.8 MB`, and the SAME number appears in repos that have
 *     no destination at all — it is a global figure, not this repo's backup. On
 *     disk braynee's backup is 31 MB. Fleet-wide the live DBs total 0.19 GB.
 *     Disk cost was never the constraint it appeared to be.
 *   - "braynee is the only project with a backup destination" is true for the
 *     Dolt-NATIVE destination, but 107 of 140 repos already hold `.darc`
 *     archives in `.beads/backup`, written by bd's INTERNAL auto-backup
 *     (`enabled=true (auto: git remote detected)`, interval 15m). They are not
 *     unprotected — they are protected by a mechanism nobody is watching, which
 *     is worse, because it looks like coverage. Measured on one fleet: the
 *     busiest repo's last internal backup was 310 HOURS old, and most were 23
 *     days old.
 *   - The real gap is not configuration, it is SCHEDULING. `bd backup sync` is
 *     manual. braynee was synced during the last session and was already 35h
 *     stale by the next one. A destination nobody pushes to rots silently while
 *     `bd backup status` still reports a recent "Last backup" — a different
 *     field, and the reassuring one is not the one that protects you.
 *
 * So this tool audits what is actually true, configures the Dolt-native
 * destination where it is missing, and — the part that matters — is callable on
 * a schedule so the destination stays fresh.
 *
 * DESTINATION: ~/beads-backups/<repo>, OUTSIDE the project. In-project
 * `.beads/backup` dies with `rm -rf <project>`, which is a likelier way to lose
 * a repo than disk failure. An external root also gives ONE directory to push
 * off-machine later.
 *
 * LIMIT, stated plainly because a backup people misunderstand is worse than
 * none: this is a LOCAL copy. It survives DB corruption and unclean-shutdown
 * journal damage — the stated threat — but NOT loss of the disk. Off-machine
 * protection needs a Dolt remote (see cp-3tk; opt-in, never mandatory:
 * braynee is local-first).
 *
 * Usage:
 *   node scripts/beads-dr.mjs                 # audit, read-only
 *   node scripts/beads-dr.mjs --init          # configure missing destinations
 *   node scripts/beads-dr.mjs --sync          # push every configured destination
 *   node scripts/beads-dr.mjs --init --sync   # roll out and populate
 *     [--root <dir>] [--dest <dir>] [--repo <name>]... [--include-dead]
 *     [--stale-hours <n>] [--dry-run] [--json] [--quiet]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const multi = (n) => { const o = []; for (let i = 0; i < argv.length; i++) if (argv[i] === n && argv[i + 1]) o.push(argv[i + 1]); return o; };

if (flag('--help') || flag('-h')) {
  console.log(`beads-dr — fleet disaster-recovery for beads (cp-uif3.2)

  node scripts/beads-dr.mjs [--init] [--sync] [options]

  (no action)        audit only, read-only
  --init             configure a Dolt-native backup destination where missing
  --sync             push every configured destination (this is the part that
                     must run on a schedule — bd backup sync is manual)

  --root <dir>       code root (default ~/code)
  --dest <dir>       backup root (default ~/beads-backups)
  --repo <name>      restrict to one repo (repeatable)
  --include-dead     do not skip retired project families
  --stale-hours <n>  age at which a destination counts as stale (default 48)
  --dry-run          report what would happen, change nothing
  --json             machine-readable output
  --quiet            summary only

A local backup survives DB corruption, NOT disk loss. Off-machine copies are
opt-in per project (cp-3tk).`);
  process.exit(0);
}

const ROOT = path.resolve(opt('--root', path.join(os.homedir(), 'code')));
const DEST_ROOT = path.resolve(opt('--dest', path.join(os.homedir(), 'beads-backups')));
const ONLY = multi('--repo');
const INIT = flag('--init');
const SYNC = flag('--sync');
const DRY = flag('--dry-run');
const AS_JSON = flag('--json');
const QUIET = flag('--quiet');
const INCLUDE_DEAD = flag('--include-dead');
const STALE_HOURS = Number(opt('--stale-hours', '48')) || 48;

// Scope, as a measured rule rather than a hand-kept list of "important" repos —
// a list goes stale the moment a project is added. A backup protects HISTORY, so
// the qualifying question is whether there is any: 88 of 124 beads repos here
// hold ZERO issues (templates, scaffolds, demos, abandoned spikes). Configuring
// and syncing those spends time and disk protecting nothing, and buries the
// repos that matter in the report.
const MIN_ISSUES = Number(opt('--min-issues', '1'));

// Retired families: backing them up spends time and disk protecting work nobody
// will do. Same exclusion the mirror sweep uses.
const DEAD = /^sophon(-|$)|^comfyui-sophon$/;

function bd(args, cwd, timeoutMs = 60000) {
  const r = spawnSync('bd', args, {
    cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, shell: false,
  });
  // spawnSync reports a timeout as status===null plus a signal, which is
  // indistinguishable from a crash unless checked explicitly.
  const timedOut = r.status === null && !r.error;
  return {
    ok: r.status === 0,
    timedOut,
    out: `${r.stdout || ''}${r.stderr || ''}`,
    err: r.error ? r.error.message : null,
  };
}

function discover() {
  let entries = [];
  try { entries = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(ROOT, e.name))
    .filter((p) => fs.existsSync(path.join(p, '.beads')))
    .filter((p) => ONLY.length ? ONLY.includes(path.basename(p)) : true)
    .filter((p) => INCLUDE_DEAD || ONLY.length || !DEAD.test(path.basename(p)));
}

const AGO = /\(([\dhms]+)\s+ago/;
function parseAgoHours(s) {
  const m = AGO.exec(s || '');
  if (!m) return null;
  const t = m[1];
  const h = /(\d+)h/.exec(t), mi = /(\d+)m/.exec(t), sec = /(\d+)s/.exec(t);
  return (h ? +h[1] : 0) + (mi ? +mi[1] : 0) / 60 + (sec ? +sec[1] : 0) / 3600;
}

/**
 * How many issues this repo's own jsonl holds.
 *
 * Read from the file, never via `bd` (cp-6j5 / dolt-guard): this runs across
 * ~124 repos, and a bd invocation each would hammer the shared Dolt server and
 * leave orphan processes. The jsonl is bd's own export and is repo-scoped by
 * construction.
 */
function issueCount(repo) {
  try {
    let n = 0;
    for (const line of fs.readFileSync(path.join(repo, '.beads', 'issues.jsonl'), 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try {
        const rec = JSON.parse(s);
        if (rec && rec.id && (!rec._type || rec._type === 'issue')) n++;
      } catch { /* interleaved non-issue row */ }
    }
    return n;
  } catch {
    return 0;
  }
}

function dirSize(p) {
  let total = 0;
  const stack = [p];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) stack.push(fp);
      else { try { total += fs.statSync(fp).size; } catch { /* vanished mid-walk */ } }
    }
  }
  return total;
}

/** What `bd backup status` says about this repo. */
function inspect(repo) {
  const name = path.basename(repo);
  const r = bd(['backup', 'status'], repo, 30000);
  const out = r.out;

  // The two mechanisms print different sections, and conflating them is the
  // documented trap: "Last backup" (bd's internal auto-backup) can read minutes
  // while "Last sync" (the Dolt-native destination) is days old.
  const destM = /Destination:\s*(\S+)/.exec(out);
  const syncLine = /Last sync:\s*([^\n]*)/.exec(out);
  const backupLine = /Last backup:\s*([^\n]*)/.exec(out);

  const destination = destM ? destM[1] : null;
  const syncAgoH = syncLine ? parseAgoHours(syncLine[1]) : null;
  const internalAgoH = backupLine ? parseAgoHours(backupLine[1]) : null;

  // A bare `.beads/` marker with no database is a legitimate state (a scaffold,
  // a repo where bd was never finished), not a failure. Calling it an error
  // would make a scheduled run exit non-zero forever and train everyone to
  // ignore it — so it is reported as SKIP and kept out of the exit code.
  const noDb = /no beads database found/i.test(out);

  const localBackupDir = path.join(repo, '.beads', 'backup');
  return {
    name,
    repo,
    issues: issueCount(repo),
    noDb,
    reachable: (r.ok || /Backup:/.test(out)) && !noDb,
    destination,
    hasDestination: !!destination,
    syncAgoH,
    internalAgoH,
    stale: destination ? (syncAgoH === null || syncAgoH > STALE_HOURS) : null,
    internalBytes: fs.existsSync(localBackupDir) ? dirSize(localBackupDir) : 0,
    error: r.timedOut ? 'bd backup status timed out'
      : (r.ok || noDb) ? null
      : (out.trim().split('\n')[0] || r.err),
    actions: [],
  };
}

const repos = discover();
const rows = [];
for (const repo of repos) {
  const row = inspect(repo);
  // In scope only when there is history to protect and a database to protect it
  // from. An explicit --repo overrides the rule: asking for a repo by name is
  // the user saying it matters.
  row.inScope = (ONLY.length > 0) || (row.issues >= MIN_ISSUES && !row.noDb);

  if (INIT && row.inScope && !row.hasDestination && row.reachable) {
    const dest = path.join(DEST_ROOT, row.name);
    if (DRY) {
      row.actions.push(`would configure destination -> ${dest}`);
    } else {
      try { fs.mkdirSync(dest, { recursive: true }); } catch { /* bd will report */ }
      const r = bd(['backup', 'init', `file://${dest}`], repo, 60000);
      if (r.ok) {
        row.hasDestination = true;
        row.destination = `file://${dest}`;
        row.actions.push(`configured -> ${dest}`);
      } else {
        row.actions.push(`init FAILED: ${(r.out || r.err || '').trim().split('\n')[0]}`);
        row.error = row.error || 'backup init failed';
      }
    }
  }

  if (SYNC && row.inScope && row.hasDestination) {
    if (DRY) {
      row.actions.push('would sync');
    } else {
      const t0 = Date.now();
      const r = bd(['backup', 'sync'], repo, 120000);
      const ms = Date.now() - t0;
      if (r.ok) { row.actions.push(`synced in ${ms}ms`); row.syncAgoH = 0; row.stale = false; }
      else {
        row.actions.push(`sync FAILED: ${(r.out || r.err || '').trim().split('\n')[0]}`);
        row.error = row.error || 'backup sync failed';
      }
    }
  }

  rows.push(row);
}

const mb = (b) => (b / 1024 / 1024).toFixed(1);
const scoped = rows.filter((r) => r.inScope);
const withDest = scoped.filter((r) => r.hasDestination);
const staleRows = withDest.filter((r) => r.stale);
const failed = rows.filter((r) => r.error);
const summary = {
  root: ROOT,
  destRoot: DEST_ROOT,
  repos: rows.length,
  minIssues: MIN_ISSUES,
  inScope: scoped.length,
  outOfScope: rows.length - scoped.length,
  protectedIssues: scoped.reduce((s, r) => s + r.issues, 0),
  withDestination: withDest.length,
  withoutDestination: scoped.length - withDest.length,
  staleOverHours: STALE_HOURS,
  stale: staleRows.length,
  errors: failed.length,
  dryRun: DRY,
};

if (AS_JSON) {
  process.stdout.write(JSON.stringify({ summary, repos: rows }, null, 2) + '\n');
} else {
  if (!QUIET) {
    console.log(`beads-dr — ${rows.length} beads repo(s) under ${ROOT}${DRY ? '  [DRY RUN]' : ''}`);
    console.log(`in scope: >=${MIN_ISSUES} issue(s) and a database present\n`);
    console.log('repo                             issues  dest   sync-age   internal-age  local(MB)');
    // Only in-scope repos are listed: printing 88 empty scaffolds buries the
    // ones that matter, and a report nobody reads protects nothing.
    for (const r of scoped.sort((a, b) => b.issues - a.issues)) {
      const age = r.syncAgoH === null ? '—' : `${r.syncAgoH.toFixed(1)}h`;
      const iage = r.internalAgoH === null ? '—' : `${r.internalAgoH.toFixed(0)}h`;
      console.log(
        r.name.padEnd(32),
        String(r.issues).padStart(6),
        ' ' + (r.hasDestination ? 'yes' : 'NO ').padEnd(6),
        (r.stale ? age + '!' : age).padStart(8),
        iage.padStart(13),
        mb(r.internalBytes).padStart(10));
      for (const a of r.actions) console.log(`    ${a}`);
      if (r.error) console.log(`    error: ${r.error}`);
    }
    const errsOutOfScope = rows.filter((r) => !r.inScope && r.error);
    for (const r of errsOutOfScope) console.log(`  (out of scope) ${r.name}: ${r.error}`);
    console.log('');
  }
  console.log(`  beads repos          : ${summary.repos}`);
  console.log(`  in scope             : ${summary.inScope}  (${summary.protectedIssues} issues)`);
  console.log(`  out of scope         : ${summary.outOfScope}  (no history, or no database)`);
  console.log(`  with destination     : ${summary.withDestination}`);
  console.log(`  WITHOUT destination  : ${summary.withoutDestination}`);
  console.log(`  stale (>${STALE_HOURS}h)         : ${summary.stale}`);
  console.log(`  errors               : ${summary.errors}`);
  if (!INIT && !SYNC) console.log(`\n  read-only audit. --init configures destinations, --sync pushes them.`);
  console.log(`\n  NOTE: a local backup survives DB corruption, NOT disk loss.`);
}

// Exit non-zero only on a real failure, so a scheduled run is silent when healthy.
process.exit(failed.length ? 1 : 0);
