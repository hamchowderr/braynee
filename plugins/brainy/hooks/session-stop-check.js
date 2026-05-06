// session-stop-check.js
// Hook: Checks if vault session was properly tracked before session ends
// Matcher: "" (all stops)
// Input: JSON on stdin
// Exit 0 = allow, Exit 2 = block (stderr shown to Claude)

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const VAULT_QUERY = path.join(process.env.USERPROFILE, '.claude', 'scripts', 'vault-query.mjs');
const VAULT_DIR = path.join(process.env.USERPROFILE, 'Obsidian Vault');
const CODE_DIR = path.join(process.env.USERPROFILE, 'code');

function findProjectName(folderName) {
  const projectsDir = path.join(VAULT_DIR, '1. Projects');
  if (!fs.existsSync(projectsDir)) return null;

  const files = fs.readdirSync(projectsDir).filter(f => f.endsWith('.md'));
  for (const file of files) {
    try {
      const content = fs.readFileSync(path.join(projectsDir, file), 'utf8');
      const folderMatch = content.match(/^folder:\s*"?([^"\n]+)"?$/m);
      if (folderMatch && folderMatch[1].trim().toLowerCase() === folderName.toLowerCase()) {
        const nameMatch = content.match(/^name:\s*"?([^"\n]+)"?$/m);
        if (nameMatch) return nameMatch[1].trim();
        return file.replace('.md', '');
      }
    } catch (e) {
      continue;
    }
  }
  return null;
}

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000 }).trim();
  } catch (e) {
    return null;
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const cwd = process.cwd();
    const folderName = path.basename(cwd);
    const isInCodeDir = cwd.toLowerCase().startsWith(CODE_DIR.toLowerCase());

    if (!isInCodeDir) {
      process.exit(0);
    }

    // Determine project name
    let projectName;
    if (folderName.toLowerCase() === 'workspace') {
      projectName = 'Workspace';
    } else {
      projectName = findProjectName(folderName);
    }

    if (!projectName) {
      process.exit(0);
    }

    // Check if there's an active session for this project
    const sessions = run(`node "${VAULT_QUERY}" session list --status active`);
    const hasActiveSession = sessions && sessions.toLowerCase().includes(projectName.toLowerCase());

    if (!hasActiveSession) {
      // No active session was ever created — warn but don't block
      process.stderr.write(
        `WARNING: No active vault session found for "${projectName}". ` +
        `Session context was not tracked. Consider creating a session next time with:\n` +
        `  vault-query.mjs session start --project "${projectName}" --goal "..." --type code`
      );
      // Exit 0 — warn but don't block the stop
      process.exit(0);
    }

    // Session exists — remind to close it with a summary
    process.stderr.write(
      `REMINDER: Active vault session exists for "${projectName}". ` +
      `Before ending, update the session note with progress and close it:\n` +
      `  vault-query.mjs session close --summary "..."`
    );
    process.exit(0);
  } catch (e) {
    process.exit(0);
  }
});
