// vault-search-guard.js
// Hook: PreToolUse (Glob + Grep + Bash) — vault content must be searched with QMD,
// never filesystem search tools. Braynee is vault-centric; the "never grep/find/Glob,
// QMD only" rule is otherwise just CLAUDE.md text with no enforcement.
//
// Why this exists: a no-path Glob/Grep searches the persistent shell cwd, so a vault
// lookup run while the shell sits in a code repo silently searches the WRONG tree and
// returns a false "not found". QMD queries an index, immune to cwd. This guard forces
// vault searches through QMD and leaves code-repo searches completely alone.
//
// Scope (deliberately conservative — never break code work):
//   • Glob / Grep TOOLS — DENY when the effective search root (tool_input.path, else the
//     event cwd) resolves INSIDE the Obsidian vault. A path pointing at a code repo passes.
//   • Bash — DENY a grep/egrep/fgrep/rg/ripgrep/find command with a PATH ARGUMENT that
//     (a) names the vault root in its raw text or (b) RESOLVES inside the vault (relative
//     arguments are resolved against the EVENT cwd, so `../../Obsidian Vault/x` from a code
//     repo is caught and `./src` is not), or (c) that has no path argument at all while the
//     cwd is inside the vault. A pure stdout filter like `qmd … | grep -v x` is never
//     touched, and neither is a precise read of ONE known file (cp-n03f).
//
// cp-ccsh.8: (a) used to compare path.resolve(command) against the vault root. Resolving a
// command STRING as a path prepends the hook PROCESS's cwd, so whenever the hook ran from
// inside the vault, every grep/find — in any directory, naming no vault path — was blocked
// and told the user it was "targeting a vault path". Relative path arguments were also never
// resolved, so a relative path escaping INTO the vault went through. Both are fixed here, and
// the deny message no longer claims "Code-repo searches are unaffected" unconditionally.
//
// cp-n03f: rule (a) went on to test raw-text containment against the WHOLE command, so a
// command that merely MENTIONED the vault root while a search ran somewhere else was blocked
// — writing a test file whose body quoted vault paths, or grepping one known deck file. Each
// time the workaround was to assemble the vault path at runtime so the literal never appeared
// in the command text, which teaches routing AROUND the guard as a reflex; that behavioural
// cost, not the inconvenience, is why it is fixed. (a) now reads the same path ARGUMENTS as
// (b) — see blockReasonForBash for the three changes that made that safe.
//
// Exit 2 = block (stderr reaches Claude), exit 0 = allow. Crash = fail-open (exit 0).
// One-off override for a deliberate filesystem search of the vault: BRAYNEE_ALLOW_VAULT_GREP=1.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const payload = require(path.join(__dirname, 'lib', 'hook-payload.js'));
// Quote-aware splitting/tokenizing is shared with secret-exposure-guard: both
// guards were reading raw command text and blocking work over it (cp-ojk2).
const { stripHeredocBodies, splitSegments, tokenize, baseCmd } =
  require(path.join(__dirname, 'lib', 'shell-parse.js'));
const { getVaultRoot } = require(path.join(__dirname, '..', 'scripts', 'lib', 'vault-root.js'));

const HOOK = 'vault-search-guard';
const PLUGIN_ROOT = path.join(__dirname, '..');
const QMD = path.join(PLUGIN_ROOT, 'scripts', 'qmd-wrapper.mjs');
// cp-0oqe: BRAYNEE_ALLOW_VAULT_GREP is read from THIS process, which inherits
// Claude Code's environment — not the command being checked. So neither
// `export BRAYNEE_ALLOW_VAULT_GREP=1 && grep ...` nor an inline `VAR=1 grep ...`
// prefix can ever reach it: the hook has run and exited before any shell applies
// them. The message advertised an escape hatch that could not be used, which is
// worse than having none. (Same defect class as cp-ar0c on the main-branch guard.)
//
// The ticket file below CAN be created in-session. It is deliberately
// time-limited rather than a permanent switch: an override that stays on is how a
// guard quietly stops guarding.
const TICKET = path.join(os.homedir(), '.claude', 'braynee-allow-vault-grep');
const TICKET_TTL_MS = 5 * 60 * 1000;

