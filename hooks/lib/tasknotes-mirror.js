// tasknotes-mirror.js — shared TaskNotes (mtn) mirror for beads issues.
//
// Extracted verbatim from beads-status-sync.js so the PostToolUse status
// hook AND prd-seed.mjs use ONE implementation. cp-8ru: prd-seed creates
// issues via internal execSync (not Bash tool-calls), so the PostToolUse
// hook never saw them and seeded backlogs got zero TaskNotes. The mirror
// was never code-vs-vault gated — the gap was the seed path bypassing it.
//
// Behavior is identical to the original inline helpers; do not "improve"
// the regexes/format here without updating both call sites + tests.

const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const { getVaultRoot } = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'vault-root.js'));
const { resolveProjectLink } = require(path.join(__dirname, 'project-resolver.js'));
const VAULT_DIR = getVaultRoot();
const log = require(path.join(__dirname, 'hook-logger.js'));
const LOG_NAME = 'tasknotes-mirror';
const TASKNOTES_DIR = path.join(VAULT_DIR, '2. Areas', 'TaskNotes', 'Tasks');

// 0–4 → name (matches beads-status-sync PRIORITY_MAP). Also tolerates the
// already-named and `P1` forms that bd --json / CLI flags can emit.
const PRIORITY_MAP = { 0: 'critical', 1: 'high', 2: 'medium', 3: 'low', 4: 'low' };
function normalizePriority(raw) {
  if (raw === undefined || raw === null || raw === '') return 'medium';
  const s = String(raw).trim();
  if (/^[0-4]$/.test(s)) return PRIORITY_MAP[parseInt(s, 10)];
  if (/^P[0-4]$/i.test(s)) return PRIORITY_MAP[parseInt(s.replace(/^P/i, ''), 10)] || 'medium';
  const w = s.toLowerCase();
  return ['critical', 'high', 'medium', 'low'].includes(w) ? w : 'medium';
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, ...opts }).trim();
  } catch { return null; }
}

