#!/usr/bin/env node
// vault-search-guard.test.js — cp-ccsh.8 / B7.
//
// The guard must block filesystem searches OF THE VAULT and leave code-repo
// searches alone. It was doing the second part wrong: `norm(cmd)` ran
// path.resolve() over the whole command STRING, which prepends the hook
// PROCESS's cwd, so a hook running from inside the vault blocked every
// grep/find anywhere and blamed "a vault path".
//
// That bug is invisible to a pure-function test — it lives in the difference
// between the hook process's cwd and the event cwd. So these tests SPAWN the
// real hook with a controlled cwd and a fake vault via $BRAYNEE_VAULT, and
// assert on exit code (2 = block, 0 = allow) plus the message text.
//
// Pure Node, no deps, cross-platform. Exit 0 = pass, 1 = fail.

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOOK = path.join(__dirname, 'vault-search-guard.js');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond) {
  if (cond) pass++; else { fail++; fails.push(name); }
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'vsg-'));
try {
  // A fake vault (PARA markers make vault-root recognize it) + a sibling code repo.
  const VAULT = path.join(sandbox, 'Obsidian Vault');
  const REPO = path.join(sandbox, 'code', 'myrepo');
  fs.mkdirSync(path.join(VAULT, '1. Projects'), { recursive: true });
  fs.mkdirSync(path.join(VAULT, '2. Areas'), { recursive: true });
  fs.mkdirSync(path.join(REPO, 'src'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'notes.md'), '## a\n');

  // hookCwd is the hook PROCESS's cwd — deliberately varied independently of the
  // event cwd, because conflating the two was the bug.
  function run(payload, hookCwd) {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8',
      windowsHide: true,
      cwd: hookCwd || REPO,
      env: { ...process.env, BRAYNEE_VAULT: VAULT, BRAYNEE_ALLOW_VAULT_GREP: '' },
    });
    return { code: r.status, err: r.stderr || '' };
  }
  const bash = (command, cwd) => ({ tool_name: 'Bash', tool_input: { command }, cwd });

  // Relative path from the repo that escapes INTO the vault.
  const relIntoVault = path.relative(REPO, path.join(VAULT, '2. Areas')).split(path.sep).join('/');

  // ── code-repo searches are allowed, whatever the hook's own cwd is ──────────
  const codeRepoCmds = [
    'find . -maxdepth 2 -name "*rules*"',
    'grep -n "^## " ./notes.md',
    'grep -rn "foo" src/',
    'rg "bar"',
    'find ./src -type f -name "*.js"',
    'grep -rn --include="*.md" "todo" .',
  ];
  for (const c of codeRepoCmds) {
    ok(`allowed in a code repo (hook cwd = repo): ${c}`, run(bash(c, REPO), REPO).code === 0);
    // The regression that shipped: same command, hook process cwd inside the vault.
    ok(`allowed in a code repo even when the HOOK runs from the vault: ${c}`,
       run(bash(c, REPO), VAULT).code === 0);
  }

  // ── genuine vault targeting is still blocked ────────────────────────────────
  {
    const abs = run(bash(`grep -rn "x" "${VAULT}/2. Areas"`, REPO), REPO);
    ok('blocked: absolute vault path argument', abs.code === 2);
    ok('blocked-absolute message names a vault path', /naming a vault path/.test(abs.err));

    const rel = run(bash(`grep -rn "secret" "${relIntoVault}"`, REPO), REPO);
    ok('blocked: RELATIVE path argument resolving into the vault', rel.code === 2);
    ok('blocked-relative message says the argument resolves inside the vault',
       /resolves inside the vault/.test(rel.err));

    // `find .` DOES carry a path argument, so it takes the precise branch: `.`
    // resolves to the vault cwd.
    const dot = run(bash('find . -name "*.md"', VAULT), REPO);
    ok('blocked: `find .` while cwd is the vault', dot.code === 2);
    ok('blocked-dot message names the resolving argument',
       /resolves inside the vault/.test(dot.err));

    // `rg "concept"` has NO path argument — this is the genuinely uncertain case.
    const bare = run(bash('rg "concept"', VAULT), REPO);
    ok('blocked: no path argument at all while cwd is the vault', bare.code === 2);
    ok('blocked-bare message says no path argument was given',
       /no path argument/.test(bare.err));
  }

  // ── message text matches actual behavior in both cases (acceptance) ─────────
  {
    const certain = run(bash(`grep -rn "x" "${VAULT}/2. Areas"`, REPO), REPO).err;
    const uncertain = run(bash('rg "concept"', VAULT), REPO).err;
    ok('no message claims code-repo searches are unaffected',
       !/Code-repo searches are unaffected/.test(certain) &&
       !/Code-repo searches are unaffected/.test(uncertain));
    ok('a certain block states that a path outside the vault is not blocked',
       /not blocked/.test(certain));
    ok('an uncertain block admits it cannot tell the searches apart',
       /cannot be told apart/.test(uncertain));
    ok('both messages still offer the QMD commands',
       /qmd-wrapper\.mjs" search/.test(certain) && /qmd-wrapper\.mjs" search/.test(uncertain));
  }

  // ── stdout filters are never a vault search ────────────────────────────────
  ok('allowed: `… | grep` stdout filter while cwd is the vault',
     run(bash('node script.js | grep -v warning', VAULT), REPO).code === 0);
  ok('allowed: non-search command mentioning the word find',
     run(bash('npm run findme', VAULT), REPO).code === 0);

  // ── a path OUTSIDE the vault stays allowed even from a vault cwd ───────────
  ok('allowed: explicit code-repo path argument while cwd is the vault',
     run(bash(`grep -rn "x" "${REPO}/src"`, VAULT), REPO).code === 0);

  // ── the override still works ───────────────────────────────────────────────
  {
    const r = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(bash('find . -name "*.md"', VAULT)),
      encoding: 'utf8', windowsHide: true, cwd: REPO,
      env: { ...process.env, BRAYNEE_VAULT: VAULT, BRAYNEE_ALLOW_VAULT_GREP: '1' },
    });
    ok('BRAYNEE_ALLOW_VAULT_GREP=1 allows a vault search', r.status === 0);
  }

  // ── Glob/Grep TOOL branch ─────────────────────────────────────────────────
  const tool = (name, input, cwd) => ({ tool_name: name, tool_input: input, cwd });
  ok('allowed: Grep tool with no path, cwd = code repo',
     run(tool('Grep', { pattern: 'x' }, REPO), REPO).code === 0);
  ok('blocked: Grep tool with no path, cwd = vault',
     run(tool('Grep', { pattern: 'x' }, VAULT), REPO).code === 2);
  ok('blocked: Grep tool with a relative path resolving into the vault',
     run(tool('Grep', { pattern: 'x', path: relIntoVault }, REPO), REPO).code === 2);
  ok('allowed: Glob tool pointed at a code path while cwd = vault',
     run(tool('Glob', { pattern: '**/*.js', path: path.join(REPO, 'src') }, VAULT), REPO).code === 0);

  // ── PowerShell tool + PowerShell-native verbs (cp-1fdn / cp-4q4h) ──────────
  //
  // PowerShell is the default shell on Windows. The guard was gated on the Bash
  // tool AND on POSIX command names, so both the tool and its native cmdlets
  // walked straight past it.
  {
    const ps = (command, cwd) => ({ tool_name: 'PowerShell', tool_input: { command }, cwd });

    // The POSIX tools are on PATH under PowerShell and read the same files.
    ok('blocked: grep naming a vault path, from the PowerShell tool',
       run(ps(`grep -rn "x" "${VAULT}/2. Areas"`, REPO), REPO).code === 2);
    ok('allowed: a code-repo grep from the PowerShell tool',
       run(ps('grep -rn "foo" src/', REPO), REPO).code === 0);

    // Native cmdlets, named arguments.
    const blocked = [
      `Select-String -Path "${VAULT}/2. Areas/*.md" -Pattern "todo"`,
      `Select-String -Pattern "todo" -Path "${VAULT}/notes.md"`,
      `sls -Path "${VAULT}/notes.md" -Pattern "x"`,
      `Get-ChildItem -Path "${VAULT}" -Recurse -Filter "*.md"`,
      `gci "${VAULT}" -Recurse`,
    ];
    for (const c of blocked) {
      ok(`blocked: PowerShell-native vault search — ${c.slice(0, 52)}`,
         run(ps(c, REPO), REPO).code === 2);
    }

    // False positives are what erode a guard, so pin them down explicitly.
    const allowed = [
      'Select-String -Path "./src/*.ts" -Pattern "TODO"',   // code repo
      'gci -Recurse -Filter "*.ts"',                        // no path → follows a code cwd
      `Get-ChildItem "${VAULT}"`,                           // a listing, not a search
      `gci "${VAULT}" | Measure-Object`,                    // still just a listing
    ];
    for (const c of allowed) {
      ok(`allowed: not a vault content search — ${c.slice(0, 52)}`,
         run(ps(c, REPO), REPO).code === 0);
    }

    // -Path must not be swallowed as a value flag the way find's `-path` is.
    ok('blocked: -LiteralPath into the vault',
       run(ps(`Select-String -LiteralPath "${VAULT}/notes.md" -Pattern "x"`, REPO), REPO).code === 2);

    // A no-path search while the cwd IS the vault still trips the cwd rule.
    ok('blocked: recursive gci with no path while cwd is the vault',
       run(ps('gci -Recurse -Filter "*.md"', VAULT), REPO).code === 2);
  }


  // ── cp-mx34: a path TOKEN is not a path yet ────────────────────────────────
  //
  // The shell has not expanded the command when a PreToolUse hook runs, so
  // path.resolve(cwd, '$HOME/.claude') from a vault cwd produced
  // '<vault>/$HOME/.claude' and blocked a search of the REAL home directory —
  // from a vault cwd, every path written with a shell variable or `~` read as a
  // vault path. In the other direction "$HOME/Obsidian Vault" walked straight
  // past rule (a), whose raw-text check never sees the expanded form. So both
  // directions are pinned here.
  {
    // A home under the sandbox keeps these independent of wherever the machine
    // running the tests actually keeps its home directory.
    const FAKEHOME = path.join(sandbox, 'home');
    fs.mkdirSync(path.join(FAKEHOME, 'code'), { recursive: true });

    // os.homedir() reads USERPROFILE on Windows and HOME elsewhere; set both so
    // the `~` case behaves identically on every CI platform.
    const withHome = (payload) => spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      encoding: 'utf8', windowsHide: true, cwd: REPO,
      env: {
        ...process.env,
        BRAYNEE_VAULT: VAULT, BRAYNEE_ALLOW_VAULT_GREP: '',
        HOME: FAKEHOME, USERPROFILE: FAKEHOME,
      },
    }).status;

    // Every variable form, pointed OUTSIDE the vault, from a vault cwd.
    const outside = [
      bash('find "$HOME/.claude" -iname "CHANGELOG*"', VAULT),
      bash('grep -rn "x" "${HOME}/code"', VAULT),
      bash('grep -rn "x" "%USERPROFILE%/code"', VAULT),
      bash('grep -rn "x" ~/code', VAULT),
      { tool_name: 'PowerShell', tool_input: { command: 'gci -Path "$env:USERPROFILE/code" -Recurse' }, cwd: VAULT },
    ];
    for (const p of outside) {
      ok(`allowed: variable path outside the vault, vault cwd — ${p.tool_input.command.slice(0, 44)}`,
         withHome(p) === 0);
    }

    // Expanding must not become a bypass: the same syntax pointed INTO the vault.
    ok('blocked: a variable that expands into the vault',
       withHome(bash('grep -rn "x" "$HOME/../Obsidian Vault/2. Areas"', REPO)) === 2);

    // An unset variable is unresolvable, so the token is ignored rather than
    // resolved literally. Rule (c) then decides on the cwd alone.
    ok('unset variable is not read as a vault path, but a vault cwd still blocks',
       withHome(bash('grep -rn "x" "$VSG_UNSET/foo"', VAULT)) === 2);
    ok('unset variable from a code-repo cwd is allowed',
       withHome(bash('grep -rn "x" "$VSG_UNSET/foo"', REPO)) === 0);
  }

  // ── cp-6t9f: a redirection is shell syntax, not a path argument ────────────
  //
  // `2>/dev/null` contains a slash, so isPathLike() took it for a path and
  // resolving it against a vault cwd landed "inside the vault" — blocking a
  // command whose actual search target was elsewhere. Masked until cp-mx34
  // shipped, because the $HOME token in the same command was blocked first.
  //
  // The search target is written absolutely here on purpose: a RELATIVE target
  // from a vault cwd is a genuine vault search and must stay blocked, so it
  // would not isolate the redirection.
  {
    const redirOutside = [
      `find "${REPO}" -name "*.json" 2>/dev/null`,
      `grep -rn "x" "${REPO}/src" 2>/dev/null`,
      `grep -rn "x" "${REPO}/src" >out.txt 2>&1`,
      `grep -rn "x" "${REPO}/src" > out.txt`,
      `rg "x" "${REPO}/src" 2> /dev/null`,
    ];
    for (const c of redirOutside) {
      ok(`allowed: redirection is not a path argument — ${c.slice(-34)}`,
         run(bash(c, VAULT), REPO).code === 0);
    }
    // The same shapes with an ordinary relative target, from a code-repo cwd.
    ok('allowed: relative search in a code repo with a redirection',
       run(bash('grep -rn "x" src/ 2>/dev/null', REPO), REPO).code === 0);

    // A redirection must not become a way to smuggle a vault search past the guard.
    ok('blocked: a vault path argument alongside a redirection',
       run(bash(`grep -rn "x" "${VAULT}/2. Areas" 2>/dev/null`, REPO), REPO).code === 2);
    ok('blocked: relative target from a vault cwd, redirection present',
       run(bash('grep -rn "x" src/ 2>/dev/null', VAULT), REPO).code === 2);
    ok('blocked: no path argument at all, vault cwd, redirection present',
       run(bash('rg "concept" 2>/dev/null', VAULT), REPO).code === 2);
  }
  // ── never throws: malformed input fails open ───────────────────────────────
  {
    const r = spawnSync(process.execPath, [HOOK], {
      input: 'not json at all', encoding: 'utf8', windowsHide: true, cwd: REPO,
      env: { ...process.env, BRAYNEE_VAULT: VAULT },
    });
    ok('malformed stdin fails open (exit 0)', r.status === 0);
  }
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

if (fail === 0) {
  console.log(`vault-search-guard.test.js: ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`vault-search-guard.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
