#!/usr/bin/env node
'use strict';

// commit-format-check.js
// Hook: PreToolUse (Bash) — the agent-facing half of the commit/PR conventions
// (cp-lj73.2). Catches a malformed commit or PR title at the moment it is
// written, instead of at review time when rewriting history is expensive.
//
// The standard itself is NOT defined here. It ships as
// skills/setup/rules-templates/commit-pr-conventions.md (cp-lj73.1) and installs
// to ~/.claude/rules/commit-pr-conventions.md; every message below cites that
// path so the rule can be read rather than guessed at. Two copies of a standard
// is one standard and one bug.
//
// ONE hook, two commands. The issue design called for two hook files; they are
// merged because both are PreToolUse-on-Bash, both need the same segment
// splitting, and every registered hook costs a node spawn on EVERY Bash call —
// there are already four. A single file is cheaper and cannot drift.
//
// Policy — where the line is drawn:
//   BLOCK (exit 2): the subject/title is not Conventional Commits form. This is
//     mechanical, unambiguous, and fixable by rewording the command that was
//     just rejected. Nothing is lost.
//   WARN (exit 0 + additionalContext): everything needing judgement — subject
//     length, imperative mood, PR size, a missing beads reference.
//
// The traceability check WARNS rather than blocks, which is a deliberate
// departure from this issue's design field. Blocking a commit for a missing
// issue id would fire on legitimately untracked work (a dependency bump), and
// the only way for an agent to satisfy a block it cannot legitimately satisfy is
// to invent an id — turning a traceability control into a source of false
// traceability. cp-lj73.4 owns the trailer convention; once there IS a canonical
// shape to point at, this can be promoted. cp-0oqe is the precedent for the
// general principle: a guard that fires on correct usage teaches the override as
// a reflex, which erodes it for the cases that matter.
//
// Opt-out (per-repo, settable mid-session — cp-ar0c):
//   git config --local braynee.allow-freeform-commits true
//   env BRAYNEE_ALLOW_FREEFORM_COMMITS=1   (still honored; wins)

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { commandSegments, repoAllows } = require(path.join(__dirname, 'lib', 'git-command.js'));
const CF = require(path.join(__dirname, 'lib', 'commit-format.js'));

const HOOK = 'commit-format-check';

// The rule's reviewable-diff ceiling. Warn only: a big PR is sometimes correct
// (a generated file, a mechanical rename), and the rule's own justification is
// about review quality, not legality.
const PR_LOC_WARN = 400;

const ENV_ALLOW = process.env.BRAYNEE_ALLOW_FREEFORM_COMMITS === '1';

function git(args, cwd, timeout = 5000) {
  return execSync(`git ${args}`, {
    cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout, windowsHide: true,
  }).trim();
}

function emit(lines) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: lines.join(' '),
    },
  }));
}

/** True when this repo tracks work in beads, so a missing ref is worth noting. */
function usesBeads(cwd) {
  try { return fs.existsSync(path.join(cwd, '.beads')); } catch { return false; }
}

/**
 * Added+deleted lines the PR would carry. Returns null when it cannot be
 * determined — an unknown size must never produce a size warning.
 */
