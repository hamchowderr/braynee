'use strict';

// git-command.js — the two helpers every PreToolUse *git guard* needs.
//
// Extracted from check-no-main-push.js (cp-lj73.2) rather than copied. Both
// helpers below encode a bug that was found the hard way, and a copy would let
// the second guard silently regress to the pre-fix behavior while the first one
// stayed correct — which is exactly the drift self-test §16 already asserts
// against for the vault-project lookup.

const { execSync } = require('child_process');

/**
 * Split a Bash command into the segments that run as their own command, so a
 * guard can anchor its match INSIDE a segment.
 *
 * cp-fznk: the git guards used to anchor at the start of the WHOLE command
 * (/^\s*git\s+push/), so `git` merely had to not be the first word to slip past.
 * Verified against the shipped 2.1.21 hook:
 *
 *   git commit -m x                -> blocked          (correct)
 *   cd . && git commit -m x        -> ALLOWED          (bypass)
 *   true; git commit -m x          -> ALLOWED          (bypass)
 *   cd . && git push origin main   -> ALLOWED          (bypass)
 *
 * `cd <dir> && git push` is the ordinary way to act on another repo, so the
 * headline guard was defeated by a three-character prefix in everyday use.
 *
 * The anchor stays INSIDE the segment rather than becoming a substring search,
 * because an unanchored search would fire on `echo "git push origin main"` and
 * on commit messages quoting a git command — and a guard that blocks correct
 * usage is one people turn off. This is not a shell parser; it closes the
 * compound-command hole. Over-matching a real git call inside a quoted string
 * fails safe (blocked, retry); under-matching fails open, which is what
 * happened here.
 *
 * NOTE for message-reading callers: this splits on newlines, so a heredoc body
 * is torn apart. Detect the command from the segments, but read its MESSAGE
 * from the raw command string (see commit-format.js/extractCommitMessage).
 */
function commandSegments(command) {
  return String(command)
    .split(/&&|\|\||[;\n|]/)
    .map((s) => s.trim())
    // Strip leading `VAR=value` env assignments so `FOO=1 git commit` is still
    // seen as a git commit. This form previously bypassed the guard entirely,
    // which is why `BRAYNEE_ALLOW_MAIN_COMMITS=1 git commit` LOOKED like a
    // working opt-out — it was never honored, just never matched (cp-ar0c).
    .map((s) => s.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, ''))
    .filter(Boolean);
}

/**
 * Read a per-repo opt-out from .git/config: `braynee.<key>` = true/1/yes.
 *
 * cp-ar0c: an env-var opt-out is read from the HOOK's process, which inherits
 * Claude Code's environment — not the shell command being checked. So neither
 * `export BRAYNEE_X=1 && git commit` nor the inline `BRAYNEE_X=1 git commit`
 * prefix can ever reach it: the hook has already run and exited by the time any
 * shell would apply them. That left the documented escape hatch settable only
 * from a shell profile BEFORE launching CC — unusable by the agent the message
 * addresses.
 *
 * .git/config fixes that: explicit, durable, greppable, scoped to one repo, and
 * settable mid-session. Deliberately NOT a tracked file — that could be
 * committed and would then travel to other users.
 *
 *   git config --local braynee.<key> true
 */
function repoAllows(cwd, key) {
  try {
    const v = execSync(`git config --get braynee.${key}`, {
      cwd,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
      windowsHide: true,
    }).trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  } catch {
    // Unset is the overwhelmingly common case and git exits 1 for it, so this
    // is control flow, not an error: no opt-out means the guard stays on.
    return false;
  }
}

module.exports = { commandSegments, repoAllows };
