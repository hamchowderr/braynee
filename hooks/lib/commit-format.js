'use strict';

// commit-format.js — pure parsing + checking behind the commit/PR format guard
// (cp-lj73.2). No I/O, no git calls: everything here is a string in, verdict out,
// so the hook stays thin and the rules are unit-testable in isolation.
//
// The STANDARD this enforces is not defined here. It is authored once, in
// skills/setup/rules-templates/commit-pr-conventions.md (cp-lj73.1), and
// installed to ~/.claude/rules/commit-pr-conventions.md. This file implements a
// checkable subset of it and CITES it; it deliberately does not restate it.
// Restating would create a second source of truth that drifts from the first.

/** Conventional Commit types, straight from the rule's table. */
const TYPES = [
  'feat', 'fix', 'perf', 'refactor', 'test', 'docs',
  'build', 'ci', 'chore', 'style', 'revert',
];

/** Where the installed rule lives — quoted in every hint so it can be read. */
const RULE_PATH = '~/.claude/rules/commit-pr-conventions.md';

// type(scope)!: summary
const CONVENTIONAL = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?:[ \t]*(.*)$/;

// The rule's subject target. Not a hard limit here — see checkSubject.
const SUBJECT_TARGET = 50;

// Flag forms that mean "the message does not come from this command line", so
// there is nothing for the guard to read and it must not guess:
//   -F/--file           message from a file
//   -C/--reuse-message, -c/--reedit-message   message from another commit
//   --amend without -m  reuses the existing message (editor or as-is)
//   --no-edit           accept whatever is already there
//   --fixup/--squash    git generates the subject itself
const MESSAGE_ELSEWHERE =
  /(?:^|\s)(?:-F|--file|-C|--reuse-message|-c|--reedit-message|--no-edit|--fixup|--squash)(?:[=\s]|$)/;

/**
 * Pull a flag's value out of a raw command string.
 * Handles `--name value`, `--name=value`, and single/double quoting.
 * Returns null when the flag is absent.
 */
function flagValue(command, names) {
  const alts = names.map((n) => n.replace(/[-]/g, '\\-')).join('|');
  const re = new RegExp(`(?:^|\\s)(?:${alts})(?:=|\\s+)('[^']*'|"[^"]*"|[^\\s]+)`);
  const m = re.exec(String(command));
  if (!m) return null;
  return unquote(m[1]);
}

