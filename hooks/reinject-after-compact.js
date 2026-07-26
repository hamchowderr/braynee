#!/usr/bin/env node
// reinject-after-compact.js
// Hook: Re-injects critical context after auto-compaction
// Runs on SessionStart with "compact" matcher (cross-platform replacement for ps1)
// Reads dynamic snapshot from pre-compact-snapshot.js if available
// Stdout is added to Claude's context

const fs = require('fs');
const os = require('os');
const path = require('path');

// Read and discard stdin
let _stdin = '';
process.stdin.on('data', (c) => { _stdin += c; });
process.stdin.on('end', () => emit());

// If stdin is closed/empty, emit immediately after a tick
if (process.stdin.isTTY) emit();

function emit() {
  // Static reminders that always apply
  process.stdout.write(`REMINDERS AFTER COMPACTION:
- NEVER push to main/master. Always feature branch + PR.
- Do ONLY what was explicitly asked. Don't expand scope.
- For API/CLI/SDK integration: check latest docs via WebFetch FIRST.
- Destructive commands (rm -rf, git reset --hard, DROP TABLE, etc.): explain and confirm before executing.
- curl requests: follow logical API order (auth -> parent resource -> child resource -> verify).
- Check for existing skills/plugins before building from scratch.
- Show diffs and wait for approval after each fix.
- When working on tasks: use beads (bd ready / bd update / bd close) — beads is the source of truth.
- Keep updating the active session note (Decisions, Progress, Blockers) as you work.
`);

  // Dynamic snapshot from PreCompact hook
  const snapshotPath = path.join(os.homedir(), '.claude', 'compact-snapshot.json');
  if (!fs.existsSync(snapshotPath)) { process.exit(0); }

  let snapshot;
  try {
    snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch {
    process.exit(0);
  }

  // Only use snapshot if it's less than 30 minutes old
  const ageMin = (Date.now() - new Date(snapshot.timestamp).getTime()) / 1000 / 60;
  if (!Number.isFinite(ageMin) || ageMin >= 30) { process.exit(0); }

  const out = [];
  out.push('');
  out.push('=== SESSION STATE (restored after compaction) ===');
  if (snapshot.projectName) out.push(`Project: ${snapshot.projectName}`);
  if (snapshot.branch) out.push(`Branch: ${snapshot.branch}`);

  // Active session note content
  if (snapshot.sessionNotePath && fs.existsSync(snapshot.sessionNotePath)) {
    try {
      const note = fs.readFileSync(snapshot.sessionNotePath, 'utf8');
      out.push('');
      out.push(`── ACTIVE SESSION: ${snapshot.sessionNoteFilename} ──`);
      const sections = ['Goal', 'Decisions', 'Progress', 'Blockers', 'Context'];
      for (const section of sections) {
        const re = new RegExp(`## ${section}\\s*\\n([\\s\\S]*?)(?=\\n## |$)`, 'm');
        const m = note.match(re);
        if (!m) continue;
        const body = m[1].trim();
        if (!body || /^\(none|^\(waiting|^\(session just/.test(body)) continue;
        out.push('');
        out.push(`[${section}]`);
        const lines = body.split('\n');
        if (lines.length > 15) {
          out.push(...lines.slice(0, 15));
          out.push('  ... (truncated)');
        } else {
          out.push(...lines);
        }
      }
      out.push('');
      out.push(`Session file: 2. Areas/Sessions/${snapshot.sessionNoteFilename}`);
      out.push('── END SESSION NOTE ──');
    } catch (e) {
      // Silently skipping means the post-compact context is missing exactly
      // the session note it exists to restore.
      try {
        require(path.join(__dirname, 'lib', 'hook-logger.js'))
          .debug('reinject-after-compact', `session note unreadable: ${e && e.message}`);
      } catch { /* logging must never break reinjection */ }
    }
  } else if (snapshot.sessionNoteFilename) {
    out.push(`Active session: ${snapshot.sessionNoteFilename} (file not found)`);
  }

  // Active timers
  if (Array.isArray(snapshot.activeTimers) && snapshot.activeTimers.length > 0) {
    out.push('');
    out.push('Active timers:');
    for (const t of snapshot.activeTimers) {
      out.push(`  - ${t.taskTitle} (ID: ${t.taskId}, ${t.elapsed}m elapsed)`);
    }
  }

  // In-progress tasks
  if (Array.isArray(snapshot.inProgressTasks) && snapshot.inProgressTasks.length > 0) {
    out.push('');
    out.push('In-progress tasks:');
    for (const t of snapshot.inProgressTasks) {
      out.push(`  - ${t.title} (ID: ${t.id})`);
    }
  }

  // Vault project context
  if (snapshot.vaultContext && snapshot.vaultContextProject) {
    out.push('');
    out.push(`=== VAULT CONTEXT (${snapshot.vaultContextProject}) ===`);
    out.push(snapshot.vaultContext);
    out.push('=== END VAULT CONTEXT ===');
  }

  out.push('=== END SESSION STATE ===');
  process.stdout.write(out.join('\n') + '\n');
  process.exit(0);
}