function ticketValid() {
  try {
    const age = Date.now() - fs.statSync(TICKET).mtimeMs;
    return age >= 0 && age < TICKET_TTL_MS;
  } catch {
    return false;   // absent is the normal case: guard stays on
  }
}

const ALLOW = process.env.BRAYNEE_ALLOW_VAULT_GREP === '1' || ticketValid();

const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

// Is resolved path `p` at or under the vault root?
function isInsideVault(p, vaultRoot) {
  if (!p || !vaultRoot) return false;
  const rp = norm(p);
  const rv = norm(vaultRoot);
  return rp === rv || rp.startsWith(rv + '/');
}

// cp-4q4h: PowerShell is the default shell on Windows, and its NATIVE search
// verbs read the same files as grep/find. Only cmdlet names that cannot also be
// a POSIX command are listed — `ls` and `dir` are PowerShell aliases for
// Get-ChildItem, but blocking those would fire on every ordinary Bash `ls`, and
// a plain listing is not a content search anyway. Get-ChildItem is treated as a
// search only with -Recurse (see below); Select-String always is.
const SEARCH_TOOL = /\b(grep|egrep|fgrep|rg|ripgrep|find|Select-String|sls|Get-ChildItem|gci)\b/i;
// Matched against ONE token that has been through baseCmd(), so the old
// `(sudo\s+)?` alternative is gone: tokens never contain whitespace, so it could
// not fire, and sudo is now one of the transparent prefixes below.
const SEARCH_CMD = /^(grep|egrep|fgrep|rg|ripgrep|find|Select-String|sls|Get-ChildItem|gci)$/i;
// Pattern-first commands. Select-String's first positional is -Pattern, exactly
// like grep's; Get-ChildItem's first positional is -Path, exactly like find's.
const GREP_FAMILY = /^(grep|egrep|fgrep|rg|ripgrep|Select-String|sls)$/i;
const PS_LIST = /^(Get-ChildItem|gci)$/i;
const PS_RECURSE = /^-(Recurse|r)$/i;
// The token after these IS the path, so it must reach classifyPath.
const PS_PATH_FLAG = /^-(Path|LiteralPath|FilePath)$/i;
// The token after these is a pattern/glob, never a path — skip it.
const PS_VALUE_FLAG = /^-(Pattern|Filter|Include|Exclude|Depth|Context|Encoding)$/i;

// Lowercased, forward-slashed command TEXT. Deliberately NOT path.resolve() —
// resolving a whole command string as if it were a path prepends the hook
// PROCESS's cwd, so when the hook happened to run from inside the vault every
// grep/find in any directory matched the vault root and was blocked while the
// message blamed "a vault path". That was cp-ccsh.8's false-positive class.
const text = (s) => String(s).replace(/\\/g, '/').toLowerCase();

// Flags that consume the FOLLOWING token, so that token is a value (a pattern, a
// glob, a depth) and never a path to test.
const VALUE_FLAGS = new Set([
  '-name', '-iname', '-path', '-ipath', '-regex', '-iregex', '-lname', '-ilname',
  '-maxdepth', '-mindepth', '-type', '-size', '-perm', '-newer', '-mtime', '-user', '-group',
  '-e', '--regexp', '-f', '--file', '--include', '--exclude', '--exclude-dir',
  '--glob', '-g', '-m', '--max-count', '-A', '-B', '-C', '--context',
  '-t', '--type', '--max-depth', '-d', '--depth',
]);

// cp-n03f: a heredoc body is DATA, not command text — writing a file whose
// CONTENT quotes vault paths is not a search. Shared with secret-exposure-guard
// since cp-ojk2, which hit the identical false positive from the other side.
// Rationale and the known limitation live in hooks/lib/shell-parse.js.

