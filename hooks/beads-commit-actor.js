// beads-commit-actor.js
// Hook: SessionStart — give Claude's shell the identity bd's git hook signs
// commits with, so agent commits carry an `Executed-By:` trailer (cp-uif3.5).
//
// bd's prepare-commit-msg hook (`bd hooks run prepare-commit-msg`, installed by
// `bd hooks install`) appends `Executed-By: <actor>` to a commit message, but
// ONLY when the BD_ACTOR environment variable is set. It reads BD_ACTOR and
// nothing else — not BEADS_ACTOR, not `--actor`, not git config. Verified in
// beads source (cmd/bd/hooks.go, runPrepareCommitMsgHook) and live on bd 1.3.4:
// with the hook installed, `BEADS_ACTOR=claude git commit` adds no trailer and
// `BD_ACTOR=claude git commit` does. The issue text said "set BEADS_ACTOR";
// that is the audit-trail variable, and it never reaches the commit.
//
// So this hook appends `export BD_ACTOR=claude` to $CLAUDE_ENV_FILE, which
// Claude Code sources before every Bash command it runs. Chosen over rewriting
// `git commit` into `BD_ACTOR=claude git commit` for the same reason
// bd-actor.js uses `--actor`: an env prefix stops `Bash(git commit *)` allow
// rules from matching. The owner's own terminal never sees the variable, so
// their commits stay unsigned, which is correct.
//
// bd also reads BD_ACTOR as a (deprecated) fallback for its audit-trail actor,
// below BEADS_ACTOR and `--actor`. That resolves to the same `claude` that
// beads-actor-sign.js writes, and a subagent's explicit `--actor
// claude/<type>` still wins.
//
// Never overrides an actor the user already set (BD_ACTOR or BEADS_ACTOR in the
// environment), and never writes the line twice (SessionStart also fires on
// resume, clear and compact). Claude Code only: other hosts have no env file.
// No output: there is nothing the model needs to read.

'use strict';

const fs = require('fs');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const payload = require(path.join(__dirname, 'lib', 'hook-payload.js'));

const HOOK = 'beads-commit-actor';
const ACTOR = 'claude';
const LINE = `export BD_ACTOR=${ACTOR}`;

/** What to do for this environment: 'skip:<reason>' or 'write'. Pure, for tests. */
function decide(env, existing) {
  if (!env.CLAUDE_ENV_FILE) return 'skip:no-env-file';
  if (env.BD_ACTOR || env.BEADS_ACTOR) return 'skip:actor-already-set';
  if (/^\s*export\s+BD_ACTOR=/m.test(existing || '')) return 'skip:already-written';
  return 'write';
}

async function main() {
  const p = await payload.read();
  if (p.host !== 'claude-code') return;
  const file = process.env.CLAUDE_ENV_FILE;
  let existing = '';
  try { existing = file ? fs.readFileSync(file, 'utf8') : ''; } catch { existing = ''; }
  const verdict = decide(process.env, existing);
  if (verdict !== 'write') { log.info(HOOK, verdict); return; }
  const sep = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${sep}${LINE}\n`);
  log.info(HOOK, `wrote ${LINE}`);
}

if (require.main === module) {
  main().catch((e) => { try { log.warn(HOOK, String(e && e.message || e)); } catch { /* logging the failure failed too; a SessionStart hook must still exit 0 */ } })
    .finally(() => process.exit(0));
}

module.exports = { decide, LINE };
