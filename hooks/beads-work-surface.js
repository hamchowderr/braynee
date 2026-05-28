// beads-work-surface.js
// Hook: SessionStart — When the SESSION is working on a code project (detected
// structurally, not by a ~/code prefix) with `.beads/` initialized and no
// in_progress issue, surface `bd ready` results and remind Claude that
// the only valid sources of work are: (a) a claimed in_progress issue, or
// (b) a new issue the user explicitly asks for.
//
// This is the enforcement companion to the "When changing code" rule in
// `~/.claude/CLAUDE.md`. It does not block — it informs. Claude is expected to
// ask the user before invoking the beads task-agent or claiming work.

const path = require('path');
const { execSync } = require('child_process');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const { findCodeRoot, findBeadsRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

const HOOK = 'beads-work-surface';

function run(cmd, opts = {}) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, ...opts }).trim();
  } catch {
    return null;
  }
}

// Terminal banner — multi-line, visible to the user before they type.
// Width 60 to fit small terminals; truncates titles to keep lines compact.
const BANNER_WIDTH = 60;
const TITLE_MAX = 48;
function trunc(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function rule(char) { return char.repeat(BANNER_WIDTH); }
function banner(projectName, header, lines, footer) {
  const out = [];
  out.push(`── ${projectName} ${'─'.repeat(Math.max(0, BANNER_WIDTH - 4 - projectName.length))}`);
  out.push(`  ${header}`);
  if (lines.length) {
    out.push('');
    for (const ln of lines) out.push(`    ${ln}`);
  }
  if (footer) {
    out.push('');
    out.push(`  ${footer}`);
  }
  out.push(rule('─'));
  return out.join('\n') + '\n';
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }

    // F-3.2a + F-3.2b: gate on the SESSION's working dir (anchored at
    // SessionStart), detected structurally — not this event's transient cwd
    // and not a hardcoded ~/code. Keeps this SessionStart hook silent for a
    // vault-rooted session regardless of subprocess cd.
    const codeRoot = findCodeRoot(sessionDir(data));
    if (!codeRoot) process.exit(0);
    const projectName = path.basename(codeRoot);
    if (projectName.toLowerCase() === 'workspace') process.exit(0);

    const beadsRoot = findBeadsRoot(codeRoot); // excludes the global ~/.beads
    if (!beadsRoot) process.exit(0); // check-beads-init handles this case

    log.info(HOOK, `start cwd=${projectName}`);

    // Pull all open counts up front so the banner is accurate regardless of
    // which surface path we take below.
    let openCount = 0;
    const openRaw = run('bd list --status open --json', { cwd: beadsRoot });
    if (openRaw) {
      try {
        const open = JSON.parse(openRaw);
        if (Array.isArray(open)) openCount = open.length;
      } catch {}
    }

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
          // Banner visible to the user in the terminal — multi-line so they
          // can see WHAT they're working on, not just the count.
          const bannerLines = inProgress.map(i => `• [${i.id}] ${trunc(i.title, TITLE_MAX)}`);
          process.stderr.write(banner(
            projectName,
            `${inProgress.length} in progress · ${openCount} open`,
            bannerLines,
            `Resume one above, or "/braynee:recap" for full context`
          ));
          process.exit(0);
        }
      } catch {}
    }

    // Nothing in_progress — surface ready work.
    const readyRaw = run('bd ready --json --limit 5', { cwd: beadsRoot });
    let readyCount = 0;
    let readyList = null;
    let topReady = null;
    if (readyRaw) {
      try {
        const ready = JSON.parse(readyRaw);
        if (Array.isArray(ready) && ready.length > 0) {
          readyCount = ready.length;
          topReady = ready[0];
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
      // Multi-line banner showing top ready issues with priority.
      const bannerLines = JSON.parse(readyRaw).slice(0, 5).map(i =>
        `• [P${i.priority ?? '?'} ${i.id}] ${trunc(i.title, TITLE_MAX - 6)}`
      );
      process.stderr.write(banner(
        projectName,
        `0 in progress · ${readyCount} ready · ${openCount} open`,
        bannerLines,
        `Claim one with: bd update <id> --claim`
      ));
    } else {
      process.stdout.write(
        `## Beads — No Ready Work\n\n` +
        `\`${projectName}\` has no in_progress and no ready issues.\n\n` +
        `**Before changing any code:** ask the user what to work on. Once they answer, \`bd create "..."\` and \`bd update <id> --claim\`. ` +
        `Do not invent work or start coding without a claimed issue.\n`
      );
      process.stderr.write(banner(
        projectName,
        `Queue empty · ${openCount} open total`,
        [],
        `What should we work on? bd create "..." then --claim`
      ));
    }

    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    process.exit(0);
  }
});
