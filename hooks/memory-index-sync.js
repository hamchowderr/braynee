#!/usr/bin/env node
'use strict';

// memory-index-sync.js
// Hook: PostToolUse (Write) — keeps MEMORY.md in sync when a memory note is
// written via the Write tool. The index logic lives in lib/memory-index.js,
// shared with memory-file-changed.js (FileChanged:MEMORY.md) so non-Write
// edits don't drift (HD-2.6 / HD-12.3 / cp-72a).

const fs = require('fs');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { syncMemoryIndex } = require(path.join(__dirname, 'lib', 'memory-index.js'));

const HOOK = 'memory-index-sync';

let input;
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'));
} catch (err) {
  log.error(HOOK, `failed to read stdin: ${err.message}`);
  process.exit(0);
}

if (input.tool_name !== 'Write') process.exit(0);

const writtenPath = (input.tool_input || {}).file_path;
if (!writtenPath) process.exit(0);
log.info(HOOK, `triggered for Write on ${writtenPath}`);

const r = syncMemoryIndex(writtenPath);

if (r.action === 'updated') {
  log.info(HOOK, `updated existing entry for ${r.filename} in MEMORY.md`);
  process.stdout.write(JSON.stringify({
    additionalContext: `Memory index updated: refreshed entry for ${r.filename} in MEMORY.md. No manual MEMORY.md edit needed.`,
  }));
} else if (r.action === 'added') {
  log.info(HOOK, `added ${r.filename} to ${r.section} section of MEMORY.md`);
  process.stdout.write(JSON.stringify({
    additionalContext: `Memory index auto-updated: added ${r.filename} to the ${r.section} section of MEMORY.md. No manual MEMORY.md edit needed.`,
  }));
} else {
  log.info(HOOK, `no index change (${r.reason})`);
}

process.exit(0);