// cp-mx34: a path TOKEN is not a path yet — the shell has not expanded it when
// this hook runs. `$HOME/.claude` contains a slash, so it read as a path,
// and path.resolve(cwd, '$HOME/.claude') with the vault as cwd produced
// '<vault>/$HOME/.claude' — "inside the vault". From a vault cwd that made EVERY
// path written with a shell variable or `~` read as a vault path, wherever it
// actually pointed: `find "$HOME/.claude" -iname 'CHANGELOG*'` was blocked while
// looking outside the vault entirely.
//
// Expanding beats merely skipping such tokens: a skip would let
// `grep -r x "$HOME/Obsidian Vault"` through, because rule (a)'s raw-text
// containment does not match the unexpanded string either.
//
// A variable absent from the environment yields null. The caller then ignores the
// token instead of resolving it literally, so an unresolvable path falls through
// to rule (c), which still blocks it when the cwd is the vault.
// Same defect family as cp-ccsh.8: resolving text that is not yet a real path.
//
// cp-ojk2: `vars` carries NAME=VALUE assignments read out of the command itself
// — `P=/c/tools; grep -rn x "$P/CHANGELOG.md"` is one command, and the variable
// it defines is knowable without running anything. Before, $P was unresolvable,
// the token was dropped, and rule (c) blocked a search of /c/tools from a vault
// cwd. Command-local assignments are consulted before the environment, which is
// the order the shell itself uses.
function expandVars(tok, vars) {
  if (!tok) return tok;
  let s = String(tok);
  let unresolved = false;
  const env = (name) => {
    if (vars && Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    const v = process.env[name] ?? process.env[name.toUpperCase()];
    if (v !== undefined && v !== '') return v;
    // cp-sm8n: this hook is a child of Claude Code — a Windows process — not of
    // the shell that will run the command. Git Bash exports HOME; Claude Code
    // does not. So `$HOME/...` arrived unresolvable, the token was dropped, and
    // rule (c) blocked a search of the user's own home directory from a vault
    // cwd. os.homedir() is what the shell would have substituted anyway.
    //
    // Every test missed this because the suite spawns the hook from a Bash-tool
    // child, which INHERITS Git Bash's HOME — so HOME was always set under test
    // and never set in production. The cp-sm8n cases delete it explicitly.
    if (/^(HOME|USERPROFILE)$/i.test(name)) return os.homedir();
    unresolved = true;
    return '';
  };
  // Leading ~ only. ~user names another account's home, which we cannot resolve.
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) {
    s = os.homedir() + s.slice(1);
  }
  // $env: must be tried before $VAR, or the $VAR pattern eats the bare `$env`.
  s = s
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (_, n) => env(n))   // PowerShell
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, n) => env(n))    // ${VAR}
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, n) => env(n))        // $VAR
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, n) => env(n));       // cmd %VAR%
  return unresolved ? null : s;
}

// Classify a token in path position: 'path' (judge it), 'unknown' (a path was
// given but cannot be resolved), or 'no' (not a path argument at all).
//
// cp-ojk2: 'unknown' used to collapse into 'no', which inverted the meaning of
// rule (c). A search whose path argument is an unexpandable variable HAS a path
// argument — it simply is not this hook's to resolve — so treating it as "no
// path given" blocked a search that was probably pointed somewhere else
// entirely. Reporting it separately lets the caller decline to judge instead of
// assuming the worst.
function classifyPath(tok, cwd, vars) {
  if (!tok) return 'no';
  const t = expandVars(tok, vars);
  if (t === null) return 'unknown';   // unresolvable variable — a path we cannot judge
  if (t === '.' || t === '..') return 'path';
  if (/[\\/]/.test(t)) return 'path';
  try { return fs.existsSync(path.resolve(cwd, t)) ? 'path' : 'no'; } catch { return 'no'; }
}

