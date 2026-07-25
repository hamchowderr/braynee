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
//   • Bash — DENY a grep/egrep/fgrep/rg/ripgrep/find command that (a) names the vault root
//     outright, (b) has a path argument that RESOLVES inside the vault (relative arguments
//     are resolved against the EVENT cwd, so `../../Obsidian Vault/x` from a code repo is
//     caught and `./src` is not), or (c) has no path argument at all while the cwd is inside
//     the vault. A pure stdout filter like `qmd … | grep -v x` is never touched.
//
// cp-ccsh.8: (a) used to compare path.resolve(command) against the vault root. Resolving a
// command STRING as a path prepends the hook PROCESS's cwd, so whenever the hook ran from
// inside the vault, every grep/find — in any directory, naming no vault path — was blocked
// and told the user it was "targeting a vault path". Relative path arguments were also never
// resolved, so a relative path escaping INTO the vault went through. Both are fixed here, and
// the deny message no longer claims "Code-repo searches are unaffected" unconditionally.
//
// Exit 2 = block (stderr reaches Claude), exit 0 = allow. Crash = fail-open (exit 0).
// One-off override for a deliberate filesystem search of the vault: BRAYNEE_ALLOW_VAULT_GREP=1.

'use strict';

const fs = require('fs');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { getVaultRoot } = require(path.join(__dirname, '..', 'scripts', 'lib', 'vault-root.js'));

const HOOK = 'vault-search-guard';
const PLUGIN_ROOT = path.join(__dirname, '..');
const QMD = path.join(PLUGIN_ROOT, 'scripts', 'qmd-wrapper.mjs');
const ALLOW = process.env.BRAYNEE_ALLOW_VAULT_GREP === '1';

const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

// Is resolved path `p` at or under the vault root?
function isInsideVault(p, vaultRoot) {
  if (!p || !vaultRoot) return false;
  const rp = norm(p);
  const rv = norm(vaultRoot);
  return rp === rv || rp.startsWith(rv + '/');
}

const SEARCH_TOOL = /\b(grep|egrep|fgrep|rg|ripgrep|find)\b/i;
const SEARCH_CMD = /^(sudo\s+)?(grep|egrep|fgrep|rg|ripgrep|find)$/i;
const GREP_FAMILY = /^(grep|egrep|fgrep|rg|ripgrep)$/i;

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

// Shell-ish tokenizer: splits on whitespace while honoring quotes, so a path with
// spaces ("Obsidian Vault") survives as ONE token.
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

// A token worth resolving as a filesystem path.
function isPathLike(tok, cwd) {
  if (!tok) return false;
  if (tok === '.' || tok === '..') return true;
  if (/[\\/]/.test(tok)) return true;
  try { return fs.existsSync(path.resolve(cwd, tok)); } catch { return false; }
}

// Path arguments of every search command in the pipeline. Returns
// { paths, sawSearch, noPathSearch } — noPathSearch means a search command ran
// with no path argument at all, i.e. it searches the cwd.
function searchPathArgs(cmd, cwd) {
  const paths = [];
  let sawSearch = false, noPathSearch = false;
  // Keep the separators so a stdin-fed segment can be told from a fresh command.
  // A single `|` pipes stdin in; `||`, `&&` and `;` start a new command that
  // reads the filesystem. `qmd … | grep -v x` must stay untouched — it filters
  // stdout and never searches the vault.
  const parts = String(cmd).split(/(\|{1,2}|&&|;)/);
  for (let s = 0; s < parts.length; s += 2) {
    const segment = parts[s];
    const piped = s > 0 && parts[s - 1] === '|';
    const toks = tokenize(segment.trim());
    if (!toks.length) continue;
    let i = 0;
    if (/^sudo$/i.test(toks[i])) i++;
    const cmdName = toks[i];
    if (!cmdName || !SEARCH_CMD.test(cmdName)) continue;
    sawSearch = true;
    const isGrep = GREP_FAMILY.test(cmdName);
    i++;
    let patternTaken = !isGrep; // `find` takes paths first; grep takes a pattern first
    const found = [];
    for (; i < toks.length; i++) {
      const t = toks[i];
      if (t.startsWith('-')) {
        // An -e/-f style flag supplies the pattern, so the first bare token after
        // it is a path, not the pattern.
        if (/^(-e|--regexp|-f|--file)$/.test(t)) patternTaken = true;
        if (VALUE_FLAGS.has(t)) i++;
        continue;
      }
      if (!patternTaken) { patternTaken = true; continue; } // this token is the pattern
      if (isPathLike(t, cwd)) found.push(t);
    }
    if (found.length) paths.push(...found);
    // A stdin-fed grep with no path reads the pipe, not the cwd — never a vault
    // search, so it must not trip the cwd rule.
    else if (!piped) noPathSearch = true;
  }
  return { paths, sawSearch, noPathSearch };
}

