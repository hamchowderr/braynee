// File-mode generator for the Second Brain Dashboard.
//
// Loads data once and writes two static HTML files:
//   - settings-viewer.html  → the dashboard (viewed via browser / Custom Frame)
//   - braynee-dashboard.html → self-contained portable artifact (offline/shareable)
//
// The data-load + HTML build live in render.mjs so server mode reuses them
// verbatim. This file only owns the write-to-disk + open-in-viewer concerns.
import { writeFileSync, mkdirSync, statSync } from 'fs';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

import { loadDashboardData, buildHtml } from './render.mjs';

const home = homedir();
const outDir = join(home, '.claude', 'temp');
const outPath = join(outDir, 'settings-viewer.html');
mkdirSync(outDir, { recursive: true });

const d = await loadDashboardData();

writeFileSync(outPath, buildHtml(d), 'utf8');
console.log('Generated: ' + outPath);

// Second source: the self-contained portable artifact (always emitted, fresh
// off the same data). Shareable, offline, droppable into an artifact canvas.
const artifactPath = join(outDir, 'braynee-dashboard.html');
writeFileSync(artifactPath, buildHtml(d, { artifact: true }), 'utf8');
console.log('Generated artifact: ' + artifactPath);

// cp-sjc: opening is the default for an explicit/manual run (the /health skill,
// SKILL.md, the global Brain Check command) — but the SessionStart hook must
// NOT pop Obsidian + the dashboard window on every ~4h session start. The hook
// passes `--no-open` (BRAYNEE_DASHBOARD_NO_OPEN=1 also works) so it regenerates
// the data silently. windowsHide on the open spawns so it never flashes a
// console even when it does open.
const suppressOpen = process.argv.includes('--no-open')
  || process.env.BRAYNEE_DASHBOARD_NO_OPEN === '1';

// Only open viewer if not suppressed and not opened recently (4h TTL).
const flagPath = join(home, '.claude', 'temp', 'settings-viewer-open.flag');
let shouldOpen = !suppressOpen;
try {
  const flagAge = (Date.now() - statSync(flagPath).mtimeMs) / 1000 / 60 / 60;
  if (flagAge < 4) shouldOpen = false;
} catch {}

if (shouldOpen) {
  try { writeFileSync(flagPath, new Date().toISOString()); } catch {}
  const fileUrl = 'file:///' + outPath.replace(/\\/g, '/');
  try { execSync(`obsidian web url="${fileUrl}"`, { stdio: 'ignore', windowsHide: true }); } catch {
    try { execSync(`start "" "${outPath}"`, { stdio: 'ignore', windowsHide: true }); } catch {}
  }
}
