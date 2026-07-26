#!/usr/bin/env node
// qmd-wrapper.mjs — cross-platform wrapper for QMD (Query Markup Documents)
//
// Locates the QMD JS source in the global npm modules and invokes node on it
// directly. This avoids the platform-specific shim issues (the npm-installed
// `qmd` shim depends on /bin/sh which is not in cmd.exe's PATH on Windows).
//
// Requires: `npm i -g @tobilu/qmd`
//
// Usage: node qmd-wrapper.mjs <command> [args...]
//   node qmd-wrapper.mjs search "supabase RLS"
//   node qmd-wrapper.mjs vsearch "auth flow decisions"
//   node qmd-wrapper.mjs query "what did we decide about ..."
//   node qmd-wrapper.mjs get "1. Projects/Minions.md"

import { execSync, spawnSync } from 'child_process';
import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

function findQmdJs() {
  // Try `npm root -g` to locate the global modules dir
  let globalRoot;
  try {
    globalRoot = execSync('npm root -g', { encoding: 'utf8', windowsHide: true }).trim();
  } catch {
    return null;
  }
  const qmdPath = join(globalRoot, '@tobilu', 'qmd', 'dist', 'cli', 'qmd.js');
  return existsSync(qmdPath) ? qmdPath : null;
}

const qmdJs = findQmdJs();
if (!qmdJs) {
  process.stderr.write(
    `qmd not found. Install with: npm i -g @tobilu/qmd\n`
  );
  process.exit(127);
}

// ---------------------------------------------------------------------------
// qmd:// slug -> real filesystem path
//
// qmd reports each hit as a qmd:// virtual path whose segments are slugified:
// spaces, dots, ' - ' and ' & ' ALL collapse to a single '-'. Case is preserved.
//   real: 1. Projects/acme.app/acme.app - Competitor Landscape & Tutorials.md
//   slug: 1-Projects/acme-app/acme-app-Competitor-Landscape-Tutorials.md
// The mapping is many-to-one, so a slug can never be reversed by string surgery,
// and qmd stores only the slug (it is content-addressable) so it cannot hand the
// real path back. Feeding a slug to Read/Edit 404s.
//
// Fix: walk the collection root segment-by-segment and match each slug segment
// against real directory entries by CANONICAL form -- every separator stripped.
// That is immune to which character a '-' came from, and to upstream slugify
// changes, so it does not depend on replicating qmd's internals.
// ---------------------------------------------------------------------------

const canonical = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

function qmdConfigPath() {
  // qmd derives its config dir from $HOME (not os.homedir) -- mirror that, and
  // respect XDG_CONFIG_HOME the same way qmd does.
  const home = process.env.HOME || homedir();
  return process.env.XDG_CONFIG_HOME
    ? join(process.env.XDG_CONFIG_HOME, 'qmd', 'index.yml')
    : join(home, '.config', 'qmd', 'index.yml');
}

// Minimal targeted parse of `collections: <name>: path: <root>`. Deliberately not
// a YAML parser -- we need exactly two fields and refuse to take on a dependency
// in a hook-driven fast path.
function readCollectionRoots() {
  const roots = new Map();
  let text;
  try {
    text = readFileSync(qmdConfigPath(), 'utf8');
  } catch {
    return roots;
  }
  let inCollections = false;
  let name = null;
  for (const line of text.split(/\r?\n/)) {
    if (/^collections:\s*$/.test(line)) { inCollections = true; continue; }
    if (!inCollections) continue;
    if (/^\S/.test(line)) break; // dedented back to a top-level key
    const nameMatch = line.match(/^ {2}([^\s:][^:]*):\s*$/);
    if (nameMatch) { name = nameMatch[1].trim(); continue; }
    // `path:` sits at 4 spaces; nested `context:` entries are deeper, so this
    // cannot accidentally capture one.
    const pathMatch = line.match(/^ {4}path:\s*(.+?)\s*$/);
    if (pathMatch && name) {
      let p = pathMatch[1];
      if (/^".*"$/.test(p) || /^'.*'$/.test(p)) p = p.slice(1, -1);
      roots.set(name, p);
      name = null;
    }
  }
  return roots;
}

const dirCache = new Map();
function listDir(dir) {
  if (!dirCache.has(dir)) {
    try {
      dirCache.set(dir, readdirSync(dir, { withFileTypes: true }));
    } catch {
      dirCache.set(dir, []);
    }
  }
  return dirCache.get(dir);
}

