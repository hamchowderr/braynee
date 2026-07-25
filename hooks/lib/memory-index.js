// memory-index.js — shared MEMORY.md index resync logic.
//
// HD-2.6 / HD-12.3 / cp-72a: memory-index-sync.js only fires on the `Write`
// tool, so a memory note added via Edit / Bash / `obsidian` CLI / external
// Obsidian silently drifts from MEMORY.md. The actual index-update logic is
// extracted here so BOTH the PostToolUse:Write hook AND a FileChanged hook
// (matcher MEMORY.md, fires however the file changed) reuse ONE
// implementation.
//
// Behavior is byte-for-byte the logic that shipped inline in
// memory-index-sync.js; do not change the frontmatter/section regexes here
// without updating both call sites + tests.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require(path.join(__dirname, 'hook-logger.js'));

const LOG_NAME = 'memory-index';

function readSettingsJson() {
  const p = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function resolveMemoryDir(settings) {
  const s = settings || readSettingsJson();
  if (s.autoMemoryDirectory) {
    return s.autoMemoryDirectory.replace(/^~/, os.homedir());
  }
  const { getVaultRoot } = require(path.join(__dirname, '..', '..', 'scripts', 'lib', 'vault-root.js'));
  return path.join(getVaultRoot(), '2. Areas', 'Claude Memory');
}

// Parse YAML-ish frontmatter into a flat object. Reads top-level `key: value`
// pairs AND keys nested one level under a `metadata:` block — memory files come
// in two shapes: flat `type: feedback` (newer) and nested `metadata:\n  type:
// feedback` (older). Reading only flat keys silently dropped `type` on the
// nested files, defaulting them to References and spawning duplicate index
// entries (cp-1nl). A top-level value always wins over a nested one of the same
// key.
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result = {};
  let inMetadata = false;
  for (const line of match[1].split(/\r?\n/)) {
    const top = line.match(/^([\w-]+):\s*(.*)$/);
    if (top) {
      const key = top[1].trim();
      const val = top[2].trim();
      if (key === 'metadata' && val === '') { inMetadata = true; continue; }
      inMetadata = false;
      if (val !== '') result[key] = val;
      continue;
    }
    if (inMetadata) {
      const nested = line.match(/^\s+([\w-]+):\s*(.+)$/);
      if (nested) {
        const key = nested[1].trim();
        if (!(key in result)) result[key] = nested[2].trim();
      } else if (/^\S/.test(line)) {
        inMetadata = false;
      }
    }
  }
  return result;
}

const SECTION_ORDER = ['User', 'Feedback', 'Projects', 'References'];

// CC auto-loads only the first 200 lines / 25KB of MEMORY.md at session start,
// so an oversized index silently truncates and the tail of it stops reaching the
// model. Two constants bound that (cp-1nl, cp-ccsh.2):
//
// MAX_LINE_LEN caps the WHOLE assembled line. MAX_DESC_LEN alone did not: a line
// is `- [{name}]({file}) — {desc}`, and bounding only {desc} left {name} and
// {file} unbounded. Measured on the real 126-note folder: a regen produced
// 26,404 bytes against a ~24,985-byte cap, 121 of 126 lines exceeded 130 chars,
// the longest was 263, and the median prefix before the description was already
// 78 chars. 150 matches the vault's ≤150-char index guideline and regenerates
// that folder to roughly 19,100 bytes.
const MAX_LINE_LEN = 150;

// Kept as the default description cap so the exported truncateDesc keeps its
// original one-argument behavior for any outside caller.
const MAX_DESC_LEN = 130;

// A prefix long enough to consume the entire line budget still gets this much
// description, so such a line can exceed MAX_LINE_LEN. Four notes in the real
// folder have a prefix over 120 chars; a line cap cannot rescue those — their
// `name:` values have to shrink, tracked separately as B1a. Truncating them to
// nothing would be worse than a slightly long line.
const MIN_DESC_BUDGET = 24;

function truncateDesc(desc, max = MAX_DESC_LEN) {
  if (!desc) return '';
  const d = String(desc).trim();
  if (d.length <= max) return d;
  return d.slice(0, max - 1).trimEnd() + '…';
}

function typeToSection(type) {
  const map = {
    user: 'User',
    feedback: 'Feedback',
    project: 'Projects',
    projects: 'Projects',
    reference: 'References',
    references: 'References',
  };
  return map[(type || '').toLowerCase()] || 'References';
}

