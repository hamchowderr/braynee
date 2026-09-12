'use strict';

// git-command.js — the helpers every PreToolUse *git guard* needs.
//
// Extracted from check-no-main-push.js (cp-lj73.2) rather than copied. Each
// helper below encodes a bug that was found the hard way, and a copy would let
// a second guard silently regress to the pre-fix behavior while the first one
// stayed correct — which is exactly the drift self-test §16 already asserts
// against for the vault-project lookup.

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
 *
 * Splitting is QUOTE-AWARE. It used to be a plain `.split(/&&|\|\||[;\n|]/)`,
 * which cut on separators inside quoted strings — so a perfectly valid
 *
 *   gh pr create --title "fix(x): do a; then b"
 *   git commit -m "fix: handle a|b"
 *
 * was truncated mid-quote, leaving the segment with an unbalanced quote. The
 * downstream flagValue() then could not match its `"[^"]*"` alternative, fell
 * through to `[^\s]+`, and reported the title as the fragment `"fix(x):` —
 * blocking a correctly-formatted title and telling the author it was malformed.
 * A guard that rejects valid input is worse than one that misses: people turn
 * it off. Any commit subject or PR title containing `;` or `|` hit this.
 *
 * Each piece keeps the separator that ended it and where it starts, so
 * resolveSegments() can tell a piped `cd` (a subshell in POSIX shells) from one
 * that persists, and a heredoc body line from a command.
 */
function splitPieces(command) {
  const out = [];
  let buf = '';
  let start = 0;
  let quote = null; // "'" or '"' while inside a quoted run
  const s = String(command);
  const cut = (sep, next) => { out.push({ text: buf, sep, start }); buf = ''; start = next; };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    // Inside double quotes a backslash escapes the next char (including a quote).
    // Inside single quotes POSIX gives backslash no special meaning.
    if (quote === '"' && c === '\\' && i + 1 < s.length) {
      buf += c + s[i + 1];
      i++;
      continue;
    }

    if (quote) {
      buf += c;
      if (c === quote) quote = null;
      continue;
    }

    if (c === '"' || c === "'") {
      quote = c;
      buf += c;
      continue;
    }

    // Separators, but only out here where the shell would actually see them.
    if (c === '&' && s[i + 1] === '&') { cut('&&', i + 2); i++; continue; }
    if (c === '|' && s[i + 1] === '|') { cut('||', i + 2); i++; continue; }
    if (c === ';' || c === '\n' || c === '|') { cut(c, i + 1); continue; }

    buf += c;
  }

  out.push({ text: buf, sep: '', start });
  return out;
}

// Leading `VAR=value` env assignments. Stripped so `FOO=1 git commit` is still
// seen as a git commit. This form previously bypassed the guard entirely, which
// is why `BRAYNEE_ALLOW_MAIN_COMMITS=1 git commit` LOOKED like a working opt-out
// — it was never honored, just never matched (cp-ar0c).
const ENV_PREFIX = /^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/;

