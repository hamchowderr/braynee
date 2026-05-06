#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'session-tracker';

function findVault() {
  const livePath = path.join(os.homedir(), '.claude', 'statusline-live.json');
  if (fs.existsSync(livePath)) {
    try {
      const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
      if (live.vault && fs.existsSync(live.vault)) return live.vault;
    } catch (err) {
      log.warn(HOOK, `statusline parse failed: ${err.message}`);
    }
  }
  const candidates = [
    path.join(os.homedir(), 'Obsidian Vault'),
    path.join(os.homedir(), 'vault'),
    path.join(os.homedir(), 'Documents', 'Obsidian Vault'),
    path.join(os.homedir(), 'OneDrive', 'Obsidian Vault'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

try {
  const vault = findVault();
  if (!vault) {
    log.warn(HOOK, 'vault not found — session note not written');
    process.exit(0);
  }

  const sessionsDir = path.join(vault, '2. Areas', 'Sessions');
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true });
  }

  const today = new Date().toISOString().slice(0, 10);
  const noteFile = path.join(sessionsDir, `${today}.md`);
  const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit' });

  const workDir = process.env.CLAUDE_CWD || process.cwd();
  const projectName = path.basename(workDir);

  const entry = `\n## ${timestamp} — session ended\n\n- **Project:** ${projectName}\n`;

  if (fs.existsSync(noteFile)) {
    fs.appendFileSync(noteFile, entry, 'utf8');
  } else {
    const content = `---\ntype: session\ndate: ${today}\n---\n\n# Session — ${today}\n${entry}`;
    fs.writeFileSync(noteFile, content, 'utf8');
  }

  log.info(HOOK, `wrote session entry to ${today}.md (project: ${projectName})`);
} catch (err) {
  log.error(HOOK, `unhandled error: ${err.message}`);
  process.exit(0);
}
