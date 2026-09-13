'use strict';

// git-command.js — the helpers every PreToolUse *git guard* needs.
//
// Extracted from check-no-main-push.js (cp-lj73.2) rather than copied. Each
// helper below encodes a bug that was found the hard way, and a copy would let
// a second guard silently regress to the pre-fix behavior while the first one
// stayed correct — which is exactly the drift self-test §16 already asserts
// against for the vault-project lookup.

const { execSync, execFileSync } = require('child_process');
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
// a cd inside a heredoc a shell runs — becomes unknown, and unknown falls back
// to the payload cwd. That is exactly what every guard did before, so a guessed
// directory is never what lets a command through. A --git-dir / GIT_DIR is
// different (cp-qvkv): it names another repository outright, so it is resolved,
// and when it cannot be the entry is `closed` and guards fail CLOSED on it.
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

/** Absolute path a word names from `base` (existing or not), or null when unknowable. */
function absoluteTarget(tok, base, ctx) {
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
  return base ? path.resolve(base, p) : path.resolve(p);
}

/** A path compared the way the filesystem compares it. */
function normPath(p) {
  const r = path.resolve(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
}

/** The worktree this command creates that contains `dir`, if any (cp-4vfe). */
function pendingFor(pending, dir) {
  if (!dir || !pending || !pending.size) return null;
  const n = normPath(dir);
  for (const e of pending.values()) {
    if (n === e.norm || n.startsWith(e.norm + path.sep)) return e;
  }
  return null;
}

/** Absolute path of the EXISTING directory a word names from `base`, or null. */
function resolveTarget(tok, base, ctx) {
  const abs = absoluteTarget(tok, base, ctx);
  if (!abs) return null;
  // A worktree `git worktree add` creates earlier in the same command does not
  // exist when the hook runs, but it will when the cd does (cp-4vfe).
  if (pendingFor(ctx.pending, abs)) return abs;
  try {
    return fs.statSync(abs).isDirectory() ? abs : null;
  } catch {
    return null;
  }
}

/**
 * The program a command word runs: directories and a Windows .exe stripped, so
 * /usr/bin/git, "C:\…\git.exe" and git.exe are all `git` (cp-qvkv). An exact
 * `name === 'git'` let every one of those spellings commit straight onto main.
 * Case-insensitive where the filesystem is.
 */
function commandName(tok, shell) {
  if (!tok || tok.op || tok.dynamic) return '';
  const base = tok.value.split(/[\\/]/).pop().replace(/\.exe$/i, '');
  return shell === 'powershell' || process.platform === 'win32' ? base.toLowerCase() : base;
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// Programs that run their argument as a command, with the options that take a
// value — so the value is never mistaken for the command.
const WRAPPERS = {
  command: [], builtin: [], exec: ['-a'], nohup: [],
  nice: ['-n', '--adjustment'],
  time: ['-f', '-o', '--format', '--output'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  sudo: ['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U', '-T', '--user', '--group', '--host', '--prompt',
    '--close-from', '--role', '--type', '--other-user', '--command-timeout'],
  xargs: ['-I', '-n', '-L', '-P', '-s', '-d', '-E', '-a', '--arg-file', '--delimiter', '--max-args',
    '--max-lines', '--max-procs', '--max-chars', '--replace', '--eof', '--process-slot-var'],
};
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh']);
const POWERSHELLS = new Set(['pwsh', 'powershell']);

/**
 * The programs a command actually runs (cp-qvkv). `env git commit`,
 * `echo x | xargs git commit`, `find . -exec git commit \;` and
 * `bash -c "git commit"` all run git, but git is not the first word, so a guard
 * matching the first word never saw them.
 *
 * Returns leaves: { words } for a program, or { script, scriptShell } for a
 * command string a shell will run. Each carries the NAME=value words (`env`),
 * `chdir` (env -C / sudo -D) and `unknownDir` (find -execdir runs in a directory
 * known only at run time) that apply to it.
 */
function leafCommands(words, shell) {
  const out = [];
  const walk = (w, env, chdir, unknownDir, depth) => {
    while (w.length && depth < 8) {
      const n = commandName(w[0], shell);
      const afterEq = (t) => ({ ...t, value: t.value.slice(t.value.indexOf('=') + 1), tilde: false });
      if (n === 'env' && shell === 'posix') {
        let i = 1;
        for (; i < w.length && !w[i].dynamic; i++) {
          const v = w[i].value;
          if (v === '-C' || v === '--chdir') { chdir = w[++i]; continue; }
          if (v.startsWith('--chdir=')) { chdir = afterEq(w[i]); continue; }
          if (v === '-u' || v === '--unset') { i++; continue; }
          if (v === '-S' || v === '--split-string') {
            if (w[i + 1]) out.push({ script: w[i + 1], scriptShell: 'posix', env, chdir, unknownDir });
            return;
          }
          if (ASSIGNMENT.test(v)) { env = [...env, w[i]]; continue; }
          if (v.startsWith('-')) continue;
          break;
        }
        w = w.slice(i);
        depth++;
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(WRAPPERS, n) && (shell === 'posix' || n === 'sudo')) {
        const takes = WRAPPERS[n];
        let i = 1;
        for (; i < w.length && !w[i].dynamic; i++) {
          const v = w[i].value;
          if (v === '--') { i++; break; }
          if (n === 'sudo' && (v === '-D' || v === '--chdir')) { chdir = w[++i]; continue; }
          if (n === 'sudo' && v.startsWith('--chdir=')) { chdir = afterEq(w[i]); continue; }
          if (n === 'sudo' && ASSIGNMENT.test(v)) { env = [...env, w[i]]; continue; }
          if (takes.includes(v)) { i++; continue; }
          if (v.length > 1 && v.startsWith('-')) continue;
          break;
        }
        if (n === 'timeout') i++; // its duration
        w = w.slice(i);
        depth++;
        continue;
      }
      if (n === 'find') {
        for (let i = 1; i < w.length; i++) {
          const v = w[i].dynamic ? '' : w[i].value;
          if (!/^-(?:exec|execdir|ok|okdir)$/.test(v)) continue;
          let j = i + 1;
          while (j < w.length && (w[j].dynamic || (w[j].value !== ';' && w[j].value !== '+'))) j++;
          walk(w.slice(i + 1, j), env, chdir, unknownDir || v.endsWith('dir'), depth + 1);
          i = j;
        }
        return;
      }
      if (n === 'cmd') {
        // cmd.exe runs everything after /c or /k (cp-4vfe); Git-Bash spells them //c.
        for (let i = 1; i < w.length; i++) {
          const v = w[i].dynamic ? '' : w[i].value;
          if (/^\/\/?[ck]$/i.test(v)) {
            const rest = w.slice(i + 1);
            if (rest.length) {
              const value = rest.length === 1 ? rest[0].value
                : rest.map((t) => (/[\s"]/.test(t.value) ? `"${t.value}"` : t.value)).join(' ');
              out.push({ script: { value, dynamic: rest.some((t) => t.dynamic) }, scriptShell: 'cmd', env, chdir, unknownDir });
            }
            return;
          }
          if (!/^\/\/?[a-z](?::\S*)?$/i.test(v)) break;   // /s /q /d /v:on
        }
        break;
      }
      if (shell === 'powershell' && (n === 'start-process' || n === 'saps' || n === 'start')) {
        // Start-Process [-FilePath] <program> [-ArgumentList] <args> (cp-4vfe). The
        // arguments are one string ("commit -m x") or a list ('commit','-m','x').
        let file;
        let list;
        for (let i = 1; i < w.length; i++) {
          const v = w[i].dynamic ? '' : w[i].value.toLowerCase();
          const next = () => {
            let t = w[++i];
            if (t && !t.dynamic && t.value === '@') t = w[++i];
            return t;
          };
          if (/^-(?:filepath|path|fp)$/.test(v)) { file = next(); continue; }
          if (/^-(?:argumentlist|args|al)$/.test(v)) { list = next(); continue; }
          if (/^-(?:workingdirectory|wd)$/.test(v)) { chdir = next(); continue; }
          if (/^-(?:verb|windowstyle|credential|redirectstandard(?:input|output|error))$/.test(v)) { i++; continue; }
          if (v.startsWith('-') || v === '@') continue;
          if (!file) file = w[i];
          else if (!list) list = w[i];
        }
        if (!file) break;
        const synth = (value, dynamic) => ({ value, start: 0, end: 0, dynamic, tilde: false, quoted: true, synthetic: true });
        const argv = !list ? []
          : list.dynamic ? [synth(list.value, true)]
            : list.value.includes(',') ? list.value.split(',').map((s) => synth(s.trim(), false))
              : shellWords(list.value, 'powershell').filter((t) => !t.op).map((t) => synth(t.value, t.dynamic));
        w = [{ ...file, synthetic: true }, ...argv];
        depth++;
        continue;
      }
      if ((shell === 'posix' && SHELLS.has(n)) || POWERSHELLS.has(n)) {
        const ps = POWERSHELLS.has(n);
        for (let i = 1; i < w.length && !w[i].dynamic; i++) {
          const v = w[i].value;
          if (ps ? /^-(?:c|command)$/i.test(v) : /^-[A-Za-z]*c[A-Za-z]*$/.test(v)) {
            if (w[i + 1]) out.push({ script: w[i + 1], scriptShell: ps ? 'powershell' : 'posix', env, chdir, unknownDir });
            return;
          }
          if (!ps && /^[-+][oO]$/.test(v)) { i++; continue; }
          if (!v.startsWith('-') && !v.startsWith('+')) break;
        }
      }
      break;
    }
    out.push({ words: w, env, chdir, unknownDir });
  };
  walk(words, [], undefined, false, 0);
  return out;
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
    if (ctx.cmd && /^\/d$/i.test(v)) continue;   // cmd.exe `cd /d <dir>` also switches drive
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
    if (ctx.cmd && target === undefined) return { cur, prev, stack };   // cmd.exe `cd` alone only prints
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

/**
 * Read `git <global options> <subcommand> …`: the directory -C moves it to, the
 * --git-dir word if one is given, and which word is the subcommand. -C is
 * cumulative — each relative -C is taken from the previous one, as git documents.
 *
 * --work-tree is skipped on purpose (cp-qvkv): HEAD, and so the branch a commit
 * lands on, belongs to the git DIR. A work tree alone changes neither.
 */
function gitInvocation(words, cur, ctx) {
  let dir = cur;
  let gitDirTok;
  let k = 1;
  while (k < words.length) {
    const v = words[k].value;
    // `--git-dir="$X"` is ONE dynamic word. Stopping at it made `$X` the
    // "subcommand", so the commit behind it was never recognised at all.
    if (words[k].dynamic && !/^--[a-z][a-z-]*=/.test(v)) break;
    if (v === '-C') { dir = resolveTarget(words[k + 1], dir, ctx); k += 2; continue; }
    if (v === '--git-dir') { gitDirTok = words[k + 1] || null; k += 2; continue; }
    if (v.startsWith('--git-dir=')) { gitDirTok = { ...words[k], value: v.slice(10), tilde: false }; k++; continue; }
    if (GIT_OPT_WITH_VALUE.has(v)) { k += 2; continue; }
    if (GIT_OPT_FLAG.test(v)) { k++; continue; }
    break;
  }
  return { dir, gitDirTok, sub: k };
}

/**
 * Split a git subcommand's words into options and positionals. `takes` lists
 * the options that consume the next word; `--name=value` is one word. Words
 * after `--` are returned as `paths`.
 */
function parseArgs(args, takes = []) {
  const opts = [];
  const pos = [];
  let paths = null;
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (paths) { paths.push(t); continue; }
    if (t.dynamic) { pos.push(t); continue; }
    const v = t.value;
    if (v === '--') { paths = []; continue; }
    if (v.length < 2 || !v.startsWith('-')) { pos.push(t); continue; }
    const eq = v.indexOf('=');
    if (v.startsWith('--') && eq > 0) {
      opts.push({ name: v.slice(0, eq), value: { ...t, value: v.slice(eq + 1), tilde: false } });
    } else if (takes.includes(v)) {
      opts.push({ name: v, value: args[i + 1] || null });
      i++;
    } else {
      opts.push({ name: v });
    }
  }
  return { opts, pos, paths };
}

const literal = (t) => (t && !t.dynamic ? t.value : null);
const CREATE_BRANCH = ['-b', '-B', '-c', '-C', '--create', '--force-create', '--orphan'];

/** The branch `git rebase` rewrites when it names one: `rebase <upstream> <branch>`. */
function rebaseBranch(args) {
  const p = parseArgs(args, ['--onto', '-s', '--strategy', '-X', '--strategy-option', '-x', '--exec']);
  const at = p.opts.some((o) => o.name === '--root') ? 0 : 1;
  return p.pos.length > at ? literal(p.pos[at]) : undefined;
}

/**
 * Where HEAD points after this git call (cp-qvkv): a branch name, 'HEAD' when
 * detached, null when it cannot be told, undefined when HEAD does not move.
 * `git checkout <x>` alone is a switch, a detach or a file restore depending on
 * what <x> is in that repo, so that one case asks git.
 */
function projectBranch(seg, ctx) {
  const { sub, args } = seg.git;
  if (sub === 'switch' || sub === 'checkout') {
    const p = parseArgs(args, ['-b', '-B', '-c', '-C', '--orphan']);
    const create = p.opts.find((o) => CREATE_BRANCH.includes(o.name));
    if (create) return literal(create.value);
    if (p.opts.some((o) => o.name === '--detach' || (sub === 'switch' && o.name === '-d'))) return 'HEAD';
    if (sub === 'checkout') {
      if (p.opts.some((o) => o.name === '-p' || o.name === '--patch')) return undefined;
      // `checkout -- <paths>` and `checkout <tree-ish> -- <paths>` restore files.
      if (p.paths && (p.paths.length || !p.pos.length)) return undefined;
      if (p.pos.length > 1) return undefined;
    }
    if (!p.pos.length) return undefined;
    const name = literal(p.pos[0]);
    if (name === null || name === '-' || /^@\{-\d+\}$/.test(name)) return null;
    if (p.opts.some((o) => o.name === '--track' || o.name === '-t')) {
      return name.includes('/') ? name.slice(name.indexOf('/') + 1) : name;
    }
    if (sub === 'switch') return name;
    const kind = ctx.probe.refKind(seg, name);
    return kind === 'branch' ? name : kind === 'commit' ? 'HEAD' : kind === 'path' ? undefined : null;
  }
  if (sub === 'branch') {
    const p = parseArgs(args);
    if (!p.opts.some((o) => ['-m', '-M', '--move'].includes(o.name))) return undefined;
    if (p.pos.length === 1) return literal(p.pos[0]);        // renames the CURRENT branch
    if (p.pos.length === 2) {
      const to = literal(p.pos[1]);
      return to === null || to === 'main' || to === 'master' ? null : undefined;
    }
    return undefined;
  }
  if (sub === 'symbolic-ref') {
    const p = parseArgs(args, ['-m']);
    if (p.pos.length !== 2 || literal(p.pos[0]) !== 'HEAD') return undefined;
    const to = literal(p.pos[1]);
    return to === null ? null : to.replace(/^refs\/heads\//, '');
  }
  if (sub === 'rebase') return rebaseBranch(args);
  return undefined;
}

/**
 * Does this push send HEAD's own branch (cp-qvkv)? A bare push, a HEAD or @
 * refspec, --all, --mirror and --branches all do — with no `main` anywhere in
 * the text, which is how `git push origin HEAD` from main got through.
 */
function pushTargetsHead(args) {
  const p = parseArgs(args, ['--repo', '-o', '--push-option', '--receive-pack', '--exec']);
  const has = (...names) => p.opts.some((o) => names.includes(o.name));
  if (has('--all', '--mirror', '--branches')) return true;
  if (has('--delete', '-d')) return false;
  const refspecs = p.pos.slice(1); // the first positional is the remote
  if (!refspecs.length) return !has('--tags');
  return refspecs.some((r) => r.dynamic || /^\+?(?:HEAD|@)(?::(?:HEAD|@)?)?$/.test(r.value));
}

/**
 * Where a refspec writes (cp-4vfe): the part after ':' (its source when the
 * destination is left empty), without a leading + or refs/heads/. A negative
 * refspec (^ref) writes nothing. Testing the push text for the word `main`
 * blocked `git push origin feature/main`; a destination is exact.
 */
function refDestination(value) {
  if (value.startsWith('^')) return null;
  const spec = value.replace(/^\+/, '');
  const colon = spec.indexOf(':');
  let dst = colon === -1 ? spec : spec.slice(colon + 1);
  if (colon !== -1 && !dst) dst = spec.slice(0, colon);
  return dst.replace(/^refs\/heads\//, '');
}

const protectedName = (name) => (name === 'main' || name === 'master' ? name : '');
const basenameOf = (tok) => {
  const v = literal(tok);
  return v === null ? null : v.split(/[\\/]/).filter(Boolean).pop() || '';
};
const PUSH_TAKES = ['--repo', '-o', '--push-option', '--receive-pack', '--exec'];

/** The main or master a push writes on the remote, by refspec destination; '' when none. */
function pushWritesMain(args) {
  for (const r of parseArgs(args, PUSH_TAKES).pos.slice(1)) {
    const name = r.dynamic ? '' : protectedName(refDestination(r.value) || '');
    if (name) return name;
  }
  return '';
}

/** '--all', '--mirror' or '--branches' when a push sends every local branch; '' otherwise. */
function pushesEveryBranch(args) {
  const o = parseArgs(args, PUSH_TAKES).opts.find((x) => ['--all', '--mirror', '--branches'].includes(x.name));
  return o ? o.name : '';
}

const BRANCH_TAKES = ['-u', '--set-upstream-to', '--points-at', '--contains', '--no-contains', '--merged',
  '--no-merged', '--sort', '--format'];
const FETCH_TAKES = ['--depth', '--deepen', '--shallow-since', '--shallow-exclude', '-j', '--jobs',
  '--negotiation-tip', '--upload-pack', '--refmap', '-o', '--server-option'];

/**
 * What a git call does to the main/master branch REF itself, whichever branch
 * is checked out (cp-4vfe). `git branch -f main HEAD && git push --all` from a
 * feature branch made no commit on main and pushed no HEAD, so no check saw it.
 *
 *   rewrite  { what, ref } when it force-moves, renames or copies onto main or
 *            master, or writes a ref it names unreadably (ref: null)
 *   writes   true when it creates or moves main/master at all, including the
 *            ordinary `git branch main`, `checkout -b main` and `fetch x main:main`
 *            that are not blocked, so a later `push --all` knows main exists
 *
 * `git reset` is deliberately absent: on main it is ordinary local sync, and a
 * push of the result is caught on its own.
 */
function mainRefEffect(git) {
  const { sub, args } = git;
  const none = { rewrite: null, writes: false };
  const named = (t) => (literal(t) === null ? null : protectedName(literal(t)));
  if (sub === 'branch') {
    const p = parseArgs(args, BRANCH_TAKES);
    const has = (...names) => p.opts.some((o) => names.includes(o.name));
    if (!p.pos.length || has('-d', '-D', '--delete', '-l', '--list', '-a', '--all', '-r', '--remotes',
      '--show-current', '--unset-upstream', '--edit-description', '-u', '--set-upstream-to')) return none;
    const move = p.opts.find((o) => ['-m', '-M', '--move', '-c', '-C', '--copy'].includes(o.name));
    const ref = named(p.pos[move && p.pos.length > 1 ? 1 : 0]);
    if (move || has('-f', '--force')) {
      return ref === '' ? none : { rewrite: { what: `git branch ${move ? move.name : '--force'}`, ref }, writes: true };
    }
    return { rewrite: null, writes: ref !== '' };
  }
  if (sub === 'update-ref') {
    const p = parseArgs(args, ['-m']);
    if (p.opts.some((o) => o.name === '--stdin')) return { rewrite: { what: 'git update-ref --stdin', ref: null }, writes: true };
    if (!p.pos.length) return none;
    const v = literal(p.pos[0]);
    const m = v === null ? null : /^refs\/heads\/(main|master)$/.exec(v);
    if (v !== null && !m) return none;
    return { rewrite: { what: 'git update-ref', ref: m ? m[1] : null }, writes: true };
  }
  if (sub === 'checkout' || sub === 'switch') {
    const create = parseArgs(args, ['-b', '-B', '-c', '-C', '--orphan']).opts.find((o) => CREATE_BRANCH.includes(o.name));
    return { rewrite: null, writes: !!create && named(create.value) !== '' };
  }
  if (sub === 'worktree' && literal(args[0]) === 'add') {
    const p = parseArgs(args.slice(1), ['-b', '-B', '--reason']);
    const create = p.opts.find((o) => o.name === '-b' || o.name === '-B');
    if (create) return { rewrite: null, writes: named(create.value) !== '' };
    const detach = p.opts.some((o) => o.name === '--detach' || o.name === '-d');
    return { rewrite: null, writes: !detach && p.pos.length === 1 && protectedName(basenameOf(p.pos[0])) !== '' };
  }
  if (sub === 'fetch') {
    const refs = parseArgs(args, FETCH_TAKES).pos.slice(1);
    return {
      rewrite: null,
      writes: refs.some((r) => !r.dynamic && r.value.includes(':') && protectedName(refDestination(r.value) || '') !== ''),
    };
  }
  return none;
}

/**
 * `git worktree add [-b|-B <new>] [--detach] <path> [<commit-ish>]` (cp-4vfe):
 * the path word, and the branch the new worktree's HEAD will be on — the -b
 * name; HEAD when detached or given a plain commit; the commit-ish when it is a
 * branch; the path's own name when neither is given, as git does. null when
 * that cannot be told.
 */
function worktreeAdd(seg, ctx) {
  const { args } = seg.git;
  if (literal(args[0]) !== 'add') return null;
  const p = parseArgs(args.slice(1), ['-b', '-B', '--reason']);
  if (!p.pos.length) return null;
  const create = p.opts.find((o) => o.name === '-b' || o.name === '-B');
  let proj;
  if (create) proj = literal(create.value);
  else if (p.opts.some((o) => o.name === '--detach' || o.name === '-d')) proj = 'HEAD';
  else if (p.pos.length > 1) {
    const name = literal(p.pos[1]);
    const kind = name === null ? null : ctx.probe.refKind(seg, name);
    proj = kind === 'branch' ? name : kind === 'commit' ? 'HEAD' : null;
  } else proj = basenameOf(p.pos[0]) || null;
  return { path: p.pos[0], proj };
}

/**
 * A cmd.exe command line in the syntax the splitter and the PowerShell word
 * rules read (cp-4vfe): a lone `&` separates commands, `^` escapes the next
 * character, and %NAME% is a variable. Its quotes are only ever double.
 */
function cmdScript(s) {
  let out = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const variable = c === '%' && /^%([A-Za-z_][A-Za-z0-9_]*)%/.exec(s.slice(i));
    if (variable) { out += `$${variable[1]}`; i += variable[0].length - 1; continue; }
    if (c === '"') { quoted = !quoted; out += c; continue; }
    if (quoted) { out += c; continue; }
    if (c === '^' && i + 1 < s.length) {
      const ch = s[++i];
      out += ch === '"' ? "'\"'" : `"${ch}"`;
      continue;
    }
    if (c === '&' && s[i + 1] !== '&' && s[i - 1] !== '&') { out += '\n'; continue; }
    out += c;
  }
  return out;
}

/**
 * Reads a guard needs from git, run where the segment runs (its --git-dir /
 * GIT_DIR included) and memoized for one hook invocation. execFileSync, not a
 * shell string: repo paths reach git verbatim, spaces and all.
 */
function gitProbe() {
  const memo = new Map();
  const run = (seg, args) => {
    const argv = [...(seg.gitDir ? ['--git-dir', seg.gitDir] : []), ...args];
    const key = `${seg.dir}\u0000${argv.join('\u0000')}`;
    if (!memo.has(key)) {
      let r;
      try {
        r = { ok: true, out: execFileSync('git', argv, {
          cwd: seg.probeDir || seg.dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true,
        }).trim() };
      } catch {
        r = { ok: false, out: '' };
      }
      memo.set(key, r);
    }
    return memo.get(key);
  };
  return {
    head: (seg) => {
      const r = run(seg, ['rev-parse', '--abbrev-ref', 'HEAD']);
      return r.ok ? r.out : undefined;
    },
    // Identifies the HEAD a segment moves: one per worktree, whichever subdir.
    key: (seg) => {
      const r = run(seg, ['rev-parse', '--absolute-git-dir']);
      return r.ok ? path.resolve(r.out) : `dir:${seg.gitDir || seg.dir}`;
    },
    refKind: (seg, name) => {
      if (run(seg, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]).ok) return 'branch';
      if (!run(seg, ['rev-parse', '--git-dir']).ok) return null;
      if (run(seg, ['for-each-ref', '--format=%(refname)', `refs/remotes/*/${name}`]).out) return 'branch';
      if (run(seg, ['rev-parse', '--verify', '--quiet', `${name}^{commit}`]).ok) return 'commit';
      return 'path';
    },
    allows: (seg, key) => {
      const r = run(seg, ['config', '--get', `braynee.${key}`]);
      return r.ok && /^(?:true|1|yes)$/i.test(r.out);
    },
    // The repository itself, shared by all of its worktrees, which share refs.
    commonKey: (seg) => {
      const r = run(seg, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      return r.ok ? `repo:${normPath(r.out)}` : `dir:${seg.gitDir || seg.dir}`;
    },
    localMain: (seg) => {
      const r = run(seg, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/main', 'refs/heads/master']);
      return r.ok && r.out ? r.out.split(/\r?\n/)[0] : '';
    },
    remoteMain: (seg) => run(seg, ['for-each-ref', '--format=%(refname)', 'refs/remotes/*/main', 'refs/remotes/*/master']).out !== '',
  };
}

const LIVE = '\u0000live'; // "whatever HEAD is right now" inside a projected branch list

/**
 * The branches a segment's HEAD may be on when it runs: strings, undefined when
 * it is not a repo, null when a switch earlier in the command makes it
 * unknowable. See `branches` in resolveSegments().
 */
function branchesOf(seg, probe) {
  return (seg.branches || [LIVE]).map((b) => (b === LIVE ? probe.head(seg) : b));
}

/**
 * Heredocs, found the way the shell finds them: an unquoted `<<WORD` (not
 * `<<<`) queues a body that starts after the next unquoted newline and runs to
 * a line that is exactly WORD (leading tabs dropped for `<<-`). Returns
 * { opener, from, to }, `to` being where the terminator line starts.
 */
function heredocs(s) {
  const found = [];
  const pending = [];
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") { if (c === "'") quote = null; continue; }
    if (quote === '"') { if (c === '\\') i++; else if (c === '"') quote = null; continue; }
    if (c === '\\') { i++; continue; }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '<' && s[i + 1] === '<' && s[i + 2] !== '<') {
      let j = i + 2;
      const strip = s[j] === '-';
      if (strip) j++;
      while (s[j] === ' ' || s[j] === '\t') j++;
      const m = /^(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/.exec(s.slice(j));
      if (m) { pending.push({ opener: i, word: m[2], strip }); i = j + m[0].length - 1; } else i++;
      continue;
    }
    if (c !== '\n' || !pending.length) continue;
    let at = i + 1;
    for (const h of pending) {
      let to = s.length;
      let next = s.length;
      for (let k = at; k < s.length;) {
        const nl = s.indexOf('\n', k);
        let line = s.slice(k, nl === -1 ? s.length : nl).replace(/\r$/, '');
        if (h.strip) line = line.replace(/^\t+/, '');
        if (line === h.word) { to = k; next = nl === -1 ? s.length : nl + 1; break; }
        if (nl === -1) break;
        k = nl + 1;
      }
      found.push({ opener: h.opener, from: at, to });
      at = next;
    }
    pending.length = 0;
    i = at - 1;
  }
  return found;
}

// Programs that only READ a heredoc body as data. A body fed to anything else —
// a shell, an interpreter, a wrapper — may be executed, so it stays visible.
const DATA_CONSUMERS = new Set([
  'cat', 'tee', 'git', 'gh', 'bd', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'head', 'tail', 'sort', 'uniq',
  'jq', 'yq', 'base64', 'read', 'mapfile', 'readarray', 'patch', 'diff', 'clip', 'xclip', 'pbcopy', 'wl-copy',
]);

/**
 * `command` with the bodies of data-only heredocs removed (cp-qvkv). A commit
 * message or PR body written as `git commit -F - <<'EOF'` is text: read as
 * commands, a line like `git checkout main` in it projects a branch switch that
 * nothing runs. A body reaching a shell (`bash <<EOF`, `cat <<EOF | sh`) keeps
 * its lines, as does a body for any program not known to only read it — so
 * hiding a body can never hide something that runs.
 */
function stripDataHeredocs(command, shell = 'posix') {
  const s = String(command);
  const docs = shell === 'posix' ? heredocs(s) : [];
  if (!docs.length) return s;
  // Pieces over a copy with every body blanked, so a quote inside one body can
  // never merge lines and misattribute the next opener to the wrong command.
  let masked = s;
  for (const d of docs) masked = masked.slice(0, d.from) + masked.slice(d.from, d.to).replace(/[^\n]/g, ' ') + masked.slice(d.to);
  const pieces = splitPieces(masked);
  const reads = (piece) => {
    const toks = shellWords(piece.text.trim().replace(ENV_PREFIX, ''), 'posix').filter((t) => !t.op);
    return DATA_CONSUMERS.has(commandName(toks[0], 'posix'));
  };
  let out = '';
  let last = 0;
  for (const d of docs) {
    let a = 0;
    pieces.forEach((pc, k) => { if (pc.start <= d.opener) a = k; });
    let b = a;
    while (a > 0 && pieces[a - 1].sep === '|') a--;
    while (b < pieces.length - 1 && pieces[b].sep === '|') b++;
    if (!pieces.slice(a, b + 1).every(reads)) continue;
    out += s.slice(last, d.from);
    last = d.to;
  }
  return out + s.slice(last);
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
 * and, for a git call (after unwrapping env, xargs, find -exec, sudo, nice,
 * time, nohup, timeout, bash -c — cp-qvkv):
 *
 *   git       { sub, args } — the subcommand and the words after it
 *   gitDir    the absolute git dir named by --git-dir / GIT_DIR, when it resolves
 *   closed    why the repository cannot be known even though the command names
 *             one (an unresolvable --git-dir / GIT_DIR, find -execdir). Guards
 *             fail CLOSED on it: the cwd fallback would judge a repo the command
 *             explicitly does not use.
 *   branches  the branches HEAD may be on when it runs, after a `git switch` /
 *             `checkout` / `branch -m` earlier in the command — undefined when
 *             nothing moved it. Read it through branchesOf().
 *   probeDir  where git reads for this entry run when that is not `dir`: the
 *             repository adding a worktree this same command creates (cp-4vfe)
 *   mainRefWritten  (push) an earlier git call in the command creates or moves
 *             this repository's main/master ref (cp-4vfe)
 *   extra     true for a further command inside the same segment (a second
 *             find -exec, a `bash -c` string); every segment has exactly one
 *             entry without it
 *
 * opts.shell  'posix' (default) or 'powershell' — see shellFor()
 * opts.home   home for `~` and a bare `cd` (default os.homedir())
 * opts.probe  the gitProbe() to read repos with; a guard shares one per run
 */
function resolveSegments(command, cwd, opts = {}) {
  const cmdMode = opts.shell === 'cmd';
  const ctx = {
    // A cmd.exe script is read with PowerShell's word rules (a backslash is a
    // path separator, not an escape) once cmdScript() has mapped its syntax.
    shell: opts.shell === 'powershell' || cmdMode ? 'powershell' : 'posix',
    cmd: cmdMode,
    home: opts.home || os.homedir(),
    probe: opts.probe || gitProbe(),
    // Worktrees this command creates, by normalized path (cp-4vfe).
    pending: opts.pending || new Map(),
  };
  const posix = ctx.shell === 'posix';
  const depth = opts.depth || 0;
  // Keyed by worktree, and shared with nested `bash -c` scripts: a branch switch
  // is repository state, so no subshell or pipeline undoes it.
  const projections = opts.projections || new Map();
  // Repositories whose main/master ref an earlier git call in this command
  // creates or moves, so a later `push --all` publishes it (cp-4vfe).
  const mainRefs = opts.mainRefs || new Set();
  const isWord = (t, v) => !!t && !t.op && !t.quoted && t.value === v;
  const src = cmdMode ? cmdScript(String(command)) : stripDataHeredocs(command, ctx.shell);
  // Bodies still present are ones a shell may run: follow their commands, but a
  // directory change inside one does not persist past it, so it makes the
  // directory unknown.
  const bodies = posix ? heredocs(src) : [];
  const inBody = (at) => bodies.some(({ from, to }) => at >= from && at < to);

  let st = { cur: cwd || null, prev: null, stack: [] };
  let gitEnv = opts.gitEnv || {};   // { GIT_DIR: word } assigned or exported earlier
  const subshells = [];    // POSIX `( … )` restores the directory it started in
  const out = [];

  const setGitDir = (env, words) => {
    let next = env;
    for (const t of words) {
      const m = !t.op && /^GIT_DIR=([\s\S]*)$/.exec(t.value);
      if (m) next = { ...next, GIT_DIR: { ...t, value: m[1], tilde: m[1].startsWith('~') } };
    }
    return next;
  };

  const gitEntry = (leaf, text, leafDir, env, certain) => {
    const w = leaf.words;
    const inv = gitInvocation(w, leafDir, ctx);
    const e = { text, match: text, dir: inv.dir || cwd, git: { sub: '', args: [] } };
    if (inv.sub < w.length) {
      e.git = { sub: literal(w[inv.sub]) || '', args: w.slice(inv.sub + 1) };
      // Words an unwrapper rebuilt (Start-Process) have no position in `text`.
      e.match = w.some((t) => t.synthetic)
        ? `git ${w.slice(inv.sub).map((t) => (/\s/.test(t.value) ? `"${t.value}"` : t.value)).join(' ')}`
        : `git ${text.slice(w[inv.sub].start, w[w.length - 1].end)}`;
    }
    if (leaf.unknownDir) e.closed = '`find -execdir`, which picks the directory at run time';
    // A worktree this command creates (cp-4vfe) does not exist when the hook runs.
    // Git reads "in" it go to the repository adding it, whose refs and config it
    // shares; its HEAD is the projection recorded at `git worktree add`.
    const pend = pendingFor(ctx.pending, inv.dir);
    if (pend) {
      e.probeDir = pend.origin.dir;
      if (pend.origin.gitDir) e.gitDir = pend.origin.gitDir;
    }
    const tok = inv.gitDirTok !== undefined ? inv.gitDirTok : env.GIT_DIR;
    if (tok !== undefined) {
      const gd = resolveTarget(tok, inv.dir, ctx);
      if (gd) e.gitDir = gd;
      else e.closed = e.closed || 'a --git-dir / GIT_DIR that does not resolve to an existing directory';
    }
    if (e.git.sub) {
      const proj = projectBranch(e, ctx);
      const key = pend ? `wt:${pend.norm}` : (projections.size || proj !== undefined ? ctx.probe.key(e) : null);
      if (key && projections.has(key)) e.branches = projections.get(key);
      if (proj !== undefined) {
        // Only an `&&` guarantees the switch happened before what follows; after
        // `;`, `||`, a pipe or `&` it may have failed, so both are possible.
        const prev = projections.get(key) || [LIVE];
        projections.set(key, certain ? [proj] : [...new Set([...prev, proj])]);
      }
      const wt = e.git.sub === 'worktree' ? worktreeAdd(e, ctx) : null;
      const at = wt && absoluteTarget(wt.path, inv.dir, ctx);
      if (at) {
        const norm = normPath(at);
        ctx.pending.set(norm, { norm, path: at, origin: { dir: e.probeDir || e.dir, gitDir: e.gitDir } });
        // An add that may have failed leaves nothing at the path, so what then
        // runs "in" it cannot be told apart from the old directory.
        projections.set(`wt:${norm}`, certain ? [wt.proj] : [wt.proj, null]);
      }
      if (mainRefEffect(e.git).writes) mainRefs.add(ctx.probe.commonKey(e));
      if (e.git.sub === 'push' && mainRefs.size) e.mainRefWritten = mainRefs.has(ctx.probe.commonKey(e));
    }
    return e;
  };

  const pieces = splitPieces(src);
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
    if (posix) for (let n = 0; n < opens; n++) subshells.push({ st, gitEnv });

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

    const name = commandName(words[0], ctx.shell);
    const verb = name ? dirVerb(name, ctx.shell) : null;
    // Each element of a POSIX pipeline runs in its own subshell, and a
    // backgrounded command in another process: neither moves this shell.
    const piped = posix && (pieces[i].sep === '|' || (i > 0 && pieces[i - 1].sep === '|'));
    const certain = pieces[i].sep === '&&' && !background;
    const here = st.cur;

    const own = [];     // the git calls this segment itself makes
    const inner = [];   // commands inside a `bash -c` string it runs
    if (verb) {
      if (!piped && !background) {
        st = verb === 'opaque' || tangled || inBody(pieces[i].start)
          ? { cur: null, prev: st.cur, stack: st.stack }
          : moveDir(verb, words.slice(1), st, ctx);
      }
    } else if (posix && words.length && words.every((t) => ASSIGNMENT.test(literal(t) || ''))) {
      gitEnv = setGitDir(gitEnv, words);                       // `GIT_DIR=x` on its own
    } else if (posix && name === 'export') {
      gitEnv = setGitDir(gitEnv, words.slice(1));
    } else if (posix && name === 'unset') {
      if (words.some((t) => t.value === 'GIT_DIR')) gitEnv = { ...gitEnv, GIT_DIR: undefined };
    } else if (!posix && /^\$env:GIT_DIR\s*=/i.test(text)) {
      const value = shellWords(text.replace(/^\$env:GIT_DIR\s*=\s*/i, ''), 'powershell').find((t) => !t.op);
      gitEnv = { ...gitEnv, GIT_DIR: value || null };
    } else {
      const prefix = shellWords(trimmed.slice(0, trimmed.length - text.length), ctx.shell).filter((t) => !t.op);
      for (const leaf of leafCommands(words, ctx.shell)) {
        const leafDir = leaf.chdir === undefined ? st.cur : resolveTarget(leaf.chdir, st.cur, ctx);
        const env = setGitDir(gitEnv, [...prefix, ...leaf.env]);
        if (leaf.script) {
          if (leaf.script.dynamic || depth >= 3) continue;
          inner.push(...resolveSegments(leaf.script.value, leafDir || cwd, {
            ...opts, shell: leaf.scriptShell, probe: ctx.probe, depth: depth + 1, projections, gitEnv: env,
            pending: ctx.pending, mainRefs,
          }));
          continue;
        }
        if (commandName(leaf.words[0], ctx.shell) === 'git') own.push(gitEntry(leaf, text, leafDir, env, certain));
      }
    }

    const list = own.length ? own : [{ text, match: text, dir: here || cwd }];
    list.push(...inner);
    list.forEach((e, k) => { if (k > 0) e.extra = true; });
    out.push(...list);

    if (posix) {
      for (let n = 0; n < closes && subshells.length; n++) ({ st, gitEnv } = subshells.pop());
    }
  }
  return out;
}

module.exports = {
  commandSegments, repoAllows, resolveSegments, shellFor, toNativePath, stripDataHeredocs,
  gitProbe, branchesOf, parseArgs, rebaseBranch, pushTargetsHead, pushWritesMain, pushesEveryBranch,
  mainRefEffect,
};
