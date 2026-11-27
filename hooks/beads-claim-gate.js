// beads-claim-gate.js
// Hook: PreToolUse (Bash|PowerShell) — refuse to START work on an issue that has
// no written plan.
//
// An issue is claimed with `bd update <id> --claim`, `bd update <id> --status
// in_progress` (`-s in_progress`, `--status=in_progress`), or `bd ready --claim`,
// which claims the first ready issue. Before any of those runs, this hook asks
// bd itself whether the issue carries the sections its type requires —
// `bd lint <id> --json` — and blocks the claim (exit 2) when lint reports a gap.
//
// bd owns the section rules; nothing here re-implements them. As of bd 1.3.0:
//   task / feature / story  Acceptance Criteria
//   bug                     Steps to Reproduce + Acceptance Criteria
//   epic                    Success Criteria (or Acceptance Criteria)
//   decision                Decision + Rationale + Alternatives Considered
//   spike                   Goal (+ Findings, which is ignored here — see below)
//   chore / milestone       nothing, so they are never blocked
// plus anything a repo adds with `bd config set lint.sections.<type> "..."`.
// A structured `--acceptance` field satisfies the Acceptance/Success check.
//
// One braynee-specific check sits beside lint: an issue whose acceptance is
// still the PRD line prd-seed wrote (SEEDED_ACCEPTANCE_PREFIX) passes lint but
// has never been authored, so it is blocked too (`bd show <ids> --json`).
//
// Execution metadata (cp-hffh): every issue, chores and epics included, must carry
// the four dispatch keys in REQUIRED_METADATA before it is claimed, because a
// subagent can't change its model or effort once launched. Keys the claiming
// command sets itself (--set-metadata k=v, --metadata '{...}') count. A
// `bd create` without them gets a non-blocking reminder, not a block.
//
// Fails OPEN: if bd is missing, errors, times out, prints something that is not
// JSON, or does not know the id, the claim goes through. This gate exists to stop
// a plan-less claim, never to stand between the user and a broken bd.
//
// Escape hatch: BRAYNEE_CLAIM_GATE=off.
//
// Self-gates in JS (never the hooks.json `if` field — version-unreliable): a
// command that does not claim exits 0 before bd is ever spawned.

'use strict';

const path = require('path');
const bdJsonLib = require(path.join(__dirname, 'lib', 'bd-json.js'));
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const payload = require(path.join(__dirname, 'lib', 'hook-payload.js'));
const { splitSegments, tokenize, baseCmd, stripHeredocBodies } = require(path.join(__dirname, 'lib', 'shell-parse.js'));
const { toNativePath } = require(path.join(__dirname, 'lib', 'git-command.js'));
const { runBdSafe } = require(path.join(__dirname, 'lib', 'bd-safe.js'));
const { makeBudget } = require(path.join(__dirname, 'lib', 'time-budget.js'));
const { SEEDED_ACCEPTANCE_PREFIX } = require(path.join(__dirname, '..', 'scripts', 'lib', 'prd-seed-core.js'));

const HOOK = 'beads-claim-gate';

const REQUIRED_METADATA = ['execution_agent_type', 'execution_suggested_model', 'execution_reasoning_effort', 'execution_mode'];

// Metadata keys a command writes itself: every --set-metadata k=v, plus the keys
// of a --metadata JSON object. An unparsable --metadata value supplies nothing.
function suppliedMetadata(setList, metadataJson) {
  const keys = new Set();
  for (const kv of setList) { const k = String(kv).split('=')[0].trim(); if (k) keys.add(k); }
  if (typeof metadataJson === 'string' && metadataJson.trim()) {
    try {
      const o = JSON.parse(metadataJson);
      if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) if (v !== '' && v != null) keys.add(k);
    } catch { /* unparsable --metadata supplies no keys; the gate then names them all */ }
  }
  return keys;
}