// cp-6t9f: shell redirections are syntax, not path arguments. `2>/dev/null`
// contains a slash, so it read as a path, and resolving it against a
// vault cwd landed "inside the vault" — blocking an ordinary command whose
// search target was somewhere else entirely. Masked until cp-mx34 shipped,
// because a $HOME token was tested first and blocked first.
//
// Stripped up front rather than inside the argument loop: a redirection may
// legally precede the pattern (`grep 2>/dev/null pat file`), so removing them
// first keeps the pattern/path positions correct.
//
// Known limitation: tokenize() has already dropped quotes, so a pattern that
// looks exactly like a redirection (`grep "2>/dev/null" file`) is stripped too.
// That loses a path argument and falls through to rule (c) — it blocks rather
// than allows, which is the safe direction.
const REDIR_BARE = /^\d*(>>?|<)&?\d*$/;      // > >> 2> < 2>&1
const REDIR_ATTACHED = /^\d*(>>?|<)&?\S/;    // 2>/dev/null  >out.txt  <in.txt
function stripRedirections(toks) {
  const out = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    // Check BARE first: `2>&1` matches both patterns.
    if (REDIR_BARE.test(t)) {
      // `2>&1` names its target inline; a bare `>` or `2>` eats the next token.
      if (!/&\d+$/.test(t)) i++;
      continue;
    }
    if (REDIR_ATTACHED.test(t)) continue;
    out.push(t);
  }
  return out;
}

// cp-25t9: the search binary is not always token 0. This function used to read
// toks[0] (plus one hardcoded `sudo` hop), so ANY token in front of the binary
// made the entire segment invisible to the guard and the vault search ran
// unguarded. Nine of thirteen audited shapes leaked, including `LC_ALL=C grep
// -rn x <vault>` — an ordinary thing to type, not an evasion. Introduced by
// cp-0oqe, which correctly required command position but modelled "command
// position" as "first token".
//
// Two prefix classes are skipped, and only these two:
//   • NAME=VALUE assignments, repeatable — `LC_ALL=C`, `A=1 B=2`
//   • wrappers that exec their argument unchanged — sudo, env, command, time,
//     nice, nohup, stdbuf
// The token is then basenamed, so `/usr/bin/grep` and
// `C:\Program Files\Git\usr\bin\grep.exe` are both `grep`.
//
// Their FLAGS are deliberately NOT skipped, which leaves `nice -n 10 grep
// <vault>` and `stdbuf -oL grep <vault>` uncaught. Skipping a leading `-flag`
// after a wrapper would make `command -v grep` — a PATH lookup that reads no
// files at all — parse as a no-path search and get blocked on every vault cwd.
// This guard is an assistive guardrail steering searches to QMD, not a security
// boundary: a missed shape costs a wrong-tree search, a false positive blocks
// real work. The narrow set is the trade that ranking implies.
//
// Out of scope, stated rather than implied:
//   • `xargs` — the path arrives over stdin, so there is no token to inspect.
//     Adding xargs as a wrapper would not help: the segment is piped, so it has
//     no path argument and no cwd rule to trip.
//   • `bash -c '<command>'` — the search lives inside a quoted argument. Rule
//     (a) never rescued this, even while it read raw text: it required a search
//     command in command position, and `bash` is not one, so the vault path in
//     the text was never consulted (cp-n03f re-confirmed it and kept it out).
// Both need a real shell parser. Guessing at quoted content is how a guard
// starts blocking things it does not understand.
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPER = /^(sudo|env|command|time|nice|nohup|stdbuf)$/i;
// The one command that changes where a LATER segment searches (cp-n03f).
const CD = /^(cd|pushd)$/i;

