// beads-version-check.js
// Hook: SessionStart — detect a bd (beads) upgrade between sessions and surface
// what changed, so the agent can adapt its workflow. Adopts the pattern from
// gastownhall/beads examples/startup-hooks/bd-version-check.sh, but in-plugin.
//
// State: the last bd version braynee announced is tracked in
// .beads/metadata.json under the braynee-owned key `braynee_seen_bd_version`.
// We deliberately do NOT reuse bd's own `last_bd_version` field — that one is
// bd's to manage, and racing it would make detection unreliable.
//
// Behaviour (always exit 0, never blocks):
//   - not a code context / no project .beads / bd not on PATH / no metadata.json
//       → silent no-op (let check-beads-init own the "no beads" story)
//   - first time we see this repo (no seen-version) → seed it silently
//   - version unchanged → nothing to do
//   - version changed → announce the upgrade with `bd info --whats-new`,
//       best-effort refresh bd's git hooks, and record the new version
//
// Output is plain markdown on stdout → injected into the session context (same
// mechanism as check-beads-init).

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { findCodeRoot, findBeadsRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

const HOOK = 'beads-version-check';
const SEEN_KEY = 'braynee_seen_bd_version';
const WHATS_NEW_CAP = 2000; // don't dump a huge changelog into context

// Pure decision — exported for the self-test. Given the running bd version and
// the version we last recorded, decide what to do. Covers upgrade AND
// downgrade/rollback (any change is worth surfacing).
function decideVersionChange(current, seen) {
  if (!current) return { emit: false, seed: false };        // couldn't read bd
  if (!seen) return { emit: false, seed: true, next: current }; // first run → seed
  if (seen === current) return { emit: false, seed: false };    // unchanged
  return { emit: true, seed: true, next: current, from: seen, to: current };
}

function bdExec(args, timeout) {
  return execSync(`bd ${args}`, {
    encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
}

function bdVersion() {
  try {
    const m = bdExec('version', 5000).match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : null;
  } catch { return null; }
}

function bdWhatsNew() {
  try {
    const out = bdExec('info --whats-new', 8000).trim();
    return out.length > WHATS_NEW_CAP ? out.slice(0, WHATS_NEW_CAP) + '\n… (truncated — run `bd info --whats-new`)' : out;
  } catch { return ''; }
}

function refreshGitHooks(cwd) {
  try { bdExecIn('hooks install', cwd, 20000); return true; } catch { return false; }
}

function bdExecIn(args, cwd, timeout) {
  return execSync(`bd ${args}`, {
    cwd, encoding: 'utf8', timeout, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
  });
}

function metaPathFor(beadsRoot) {
  return path.join(beadsRoot, '.beads', 'metadata.json');
}

function readMeta(metaPath) {
  try { return JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { return null; }
}

// Preserve every existing field; only set the braynee-owned seen-version key.
function writeSeen(metaPath, json, version) {
  try {
    fs.writeFileSync(metaPath, JSON.stringify({ ...json, [SEEN_KEY]: version }, null, 2) + '\n', 'utf8');
    return true;
  } catch { return false; }
}

function main(data) {
  const codeRoot = findCodeRoot(sessionDir(data));
  if (!codeRoot) return process.exit(0);

  const beadsRoot = findBeadsRoot(codeRoot);
  if (!beadsRoot) return process.exit(0); // no project beads → nothing to track

  const current = bdVersion();
  if (!current) return process.exit(0);   // bd not on PATH → silent

  const metaPath = metaPathFor(beadsRoot);
  const json = readMeta(metaPath);
  if (!json) return process.exit(0);      // no metadata.json → check-beads-init owns setup

  const decision = decideVersionChange(current, json[SEEN_KEY]);
  if (decision.seed) writeSeen(metaPath, json, decision.next);
  if (!decision.emit) return process.exit(0); // first-run seed or unchanged → silent

  log.info(HOOK, `bd changed ${decision.from} → ${decision.to}`);
  const whatsNew = bdWhatsNew();
  const hooksRefreshed = refreshGitHooks(beadsRoot);

  process.stdout.write(
    `# Beads (bd) upgraded: ${decision.from} → ${decision.to}\n\n` +
    `The \`bd\` CLI changed since your last session in \`${path.basename(beadsRoot)}\`. ` +
    `Review what changed and adapt your beads workflow if needed.\n\n` +
    (whatsNew ? '```\n' + whatsNew + '\n```\n\n' : `Run \`bd info --whats-new\` to see the changelog.\n\n`) +
    (hooksRefreshed ? `braynee also refreshed bd's git hooks to match ${decision.to}.\n\n` : '')
  );
  process.exit(0);
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; });
  process.stdin.on('end', () => {
    try { main(input ? JSON.parse(input) : {}); }
    catch (e) { log.error(HOOK, `crash: ${e.message}`); process.exit(0); }
  });
} else {
  // Required by the self-test: expose the pure decision without running main.
  module.exports = { decideVersionChange };
}
