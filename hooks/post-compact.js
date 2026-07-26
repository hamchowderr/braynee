// post-compact.js
// Hook: PostCompact — Appends the compact_summary to the active session note
// Fired AFTER compaction completes; compact_summary is the AI-generated summary
// of what was in context. This preserves it as a permanent record in the vault.
//
// Does NOT replace reinject-after-compact.ps1 — that handles context injection
// BACK into Claude. This handles writing the summary TO the vault for future reference.
// Exit 0 always — informational, no decision control on PostCompact.

const fs = require('fs');
const path = require('path');
const os = require('os');

const { findCodeRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

const { getVaultRoot } = require(path.join(__dirname, '..', 'scripts', 'lib', 'vault-root.js'));
const VAULT_DIR = getVaultRoot();
const SESSIONS_DIR = path.join(VAULT_DIR, '2. Areas', 'Sessions');

// cp-7kfh: one shared, RECURSIVE lookup. This was a local copy that read only
// `1. Projects/*.md` and so missed every note nested in a project subfolder.
const { findProjectName: lookupProjectName } = require(path.join(__dirname, 'lib', 'vault-projects.js'));
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const HOOK = 'post-compact';
function findProjectName(folderName) {
  return lookupProjectName(folderName, VAULT_DIR);
}

function findMdFiles(dir) {
  const results = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) {
        results.push(...findMdFiles(path.join(dir, entry.name)));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        results.push(path.join(dir, entry.name));
      }
    }
  } catch (e) {
    // Partial results are returned, so a failed walk silently reduces the set
    // of session notes available for post-compact recovery.
    log.debug(HOOK, `session-note walk failed under ${dir}: ${e && e.message}`);
  }
  return results;
}

function findActiveSession(projectName) {
  if (!fs.existsSync(SESSIONS_DIR)) return null;

  const projectSlug = projectName.replace(/[^a-zA-Z0-9]+/g, '-');
  const projectDir = path.join(SESSIONS_DIR, projectSlug);
  const seen = new Set();

  for (const searchDir of [projectDir, SESSIONS_DIR].filter(d => fs.existsSync(d))) {
    const files = findMdFiles(searchDir).filter(f => !seen.has(f));
    files.sort((a, b) => path.basename(b).localeCompare(path.basename(a)));

    for (const filepath of files) {
      seen.add(filepath);
      try {
        const content = fs.readFileSync(filepath, 'utf8');
        const statusMatch = content.match(/^status:\s*(\S+)/m);
        if (!statusMatch || statusMatch[1] !== 'active') continue;
        const projectMatch = content.match(/^project:\s*"?\[?\[?([^\]"\n]+)\]?\]?"?/m);
        if (!projectMatch) continue;
        if (projectMatch[1].trim().toLowerCase() === projectName.toLowerCase()) {
          return { filepath, content };
        }
      } catch { continue; }
    }
  }
  return null;
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
    const compactSummary = data.compact_summary;
    const trigger = data.trigger || 'auto';

    if (!compactSummary || !compactSummary.trim()) process.exit(0);

    // F-3.2a + F-3.2b: gate on the SESSION's code root (anchored at
    // SessionStart, detected structurally) — not a ~/code prefix on the
    // transient cwd.
    const codeRoot = findCodeRoot(sessionDir(data));
    if (!codeRoot) process.exit(0);
    const folderName = path.basename(codeRoot);
    if (folderName.toLowerCase() === 'workspace') process.exit(0);

    const projectName = findProjectName(folderName);
    if (!projectName) process.exit(0);

    const session = findActiveSession(projectName);
    if (!session) process.exit(0);

    const now = new Date().toISOString().replace('T', ' ').split('.')[0];

    // Trim summary to reasonable length (first 30 lines)
    const summaryLines = compactSummary.trim().split('\n').slice(0, 30);
    const trimmedSummary = summaryLines.join('\n') +
      (compactSummary.trim().split('\n').length > 30 ? '\n*(truncated)*' : '');

    const compactionBlock =
      `\n#### Compaction record (${trigger}, ${now})\n` +
      `${trimmedSummary}\n`;

    let content = session.content;

    // Append to ## Progress section if it exists
    const progressRegex = /(## Progress\s*\n)([\s\S]*?)(?=\n## |\n$)/;
    if (progressRegex.test(content)) {
      content = content.replace(progressRegex, `$1$2${compactionBlock}`);
    } else {
      // Append at end
      content = content.trimEnd() + '\n\n## Progress\n' + compactionBlock;
    }

    fs.writeFileSync(session.filepath, content, 'utf-8');
    process.exit(0);
  } catch {
    process.exit(0);
  }
});
