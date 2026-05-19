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
  return path.join(os.homedir(), 'Obsidian Vault', '2. Areas', 'Claude Memory');
}

function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^(\w+):\s*(.+)/);
    if (m) result[m[1].trim()] = m[2].trim();
  }
  return result;
}

const SECTION_ORDER = ['User', 'Feedback', 'Projects', 'References'];

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

    const memName = frontmatter.name || filename.replace(/\.md$/, '');
    const memDesc = frontmatter.description || '';
    const section = typeToSection(frontmatter.type);
    const relPath = filename;
    const newLine = memDesc
      ? `- [${memName}](${relPath}) — ${memDesc}`
      : `- [${memName}](${relPath})`;

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
    return { action: 'skip', reason: 'error: ' + (e && e.message) };
  }
}

/**
 * Full resync: ensure every memory note .md in the memory dir has an entry in
 * MEMORY.md. Used by the FileChanged:MEMORY.md hook — when MEMORY.md changes
 * (however it changed: Edit, Bash, obsidian CLI, external Obsidian, manual)
 * re-walk the directory so a note added outside the Write tool is not lost.
 * Pure filesystem; never throws. Returns { scanned, added, updated }.
 */
function resyncAllMemoryNotes(settings) {
  const summary = { scanned: 0, added: 0, updated: 0 };
  try {
    const memoryDir = resolveMemoryDir(settings);
    if (!fs.existsSync(memoryDir)) return summary;
    for (const name of fs.readdirSync(memoryDir)) {
      if (!name.endsWith('.md') || name === 'MEMORY.md') continue;
      summary.scanned++;
      const r = syncMemoryIndex(path.join(memoryDir, name), settings);
      if (r.action === 'added') summary.added++;
      else if (r.action === 'updated') summary.updated++;
    }
  } catch { /* best-effort */ }
  return summary;
}

module.exports = {
  readSettingsJson,
  resolveMemoryDir,
  parseFrontmatter,
  typeToSection,
  syncMemoryIndex,
  resyncAllMemoryNotes,
  SECTION_ORDER,
};
