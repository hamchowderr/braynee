#!/usr/bin/env node
/**
 * beads-dolthub.mjs — OPTIONAL off-machine sync of beads to DoltHub (cp-3tk).
 *
 * braynee is local-first. Nothing calls this script; no hook, skill or feature
 * needs it; it changes nothing unless run with --enable / --push / --disable
 * and an explicit set of repos. beads-dr.mjs covers corruption with a LOCAL
 * backup; this is the tier above it, for users who want a copy that survives
 * losing the disk, or one database shared across machines.
 *
 * Per project: each beads repo gets its own DoltHub database under an owner
 * YOU name (--owner). No account is assumed.
 *
 * One-time credentials, then everything is non-interactive:
 *   dolt login                      # opens a browser once, stores a key
 *   export DOLTHUB_API_TOKEN=...    # only needed to CREATE databases
 *                                   # (dolthub.com > Settings > Tokens)
 *
 * Usage:
 *   node scripts/beads-dolthub.mjs                         # audit, read-only
 *   node scripts/beads-dolthub.mjs --enable --owner <o> --repo <name>...
 *   node scripts/beads-dolthub.mjs --enable --owner <o> --all     # every repo with issues
 *   node scripts/beads-dolthub.mjs --push [--repo <name>...]       # push wired repos
 *   node scripts/beads-dolthub.mjs --disable --repo <name>         # unwire locally
 *     [--auto-push] [--public] [--root <dir>] [--dry-run] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('./lib/dolthub-sync-core.js');
const { getProjectsDir } = require('./lib/projects-root.js');
const bdJsonLib = require('../hooks/lib/bd-json.js');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const multi = (n) => { const o = []; for (let i = 0; i < argv.length; i++) if (argv[i] === n && argv[i + 1]) o.push(argv[i + 1]); return o; };

if (flag('--help') || flag('-h')) {
  console.log(`beads-dolthub — optional off-machine beads sync to DoltHub (cp-3tk)

  (no action)        audit: which repos have a DoltHub origin, read-only
  --enable           create the DoltHub database (if DOLTHUB_API_TOKEN is set),
                     \`bd dolt remote add origin\`, then \`bd dolt push\`
  --push             \`bd dolt push\` every selected repo that has a DoltHub origin
  --disable          \`bd dolt remote remove origin\` (DoltHub data is kept)

  --owner <name>     DoltHub user or org (required for --enable; nothing is assumed)
  --repo <name>      a repo folder under the projects root (repeatable)
  --all              with --enable/--push: every repo that has at least one issue
  --auto-push        also set dolt.auto-push=true (bd pushes after writes). Only
                     safe with ONE writer per database: bd warns that concurrent
                     pushes can corrupt a remote.
  --public           create public databases (default private)
  --root <dir>       projects root (default: BRAYNEE_PROJECTS_DIR, else ~/code)
  --dry-run          say what would happen, change nothing
  --json             machine-readable output

Repos with dolt.local-only set, or an origin pointing elsewhere, are never touched.`);
  process.exit(0);
}

const ROOT = path.resolve(opt('--root', getProjectsDir()));
const ONLY = multi('--repo');
const ENABLE = flag('--enable');
const PUSH = flag('--push');
const DISABLE = flag('--disable');
const ALL = flag('--all');
const DRY = flag('--dry-run');
const AS_JSON = flag('--json');
const AUTO_PUSH = flag('--auto-push');
const VISIBILITY = flag('--public') ? 'public' : 'private';
const OWNER = opt('--owner');

const mutating = ENABLE || PUSH || DISABLE;
function die(msg) { console.error(`beads-dolthub: ${msg}`); process.exit(2); }
if ([ENABLE, PUSH, DISABLE].filter(Boolean).length > 1) die('pick one of --enable, --push, --disable');
if (mutating && !ONLY.length && !(ALL && !DISABLE)) die('name the repos: --repo <name> (repeatable), or --all with --enable/--push');
if (ENABLE && !core.validOwner(OWNER)) die('--enable needs --owner <dolthub user or org>');

function run(cmd, args, cwd, timeoutMs = 120000) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: timeoutMs, windowsHide: true, shell: false });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim(), missing: r.error && r.error.code === 'ENOENT' };
}
const bd = (args, cwd, t) => run('bd', args, cwd, t);

function configValue(repo, key) {
  const r = bd(['config', 'get', key, '--json'], repo, 30000);
  if (!r.ok) return '';
  try { const v = bdJsonLib.parse(r.out); return String((v && v.value) ?? ''); } catch { return ''; }
}

function issueCount(repo) {
  const r = bd(['stats', '--json'], repo, 60000);
  try {
    const v = bdJsonLib.parse(r.out.slice(r.out.indexOf('{')));
    const n = v && v.summary ? v.summary.total_issues : null;
    return typeof n === 'number' ? n : null;
  } catch { return null; }
}

function inspect(repo) {
  const remotes = core.parseRemotes(bd(['dolt', 'remote', 'list'], repo, 30000).out);
  const origin = (remotes.find((x) => x.name === 'origin') || {}).url || null;
  return {
    repo: path.basename(repo),
    dir: repo,
    origin,
    dolthub: core.dolthubTarget(origin),
    localOnly: /^(true|1|yes)$/i.test(configValue(repo, 'dolt.local-only')),
    autoPush: /^(true|1|yes)$/i.test(configValue(repo, 'dolt.auto-push')),
  };
}

function discover() {
  let entries = [];
  try { entries = fs.readdirSync(ROOT, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => path.join(ROOT, e.name))
    .filter((p) => fs.existsSync(path.join(p, '.beads')))
    .filter((p) => (ONLY.length ? ONLY.includes(path.basename(p)) : true));
}

async function createDatabase(owner, name) {
  const token = process.env.DOLTHUB_API_TOKEN;
  if (!token) return { ok: false, skipped: true, msg: 'DOLTHUB_API_TOKEN not set: create the database on dolthub.com first' };
  const res = await fetch('https://www.dolthub.com/api/v1alpha1/database', {
    method: 'POST',
    headers: { authorization: `token ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(core.createDatabaseBody(owner, name, VISIBILITY)),
  });
  let body = {};
  try { body = await res.json(); } catch { /* non-JSON error page; the status code says enough */ }
  if (res.ok && body.status === 'Success') return { ok: true, msg: `created ${owner}/${name} (${VISIBILITY})` };
  // An existing database is fine: we only need it to exist.
  const text = JSON.stringify(body);
  if (/already exists/i.test(text)) return { ok: true, msg: `${owner}/${name} already exists` };
  return { ok: false, msg: `create failed (HTTP ${res.status}): ${body.message || text.slice(0, 200)}` };
}

