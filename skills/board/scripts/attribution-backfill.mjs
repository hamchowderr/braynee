#!/usr/bin/env node
// Attribution backfill — work out, from Claude Code transcripts, which past
// beads changes Claude made, and record that next to beads' history.
//
// Before braynee's beads-actor-sign hook, every bd write an agent made was
// signed with the human's git user.name. The transcripts still hold each bd
// command Claude ran, with timestamps, so most of those events can be matched to
// the command that produced them.
//
// Nothing is rewritten. Dolt history is left exactly as it is; each match is
// appended to bd's provenance log (append-only, idempotent — re-running records
// nothing new), bound to the event's own id:
//   bd provenance record --issue <id> --kind used --source braynee-attribution-backfill
//     --ref-kind work-id --ref <event id> --actor claude[/<agent type>]
//     --payload {"backfill":true,"confidence":…,"directed_by":"<git user.name>","event":"<type>"}
// No session ids are written: repos that use beads may be public.
//
// Usage:
//   node attribution-backfill.mjs <repo> [--transcripts <dir>]... [--apply]
//        [--window <seconds>] [--min-confidence <0-1>] [--refresh] [--debug <id>] [--show-unmatched]
// Without --apply it is a dry run that prints what it would record.
// --transcripts defaults to the repo's own Claude Code project folder
// (~/.claude/projects/<slug>); pass it several times to add folders the work
// also ran from (a moved checkout, a session started elsewhere).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import { loadHistory, refreshIssue, backfillFor, BACKFILL_SOURCE } from './events.mjs';

const require = createRequire(import.meta.url);
const shell = require('../../../hooks/lib/shell-parse.js');

// ---- args ---------------------------------------------------------------
const argv = process.argv.slice(2);
const flags = (name) => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
const repoArg = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && ['--transcripts', '--window', '--debug', '--min-confidence'].includes(argv[i - 1])));
if (!repoArg || argv.includes('--help')) {
  console.log('usage: node attribution-backfill.mjs <repo> [--transcripts <dir>]... [--apply] [--window <s>] [--min-confidence <0-1>] [--refresh] [--debug <id>] [--show-unmatched]');
  process.exit(repoArg ? 0 : 1);
}
const REPO = resolve(repoArg);
const APPLY = argv.includes('--apply');
const REFRESH = argv.includes('--refresh');
const WINDOW_MS = (Number(flags('--window')[0]) || 120) * 1000;
const TIGHT_MS = 5000;
// Matches below this are counted but not recorded: a guess is worse than a gap.
const MIN_CONFIDENCE = Number(flags('--min-confidence')[0]) || 0.65;

const slug = (p) => p.replace(/[^A-Za-z0-9]/g, '-');
const transcriptDirs = flags('--transcripts').map(d => resolve(d));
if (!transcriptDirs.length) transcriptDirs.push(join(homedir(), '.claude', 'projects', slug(REPO)));

function run(cmd, args) {
  return execFileSync(cmd, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 });
}

// ---- beads side -----------------------------------------------------------
const issues = run('bd', ['export']).split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
if (!issues.length) { console.error('no issues exported'); process.exit(1); }
const prefixCounts = {};
for (const i of issues) { const p = i.id.replace(/-[a-z0-9]+(\.\d+)*$/i, ''); prefixCounts[p] = (prefixCounts[p] || 0) + 1; }
const PREFIX = Object.entries(prefixCounts).sort((a, b) => b[1] - a[1])[0][0];
const HUMAN = run('git', ['config', 'user.name']).trim();
const ID_RE = new RegExp(`\\b${PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[a-z0-9]+(?:\\.\\d+)*\\b`, 'gi');

// ---- transcripts ------------------------------------------------------------
// A transcript last written before the repo's first issue cannot hold its bd
// commands, so it is skipped unread — this keeps a large shared folder (a vault
// the work also ran from) cheap to include.
const FIRST_ISSUE_MS = Math.min(...issues.map(i => Date.parse(i.created_at)).filter(Number.isFinite));
const fresh = (p) => { try { return statSync(p).mtimeMs >= FIRST_ISSUE_MS; } catch { return false; } };

function listTranscripts(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name.endsWith('.jsonl')) { if (fresh(p)) out.push({ file: p, meta: null }); }
    else if (e.isDirectory()) {
      const sub = join(p, 'subagents');
      if (!existsSync(sub)) continue;
      for (const f of readdirSync(sub)) {
        if (!f.endsWith('.jsonl') || !fresh(join(sub, f))) continue;
        const metaFile = join(sub, f.replace(/\.jsonl$/, '.meta.json'));
        let meta = {};
        try { meta = JSON.parse(readFileSync(metaFile, 'utf8')); } catch {}
        out.push({ file: join(sub, f), meta });
      }
    }
  }
  return out;
}

