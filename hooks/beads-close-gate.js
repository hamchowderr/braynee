// beads-close-gate.js
// Hook: PreToolUse (Bash) — verify-before-close gate (cp-9f2.5).
//
// Per ~/.claude/rules/testing-tiers.md ("verify behavior, not just logic"), a
// code/build issue should not be closed on logic-green alone. This intercepts
// `bd close <id...>` (and `bd update <id> --status closed`) and checks each
// target issue for a recorded VERIFY step — evidence in the issue NOTES, or
// verify language in the close `--reason`. (Deliberately NOT acceptance_criteria
// or description: those state the PLAN — "verified via X" — so scanning them
// would false-allow every issue.)
//
// Missing evidence is FLAGGED via additionalContext by default (non-blocking,
// exit 0), or hard-BLOCKED (exit 2) when BRAYNEE_CLOSE_GATE=block. Disable with
// BRAYNEE_CLOSE_GATE=off. Only gates feature/task/bug issues; --force bypasses.
//
// Self-gates in JS (never the hooks.json `if` field — version-unreliable): it
// exits 0 immediately unless the command is a bd close/close-update in a beads
// repo, before any side effect.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'beads-close-gate';
const MODE = (process.env.BRAYNEE_CLOSE_GATE || '').toLowerCase(); // '', 'block', 'off'

// Recorded-evidence language (scanned in notes + close --reason).
const VERIFY_RE = /\b(verif(?:y|ied|ication)|self[- ]?test|sandbox|behaviou?r[- ]?verif|tests?\s+(?:are\s+)?(?:green|pass(?:ed|ing)?)|all\s+green|preview\s+(?:live|url))\b/i;
// Issue types worth gating (code/build/deploy work). Others (epic/decision/
// chore/event) are exempt — they have no behavior to verify.
const GATED_TYPES = new Set(['feature', 'task', 'bug']);
// bd id shape, allowing internal '.'/'-' segments (cp-9f2.7, cp-wisp-q8r).
const ID_RE = /\b[a-z]{2,}-[a-z0-9]+(?:[.-][a-z0-9]+)*\b/gi;

// Parse a close-style command into { ids, force, reason } or null.
function parseClose(cmd) {
  let idsPart = null;
  const mClose = cmd.match(/^\s*bd\s+close\s+(.*)$/i);
  const mUpdate = cmd.match(/^\s*bd\s+update\s+(.*)$/i);
  if (mClose) idsPart = mClose[1];
  else if (mUpdate && /--status[=\s]+closed\b/.test(cmd)) idsPart = mUpdate[1];
  if (idsPart === null) return null;
  // ids are the leading positional tokens, before the first flag.
  const beforeFlags = idsPart.split(/\s+-/)[0];
  const ids = beforeFlags.match(ID_RE) || [];
  const force = /(^|\s)(-f|--force)\b/.test(cmd);
  const rm = cmd.match(/(?:--reason|-r)[=\s]+(?:"([^"]*)"|'([^']*)'|(\S+))/);
  const reason = rm ? (rm[1] || rm[2] || rm[3] || '') : '';
  return { ids, force, reason };
}

function showIssue(id, cwd) {
  try {
    const out = execSync(`bd show ${id} --json`, {
      cwd, encoding: 'utf8', timeout: 15000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    let j = JSON.parse(out.trim() || 'null');
    if (Array.isArray(j)) j = j[0];
    return j || null;
  } catch { return null; }
}

// Does this issue have recorded verify evidence (notes or the close reason)?
function hasVerifyEvidence(issue, reason) {
  if (VERIFY_RE.test(reason || '')) return true;
  if (issue && VERIFY_RE.test(issue.notes || '')) return true;
  return false;
}

function main() {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', c => { input += c; });
  process.stdin.on('end', () => {
  try {
    if (MODE === 'off') process.exit(0);
    const data = JSON.parse(input || '{}');
    const cmd = (data.tool_input?.command || '').trim();
    const cwd = data.cwd || process.cwd();

    // Self-gate: only bd close / close-update, in a beads repo.
    if (!/^\s*bd\s+(close|update)\b/i.test(cmd)) process.exit(0);
    if (!fs.existsSync(path.join(cwd, '.beads'))) process.exit(0);
    const parsed = parseClose(cmd);
    if (!parsed || parsed.ids.length === 0) process.exit(0);
    if (parsed.force) process.exit(0); // explicit override

    const flagged = [];
    for (const id of parsed.ids) {
      const issue = showIssue(id, cwd);
      if (!issue) continue;                            // can't read it → don't get in the way
      const type = (issue.issue_type || issue.type || '').toLowerCase();
      if (type && !GATED_TYPES.has(type)) continue;    // epic/decision/chore exempt
      if (!hasVerifyEvidence(issue, parsed.reason)) flagged.push(id);
    }

    if (flagged.length === 0) process.exit(0);

    const ids = flagged.join(', ');
    if (MODE === 'block') {
      log.warn(HOOK, `blocked close without verify evidence: ${ids}`);
      process.stderr.write(
        `BLOCKED: closing ${ids} without a recorded verify step. Per testing-tiers.md, ` +
        `record behavior-verify evidence first: \`bd update <id> --append-notes "VERIFY: <what ran + result>"\`, ` +
        `or put it in the close reason (\`--reason "... ; tests green / sandbox-verified"\`). ` +
        `Use \`bd close <id> --force\` to override, or set BRAYNEE_CLOSE_GATE=off to disable this gate.`
      );
      process.exit(2);
    }

    // Default: flag (non-blocking). PreToolUse exit-0 stdout is ignored — use
    // the additionalContext channel with a factual statement (not an imperative).
    log.info(HOOK, `flagged close without verify evidence: ${ids}`);
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext:
          `beads close-gate: ${ids} ${flagged.length > 1 ? 'are' : 'is'} being closed without a recorded ` +
          `verify step (no verify evidence in the issue notes or the close --reason). testing-tiers.md asks ` +
          `that behavior — not just logic — be verified before close. If it was verified, record it with ` +
          `\`bd update <id> --append-notes "VERIFY: <what ran + observed result>"\` before closing; if not, ` +
          `the close may be premature. (Set BRAYNEE_CLOSE_GATE=block to hard-block, or =off to silence.)`,
      },
    }));
    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0); // never break the tool call
  }
  });
}

if (require.main === module) main();

module.exports = { parseClose, hasVerifyEvidence, VERIFY_RE, GATED_TYPES };