function sanitizeTitle(title) {
  return title.replace(/:/g, ' -').replace(/[/\\*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// cp-na6c: per-process cache of the scanned notes, keyed by filepath.
//
// The comment below used to end "scanning ~hundreds of small .md files is cheap
// enough". It is not, and that assumption was the mirror's real bottleneck.
// Measured 2026-07-26 against 2,067 task notes: ONE findTasknoteForIssueId call
// costs 1,105 ms, because it re-read every note from disk. beads-batch-reconcile
// calls it twice per issue and ensureMtnTask twice more, so reconciling braynee's
// 219 issues needed ~484 SECONDS against the hook's 60s timeout. The reconcile
// was killed part-way on every batch, having spent its whole budget re-checking
// issues that were ALREADY mirrored, and never reaching the missing ones.
//
// Each file is now read once per process; later calls re-list the directory
// (one cheap syscall) and read only files they have not seen. Entries for
// deleted notes are dropped, so a long-lived process cannot serve a stale hit.
let NOTE_CACHE = null;
// tag -> filepath, rebuilt lazily alongside NOTE_CACHE. Caching the notes alone
// still left every lookup running 2,067 regex tests (~16 ms); indexing the tags
// makes the common exact-id case a single Map hit.
let TAG_INDEX = null;
// The last note list handed out, plus the directory mtime it was built from.
// Without this, every lookup still re-listed 2,067 entries and rebuilt the
// `present` set — ~15 ms, which made the tag index pointless.
let NOTE_LIST = null;
let DIR_STAMP = null;

/**
 * The `title:` value from a frontmatter block, including YAML FOLDED scalars.
 *
 * cp-na6c: mtn writes long titles as a folded block, so the value is not on the
 * `title:` line at all:
 *
 *     title: >-
 *       OM-style complexity guard - agent watches the running builder and can
 *       send it back [] .7
 *
 * The sub-issue lookup below used /^title:\s*(.+)$/m, which captured ">-" and
 * never matched. Every sub-issue whose title was long enough to fold was
 * therefore INVISIBLE to the mirror: ensureMtnTask created a duplicate and
 * completeMtnTaskByIssueId silently no-op'd, so closed sub-tasks stayed open.
 * Same class as the CRLF bug fixed in cp-ccsh.10, different trigger.
 */
function titleOf(fm) {
  if (!fm) return '';
  const lines = String(fm).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^title:[ \t]*(.*)$/);
    if (!m) continue;
    const head = m[1].trim();
    // Not a folded/literal block — the value is inline.
    if (head && !/^[|>][-+]?\d*$/.test(head)) {
      return head.replace(/^['"]|['"]$/g, '');
    }
    // Folded (>) or literal (|): collect the indented continuation lines.
    const parts = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (!/^[ \t]+\S/.test(lines[j])) break;
      parts.push(lines[j].trim());
    }
    return parts.join(' ');
  }
  return '';
}

/** Every tag in a frontmatter block, from either YAML shape. */
function tagsIn(fm) {
  const out = [];
  if (!fm) return out;
  const flow = fm.match(/^tags:\s*\[([^\]]*)\]/m);
  if (flow) {
    for (const t of flow[1].split(',')) {
      const v = t.trim().replace(/^['"]|['"]$/g, '');
      if (v) out.push(v);
    }
  }
  const block = fm.match(/^tags:\s*\n((?:[ \t]*-[ \t]*.+\n?)+)/m);
  if (block) {
    for (const line of block[1].split('\n')) {
      const m = line.match(/^[ \t]*-[ \t]*['"]?([^'"\s]+)['"]?\s*$/);
      if (m) out.push(m[1]);
    }
  }
  return out;
}

function scanNotes() {
  // Freshness is decided by the directory LISTING, not its mtime.
  //
  // An earlier version compared `statSync(dir).mtimeMs` and skipped the listing
  // when unchanged. That is wrong: a note created inside the same mtime tick as
  // the previous scan leaves the stamp identical, so the new note stayed
  // invisible. It passed on Windows and failed on Linux, where the writes land
  // fast enough to share a tick — and it cannot be fixed by having callers
  // invalidate, because mtn, Obsidian, and other hooks all add notes without
  // going through this module.
  //
  // readdir is cheap; re-READING every note is what cost 1,105 ms. So always
  // list, and reuse the parsed frontmatter for names already seen.
  let names;
  try {
    names = fs.readdirSync(TASKNOTES_DIR).filter((n) => n.endsWith('.md'));
  } catch {
    return null;
  }
  const stamp = names.length + '\u0000' + names.join('\u0000');
  if (NOTE_LIST && TAG_INDEX && DIR_STAMP === stamp) return NOTE_LIST;
  if (!NOTE_CACHE) NOTE_CACHE = new Map();
  const present = new Set();
  const out = [];
  let mutated = false;
  for (const name of names) {
    const filepath = path.join(TASKNOTES_DIR, name);
    present.add(filepath);
    let entry = NOTE_CACHE.get(filepath);
    if (!entry) {
      mutated = true;
      let fm = '';
      // BOM- and CRLF-tolerant. This used to be /^---\n([\s\S]*?)\n---/ (LF
      // only, no BOM), so on Windows a CRLF task note was invisible to the
      // mirror: it could never be found, which meant ensureMtnTask created a
      // DUPLICATE note for an issue that already had one, and
      // completeMtnTaskByIssueId silently no-op'd so closed work stayed "open".
      // Found by tasknotes-mirror.test.js (cp-ccsh.10).
      try {
        fm = (fs.readFileSync(filepath, 'utf8').match(/^﻿?---\r?\n([\s\S]*?)\r?\n---/) || [, ''])[1];
      } catch (e) {
        // An unreadable note reads as "no such task note", which is precisely
        // the failure described above: a DUPLICATE gets created and the close
        // path silently no-ops. Never let that happen without a record.
        log.debug(LOG_NAME, `task note unreadable ${filepath}: ${e && e.message}`);
      }
      entry = { filepath, fm };
      NOTE_CACHE.set(filepath, entry);
    }
    out.push(entry);
  }
  for (const key of [...NOTE_CACHE.keys()]) {
    if (!present.has(key)) { NOTE_CACHE.delete(key); mutated = true; }
  }

  // Rebuild ONLY when the note set changed (or the index was dropped). Rebuilding
  // unconditionally re-walked all 2,067 notes on every lookup, which kept a
  // lookup at ~19 ms and defeated the point of indexing at all.
  // First tag wins: a duplicate tag across two notes means the mirror already
  // holds a duplicate, and choosing deterministically matches the old behavior
  // of returning the first match in readdir order.
  if (mutated || !TAG_INDEX) {
    TAG_INDEX = new Map();
    for (const n of out) {
      for (const tag of tagsIn(n.fm)) if (!TAG_INDEX.has(tag)) TAG_INDEX.set(tag, n.filepath);
    }
  }
  NOTE_LIST = out;
  DIR_STAMP = stamp;
  return out;
}

/**
 * Drop one note from the cache. Call after WRITING a note, so a subsequent
 * lookup re-reads it rather than matching against pre-write frontmatter.
 * (Tags do not change on completion, but relying on that would make the cache
 * correct only by coincidence.)
 */
/**
 * Drop the whole cache. Call after an operation that ADDS a note, because the
 * directory-mtime check cannot be trusted then: a file created inside the same
 * mtime tick as the previous scan leaves the stamp unchanged, so the new note
 * stays invisible. Windows timing happened to hide this; Linux exposed it as a
 * failing sub-issue lookup in tasknotes-mirror.test.js.
 */
function invalidateCache() {
  NOTE_CACHE = null;
  TAG_INDEX = null;
  NOTE_LIST = null;
  DIR_STAMP = null;
}

function forgetNote(filepath) {
  if (NOTE_CACHE && filepath) NOTE_CACHE.delete(filepath);
  // The tag index and the mtime stamp are both derived from the note list, so
  // all three must fall together — leaving the stamp would let the next call
  // short-circuit and keep serving the dropped note's tags.
  TAG_INDEX = null;
  NOTE_LIST = null;
  DIR_STAMP = null;
}

// Filesystem dedupe — scans tasknote files for one whose frontmatter `tags:`
// array contains the bd issue ID. `mtn search` for a `#<tag>` query returned
// empty on Windows even when the task existed (verified 2026-05-12 against
// sophon-sdk-python-test-bb4). bd IDs are workspace-namespaced so this is a
// unique key.
function findTasknoteForIssueId(issueId) {
  if (!issueId) return null;
  if (!fs.existsSync(TASKNOTES_DIR)) return null;

  // Candidate ids: the exact id, plus the Brainy<->Braynee rename swap — task
  // tags and beads ids diverged across that rename (tag `braynee-web-x`, beads
  // id `brainy-web-x`), so a close of one must still find the note of the other.
  const ids = [issueId];
  if (issueId.startsWith('braynee')) ids.push(issueId.replace(/^braynee/, 'brainy'));
  else if (issueId.startsWith('brainy')) ids.push(issueId.replace(/^brainy/, 'braynee'));

  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // tags appear as a YAML flow array `tags: [a, b]` or a block list of `- tag`.
  const tagRe = (id) => new RegExp(`(^|[\\s,\\[])${esc(id)}([\\s,\\]]|$)`, 'm');

  const notes = scanNotes();
  if (!notes) return null;

  // Pass 0: O(1) exact-tag hit. Same result as the linear pass below, which is
  // kept as the fallback for the sub-issue shape.
  if (TAG_INDEX) {
    for (const id of ids) {
      const hit = TAG_INDEX.get(id);
      if (hit) return hit;
    }
  }

  // Pass 1: exact tag match for any candidate id.
  for (const { filepath, fm } of notes) {
    if (fm && ids.some((id) => tagRe(id).test(fm))) return filepath;
  }
  // Pass 2: sub-issue. beads closes the full `parent.N`, but the task note tags
  // the PARENT id and carries the `.N` in its title — match parent tag + `.N`.
  // cp-na6c: handle ANY nesting depth, not just one level. mtn cannot put a dot
  // in a tag, so it tags the note with the id up to some dot and pushes the rest
  // into the title (`... [medium] .10.4`). The old code split exactly one level
  // with a greedy /^(.+)\.(\d+)$/, so for `proj-4cd.10.4` it looked for the tag
  // `proj-4cd.10` — which mtn never writes — and missed a note that DID exist.
  // The symptom was severe: the mirror concluded the note was absent, tried to
  // create it, and mtn refused with "File already exists". Those issues then
  // counted as unmirrored forever.
  //
  // Try every split point, longest tag first, matching the remaining dotted
  // suffix at the end of the title.
  for (const id of ids) {
    if (!id.includes('.')) continue;
    const parts = id.split('.');
    for (let cut = parts.length - 1; cut >= 1; cut--) {
      const parent = parts.slice(0, cut).join('.');
      const suffix = '.' + parts.slice(cut).join('.');
      const parentRe = tagRe(parent);
      const titleRe = new RegExp(`\\s${suffix.replace(/\./g, '\\.')}\\s*['"]?\\s*$`, 'm');
      for (const { filepath, fm } of notes) {
        if (fm && parentRe.test(fm) && titleRe.test(titleOf(fm))) return filepath;
      }
    }
  }
  return null;
}

function findMtnTaskByIssueId(issueId) {
  // Used by close-side to decide whether to call `mtn complete`.
  // Returns a string mtn can resolve back to the task (the `#<issueId>` tag).
  return findTasknoteForIssueId(issueId) ? '#' + issueId : null;
}

// Mark the mirrored task note done. The previous version ran `mtn complete
// "#<id>"`, but `mtn complete` takes <pathOrTitle> — a `#tag` never resolves
// (and mtn complete crashes on some Windows paths), so every completion was a
// silent no-op and finished work stayed "open". Write the canonical done state
// (status: done + completedDate) straight to the note's frontmatter instead.
function completeMtnTaskByIssueId(issueId) {
  const file = findTasknoteForIssueId(issueId);
  if (!file) return;
  try {
    const content = fs.readFileSync(file, 'utf8');
    const m = content.match(/^(﻿?---\r?\n)([\s\S]*?)(\r?\n---)/);
    if (!m) return;
    let fm = m[2];
    const date = new Date().toISOString().slice(0, 10);
    fm = /^status:.*$/m.test(fm) ? fm.replace(/^status:.*$/m, 'status: done') : fm + '\nstatus: done';
    fm = /^completedDate:.*$/m.test(fm) ? fm.replace(/^completedDate:.*$/m, `completedDate: '${date}'`) : fm + `\ncompletedDate: '${date}'`;
    fs.writeFileSync(file, m[1] + fm + m[3] + content.slice(m[0].length));
    forgetNote(file);
  } catch (e) {
    // Leaves a closed issue's task note showing "open" forever — the mirror
    // drift this module exists to prevent.
    log.debug(LOG_NAME, `could not mark task note complete ${file}: ${e && e.message}`);
  }
}

// Create the matching TaskNote if one does not already exist for this issue.
// Dedupe by bd issue ID, not by title prefix. Workspaces with identical task
// titles would otherwise collide on the first chars and silently skip.
// Returns the sanitized title (the mtn-resolvable name).
function ensureMtnTask(issueId, title, priority, projectSlug) {
  if (findTasknoteForIssueId(issueId)) return sanitizeTitle(title);
  let safeTitle = sanitizeTitle(title);
  const mtnCreate = (t) =>
    run(`mtn create ${JSON.stringify(`${t} +${projectSlug} [${priority}] #task #${issueId}`)}`);
  mtnCreate(safeTitle);
  // We just added a note, so the mtime stamp is not a reliable freshness signal
  // (same-tick creates leave it unchanged). Drop the cache so the lookup below
  // actually sees the new file.
  invalidateCache();

  // cp-lqki: mtn keys notes by FILENAME, and refuses when one already exists —
  // "Failed to create task: File already exists: .../<title> [].md". This module
  // dedupes by issue id, so a title that is already taken by a DIFFERENT issue
  // left the current one permanently unmirrored, and run() discarded the error
  // so it surfaced only as a bare "failed" count.
  //
  // Two ways it happens, both real: a repo whose bd prefix was renamed still has
  // the old notes holding the filenames, and two repos can legitimately share a
  // task title. Neither is a reason to skip the mirror, so disambiguate with the
  // id — which is what makes the note unique anyway — and try once more.
  // The suffix is a bare counter, NOT the issue id. mtn parses natural-language
  // DURATIONS out of the title, so an id ending in digits + a time unit is eaten:
  // `brokerboard-46h` lost "46h" (46 hours) and `brokerboard-08s` lost "08s" (8
  // seconds), both leaving a useless "(brokerboard-)" that collides all over
  // again. A counter cannot be read as a duration, and the id is already carried
  // by the `#<id>` tag — which is what findTasknoteForIssueId matches on, so
  // nothing depends on the id being in the filename.
  for (let n = 2; n <= 9 && !findTasknoteForIssueId(issueId); n++) {
    safeTitle = `${sanitizeTitle(title)} (${n})`;
    log.debug(LOG_NAME, `title collision for ${issueId}; retrying as ${safeTitle}`);
    mtnCreate(safeTitle);
    invalidateCache();
  }
  // Post-create cleanup of the note mtn just wrote (best-effort):
  //  - repoint the project from mtn's non-resolving `[[projects/<slug>]]` to the
  //    real vault note so the task isn't a graph orphan.
  //  - guarantee a `status` field. Older mtn omitted it, which renders as the
  //    "none" status and drops the task out of Open/Today/Overdue Base filters.
  try {
    const file = findTasknoteForIssueId(issueId);
    if (file) {
      let content = fs.readFileSync(file, 'utf8');
      let changed = false;
      const target = resolveProjectLink(projectSlug, VAULT_DIR);
      if (target && /\[\[projects\/[^\]]+\]\]/.test(content)) {
        content = content.replace(/\[\[projects\/[^\]]+\]\]/g, `[[${target}]]`);
        changed = true;
      }
      const m = content.match(/^(﻿?---\r?\n)([\s\S]*?)(\r?\n---)/);
      if (m && !/^status:/m.test(m[2])) {
        content = m[1] + m[2] + '\nstatus: open' + m[3] + content.slice(m[0].length);
        changed = true;
      }
      if (changed) { fs.writeFileSync(file, content); forgetNote(file); }
    }
  } catch (e) {
    // The note exists but without `status:`, so later status queries skip it
    // and it never appears open or closed anywhere.
    log.debug(LOG_NAME, `could not normalize new task note: ${e && e.message}`);
  }
  return safeTitle;
}

// Derive the +project tag the same way beads-status-sync does:
// Title-Cased-With-Dashes from the project/folder name.
function projectSlugFrom(name) {
  return String(name || '')
    .split(/[-_\s]/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-');
}

module.exports = {
  VAULT_DIR,
  TASKNOTES_DIR,
  PRIORITY_MAP,
  normalizePriority,
  run,
  sanitizeTitle,
  findTasknoteForIssueId,
  findMtnTaskByIssueId,
  completeMtnTaskByIssueId,
  ensureMtnTask,
  projectSlugFrom,
  // cp-na6c: exported so a fleet sweep can drop the cache between repos and so
  // tests can assert the cache is actually being used.
  forgetNote,
};
