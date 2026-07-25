// session-stop-check.js
// Hook: Checks if vault session was properly tracked before session ends
// Matcher: "" (all stops)
// Input: JSON on stdin
// Exit 0 = allow, Exit 2 = block (stderr shown to Claude)

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const { findCodeRoot, sessionDir } = require(path.join(__dirname, 'lib', 'is-code-context.js'));

const VAULT_QUERY = path.join(__dirname, '..', 'scripts', 'vault-query.mjs');
const { getVaultRoot } = require(path.join(__dirname, '..', 'scripts', 'lib', 'vault-root.js'));
const VAULT_DIR = getVaultRoot();

// cp-7kfh: one shared, RECURSIVE lookup. This was a local copy that read only
// `1. Projects/*.md` and so missed every note nested in a project subfolder.
const { findProjectName: lookupProjectName } = require(path.join(__dirname, 'lib', 'vault-projects.js'));
function findProjectName(folderName) {
  return lookupProjectName(folderName, VAULT_DIR);
}

function run(cmd) {
  try {
    return execSync(cmd, { encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
  } catch (e) {
    return null;
  }
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

    // F-3.2a + F-3.2b: gate on the SESSION's code root (anchored at
    // SessionStart, detected structurally) — not process.cwd() / a ~/code
    // prefix. Off ~/code this previously never reminded to close the session.
    const codeRoot = findCodeRoot(sessionDir(data));
    if (!codeRoot) {
      process.exit(0);
    }
    const folderName = path.basename(codeRoot);

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
