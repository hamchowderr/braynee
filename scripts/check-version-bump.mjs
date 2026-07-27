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

// cp-0gs2: this gate used to FAIL on any shipping change without a version bump,
// which put it in direct conflict with the release rule in CLAUDE.md — commits
// ACCUMULATE on main and ONE release is cut per batch. Under that rule main went
// red on the first phase-1 commit and stayed red until the release, so a genuine
// failure had nowhere to show: it hid behind a job everyone already knew was red.
//
// Split by WHERE it runs instead of relaxing it:
//   • ordinary push to main  -> WARN (exit 0), reporting what is unreleased
//   • the release path       -> FAIL, exactly as before
//   • batch left too long    -> FAIL even on main, so the original cp-e2s
//                               protection (a released build silently lagging
//                               source) still has teeth
//
// --strict            force the failing behavior (the release workflow passes it)
// --max-age-days <n>  how long a batch may sit unreleased before warn escalates
//                     to fail. 0 disables the escalation.
const args = process.argv.slice(2);
const flagIdx = args.findIndex((a) => a.startsWith('--'));
const HEAD = (flagIdx === 0 ? null : args[0]) || 'HEAD';
const STRICT = args.includes('--strict');
const MAX_AGE_DAYS = (() => {
  const i = args.indexOf('--max-age-days');
  if (i < 0) return 14;
  const v = Number(args[i + 1]);
  return Number.isFinite(v) && v >= 0 ? v : 14;
})();

function sh(cmd) {
  return execSync(cmd, { encoding: 'utf8', windowsHide: true }).trim();
}

/**
 * True when this run IS a release: HEAD carries a braynee--v* tag. Checked in
 * addition to --strict so the gate cannot be softened by forgetting the flag in
 * a workflow — the release path is identified by the ref itself.
 */
function headIsReleaseTag() {
  try {
    return sh(`git tag --points-at ${HEAD} --list "braynee--v*"`).length > 0;
  } catch {
    return false;
  }
}

/** Days since the tag was created, or null when it cannot be determined. */
function tagAgeDays(tag) {
  try {
    const ts = Number(sh(`git log -1 --format=%ct ${tag}`));
    if (!Number.isFinite(ts) || ts <= 0) return null;
    return (Date.now() / 1000 - ts) / 86400;
  } catch {
    return null;
  }
}

/**
 * The release to compare HEAD against.
 *
 * cp-0gs2: this used to take the newest braynee--v* tag unconditionally. On the
 * RELEASE path that tag is on HEAD itself, so the gate diffed HEAD against HEAD,
 * found no changes, and passed — every time, regardless of whether the version
 * had moved. The enforcement was vacuous exactly where it mattered most, and the
 * self-test caught it.
 *
 * Tags pointing at HEAD are therefore skipped: the meaningful baseline is the
 * PREVIOUS release. On main (no tag on HEAD) this is unchanged behavior.
 */
function lastReleaseTag() {
  const out = sh('git tag --sort=-creatordate --list "braynee--v*"');
  const tags = out ? out.split('\n').map((t) => t.trim()).filter(Boolean) : [];
  if (!tags.length) return null;
  let onHead = new Set();
  try {
    onHead = new Set(sh(`git tag --points-at ${HEAD} --list "braynee--v*"`)
      .split('\n').map((t) => t.trim()).filter(Boolean));
  } catch { /* no tag on HEAD — every tag is a valid baseline */ }
  for (const t of tags) if (!onHead.has(t)) return t;
  return null;   // only HEAD's own tag exists: this is the first release
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

  // Unreleased shipping changes exist. Whether that is a FAILURE depends on
  // where we are: mid-batch on main it is the documented normal state.
  const releasing = STRICT || headIsReleaseTag();
  const ageDays = tagAgeDays(tag);
  const stale = MAX_AGE_DAYS > 0 && ageDays !== null && ageDays > MAX_AGE_DAYS;

  const detail = [
    `${shipping.length} shipping file(s) changed since ${tag} but plugin.json is still v${headVer}.`,
    ...shipping.slice(0, 30).map((f) => '  - ' + f),
    ...(shipping.length > 30 ? [`  … and ${shipping.length - 30} more`] : []),
  ].join('\n');

  if (releasing) {
    console.error(`check-version-bump: FAIL — ${detail}\n` +
      `Bump "version" in .claude-plugin/plugin.json AND .claude-plugin/marketplace.json, ` +
      `then tag a release.`);
    process.exit(1);
  }

  if (stale) {
    console.error(
      `check-version-bump: FAIL — ${detail}\n` +
      `The batch has been unreleased for ${ageDays.toFixed(0)} days ` +
      `(limit ${MAX_AGE_DAYS}). Accumulating commits is the normal workflow, but a ` +
      `batch left this long means the installed plugin is lagging source — the drift ` +
      `this gate exists to prevent. Cut a release, or raise --max-age-days deliberately.`
    );
    process.exit(1);
  }

  // The batching rule's normal state. Report it loudly, but do not fail: a
  // permanently-red main is what lets a REAL failure go unnoticed.
  console.log(
    `check-version-bump: OK (unreleased batch) — ${detail}\n` +
    `This is expected between batched releases; the gate fails on the release path ` +
    `(--strict, or a braynee--v* tag on HEAD)` +
    (ageDays !== null ? `, and here after ${MAX_AGE_DAYS} days (batch age ${ageDays.toFixed(1)}d).` : '.')
  );
  process.exit(0);
}

main();