function commandSegments(command) {
  return splitPieces(command)
    .map((p) => p.text.trim())
    .map((s) => s.replace(ENV_PREFIX, ''))
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
 * Pass the directory the git command RUNS in (a resolveSegments() `dir`), never
 * the session cwd: the opt-out belongs to the repo being acted on (cp-2jlh).
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

// ── Where each segment actually runs (cp-2jlh) ───────────────────────────────
//
// A guard asking "is HEAD main?" or "has this repo opted out?" has to ask the
// repo the command acts on. The guards asked the hook payload's `cwd` instead —
// the SESSION's directory — and one command reaches other repos all the time:
//
//   session on main, `cd <repo>/.worktrees/wt && git commit`
//     (wt is on a feature branch)                        -> BLOCKED (wrong repo)
//   session on a feature branch, `cd <repo-on-main> && git commit`  -> ALLOWED
//   session on a feature branch, `git -C <repo-on-main> commit`     -> ALLOWED
//
// resolveSegments() follows the command through directories the way the shell
// would and pairs every segment with the directory it runs in.
//
// FAIL-SAFE RULE: a directory that cannot be KNOWN from the text — a variable,
// command substitution, a glob, ~user, a path that does not exist, eval/source,
// --git-dir/--work-tree/GIT_DIR, a cd inside a heredoc body — becomes unknown,
// and unknown falls back to the payload cwd. That is exactly what every guard
// did before, so a guessed directory is never what lets a command through.
// Nothing here executes command text: a hook must not run what it is judging.

/**
 * Which quoting rules a command follows, from the tool that ran it. hooks.json
 * registers the git guards for both Bash and PowerShell, and a backslash means
 * opposite things in the two: `C:\repo` is a path to PowerShell and `C:repo` to
 * Bash. Anything that is not PowerShell (Bash, Mastra Code's execute_command)
 * is read as POSIX.
 */
function shellFor(toolName) {
  return /powershell/i.test(String(toolName || '')) ? 'powershell' : 'posix';
}

/**
 * Split one segment into shell words, recording for each whether its value can
 * be known without running anything, and where it sits in the segment. The
 * operators the resolver needs come back as { op }: '(' and ')', '&' (background,
 * or PowerShell's call operator) and 'redir' (the next word is a redirect
 * target, not an argument).
 *
 *   POSIX       '…' literal; "…" where \ escapes only $ ` " \; a bare \ escapes
 *               the next character.
 *   PowerShell  '…' literal with '' for a quote; "…" and bare words take ` as
 *               the escape; "" inside "…" is a quote.
 */
function shellWords(segment, shell) {
  const ps = shell === 'powershell';
  const s = String(segment);
  const toks = [];
  let w = null;
  const word = (at) => {
    if (!w) w = { value: '', start: at, end: at, dynamic: false, tilde: false, quoted: false };
    return w;
  };
  const end = (at) => {
    if (w) { w.end = at; toks.push(w); }
    w = null;
  };

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (/\s/.test(c)) { end(i); continue; }

    if (c === "'") {
      word(i).quoted = true;
      while (++i < s.length) {
        if (s[i] !== "'") { w.value += s[i]; continue; }
        if (ps && s[i + 1] === "'") { w.value += "'"; i++; continue; }
        break;
      }
      continue;
    }

    if (c === '"') {
      word(i).quoted = true;
      while (++i < s.length) {
        const d = s[i];
        if (d === '"') {
          if (ps && s[i + 1] === '"') { w.value += '"'; i++; continue; }
          break;
        }
        if (!ps && d === '\\' && i + 1 < s.length && '$`"\\'.includes(s[i + 1])) { w.value += s[++i]; continue; }
        if (ps && d === '`' && i + 1 < s.length) { w.value += s[++i]; continue; }
        if (d === '$' || (!ps && d === '`')) w.dynamic = true;
        w.value += d;
      }
      continue;
    }

    if (c === (ps ? '`' : '\\')) {
      word(i);
      if (i + 1 < s.length) w.value += s[++i];
      continue;
    }

    if (c === '$' || (!ps && c === '`')) {
      word(i).dynamic = true;
      w.value += c;
      // $( … ) is ONE word however many spaces it holds.
      if (s[i + 1] === '(') {
        let depth = 0;
        while (++i < s.length) {
          w.value += s[i];
          if (s[i] === '(') depth++;
          else if (s[i] === ')' && --depth === 0) break;
        }
      }
      continue;
    }

    if (c === '<' || c === '>' || (c === '&' && s[i + 1] === '>')) {
      // `2>` / `2>&1`: a bare fd number glued to the operator belongs to it.
      if (w && !w.quoted && /^\d+$/.test(w.value)) w = null;
      else end(i);
      while ('<>&|'.includes(s[i + 1] || '\u0000')) i++;
      toks.push({ op: 'redir' });
      continue;
    }

    if (c === '(' || c === ')' || c === '&') { end(i); toks.push({ op: c }); continue; }

    if (c === '*' || c === '?' || c === '[') { word(i).dynamic = true; w.value += c; continue; }
    if (c === '~' && !w) { word(i).tilde = true; w.value += c; continue; }
    word(i).value += c;
  }
  end(s.length);
  return toks;
}