// A bd id: prefix, then one or more -segments, then optional .child suffixes.
// Tokens that merely look like one (a hyphenated --title value) are harmless:
// bd lint skips ids it does not know, and an unknown id is allowed through.
const ID_RE = /^[a-z][a-z0-9_]*(?:-[a-z0-9_]+)+(?:\.[a-z0-9]+)*$/i;

// bd update / bd ready flags that take NO value. Every other flag consumes the
// next token (unless written --flag=value), so its value is not read as an id.
const BOOL_FLAGS = new Set([
  '--claim', '--force', '--json', '-q', '--quiet', '-v', '--verbose', '--readonly',
  '--sandbox', '--no-color', '--global', '--ignore-schema-skew', '--cpu-profile',
  '--allow-empty-description', '--ephemeral', '--persistent', '--history',
  '--no-history', '--stdin', '-h', '--help',
  // bd ready
  '-u', '--unassigned', '--brief', '--gated', '--explain', '--include-deferred',
]);

// Sections the gate never blocks on. A spike's Findings are written when the
// spike ENDS ("fill in when complete"), so demanding them at claim time would
// make every spike unclaimable.
const IGNORED_SECTIONS = new Set(['findings']);

// Global bd flags that change which repo the command runs in.
const DIR_FLAGS = new Set(['-C', '--directory']);

function sectionName(heading) {
  return String(heading || '').replace(/^#+\s*/, '').trim();
}

// ── Pure: what does this command claim? ──────────────────────────────────────
//
// Returns a list of claims, one per claiming bd invocation:
//   { kind: 'update', ids: [...], dir, supplies: { acceptance, description, text } }
//   { kind: 'ready',  readyArgs: [...], dir }
// `dir` is the directory bd runs in (a `cd` earlier in the command, or -C), or
// null for the hook's cwd. `supplies` records sections the SAME command writes,
// so `bd update x --claim --acceptance "..."` is not blocked for lacking them.
function parseClaims(command, cwd) {
  const claims = [];
  if (!command || !/\bbd(?:\.exe)?\b/i.test(command)) return claims;
  const parts = splitSegments(stripHeredocBodies(command));
  let dir = null;
  for (let s = 0; s < parts.length; s += 2) {
    const toks = tokenize(String(parts[s]).trim());
    let i = 0;
    while (i < toks.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[i])) i++;
    const argv = toks.slice(i);
    if (!argv.length) continue;
    const exe = baseCmd(argv[0]).toLowerCase();

    if ((exe === 'cd' || exe === 'set-location' || exe === 'pushd' || exe === 'sl') && argv[1]) {
      const target = argv[1] === '-Path' || argv[1] === '-LiteralPath' ? argv[2] : argv[1];
      if (target) dir = path.resolve(dir || cwd || process.cwd(), toNativePath(target));
      continue;
    }
    if (exe !== 'bd') continue;

    // Global flags may precede the subcommand: `bd -C ../x update ...`.
    let segDir = dir;
    let j = 1;
    let sub = null;
    for (; j < argv.length; j++) {
      const t = argv[j];
      if (DIR_FLAGS.has(t)) { segDir = path.resolve(dir || cwd || process.cwd(), toNativePath(argv[j + 1] || '.')); j++; continue; }
      const eq = /^(?:-C|--directory)=(.*)$/.exec(t);
      if (eq) { segDir = path.resolve(dir || cwd || process.cwd(), toNativePath(eq[1])); continue; }
      if (t.startsWith('-')) { if (!BOOL_FLAGS.has(t) && !t.includes('=')) j++; continue; }
      sub = t.toLowerCase();
      break;
    }
    if (sub !== 'update' && sub !== 'ready') continue;

    const rest = argv.slice(j + 1);
    const ids = [];
    const flags = {};
    const positional = [];
    const setMeta = [];
    for (let k = 0; k < rest.length; k++) {
      const t = rest[k];
      if (t.startsWith('-') && t.length > 1) {
        const m = /^(--?[^=]+)=(.*)$/s.exec(t);
        if (m) { if (m[1] === '--set-metadata') setMeta.push(m[2]); flags[m[1]] = m[2]; continue; }
        if (t === '--set-metadata') { setMeta.push(rest[k + 1] || ''); k++; continue; }
        if (DIR_FLAGS.has(t)) { segDir = path.resolve(dir || cwd || process.cwd(), toNativePath(rest[k + 1] || '.')); k++; continue; }
        if (BOOL_FLAGS.has(t)) { flags[t] = true; continue; }
        flags[t] = rest[k + 1] === undefined ? '' : rest[k + 1];
        k++;
        continue;
      }
      positional.push(t);
      if (ID_RE.test(t)) ids.push(t);
    }

    const status = String(flags['--status'] ?? flags['-s'] ?? '').toLowerCase();
    const claiming = flags['--claim'] === true || status === 'in_progress';
    if (!claiming) continue;

    if (sub === 'update') {
      if (!ids.length) continue;
      const desc = flags['--description'] ?? flags['-d'];
      claims.push({
        kind: 'update',
        ids,
        dir: segDir,
        supplies: {
          acceptance: typeof flags['--acceptance'] === 'string' && flags['--acceptance'].trim() !== '',
          // A description from a file or stdin cannot be read here — trust it.
          opaqueDescription: flags['--body-file'] !== undefined || flags['--stdin'] === true,
          description: typeof desc === 'string' ? desc : '',
          metadata: suppliedMetadata(setMeta, flags['--metadata']),
        },
      });
    } else if (flags['--claim'] === true) {
      // bd ready --claim takes the FIRST ready issue matching its filters. Ask
      // bd ready the same question without --claim to learn which one that is.
      const readyArgs = [];
      for (let k = 0; k < rest.length; k++) {
        const t = rest[k];
        if (t === '--claim' || t === '--json') continue;
        if (DIR_FLAGS.has(t)) { k++; continue; }
        readyArgs.push(t);
      }
      claims.push({ kind: 'ready', readyArgs, dir: segDir });
    }
  }
  return claims;
}

