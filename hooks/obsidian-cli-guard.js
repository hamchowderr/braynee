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
// SIX rules, in order of how much damage they prevent:
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
//   (4) `move` and `rename` AT ALL. Measured 2026-09-07 on 1.13.7: they never
//       return (exit 124), isolated across plain vs parenthesised names, disk vs
//       API-created files, fresh vs long-indexed destinations, and before vs after
//       a full restart. Not the IPC wedge — delete/create/eval keep working, and
//       `delete` succeeds on a parenthesised name. Worth blocking because the
//       obvious workaround is also broken: `app.fileManager.renameFile()` returns
//       `started`, exits 0, and silently no-ops. Route is read + create + trash.
//       (An earlier revision of this rule blamed PARENTHESES from a single
//       observation and was wrong. Encode the observation, not the theory.)
//   (5) `property:set` / `property:read` carrying `path=` or `file=`. Both are
//       ACCEPTED AND IGNORED — the command acts on the currently ACTIVE file and
//       exits 0 either way, so "written" and "silently skipped" are the same
//       observable. Specific to property:*; delete and move honor their paths.
//   (6) Bare `obsidian` from Bash. Git Bash ignores PATHEXT and resolves it to
//       the 225 MB GUI .exe, which has no console — the command runs and every
//       line of output is lost. Bash-only; PowerShell resolves the .com fine.
//       Listed last but checked FIRST, because losing stdout makes every other
//       failure here undiagnosable.
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
// Split on shell operators OUTSIDE quotes. A naive .split(/\|{1,2}|&&|;/) breaks
// a quoted argument that merely CONTAINS one — e.g.
//   grep -rn "obsidian \|(move\|rename)" .
// splits at the escaped pipes and leaves a fragment starting with `obsidian`,
// which then blocks an ordinary grep. Found 2026-09-07 by tripping it.
function splitSegments(cmd) {
  const out = [];
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
    if (c === ';') { out.push(cur); cur = ''; continue; }
    if (c === '|') { out.push(cur); cur = ''; if (s[i + 1] === '|') i++; continue; }
    if (c === '&' && s[i + 1] === '&') { out.push(cur); cur = ''; i++; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

function obsidianSegments(cmd) {
  const found = [];
  for (const segment of splitSegments(cmd)) {
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

// Bare `obsidian` — no path, no extension. Git Bash (MSYS2) ignores PATHEXT: it
// tries the exact name then appends `.exe`, and NEVER tries `.com`. So this runs
// the 225 MB GUI Electron binary, which has no console attached, and every line
// of output is lost. Measured 2026-08-05 on 1.13.4, identical 3-create/3-delete
// burst: PowerShell bare 6/6 printed, Git Bash `Obsidian.com` 6/6, Git Bash bare
// 0/6 — while all six operations still ran. Losing the output is what makes a
// silent failure indistinguishable from success. PowerShell resolves `.com`
// correctly on its own, so this is a Bash-only defect.
function isBareObsidian(tok) {
  const t = String(tok);
  if (/[\\/]/.test(t)) return false;            // has a path — explicit enough
  return /^obsidian$/i.test(t);                  // no extension at all
}

// Returns null (allow) or { rule, detail } describing why it is blocked.
function blockReason(cmd, tool) {
  for (const { text, toks } of obsidianSegments(cmd)) {
    // (6) Windows + Bash only: bare `obsidian` loses ALL stdout. Checked first —
    // it makes every other failure here undiagnosable. Gated on win32 because the
    // two-binary split IS the Windows packaging: on macOS/Linux there is no
    // `.com` shim and bare `obsidian` is the correct invocation.
    if (process.platform === 'win32' && tool === 'Bash' && isBareObsidian(toks[0])) {
      return {
        rule: 'bare-obsidian-in-bash',
        detail: 'this calls bare `obsidian` from Bash, which resolves to the GUI .exe and loses all output',
      };
    }

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

    // (4) `move` and `rename` HANG. Measured 2026-09-07 on 1.13.7 (installer
    // 1.13.4): every invocation returns exit 124 at the timeout, never completing.
    // Isolated across plain vs parenthesised names, files written to disk vs
    // created through the Obsidian API, destinations freshly made vs long-indexed,
    // and before vs after a full `Obsidian.com restart`. All hang. `delete`,
    // `create`, `eval`, `tags` and `backlinks` keep working throughout — and
    // `delete` succeeds on a parenthesised filename, which is what rules
    // parentheses out as the cause.
    //
    // UNEXPLAINED: `move` succeeded three times earlier in the same session on
    // this exact version, binaries unchanged. Recorded rather than theorised —
    // an earlier revision of this rule blamed parentheses on the strength of one
    // observation and was wrong. The rule encodes the OBSERVATION (they hang),
    // not a cause.
    //
    // Blocked rather than warned because the failure costs a full timeout every
    // time and the working route is a straight substitution. The override ticket
    // is the escape hatch if a later Obsidian build fixes it.
    const sub = toks[1] ? String(toks[1]).toLowerCase() : '';
    if (sub === 'move' || sub === 'rename') {
      return {
        rule: 'move-rename-hangs',
        detail: `\`${sub}\` hangs on this Obsidian build (exit 124, never returns)`,
      };
    }

    // (5) `property:set` / `property:read` with `path=` or `file=`. Measured
    // 2026-07-25: the property:* commands ACCEPT and IGNORE both, acting on the
    // currently ACTIVE file instead, and exit 0 either way — so a script cannot
    // tell "written" from "silently skipped". Specific to property:*; `delete
    // path=` and `move path=` do honor their path.
    if (/^property:(set|read)$/i.test(sub)) {
      const target = argValue(toks, 'path') !== null ? 'path' : (argValue(toks, 'file') !== null ? 'file' : null);
      if (target) {
        return {
          rule: 'property-path-ignored',
          detail: `this \`${sub}\` passes \`${target}=\`, which the CLI accepts and ignores`,
        };
      }
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
  if (rule === 'bare-obsidian-in-bash') {
    return (
      `BLOCKED: ${detail}.\n\n` +
      'Obsidian ships TWO binaries: `Obsidian.com` (22 KB, console subsystem — the CLI relay)\n' +
      'and `Obsidian.exe` (225 MB, GUI subsystem — the Electron app). Windows resolves a bare\n' +
      'command through PATHEXT, which lists .COM first — but Git Bash (MSYS2) IGNORES PATHEXT:\n' +
      'it tries the exact name, then appends `.exe`, and never tries `.com`.\n\n' +
      'So bare `obsidian` in Bash runs the GUI binary, which has no console attached —\n' +
      'confirmed by `file`: PE32+ executable, GUI subsystem. The command still RUNS; the\n' +
      'output is what is at risk.\n\n' +
      'How often: re-measured 2026-09-07 on 1.13.7, bare lost output 1 run in 15 while\n' +
      '`Obsidian.com` lost 0 in 15. An earlier measurement (2026-08-05, same version) saw\n' +
      'bare lose 6 of 6. So the rate VARIES and cannot be relied on — which is the point:\n' +
      'the loss is silent and intermittent, so a passing test proves nothing.\n\n' +
      'That matters because several CLI failure modes are visible ONLY in stdout. Losing a\n' +
      'line makes a silent failure indistinguishable from success.\n\n' +
      'Call it by full path:\n' +
      '  "C:/Users/HamCh/AppData/Local/Programs/Obsidian/Obsidian.com" <command> ...\n\n' +
      'Or use the PowerShell tool, where bare `obsidian` resolves to the .com correctly.'
    );
  }

  if (rule === 'property-path-ignored') {
    return (
      `BLOCKED: ${detail}.\n\n` +
      '`property:set` and `property:read` ACCEPT `path=` / `file=` and then IGNORE them — they\n' +
      'act on the currently ACTIVE file instead, and exit 0 either way. A script cannot tell\n' +
      '"written" from "silently skipped". Confirmed 2026-07-25: three attempts across both\n' +
      'argument forms all reported success and changed nothing on disk.\n\n' +
      'This defect is specific to `property:*` — `delete path=` and `move path=` DO honor theirs.\n\n' +
      'Edit a specific note\'s frontmatter through the API instead. Note there is no `await`:\n' +
      'an await in an eval body hangs the CLI (rule 3), so start the work and return a plain\n' +
      'string synchronously:\n\n' +
      'Obsidian.com eval code="(function(){\n' +
      '  var f = app.vault.getAbstractFileByPath(\'Folder/Note.md\');\n' +
      '  app.fileManager.processFrontMatter(f, function(fm){ fm.status = \'done\'; });\n' +
      '  return \'started\'; })()"\n\n' +
      'Then VERIFY on disk — read the file back and assert the new value. Failure here is\n' +
      'indistinguishable from success by exit code alone.\n\n' +
      'To READ frontmatter, prefer the metadata cache:\n' +
      '  app.metadataCache.getFileCache(f).frontmatter'
    );
  }

  // move/rename have their own failure and their own fix, so they get a dedicated
  // message rather than the staged-file advice, which does not apply.
  if (rule === 'move-rename-hangs') {
    return (
      `BLOCKED: ${detail}.\n\n` +
      '`move` and `rename` never return on this Obsidian build (1.13.7 / installer 1.13.4).\n' +
      'Measured 2026-09-07 and isolated across every variable: plain vs parenthesised names,\n' +
      'files written to disk vs created through the Obsidian API, destinations freshly made\n' +
      'vs long-indexed, and before vs after a full `Obsidian.com restart`. All hang at the\n' +
      'timeout with exit 124.\n\n' +
      'It is NOT the IPC wedge and NOT about parentheses — `delete`, `create`, `eval`, `tags`\n' +
      'and `backlinks` all keep working, and `delete` succeeds on a parenthesised filename.\n' +
      '(Unexplained: `move` did work earlier in one session on this same version. If a later\n' +
      'build fixes it, take the override ticket below and confirm before trusting it.)\n\n' +
      '`app.fileManager.renameFile()` via eval is NOT a workaround — it returns `started`,\n' +
      'exits 0, and silently no-ops. Verified: polled disk 3x over ~9s and re-queried\n' +
      'app.vault.getMarkdownFiles(); Obsidian still reported the OLD path.\n\n' +
      'Use read + create + verify + trash instead:\n\n' +
      'cp "$VAULT/Inbox/Note (2026-08-06).md" "$VAULT/_tmp.md"\n' +
      'Obsidian.com eval code="(function(){ var t=\'Dest/Note (2026-08-06).md\';\n' +
      '  app.vault.adapter.read(\'_tmp.md\').then(function(c){ app.vault.create(t, c); });\n' +
      '  return \'started\'; })()"\n' +
      '# VERIFY the copy is byte-identical, THEN trash the original:\n' +
      'Obsidian.com eval code="(function(){ var f=app.vault.getMarkdownFiles()\n' +
      '  .filter(function(x){return x.path.indexOf(\'Inbox/Note\')===0;})[0];\n' +
      '  app.vault.trash(f, true); return \'started\'; })()"\n\n' +
      'Also: `move to=` needs the FULL destination path including the filename. Passing only\n' +
      'a folder returns "Error: Destination file already exists!" even when nothing is there.\n\n' +
      'If you must run this as written, take a 5-minute override — an env var set inside the\n' +
      'command CANNOT work, because this hook has already run:\n' +
      '  node -e "require(\'fs\').writeFileSync(process.env.USERPROFILE + \'/.claude/braynee-allow-obsidian-cli\',\'\')"'
    );
  }

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

    const reason = blockReason(ti.command, tool);
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
