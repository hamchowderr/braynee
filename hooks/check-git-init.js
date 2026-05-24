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

// Mirror of check-beads-init.js isBdOnPath(): probe the tool's presence
// BEFORE attempting any operation. When git is absent, `git init` throws
// ENOENT / "'git' is not recognized" and the hook would surface a confusing
// ERROR instead of actionable install guidance (cp-h5a / R-1).
function isGitOnPath() {
  try {
    execSync('git --version', { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

function tryGitInit(cwd) {
  try {
    execSync('git init -b main', { cwd, encoding: 'utf8', timeout: 10_000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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

    // cp-h5a / R-1: git is a hard Braynee dependency. Probe its presence FIRST
    // (mirror of check-beads-init.js Step 1). If git is missing, emit
    // cross-platform install guidance and exit 0 cleanly — never attempt
    // `git init` (which would throw ENOENT and surface a confusing hook error
    // instead of the actionable "install git" message).
    if (!isGitOnPath()) {
      log.warn(HOOK, `git not on PATH — emitting install guidance, skipping init`);
      process.stdout.write(
        `# Git Not Installed\n\n` +
        `\`git\` is not on PATH, but git is a required Braynee dependency ` +
        `(\`${projectName}\` needs version control; Braynee also drives vault backup and push protection).\n\n` +
        `**Ask the user once:** "Install \`git\` now? (Y/n)"\n\n` +
        `On yes, run the platform-appropriate install:\n` +
        `- Windows (PowerShell): \`winget install --id Git.Git -e\`\n` +
        `- macOS (Homebrew): \`brew install git\`\n` +
        `- Debian/Ubuntu: \`sudo apt-get update && sudo apt-get install -y git\`\n` +
        `- Fedora/RHEL: \`sudo dnf install -y git\`\n\n` +
        `After install, this session needs no further action — the next session will initialize git automatically.\n`
      );
      process.exit(0);
    }

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
      `\`${projectName}\` does not have git initialized. Braynee is running:\n\n` +
      `\`\`\`\ngit init -b main\n\`\`\`\n\n`
    );

    const result = tryGitInit(cwd);
    if (result.ok) {
      log.info(HOOK, `git init succeeded for ${projectName}`);
      process.stdout.write(
        `**Done.** Git initialized in \`${projectName}\` on branch \`main\`. ` +
        `Braynee will block pushes to main/master, so use feature branches (\`feature/*\`, \`fix/*\`) for work.\n`
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
