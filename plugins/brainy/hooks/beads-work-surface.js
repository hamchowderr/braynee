// beads-work-surface.js
// Hook: SessionStart — When in a `~/code/*` project with `.beads/` initialized
// and no in_progress issue, surface `bd ready` results and remind Claude that
// the only valid sources of work are: (a) a claimed in_progress issue, or
// (b) a new issue the user explicitly asks for.
//
// This is the enforcement companion to the "When changing code" rule in
// `~/.claude/CLAUDE.md`. It does not block — it informs. Claude is expected to
// ask the user before invoking the beads task-agent or claiming work.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'beads-work-surface';
const CODE_DIR = path.join(os.homedir(), 'code');

function findBeadsAncestor(startDir) {
  let dir = startDir;
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.beads'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
  } catch {
    return null;
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = input ? JSON.parse(input) : {};
    const cwd = data.cwd || process.cwd();

    if (!cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase())) process.exit(0);
    const projectName = path.basename(cwd);
    if (projectName.toLowerCase() === 'workspace') process.exit(0);

    const beadsRoot = findBeadsAncestor(cwd);
    if (!beadsRoot) process.exit(0); // check-beads-init handles this case

    log.info(HOOK, `start cwd=${projectName}`);

    // In-progress check first — if something is claimed, no surface needed.
    const inProgressRaw = run('bd list --status in_progress --json', { cwd: beadsRoot });
    if (inProgressRaw) {
      try {
        const inProgress = JSON.parse(inProgressRaw);
        if (Array.isArray(inProgress) && inProgress.length > 0) {
          const list = inProgress.map(i => `  [${i.id}] ${i.title}`).join('\n');
          process.stdout.write(
            `## Beads — In-Progress\n\n` +
            `You have ${inProgress.length} claimed issue${inProgress.length === 1 ? '' : 's'} in \`${projectName}\`:\n\n` +
            list + `\n\n` +
            `Resume work on the most relevant one. Use \`bd show <id>\` for full context.\n`
          );
          process.exit(0);
        }
      } catch {}
    }

    // Nothing in_progress — surface ready work.
    const readyRaw = run('bd ready --json --limit 5', { cwd: beadsRoot });
    let readyList = null;
    if (readyRaw) {
      try {
        const ready = JSON.parse(readyRaw);
        if (Array.isArray(ready) && ready.length > 0) {
          readyList = ready
            .map(i => `  [${i.id}] (P${i.priority ?? '?'}) ${i.title}`)
            .join('\n');
        }
      } catch {}
    }

    if (readyList) {
      process.stdout.write(
        `## Beads — No Claimed Work\n\n` +
        `No in_progress issue in \`${projectName}\`. Ready (unblocked) work:\n\n` +
        readyList + `\n\n` +
        `**Before changing any code:** ask the user which to claim, or offer to invoke the beads \`task-agent\` to autonomously work the queue. ` +
        `Claim atomically with \`bd update <id> --claim\`. Do not start coding without a claimed issue.\n`
      );
    } else {
      process.stdout.write(
        `## Beads — No Ready Work\n\n` +
        `\`${projectName}\` has no in_progress and no ready issues.\n\n` +
        `**Before changing any code:** ask the user what to work on. Once they answer, \`bd create "..."\` and \`bd update <id> --claim\`. ` +
        `Do not invent work or start coding without a claimed issue.\n`
      );
    }

    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
