// read-issues-jsonl.js
// Repo-scoped, server-free reader for a project's beads issues.
//
// WHY (cp-6j5 / dolt-guard): braynee runs read-only hooks on routine events
// (Stop, PostToolBatch, PostToolUse). When those query the live Dolt server via
// `bd list`/`bd stats`, many CONCURRENT Claude Code sessions (different
// terminals/projects) hammer the single shared server at once; its handshakes
// flap and bd auto-spawns throwaway dolt sql-servers that orphan and pile up.
// `issues.jsonl` is the source of truth bd auto-exports — reading the file is
// concurrency-safe (N sessions = N file reads, never N server hits), needs no
// process spawn, and is INHERENTLY repo-scoped (this repo's own .beads/), so it
// also sidesteps the cp-o4g `--all` cross-project scoping trap. This generalizes
// the move statusline-state.js (getBeadsData) already made, for reuse.
'use strict';

const fs = require('fs');
const path = require('path');

// All issue records from <beadsRoot>/.beads/issues.jsonl. Each line is one JSON
// record; issues.jsonl can interleave non-issue rows, so we keep only records
// that look like issues (have an id; _type==='issue' when the field is present).
// Returns [] on missing file or any parse error — callers early-exit on empty,
// matching the prior bd-failure behavior.
function readIssues(beadsRoot) {
  try {
    const jsonl = path.join(beadsRoot, '.beads', 'issues.jsonl');
    if (!fs.existsSync(jsonl)) return [];
    const out = [];
    for (const line of fs.readFileSync(jsonl, 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let rec;
      try { rec = JSON.parse(s); } catch { continue; }
      if (!rec || !rec.id) continue;
      if (rec._type && rec._type !== 'issue') continue;
      out.push(rec);
    }
    return out;
  } catch {
    return [];
  }
}

const isOpen = (i) => !!(i && i.status && i.status !== 'closed');

// Server-free `bd stale` approximation: open issues untouched for `days` days.
// nowMs is injectable for tests.
function staleOpen(issues, days = 14, nowMs = Date.now()) {
  const cutoff = nowMs - days * 24 * 60 * 60 * 1000;
  return (issues || []).filter((i) => {
    if (!isOpen(i)) return false;
    const t = Date.parse(i.updated_at || i.created_at || '');
    return Number.isFinite(t) && t < cutoff;
  });
}

module.exports = { readIssues, isOpen, staleOpen };
