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
  //
  // --skip-agents: bd init's default agent-doc generation writes AGENTS.md,
  // CLAUDE.md AND .claude/settings.json. The CLAUDE.md / settings.json writes
  // would clobber a real project's own files (settings.json carries the
  // project's Claude Code config; CLAUDE.md its agent context). We keep this
  // skip and instead write a minimal AGENTS.md ourselves below, only when the
  // project has no agent doc at all (see finishBdSetup) — never overwriting.
  //
  // --skip-hooks: bd init's hook step is interactive-ish and we want a single
  // explicit, idempotent install. We run `bd hooks install` separately below.
  // NOTE: bd's *git* hooks (pre-commit/post-merge/pre-push/post-checkout/
  // prepare-commit-msg, installed into .git/hooks/) only keep
  // .beads/issues.jsonl in sync with the Dolt DB. They are completely
  // distinct from braynee's Claude-Code *event* hooks (SessionStart,
  // PreCompact, etc., wired via the plugin's hooks.json) — different
  // mechanism, different files, no conflict. Skipping bd's git hooks at
  // init time was the ROOT CAUSE of the recurring .beads/issues.jsonl
  // merge conflicts on PRs, so we now install them right after.
  //
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

// Run after a successful `bd init` to leave the project CLEAN in `bd doctor`:
//   1. `bd hooks install` — installs bd's git hooks (.git/hooks/) that keep
//      .beads/issues.jsonl synced. Idempotent: bd uses section markers and a
//      re-run just rewrites its own block, preserving any user hook content.
//   2. Minimal AGENTS.md — ONLY when the project has neither AGENTS.md nor
//      CLAUDE.md (bd doctor accepts either). Never overwrites an existing one,
//      so a project's own agent doc is left untouched.
//   3. `bd vc commit` — commits the freshly-written bd Dolt config so the
//      project doesn't come up with an uncommitted "config: modified" change.
//      "Nothing to commit" (exit 0) on a re-run, so it's a safe no-op.
// Every step is best-effort and guarded: a failure in one never aborts the
// others or the hook. Re-running on an already-set-up project is a clean
// no-op (the SessionStart guard normally prevents re-entry anyway).
function finishBdSetup(cwd) {
  const steps = [];

  // 1. git hooks (.git/hooks/) — only meaningful inside a git repo.
  if (fs.existsSync(path.join(cwd, '.git'))) {
    try {
      execSync('bd hooks install', {
        cwd,
        encoding: 'utf8',
        timeout: 20_000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      steps.push({ step: 'git-hooks', ok: true });
    } catch (err) {
      steps.push({ step: 'git-hooks', ok: false, error: err.stderr?.toString() || err.message });
    }
  }

  // 2. Agent doc — write a minimal AGENTS.md only if NOTHING exists yet.
  try {
    const hasAgents = fs.existsSync(path.join(cwd, 'AGENTS.md'));
    const hasClaude = fs.existsSync(path.join(cwd, 'CLAUDE.md'));
    if (!hasAgents && !hasClaude) {
      const doc =
        '## Issue Tracking\n\n' +
        'This project uses **bd (beads)** for issue tracking.\n' +
        'Run `bd prime` for full workflow context, or install hooks ' +
        '(`bd hooks install`) for auto-injection.\n\n' +
        '**Quick reference:**\n' +
        '- `bd ready` — Find unblocked work\n' +
        '- `bd create "Title" --type task --priority 2` — Create issue\n' +
        '- `bd update <id> --claim` — Claim work atomically\n' +
        '- `bd close <id>` — Complete work\n' +
        '- `bd dolt push` — Push beads data to remote\n\n' +
        'For full workflow details: `bd prime`\n';
      fs.writeFileSync(path.join(cwd, 'AGENTS.md'), doc, 'utf8');
      steps.push({ step: 'agents-md', ok: true, wrote: true });
    } else {
      steps.push({ step: 'agents-md', ok: true, wrote: false });
    }
  } catch (err) {
    steps.push({ step: 'agents-md', ok: false, error: err.message });
  }

  // 3. Commit the bd Dolt config so the project isn't left "config: modified".
  try {
    execSync('bd vc commit -m "braynee auto-init: commit initial bd config"', {
      cwd,
      encoding: 'utf8',
      timeout: 20_000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    steps.push({ step: 'vc-commit', ok: true });
  } catch (err) {
    // "Nothing to commit" exits 0, so a non-zero here is a real failure.
    steps.push({ step: 'vc-commit', ok: false, error: err.stderr?.toString() || err.message });
  }

  return steps;
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
    // and not a hardcoded ~/code prefix (braynee is universal — most users have
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
      `did not have it initialized. braynee is running:\n\n` +
      `\`\`\`\n` +
      `bd init --shared-server --external -p "${projectName}" --skip-agents --skip-hooks --non-interactive\n` +
      `bd hooks install            # git hooks that keep .beads/issues.jsonl synced\n` +
      `bd vc commit -m "..."       # commit the initial bd config\n` +
      `\`\`\`\n\n`
    );

    const result = tryBdInit(codeRoot, projectName);
    if (result.ok) {
      log.info(HOOK, `bd init succeeded for ${projectName}`);
      // Leave the project CLEAN in `bd doctor`: install bd's git hooks,
      // ensure an agent doc exists, and commit the initial bd config.
      const finish = finishBdSetup(codeRoot);
      for (const s of finish) {
        if (s.ok) log.info(HOOK, `finishBdSetup ${s.step}: ok${s.wrote === false ? ' (skipped, doc exists)' : ''}`);
        else log.warn(HOOK, `finishBdSetup ${s.step} failed: ${(s.error || '').split('\n')[0]}`);
      }
      process.stdout.write(
        `**Done.** Beads is now initialized in \`${projectName}\`. ` +
        `Braynee also installed bd's git hooks (keep \`.beads/issues.jsonl\` synced, ` +
        `preventing merge conflicts on PRs), ensured an agent doc exists, and committed ` +
        `the initial bd config — the project comes up clean in \`bd doctor\`.\n\n` +
        `Use \`bd create\`, \`bd list\`, \`bd update <id> --status in_progress\` to track work. ` +
        `Braynee hooks will sync bd status changes to TaskNotes and the project session note automatically.\n`
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
