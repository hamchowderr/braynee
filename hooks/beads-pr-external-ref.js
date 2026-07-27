#!/usr/bin/env node
'use strict';

// beads-pr-external-ref.js
// Hook: PostToolUse (Bash) — closes the commit/PR ↔ beads loop (cp-lj73.4).
//
// The commit side is enforced BEFORE the fact by commit-format-check.js. The PR
// side cannot be: `bd update <id> --external-ref gh-<PR#>` needs the PR number,
// which does not exist until `gh pr create` has run. So this is PostToolUse, not
// a PreToolUse gate — the trade-off the issue's design already called out.
//
// Result: the link is navigable in BOTH directions. The PR body says which
// issues it closes; the issue carries `gh-<PR#>` pointing back at the PR that
// shipped it. Previously only the first direction existed, and only by
// convention.
//
// SCOPE: issue linkage only. The `Executed-By` agent-attribution trailer is
// beads-native (BEADS_ACTOR + bd's own prepare-commit-msg hook) and belongs to
// cp-uif3.5 — coordinate, don't duplicate. This hook writes no trailers.
//
// Never blocks and never fails a PR: by the time it runs the PR already exists.
// A stamping failure is reported through additionalContext, never as an error.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { commandSegments } = require(path.join(__dirname, 'lib', 'git-command.js'));
const { findIssueRefs } = require(path.join(__dirname, 'lib', 'commit-format.js'));
const { readIssues } = require(path.join(__dirname, 'lib', 'read-issues-jsonl.js'));
const { makeBudget } = require(path.join(__dirname, 'lib', 'time-budget.js'));

const HOOK = 'beads-pr-external-ref';

// cp-szoa: a hook gets ONE timeout from hooks.json, but this one shells out once
// per referenced issue. N ids x a generous per-call cap blows straight past the
// allowance, and a killed hook emits NOTHING — no error, no partial result.
//
// time-budget.js warns it is for work that is safe to TRUNCATE, and this hook
// mutates. It qualifies anyway because each stamp is independent and idempotent:
// cutting the loop short leaves some issues stamped and some not, which is a
// reportable state, not a broken one — and the skipped ids ARE reported below. A
// multi-step mutation (bd init, hooks install) would not qualify.
const BUDGET_MS = 12_000;      // < the 15s hooks.json timeout, leaving headroom
const PER_STAMP_CAP_MS = 8_000;