function haveDoltCreds() {
  const r = run('dolt', ['creds', 'ls'], process.cwd(), 15000);
  return r.ok && /\S/.test(r.out);
}

const results = [];
const note = (repo, status, msg) => { results.push({ repo, status, msg }); if (!AS_JSON) console.log(`  ${status.padEnd(8)} ${repo}: ${msg}`); };

async function main() {
  if (bd(['version'], process.cwd(), 15000).missing) die('bd is not on PATH');
  if (!AS_JSON) console.log(`beads-dolthub: ${mutating ? (ENABLE ? 'enable' : PUSH ? 'push' : 'disable') : 'audit'} under ${ROOT}${DRY ? ' (dry run)' : ''}`);
  const repos = discover();
  if (!repos.length) die(`no beads repos found under ${ROOT}${ONLY.length ? ` matching ${ONLY.join(', ')}` : ''}`);
  if (ONLY.length) {
    const found = new Set(repos.map((r) => path.basename(r)));
    for (const name of ONLY) if (!found.has(name)) note(name, 'missing', `no ${path.join(ROOT, name, '.beads')}`);
  }
  if ((ENABLE || PUSH) && !DRY && !haveDoltCreds()) die('no Dolt credentials: run `dolt login` once (or `dolt creds import`)');


  for (const dir of repos) {
    const s = inspect(dir);
    if (!mutating) {
      note(s.repo, s.dolthub ? 'dolthub' : s.origin ? 'other' : 'local',
        s.dolthub ? `${s.dolthub.owner}/${s.dolthub.name}${s.autoPush ? ' · auto-push on' : ''}`
          : s.origin ? `origin ${s.origin}` : (s.localOnly ? 'local-only (set by user)' : 'no remote'));
      continue;
    }
    if (ALL && !ONLY.length && (ENABLE || PUSH)) {
      const n = issueCount(dir);
      if (!n) { note(s.repo, 'skip', 'no issues to protect'); continue; }
    }

    if (DISABLE) {
      if (!s.dolthub) { note(s.repo, 'skip', 'no DoltHub origin'); continue; }
      if (DRY) { note(s.repo, 'would', `remove origin ${s.origin}`); continue; }
      const r = bd(['dolt', 'remote', 'remove', 'origin'], dir);
      note(s.repo, r.ok ? 'disabled' : 'error', r.ok ? 'origin removed locally; the DoltHub database is untouched' : r.out.split('\n')[0]);
      continue;
    }

    if (PUSH) {
      if (!s.dolthub) { note(s.repo, 'skip', 'no DoltHub origin (use --enable)'); continue; }
      if (DRY) { note(s.repo, 'would', `bd dolt push -> ${s.dolthub.owner}/${s.dolthub.name}`); continue; }
      const r = bd(['dolt', 'push'], dir, 600000);
      note(s.repo, r.ok ? 'pushed' : 'error', r.ok ? `${s.dolthub.owner}/${s.dolthub.name}` : r.out.split('\n').slice(-1)[0]);
      continue;
    }

    // ENABLE
    const name = core.dolthubName(s.repo);
    const plan = core.planEnable(s, OWNER, name);
    if (plan.action === 'skip') { note(s.repo, 'skip', plan.reason); continue; }
    if (DRY) {
      note(s.repo, 'would', plan.action === 'already'
        ? `push to ${OWNER}/${name}${AUTO_PUSH ? ', set dolt.auto-push=true' : ''}`
        : `create ${OWNER}/${name} (${VISIBILITY}), add origin ${plan.url}, push${AUTO_PUSH ? ', set dolt.auto-push=true' : ''}`);
      continue;
    }
    if (plan.action === 'wire') {
      const c = await createDatabase(OWNER, name);
      if (!c.ok && !c.skipped) { note(s.repo, 'error', c.msg); continue; }
      if (c.skipped && !AS_JSON) console.log(`  note     ${s.repo}: ${c.msg}`);
      const add = bd(['dolt', 'remote', 'add', 'origin', plan.url], dir);
      if (!add.ok) { note(s.repo, 'error', `remote add failed: ${add.out.split('\n')[0]}`); continue; }
    }
    const push = bd(['dolt', 'push'], dir, 600000);
    if (!push.ok) { note(s.repo, 'error', `wired, but the first push failed: ${push.out.split('\n').slice(-1)[0]}`); continue; }
    if (AUTO_PUSH) bd(['config', 'set', 'dolt.auto-push', 'true'], dir);
    note(s.repo, 'enabled', `${OWNER}/${name}${AUTO_PUSH ? ' · auto-push on (single writer only)' : ' · push with --push or bd dolt push'}`);
  }

  if (AS_JSON) console.log(JSON.stringify({ root: ROOT, dryRun: DRY, results }, null, 2));
  process.exit(results.some((r) => r.status === 'error' || r.status === 'missing') ? 1 : 0);
}

main().catch((e) => { console.error(`beads-dolthub: ${e && e.message ? e.message : e}`); process.exit(1); });