/**
 * Git-Bash spells `C:\x` as `/c/x` (Cygwin as `/cygdrive/c/x`). Node on Windows
 * reads `/c/x` as `<current drive>:\c\x`, a different place. Unchanged on every
 * other platform, where `/c/x` really is /c/x.
 */
function toNativePath(p, platform = process.platform) {
  if (platform !== 'win32') return p;
  const m = /^\/(?:cygdrive\/)?([A-Za-z])(\/.*)?$/.exec(p);
  return m ? `${m[1].toUpperCase()}:${m[2] || '/'}` : p;
}

/** Absolute path of the EXISTING directory a word names from `base`, or null. */
function resolveTarget(tok, base, ctx) {
  if (!tok || tok.op || tok.dynamic) return null;
  let p = tok.value;
  // PowerShell's provider expands a leading ~ even inside quotes; POSIX only bare.
  const tilde = ctx.shell === 'powershell' ? p.startsWith('~') : tok.tilde;
  if (tilde) {
    const m = /^~((?:[\\/].*)?)$/.exec(p); // ~user is somebody else's home
    if (!m) return null;
    p = ctx.home + m[1];
  } else if (ctx.shell === 'posix' && process.platform === 'win32' && p.startsWith('/')) {
    p = toNativePath(p);
    // Any other rooted path (/tmp, /usr) lives under Git-Bash's own install.
    if (p.startsWith('/')) return null;
  }
  // `C:repo` is relative to drive C's own current directory, which no hook sees.
  if (process.platform === 'win32' && /^[A-Za-z]:(?![\\/])/.test(p)) return null;
  if (!base && !path.isAbsolute(p)) return null;
  const abs = base ? path.resolve(base, p) : path.resolve(p);
  try {
    return fs.statSync(abs).isDirectory() ? abs : null;
  } catch {
    return null;
  }
}

/** What a command word does to the working directory, if anything. */
function dirVerb(name, shell) {
  if (shell === 'powershell') {
    const n = name.toLowerCase();
    if (n === 'cd' || n === 'chdir' || n === 'sl' || n === 'set-location') return 'cd';
    if (n === 'pushd' || n === 'push-location') return 'pushd';
    if (n === 'popd' || n === 'pop-location') return 'popd';
    if (n === 'iex' || n === 'invoke-expression') return 'opaque';
    return null;
  }
  if (name === 'cd' || name === 'pushd' || name === 'popd') return name;
  if (name === 'eval' || name === 'source' || name === '.') return 'opaque';
  return null;
}

/**
 * Apply one cd / pushd / popd to the tracked location { cur, prev, stack }.
 * Returns the new state; `cur: null` means the directory is now unknowable.
 */
function moveDir(verb, args, st, ctx) {
  const ps = ctx.shell === 'powershell';
  const { cur, prev } = st;
  const stack = st.stack.slice();
  const unknown = () => ({ cur: null, prev: cur, stack });

  let target;              // the positional word; undefined when none was given
  let stackOnly = false;   // POSIX pushd/popd -n: edit the stack, do not move
  for (let k = 0; k < args.length; k++) {
    const t = args[k];
    const v = t.quoted ? '' : t.value;
    if (ps && /^-(?:path|literalpath|lp|pspath)$/i.test(v)) { target = args[k + 1] || null; break; }
    if (!ps && v === '--') { target = args[k + 1]; break; }
    if (!ps && v === '-n' && verb !== 'cd') { stackOnly = true; continue; }
    if (/^[+-]\d+$/.test(v)) return unknown();          // a stack rotation
    if (v.length > 1 && v.startsWith('-')) continue;     // -L, -P, -PassThru, …
    target = t;
    break;
  }
  const bare = (v) => target && !target.quoted && target.value === v;

  if (verb === 'cd') {
    if (bare('+')) return unknown();
    const next = target === undefined ? ctx.home    // a bare cd goes home
      : bare('-') ? prev
        : resolveTarget(target, cur, ctx);
    return { cur: next, prev: cur, stack };
  }

  if (verb === 'pushd') {
    if (stackOnly) { stack.push(resolveTarget(target, cur, ctx)); return { cur, prev, stack }; }
    if (target === undefined) {
      // PowerShell pushes the current location; POSIX swaps the top two.
      if (ps) { stack.push(cur); return { cur, prev, stack }; }
      if (!stack.length) return unknown();
      const top = stack.pop();
      stack.push(cur);
      return { cur: top, prev: cur, stack };
    }
    const next = resolveTarget(target, cur, ctx);
    stack.push(cur);
    return { cur: next, prev: cur, stack };
  }

  // popd
  if (target !== undefined) return unknown();
  if (stackOnly) { stack.pop(); return { cur, prev, stack }; }
  if (!stack.length) return unknown();
  const top = stack.pop();
  return { cur: top, prev: cur, stack };
}

