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
//   • Bash — DENY a grep/egrep/fgrep/rg/ripgrep/find command that either (a) references the
//     vault root path explicitly, or (b) is the LEADING command (not a `… | grep` stdin
//     filter) with NO absolute path argument while the cwd is inside the vault. A pure
//     stdout filter like `qmd … | grep -v x` is never touched (it isn't searching the vault).
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
// First pipeline segment starts with a filesystem-search command (not a `… | grep` filter).
function isLeadingSearch(cmd) {
  const first = String(cmd).split('|')[0].trim();
  return /^(sudo\s+)?(grep|egrep|fgrep|rg|ripgrep|find)\b/i.test(first);
}
// Any drive-letter absolute path (Windows-primary). If present, let the explicit
// vault-path check decide and don't fire the cwd-based rule (avoids blocking a grep
// that targets a code path while the shell happens to sit in the vault).
const HAS_ABS_PATH = /[a-zA-Z]:[\\/]/;

function blockReasonForBash(cmd, vaultRoot, cwd) {
  if (!SEARCH_TOOL.test(cmd)) return null;
  // (a) explicit vault path in the command
  if (norm(cmd).includes(norm(vaultRoot))) return 'a grep/find targeting a vault path';
  // (b) leading filesystem search, no absolute path arg, cwd inside the vault
  if (isLeadingSearch(cmd) && !HAS_ABS_PATH.test(cmd) && isInsideVault(cwd, vaultRoot)) {
    return 'a grep/find of the vault working directory';
  }
  return null;
}

function denyMessage(what, terms) {
  const t = terms ? terms.slice(0, 60) : 'your terms';
  return (
    `BLOCKED: ${what}. Vault content must be searched with QMD, not filesystem search ` +
    `(a no-path Glob/Grep follows the shell cwd and can silently search the wrong tree). Use:\n` +
    `  node "${QMD}" search "${t}"      # BM25 keyword\n` +
    `  node "${QMD}" vsearch "${t}"     # semantic\n` +
    `  node "${QMD}" query "${t}"       # deep research\n` +
    `Code-repo searches are unaffected. Deliberate one-off override: BRAYNEE_ALLOW_VAULT_GREP=1.`
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
        process.stderr.write(denyMessage(`${tool} against the vault`, ti.pattern));
        process.exit(2);
      }
      process.exit(0);
    }

    // ── Bash grep/find/rg targeting the vault ────────────────────────────
    if (tool === 'Bash' && typeof ti.command === 'string' && ti.command) {
      const reason = blockReasonForBash(ti.command, vaultRoot, cwd);
      if (reason) {
        log.warn(HOOK, `blocked Bash search of vault: ${ti.command.slice(0, 80)}`);
        process.stderr.write(denyMessage(reason));
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