// cp-ojk2: segments come from the shared quote-aware splitter now. Splitting on
// /(\|{1,2}|&&|;)/ ignored quoting, so a separator INSIDE the pattern tore the
// command apart mid-argument: `grep -n -B3 -A3 "a\|b" <path>` split at the
// alternation, leaving a first segment with no path argument, and rule (c)
// blocked a search whose path was sitting in the piece that got cut off.
//
// Path arguments of every search command in the pipeline. Returns
// { paths, sawSearch, noPathCwds } — each path carries the cwd it must be
// resolved against and its resolved form, and noPathCwds holds one entry per
// search command that ran with no path argument at all, i.e. one that searches
// its own cwd.
function searchPathArgs(cmd, cwd) {
  const paths = [];
  const noPathCwds = [];
  let sawSearch = false;
  // NAME=VALUE assignments seen so far in this command, for expandVars.
  const vars = Object.create(null);
  // Keep the separators so a stdin-fed segment can be told from a fresh command.
  // A single `|` pipes stdin in; `||`, `&&` and `;` start a new command that
  // reads the filesystem. `qmd … | grep -v x` must stay untouched — it filters
  // stdout and never searches the vault.
  const parts = splitSegments(cmd);
  // cp-n03f: `cd <dir> && grep …` is the ordinary way to search another tree, and
  // the old rule (a) caught the vault case only incidentally, by containment over
  // the whole command text. With (a) reading path ARGUMENTS, the cwd a later
  // segment actually searches has to be tracked or `cd <vault> && grep -rn x .`
  // reads as a search of the EVENT cwd. It closes a false positive in the other
  // direction too: `cd <repo> && grep -rn x .` issued while the event cwd is the
  // vault, which is how this hook blocked its own author. Only cd/pushd are
  // modelled; every other command leaves the cwd alone.
  let effCwd = cwd;
  for (let s = 0; s < parts.length; s += 2) {
    const segment = parts[s];
    const piped = s > 0 && parts[s - 1] === '|';
    const toks = stripRedirections(tokenize(segment.trim()));
    if (!toks.length) continue;
    let i = 0;
    while (i < toks.length && (ASSIGNMENT.test(toks[i]) || WRAPPER.test(baseCmd(toks[i])))) {
      // Record `P=/some/path` so a later `"$P/file"` resolves (cp-ojk2). Both an
      // inline prefix (`LC_ALL=C grep …`) and a standalone `P=x; grep …` segment
      // land here, which is the shape that was blocking real work.
      const eq = ASSIGNMENT.test(toks[i]) ? toks[i].indexOf('=') : -1;
      if (eq > 0) {
        const value = expandVars(toks[i].slice(eq + 1), vars);
        if (value !== null) vars[toks[i].slice(0, eq)] = value;
      }
      i++;
    }
    const cmdName = i < toks.length ? baseCmd(toks[i]) : '';
    if (CD.test(cmdName)) {
      // cd's own options are -L/-P/-e/-@; a BARE `-` is not one of them, it is
      // the target. Filtering every leading dash would read `cd -` as bare `cd`.
      const target = toks.slice(i + 1).filter((t) => !/^-[LPe@]+$/.test(t))[0];
      // Bare `cd` is $HOME. `cd -` is the previous directory, which is not
      // knowable from one command, so the cwd is left exactly as it was.
      if (target === undefined) effCwd = os.homedir();
      else if (target !== '-') {
        const expanded = expandVars(target, vars);
        if (expanded !== null) {
          try { effCwd = path.resolve(effCwd, expanded); } catch { /* keep the old cwd */ }
        }
      }
      continue;
    }
    if (!cmdName || !SEARCH_CMD.test(cmdName)) continue;
    // A non-recursive Get-ChildItem is a directory listing, not a search. Only
    // -Recurse makes it the `find` equivalent this guard is meant to catch.
    if (PS_LIST.test(cmdName) && !toks.some((t) => PS_RECURSE.test(t))) continue;
    sawSearch = true;
    const isGrep = GREP_FAMILY.test(cmdName);
    i++;
    let patternTaken = !isGrep; // `find` takes paths first; grep takes a pattern first
    // cp-ojk2: `--` ends option parsing. Without it, `grep -roh -- "--no-[a-z-]*" DIR`
    // read the PATTERN as a flag (it starts with a dash), so DIR fell into the
    // pattern slot, no path was seen, and rule (c) blocked a search of DIR. This
    // is the documented way to grep for a pattern that begins with a dash, so the
    // guard was punishing correct usage.
    let endOfOptions = false;
    // A path argument that exists but cannot be resolved (an unset variable).
    // Distinct from "no path argument", which is what rule (c) judges.
    let sawUnknownPath = false;
    const found = [];
    for (; i < toks.length; i++) {
      const t = toks[i];
      if (!endOfOptions && t === '--') { endOfOptions = true; continue; }
      if (!endOfOptions && t.startsWith('-')) {
        // An -e/-f style flag supplies the pattern, so the first bare token after
        // it is a path, not the pattern.
        if (/^(-e|--regexp|-f|--file)$/.test(t)) patternTaken = true;
        // PowerShell names its arguments. -Path/-LiteralPath must NOT be skipped
        // as a value flag: the token after them is the path this guard exists to
        // inspect. Checked before VALUE_FLAGS because that set already holds
        // find's lowercase `-path`, and PowerShell flags are case-insensitive.
        if (PS_PATH_FLAG.test(t)) { patternTaken = true; continue; }
        if (PS_VALUE_FLAG.test(t)) { patternTaken = true; i++; continue; }
        if (VALUE_FLAGS.has(t)) i++;
        continue;
      }
      if (!patternTaken) { patternTaken = true; continue; } // this token is the pattern
      const kind = classifyPath(t, effCwd, vars);
      if (kind === 'path') found.push(t);
      else if (kind === 'unknown') sawUnknownPath = true;
    }
    if (found.length) {
      paths.push(...found.map((raw) => ({ raw, cwd: effCwd, resolved: resolveArg(effCwd, raw, vars) })));
    }
    // A stdin-fed grep with no path reads the pipe, not the cwd — never a vault
    // search, so it must not trip the cwd rule. cp-0oqe: `git -C <vault> log
    // --diff-filter=D --name-only | grep x` was blocked despite being the one way
    // to answer "what did this deleted note contain" — QMD indexes the working
    // tree only, so it structurally cannot. Blocking it left no compliant path.
    // cp-ojk2: an unresolvable path argument still reaches rule (c) — a variable
    // this hook cannot see may well be set in the shell that runs the command,
    // and pointing it into the vault is exactly the bypass cp-mx34 closed. What
    // changes is the REPORT: the old message said "no path argument was given",
    // which is false when one was given and merely could not be resolved, and a
    // wrong diagnosis sends the reader looking for the wrong mistake.
    else if (!piped) noPathCwds.push({ cwd: effCwd, unresolved: sawUnknownPath });
  }
  return { paths, sawSearch, noPathCwds };
}

