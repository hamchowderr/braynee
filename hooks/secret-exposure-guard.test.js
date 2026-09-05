#!/usr/bin/env node
// secret-exposure-guard.test.js — cp-ojk2.
//
// The guard must refuse commands that PRINT secret values and stay out of the
// way of everything else. It was doing the second part wrong: the rules were
// regexes over the whole command string, so any command whose ARGUMENTS
// contained the words matched. `qmd search "infisical secrets rule"` was
// refused, and so was the `bd create` filing that bug, because the report
// quotes the phrase.
//
// Matching is structural now — the tool has to be in command position — so the
// tests come in pairs: the same words as an argument to another program (allow)
// and as the command itself (block).
//
// Pure Node, no deps. Exit 0 = pass, 1 = fail.

'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const HOOK = path.join(__dirname, 'secret-exposure-guard.js');

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond) {
  if (cond) pass++; else { fail++; fails.push(name); }
}

function run(payload, env) {
  const r = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, BRAYNEE_ALLOW_SECRET_READS: '', ...(env || {}) },
  });
  return r.status;
}
const bash = (command) => run({ tool_name: 'Bash', tool_input: { command } });
const write = (file_path, content) => run({ tool_name: 'Write', tool_input: { file_path, content } });

// ── the reported false positives: the phrase is DATA, not a command ──────────
ok('allowed: the phrase inside a qmd search string',
   bash('qmd search "infisical secrets rule"') === 0);
ok('allowed: the phrase inside a bug report being filed',
   bash('bd create "guard bug" -d "blocked a qmd search whose text said infisical secrets"') === 0);
ok('allowed: the phrase in an echo',
   bash('echo "run infisical secrets to list them"') === 0);
ok('allowed: another tool named in a --note argument',
   bash('node ship.mjs --note "vault read and op item get are blocked"') === 0);
ok('allowed: a grep FOR the phrase in source',
   bash('grep -rn "doppler secrets" ./docs') === 0);

// ── a heredoc body is data: writing ABOUT the guard must not trip it ─────────
ok('allowed: a commit message quoting the guarded commands',
   bash("git commit -F - <<'EOF'\nfix(hooks): parse argv\n\ninfisical run -- vault read x still blocks.\nEOF") === 0);
ok('allowed: a heredoc writing a doc that names them',
   bash("cat > notes.md <<'EOF'\nBlocked: infisical secrets, vault kv get, op read.\nEOF") === 0);
ok('blocked: a real command beside a heredoc is still read',
   bash("infisical secrets; cat > notes.md <<'EOF'\nharmless text\nEOF") === 2);
// Same known limitation vault-search-guard pins: a newline is not a segment
// separator, so a command on the next line is invisible. Dropping heredoc
// bodies makes it look adjacent, which is exactly why it is pinned here.
ok('known limitation (allowed): a command on the next line after a heredoc',
   bash("cat > notes.md <<'EOF'\nharmless text\nEOF\ninfisical secrets") === 0);

// ── the true positives still block ───────────────────────────────────────────
ok('blocked: infisical secrets (bare list)', bash('infisical secrets') === 2);
ok('blocked: infisical secrets get', bash('infisical secrets get API_KEY') === 2);
ok('blocked: infisical export', bash('infisical export --format=dotenv') === 2);
ok('blocked: doppler secrets download', bash('doppler secrets download --no-file') === 2);
ok('blocked: doppler secrets (bare list)', bash('doppler secrets') === 2);
ok('blocked: vault kv get', bash('vault kv get secret/app') === 2);
ok('blocked: vault read', bash('vault read secret/app') === 2);
ok('blocked: op read', bash('op read "op://vault/item/field"') === 2);
ok('blocked: op item get', bash('op item get "My Item"') === 2);

// ── command position is found past prefixes, wrappers, paths and separators ──
ok('blocked: sudo prefix', bash('sudo infisical export') === 2);
ok('blocked: NAME=VALUE prefix', bash('LC_ALL=C infisical secrets') === 2);
ok('blocked: absolute path to the binary', bash('/usr/local/bin/infisical secrets') === 2);
ok('blocked: second command in a chain', bash('echo hi && infisical secrets') === 2);
ok('blocked: after a pipe', bash('echo hi | doppler secrets') === 2);
ok('blocked: the nested command after --', bash('infisical run --silent -- vault read secret/app') === 2);

// ── the safe subcommands stay allowed ────────────────────────────────────────
ok('allowed: infisical run (injection, prints nothing)',
   bash('infisical run --path=/proj --silent -- npm run dev') === 0);
ok('allowed: infisical secrets set (a write)', bash('infisical secrets set FOO=bar') === 0);
ok('allowed: infisical secrets folders', bash('infisical secrets folders get') === 0);
ok('allowed: doppler secrets set', bash('doppler secrets set FOO=bar') === 0);
ok('allowed: doppler run', bash('doppler run -- npm start') === 0);
ok('allowed: op item get piped into op inject',
   bash('op item get x --format json | op inject') === 0);
ok('allowed: an unrelated command', bash('git status --short') === 0);

// ── the opt-out still works ──────────────────────────────────────────────────
ok('allowed with BRAYNEE_ALLOW_SECRET_READS=1',
   run({ tool_name: 'Bash', tool_input: { command: 'infisical secrets' } },
       { BRAYNEE_ALLOW_SECRET_READS: '1' }) === 0);

// ── the .env write branch is untouched by the parser change ──────────────────
ok('blocked: a real-looking key written into .env',
   write('/tmp/proj/.env', 'ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz012345\n') === 2);
ok('allowed: a placeholder written into .env',
   write('/tmp/proj/.env', 'ANTHROPIC_API_KEY=YOUR_KEY_HERE\n') === 0);
ok('allowed: a non-.env file with a keyish string',
   write('/tmp/proj/notes.md', 'ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz012345\n') === 0);

// ── never throws: malformed input fails open ─────────────────────────────────
{
  const r = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8', windowsHide: true });
  ok('malformed stdin fails open (exit 0)', r.status === 0);
}

if (fail === 0) {
  console.log(`secret-exposure-guard.test.js: ${pass} passed, 0 failed`);
  process.exit(0);
} else {
  console.error(`secret-exposure-guard.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
