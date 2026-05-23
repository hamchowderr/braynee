#!/usr/bin/env node
// check-version-bump.mjs — CI gate against released-build drift.
//
// Fails when shipping code has changed since the last released tag but
// plugin.json's version has NOT moved. Without this, a change can land on
// master at the same version, never get re-released, and the installed
// plugin silently lags source (cp-e2s: the dead TaskNotes HTTP-API skill
// stayed in the installed 2.0.0 because deletion commit 67703bd bumped
// nothing). See cp-9v9.
//
// Logic:
//   1. Find the most recent `braynee--v*` tag (the last release).
//   2. Read plugin.json version at that tag and at the head ref.
//   3. version moved        -> PASS (a release is coming).
//   4. version same + shipping files changed since the tag -> FAIL (bump it).
//   5. version same + no shipping changes                   -> PASS.
//
// Usage:  node scripts/check-version-bump.mjs [headRef]   (default: HEAD)
// Exit 0 = OK, exit 1 = gate failed (or unexpected error).

import { execSync } from 'node:child_process';

// Paths whose changes ship to users and therefore require a version bump.
const SHIPPING_PREFIXES = [
  'skills/', 'hooks/', 'scripts/', 'commands/', 'agents/', 'bin/',
  '.claude-plugin/',
];

const HEAD = process.argv[2] || 'HEAD';

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function lastReleaseTag() {
  const out = sh('git tag --sort=-creatordate --list "braynee--v*"');
  return out ? out.split('\n').filter(Boolean)[0] : null;
}

function versionAt(ref) {
  try {
    return JSON.parse(sh(`git show ${ref}:.claude-plugin/plugin.json`)).version;
  } catch {
    return null;
  }
}

function main() {
  const tag = lastReleaseTag();
  if (!tag) {
    console.log('check-version-bump: no braynee--v* tag yet — skipping (first release).');
    process.exit(0);
  }

  const tagVer = versionAt(tag);
  const headVer = versionAt(HEAD);
  if (!headVer) {
    console.error(`check-version-bump: cannot read plugin.json version at ${HEAD}`);
    process.exit(1);
  }

  if (headVer !== tagVer) {
    console.log(`check-version-bump: OK — version moved ${tagVer} (${tag}) -> ${headVer}.`);
    process.exit(0);
  }

  const changed = sh(`git diff --name-only ${tag} ${HEAD}`).split('\n').filter(Boolean);
  const shipping = changed.filter(f => SHIPPING_PREFIXES.some(p => f.startsWith(p)));

  if (shipping.length === 0) {
    console.log(`check-version-bump: OK — no shipping changes since ${tag} (v${headVer}).`);
    process.exit(0);
  }

  console.error(
    `check-version-bump: FAIL — ${shipping.length} shipping file(s) changed since ` +
    `${tag} but plugin.json is still v${headVer}.\n` +
    `Bump "version" in .claude-plugin/plugin.json AND .claude-plugin/marketplace.json, ` +
    `then tag a release. Changed shipping files:`
  );
  shipping.slice(0, 30).forEach(f => console.error('  - ' + f));
  if (shipping.length > 30) console.error(`  … and ${shipping.length - 30} more`);
  process.exit(1);
}

main();