const WRITE_VERBS = new Set(['create', 'q', 'update', 'close', 'reopen', 'comment', 'comments', 'note', 'dep', 'label',
  'set-state', 'defer', 'undefer', 'assign', 'promote', 'supersede', 'duplicate', 'rename', 'delete', 'edit', 'claim']);

const READ_VERBS = new Set(['show', 'list', 'ready', 'export', 'history', 'stats', 'search', 'query', 'count', 'prime',
  'memories', 'graph', 'blocked', 'status', 'doctor', 'preflight', 'sql', 'version', 'help', 'where', 'dolt', 'provenance',
  'remember', 'forget', 'config', 'hooks', 'init', 'setup', 'mol', 'formula', 'gate', 'audit', 'events', 'import', 'sync']);

// The bodies of every `$( … )` in a command, balanced, ignoring parentheses
// inside quotes (a bd create title or description often has some).
function substitutions(s) {
  const out = [];
  for (let i = s.indexOf('$('); i !== -1; i = s.indexOf('$(', i + 2)) {
    let depth = 0, q = null, j = i + 1;
    for (; j < s.length; j++) {
      const c = s[j];
      if (q) { if (c === q) q = null; else if (c === '\\' && q === '"') j++; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '(') depth++;
      else if (c === ')' && --depth === 0) break;
    }
    if (j < s.length) out.push(s.slice(i + 2, j));
  }
  return out;
}

// `timeout 60 bd …` is common in transcripts, and shell-parse does not treat
// timeout as a wrapper (its duration argument would read as the command).
function dropTimeout(a) {
  let i = 0;
  while (a[i] && shell.baseCmd(a[i]).toLowerCase() === 'timeout') {
    i++;
    while (a[i] && a[i].startsWith('-')) i += /^(-k|-s|--kill-after|--signal)$/.test(a[i]) ? 2 : 1;
    if (a[i] && /^\d+(\.\d+)?[smhd]?$/.test(a[i])) i++;
  }
  return a.slice(i);
}

// Commands that can write beads without a bd command of their own showing in
// the transcript: scripts that call bd (prd-seed and friends), and git
// operations that fire bd's git hooks (import/export on checkout, merge, pull).
const INDIRECT = /\b(bd|prd-seed|beads)\b|\.beads\b|\bgit\s+(checkout|switch|merge|pull|rebase|commit)\b/;

const safeType = (t) => String(t || 'subagent').replace(/[^A-Za-z0-9._:-]/g, '-');

/** Every bd write Claude ran, as { issue, actor, verb, tUse, tRes }. */
function collectCommands() {
  const cmds = [];
  const windows = [];
  let files = 0, scanned = 0, oldest = Infinity;
  for (const dir of transcriptDirs) {
    for (const t of listTranscripts(dir)) {
      files++;
      let text;
      try { text = readFileSync(t.file, 'utf8'); } catch { continue; }
      if (!text.includes(`${PREFIX}-`)) continue;
      scanned++;
      const actorBase = t.meta ? `claude/${safeType(t.meta.agentType)}` : 'claude';
      const uses = new Map();
      const results = new Map();
      for (const line of text.split('\n')) {
        if (!line) continue;
        let o; try { o = JSON.parse(line); } catch { continue; }
        const content = o.message && o.message.content;
        if (!Array.isArray(content)) continue;
        const ts = Date.parse(o.timestamp);
        if (Number.isFinite(ts) && ts < oldest) oldest = ts;
        for (const b of content) {
          if (b.type === 'tool_use' && (b.name === 'Bash' || b.name === 'PowerShell') && b.input && typeof b.input.command === 'string') {
            const actor = !t.meta && o.isSidechain ? 'claude/subagent' : actorBase;
            uses.set(b.id, { command: b.input.command, ts, actor });
          } else if (b.type === 'tool_result' && b.tool_use_id) {
            const c = typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '');
            results.set(b.tool_use_id, { ts, text: c });
          }
        }
      }
      for (const [id, u] of uses) {
        const res = results.get(id);
        const tRes = res ? res.ts : u.ts;
        // Every command that touches beads indirectly (a seeding script, a git
        // checkout that fires bd's hooks) is kept as a time window, for events
        // that no bd command in the transcript produced directly.
        if (INDIRECT.test(u.command)) windows.push({ actor: u.actor, tUse: u.ts, tRes });
        let argvs;
        // commandsIn() reads `id=$(bd create …)` as an assignment and skips it,
        // so command substitutions are parsed as commands of their own too.
        try {
          const text = shell.stripHeredocBodies(u.command);
          argvs = [text, ...substitutions(text)].flatMap(c => shell.commandsIn(c));
        } catch { continue; }
        for (const raw of argvs) {
          const a = dropTimeout(raw);
          if (!a.length || shell.baseCmd(a[0]).toLowerCase() !== 'bd') continue;
          // subcommands() keeps flag VALUES (`bd -C dir close`, `bd --actor x …`),
          // so take the first token that is a known bd verb, not simply the first.
          const sub = shell.subcommands(a);
          const at = sub.findIndex(s => WRITE_VERBS.has(s) || READ_VERBS.has(s));
          const verb = at === -1 ? '' : sub[at];
          if (!WRITE_VERBS.has(verb)) continue;
          if (verb === 'comments' && sub[at + 1] !== 'add') continue;
          const ids = new Set();
          for (const tok of a) for (const m of String(tok).matchAll(ID_RE)) ids.add(m[0].toLowerCase());
          if ((verb === 'create' || verb === 'q') && res) {
            // a batch may create several; every id the output names came from it
            for (const m of String(res.text).matchAll(ID_RE)) ids.add(m[0].toLowerCase());
          }
          for (const issue of ids) cmds.push({ issue, actor: u.actor, verb, tUse: u.ts, tRes });
        }
      }
    }
  }
  return { cmds, windows, files, scanned, oldest };
}

