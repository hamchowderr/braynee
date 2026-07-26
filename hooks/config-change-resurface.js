#!/usr/bin/env node
'use strict';

// config-change-resurface.js
// Hook: ConfigChange (matcher: user_settings|project_settings|skills)
//
// HD-1.2 / cp-w4b: Braynee's core thesis is that Claude should not relearn the
// user's conventions every session. But editing the vault/project CLAUDE.md,
// ~/.claude settings, or a skill file mid-session is invisible until the next
// launch — the just-changed convention is not in context. ConfigChange fires
// exactly on these. This hook surfaces a FACTUAL note (per cp-psc / HD-R2.2:
// documented hookSpecificOutput shape, factual statement, no imperative) that
// the configuration source changed and which file Claude should re-read.
//
// Non-blocking: emits additionalContext only; never exit 2 / decision block
// (policy_settings can't be blocked anyway and Braynee is advisory here).

const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

const HOOK = 'config-change-resurface';

// Human-readable description of what each ConfigChange source maps to, plus
// the concrete file(s) Claude would re-read to pick the change back up.
function describeSource(source, data) {
  const home = os.homedir();
  const dir = sessionDir(data);
  switch (source) {
    case 'user_settings':
      return {
        what: 'user settings / global instructions',
        files: [
          path.join(home, '.claude', 'settings.json'),
          path.join(home, '.claude', 'CLAUDE.md'),
        ],
      };
    case 'project_settings':
      return {
        what: 'project settings / project instructions',
        files: [
          path.join(dir, '.claude', 'settings.json'),
          path.join(dir, 'CLAUDE.md'),
        ],
      };
    case 'skills':
      return { what: 'an installed skill', files: [] };
    default:
      return { what: source || 'a configuration source', files: [] };
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }
    const source = data.source || data.hook_event_name || 'unknown';
    log.info(HOOK, `ConfigChange source=${source}`);

    const { what, files } = describeSource(source, data);
    const existing = files.filter(f => {
      try { return fs.existsSync(f); } catch { return false; }
    });

    const fileNote = existing.length
      ? ` The current on-disk file(s): ${existing.join(', ')}.`
      : '';

    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'ConfigChange',
        additionalContext:
          `Configuration changed during this session: ${what} (source: ${source}). ` +
          `Any conventions, instructions, or skill behavior loaded at session start may now be out of date relative to disk.${fileNote}`,
      },
    }));
  } catch (e) {
    try { log.error(HOOK, `crash: ${e.message}`); } catch { /* logging must never break the hook */ }
  }
  process.exit(0);
});
