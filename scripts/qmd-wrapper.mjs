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

// `search` is captured so a zero-result run can be diagnosed below. Everything
// else streams straight through on inherit, so long-running progress
// (embed/update) still appears live.
const captureStdout = args[0] === 'search';
if (captureStdout) {
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
// Count qmd's OWN hit marker so a probe's output is judged the same way the
// primary run is.
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
      return note + out;
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
  process.stderr.write(`[qmd-wrapper] cmd=${args[0]} captured=${captureStdout} stdoutType=${typeof res.stdout} len=${res.stdout ? res.stdout.length : 'n/a'} status=${res.status}\n`);
}
if (captureStdout && typeof res.stdout === 'string') {
  let out = res.stdout;
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