// git's global options — the ones BEFORE the subcommand. Those in the set take
// the next word as their value; `--name=value` is a single word.
const GIT_OPT_WITH_VALUE = new Set([
  '-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env', '--attr-source',
]);
const GIT_OPT_FLAG = /^(?:-p|-P|--paginate|--no-pager|--bare|--no-replace-objects|--(?:literal|glob|noglob|icase)-pathspecs|--no-optional-locks|--no-lazy-fetch|--no-advice|--exec-path|--[a-z][a-z-]*=.*)$/;
// These move the repository away from the working directory, so no directory
// can stand in for it.
const GIT_RELOCATES = /^(?:--git-dir|--work-tree|--bare)(?:=|$)/;
const GIT_ENV = /\bGIT_(?:DIR|WORK_TREE)=/;
const GIT_ENV_STATEMENT = /^(?:export\s[^\n]*)?\bGIT_(?:DIR|WORK_TREE)=|^\$env:GIT_(?:DIR|WORK_TREE)\s*=/i;

/**
 * Read `git <global options> <subcommand> …`: the directory -C moves it to, and
 * which word is the subcommand. -C is cumulative — each relative -C is taken
 * from the previous one, as git documents.
 */
function gitInvocation(words, cur, ctx) {
  let dir = cur;
  let relocated = false;
  let k = 1;
  while (k < words.length && !words[k].dynamic) {
    const v = words[k].value;
    if (GIT_RELOCATES.test(v)) relocated = true;
    if (v === '-C') { dir = resolveTarget(words[k + 1], dir, ctx); k += 2; continue; }
    if (GIT_OPT_WITH_VALUE.has(v)) { k += 2; continue; }
    if (GIT_OPT_FLAG.test(v)) { k++; continue; }
    break;
  }
  return { dir: relocated ? null : dir, sub: k };
}

