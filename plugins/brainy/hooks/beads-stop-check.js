// beads-stop-check.js
// Hook: Stop — surfaces in_progress and stale beads issues before session ends.
// Never hard-blocks. Outputs text that Claude sees and can act on.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CODE_DIR = path.join(process.env.USERPROFILE || os.homedir(), 'code');

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
    const data = JSON.parse(input || '{}');
    const cwd = data.cwd || process.cwd();

    if (!cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase())) process.exit(0);
    if (!fs.existsSync(path.join(cwd, '.beads'))) process.exit(0);

    const sections = [];

    // ── In-progress issues ────────────────────────────────────────────
    const raw = run('bd list --json --all', { cwd });
    if (raw) {
      try {
        const issues = JSON.parse(raw);
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
    const staleOut = run('bd stale --days 14 --limit 5', { cwd });
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