// gh prints the new PR's URL on success: https://github.com/<owner>/<repo>/pull/123
const PR_URL = /https?:\/\/[^\s"']*\/pull\/(\d+)/;

/**
 * The PR number gh just created, or null.
 *
 * Read from the tool's OUTPUT, never from the command: the number does not
 * exist until gh has run, and a command that failed produces none. Requiring
 * the URL is itself the success check — cp-snh2 is the precedent for not
 * announcing a state change that never happened.
 */
function prNumberFrom(data) {
  const resp = data && data.tool_response;
  if (!resp) return null;
  const text = typeof resp === 'string'
    ? resp
    : [resp.stdout, resp.output, resp.stderr].filter((s) => typeof s === 'string').join('\n');
  const m = PR_URL.exec(text || '');
  return m ? m[1] : null;
}

/** Ids that exist in THIS repo's beads — never stamp an id we cannot see. */
function knownIds(cwd) {
  const ids = new Set();
  try { for (const i of readIssues(cwd)) if (i && i.id) ids.add(i.id); } catch { /* no beads here */ }
  return ids;
}

/**
 * Has `bd init` actually run in THIS repo?
 *
 * A `.beads/` holding only `issues.jsonl` — a partial clone, or a directory
 * someone copied — is NOT an initialized repo, and running `bd update` there is
 * actively harmful in two ways, both observed while building this:
 *
 *   1. bd falls back to a database that is not this repo's. The probe returned
 *      `failed to open database … (gastownhall/beads`, i.e. it had resolved a
 *      DIFFERENT project's DB. A write there would stamp an unrelated issue —
 *      the cp-o4g cross-project scoping trap, with side effects.
 *   2. it left a `bd` process running past the call's own timeout, holding the
 *      directory open. That is the cp-6j5 orphan-process problem, caused by a
 *      hook, which is exactly why the read path in this codebase never shells
 *      out to bd at all.
 *
 * So the write is gated on an initialization marker, not on `.beads` existing.
 */
function hasLocalBeadsDb(cwd) {
  const beads = path.join(cwd, '.beads');
  try {
    if (!fs.existsSync(beads)) return false;
    const entries = fs.readdirSync(beads);
    return entries.some((e) =>
      e === 'embeddeddolt' || e === 'config.yaml' || e === 'metadata.json' || e.endsWith('.db'));
  } catch {
    return false;
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const command = data.tool_input?.command || '';
    const cwd = data.cwd || process.cwd();

    // Self-gate in JS, never via hooks.json `if` (CLAUDE.md), and match the
    // SHELL SEGMENT in command position so `cd repo && gh pr create` is seen —
    // the cp-fznk hole that made the main-branch guard bypassable.
    const prSeg = commandSegments(command).find((s) => /^gh\s+pr\s+create\b/i.test(s));
    if (!prSeg) process.exit(0);

    if (!fs.existsSync(path.join(cwd, '.beads'))) process.exit(0);

    const pr = prNumberFrom(data);
    if (!pr) process.exit(0);   // failed, or no URL to key off — nothing to stamp

    // Ids named anywhere in the command (title, body, --body-file path aside)
    // that actually exist in this repo's beads.
    const known = knownIds(cwd);
    const ids = findIssueRefs(command).filter((id) => known.has(id));

    if (!ids.length) {
      // The PR is already open, so this cannot be a block — but an unlinked PR
      // is precisely the gap this hook exists to close, so say so.
      log.info(HOOK, `PR #${pr} references no known beads issue`);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            `PR #${pr} was created but references no beads issue that exists in this repo, so ` +
            `the issue it ships has no link back to it. ` +
            `\`bd update <id> --external-ref gh-${pr}\` would record the link.`,
        },
      }));
      process.exit(0);
    }

    // Never write through bd unless this repo is genuinely bd-initialized.
    if (!hasLocalBeadsDb(cwd)) {
      log.info(HOOK, `PR #${pr}: .beads is not initialized here — not stamping ${ids.join(', ')}`);
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext:
            `PR #${pr} references ${ids.join(', ')}, but this repo's .beads is not initialized ` +
            `(no local database), so the external-ref was not recorded. ` +
            `Running \`bd update <id> --external-ref gh-${pr}\` in the repo that owns these ` +
            `issues would link them.`,
        },
      }));
      process.exit(0);
    }

    const budget = makeBudget(BUDGET_MS);
    const stamped = [];
    const failed = [];
    const skipped = [];
    for (const id of ids) {
      const allowed = budget.allow(PER_STAMP_CAP_MS);
      if (allowed === null) { skipped.push(id); continue; }
      const r = spawnSync('bd', ['update', id, '--external-ref', `gh-${pr}`], {
        cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: allowed, windowsHide: true,
      });
      if (r.status === 0) { stamped.push(id); continue; }
      failed.push(id);
      // spawnSync reports a TIMEOUT as status === null plus a kill signal, which
      // is indistinguishable from a crash unless you check for it explicitly.
      const why = r.error ? r.error.message
        : r.status === null ? `timed out or was killed (${r.signal || 'no signal'})`
        : `exit ${r.status}: ${String(r.stderr || '').trim().slice(0, 200)}`;
      log.debug(HOOK, `could not stamp ${id}: ${why}`);
    }

    if (stamped.length) log.info(HOOK, `stamped gh-${pr} on ${stamped.join(', ')}`);
    const parts = [];
    if (stamped.length) {
      parts.push(
        `Beads traceability: ${stamped.join(', ')} now carr${stamped.length === 1 ? 'ies' : 'y'} ` +
        `external-ref gh-${pr}, so the issue points back at the PR that ships it.`
      );
    }
    if (failed.length) {
      parts.push(
        `Could not stamp ${failed.join(', ')} (bd update failed); ` +
        `\`bd update <id> --external-ref gh-${pr}\` would record the link.`
      );
    }
    // Reporting the truncation is what makes a budget honest: a hook that runs
    // out of time and says "done" is claiming coverage it does not have.
    if (skipped.length) {
      log.info(HOOK, `budget exhausted, skipped ${skipped.join(', ')}`);
      parts.push(
        `Ran out of time before ${skipped.join(', ')} — not stamped. ` +
        `\`bd update <id> --external-ref gh-${pr}\` would finish the link.`
      );
    }
    if (parts.length) {
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: parts.join(' ') },
      }));
    }
    process.exit(0);
  } catch (e) {
    try { log.error(HOOK, `crash: ${e.message}`); } catch { /* logging must never break the hook */ }
    process.exit(0);
  }
});
