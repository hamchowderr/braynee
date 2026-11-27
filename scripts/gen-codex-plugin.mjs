#!/usr/bin/env node
// gen-codex-plugin.mjs — generate the Codex CLI surface from the Claude Code one
// (cp-268). Contract pinned in docs/codex-compat.md (cp-5ox, cp-sgp).
//
// Why this exists:
//   Codex 0.172 installs braynee straight from .claude-plugin/marketplace.json
//   and reads skills/ as is. It ALSO reads hooks/hooks.json by default, but it
//   runs each handler as `sh -lc "<command>"` and has no `args` field. braynee's
//   hooks use the exec form {command: "node", args: [script]}, so under Codex
//   every one of them runs a bare `node`, which reads the hook's JSON payload
//   from stdin as a script and exits 1. Nothing blocks, nothing injects context.
//
//   So Codex gets its own hooks file, built from hooks/hooks.json:
//     - only events Codex has (CODEX_EVENTS); the others are dropped, not faked;
//     - `node "${PLUGIN_ROOT}/hooks/x.js"` as one command string. Codex replaces
//       ${PLUGIN_ROOT} before the shell sees it, so the quotes keep a path with
//       spaces intact on sh and on cmd;
//     - matcher, timeout (seconds, like Claude Code) and statusMessage kept.
//   .codex-plugin/plugin.json points Codex at that file and at skills/. Both
//   files are generated; the self-test fails if they drift from their sources.
//   (No $comment banner in the hooks file: Codex may reject unknown keys.)
//
// Usage:  node scripts/gen-codex-plugin.mjs [--check]
//   --check  exit 1 if anything on disk is out of date (for CI / self-test)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECK = process.argv.includes('--check');

// codex-rs/hooks/src/schema.rs HookEventNameWire plus SessionEnd, pinned at
// codex-cli 0.172.0. PermissionRequest, SubagentStart/Stop and Interrupt exist
// in Codex but braynee registers nothing for them.
export const CODEX_EVENTS = [
  'SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse',
  'PreCompact', 'PostCompact', 'Stop', 'SubagentStart', 'SubagentStop',
  'PermissionRequest', 'Interrupt', 'SessionEnd',
];

export function codexHandler(h) {
  if (h.type !== 'command' || h.command !== 'node' || !Array.isArray(h.args) || h.args.length !== 1) {
    throw new Error(`unsupported hook shape: ${JSON.stringify(h)}`);
  }
  const script = h.args[0].replace('${CLAUDE_PLUGIN_ROOT}', '${PLUGIN_ROOT}');
  if (!script.startsWith('${PLUGIN_ROOT}/')) throw new Error(`hook script outside the plugin: ${h.args[0]}`);
  if (script.includes('"')) throw new Error(`hook path contains a quote: ${h.args[0]}`);
  const out = { type: 'command', command: `node "${script}"` };
  if (h.timeout != null) out.timeout = h.timeout;
  if (h.statusMessage) out.statusMessage = h.statusMessage;
  if (h.async) out.async = true;
  return out;
}

export function buildCodexHooks(claudeHooks) {
  const hooks = {};
  const dropped = [];
  for (const [event, groups] of Object.entries(claudeHooks.hooks)) {
    if (!CODEX_EVENTS.includes(event)) { dropped.push(event); continue; }
    hooks[event] = groups.map(g => {
      const group = {};
      if (g.matcher != null) group.matcher = g.matcher;
      group.hooks = g.hooks.map(codexHandler);
      return group;
    });
  }
  return { hooks, dropped };
}

export function buildManifest(claudePlugin) {
  return {
    name: claudePlugin.name,
    version: claudePlugin.version,
    description: 'Braynee: an Obsidian-backed second brain. Skills, beads guards and session hooks; see docs/codex-compat.md for what runs on Codex.',
    author: { name: claudePlugin.author?.name },
    homepage: claudePlugin.homepage,
    repository: claudePlugin.repository,
    license: claudePlugin.license,
    keywords: claudePlugin.keywords,
    skills: './skills/',
    hooks: './hooks/codex-hooks.json',
    interface: {
      displayName: 'Braynee',
      shortDescription: 'Obsidian second brain with beads task tracking',
      developerName: claudePlugin.author?.name,
      category: 'Productivity',
    },
  };
}

const json = v => JSON.stringify(v, null, 2) + '\n';

function main() {
  const claudeHooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
  const claudePlugin = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));
  const { hooks, dropped } = buildCodexHooks(claudeHooks);
  const targets = [
    [path.join(ROOT, 'hooks', 'codex-hooks.json'), json({ hooks })],
    [path.join(ROOT, '.codex-plugin', 'plugin.json'), json(buildManifest(claudePlugin))],
  ];
  const stale = [];
  for (const [file, content] of targets) {
    let current = null;
    try { current = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { /* missing file: treated as stale below */ }
    if (current === content) continue;
    stale.push(path.relative(ROOT, file));
    if (!CHECK) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); }
  }
  if (CHECK) {
    if (stale.length) { console.log(`out of date: ${stale.join(', ')} (run node scripts/gen-codex-plugin.mjs)`); process.exit(1); }
    console.log('codex surface up to date');
    return;
  }
  console.log(stale.length ? `wrote ${stale.join(', ')}` : 'codex surface up to date');
  console.log(`events not on Codex (dropped): ${dropped.join(', ') || 'none'}`);
}

if (path.resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) main();