// Does this argument point at one file that already exists? cp-n03f: a search
// of a KNOWN single file is not what this guard exists to prevent. The harm it
// steers away from is a search whose target is implied — a no-path or recursive
// search follows the cwd and can silently read the wrong tree and report a false
// "not found". An explicit file cannot do that: it either holds the answer or
// grep says nothing. QMD has no equivalent (it answers over an index of notes,
// not "which lines of THIS file match"), so blocking it leaves no compliant way
// to do the work — the shape that teaches the override as a reflex.
//
// Recursion flags are deliberately not consulted: `-r` over a regular file
// expands to that same file, so `grep -rn x <vault>/note.md` reads exactly what
// `grep -n` reads. Directories, globs and paths that do not exist are all
// blocked, so a mistyped file name fails toward blocking.
function isKnownFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

// The path an argument actually points at, or null when that cannot be told.
function resolveArg(base, raw, vars) {
  const expanded = expandVars(raw, vars);
  if (expanded === null) return null;   // unresolvable variable — (c) still guards a vault cwd
  try { return path.resolve(base, expanded); } catch { return null; }
}

// Returns null (allow) or { what, certain } describing why it is blocked.
function blockReasonForBash(cmd, vaultRoot, cwd) {
  if (!SEARCH_TOOL.test(cmd)) return null;   // cheap pre-filter only

  // cp-0oqe: every rule below now requires a real search command in COMMAND
  // POSITION. Rule (a) used to fire on raw text alone, so a command merely
  // CONTAINING the words was blocked:
  //   • `node -e "...split(/\n/).find(l => re.test(l))..."` over one known vault
  //     file — \bfind\b matches inside `.find(`, and the vault path is in the
  //     text, so a read-only precise read of a single file was blocked.
  //   • filing the bug report itself was blocked, because the report QUOTES the
  //     offending command.
  // The cost was behavioral: it taught the override as a reflex, which erodes the
  // guard for the cases that matter. A word boundary is not enough — `.find(`
  // has one. Command position is the discriminator.
  // cp-n03f: rule (a) tested the vault root against the WHOLE command text. Even
  // gated on a search in command position that blocked commands searching
  // something else entirely — a heredoc writing a fixture whose body quotes vault
  // paths, a `grep` over one known deck file. Three changes make (a) read the
  // same path ARGUMENTS as (b), which is what the ticket's option 1 asks for:
  //
  //   • heredoc bodies are dropped, so file CONTENT is never command text;
  //   • containment is tested per path argument, never against the pattern, so
  //     `grep -rn "<vault>" ./src` — searching a code repo FOR the vault path —
  //     stops being a vault search;
  //   • the cwd of each segment is tracked through `cd`, because containment over
  //     the whole command was what incidentally caught `cd <vault> && grep -rn x .`
  //
  // What that gives up: a vault path reachable ONLY as text, i.e. inside a nested
  // quote. `bash -c 'grep -rn x "<vault>"'` is the case, and it was never covered
  // — the old (a) was gated on a search in command position, and `bash` is not
  // one, so the literal in the text was never consulted. It stays out of scope
  // and stays pinned as a known-limitation test: guessing at quoted content is
  // how a guard starts blocking things it does not understand.
  const { paths, sawSearch, noPathCwds } = searchPathArgs(stripHeredocBodies(cmd), cwd);
  if (!sawSearch) return null; // only a `… | grep` stdout filter, or no search at all

  // (a)+(b) A PATH ARGUMENT of that search points at the vault: its raw text
  // names the vault root — text containment, because `$(echo <vault>)/x` reaches
  // a search through a form no resolver can follow — or it RESOLVES there.
  // Relative arguments resolve against the cwd of their own segment, so
  // `../../Obsidian Vault/...` from a code repo is caught and `./src` is not.
  for (const { raw, resolved } of paths) {
    // cp-mx34: expanded before resolving, inside searchPathArgs where the
    // command's own variable assignments are known. `paths` keeps the RAW token
    // so the deny message quotes what was actually typed.
    const namesVault = text(raw).includes(text(vaultRoot));
    const inside = resolved !== null && isInsideVault(resolved, vaultRoot);
    if (!namesVault && !inside) continue;
    if (resolved !== null && isKnownFile(resolved)) continue;   // precise read of one known file
    if (namesVault) {
      return { what: `a grep/find naming a vault path in "${raw}"`, certain: true };
    }
    return { what: `a grep/find whose path argument "${raw}" resolves inside the vault`, certain: true };
  }

  // (c) No path argument at all → the search follows the cwd. Block only when
  // that cwd is the vault; a code-repo cwd is left alone.
  for (const { cwd: base, unresolved } of noPathCwds) {
    if (isInsideVault(base, vaultRoot)) {
      return {
        what: unresolved
          ? 'a grep/find whose path argument could not be resolved (an unset variable) while the working directory is inside the vault'
          : 'a grep/find with no path argument while the working directory is inside the vault',
        certain: false,
        unresolved: !!unresolved,
      };
    }
  }
  return null;
}

