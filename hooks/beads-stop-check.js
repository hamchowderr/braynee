// beads-stop-check.js
// Hook: Stop — surfaces in_progress and stale beads issues before session ends.
// Never hard-blocks. Outputs text that Claude sees and can act on.
// Gates on the SESSION's working dir (anchored at SessionStart via
// lib/is-code-context.js), detected structurally — so a pure vault session
// never dumps global beads state just because a subprocess cd'd into ~/code.

const path = require('path');
const { findCodeRoot, findBeadsRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));
const { readIssues, staleOpen } = require(path.join(__dirname, 'lib', 'read-issues-jsonl.js'));

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    // Guard the parse (F-3.4 class): a malformed payload must not be the only
    // thing standing between the user and their in-progress/stale reminders.
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }

    // F-3.2a + F-3.2b: gate on the SESSION's working dir (anchored at
    // SessionStart), detected structurally — not this event's transient cwd
    // and not a hardcoded ~/code. A vault-rooted session never dumps global
    // beads state just because a subprocess cd'd into a code project.
    const codeRoot = findCodeRoot(sessionDir(data));
    if (!codeRoot) process.exit(0);
    const beadsRoot = findBeadsRoot(codeRoot); // excludes the global ~/.beads
    if (!beadsRoot) process.exit(0);
    const cwd = beadsRoot;

    const sections = [];

    // Read the repo's issues.jsonl directly (the source of truth bd auto-exports)
    // instead of querying the live Dolt server with `bd list`/`bd stale`. The
    // per-repo jsonl is inherently scoped to THIS project, so it sidesteps the
    // cp-o4g `--all` cross-project trap AND never spawns/hits dolt — safe under
    // concurrent multi-session load (cp-6j5 / dolt-guard; the same move
    // statusline-state.js already made).
    const issues = readIssues(cwd);

    // ── In-progress issues ────────────────────────────────────────────
    const inProgress = issues.filter(i => i.status === 'in_progress');
    if (inProgress.length > 0) {
      const list = inProgress.map(i => `  [${i.id}] ${i.title}`).join('\n');
      sections.push(
        `## In-Progress Beads Issues\n${list}\n\n` +
        `Close with \`bd close <id>\` or park with \`bd update <id> --status blocked\`.`
      );
    }

    // ── Stale issues (open, untouched 14+ days) ───────────────────────
    // staleOpen() approximates `bd stale` from each issue's updated_at.
    const stale = staleOpen(issues, 14).slice(0, 5);
    if (stale.length > 0) {
      const list = stale.map(i => `  [${i.id}] ${i.title}`).join('\n');
      sections.push(
        `## Stale Beads Issues (14+ days)\n${list}\n\n` +
        `Use \`bd update <id>\` to refresh or \`bd close <id>\` to close them.`
      );
    }

    if (sections.length === 0) process.exit(0);

    process.stdout.write(sections.join('\n\n'));
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
