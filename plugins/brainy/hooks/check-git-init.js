// check-git-init.js
// Hook: SessionStart — Ensures git is initialized for any code project.
// Mirror of check-beads-init.js: if .git/ is missing, runs `git init`
// automatically with a clear explanation. Acts only when the SESSION is a
// code context (detected structurally, not a ~/code prefix) and not the
// workspace root. Exit 0 always (non-blocking).

const path = require('path');
const { execSync } = require('child_process');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { findCodeRoot, findGitRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

const HOOK = 'check-git-init';

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
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }

    // F-3.2a + F-3.2b: act only in a code context, detected structurally on
    // the SESSION's working dir — not a ~/code prefix on the transient cwd.
    const codeRoot = findCodeRoot(sessionDir(data));
    if (!codeRoot) process.exit(0);
    const projectName = path.basename(codeRoot);
    if (projectName.toLowerCase() === 'workspace') process.exit(0);

    // findGitRoot excludes a dotfiles ~/.git so a project without its own
    // repo still auto-inits instead of looking already-initialized.
    if (findGitRoot(codeRoot)) {
      log.info(HOOK, `git already initialized — nothing to do`);
      process.exit(0);
    }
    const cwd = codeRoot;

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
