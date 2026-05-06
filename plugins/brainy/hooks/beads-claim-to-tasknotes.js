// beads-claim-to-tasknotes.js
// Hook: PostToolUse (Bash) — when a beads issue is claimed, auto-create a matching mtn task.
// Detects: bd update <id> --claim
// Creates: mtn task with beads title, project, priority, and bd ID tag.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PRIORITY_MAP = { 0: 'critical', 1: 'high', 2: 'medium', 3: 'low', 4: 'low' };

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', c => { input += c; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    const cmd = (data.tool_input && data.tool_input.command) || '';
    const cwd = data.cwd || process.cwd();

    // Only fire on: bd update <id> --claim
    const match = cmd.match(/bd\s+update\s+([\w-]+)\s+.*--claim/);
    if (!match) process.exit(0);

    const issueId = match[1];

    // Must be in a beads project
    if (!fs.existsSync(path.join(cwd, '.beads'))) process.exit(0);

    // Project name: directory basename, Title-Cased
    const projectName = path.basename(cwd)
      .split(/[-_]/)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1))
      .join('-');

    // Get issue details from bd show
    let title = issueId;
    let priority = 'medium';
    try {
      const showOut = execSync(`bd show ${issueId}`, {
        cwd, encoding: 'utf8', timeout: 8000,
      });
      // First line: "✓ id · Title   [● P2 · STATUS]"
      const firstLine = showOut.split('\n')[0];
      const titleMatch = firstLine.match(/·\s+(.+?)\s+\[/);
      if (titleMatch) title = titleMatch[1].trim();
      const prioMatch = firstLine.match(/P(\d)/);
      if (prioMatch) priority = PRIORITY_MAP[parseInt(prioMatch[1])] || 'medium';
    } catch {}

    // Sanitize for Windows filenames (no : / \ * ? " < > |) and truncate
    const safeTitle = title
      .replace(/:/g, ' -')
      .replace(/[/\\*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);

    // Check if mtn task with this bd ID already exists
    try {
      const searchOut = execSync(`mtn search ${issueId}`, { encoding: 'utf8', timeout: 8000 });
      // "No tasks matching..." means not found; "N result(s)" means it exists
      if (/\d+ result/.test(searchOut)) process.exit(0);
    } catch {}

    // Create the mtn task
    const mtnText = `${safeTitle} +${projectName} [${priority}] #task #${issueId}`;
    execSync(`mtn create ${JSON.stringify(mtnText)}`, {
      encoding: 'utf8', timeout: 10000,
    });

    process.exit(0);
  } catch {
    process.exit(0);
  }
});
