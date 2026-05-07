// check-git-init.js
// Hook: SessionStart — Ensures git is initialized for any code project.
// Mirror of check-beads-init.js: if .git/ is missing, runs `git init` automatically
// with a clear explanation. Skipped if cwd is outside ~/code or is the workspace root.
// Exit 0 always (non-blocking).

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'check-git-init';
const CODE_DIR = path.join(os.homedir(), 'code');

function findGitAncestor(startDir) {
  let dir = startDir;
  const root = path.parse(dir).root;
  while (dir !== root) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function tryGitInit(cwd) {
  try {
    execSync('git init -b main', { cwd, encoding: 'utf8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.stderr?.toString() || err.message };
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = input ? JSON.parse(input) : {};
    const cwd = data.cwd || process.cwd();
    if (!cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase())) process.exit(0);
    const projectName = path.basename(cwd);
    if (projectName.toLowerCase() === 'workspace') process.exit(0);

    if (findGitAncestor(cwd)) {
      log.info(HOOK, `git already initialized — nothing to do`);
      process.exit(0);
    }

    log.warn(HOOK, `no .git/ found in ${projectName} — running git init`);
    process.stdout.write(
      `# Git Auto-Initializing\n\n` +
      `\`${projectName}\` does not have git initialized. Brainy is running:\n\n` +
      `\`\`\`\ngit init -b main\n\`\`\`\n\n`
    );

    const result = tryGitInit(cwd);
    if (result.ok) {
      log.info(HOOK, `git init succeeded for ${projectName}`);
      process.stdout.write(
        `**Done.** Git initialized in \`${projectName}\` on branch \`main\`. ` +
        `Brainy will block pushes to main/master, so use feature branches (\`feature/*\`, \`fix/*\`) for work.\n`
      );
    } else {
      log.error(HOOK, `git init failed: ${result.error?.split('\n')[0] || 'unknown'}`);
      process.stdout.write(`**git init failed.** Run manually: \`git init -b main\`\n\nError: \`${(result.error || '').split('\n')[0]}\`\n`);
    }
    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