// Which bd verbs can produce which event types.
const VERB_EVENTS = {
  create: ['created'], q: ['created'],
  close: ['closed', 'status_changed', 'updated'],
  reopen: ['reopened', 'status_changed', 'updated'],
  update: ['updated', 'status_changed', 'claimed', 'assigned', 'priority_changed', 'title_changed'],
  claim: ['claimed', 'status_changed', 'updated'],
  note: ['updated'], label: ['label_added', 'label_removed', 'updated'],
  dep: ['dependency_added', 'dependency_removed', 'updated'],
  defer: ['status_changed', 'updated'], undefer: ['status_changed', 'updated'],
};
const verbFits = (verb, type) => !VERB_EVENTS[verb] || VERB_EVENTS[verb].includes(type);

// ---- match ----------------------------------------------------------------
const { cmds, windows, files, scanned, oldest } = collectCommands();
const byIssue = new Map();
for (const c of cmds) { if (!byIssue.has(c.issue)) byIssue.set(c.issue, []); byIssue.get(c.issue).push(c); }

const since = Number.isFinite(oldest) ? oldest - 86400000 : Infinity;
const candidates = issues.filter(i => Date.parse(i.updated_at) >= since);
process.stderr.write(`${PREFIX}: ${issues.length} issues, ${candidates.length} changed since the oldest transcript; reading their history…\n`);
const history = loadHistory(REPO, candidates, {
  prefix: PREFIX, refresh: REFRESH,
  onProgress: (d, n) => { if (d % 10 === 0 || d === n) process.stderr.write(`  ${d}/${n}\n`); },
});

// --debug <issue id>: print that issue's events and the bd commands found for it.
const DEBUG = flags('--debug')[0];
if (DEBUG) {
  const h = history.get(DEBUG);
  console.log('events:', JSON.stringify((h ? h.events : []).map(e => [e.type, e.actor, e.at])));
  console.log('commands:', JSON.stringify((byIssue.get(DEBUG.toLowerCase()) || []).map(c => [c.verb, c.actor, new Date(c.tUse).toISOString(), new Date(c.tRes).toISOString()])));
  console.log('oldest transcript:', new Date(oldest).toISOString());
}

