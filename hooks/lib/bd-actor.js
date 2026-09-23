'use strict';

// bd-actor.js — sign every bd command with WHO is running it.
//
// bd resolves the actor for its audit trail as `--actor`, then $BEADS_ACTOR,
// then git user.name. Nothing ever set the first two, so every change an agent
// made landed in beads signed with the human's git name — the history said the
// owner did everything, and nothing showed what Claude did.
//
// The fix is to put `--actor <name>` straight after `bd` wherever bd is in
// command position. That was chosen over an env prefix on purpose:
//   • `export BEADS_ACTOR=… ; bd …` turns every bd call into a compound command,
//     and a permission rule like `Bash(bd *)` no longer covers it — every bd
//     call would start prompting.
//   • `--actor` is a persistent flag, so `bd --actor x create …` works for every
//     subcommand, and bd records it on events, `created_by` and comment authors
//     (verified on bd 1.3.0).
//
// Conservative by construction: bd inside quotes or a heredoc body is data, not
// a command, and is never touched; a command that already names an actor
// (`--actor`, BEADS_ACTOR, BD_ACTOR) is left exactly as written.

const WRAPPERS = new Set([
  'sudo', 'env', 'command', 'time', 'nice', 'nohup', 'stdbuf', 'xargs',
  // shell keywords that precede a command in the same segment
  'then', 'do', 'else', 'elif', 'if', 'while', 'until', '!', '{',
]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DURATION = /^\d+(\.\d+)?[smhd]?$/;
const ALREADY_SIGNED = /--actor\b|\bBEADS_ACTOR\b|\bBD_ACTOR\b/;

// Same heredoc grammar as shell-parse.js: the body is data handed to another
// program, so bd written inside it (a commit message, a bug report) is not run.
const HEREDOC_BODY = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\r?\n[\s\S]*?\r?\n[ \t]*\2(?=\s|$)/g;
const HEREDOC_UNTERMINATED = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\r?\n[\s\S]*$/;

/** Actor for a hook payload: the main thread is `claude`, a subagent `claude/<type>`. */
function actorFor(raw) {
  const d = raw && typeof raw === 'object' ? raw : {};
  if (!d.agent_id) return 'claude';
  const type = String(d.agent_type || 'subagent').replace(/[^A-Za-z0-9._:-]/g, '-') || 'subagent';
  return `claude/${type}`;
}

// Character ranges that are heredoc bodies (from the line after the opener to
// the closing delimiter). Scanning skips them entirely.
function heredocRanges(s) {
  const ranges = [];
  const add = (m) => {
    const nl = m[0].indexOf('\n');
    if (nl !== -1) ranges.push([m.index + nl + 1, m.index + m[0].length]);
  };
  for (const m of s.matchAll(HEREDOC_BODY)) add(m);
  const covered = (i) => ranges.some(([a, b]) => i >= a && i < b);
  const u = HEREDOC_UNTERMINATED.exec(s);
  if (u && !covered(u.index)) add(u);
  return ranges;
}

function baseName(tok) {
  return String(tok).split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, '');
}

const isSpace = (c) => c === ' ' || c === '\t' || c === '\r';

/**
 * Insert `--actor <actor>` after every bd in command position.
 * @param {string} cmd     the command exactly as the tool will run it
 * @param {string} actor   e.g. "claude" or "claude/Explore"
 * @param {'bash'|'powershell'} shell  decides the escape character
 * @returns {{command: string, changed: boolean}}
 */
function signBdCommand(cmd, actor, shell = 'bash') {
  const s = String(cmd == null ? '' : cmd);
  if (!/\bbd(\.exe)?\b/i.test(s) || ALREADY_SIGNED.test(s)) return { command: s, changed: false };

  const esc = shell === 'powershell' ? '`' : '\\';
  const masked = heredocRanges(s);
  const inMask = (i) => masked.find(([a, b]) => i >= a && i < b);

  const inserts = [];
  let quote = null;
  let atStart = true;

  // Read one token starting at i (quotes kept whole); returns [text, end].
  function readToken(i) {
    let j = i, text = '', q = null;
    while (j < s.length) {
      const c = s[j];
      if (q) { if (c === q) q = null; else text += c; j++; continue; }
      if (c === '"' || c === "'") { q = c; j++; continue; }
      if (isSpace(c) || c === '\n' || ';|&()'.includes(c)) break;
      text += c; j++;
    }
    return [text, j];
  }

  // At a segment start: skip assignments and wrappers, then look at argv[0].
  function head(i) {
    let j = i;
    for (;;) {
      while (j < s.length && isSpace(s[j])) j++;
      const [tok, end] = readToken(j);
      if (!tok) return end > j ? end : j;
      if (ASSIGNMENT.test(tok) || WRAPPERS.has(tok)) { j = end; continue; }
      if (tok === 'timeout') {
        j = end;
        // flags (-k 5, --signal=X) and the duration belong to timeout
        for (;;) {
          while (j < s.length && isSpace(s[j])) j++;
          const [t, e] = readToken(j);
          if (t.startsWith('-')) {
            j = e;
            // -k/-s and their long forms take a value unless written with '='
            if (/^(-k|-s|--kill-after|--signal)$/.test(t)) {
              while (j < s.length && isSpace(s[j])) j++;
              j = readToken(j)[1];
            }
            continue;
          }
          if (DURATION.test(t)) { j = e; }
          break;
        }
        continue;
      }
      if (baseName(tok).toLowerCase() === 'bd' && !inMask(j)) inserts.push(end);
      return end;
    }
  }

  for (let i = 0; i < s.length; i++) {
    const m = inMask(i);
    if (m) { i = m[1] - 1; continue; }
    const c = s[i];
    if (quote) {
      if (c === esc && quote === '"' && i + 1 < s.length) { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === esc && i + 1 < s.length) { i++; atStart = false; continue; }
    if (c === '"' || c === "'") { quote = c; atStart = false; continue; }
    if (c === '\n' || c === ';' || c === '|' || c === '&' || c === '(') { atStart = true; continue; }
    if (isSpace(c)) continue;
    if (c === '#' && atStart) {             // a comment runs to end of line
      while (i + 1 < s.length && s[i + 1] !== '\n') i++;
      continue;
    }
    if (atStart) {
      const end = head(i);
      atStart = false;
      i = Math.max(i, end - 1);
    }
  }

  if (!inserts.length) return { command: s, changed: false };
  let out = s;
  for (const at of inserts.sort((a, b) => b - a)) {
    out = out.slice(0, at) + ` --actor ${actor}` + out.slice(at);
  }
  return { command: out, changed: true };
}

module.exports = { actorFor, signBdCommand };
