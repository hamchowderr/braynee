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
//   real: 1. Projects/myRP.build/myRP.build - Competitor Landscape & Tutorials.md
//   slug: 1-Projects/myRP-build/myRP-build-Competitor-Landscape-Tutorials.md
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

if (shouldAnnotate && typeof res.stdout === 'string') {
  let out = res.stdout;
  try {
    out = annotate(out);
  } catch {
    // Annotation is a convenience -- never let it swallow real results.
  }
  process.stdout.write(out);
}

process.exit(res.status ?? 1);
