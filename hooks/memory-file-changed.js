#!/usr/bin/env node
'use strict';

// memory-file-changed.js
// Hook: FileChanged (matcher: MEMORY.md) — resyncs the memory index whenever
// MEMORY.md changes on disk, regardless of HOW it changed.
//
// HD-2.6 / HD-12.3 / cp-72a: memory-index-sync.js only fires on the `Write`
// tool, so a memory note added/edited via Edit / Bash / `obsidian` CLI / the
// external Obsidian app silently drifts the index. FileChanged fires on the
// file changing however it changed (including edits made entirely outside
// Claude). A change to MEMORY.md is the trigger to re-walk the memory
// directory and reconcile every note's entry — strictly broader than a wider
// PostToolUse matcher.
//
// Re-entrancy: resyncAllMemoryNotes only writes MEMORY.md when an entry is
// actually missing or stale, so a no-op change does not loop (the write is
// skipped, no further FileChanged fires).
//
// Output: a FACTUAL additionalContext note via the documented
// hookSpecificOutput shape (cp-psc / HD-R2.2) only when the index actually
// changed; silent otherwise.

const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { resyncAllMemoryNotes } = require(path.join(__dirname, 'lib', 'memory-index.js'));

const HOOK = 'memory-file-changed';

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }
    const changeType = data.change_type || 'modified';
    const filePath = data.file_path || '(MEMORY.md)';
    log.info(HOOK, `MEMORY.md ${changeType} (${filePath}) — resyncing index`);

    const s = resyncAllMemoryNotes();
    log.info(HOOK, `resync: scanned=${s.scanned} added=${s.added} updated=${s.updated}`);

    if (s.added > 0 || s.updated > 0) {
      const parts = [];
      if (s.added > 0) parts.push(`added ${s.added}`);
      if (s.updated > 0) parts.push(`refreshed ${s.updated}`);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'FileChanged',
          additionalContext: `Memory index reconciled after a non-Write change to MEMORY.md: ${parts.join(', ')} entr${(s.added + s.updated) === 1 ? 'y' : 'ies'} across ${s.scanned} memory note(s). MEMORY.md now matches the memory directory.`,
        },
      }));
    }
  } catch (e) {
    try { log.error(HOOK, `crash: ${e.message}`); } catch {}
  }
  process.exit(0);
});
