import { execSync } from 'child_process';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// Shared projects-root resolver: plugins/brainy/scripts/lib/. This file is at
// plugins/brainy/skills/settings-viewer/scripts/data/ → up 4 to plugin root.
const { getProjectsDir } = require(
  join(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'lib', 'projects-root.js')
);

function parseBdLine(line) {
  const statusChar = line[0];
  const status = statusChar === '○' ? 'open' : statusChar === '✓' ? 'closed' : 'cancelled';
  const idMatch       = line.match(/^[○✓×]\s+(\S+)\s/);
  const priMatch      = line.match(/\[●?\s*P(\d)\]/);
  const typeMatch     = line.match(/\[([a-z]+)\]\s+@/);
  const assigneeMatch = line.match(/@(\S+)\s+-\s/);
  const titleMatch    = line.match(/\s+-\s+(.+)$/);
  return {
    id:       idMatch?.[1]       || '',
    status,
    priority: priMatch?.[1]      || '?',
    type:     typeMatch?.[1]     || 'task',
    assignee: assigneeMatch?.[1] || '',
    title:    titleMatch?.[1]?.trim() || line,
  };
}

export async function loadBeadsStats() {
  const codeDir = getProjectsDir();
  let workspaces = 0, totalOpen = 0, assignedToMe = 0;
  const projectsData = [];

  try {
    for (const d of readdirSync(codeDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const projDir = join(codeDir, d.name);
      if (!existsSync(join(projDir, '.beads'))) continue;
      workspaces++;
      try {
        const openOut  = execSync('bd list --flat --limit 0',       { cwd: projDir, timeout: 8000 }).toString();
        const allOut   = execSync('bd list --flat --limit 0 --all', { cwd: projDir, timeout: 8000 }).toString();
        const openLines   = openOut.split('\n').filter(l => l.startsWith('○'));
        const closedLines = allOut.split('\n').filter(l => l.startsWith('✓') || l.startsWith('×'));
        if (!openLines.length && !closedLines.length) continue;

        const openIssues   = openLines.map(parseBdLine);
        const closedIssues = closedLines.map(parseBdLine);

        // Fetch full detail for open issues
        for (const issue of openIssues) {
          try {
            const showOut = execSync(`bd show ${issue.id}`, { cwd: projDir, timeout: 6000 }).toString();
            const ownerMatch   = showOut.match(/Owner:\s+(\S+)/);
            const createdMatch = showOut.match(/Created:\s+(\S+)/);
            const updatedMatch = showOut.match(/Updated:\s+(\S+)/);
            const descMatch    = showOut.match(/\nDESCRIPTION\n([\s\S]*?)(?:\n[A-Z]+\n|$)/);
            const notesMatch   = showOut.match(/\nNOTES\n([\s\S]*?)(?:\n[A-Z]+\n|$)/);
            const accMatch     = showOut.match(/\nACCEPTANCE\n([\s\S]*?)(?:\n[A-Z]+\n|$)/);
            issue.detail = {
              owner:       ownerMatch?.[1]?.trim()  || '',
              created:     createdMatch?.[1]?.trim() || '',
              updated:     updatedMatch?.[1]?.trim() || '',
              description: descMatch?.[1]?.trim()    || '',
              notes:       notesMatch?.[1]?.trim()   || '',
              acceptance:  accMatch?.[1]?.trim()     || '',
            };
          } catch { issue.detail = null; }
        }

        const myCount = openIssues.filter(i => i.assignee === 'hamchowderr').length;
        totalOpen    += openIssues.length;
        assignedToMe += myCount;
        projectsData.push({
          name: d.name,
          open: openIssues.length,
          closed: closedIssues.length,
          total: openIssues.length + closedIssues.length,
          openIssues,
          closedIssues,
          myCount,
        });
      } catch {}
    }
  } catch {}

  projectsData.sort((a, b) => b.total - a.total);
  return { workspaces, activeProjects: projectsData.length, totalOpen, assignedToMe, projectsData };
}