// A heredoc body is data handed to a program, not commands this shell runs, so
// a `cd` line inside one must never MOVE the tracked directory. It must not be
// silently skipped either — this scan is not quote-aware, and skipping a real
// `cd` would judge the wrong repo — so a directory change inside a body makes
// the directory unknown instead.
function heredocBodies(s) {
  const ranges = [];
  const opener = /<<-?[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n/g;
  let m;
  while ((m = opener.exec(s)) !== null) {
    const from = m.index + m[0].length;
    const term = new RegExp(`\\n[ \\t]*${m[2]}(?=\\s|$)`, 'g');
    term.lastIndex = from - 1;
    const t = term.exec(s);
    const to = t ? t.index + 1 : s.length;
    ranges.push([from, to]);
    opener.lastIndex = Math.max(to, from);
  }
  return ranges;
}

/**
 * Every segment of `command` — the same list commandSegments() returns — each
 * paired with where it runs:
 *
 *   text   the segment, exactly as commandSegments() yields it (a verbatim
 *          slice of the command, bar a stripped NAME=value prefix)
 *   match  the text a guard's pattern should be tested against. For a git call
 *          its global options and any enclosing `( )` / `{ }` / `&` are
 *          removed, so `git -C d -c k=v commit` reads as `git commit` — without
 *          that, the -C form was not just mis-judged but never recognized.
 *          Identical to text for everything else.
 *   dir    the absolute directory the segment runs in; the payload cwd when
 *          that cannot be known (see the fail-safe rule above)
 *
 * opts.shell  'posix' (default) or 'powershell' — see shellFor()
 * opts.home   home for `~` and a bare `cd` (default os.homedir())
 */
function resolveSegments(command, cwd, opts = {}) {
  const ctx = {
    shell: opts.shell === 'powershell' ? 'powershell' : 'posix',
    home: opts.home || os.homedir(),
  };
  const posix = ctx.shell === 'posix';
  const isWord = (t, v) => !!t && !t.op && !t.quoted && t.value === v;
  const raw = String(command);
  const bodies = heredocBodies(raw);
  const inBody = (at) => bodies.some(([from, to]) => at >= from && at < to);

  let st = { cur: cwd || null, prev: null, stack: [] };
  let gitEnvSet = false;   // GIT_DIR / GIT_WORK_TREE assigned earlier in the command
  const subshells = [];    // POSIX `( … )` restores the directory it started in
  const out = [];

  const pieces = splitPieces(raw);
  for (let i = 0; i < pieces.length; i++) {
    const trimmed = pieces[i].text.trim();
    const text = trimmed.replace(ENV_PREFIX, '');
    if (!text) continue;
    const toks = shellWords(text, ctx.shell);

    // Around the command: `(` opens a subshell, `{` and `!` are transparent, a
    // leading `&` is PowerShell's call operator. At the end, `)` closes, `}` is
    // transparent, and `&` backgrounds the whole segment.
    let a = 0;
    let opens = 0;
    while (a < toks.length) {
      const t = toks[a];
      if (t.op === '(') opens++;
      else if (!(t.op === '&' && !posix) && !isWord(t, '{') && !isWord(t, '!')) break;
      a++;
    }
    let b = toks.length;
    let closes = 0;
    let background = false;
    while (b > a) {
      const t = toks[b - 1];
      if (t.op === ')') closes++;
      else if (t.op === '&') background = true;
      else if (!isWord(t, '}')) break;
      b--;
    }
    if (posix) for (let n = 0; n < opens; n++) subshells.push({ st, gitEnvSet });

    const words = [];
    let tangled = false;   // an operator mid-command that is not modeled
    for (let k = a; k < b; k++) {
      if (toks[k].op === 'redir') { k++; continue; }
      if (toks[k].op) { tangled = true; continue; }
      words.push(toks[k]);
    }
    while (posix && words.length > 1 && (isWord(words[0], 'builtin') || isWord(words[0], 'command'))) {
      words.shift();
    }

    const name = words.length && !words[0].dynamic ? words[0].value : '';
    const verb = name ? dirVerb(name, ctx.shell) : null;
    const isGit = posix ? name === 'git' : name.toLowerCase() === 'git';
    // Each element of a POSIX pipeline runs in its own subshell, and a
    // backgrounded command in another process: neither moves this shell.
    const piped = posix && (pieces[i].sep === '|' || (i > 0 && pieces[i - 1].sep === '|'));

    let dir = st.cur;
    let match = text;
    if (verb) {
      if (!piped && !background) {
        st = verb === 'opaque' || tangled || inBody(pieces[i].start)
          ? { cur: null, prev: st.cur, stack: st.stack }
          : moveDir(verb, words.slice(1), st, ctx);
      }
    } else if (isGit) {
      const inv = gitInvocation(words, st.cur, ctx);
      const envHere = GIT_ENV.test(trimmed.slice(0, trimmed.length - text.length));
      dir = gitEnvSet || envHere ? null : inv.dir;
      if (inv.sub < words.length) {
        let last = b - 1;
        while (toks[last].op) last--;
        match = `git ${text.slice(words[inv.sub].start, toks[last].end)}`;
      }
    }
    if (GIT_ENV_STATEMENT.test(text)) gitEnvSet = true;

    out.push({ text, match, dir: dir || cwd });

    if (posix) {
      for (let n = 0; n < closes && subshells.length; n++) ({ st, gitEnvSet } = subshells.pop());
    }
  }
  return out;
}

module.exports = { commandSegments, repoAllows, resolveSegments, shellFor, toNativePath };