function unquote(s) {
  const t = String(s).trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/**
 * Extract a commit message from one piece of command text.
 *
 * Returns null when the message is not in that text at all (editor commit, -F,
 * --amend --no-edit …). Null means "cannot judge", and the caller must let the
 * commit through — a guard that blocks what it cannot read is just an obstacle.
 *
 * Callers should use commitMessageFor() rather than calling this directly; the
 * choice of WHICH text to read is the subtle part.
 */
function extractCommitMessage(command) {
  const raw = String(command || '');

  // 1. Heredoc, including the <<- indented form and quoted/unquoted delimiters.
  //    Non-greedy body, terminator anchored to its own line.
  const here = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1\r?\n([\s\S]*?)\r?\n[ \t]*\2(?:\s|$)/.exec(raw);
  if (here) {
    const body = here[3].trim();
    return body || null;
  }

  // 2. -m / --message, possibly repeated. git joins repeated -m as paragraphs.
  //    `-[A-Za-z]*m` also catches the combined short forms (-am, -sm, -asm).
  const re = /(?:^|\s)(?:--message|-[A-Za-z]*m)(?:=|\s+)('[^']*'|"[^"]*"|[^\s]+)/g;
  const parts = [];
  let m;
  while ((m = re.exec(raw)) !== null) parts.push(unquote(m[1]));
  if (!parts.length) return null;

  const msg = parts.join('\n\n').trim();
  return msg || null;
}

/** True when this `git commit` takes its message from somewhere unreadable. */
function messageIsElsewhere(segment) {
  return MESSAGE_ELSEWHERE.test(String(segment || ''));
}

// A heredoc opener anywhere in the text. `<<` alone would also match `x << 2`.
const HEREDOC_OPENER = /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*/;

/**
 * Pick the right text to read the message from, then read it.
 *
 * Neither source is correct on its own, and getting this wrong means judging
 * text the user never wrote as their commit message:
 *
 *   SEGMENT ONLY — commandSegments() splits on newlines and pipes, and the
 *     commit form Claude Code documents is a heredoc:
 *         git commit -m "$(cat <<'EOF'
 *         feat(x): subject
 *         EOF
 *         )"
 *     whose first segment truncates to `git commit -m "$(cat <<'EOF'`. Reading
 *     that yields the subject `"$(cat` — not Conventional form, so a perfectly
 *     good commit gets BLOCKED. (Asserted in the tests.)
 *
 *   RAW ONLY — the raw command may contain an earlier `-m` that belongs to a
 *     different command:
 *         echo "git commit -m 'oops'" && git commit -m "feat: real subject"
 *     Reading the raw string finds `oops` first and blocks the real, valid
 *     commit on the strength of a quoted string.
 *
 * So: read the SEGMENT, which is correctly scoped to this one command — and
 * fall back to the raw command only when the segment carries a heredoc opener,
 * i.e. only when we can see that splitting is what tore the message apart.
 */
function commitMessageFor(rawCommand, commitSegment) {
  const seg = String(commitSegment || '');
  if (HEREDOC_OPENER.test(seg)) {
    const fromRaw = extractCommitMessage(rawCommand);
    if (fromRaw) return fromRaw;
  }
  return extractCommitMessage(seg || rawCommand);
}

/**
 * Check one subject line (a commit subject or a PR title).
 *
 * Returns { errors, warnings }. The split is the whole policy of this guard:
 *
 *   errors   -> BLOCK. Objective, mechanical, and always fixable by rewording
 *               the very command that was just rejected.
 *   warnings -> ALLOW + report. Anything needing judgment, where a wrong call
 *               would block a correct commit. cp-0oqe is the precedent: a guard
 *               that fires on correct usage teaches the override as a reflex,
 *               which erodes it for the cases that matter.
 */
function checkSubject(subject, { label = 'Commit subject' } = {}) {
  const errors = [];
  const warnings = [];
  const s = String(subject || '').trim();

  if (!s) {
    errors.push(`${label} is empty.`);
    return { errors, warnings };
  }

  const m = CONVENTIONAL.exec(s);
  if (!m) {
    errors.push(
      `${label} is not Conventional Commits form. Expected \`type(scope): summary\` ` +
      `— got "${s}".`
    );
    return { errors, warnings };
  }

  const [, type, scope, bang, summary] = m;

  if (!TYPES.includes(type)) {
    // A capitalised or otherwise near-miss type is the common case, so name the
    // closest legal one instead of only listing all eleven.
    const lower = type.toLowerCase();
    const near = TYPES.includes(lower) ? ` Did you mean \`${lower}\`?` : '';
    errors.push(
      `"${type}" is not a Conventional Commit type.${near} ` +
      `Valid: ${TYPES.join(', ')}.`
    );
  }

  if (!summary.trim()) {
    errors.push(`${label} has a type but no summary after the colon.`);
  }

  if (scope !== undefined && !scope.trim()) {
    errors.push(`${label} has an empty scope — write \`${type}: …\` or \`${type}(scope): …\`.`);
  }

  // ── warnings ──────────────────────────────────────────────────────────────
  if (s.length > SUBJECT_TARGET) {
    warnings.push(
      `${label} is ${s.length} chars; the rule's target is ${SUBJECT_TARGET}.`
    );
  }

  const first = summary.trim().split(/\s+/)[0] || '';
  if (first && NON_IMPERATIVE.test(first)) {
    warnings.push(
      `"${first}" is not imperative mood — read the subject as ` +
      `"if applied, this commit will ${first.toLowerCase()}…".`
    );
  }

  if (NOISE.test(summary)) {
    warnings.push(
      `"${summary.trim()}" reads like in-progress noise; the rule says squash ` +
      `these before merge.`
    );
  }

  if (bang) {
    warnings.push('`!` marks a BREAKING CHANGE — that means a major version bump.');
  }

  return { errors, warnings };
}

// Past tense / third person / gerund. Deliberately a SHORT explicit list plus
// -ed and -ing: a bare /s$/ would flag ordinary imperatives like "process",
// "address", "pass" and turn a nudge into noise.
const NON_IMPERATIVE =
  /^(?:adds|added|adding|fixes|fixed|fixing|updates|updated|updating|removes|removed|removing|changes|changed|changing|creates|created|creating|makes|made|making|bumps|bumped|bumping|[a-z]+(?:ed|ing))$/i;

const NOISE = /^\s*(?:wip\b|oops\b|typo\b|fix\s+typo\b|address(?:ing|ed)?\s+review\b|misc\b|stuff\b|more\s+(?:fixes|changes|work)\b|\.+$)/i;

/**
 * beads issue ids referenced anywhere in a message — subject `(cp-lj73.2)`,
 * a `Refs:`/`Closes:` footer, or prose. Any of those traces the commit back to
 * its issue, which is the property the rule asks for; which SHAPE is canonical
 * is cp-lj73.4's decision, so this stays deliberately permissive.
 *
 * Over-matching (e.g. "utf-8", "node-20") only ever SILENCES an advisory
 * warning, so the loose end fails in the harmless direction.
 */
function findIssueRefs(text) {
  const out = new Set();
  const re = /\b([a-z][a-z0-9]{0,9}-[a-z0-9]{2,}(?:\.\d+)*)\b/g;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) out.add(m[1]);
  return [...out];
}

module.exports = {
  TYPES,
  RULE_PATH,
  SUBJECT_TARGET,
  flagValue,
  extractCommitMessage,
  commitMessageFor,
  messageIsElsewhere,
  checkSubject,
  findIssueRefs,
};
