#!/usr/bin/env node
'use strict';

// vault-changelog.js
// Hook: PostToolUse (Write|Edit) — appends a one-line entry to today's
// vault changelog at "2. Areas/Changelog/YYYY-MM-DD.md".
//
// Goal: zero-effort running activity feed of every file edit Claude Code
// makes, so the user can scan a day's changes without grep'ing git or
// digging through transcripts. Separate from curated daily notes — this is
// machine-generated noise that doesn't belong in the human-written daily.
//
// Self-gating: only fires for Write/Edit tools with a file_path. Skips
// files inside the vault itself (would loop forever — changelog is a
// vault file), build artifacts (node_modules, dist, build, .next, .venv,
// __pycache__, .cache), and VCS/tracker internals (.git, .beads).
//
// Non-blocking: synchronous fs append only (no subprocess), <10ms typical.
// Always exit 0 — never block the tool result on logging failure.

const fs = require('fs');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { getVaultRoot } = require(path.join(__dirname, '..', 'scripts', 'lib', 'vault-root.js'));

const HOOK = 'vault-changelog';

const SKIP_PATTERNS = [
  /[/\\]\.beads[/\\]/,
  /[/\\]\.git[/\\]/,
  /[/\\]node_modules[/\\]/,
  /[/\\]\.cache[/\\]/,
  /[/\\]build[/\\]/,
  /[/\\]dist[/\\]/,
  /[/\\]\.next[/\\]/,
  /[/\\]\.venv[/\\]/,
  /[/\\]__pycache__[/\\]/,
  // Ephemeral agent working files — Claude Code per-session temp + scratchpad
  // dirs. These are throwaway (probes, one-off scripts, HTML previews) and
  // otherwise masquerade as real project activity in the changelog.
  /[/\\][Tt]emp[/\\]claude[/\\]/,
  /[/\\]scratchpad[/\\]/,
];

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const toolName = input.tool_name;
if (toolName !== 'Write' && toolName !== 'Edit') process.exit(0);

const filePath = (input.tool_input || {}).file_path;
if (!filePath || typeof filePath !== 'string') process.exit(0);

for (const pattern of SKIP_PATTERNS) {
  if (pattern.test(filePath)) process.exit(0);
}

let vaultRoot;
try {
  vaultRoot = getVaultRoot();
} catch {
  process.exit(0);
}

// Skip files inside the vault — the changelog itself is in the vault and
// we'd recurse infinitely on each write of it.
const normalizedFile = path.normalize(filePath);
const normalizedVault = path.normalize(vaultRoot);
if (
  normalizedFile === normalizedVault ||
  normalizedFile.startsWith(normalizedVault + path.sep)
) {
  process.exit(0);
}

const now = new Date();
const pad = (n) => String(n).padStart(2, '0');
const dateStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const timeStr = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;

const changelogDir = path.join(vaultRoot, '2. Areas', 'Changelog');
const changelogPath = path.join(changelogDir, `${dateStr}.md`);

try {
  if (!fs.existsSync(changelogDir)) {
    fs.mkdirSync(changelogDir, { recursive: true });
  }

  if (!fs.existsSync(changelogPath)) {
    const header =
      `---\n` +
      `type: changelog\n` +
      `date: ${dateStr}\n` +
      `---\n\n` +
      `# Changelog ${dateStr}\n\n` +
      `Auto-logged file edits from Claude Code sessions. One line per Write/Edit.\n\n`;
    fs.writeFileSync(changelogPath, header, 'utf8');
  }

  const action = toolName.toLowerCase();
  const line = `- ${timeStr} · ${action} · \`${filePath}\`\n`;
  fs.appendFileSync(changelogPath, line, 'utf8');
  log.info(HOOK, `appended ${action} ${filePath}`);
} catch (err) {
  log.error(HOOK, `append failed: ${err.message}`);
}

process.exit(0);