function prDiffSize(cwd, explicitBase) {
  const bases = [];
  if (explicitBase) bases.push(explicitBase, `origin/${explicitBase}`);
  try {
    // The remote's own default branch, when the remote HEAD ref is present.
    const head = git('symbolic-ref --quiet refs/remotes/origin/HEAD', cwd, 3000);
    if (head) bases.push(head.replace(/^refs\/remotes\//, ''));
  } catch { /* no remote HEAD ref — fall through to the conventional names */ }
  bases.push('origin/main', 'origin/master', 'main', 'master');

  for (const base of bases) {
    try {
      // `base...HEAD` counts only what THIS branch added since it diverged,
      // which is what a reviewer sees. `base..HEAD` would also count everything
      // that landed on base meanwhile.
      const out = git(`diff --shortstat ${base}...HEAD`, cwd, 5000);
      if (!out) return 0;
      const ins = /(\d+) insertion/.exec(out);
      const del = /(\d+) deletion/.exec(out);
      return (ins ? Number(ins[1]) : 0) + (del ? Number(del[1]) : 0);
    } catch { /* not a valid base here — try the next candidate */ }
  }
  return null;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input || '{}');
    const command = data.tool_input?.command || '';
    const cwd = data.cwd || process.cwd();

    // Self-gate in JS, never via hooks.json `if` (see CLAUDE.md): match each
    // SHELL SEGMENT in command position, so `cd repo && git commit -m x` is
    // still seen. Anchoring at the start of the whole command is the cp-fznk
    // hole that made the main-branch guard bypassable by a three-char prefix.
    const segments = commandSegments(command);
    const commitSeg = segments.find((s) => /^git\s+commit\b/i.test(s));
    const prSeg = segments.find((s) => /^gh\s+pr\s+create\b/i.test(s));
    if (!commitSeg && !prSeg) process.exit(0);

    if (ENV_ALLOW || repoAllows(cwd, 'allow-freeform-commits')) process.exit(0);

    const warnings = [];

    // ── git commit ────────────────────────────────────────────────────────────
    if (commitSeg) {
      // A message that lives in a file, another commit, or the editor is not on
      // this command line. Judging it would mean guessing.
      if (!CF.messageIsElsewhere(commitSeg)) {
        // Segment-scoped by default, raw only when a heredoc was torn apart by
        // the split — see commitMessageFor(); both naive choices misjudge a
        // valid commit.
        const message = CF.commitMessageFor(command, commitSeg);
        if (message) {
          const subject = message.split(/\r?\n/)[0];
          const { errors, warnings: subWarn } = CF.checkSubject(subject, { label: 'Commit subject' });

          if (errors.length) {
            log.warn(HOOK, `blocked non-conventional commit subject: ${subject.slice(0, 80)}`);
            process.stderr.write(
              `BLOCKED: ${errors.join(' ')}\n` +
              `Rewrite the subject as \`type(scope): summary\` (imperative, ` +
              `≤${CF.SUBJECT_TARGET} chars) and run the command again — nothing else needs to change.\n` +
              `Types: ${CF.TYPES.join(', ')}. Full standard: ${CF.RULE_PATH}\n` +
              `If this repo intentionally uses free-form commit messages, run ` +
              `\`git config --local braynee.allow-freeform-commits true\`.`
            );
            process.exit(2);
          }

          warnings.push(...subWarn);

          if (usesBeads(cwd) && !CF.findIssueRefs(message).length) {
            warnings.push(
              'No beads issue id appears in the message, so this commit cannot be traced ' +
              'back to the work that motivated it; adding it to the subject or a Refs: footer would fix that.'
            );
          }
        }
      }
    }

    // ── gh pr create ──────────────────────────────────────────────────────────
    if (prSeg) {
      const title = CF.flagValue(prSeg, ['--title', '-t']);
      // No --title means `--fill` (title from the commits, already checked
      // above) or the interactive prompt. Neither is judgeable here.
      if (title) {
        const { errors, warnings: titleWarn } = CF.checkSubject(title, { label: 'PR title' });
        if (errors.length) {
          log.warn(HOOK, `blocked non-conventional PR title: ${title.slice(0, 80)}`);
          process.stderr.write(
            `BLOCKED: ${errors.join(' ')}\n` +
            `Title the PR by its highest-impact commit (feat > fix > refactor/perf > ` +
            `test/chore/docs) in \`type(scope): summary\` form, then run the command again.\n` +
            `Full standard: ${CF.RULE_PATH}`
          );
          process.exit(2);
        }
        warnings.push(...titleWarn);
      }

      // A --body given as a heredoc is torn apart by the split exactly like a
      // commit message, so the same selector recovers it.
      const body = CF.flagValue(prSeg, ['--body', '-b']) || CF.commitMessageFor(command, prSeg) || '';
      const hasBodyFile = /(?:^|\s)(?:--body-file|-F)(?:[=\s])/.test(prSeg);
      if (usesBeads(cwd) && !hasBodyFile && !CF.findIssueRefs(body).length) {
        warnings.push(
          'The PR body references no beads issue, so the shipped change cannot be traced ' +
          'back to the tracked work.'
        );
      }

      const loc = prDiffSize(cwd, CF.flagValue(prSeg, ['--base', '-B']));
      if (loc !== null && loc > PR_LOC_WARN) {
        warnings.push(
          `This branch changes ~${loc} lines against its base; the rule's reviewable ceiling ` +
          `is ~${PR_LOC_WARN} (defect detection drops sharply past it). Splitting or stacking ` +
          `the PRs would keep it reviewable.`
        );
      }
    }

    if (warnings.length) {
      log.info(HOOK, `${warnings.length} advisory warning(s)`);
      // cp-psc/HD-4.2: exit-0 stderr is NOT surfaced to Claude on PreToolUse;
      // additionalContext is the documented channel. Factual phrasing, not an
      // imperative, so it is not read as an out-of-band instruction. The command
      // proceeds either way.
      emit([
        'Commit/PR conventions —',
        ...warnings,
        `The command is allowed; the full standard is at ${CF.RULE_PATH}.`,
      ]);
    }
    process.exit(0);
  } catch (e) {
    // A formatting guard must never be the reason a commit cannot be made.
    try { log.error(HOOK, `crash: ${e.message}`); } catch { /* logging must never break the hook */ }
    process.exit(0);
  }
});