const stats = { events: 0, humanSigned: 0, alreadySigned: 0, beforeTranscripts: 0, matched: 0, ambiguous: 0, unmatched: 0, alreadyRecorded: 0 };
const plan = [];
const unmatchedBy = {};
let unmatchedShown = 0;
for (const issue of candidates) {
  const h = history.get(issue.id) || { events: [], provenance: [] };
  const mine = byIssue.get(issue.id.toLowerCase()) || [];
  for (const e of h.events) {
    stats.events++;
    if (e.actor !== HUMAN) { stats.alreadySigned++; continue; }
    stats.humanSigned++;
    const recorded = Date.parse(e.at);
    if (backfillFor(h.provenance, e.id)) { stats.alreadyRecorded++; continue; }
    // Some bd versions stored event times in LOCAL time labelled as UTC, so an
    // event that matches nothing as written is tried again shifted by this
    // machine's UTC offset for that date. A shifted match scores a notch lower.
    const shift = new Date(recorded).getTimezoneOffset() * 60000;
    let found = null;
    for (const [t, penalty] of [[recorded, 0], [recorded + shift, 0.05]]) {
      if (!shift && penalty) continue;
      const tight = mine.filter(c => t >= c.tUse - TIGHT_MS && t <= c.tRes + TIGHT_MS);
      const loose = tight.length ? tight : mine.filter(c => Math.abs(t - c.tUse) <= WINDOW_MS || Math.abs(t - c.tRes) <= WINDOW_MS);
      if (!loose.length) continue;
      const fitting = loose.filter(c => verbFits(c.verb, e.type));
      const pool = fitting.length ? fitting : loose;
      found = { pool, penalty, tight: tight.length > 0, fits: fitting.length > 0 };
      break;
    }
    if (!found) {
      // Second chance: the event happened while exactly one actor had a
      // beads-touching command running. Weaker evidence, so a lower score.
      for (const [t, penalty] of [[recorded, 0], [recorded + shift, 0.05]]) {
        if (!shift && penalty) continue;
        const open = windows.filter(w => t >= w.tUse - TIGHT_MS && t <= w.tRes + TIGHT_MS);
        if (!open.length) continue;
        found = { pool: open, penalty, tight: false, fits: false, indirect: true };
        break;
      }
    }
    if (!found) {
      const t = recorded;
      if (!(t + Math.max(shift, 0) >= oldest)) { stats.beforeTranscripts++; continue; }
      if (argv.includes('--show-unmatched') && unmatchedShown++ < 15) {
        const near = mine.map(c => Math.round((c.tUse - t) / 1000)).sort((a, b) => Math.abs(a) - Math.abs(b))[0];
        console.log(`  unmatched ${issue.id} ${e.type} ${e.at} nearest command ${near === undefined ? 'none' : near + 's'}`);
      }
      stats.unmatched++;
      const k = `${e.type} ${e.at.slice(0, 7)}`;
      unmatchedBy[k] = (unmatchedBy[k] || 0) + 1;
      continue;
    }
    const actors = new Set(found.pool.map(c => c.actor));
    if (actors.size > 1) { stats.ambiguous++; continue; }
    const base = found.indirect ? 0.65 : found.tight ? (found.fits ? 0.95 : 0.8) : (found.fits ? 0.7 : 0.55);
    const confidence = Math.round((base - found.penalty) * 100) / 100;
    if (confidence < MIN_CONFIDENCE) { stats.weak = (stats.weak || 0) + 1; continue; }
    stats.matched++;
    if (found.penalty) stats.shifted = (stats.shifted || 0) + 1;
    if (found.indirect) stats.indirect = (stats.indirect || 0) + 1;
    plan.push({ issue, event: e, actor: [...actors][0], confidence, via: found.indirect ? 'command-window' : 'bd-command' });
  }
}

console.log(`\n${PREFIX} — transcripts: ${files} files, ${scanned} mention the prefix, ${cmds.length} bd writes found`);
console.log(`events read: ${stats.events} · signed by someone else already: ${stats.alreadySigned} · signed "${HUMAN}": ${stats.humanSigned}`);
console.log(`  of those: matched ${stats.matched} · ambiguous ${stats.ambiguous} · unmatched ${stats.unmatched} · before the oldest transcript ${stats.beforeTranscripts} · below --min-confidence ${stats.weak || 0} · already recorded ${stats.alreadyRecorded}${stats.shifted ? ` (${stats.shifted} matched after correcting a local-time timestamp)` : ""}${stats.indirect ? ` · ${stats.indirect} matched to a running script or git command rather than a bd command` : ''}`);
console.log('  unmatched by type and month:', JSON.stringify(Object.fromEntries(Object.entries(unmatchedBy).sort((a, b) => b[1] - a[1]))));
const byActor = {};
for (const p of plan) byActor[p.actor] = (byActor[p.actor] || 0) + 1;
console.log('  matched by actor:', JSON.stringify(byActor));
const byConf = {};
for (const p of plan) byConf[p.confidence] = (byConf[p.confidence] || 0) + 1;
console.log('  matched by confidence:', JSON.stringify(byConf));

if (!APPLY) { console.log('\ndry run — nothing recorded. Re-run with --apply to record.'); process.exit(0); }

let ok = 0, failed = 0;
const touched = new Map();
for (const p of plan) {
  const payload = JSON.stringify({ backfill: true, confidence: p.confidence, directed_by: HUMAN, event: p.event.type, via: p.via });
  try {
    execFileSync('bd', ['provenance', 'record', '--issue', p.issue.id, '--kind', 'used', '--source', BACKFILL_SOURCE,
      '--ref-kind', 'work-id', '--ref', p.event.id, '--actor', p.actor, '--payload', payload], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, BD_EXPORT_AUTO: 'false', BEADS_ACTOR: 'claude' },
    });
    ok++;
    touched.set(p.issue.id, p.issue);
  } catch (err) {
    failed++;
    process.stderr.write(`  failed ${p.issue.id} ${p.event.id}: ${String(err.stderr || err.message).split('\n')[0]}\n`);
  }
  if ((ok + failed) % 25 === 0) process.stderr.write(`  recorded ${ok + failed}/${plan.length}\n`);
}
for (const issue of touched.values()) refreshIssue(REPO, PREFIX, issue);
console.log(`\nrecorded ${ok}, failed ${failed}`);
process.exit(failed ? 1 : 0);
