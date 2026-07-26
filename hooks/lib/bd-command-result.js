'use strict';

// bd-command-result.js — did the `bd` command that just ran actually succeed?
// (cp-snh2)
//
// The beads hooks fire on PostToolUse and, until this module, keyed purely off
// the command TEXT. A `bd close` that ERRORED still emitted "beads issue <id> is
// now closed" into the model's context and still drove the vault TaskNotes
// mirror. Observed live: a malformed `bd close cp-uif3.3 --reason="" --dry-run`
// closed nothing (invalid flag, non-zero exit) yet announced a closure.
//
// That is worse than a missing reminder: it tells the model a state change
// happened that did not, so the model stops tracking real work and the mirror
// records an event with no counterpart in beads.
//
// Deliberately CONSERVATIVE. It suppresses only when failure is positively
// visible, and emits whenever the outcome cannot be determined. The mirror is
// already under-firing (cp-na6c measured it at 46%), so wrongly dropping a REAL
// event would deepen the exact problem these hooks exist to solve. Silence is
// only correct when we can see the command failed.

// bd prints a check mark on every successful mutation:
//   ✓ Created issue: cp-abc — title
//   ✓ Updated issue: cp-abc — title
//   ✓ Closed cp-abc — title: reason
const SUCCESS_RE = /(?:^|\n)\s*[✓✔]\s*(?:Created|Updated|Closed|Reopened)/i;

// Shapes bd/the shell produce on failure. `Error:` covers bd's own errors,
// `Usage:` covers an invalid flag or arity, and the unknown-flag wording covers
// the CLI parser rejecting the command outright.
const FAILURE_RE = /(?:^|\n)\s*(?:Error|error):|(?:^|\n)Usage:|unknown (?:flag|shorthand|command)|flag provided but not defined|required flag/i;

/**
 * @param {object} data  the PostToolUse hook payload
 * @returns {'success'|'failure'|'unknown'}
 */
function bdOutcome(data) {
  const resp = data && data.tool_response;
  if (!resp || typeof resp !== 'object') return 'unknown';

  // Prefer a real exit status when the host provides one — several field names
  // are in circulation and none is guaranteed, hence the text fallbacks below.
  for (const key of ['exit_code', 'exitCode', 'returncode', 'status']) {
    const v = resp[key];
    if (typeof v === 'number') return v === 0 ? 'success' : 'failure';
  }
  if (resp.is_error === true || resp.error === true) return 'failure';
  if (resp.interrupted === true) return 'failure';

  const text = [resp.stdout, resp.output, resp.stderr]
    .filter((s) => typeof s === 'string')
    .join('\n');
  if (!text.trim()) return 'unknown';

  // Success wins a tie: bd routinely prints benign warnings to stderr alongside
  // a successful mutation (the auto-export shrink guard is the common one), and
  // treating that as failure would suppress a real, correct event.
  if (SUCCESS_RE.test(text)) return 'success';
  if (FAILURE_RE.test(text)) return 'failure';
  return 'unknown';
}

/** Should a beads hook act on this command? False only on visible failure. */
function bdSucceeded(data) {
  return bdOutcome(data) !== 'failure';
}

module.exports = { bdOutcome, bdSucceeded, SUCCESS_RE, FAILURE_RE };