// Compose the single MEMORY.md index line for a memory note from its
// frontmatter. Shared by syncMemoryIndex (incremental) and resyncAllMemoryNotes
// (full rebuild) so both produce byte-identical lines — never let them diverge.
function buildIndexLine(frontmatter, filename) {
  const memName = (frontmatter && frontmatter.name) || filename.replace(/\.md$/, '');
  const relPath = filename;
  // Budget the description against what the prefix has already spent, so the cap
  // applies to the assembled line rather than to one of its three parts.
  const prefix = `- [${memName}](${relPath}) — `;
  const budget = Math.max(MIN_DESC_BUDGET, MAX_LINE_LEN - prefix.length);
  const memDesc = truncateDesc(frontmatter && frontmatter.description, budget);
  return memDesc
    ? `${prefix}${memDesc}`
    : `- [${memName}](${relPath})`;
}

/**
 * Ensure `memoryFilePath` (a single memory note .md) has an entry in MEMORY.md,
 * inserting or refreshing it in the correct section. Pure filesystem; never
 * throws. Returns one of:
 *   { action: 'skip',    reason }                         — nothing to do
 *   { action: 'updated', section, filename }              — refreshed an entry
 *   { action: 'added',   section, filename }              — added a new entry
 */
function syncMemoryIndex(memoryFilePath, settings) {
  try {
    if (!memoryFilePath) return { action: 'skip', reason: 'no path' };

    const memoryDir = resolveMemoryDir(settings);
    const normWritten = String(memoryFilePath).replace(/\\/g, '/');
    const normMemDir = memoryDir.replace(/\\/g, '/');
    if (!normWritten.startsWith(normMemDir + '/')) {
      return { action: 'skip', reason: 'not inside memory dir' };
    }

    const filename = path.basename(memoryFilePath);
    if (filename === 'MEMORY.md') return { action: 'skip', reason: 'is the index itself' };
    if (!filename.endsWith('.md')) return { action: 'skip', reason: 'not markdown' };

    let frontmatter = {};
    if (fs.existsSync(memoryFilePath)) {
      try {
        frontmatter = parseFrontmatter(fs.readFileSync(memoryFilePath, 'utf8'));
      } catch { /* leave frontmatter empty */ }
    } else {
      // File was deleted — leave the index alone (conservative; matches the
      // original Write-only behavior which never removed entries).
      return { action: 'skip', reason: 'file missing' };
    }

    const section = typeToSection(frontmatter.type);
    const relPath = filename;
    const newLine = buildIndexLine(frontmatter, filename);

    const memoryIndexPath = path.join(memoryDir, 'MEMORY.md');
    let lines = [];
    if (fs.existsSync(memoryIndexPath)) {
      lines = fs.readFileSync(memoryIndexPath, 'utf8').split(/\r?\n/);
    }

    const existingIdx = lines.findIndex(l => l.includes(`(${relPath})`));
    if (existingIdx !== -1) {
      if (lines[existingIdx] === newLine) {
        return { action: 'skip', reason: 'unchanged' };
      }
      lines[existingIdx] = newLine;
      fs.writeFileSync(memoryIndexPath, lines.join('\n'), 'utf8');
      return { action: 'updated', section, filename };
    }

    const sectionHeader = `## ${section}`;
    const sectionIdx = lines.findIndex(l => l.trim() === sectionHeader);
    if (sectionIdx !== -1) {
      let insertAt = sectionIdx + 1;
      while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
      lines.splice(insertAt, 0, newLine);
    } else {
      if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
      lines.push(sectionHeader);
      lines.push(newLine);
    }
    fs.writeFileSync(memoryIndexPath, lines.join('\n'), 'utf8');
    return { action: 'added', section, filename };
  } catch (e) {
    // The caller gets a reason string, but nothing persists it — a hook that
    // stopped indexing would look like a no-op forever (cp-ccsh.11).
    log.debug(LOG_NAME, `syncMemoryIndex failed for ${memoryFilePath}: ${e && e.message}`);
    return { action: 'skip', reason: 'error: ' + (e && e.message) };
  }
}

/**
 * Full resync: authoritatively REGENERATE MEMORY.md from the frontmatter of
 * every memory note in the dir. Used by the FileChanged:MEMORY.md hook — when
 * MEMORY.md changes (however it changed: Edit, Bash, obsidian CLI, external
 * Obsidian, manual) the index is rebuilt so it always matches the directory.
 *
 * Frontmatter is the source of truth. The rebuild guarantees three invariants
 * that the old per-file insert/update could not (cp-1nl):
 *   • one line per file — cross-section duplicate entries are eliminated
 *   • each entry sits in its `type`'s section (mis-filed entries get re-homed)
 *   • each assembled line is budgeted to MAX_LINE_LEN — name, filename and
 *     description together — so no single part can bloat the index past CC's
 *     200-line / 25KB startup-load cap (the one exception being a prefix that
 *     alone exceeds the budget; see MIN_DESC_BUDGET and B1a)
 * Entries are sorted alphabetically within a section, so once clean the output
 * is stable: an unchanged dir regenerates byte-identical content → no write →
 * the FileChanged hook does not loop.
 *
 * The preamble (everything before the first managed `## Section` header — e.g.
 * the `# Claude Memory Index` title) is preserved verbatim. Anything ELSE after
 * that point is regenerated; the four managed sections are owned by this code.
 *
 * Pure filesystem; never throws. Returns { scanned, added, updated }.
 */