// Returns { path } | { ambiguous: [names] } | null
function resolveSlugPath(root, slugPath) {
  let current = root;
  for (const segment of slugPath.split('/').filter(Boolean)) {
    const entries = listDir(current);
    if (entries.length === 0) return null;
    // Exact hit first: correct (and fastest) whenever no slugification happened.
    let match = entries.find((e) => e.name === segment);
    if (!match) {
      const want = canonical(segment);
      const candidates = entries.filter((e) => canonical(e.name) === want);
      if (candidates.length === 0) return null;
      if (candidates.length > 1) {
        return { ambiguous: candidates.map((e) => e.name) };
      }
      match = candidates[0];
    }
    current = join(current, match.name);
  }
  return { path: current };
}

// Hit headers come in two shapes -- search/query put the slug at line start:
//   qmd://vault/Inbox/Note-Name.md:12 #24a5d6
// while `ls` puts it last, after size and mtime columns:
//   6.0 KB  Jul 12 11:53  qmd://vault/Inbox/Note-Name.md
// So anchor on the END of the line and allow leading columns. Slugs never
// contain spaces, so \S is safe for the path portion.
const HIT_RE = /(?:^|\s)qmd:\/\/([^/\s]+)\/(\S+?)(:\d+(?::\d+)?)?(\s+#[0-9a-fA-F]+)?\s*$/;

function annotate(output) {
  const roots = readCollectionRoots();
  if (roots.size === 0) return output;
  const lines = output.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    out.push(line);
    const m = line.match(HIT_RE);
    if (!m) continue;
    const [, collection, slugPath, lineSuffix] = m;
    const root = roots.get(collection);
    if (!root) continue;
    const resolved = resolveSlugPath(root, slugPath);
    if (!resolved) continue;
    if (resolved.ambiguous) {
      out.push(`Path: <ambiguous: ${resolved.ambiguous.join(' | ')}>`);
      continue;
    }
    // Emit as `Path:` to match qmd's existing Title:/Context:/Score: field shape,
    // and keep the :line suffix so the result stays clickable.
    out.push(`Path: ${resolved.path}${lineSuffix || ''}`);
  }
  return out.join('\n');
}

// Fast, hook-driven commands (search/vsearch/query/get) must never hang, so they
// keep the 60s cap. Maintenance commands (embed/update/cleanup/bench) legitimately
// run for minutes on a large corpus — capping them silently SIGTERMs the job
// mid-batch (exit 1, no error), so they run uncapped.
const args = process.argv.slice(2);
const LONG_RUNNING = new Set(['embed', 'update', 'cleanup', 'bench']);
// query/vsearch run an LLM query-expansion pass (~20s) plus CPU reranking, which
// regularly blows past a 60s cap on CPU-only boxes — the job gets SIGTERM'd
// mid-run (exit 1, zero results), so a working search looks broken. Give the
// heavy semantic commands a longer ceiling; keep the fast keyword/get path at
// 60s so a genuine hang there still fails fast.
const HEAVY_INTERACTIVE = new Set(['query', 'vsearch']);
// qmd derives its cache/index dir from $HOME (NOT os.homedir). On Windows,
// PowerShell and Claude-Code-spawned hooks leave HOME unset, so qmd silently
// falls back to a /tmp index — split-brained from the ~/.cache index Git Bash
// gets. Pin HOME so every qmd invocation reads/writes ONE index, matching the
// ~/.cache/qmd location braynee's reindex control files already assume.
const spawnOpts = {
  stdio: 'inherit',
  windowsHide: true,
  env: { ...process.env, HOME: process.env.HOME || homedir() },
};
if (!LONG_RUNNING.has(args[0])) {
  spawnOpts.timeout = HEAVY_INTERACTIVE.has(args[0]) ? 150_000 : 60_000;
}

// Commands whose output reports qmd:// hits an agent will then want to open.
// Only these get captured+annotated; everything else keeps streaming on inherit
// so long-running progress (embed/update) still appears live.
const ANNOTATED = new Set(['search', 'vsearch', 'query', 'ls', 'get']);
const shouldAnnotate = ANNOTATED.has(args[0]);
if (shouldAnnotate) {
  spawnOpts.stdio = ['inherit', 'pipe', 'inherit'];
  spawnOpts.encoding = 'utf8';
}

const res = spawnSync(process.execPath, [qmdJs, ...args], spawnOpts);

