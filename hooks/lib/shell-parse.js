// shell-parse.js — the small amount of shell parsing hooks need to tell
// "this command RUNS tool X" from "the letters x-y-z appear somewhere in the
// text".
//
// Both guards that read a Bash command used to pattern-match the raw string,
// and both blocked work that was never what they guard (cp-ojk2):
//   • vault-search-guard split the command on `|` without honouring quotes, so
//     `grep -n "a\|b" <path>` tore in half and the path landed in the discarded
//     piece;
//   • secret-exposure-guard matched /\binfisical\s+secrets\b/ against the whole
//     string, so `qmd search "infisical secrets rule"` — a SEARCH STRING handed
//     to a different program — was refused, and so was the bug report quoting it.
//
// Quoting is the whole discriminator, and it is cheap to honour exactly. Nothing
// here tries to be a shell: no expansion, no globbing, no `bash -c` recursion.
// It answers one question — what is in command position in each segment — and
// says nothing about the rest.

'use strict';

// A heredoc body is DATA the shell hands to another program, not command text.
// A commit message, a fixture, a bug report written with `git commit -F - <<EOF`
// travels in the same string as the command, and a guard reading it as command
// text refuses to let you WRITE ABOUT the thing it guards. The delimiter says
// exactly where the data ends, so dropping bodies is precise where guessing at
// quoted content would not be.
//
// An unterminated opener means the rest of the string is body, so it goes too.
// That errs toward allowing — the direction a guard should fail in — and a
// command with an unterminated heredoc would not run as written anyway.
//
// `[^\n]*` after the delimiter: the rest of the OPENER line is command, not
// body — `cat <<'EOF' | tee f` and `cat <<'EOF' > f` are both ordinary.
//
// Known limitation, shared by every caller: a body that is itself executed
// (`bash <<'EOF'`) is invisible here too.
const HEREDOC_BODY = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\r?\n[\s\S]*?\r?\n[ \t]*\2(?=\s|$)/g;
const HEREDOC_UNTERMINATED = /<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\r?\n[\s\S]*$/;
function stripHeredocBodies(cmd) {
  return String(cmd).replace(HEREDOC_BODY, ' ').replace(HEREDOC_UNTERMINATED, ' ');
}

// Split on the separators that start a NEW command, ignoring any that appear
// inside quotes or behind a backslash. Returns the alternating
// [segment, separator, segment, …] shape String.split(/(…)/) produced, so a
// caller can still tell a piped segment (stdin) from a fresh one.
function splitSegments(cmd) {
  const parts = [];
  let cur = '', quote = null;
  const s = String(cmd);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (c === '|' || c === '&') {
      const two = s.slice(i, i + 2);
      if (two === '||' || two === '&&') { parts.push(cur, two); cur = ''; i++; continue; }
      if (c === '|') { parts.push(cur, '|'); cur = ''; continue; }
      cur += c;   // a single & backgrounds; it does not start a new command here
      continue;
    }
    if (c === ';') { parts.push(cur, ';'); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts;
}

// Whitespace split that keeps a quoted argument whole, so "Obsidian Vault"
// survives as one token. Quotes themselves are dropped, as the shell drops them.
function tokenize(segment) {
  const out = [];
  let cur = '', quote = null, had = false;
  for (const c of String(segment)) {
    if (quote) {
      if (c === quote) quote = null; else cur += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; had = true; continue; }
    if (/\s/.test(c)) { if (cur || had) { out.push(cur); cur = ''; had = false; } continue; }
    cur += c;
  }
  if (cur || had) out.push(cur);
  return out;
}

// What a shell would exec: directory and Windows extension stripped, so
// /usr/bin/grep and C:\…\grep.exe are both `grep`.
function baseCmd(tok) {
  const base = String(tok).split(/[\\/]/).pop();
  return base.replace(/\.(exe|com|cmd|bat|ps1)$/i, '');
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Wrappers that exec their argument unchanged, so the real command is further
// along. `infisical run -- <cmd>` and `doppler run -- <cmd>` belong here too:
// the command after `--` is the one that runs.
const WRAPPER = /^(sudo|env|command|time|nice|nohup|stdbuf|xargs)$/i;

// Every command in a pipeline, as argv arrays with NAME=VALUE prefixes and
// transparent wrappers removed. A `--` inside a segment also yields the tail as
// its own argv, so `infisical run --silent -- vault read x` reports both
// `infisical run …` and `vault read x`.
function commandsIn(cmd) {
  const argvs = [];
  const parts = splitSegments(cmd);
  for (let s = 0; s < parts.length; s += 2) {
    const toks = tokenize(String(parts[s]).trim());
    if (!toks.length) continue;
    let i = 0;
    while (i < toks.length && (ASSIGNMENT.test(toks[i]) || WRAPPER.test(baseCmd(toks[i])))) i++;
    const argv = toks.slice(i);
    if (argv.length) argvs.push(argv);
    const dash = argv.indexOf('--');
    if (dash !== -1 && dash + 1 < argv.length) argvs.push(argv.slice(dash + 1));
  }
  return argvs;
}

// The leading run of non-flag arguments — a command's subcommand path.
// `infisical secrets get --path=/x` -> ['secrets', 'get']. Stops at `--`
// because what follows is a different command, handled by commandsIn.
function subcommands(argv) {
  const out = [];
  for (let i = 1; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--') break;
    if (t.startsWith('-')) continue;
    out.push(t);
  }
  return out;
}

module.exports = { stripHeredocBodies, splitSegments, tokenize, baseCmd, commandsIn, subcommands };
