#!/usr/bin/env node
'use strict';

// commit-format.test.js — cp-lj73.2.
//
// The guard blocks commits, so its parser is the part that has to be right: a
// message it reads WRONG produces a confident, wrong block on a correct commit,
// and that is how a guard gets switched off permanently.
//
// The specific trap these lock down is the heredoc. The commit form Claude Code
// documents puts the whole message inside `"$(cat <<'EOF' … EOF)"`, whose body
// contains the newlines and pipes that commandSegments() splits on. Detect from
// segments, but READ from the raw command — assert both directions here.
//
// Pure Node, no deps, cross-platform. Exit 0 = pass, 1 = fail.

const {
  TYPES, SUBJECT_TARGET, flagValue, extractCommitMessage, commitMessageFor,
  messageIsElsewhere, checkSubject, findIssueRefs, referencesKnownIssue,
} = require('./commit-format.js');
const { commandSegments } = require('./git-command.js');

let pass = 0, fail = 0;
const fails = [];
const ok = (name, cond, detail) => {
  if (cond) pass++;
  else { fail++; fails.push(name + (detail ? ` — ${detail}` : '')); }
};
const eq = (name, got, want) =>
  ok(name, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

const errs = (s) => checkSubject(s).errors;
const warns = (s) => checkSubject(s).warnings;
const blocked = (s) => errs(s).length > 0;

// ── extractCommitMessage ─────────────────────────────────────────────────────
eq('-m with double quotes',
  extractCommitMessage('git commit -m "feat: add login"'), 'feat: add login');
eq('-m with single quotes',
  extractCommitMessage("git commit -m 'fix: null deref'"), 'fix: null deref');
eq('--message= form',
  extractCommitMessage('git commit --message="docs: update readme"'), 'docs: update readme');
eq('--message with a space',
  extractCommitMessage('git commit --message "chore: bump"'), 'chore: bump');
eq('combined short flag -am',
  extractCommitMessage('git commit -am "fix: typo in path"'), 'fix: typo in path');
eq('unquoted single-word message',
  extractCommitMessage('git commit -m wip'), 'wip');
eq('no message at all is null',
  extractCommitMessage('git commit'), null);
eq('an editor commit is null',
  extractCommitMessage('git commit --amend'), null);

// git joins repeated -m as paragraphs; the SUBJECT must stay the first one.
{
  const msg = extractCommitMessage('git commit -m "feat: add x" -m "why it matters"');
  eq('repeated -m keeps the first as subject', msg.split('\n')[0], 'feat: add x');
  ok('repeated -m keeps the body too', /why it matters/.test(msg), msg);
}

// The documented heredoc form — the one that must not be torn apart.
{
  const cmd = [
    'git commit -m "$(cat <<\'EOF\'',
    'feat(hooks): add the format guard',
    '',
    'Body line one; body line two | with pipes.',
    'EOF',
    ')"',
  ].join('\n');
  const msg = extractCommitMessage(cmd);
  eq('heredoc subject survives', msg.split('\n')[0], 'feat(hooks): add the format guard');
  ok('heredoc body survives', /body line two \| with pipes/i.test(msg), msg);

  // Why commitMessageFor exists at all: a segment-only read truncates this to
  // `"$(cat`, which is not Conventional form — so the guard would BLOCK a
  // perfectly good commit. Assert the wrong answer really is wrong.
  const firstSeg = commandSegments(cmd).find((s) => /^git\s+commit\b/.test(s));
  ok('the commit is still DETECTED from the segments',
    !!firstSeg, 'heredoc commit must still be seen as a git commit');
  eq('a segment-only read truncates the heredoc subject',
    extractCommitMessage(firstSeg), '"$(cat');
  ok('...and that truncation WOULD have blocked a valid commit',
    checkSubject(extractCommitMessage(firstSeg)).errors.length > 0);
  eq('commitMessageFor recovers the real subject',
    commitMessageFor(cmd, firstSeg).split('\n')[0], 'feat(hooks): add the format guard');
}

// ── commitMessageFor: the other naive choice is wrong too ────────────────────
// Reading the RAW command unconditionally finds an earlier `-m` belonging to a
// DIFFERENT command, and blocks the real commit on the strength of a quoted
// string. The segment is correctly scoped, so it must win when there is no
// heredoc to recover.
{
  const cmd = `echo "git commit -m 'oops'" && git commit -m "feat: real subject"`;
  const seg = commandSegments(cmd).find((s) => /^git\s+commit\b/.test(s));
  // Both -m matches are collected, so the DECOY becomes the subject line.
  eq('a raw-only read makes the quoted decoy the subject',
    extractCommitMessage(cmd).split('\n')[0], 'oops');
  ok('...and the decoy WOULD have blocked a valid commit',
    checkSubject('oops').errors.length > 0);
  eq('commitMessageFor reads the segment instead',
    commitMessageFor(cmd, seg), 'feat: real subject');
  ok('so the valid commit is NOT blocked',
    checkSubject(commitMessageFor(cmd, seg)).errors.length === 0);
}
eq('commitMessageFor is null when there is no message',
  commitMessageFor('cd . && git commit', 'git commit'), null);
eq('unquoted heredoc delimiter',
  extractCommitMessage('git commit -m "$(cat <<EOF\nfix: x\nEOF\n)"'), 'fix: x');
eq('indented <<- heredoc',
  extractCommitMessage('git commit -m "$(cat <<-EOF\nfix: y\n\tEOF\n)"'), 'fix: y');
eq('CRLF heredoc',
  extractCommitMessage('git commit -m "$(cat <<\'EOF\'\r\nfix: z\r\nEOF\r\n)"'), 'fix: z');

// ── messageIsElsewhere ───────────────────────────────────────────────────────
ok('-F means the message is in a file', messageIsElsewhere('git commit -F msg.txt'));
ok('--file means the message is in a file', messageIsElsewhere('git commit --file=msg.txt'));
ok('--no-edit reuses the existing message', messageIsElsewhere('git commit --amend --no-edit'));
ok('--fixup generates its own subject', messageIsElsewhere('git commit --fixup HEAD'));
ok('-C reuses another commit', messageIsElsewhere('git commit -C HEAD'));
ok('a plain -m commit is judgeable', !messageIsElsewhere('git commit -m "feat: x"'));

// ── checkSubject: what BLOCKS ────────────────────────────────────────────────
ok('a bare sentence is blocked', blocked('added the login page'));
ok('a missing colon is blocked', blocked('feat add login'));
ok('an unknown type is blocked', blocked('feature: add login'));
ok('an empty subject is blocked', blocked(''));
ok('a type with no summary is blocked', blocked('feat:'));
ok('an empty scope is blocked', blocked('feat(): add login'));
ok('a capitalised type is blocked', blocked('Feat: add login'));
ok('the capitalised-type hint names the fix',
  /Did you mean `feat`/.test(errs('Feat: add login').join(' ')),
  errs('Feat: add login').join(' '));

// ── checkSubject: what PASSES ────────────────────────────────────────────────
ok('plain type: summary passes', !blocked('feat: add login'));
ok('type(scope): summary passes', !blocked('fix(hooks): stop the guard crashing'));
ok('a breaking-change bang passes', !blocked('feat(api)!: drop v1 endpoints'));
for (const t of TYPES) ok(`type "${t}" is accepted`, !blocked(`${t}: do the thing`));
ok('a scope with a slash passes', !blocked('ci(github/actions): pin node'));
ok('a real braynee subject passes',
  !blocked('fix(ci): stop the version-bump gate keeping main red'));

// ── checkSubject: what only WARNS ────────────────────────────────────────────
{
  const long = 'feat(hooks): ' + 'x'.repeat(80);
  ok('an over-long subject warns but does not block', !blocked(long) && warns(long).length > 0);
  ok('the length warning cites the target',
    warns(long).some((w) => w.includes(String(SUBJECT_TARGET))), warns(long).join(' '));
  ok('a subject at the target does NOT warn about length',
    !warns('feat: add the login page').some((w) => /chars/.test(w)));
}
ok('past tense warns', warns('feat: added the login page').some((w) => /imperative/.test(w)));
ok('third person warns', warns('fix: fixes the null deref').some((w) => /imperative/.test(w)));
ok('gerund warns', warns('refactor: moving the parser').some((w) => /imperative/.test(w)));
ok('imperative does NOT warn', !warns('feat: add the login page').some((w) => /imperative/.test(w)));
// A bare /s$/ heuristic would flag these ordinary imperatives — the exact way a
// nudge turns into noise people mute.
for (const s of ['feat: process the queue', 'fix: address the race', 'perf: pass fewer args',
                 'chore: express the dep range']) {
  ok(`"${s}" is not mistaken for non-imperative`, !warns(s).some((w) => /imperative/.test(w)));
}
ok('wip warns', warns('chore: wip').some((w) => /noise/.test(w)));
ok('fix typo warns', warns('fix: typo').some((w) => /noise/.test(w)));
ok('address review warns', warns('chore: address review').some((w) => /noise/.test(w)));
ok('a breaking change warns about the major bump',
  warns('feat(api)!: drop v1').some((w) => /major/.test(w)));

// ── findIssueRefs ────────────────────────────────────────────────────────────
ok('an id in the subject is found', findIssueRefs('fix(ci): do the thing (cp-0gs2)').includes('cp-0gs2'));
ok('a dotted sub-issue id is found', findIssueRefs('feat: x (cp-lj73.2)').includes('cp-lj73.2'));
ok('a Refs: footer is found', findIssueRefs('feat: x\n\nRefs: bd-123').includes('bd-123'));
ok('a Closes: footer is found', findIssueRefs('fix: y\n\nCloses: proj-9a').includes('proj-9a'));
eq('a message with no id finds none', findIssueRefs('feat: add the login page').length, 0);

// ── referencesKnownIssue (cp-lj73.4) ─────────────────────────────────────────
// findIssueRefs guesses at the SHAPE of an id, and its 2+ char suffix rule
// (tuned to skip "utf-8") misses short real ids. That was harmless while a
// missing reference only warned; once it can BLOCK a commit, the miss blocks
// correct work. These pin the exact matcher that replaced the guess.
{
  const IDS = ['tt-1', 'tt-42', 'cp-lj73', 'cp-lj73.2'];
  const refs = (s) => referencesKnownIssue(s, IDS);

  ok('the shape guess MISSES a short id (the bug)', !findIssueRefs('Refs: tt-1').includes('tt-1'));
  ok('...and the exact matcher finds it', refs('Refs: tt-1').includes('tt-1'));

  ok('an id in parentheses is found', refs('fix: tidy up (tt-42)').includes('tt-42'));
  ok('a Refs: footer is found', refs('feat: x\n\nRefs: cp-lj73.2').includes('cp-lj73.2'));
  ok('a Closes: footer is found', refs('feat: x\n\nCloses: tt-42').includes('tt-42'));
  ok('an id at the very start is found', refs('tt-42 done').includes('tt-42'));
  ok('an id at the very end is found', refs('done tt-42').includes('tt-42'));

  // Near-misses must NOT count, or the block is trivially bypassed by typo.
  ok('tt-1 does not match inside tt-123', !refs('see tt-123').includes('tt-1'));
  ok('tt-42 does not match inside tt-420', !refs('see tt-420').includes('tt-42'));
  ok('an unknown id matches nothing', refs('see zz-999').length === 0);
  ok('an unrelated hyphenated token matches nothing', refs('move to utf-8 encoding').length === 0);

  // A parent id counts for its children: citing the epic still traces the work.
  ok('the parent id is found on its own', refs('feat: x (cp-lj73)').includes('cp-lj73'));
  ok('citing the child also matches the parent prefix',
    refs('feat: x (cp-lj73.2)').includes('cp-lj73.2'));

  eq('an empty id list finds nothing', referencesKnownIssue('tt-42', []).length, 0);
  eq('empty text finds nothing', refs('').length, 0);
}

// ── flagValue ────────────────────────────────────────────────────────────────
eq('--title with a space', flagValue('gh pr create --title "feat: x" --body y', ['--title', '-t']), 'feat: x');
eq('--title= form', flagValue('gh pr create --title="fix: y"', ['--title', '-t']), 'fix: y');
eq('-t short form', flagValue('gh pr create -t \'chore: z\'', ['--title', '-t']), 'chore: z');
eq('an absent flag is null', flagValue('gh pr create --fill', ['--title', '-t']), null);
eq('--base is read', flagValue('gh pr create --base develop -t "feat: x"', ['--base', '-B']), 'develop');

// ── report ───────────────────────────────────────────────────────────────────
if (fail) {
  console.error(`commit-format.test.js: ${pass} passed, ${fail} FAILED`);
  for (const f of fails) console.error('  - ' + f);
  process.exit(1);
}
console.log(`commit-format.test.js: ${pass} passed`);
process.exit(0);