// ── Zero-result diagnosis (cp-ee67) ─────────────────────────────────────────
// `qmd search` is AND-based: EVERY term must match or the whole query returns
// nothing. Combined with a query-time tokenizer that treats a dotted term as one
// literal token, a term like `llms.txt` matches nothing even though it appears
// verbatim in an indexed note — and silently zeroes an otherwise-good query.
// Verified: 'llms' -> 5 hits, 'llms.txt' -> 0; 'hooks json' -> 5, 'hooks.json' -> 0.
// Inconsistent too, so it can't be reasoned around: 'package.json' and '.env' DO
// match. See cp-ee67 for the full reproduction.
//
// A bare "No results found." makes an agent conclude the knowledge is absent and
// re-derive it, ask the user, or contradict a recorded decision. This turns that
// silent wrong answer into a self-correcting one. Deliberately NOT solved by
// telling agents to avoid dotted terms: the QMD hook re-injects its instructions
// every turn and can't carry a growing list of tokenizer caveats.
// Count qmd's OWN hit marker, not the `Path:` line — that one is added by
// annotate() above, so a raw qmd call (as the retry probes below make) never has
// it. Keying on `Path:` made every probe read as zero hits and the whole
// diagnosis fell through silently.
function hitCount(s) {
  return typeof s === 'string' ? (s.match(/qmd:\/\//g) || []).length : 0;
}
const hasHits = (s) => hitCount(s) > 0;
function runQmd(argv) {
  const r = spawnSync(process.execPath, [qmdJs, ...argv], {
    ...spawnOpts, stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8', timeout: 60_000,
  });
  return typeof r.stdout === 'string' ? r.stdout : '';
}
// Interior dot only: `.env` is a leading-dot token that matches fine, and a
// trailing dot is sentence punctuation.
const isDotted = (t) => /[^.\s]\.[^.\s]/.test(t);
const MAX_PROBES = 6;   // each probe is a separate qmd spawn; keep the tail bounded

function diagnoseZeroResults(originalOut) {
  const terms = args.slice(1).join(' ').split(/\s+/).filter(Boolean);
  if (terms.length === 0) return originalOut;

  // 1. Cheapest useful move: if any term has an interior dot, retry the whole
  //    query with those split on dots. Demonstrably equivalent, one extra call.
  const dotted = terms.filter(isDotted);
  if (dotted.length) {
    const relaxed = terms.map((t) => (isDotted(t) ? t.replace(/\./g, ' ') : t)).join(' ');
    const out = runQmd(['search', relaxed]);
    if (hasHits(out)) {
      const note = `[qmd-wrapper] Your query matched nothing because qmd search is AND-based and these dotted terms match no index token: ${dotted.join(', ')}\n`
        + `[qmd-wrapper] Retried as: "${relaxed}" — results below are from that retry (cp-ee67).\n\n`;
      // Annotate so the retry's hits carry real filesystem paths too.
      let annotated = out;
      try { annotated = annotate(out); } catch { /* keep raw */ }
      return note + annotated;
    }
  }

  // 2. Still nothing: name the term(s) that zeroed it, so the caller can retry
  //    deliberately instead of concluding the knowledge does not exist.
  if (terms.length > 1) {
    const dead = [];
    for (const t of terms.slice(0, MAX_PROBES)) {
      if (hitCount(runQmd(['search', t])) === 0) dead.push(t);
    }
    if (dead.length) {
      const truncated = terms.length > MAX_PROBES ? ` (checked the first ${MAX_PROBES} of ${terms.length} terms)` : '';
      return originalOut
        + `\n[qmd-wrapper] qmd search requires EVERY term to match. These matched nothing and zeroed the query${truncated}: ${dead.join(', ')}\n`
        + `[qmd-wrapper] Retry without them, or use bare stems (e.g. llms.txt -> llms). Absence of results here is NOT evidence the knowledge is missing (cp-ee67).\n`;
    }
    return originalOut
      + `\n[qmd-wrapper] Every term matches something individually, but no document contains them ALL (qmd search is AND-based). Try fewer or rarer terms, or 'vsearch' for semantic matching (cp-ee67).\n`;
  }
  return originalOut;
}

if (process.env.QMD_WRAPPER_DEBUG) {
  process.stderr.write(`[qmd-wrapper] cmd=${args[0]} annotate=${shouldAnnotate} stdoutType=${typeof res.stdout} len=${res.stdout ? res.stdout.length : 'n/a'} status=${res.status}\n`);
}
if (shouldAnnotate && typeof res.stdout === 'string') {
  let out = res.stdout;
  try {
    out = annotate(out);
  } catch {
    // Annotation is a convenience -- never let it swallow real results.
  }
  // Only `search` is cheap enough to probe, and only when it found nothing.
  if (args[0] === 'search' && !hasHits(out)) {
    try {
      out = diagnoseZeroResults(out);
    } catch (e) {
      // Diagnosis is best-effort — never let it replace or hide real output.
      if (process.env.QMD_WRAPPER_DEBUG) {
        process.stderr.write(`[qmd-wrapper] diagnosis failed: ${(e && e.stack) || e}\n`);
      }
    }
  }
  process.stdout.write(out);
}

process.exit(res.status ?? 1);
