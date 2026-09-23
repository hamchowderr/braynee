// Per-issue beads history for the board's Activity view and the attribution
// backfill: bd's audit events (who did what, when) and the provenance log (where
// back-attributions are recorded).
//
// bd exposes both only per issue (`bd history <id> --events --json`,
// `bd provenance log <id> --json`), and in embedded mode each call costs a few
// seconds. So results are cached outside the repo, keyed by the issue's
// updated_at: an issue that has not changed since the last run is not asked
// again. Provenance writes do not bump updated_at, which is why the backfill
// refreshes the cache entries it touches and the board takes --refresh.
//
// Read-only against bd.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';

export const CACHE_VERSION = 1;

export function cachePath(prefix) {
  return join(tmpdir(), 'braynee-board-cache', `${prefix}.json`);
}

export function readCache(file) {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    if (c && c.v === CACHE_VERSION && c.issues) return c;
  } catch {}
  return { v: CACHE_VERSION, issues: {} };
}

export function writeCache(file, cache) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cache));
  } catch {}
}

function bdJson(repo, args) {
  try {
    const out = execFileSync('bd', [...args, '--json'], {
      cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024, env: { ...process.env, BD_EXPORT_AUTO: 'false' },
    });
    const v = JSON.parse(out);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function fetchIssueHistory(repo, id) {
  const events = bdJson(repo, ['history', id, '--events']).map(e => ({
    id: e.id, type: e.event_type, actor: e.actor || '', at: e.created_at,
    old: e.old_value || '', new: e.new_value || '',
  }));
  const provenance = bdJson(repo, ['provenance', 'log', id]).map(p => ({
    id: p.id, kind: p.kind, actor: p.actor || '', ref: p.ref || '', refKind: p.ref_kind || '',
    source: p.source || '', payload: p.payload || '',
  }));
  return { events, provenance };
}

/**
 * History for the given issues, from cache where the issue is unchanged.
 * @param {string} repo
 * @param {Array<{id:string, updated_at:string}>} issues
 * @param {{prefix:string, refresh?:boolean, onProgress?:(done:number,total:number)=>void}} opts
 * @returns {Map<string, {events:any[], provenance:any[]}>}
 */
export function loadHistory(repo, issues, { prefix, refresh = false, onProgress } = {}) {
  const file = cachePath(prefix);
  const cache = readCache(file);
  const out = new Map();
  let done = 0, dirty = false;
  for (const i of issues) {
    const hit = cache.issues[i.id];
    if (!refresh && hit && hit.updated_at === i.updated_at) {
      out.set(i.id, hit.data);
    } else {
      const data = fetchIssueHistory(repo, i.id);
      cache.issues[i.id] = { updated_at: i.updated_at, data };
      out.set(i.id, data);
      dirty = true;
    }
    done++;
    if (onProgress) onProgress(done, issues.length);
    if (dirty && done % 10 === 0) writeCache(file, cache);
  }
  if (dirty) writeCache(file, cache);
  return out;
}

/** Re-read one issue into the cache (after a provenance write). */
export function refreshIssue(repo, prefix, issue) {
  const file = cachePath(prefix);
  const cache = readCache(file);
  cache.issues[issue.id] = { updated_at: issue.updated_at, data: fetchIssueHistory(repo, issue.id) };
  writeCache(file, cache);
}

/** A back-attribution recorded by the backfill for one event id, or null. */
export function backfillFor(provenance, eventId) {
  for (const p of provenance || []) {
    if (p.source !== BACKFILL_SOURCE || p.ref !== eventId) continue;
    let payload = {};
    try { payload = JSON.parse(p.payload); } catch {}
    return { actor: p.actor, confidence: typeof payload.confidence === 'number' ? payload.confidence : null };
  }
  return null;
}

export const BACKFILL_SOURCE = 'braynee-attribution-backfill';
