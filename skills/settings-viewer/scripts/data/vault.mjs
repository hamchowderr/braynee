import { execSync } from 'child_process';
import { readFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getVaultRoot } = require(
  join(import.meta.dirname, '..', '..', '..', '..', 'scripts', 'lib', 'vault-root.js')
);

export async function loadVaultStats() {
  const home = homedir();
  const vaultRoot = getVaultRoot();
  const tempDir = join(home, '.claude', 'temp');
  mkdirSync(tempDir, { recursive: true });
  const tempPath = join(tempDir, 'vault-stats.json').replace(/\\/g, '/');

  try {
    // Fetch vault stats via Obsidian's in-app API (requires Obsidian to be running).
    // Counts inbox, sessions, TaskNotes, and the four PARA buckets in one pass.
    const jsCode = [
      `(async () => {`,
      `  const {writeFileSync} = require('fs');`,
      `  const files = app.vault.getFiles().filter(f => f.extension === 'md');`,
      `  const sw = p => files.filter(f => f.path.startsWith(p)).length;`,
      `  writeFileSync('${tempPath}', JSON.stringify({`,
      `    inboxCount: sw('Inbox/'),`,
      `    sessionCount: sw('2. Areas/Sessions/'),`,
      `    taskCount: sw('2. Areas/TaskNotes/Tasks/'),`,
      `    para: { projects: sw('1. Projects/'), areas: sw('2. Areas/'), resources: sw('3. Resources/'), archives: sw('4. Archives/') },`,
      `  }));`,
      `})()`,
    ].join(' ').replace(/'/g, "\\'");
    execSync(`obsidian eval code="${jsCode}"`, { timeout: 10000, windowsHide: true });
    const data = JSON.parse(readFileSync(tempPath, 'utf8'));
    return {
      inboxCount: data.inboxCount || 0,
      sessionCount: data.sessionCount || 0,
      taskCount: data.taskCount || 0,
      para: data.para || { projects: 0, areas: 0, resources: 0, archives: 0 },
      vaultPath: vaultRoot,
    };
  } catch {
    // Fallback: direct filesystem reads if Obsidian is not running (cp-dgu.2: the
    // dashboard must surface tasks + folder counts even with Obsidian closed).
    const { readdirSync } = await import('fs');
    const vaultPath = vaultRoot;

    const countDir = (p) => {
      try { return readdirSync(p, { withFileTypes: true }).filter(f => f.isFile() && f.name.endsWith('.md')).length; }
      catch { return 0; }
    };
    const countMdRec = (dir, depth = 0) => {
      if (depth > 6) return 0;
      let n = 0, ents = [];
      try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
      for (const e of ents) {
        if (e.isFile() && e.name.endsWith('.md')) n++;
        else if (e.isDirectory()) n += countMdRec(join(dir, e.name), depth + 1);
      }
      return n;
    };

    const inboxCount = countDir(join(vaultPath, 'Inbox'));
    let sessionCount = 0;
    try {
      const sessDir = join(vaultPath, '2. Areas', 'Sessions');
      for (const d of readdirSync(sessDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        sessionCount += countDir(join(sessDir, d.name));
      }
      sessionCount += countDir(sessDir); // sessions filed directly under Sessions/
    } catch {}
    const taskCount = countDir(join(vaultPath, '2. Areas', 'TaskNotes', 'Tasks'));
    const para = {
      projects: countMdRec(join(vaultPath, '1. Projects')),
      areas: countMdRec(join(vaultPath, '2. Areas')),
      resources: countMdRec(join(vaultPath, '3. Resources')),
      archives: countMdRec(join(vaultPath, '4. Archives')),
    };
    return { inboxCount, sessionCount, taskCount, para, vaultPath };
  }
}
