// Hook: Notification (agent_needs_input / agent_completed) — cp-hdpr.1
//
// CC 2.1.198 added background-agent notifications: a `claude agents` background
// SESSION that needs input or finishes fires the Notification hook. braynee had
// no coverage of that surface at all.
//
// Scope, stated precisely because the three are easy to conflate:
//   - CC's task list          -> TaskCreated / TaskCompleted (task-*-check.js)
//   - `claude agents` sessions -> THIS hook
//   - in-session Agent-tool subagents -> neither; not covered by any of them
//
// Payload caveat: the docs list the valid matcher values but do NOT document the
// event-specific fields. Confirmed present: hook_event_name, session_id,
// transcript_path, cwd, permission_mode, and `message` (the working Notification
// hook at ~/.claude/hooks/claude-hook-toast.ps1 reads it). Any agent-identifying
// field is UNVERIFIED, so nothing here is hard-coded to one: the kind is read
// across plausible keys and falls back to the message text, and the full payload
// is recorded at debug level so the first real fire documents the true shape
// instead of us guessing at it.
//
// cp-068/HD-4.1: a plain stdout write from a non-UserPromptSubmit hook is NOT
// added to Claude's context — the channel is hookSpecificOutput.additionalContext,
// and the text must be FACTUAL (not imperative) or it trips prompt-injection
// defenses and is shown to the user instead of acted on. Mirrors
// task-completed-check.js.
'use strict';

const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { findCodeRoot, findBeadsRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));
const { bdOut } = require(path.join(__dirname, 'lib', 'bd-safe.js'));

const HOOK = 'agent-notification-check';

function emit(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'Notification', additionalContext: text },
  }));
}

// The matcher already filters, but self-gate in JS too: hooks must never rely on
// config-level gating alone (this repo's cardinal rule — see CLAUDE.md on `if:`).
// Returns 'needs_input' | 'completed' | null.
function classify(data) {
  const explicit = data.notification_type || data.notificationType || data.type
    || data.kind || data.matcher || data.notification || '';
  const hay = `${explicit} ${data.message || ''}`.toLowerCase();
  if (hay.includes('agent_needs_input') || hay.includes('needs input') || hay.includes('needs_input')) return 'needs_input';
  if (hay.includes('agent_completed') || hay.includes('agent completed')) return 'completed';
  return null;
}

// Best-effort: name the beads issue currently claimed in that working directory.
// Independent of the payload, precisely because the payload's agent fields are
// unverified — the cwd is a common field and is enough to be useful.
function claimedIssue(cwd) {
  try {
    const codeRoot = findCodeRoot(cwd);
    if (!codeRoot) return null;
    if (!findBeadsRoot(codeRoot)) return null;
    // bdOut runs through the dolt-server cap guard and returns '' on any failure,
    // so a wedged or absent bd degrades to "no claimed issue" rather than throwing.
    const raw = bdOut('bd list --status=in_progress --json', { cwd: codeRoot });
    if (!raw) return null;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { return null; }
    const list = Array.isArray(parsed) ? parsed : (parsed && parsed.issues) || [];
    if (!list.length) return null;
    // Cap it: this text is injected into context, and a repo with a dozen claimed
    // issues would bury the notification it is meant to annotate.
    const MAX = 3;
    const shown = list.slice(0, MAX).map(i => `${i.id}${i.title ? ` (${String(i.title).slice(0, 60)})` : ''}`);
    const extra = list.length - shown.length;
    return shown.join(', ') + (extra > 0 ? `, +${extra} more` : '');
  } catch (e) {
    log.debug(HOOK, `claimedIssue failed: ${e && e.message}`);
    return null;
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    let data = {};
    if (input) { try { data = JSON.parse(input); } catch { data = {}; } }

    if (data.hook_event_name && data.hook_event_name !== 'Notification') process.exit(0);

    const kind = classify(data);
    if (!kind) process.exit(0); // every other notification kind: stay silent

    // Record the real shape once we are certain this is one of ours. This is how
    // the undocumented fields get documented — see the payload caveat above.
    try {
      log.debug(HOOK, `${kind} payload keys=[${Object.keys(data).join(',')}] raw=${JSON.stringify(data).slice(0, 600)}`);
    } catch { /* logging must never break the hook */ }

    const cwd = sessionDir(data) || data.cwd || process.cwd();
    const claimed = claimedIssue(cwd);
    const msg = String(data.message || '').replace(/\s+/g, ' ').slice(0, 200);

    if (kind === 'needs_input') {
      emit(
        `A background agent session is waiting for input${msg ? `: "${msg}"` : ''}. ` +
        `It is blocked until someone answers, so it is making no progress in the meantime` +
        `${claimed ? `. The beads issue(s) currently claimed in ${cwd} : ${claimed}` : ''}.`
      );
    } else {
      emit(
        `A background agent session finished${msg ? `: "${msg}"` : ''}. ` +
        `Its result is not in this conversation — reading it requires \`claude agents\`` +
        `${claimed ? `. The beads issue(s) still marked in_progress in ${cwd} : ${claimed}, which may now need closing` : ''}.`
      );
    }
  } catch (e) {
    try { log.debug(HOOK, `unhandled: ${e && e.message}`); } catch { /* logging must never break the hook */ }
  }
  process.exit(0);
});
