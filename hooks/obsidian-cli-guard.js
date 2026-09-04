// obsidian-cli-guard.js
// Hook: PreToolUse (Bash + PowerShell) — stop the three Obsidian CLI shapes that
// fail SILENTLY and then wedge the CLI for the rest of the session.
//
// Why this exists: the obsidian-cli SKILL only loads when the user's phrasing
// matches its description ("interact with my vault", "manage notes"). Writing a
// note as a STEP inside some other task never matches, so the skill never fires
// and nothing carries its constraints. The path-scoped rule in ~/.claude/rules/
// covers a session that touches vault .md files, but the CLI is reached through
// Bash, not through a vault file path — so neither mechanism sees the command
// that actually breaks. This guard sits where the command is.
//
// The failure being prevented (measured 2026-09-03, Obsidian 1.13.7, Windows 11):
// the CLI's IPC layer calls JSON.parse on socket data WITHOUT reassembling
// messages, so a payload split across pipe frames parses as a truncated fragment
// and throws. Past a 4000-byte total command line the CLI returns exit 0, prints
// NOTHING, writes ZERO bytes, and then kills its own IPC socket — every later
// call hangs or reports "unable to find Obsidian". Upstream bug, open and unfixed
// as of 1.14.0: https://forum.obsidian.md/t/117325
//
// Neither exit code nor stdout can detect it — exit 0 with empty output is
// indistinguishable from success. That is what makes it worth a PreToolUse gate
// rather than a post-hoc check.
//
// THREE rules, in order of how much damage they prevent:
//
//   (1) COMMAND SUBSTITUTION inside content=. `content="$(cat note.md)"` is SHORT
//       as typed and only explodes after the shell expands it — which happens
//       AFTER this hook runs. A pure length check cannot see it, so a length
//       check alone would miss the exact shape that motivated this hook. The
//       expanded size is unknowable here, so the shape itself is refused.
//   (2) LITERAL LENGTH over the threshold. The plain case: a big note pasted
//       straight into content=.
//   (3) `await` inside eval code=. `(async () => { ... await ... })()` hangs the
//       CLI outright — it waits on the returned promise and never resolves.
//
// Deliberately NOT enforced: the "at most one .then" rule. A nested .then fails
// silently too, but detecting nesting needs a JS parser, and a regex that guesses
// at it would fire on ordinary chained code. Documented in the skill instead.
//
// Scope is narrow on purpose — only commands that invoke the Obsidian CLI IN
// COMMAND POSITION are examined, so prose mentioning "obsidian", a `grep obsidian`
// or an npm package named obsidian-something all pass untouched.
//
// Exit 2 = block (stderr reaches the model), exit 0 = allow. Crash = fail-open.
// One-off override: a ticket file, time-limited like the vault-search guard's.
// An env var cannot work — this hook has already run before any shell applies it.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const payload = require(path.join(__dirname, 'lib', 'hook-payload.js'));

const HOOK = 'obsidian-cli-guard';

// 4000 is the measured cliff (4000 writes, 4001 does not) and it covers the
// WHOLE command line — verified: content that wrote fine at a short path failed
// when only the path grew by 62 bytes. 3500 leaves headroom for the parts of the
// command that are not the content, and for a shell that rewrites arguments
// slightly before exec.
const HARD_LIMIT = 4000;
const SAFE_LIMIT = 3500;

const TICKET = path.join(os.homedir(), '.claude', 'braynee-allow-obsidian-cli');
const TICKET_TTL_MS = 5 * 60 * 1000;

function ticketValid() {
  try {
    const age = Date.now() - fs.statSync(TICKET).mtimeMs;
    return age >= 0 && age < TICKET_TTL_MS;
  } catch {
    return false;   // absent is the normal case: guard stays on
  }
}

// Directory and Windows executable extension stripped: what a shell would exec.
// `Obsidian.com`, `C:/.../Obsidian.com` and a bare `obsidian` all reduce to the
// same token. `.com` matters here — it IS the console relay, and stripping it is
// what lets one pattern cover both invocations.
function baseCmd(tok) {
  const base = String(tok).split(/[\\/]/).pop();
  return base.replace(/\.(exe|com|cmd|bat|ps1)$/i, '');
}

const OBSIDIAN_CMD = /^obsidian$/i;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPER = /^(sudo|env|command|time|nice|nohup|stdbuf|timeout)$/i;

// Same shell-ish tokenizer as vault-search-guard: splits on whitespace while
// honoring quotes, so a quoted path with spaces survives as ONE token.
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