// Returns null (allow) or { what, certain } describing why it is blocked.
function blockReasonForBash(cmd, vaultRoot, cwd) {
  if (!SEARCH_TOOL.test(cmd)) return null;

  // (a) The command text names the vault root outright. Raw-text containment —
  // see `text` above for why this must not go through path.resolve.
  if (text(cmd).includes(text(vaultRoot))) {
    return { what: 'a grep/find naming a vault path', certain: true };
  }

  const { paths, sawSearch, noPathSearch } = searchPathArgs(cmd, cwd);
  if (!sawSearch) return null; // only a `… | grep` stdout filter

  // (b) A path argument RESOLVES into the vault. Relative arguments are resolved
  // against the event cwd, so `../../Obsidian Vault/...` from a code repo is
  // caught, and `./src` or `.` from a code repo is not.
  for (const p of paths) {
    let resolved;
    try { resolved = path.resolve(cwd, p); } catch { continue; }
    if (isInsideVault(resolved, vaultRoot)) {
      return { what: `a grep/find whose path argument "${p}" resolves inside the vault`, certain: true };
    }
  }

  // (c) No path argument at all → the search follows the cwd. Block only when
  // that cwd is the vault; a code-repo cwd is left alone.
  if (noPathSearch && isInsideVault(cwd, vaultRoot)) {
    return { what: 'a grep/find with no path argument while the working directory is inside the vault', certain: false };
  }
  return null;
}

function denyMessage(what, terms, certain) {
  const t = terms ? terms.slice(0, 60) : 'your terms';
  // The old text asserted "Code-repo searches are unaffected", which was false
  // for exactly the cases that tripped this guard. Say what was actually
  // detected, and separate "this targets the vault" from "I cannot tell what
  // this targets, and the cwd is the vault" (cp-ccsh.8).
  const tail = certain
    ? 'A search whose path resolves outside the vault is not blocked.'
    : 'No path argument was given, so this cannot be told apart from a vault-wide ' +
      'search. Pass an explicit path outside the vault to run it, or use QMD.';
  return (
    `BLOCKED: ${what}. Vault content must be searched with QMD, not filesystem search ` +
    `(a no-path Glob/Grep follows the shell cwd and can silently search the wrong tree). Use:\n` +
    `  node "${QMD}" search "${t}"      # BM25 keyword\n` +
    `  node "${QMD}" vsearch "${t}"     # semantic\n` +
    `  node "${QMD}" query "${t}"       # deep research\n` +
    `${tail} Deliberate one-off override: BRAYNEE_ALLOW_VAULT_GREP=1.`
  );
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    if (ALLOW) process.exit(0);
    const data = JSON.parse(input || '{}');
    const tool = data.tool_name || '';
    const ti = data.tool_input || {};
    const cwd = data.cwd || process.cwd();

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

    // ── Bash grep/find/rg targeting the vault ────────────────────────────
    if (tool === 'Bash' && typeof ti.command === 'string' && ti.command) {
      const reason = blockReasonForBash(ti.command, vaultRoot, cwd);
      if (reason) {
        log.warn(HOOK, `blocked Bash search of vault: ${ti.command.slice(0, 80)}`);
        process.stderr.write(denyMessage(reason.what, null, reason.certain));
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