function denyMessage(what, terms, certain, unresolved) {
  const t = terms ? terms.slice(0, 60) : 'your terms';
  // The old text asserted "Code-repo searches are unaffected", which was false
  // for exactly the cases that tripped this guard. Say what was actually
  // detected, and separate "this targets the vault" from "I cannot tell what
  // this targets, and the cwd is the vault" (cp-ccsh.8).
  // cp-ojk2: three cases, three tails. Telling "I cannot resolve your variable"
  // apart from "you passed no path" is the difference between a fix the reader
  // can make in one edit and a hunt for a mistake they did not make.
  const tail = certain
    ? 'A search whose path resolves outside the vault is not blocked.'
    : unresolved
      ? 'A path argument was given but could not be resolved here — this hook runs as a ' +
        'child of Claude Code, not of your shell, so a variable your shell sets is invisible ' +
        'to it. Assign it in the SAME command (`P=/some/dir; grep -rn x "$P/f"`) and it ' +
        'resolves, or pass the path literally.'
      : 'No path argument was given, so this cannot be told apart from a vault-wide ' +
        'search. Pass an explicit path outside the vault to run it, or use QMD.';
  return (
    `BLOCKED: ${what}. Vault content must be searched with QMD, not filesystem search ` +
    `(a no-path Glob/Grep follows the shell cwd and can silently search the wrong tree). Use:\n` +
    `  node "${QMD}" search "${t}"      # BM25 keyword\n` +
    `  node "${QMD}" vsearch "${t}"     # semantic\n` +
    `  node "${QMD}" query "${t}"       # deep research\n` +
    `${tail}\n` +
    `If a filesystem read is genuinely required (git history of a deleted note, or a\n` +
    `precise read of one known file), take a 5-minute override — note that setting\n` +
    `the env var inside the command CANNOT work, because this hook already ran:\n` +
    `  node -e "require('fs').writeFileSync(process.env.USERPROFILE + '/.claude/braynee-allow-vault-grep','')"`
  );
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    if (ALLOW) process.exit(0);
    // Host-neutral view: `tool` is the canonical name regardless of whether the
    // host called it Grep or search_content (cp-3o3g.3).
    const p = payload.parse(input);
    const tool = p.tool;
    const ti = p.toolInput;
    const cwd = p.cwd;

    const vaultRoot = getVaultRoot();
    // Fail-open if there is no real vault on disk (nothing to protect).
    if (!vaultRoot || !fs.existsSync(vaultRoot)) process.exit(0);

    // ── Glob / Grep TOOLS ────────────────────────────────────────────────
    if (tool === 'Glob' || tool === 'Grep') {
      const root = ti.path ? path.resolve(cwd, ti.path) : cwd;
      if (isInsideVault(root, vaultRoot)) {
        log.warn(HOOK, `blocked ${tool} against vault (root=${root})`);
        process.stderr.write(denyMessage(`${tool} against the vault`, ti.pattern, true));
        process.exit(2);
      }
      process.exit(0);
    }

    // ── Shell grep/find/rg targeting the vault ───────────────────────────
    //
    // PowerShell is the default shell on Windows (CLAUDE_CODE_USE_POWERSHELL_TOOL),
    // and grep/rg/find are all on PATH there via the Git tooling — so a vault
    // search issued from the PowerShell tool reaches the same binaries and must
    // hit the same guard. Gating this branch on 'Bash' alone left that open
    // (cp-1fdn). PowerShell-NATIVE search verbs (Select-String, Get-ChildItem
    // -Recurse) still need their own patterns in blockReasonForBash — tracked
    // separately; this branch only covers the POSIX-named tools.
    if ((tool === 'Bash' || tool === 'PowerShell') && typeof ti.command === 'string' && ti.command) {
      const reason = blockReasonForBash(ti.command, vaultRoot, cwd);
      if (reason) {
        log.warn(HOOK, `blocked ${tool} search of vault: ${ti.command.slice(0, 80)}`);
        process.stderr.write(denyMessage(reason.what, null, reason.certain, reason.unresolved));
        process.exit(2);
      }
      process.exit(0);
    }

    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
