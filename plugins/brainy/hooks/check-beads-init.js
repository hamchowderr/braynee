// check-beads-init.js
// Hook: SessionStart — Ensures Beads is initialized for any code project.
// If .beads/ is missing, runs `bd init` automatically with a clear explanation
// of what's happening. Beads is mandatory for all code projects; this hook
// removes the manual step.
//
// Output goes to stdout → injected into Claude's context so the user sees
// what was done. Never hard-blocks (exit 0 always); init failures fall back
// to the prior warn-and-instruct behavior.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'check-beads-init';
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

function tryBdInit(cwd, projectName) {
  // Use --shared-server to avoid port conflicts when many projects are open.
  // --skip-agents and --skip-hooks keep init non-interactive and minimal —
  // we install our own integration via brainy hooks elsewhere.
  const cmd = `bd init --shared-server -p "${projectName}" --skip-agents --skip-hooks`;
  try {
    execSync(cmd, {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { ok: true, cmd };
  } catch (err) {
    return { ok: false, cmd, error: err.stderr?.toString() || err.message };
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = input ? JSON.parse(input) : {};
    const cwd = data.cwd || process.cwd();

    if (!cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase())) {
      process.exit(0);
    }
    const projectName = path.basename(cwd);
    if (projectName.toLowerCase() === 'workspace') {
      process.exit(0);
    }

    log.info(HOOK, `start cwd=${projectName}`);

    if (findBeadsAncestor(cwd)) {
      log.info(HOOK, `beads already initialized — nothing to do`);
      process.exit(0);
    }

    // No .beads/ found. Try to auto-init.
    log.warn(HOOK, `no .beads/ found in ${projectName} — running bd init`);
    process.stdout.write(
      `# Beads Auto-Initializing\n\n` +
      `Beads issue tracking is mandatory for all code projects, but \`${projectName}\` ` +
      `did not have it initialized. brainy is running:\n\n` +
      `\`\`\`\n` +
      `bd init --shared-server -p "${projectName}" --skip-agents --skip-hooks\n` +
      `\`\`\`\n\n`
    );

    const result = tryBdInit(cwd, projectName);
    if (result.ok) {
      log.info(HOOK, `bd init succeeded for ${projectName}`);
      process.stdout.write(
        `**Done.** Beads is now initialized in \`${projectName}\`. ` +
        `Use \`bd create\`, \`bd list\`, \`bd update <id> --status in_progress\` to track work. ` +
        `Brainy hooks will sync bd status changes to TaskNotes and the project session note automatically.\n`
      );
    } else {
      log.error(HOOK, `bd init failed: ${result.error?.split('\n')[0] || 'unknown'}`);
      process.stdout.write(
        `**bd init failed** — likely because the bd CLI isn't on PATH or the shared server is unreachable.\n\n` +
        `Manually run: \`${result.cmd}\`\n\n` +
        `Error: \`${(result.error || '').split('\n')[0]}\`\n`
      );
    }

    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
