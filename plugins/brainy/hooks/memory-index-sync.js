#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'memory-index-sync';

// ── Helpers ──────────────────────────────────────────────────────────────────

function readSettingsJson() {
  const p = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function resolveMemoryDir(settings) {
  if (settings.autoMemoryDirectory) {
    return settings.autoMemoryDirectory.replace(/^~/, os.homedir());
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

// ── Main ─────────────────────────────────────────────────────────────────────

let input;
try {
  input = JSON.parse(fs.readFileSync('/dev/stdin', 'utf8'));
} catch (err) {
  log.error(HOOK, `failed to read stdin: ${err.message}`);
  process.exit(0);
}

// Only handle Write tool calls
if (input.tool_name !== 'Write') process.exit(0);
log.info(HOOK, `triggered for Write on ${(input.tool_input || {}).file_path || '(unknown path)'}`);

const writtenPath = (input.tool_input || {}).file_path;
if (!writtenPath) process.exit(0);

const settings = readSettingsJson();
const memoryDir = resolveMemoryDir(settings);

// Normalise both to forward slashes for comparison
const normWritten = writtenPath.replace(/\\/g, '/');
const normMemDir = memoryDir.replace(/\\/g, '/');

if (!normWritten.startsWith(normMemDir + '/')) {
  log.info(HOOK, `skipped — not inside memory dir (${normMemDir})`);
  process.exit(0);
}

const filename = path.basename(writtenPath);

// Skip MEMORY.md itself (that's the index we're writing to)
if (filename === 'MEMORY.md') process.exit(0);

// Only process .md files
if (!filename.endsWith('.md')) process.exit(0);

// ── Parse the written file ──────────────────────────────────────────────────

let frontmatter = {};
if (fs.existsSync(writtenPath)) {
  try {
    frontmatter = parseFrontmatter(fs.readFileSync(writtenPath, 'utf8'));
  } catch (err) {
    log.warn(HOOK, `could not parse frontmatter for ${filename}: ${err.message}`);
  }
}

const memName = frontmatter.name || filename.replace(/\.md$/, '');
const memDesc = frontmatter.description || '';
const section = typeToSection(frontmatter.type);

// Relative path from MEMORY.md's perspective (same directory)
const relPath = filename;
const newLine = memDesc
  ? `- [${memName}](${relPath}) — ${memDesc}`
  : `- [${memName}](${relPath})`;

// ── Read and update MEMORY.md ───────────────────────────────────────────────

const memoryIndexPath = path.join(memoryDir, 'MEMORY.md');
let lines = [];
if (fs.existsSync(memoryIndexPath)) {
  lines = fs.readFileSync(memoryIndexPath, 'utf8').split(/\r?\n/);
}

// Check if this file is already indexed (by filename)
const existingIdx = lines.findIndex(l => l.includes(`(${relPath})`));
if (existingIdx !== -1) {
  // Update in place if it changed
  if (lines[existingIdx] === newLine) {
    // No change — exit silently
    process.exit(0);
  }
  lines[existingIdx] = newLine;
  fs.writeFileSync(memoryIndexPath, lines.join('\n'), 'utf8');
  log.info(HOOK, `updated existing entry for ${filename} in MEMORY.md`);
  process.stdout.write(JSON.stringify({
    additionalContext: `Memory index updated: refreshed entry for ${filename} in MEMORY.md. No manual MEMORY.md edit needed.`,
  }));
  process.exit(0);
}

// File is new — find the right section and insert
const sectionHeader = `## ${section}`;
const sectionIdx = lines.findIndex(l => l.trim() === sectionHeader);

if (sectionIdx !== -1) {
  // Insert after the header (and any blank line immediately after)
  let insertAt = sectionIdx + 1;
  while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
  lines.splice(insertAt, 0, newLine);
} else {
  // Section doesn't exist — append it
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('');
  lines.push(sectionHeader);
  lines.push(newLine);
}

fs.writeFileSync(memoryIndexPath, lines.join('\n'), 'utf8');
log.info(HOOK, `added ${filename} to ${section} section of MEMORY.md`);

process.stdout.write(JSON.stringify({
  additionalContext: `Memory index auto-updated: added ${filename} to the ${section} section of MEMORY.md. No manual MEMORY.md edit needed.`,
}));
