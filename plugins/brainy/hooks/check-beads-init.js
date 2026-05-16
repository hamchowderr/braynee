// check-beads-init.js
// Hook: SessionStart — Ensures Beads is installed and initialized for any code project.
// Runs three checks in order:
//   1. Is `bd` on PATH? If not, prompt Claude to ask the user before installing.
//   2. Is the `beads` plugin installed? If not, prompt Claude to offer the slash command.
//   3. Is `.beads/` present? If not, run `bd init` automatically.
//
// Output goes to stdout → injected into Claude's context so Claude can act on it
// (asking the user, running an install with permission, etc.). Never hard-blocks.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { findCodeRoot, findBeadsRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

const HOOK = 'check-beads-init';
const PLUGINS_CACHE = path.join(os.homedir(), '.claude', 'plugins', 'cache');

function isBdOnPath() {
  try {
    execSync('bd --version', { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] });
    return true;
  } catch {
    return false;
  }
}

function isBeadsPluginInstalled() {
  if (!fs.existsSync(PLUGINS_CACHE)) return false;
  try {
    for (const marketplace of fs.readdirSync(PLUGINS_CACHE, { withFileTypes: true })) {
      if (!marketplace.isDirectory()) continue;
      const beadsDir = path.join(PLUGINS_CACHE, marketplace.name, 'beads');
      if (fs.existsSync(beadsDir)) return true;
    }
  } catch {}
  return false;
}


function tryBdInit(cwd, projectName) {
  // --shared-server + --external is the canonical pair: the shared Dolt
  // server is a user-machine singleton managed outside bd's per-project
  // lifecycle. Without --external, bd may try to start a second server on
  // the already-bound port and fail (especially on Windows, where the
  // process-detection probe is non-deterministic).
  // --skip-agents and --skip-hooks keep init non-interactive and minimal —
  // we install our own integration via brainy hooks elsewhere.
  // --non-interactive avoids stdin prompts when bd runs under the hook.
  const cmd = `bd init --shared-server --external -p "${projectName}" --skip-agents --skip-hooks --non-interactive`;
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
    let data = {};
    if (input) {
      try {
        data = JSON.parse(input);
      } catch (parseErr) {
        log.warn(HOOK, `unparseable stdin, using empty payload: ${parseErr.message}`);
        data = {};
      }
    }
    // F-3.2a + F-3.2b: gate on the SESSION's working dir (anchored at
    // SessionStart), detected structurally — not this event's transient cwd
    // and not a hardcoded ~/code prefix (brainy is universal — most users have
    // no ~/code). A vault-rooted session must not auto-init beads or nag about
    // the bd CLI just because a subprocess cd'd into a code project. The
    // detected root is also the correct project-name source.
    const codeRoot = findCodeRoot(sessionDir(data));
    if (!codeRoot) {
      process.exit(0);
    }
    const projectName = path.basename(codeRoot);
    if (projectName.toLowerCase() === 'workspace') {
      process.exit(0);
    }

    log.info(HOOK, `start cwd=${projectName}`);

    // Step 1: bd CLI present?
    if (!isBdOnPath()) {
      log.warn(HOOK, `bd not on PATH`);
      process.stdout.write(
        `# Beads CLI Missing\n\n` +
        `The \`bd\` CLI is not installed, but Beads is mandatory for all code projects.\n\n` +
        `**Ask the user once:** "Install \`bd\` now? (Y/n)"\n\n` +
        `On yes, run the platform-appropriate install:\n` +
        `- Windows (PowerShell): \`irm https://raw.githubusercontent.com/gastownhall/beads/main/install.ps1 | iex\`\n` +
        `- npm (cross-platform): \`npm install -g @beads/bd\`\n\n` +
        `Also recommend installing the official slash-command plugin: \`/plugin install beads@beads-marketplace\`\n\n` +
        `After install, this session needs no further action — the next session will pick up Beads automatically.\n`
      );
      process.exit(0);
    }

    // Step 2: beads plugin present? (recommended, not required)
    if (!isBeadsPluginInstalled()) {
      log.info(HOOK, `bd present but beads plugin not installed — recommending`);
      process.stdout.write(
        `# Beads Plugin Recommendation\n\n` +
        `\`bd\` CLI is installed but the official \`beads\` Claude Code plugin is not. ` +
        `It provides slash commands (\`/ready\`, \`/create\`, \`/show\`), the canonical \`beads\` skill, and the autonomous \`task-agent\`.\n\n` +
        `**Ask the user once:** "Install the beads plugin? (Y/n)" — on yes, run \`/plugin install beads@beads-marketplace\`.\n\n`
      );
      // Continue — plugin is optional, init still proceeds.
    }

    // Excludes the global ~/.beads (`bd init --shared-server`) so a project
    // without its own .beads/ still auto-inits instead of being mistaken for
    // already-initialized.
    if (findBeadsRoot(codeRoot)) {
      log.info(HOOK, `beads already initialized — nothing to do`);
      process.exit(0);
    }

    // Step 3: No .beads/ found. Try to auto-init.
    log.warn(HOOK, `no .beads/ found in ${projectName} — running bd init`);
    process.stdout.write(
      `# Beads Auto-Initializing\n\n` +
      `Beads issue tracking is mandatory for all code projects, but \`${projectName}\` ` +
      `did not have it initialized. brainy is running:\n\n` +
      `\`\`\`\n` +
      `bd init --shared-server --external -p "${projectName}" --skip-agents --skip-hooks --non-interactive\n` +
      `\`\`\`\n\n`
    );

    const result = tryBdInit(codeRoot, projectName);
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
