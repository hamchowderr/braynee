#!/usr/bin/env node
/**
 * second-brain statusline — 3-line vault status for Claude Code.
 *
 * Install path: ~/.claude/second-brain/statusline.js
 * Setup adds: "statusline": "~/.claude/second-brain/statusline.js" to ~/.claude/settings.json
 */
'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const { execSync } = require('child_process');

// ── Vault path ──────────────────────────────────────────────────────────────

function findVault() {
  const livePath = path.join(os.homedir(), '.claude', 'statusline-live.json');
  if (fs.existsSync(livePath)) {
    try {
      const live = JSON.parse(fs.readFileSync(livePath, 'utf8'));
      if (live.vault && fs.existsSync(live.vault)) return live.vault;
    } catch {}
  }
  const candidates = [
    path.join(os.homedir(), 'Obsidian Vault'),
    path.join(os.homedir(), 'vault'),
    path.join(os.homedir(), 'Documents', 'Obsidian Vault'),
    path.join(os.homedir(), 'OneDrive', 'Obsidian Vault'),
  ];
  return candidates.find(p => fs.existsSync(p)) || null;
}

// ── Line 1: Vault state ──────────────────────────────────────────────────────

function line1(vault) {
  const cwd = process.env.CLAUDE_CWD || process.cwd();
  const project = path.basename(cwd);

  if (!vault) {
    return `📥 ? inbox  │  📁 ${project}  │  🧠 vault: not found`;
  }

  let inboxCount = 0;
  try {
    const inboxDir = path.join(vault, 'Inbox');
    if (fs.existsSync(inboxDir)) {
      inboxCount = fs.readdirSync(inboxDir)
        .filter(f => f.endsWith('.md')).length;
    }
  } catch {}

  return `📥 ${inboxCount} inbox  │  📁 ${project}  │  🧠 vault`;
}

// ── Line 2: Session ──────────────────────────────────────────────────────────

function line2() {
  const cwd = process.env.CLAUDE_CWD || process.cwd();
  const cwdBase = path.basename(cwd);

  let branch = '—';
  try {
    branch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 500,
    }).toString().trim();
  } catch {}

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });

  return `📋 ${cwdBase}  │  🌿 ${branch}  │  ${dateStr}`;
}

// ── Line 3: Tools ────────────────────────────────────────────────────────────

function checkBinary(name) {
  try {
    execSync(`${process.platform === 'win32' ? 'where' : 'which'} ${name}`, {
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 300,
    });
    return true;
  } catch {
    return false;
  }
}

function line3() {
  const obsidian = checkBinary('obsidian') ? '●' : '○';
  const bd       = checkBinary('bd')       ? '●' : '○';
  const qmdPath  = path.join(os.homedir(), '.claude', 'scripts', 'qmd-wrapper.mjs');
  const qmd      = fs.existsSync(qmdPath)  ? '●' : '○';

  return `obsidian ${obsidian}  │  bd ${bd}  │  qmd ${qmd}`;
}

// ── Output ───────────────────────────────────────────────────────────────────

const vault = findVault();
process.stdout.write([line1(vault), line2(), line3()].join('\n'));
