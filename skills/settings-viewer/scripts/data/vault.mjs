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
    // Fetch vault stats via Obsidian's in-app API (requires Obsidian to be running)
    // Uses require('fs') which is available in Obsidian's Electron context
    const jsCode = [
      `(async () => {`,
      `  const {writeFileSync} = require('fs');`,
      `  const inbox = app.vault.getFiles().filter(f => f.path.startsWith('Inbox/') && f.extension === 'md').length;`,
      `  const sessions = app.vault.getFiles().filter(f => f.path.startsWith('2. Areas/Sessions/') && f.extension === 'md').length;`,
      `  writeFileSync('${tempPath}', JSON.stringify({inboxCount: inbox, sessionCount: sessions}));`,
      `})()`,
    ].join(' ').replace(/'/g, "\\'");
    execSync(`obsidian eval code="${jsCode}"`, { shell: true, timeout: 10000 });
    const data = JSON.parse(readFileSync(tempPath, 'utf8'));
    return { inboxCount: data.inboxCount || 0, sessionCount: data.sessionCount || 0, vaultPath: vaultRoot };
  } catch {
    // Fallback: direct filesystem reads if Obsidian is not running
    const { readdirSync } = await import('fs');
    const vaultPath = vaultRoot;
    let inboxCount = 0, sessionCount = 0;
    try {
      inboxCount = readdirSync(join(vaultPath, 'Inbox'), { withFileTypes: true })
        .filter(f => f.isFile() && f.name.endsWith('.md')).length;
    } catch {}
    try {
      const sessDir = join(vaultPath, '2. Areas', 'Sessions');
      for (const d of readdirSync(sessDir, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        try {
          sessionCount += readdirSync(join(sessDir, d.name), { withFileTypes: true })
            .filter(f => f.isFile() && f.name.endsWith('.md')).length;
        } catch {}
      }
    } catch {}
    return { inboxCount, sessionCount, vaultPath };
  }
}