// Command substitution that the shell expands AFTER this hook has run, so its
// real size is unknowable here. `timeout 25` is a wrapper, not a substitution.
const SUBSTITUTION = /\$\(|`|\$\{[A-Za-z_]/;

// Each pipeline segment that invokes the Obsidian CLI, with its raw text.
// `||`, `&&`, `;` and `|` all start a new command, so a `cat x | obsidian ...`
// segment is examined on its own rather than as part of the producer.
function obsidianSegments(cmd) {
  const found = [];
  for (const segment of String(cmd).split(/\|{1,2}|&&|;/)) {
    const toks = tokenize(segment.trim());
    if (!toks.length) continue;
    let i = 0;
    while (i < toks.length && (ASSIGNMENT.test(toks[i]) || WRAPPER.test(baseCmd(toks[i])))) {
      // A wrapper's own flags/values are skipped so `timeout 25 Obsidian.com ...`
      // reaches the CLI token. Only leading numeric/flag tokens are consumed —
      // anything else is treated as the command itself.
      i++;
      while (i < toks.length && /^(-|\d)/.test(toks[i])) i++;
    }
    if (i < toks.length && OBSIDIAN_CMD.test(baseCmd(toks[i]))) {
      found.push({ text: segment, toks: toks.slice(i) });
    }
  }
  return found;
}

// The value of a `key=` argument, given the already-tokenized segment. Quotes are
// gone by now, so `content="a b"` is one token: `content=a b`.
function argValue(toks, key) {
  const pre = key.toLowerCase() + '=';
  for (const t of toks) {
    if (String(t).toLowerCase().startsWith(pre)) return String(t).slice(pre.length);
  }
  return null;
}

// Returns null (allow) or { rule, detail } describing why it is blocked.
function blockReason(cmd) {
  for (const { text, toks } of obsidianSegments(cmd)) {
    const content = argValue(toks, 'content');
    const code = argValue(toks, 'code');

    // (3) An `await` in an eval body hangs the CLI outright. Checked before size
    // because it fails at ANY length — a 200-byte async IIFE hangs just as hard.
    if (code !== null && /\bawait\b/.test(code)) {
      return {
        rule: 'await-in-eval',
        detail: 'this `eval code=` contains `await`',
      };
    }

    // (1) Command substitution inside content= — the shape that cannot be sized.
    if (content !== null && SUBSTITUTION.test(content)) {
      return {
        rule: 'substitution-in-content',
        detail: 'this `content=` is built by shell substitution ($(...), backticks or ${VAR})',
      };
    }

    // (2) Literal length. Measured against the whole segment, because the limit
    // covers the entire command line, not content= alone.
    const len = Buffer.byteLength(text, 'utf8');
    if (len > SAFE_LIMIT) {
      return {
        rule: 'too-long',
        detail: `this command is ${len} bytes (safe limit ${SAFE_LIMIT}, hard cliff ${HARD_LIMIT})`,
      };
    }
  }
  return null;
}

function denyMessage(rule, detail) {
  const why = rule === 'await-in-eval'
    ? 'An `await` in an eval body HANGS the CLI — it waits on the returned promise and never resolves.\n' +
      'Start the async work and return a plain string synchronously instead.'
    : 'Past a 4000-byte total command line the CLI returns exit 0, prints NOTHING, writes ZERO\n' +
      'bytes, and then kills its own IPC socket — every later call hangs or reports "unable to\n' +
      'find Obsidian". Neither the exit code nor stdout can tell you it failed.\n' +
      'Upstream bug, open and unfixed as of 1.14.0: https://forum.obsidian.md/t/117325';

  const fix = rule === 'await-in-eval'
    ? 'Obsidian.com eval code="(function(){ var t=\'Folder/Note.md\';\n' +
      '  app.vault.adapter.read(\'_tmp.md\').then(function(c){ app.vault.modify(app.vault.getFileByPath(t), c); });\n' +
      '  return \'started\'; })()"'
    : '# 1. Write the content with the Write tool, then stage it INSIDE the vault\n' +
      'cp "<scratch>/note.md" "$VAULT/_tmp.md"\n' +
      '# 2. Read it by VAULT-RELATIVE path — the eval argument stays ~200 chars at ANY note size\n' +
      'Obsidian.com eval code="(function(){ var t=\'Folder/Note.md\';\n' +
      '  app.vault.adapter.read(\'_tmp.md\').then(function(c){ app.vault.create(t, c); });\n' +
      '  return \'started\'; })()"\n' +
      '# 3. rm the staging file, then VERIFY BY CONTENT — not by exit code, not by byte count';

  return (
    `BLOCKED: ${detail}.\n\n` +
    `${why}\n\n` +
    `Use the staged-file + eval pattern instead:\n\n${fix}\n\n` +
    `Rules for every eval body: no \`await\`; at most one \`.then\` (a nested one silently\n` +
    `no-ops — use app.vault.append, which does read-modify-write internally); keep the\n` +
    `argument ASCII. Full detail: the braynee obsidian-cli skill.\n\n` +
    `If this is genuinely a small, literal command that must run as written, take a\n` +
    `5-minute override — setting an env var inside the command CANNOT work, because\n` +
    `this hook has already run:\n` +
    `  node -e "require('fs').writeFileSync(process.env.USERPROFILE + '/.claude/braynee-allow-obsidian-cli','')"`
  );
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    if (process.env.BRAYNEE_ALLOW_OBSIDIAN_CLI === '1' || ticketValid()) process.exit(0);

    const p = payload.parse(input);
    const tool = p.tool;
    const ti = p.toolInput;

    if (tool !== 'Bash' && tool !== 'PowerShell') process.exit(0);
    if (typeof ti.command !== 'string' || !ti.command) process.exit(0);

    const reason = blockReason(ti.command);
    if (reason) {
      log.warn(HOOK, `blocked ${reason.rule}: ${ti.command.slice(0, 80)}`);
      process.stderr.write(denyMessage(reason.rule, reason.detail));
      process.exit(2);
    }
    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});

module.exports = { blockReason, obsidianSegments, SAFE_LIMIT, HARD_LIMIT };
