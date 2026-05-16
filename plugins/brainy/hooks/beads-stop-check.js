// beads-stop-check.js
// Hook: Stop — surfaces in_progress and stale beads issues before session ends.
// Never hard-blocks. Outputs text that Claude sees and can act on.
// Gates on the SESSION's working dir (anchored at SessionStart via
// lib/is-code-context.js), detected structurally — so a pure vault session
// never dumps global beads state just because a subprocess cd'd into ~/code.

const { execSync } = require('child_process');
const path = require('path');
const { findCodeRoot, findBeadsRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'], ...opts }).trim();
  } catch { return null; }
}

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

    // ── In-progress issues ────────────────────────────────────────────
    // cp-o4g: NEVER use `--all`. On the shared Dolt server `--all` overrides
    // the default per-repo filter and spans EVERY project's namespace, so the
    // Stop hook would surface unrelated projects' issues. `bd list` without
    // `--all`, run with cwd=beadsRoot, auto-discovers THIS repo's .beads/ and
    // is scoped to its namespace only. We further constrain to in_progress
    // (the only status this section cares about) so closed issues from any
    // project can never leak in regardless of server-side filter behavior.
    const raw = run('bd list --json --status in_progress', { cwd });
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const issues = Array.isArray(parsed) ? parsed : [];
        const inProgress = issues.filter(i => i.status === 'in_progress');
        if (inProgress.length > 0) {
          const list = inProgress.map(i => `  [${i.id}] ${i.title}`).join('\n');
          sections.push(
            `## In-Progress Beads Issues\n${list}\n\n` +
            `Close with \`bd close <id>\` or park with \`bd update <id> --status blocked\`.`
          );
        }
      } catch {}
    }

    // ── Stale issues ──────────────────────────────────────────────────
    // cp-o4g: `bd stale` has no `--all`; run with cwd=beadsRoot it
    // auto-discovers THIS repo's .beads/ and is scoped to its namespace.
    // Constrain to open issues so a stale closed/parked issue from another
    // project can't surface even if server-side scoping ever changes.
    const staleOut = run('bd stale --days 14 --limit 5 --status open', { cwd });
    if (staleOut && staleOut.includes('stale') && !staleOut.includes('No stale')) {
      sections.push(
        `## Stale Beads Issues (14+ days)\n\n${staleOut.trim()}\n\n` +
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