function resyncAllMemoryNotes(settings) {
  const summary = { scanned: 0, added: 0, updated: 0 };
  try {
    const memoryDir = resolveMemoryDir(settings);
    if (!fs.existsSync(memoryDir)) return summary;
    const memoryIndexPath = path.join(memoryDir, 'MEMORY.md');

    const oldContent = fs.existsSync(memoryIndexPath)
      ? fs.readFileSync(memoryIndexPath, 'utf8') : '';
    const oldLines = oldContent.split(/\r?\n/);

    // Which files already had an entry (by relPath in a markdown link) — used to
    // split the change count into added (new) vs updated (pre-existing).
    const oldRelPaths = new Set();
    for (const l of oldLines) {
      const m = l.match(/\]\(([^)]+\.md)\)/);
      if (m) oldRelPaths.add(m[1]);
    }

    // Group fresh entries by section, from frontmatter.
    const bySection = {};
    for (const name of fs.readdirSync(memoryDir)) {
      if (!name.endsWith('.md') || name === 'MEMORY.md') continue;
      summary.scanned++;
      let fm = {};
      try { fm = parseFrontmatter(fs.readFileSync(path.join(memoryDir, name), 'utf8')); }
      catch { /* leave empty — buildIndexLine falls back to filename */ }
      const section = typeToSection(fm.type);
      (bySection[section] = bySection[section] || []).push({
        sortKey: ((fm.name || name).toLowerCase()),
        line: buildIndexLine(fm, name),
      });
      if (!oldRelPaths.has(name)) summary.added++;
    }

    // Preamble = everything up to the first managed-section header.
    const managed = new Set(SECTION_ORDER.map(s => `## ${s}`));
    const preamble = [];
    for (const l of oldLines) {
      if (managed.has(l.trim())) break;
      preamble.push(l);
    }
    while (preamble.length && preamble[preamble.length - 1].trim() === '') preamble.pop();
    if (preamble.length === 0) preamble.push('# Claude Memory Index');

    const out = [...preamble];
    for (const section of SECTION_ORDER) {
      const entries = bySection[section];
      if (!entries || entries.length === 0) continue;
      entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
      out.push('', `## ${section}`);
      for (const e of entries) out.push(e.line);
    }
    const newContent = out.join('\n') + '\n';

    if (newContent !== oldContent) {
      summary.updated = summary.scanned - summary.added;
      fs.writeFileSync(memoryIndexPath, newContent, 'utf8');

      // The invariant this function exists to guarantee. B1 (cp-ccsh.2) shipped a
      // regeneration that produced 26,404 bytes against a ~24,985 byte cap and
      // reported NOTHING, because the only failure channel was the bare
      // `catch { /* best-effort */ }` below. Record a breach rather than trusting
      // the cap to hold silently.
      const bytes = Buffer.byteLength(newContent, 'utf8');
      if (bytes > 24985) {
        log.debug(LOG_NAME, `regenerated MEMORY.md is ${bytes} bytes, over the ~24985 startup-load cap ` +
          `(${summary.scanned} notes) — shorten the longest name:/description: frontmatter`);
      }
      const overLong = out.filter(l => l.startsWith('- [') && l.length > MAX_LINE_LEN);
      if (overLong.length) {
        log.debug(LOG_NAME, `${overLong.length} index line(s) exceed MAX_LINE_LEN=${MAX_LINE_LEN} ` +
          `(longest ${Math.max(...overLong.map(l => l.length))}); their name: values are too long to budget`);
      }
    } else {
      summary.added = 0;
      summary.updated = 0;
    }
  } catch (e) {
    // Still best-effort — the swallow stays, the silence does not (cp-ccsh.11).
    log.debug(LOG_NAME, `resyncAllMemoryNotes failed: ${e && e.message}`);
  }
  return summary;
}

module.exports = {
  readSettingsJson,
  resolveMemoryDir,
  parseFrontmatter,
  typeToSection,
  truncateDesc,
  buildIndexLine,
  syncMemoryIndex,
  resyncAllMemoryNotes,
  SECTION_ORDER,
  MAX_DESC_LEN,
  MAX_LINE_LEN,
  MIN_DESC_BUDGET,
};
