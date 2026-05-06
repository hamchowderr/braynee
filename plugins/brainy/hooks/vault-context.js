#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));

const HOOK = 'vault-context';

function findVaultClaude() {
  const livePath = path.join(os.homedir(), '.claude', 'statusline-live.json');
  if (fs.existsSync(livePath)) {
    try {
      const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
      if (live.vault) {
        const p = path.join(live.vault, 'CLAUDE.md');
        if (fs.existsSync(p)) return p;
      }
    } catch (err) {
      log.warn(HOOK, `statusline parse failed: ${err.message}`);
    }
  }

  const candidates = [
    path.join(os.homedir(), 'Obsidian Vault', 'CLAUDE.md'),
    path.join(os.homedir(), 'vault', 'CLAUDE.md'),
    path.join(os.homedir(), 'Documents', 'Obsidian Vault', 'CLAUDE.md'),
    path.join(os.homedir(), 'OneDrive', 'Obsidian Vault', 'CLAUDE.md'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

try {
  const claudePath = findVaultClaude();
  if (claudePath) {
    process.stdout.write(fs.readFileSync(claudePath, 'utf8'));
    log.info(HOOK, `injected ${claudePath}`);
  } else {
    log.warn(HOOK, 'no vault CLAUDE.md found — checked statusline-live.json and common paths');
  }
} catch (err) {
  log.error(HOOK, `unhandled error: ${err.message}`);
  process.exit(0);
}