// ── Pure: which lint findings actually block? ────────────────────────────────
//
// `lint` is parsed `bd lint --json` output; `supplies` is what the claiming
// command itself writes. Returns [{ id, type, title, missing: [section, ...] }].
function blockingFindings(lint, supplies = {}) {
  const out = [];
  const results = (lint && Array.isArray(lint.results)) ? lint.results : [];
  for (const r of results) {
    if (!r || !r.id) continue;
    const missing = (Array.isArray(r.missing) ? r.missing : [])
      .map(sectionName)
      .filter(Boolean)
      .filter((name) => !IGNORED_SECTIONS.has(name.toLowerCase()))
      .filter((name) => {
        if (supplies.opaqueDescription) return false;
        if (supplies.acceptance && /^(acceptance|success) criteria$/i.test(name)) return false;
        if (supplies.description && new RegExp('^#+\\s*' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*$', 'im').test(supplies.description)) return false;
        return true;
      });
    if (missing.length) out.push({ id: r.id, type: r.type || '', title: r.title || '', missing });
  }
  return out;
}

// ── Pure: seeded stubs that lint cannot see ──────────────────────────────────
//
// prd-seed records each PRD line as the issue's acceptance so the create passes
// validation.on-create=error. That satisfies lint, but the issue is still a
// one-line stub with no Design. The prefix is braynee's own marker for "seeded,
// not yet enriched" (scripts/lib/prd-seed-core.js), so an issue still carrying
// it is blocked like any other issue without a plan.
//
// `issues` is parsed `bd show <ids> --json`. Returns findings in the
// blockingFindings shape.
function seededStubFindings(issues, supplies = {}) {
  if (supplies.acceptance || supplies.opaqueDescription) return [];
  const out = [];
  for (const i of Array.isArray(issues) ? issues : []) {
    if (!i || !i.id) continue;
    if (!String(i.acceptance_criteria || '').startsWith(SEEDED_ACCEPTANCE_PREFIX)) continue;
    const missing = ['Acceptance Criteria (still the seeded PRD line)'];
    if (!String(i.design || '').trim()) missing.unshift('Design');
    out.push({ id: i.id, type: i.issue_type || '', title: i.title || '', missing });
  }
  return out;
}

// ── Pure: execution metadata the issue lacks ─────────────────────────────────
//
// `issues` is parsed `bd show <ids> --json`. A key counts when the issue already
// has a non-empty value or the claiming command sets it.
function metadataFindings(issues, supplies = {}) {
  const given = supplies.metadata instanceof Set ? supplies.metadata : new Set();
  const out = [];
  for (const i of Array.isArray(issues) ? issues : []) {
    if (!i || !i.id) continue;
    const md = (i.metadata && typeof i.metadata === 'object') ? i.metadata : {};
    const lacking = REQUIRED_METADATA.filter((k) => !given.has(k) && (md[k] === undefined || md[k] === null || String(md[k]).trim() === ''));
    if (lacking.length) out.push({ id: i.id, type: i.issue_type || '', title: i.title || '', missing: lacking.map((k) => `metadata ${k}`) });
  }
  return out;
}

// Pure: does this command create an issue without the required metadata? Returns
// the missing keys ([] when none are missing or the command creates nothing).
function createMissingMetadata(command) {
  if (!command || !/\bbd(?:\.exe)?\b/i.test(command)) return [];
  const parts = splitSegments(stripHeredocBodies(command));
  for (let p = 0; p < parts.length; p += 2) {
    const argv = tokenize(String(parts[p]).trim());
    let i = 0;
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) i++;
    if (baseCmd(argv[i] || '').toLowerCase() !== 'bd' || String(argv[i + 1] || '').toLowerCase() !== 'create') continue;
    const setMeta = [];
    let mdJson;
    for (let k = i + 2; k < argv.length; k++) {
      const t = argv[k];
      const m = /^(--set-metadata|--metadata)=(.*)$/s.exec(t);
      if (m) { if (m[1] === '--metadata') mdJson = m[2]; else setMeta.push(m[2]); continue; }
      if (t === '--metadata') { mdJson = argv[k + 1]; k++; continue; }
      if (t === '--set-metadata') { setMeta.push(argv[k + 1] || ''); k++; }
    }
    const have = suppliedMetadata(setMeta, mdJson);
    const lacking = REQUIRED_METADATA.filter((key) => !have.has(key));
    if (lacking.length) return lacking;
  }
  return [];
}

// One finding per id, sections merged, so lint and the seeded check never
// report the same issue twice.
function mergeFindings(list) {
  const byId = new Map();
  for (const f of list) {
    const cur = byId.get(f.id);
    if (!cur) { byId.set(f.id, { ...f, missing: [...f.missing] }); continue; }
    for (const m of f.missing) if (!cur.missing.includes(m)) cur.missing.push(m);
  }
  return [...byId.values()];
}

// ── Pure: the message the agent sees ─────────────────────────────────────────
function blockMessage(findings) {
  const all = [...new Set(findings.flatMap((f) => f.missing))];
  const sections = all.filter((n) => !n.startsWith('metadata '));
  const lines = [sections.length
    ? 'BLOCKED by braynee claim gate: fill Design/Acceptance before starting work.'
    : 'BLOCKED by braynee claim gate: set the execution metadata before starting work.', ''];
  for (const f of findings) {
    lines.push(`${f.id}${f.type ? ` [${f.type}]` : ''}${f.title ? ` "${f.title}"` : ''} is missing: ${f.missing.join(', ')}`);
  }
  lines.push('');
  const id = findings.length === 1 ? findings[0].id : '<id>';
  if (sections.length) lines.push(`Fix: bd update ${id} --design "<how + trade-off>" --acceptance "<verifiable outcomes>"`);
  const other = sections.filter((n) => !/^(acceptance|success) criteria\b/i.test(n) && n !== 'Design');
  if (other.length) {
    lines.push(`     ${other.map((n) => `"## ${n}"`).join(', ')} must be a heading in the description ` +
      `(bd update ${id} --description "...").`);
  }
  const metaLacking = [...new Set(findings.flatMap((f) => f.missing).filter((n) => n.startsWith('metadata ')).map((n) => n.slice(9)))];
  if (metaLacking.length) {
    lines.push(`Metadata: bd update ${id} ${metaLacking.map((k) => `--set-metadata ${k}=<value>`).join(' ')}`);
    lines.push('     (agent type, opus|sonnet|haiku, low|medium|high, autonomous|review|plan: see the beads-ops rule)');
  }
  lines.push('Then run the claim again. For a whole seeded backlog, dispatch the braynee:beads-enricher agent.');
  lines.push('Chores need no sections, but every issue needs the metadata. To disable this gate: BRAYNEE_CLAIM_GATE=off.');
  return lines.join('\n');
}

// ── I/O ──────────────────────────────────────────────────────────────────────

// One bd lint call per claim; the budget is shared so several claims in one
// command cannot outlive the hook's hooks.json timeout (cp-szoa).
const BUDGET_MS = 7_000;

function bdJson(cmd, cwd, budget) {
  const timeout = budget.allow(6_000);
  if (timeout === null) return null;
  const r = runBdSafe(cmd, { cwd, timeout });
  if (!r.ok) return null;
  try { return bdJsonLib.parse(r.out || 'null'); } catch { return null; }
}

const q = (s) => JSON.stringify(String(s));

function lintIds(ids, cwd, budget) {
  return bdJson(`bd lint ${ids.join(' ')} --status all --json`, cwd, budget);
}

function predictReadyId(readyArgs, cwd, budget) {
  const list = bdJson(`bd ready ${readyArgs.map(q).join(' ')} --json --limit 1`.replace(/\s+/g, ' '), cwd, budget);
  return Array.isArray(list) && list[0] && list[0].id ? list[0].id : null;
}

async function main() {
  try {
    if ((process.env.BRAYNEE_CLAIM_GATE || '').toLowerCase() === 'off') process.exit(0);
    const p = await payload.read();
    if (p.tool && p.tool !== 'Bash' && p.tool !== 'PowerShell') process.exit(0);
    const command = String(p.toolInput.command || '');
    const createLacking = createMissingMetadata(command);
    const claims = parseClaims(command, p.cwd);
    if (!claims.length) {
      if (createLacking.length) {
        payload.emitContext(`braynee: this bd create sets no ${createLacking.join(', ')}. Every issue needs the four execution metadata keys (beads-ops rule); add --metadata '{...}' now, or the claim gate will refuse the claim.`, 'PreToolUse');
      }
      process.exit(0);
    }

    const budget = makeBudget(BUDGET_MS);
    const findings = [];
    for (const c of claims) {
      const cwd = c.dir || p.cwd;
      let ids = c.ids;
      if (c.kind === 'ready') {
        const id = predictReadyId(c.readyArgs, cwd, budget);
        if (!id) continue;                       // nothing ready, or bd failed: allow
        ids = [id];
      }
      if (!ids.every((id) => ID_RE.test(id))) continue;
      const lint = lintIds(ids, cwd, budget);
      if (lint) findings.push(...blockingFindings(lint, c.supplies || {}));
      const shown = bdJson(`bd show ${ids.join(' ')} --json`, cwd, budget);
      if (shown) {
        const list = Array.isArray(shown) ? shown : [shown];
        findings.push(...seededStubFindings(list, c.supplies || {}));
        findings.push(...metadataFindings(list, c.supplies || {}));
      }
      // Either call failing (bd errored / timed out) simply contributes nothing: fail open.
    }

    const merged = mergeFindings(findings);
    if (!merged.length) process.exit(0);
    log.warn(HOOK, `blocked claim of ${merged.map((f) => f.id).join(', ')} (missing sections or metadata)`);
    payload.block(blockMessage(merged));
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0); // never break the tool call
  }
}

if (require.main === module) main();

module.exports = { parseClaims, blockingFindings, seededStubFindings, metadataFindings, createMissingMetadata,
  suppliedMetadata, mergeFindings, blockMessage, ID_RE, REQUIRED_METADATA };
