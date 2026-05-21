#!/usr/bin/env node
/**
 * vault-query.mjs — Obsidian Vault Frontmatter Query Engine
 * Zero-dependency Node.js script for querying markdown notes by frontmatter.
 * Replaces the need for obsidian-bases-query RPC plugin.
 *
 * Usage: node vault-query.mjs <command> [options]
 *
 * Commands:
 *   query <folder>       Query notes by frontmatter fields
 *   read <path>          Read a note's frontmatter + body preview
 *   context <project>    Load full project context (project + sessions + tasks)
 *   session start        Create a new session note
 *   session close        Close an active session
 *   session list         List sessions with filters
 *   project create       Create a new project note
 *   project list         List all projects
 *   dashboard list       List available dashboards
 *   dashboard read       Read a dashboard note
 */

import { readFileSync, readdirSync, writeFileSync, existsSync, mkdirSync, statSync } from 'fs';
import { join, basename, extname, relative } from 'path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { getVaultRoot } = require('./lib/vault-root.js');

// ─── Configuration ──────────────────────────────────────────────────────────
const VAULT = getVaultRoot();
const FOLDERS = {
  projects:   join(VAULT, '1. Projects'),
  sessions:   join(VAULT, '2. Areas', 'Sessions'),
  dashboards: join(VAULT, '2. Areas', 'Views'),
  bases:      join(VAULT, '2. Areas', 'Bases'),
  tasks:      join(VAULT, '2. Areas', 'TaskNotes', 'Tasks'),
};

// ─── Frontmatter Parser ─────────────────────────────────────────────────────
function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { frontmatter: {}, body: content };

  const raw = match[1];
  const body = content.slice(match[0].length).trim();
  const fm = {};

  let currentKey = null;
  let currentIndent = 0;
  let listKey = null;

  for (const line of raw.split(/\r?\n/)) {
    // Skip empty lines
    if (!line.trim()) continue;

    // Detect list items (  - value)
    const listMatch = line.match(/^(\s+)-\s+(.*)/);
    if (listMatch && listKey) {
      if (!Array.isArray(fm[listKey])) fm[listKey] = [];
      let val = listMatch[2].trim();
      // Strip wikilinks and quotes
      val = val.replace(/^\[?\[?(.*?)\]?\]?$/, '$1').replace(/^["']|["']$/g, '');
      fm[listKey].push(val);
      continue;
    }

    // Key: value pairs
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)/);
    if (kvMatch) {
      const key = kvMatch[1];
      let value = kvMatch[2].trim();

      // Empty value means upcoming list or nested object
      if (!value) {
        listKey = key;
        fm[key] = [];
        continue;
      }

      listKey = null;

      // Strip quotes
      value = value.replace(/^["']|["']$/g, '');

      // Strip wikilinks: [[Project Name]] → Project Name
      value = value.replace(/\[\[(.*?)\]\]/g, '$1');

      // Parse booleans
      if (value === 'true') value = true;
      else if (value === 'false') value = false;
      // Parse numbers
      else if (/^\d+$/.test(value)) value = parseInt(value, 10);
      else if (/^\d+\.\d+$/.test(value)) value = parseFloat(value);
      // Parse null
      else if (value === 'null' || value === '~') value = null;
      // Parse inline arrays: [a, b, c]
      else if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map(v =>
          v.trim().replace(/^["']|["']$/g, '').replace(/\[\[(.*?)\]\]/g, '$1')
        );
      }

      fm[key] = value;
    }
  }

  return { frontmatter: fm, body };
}

// ─── File Discovery ─────────────────────────────────────────────────────────
function findMarkdownFiles(folder, recursive = true) {
  if (!existsSync(folder)) return [];
  const files = [];

  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory() && recursive && !entry.name.startsWith('.')) {
        walk(full);
      } else if (entry.isFile() && extname(entry.name) === '.md') {
        files.push(full);
      }
    }
  }

  walk(folder);
  return files;
}

function readNote(filePath) {
  let content = readFileSync(filePath, 'utf-8');
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1); // strip UTF-8 BOM
  const { frontmatter, body } = parseFrontmatter(content);
  const stat = statSync(filePath);
  return {
    path: relative(VAULT, filePath).replace(/\\/g, '/'),
    filename: basename(filePath, '.md'),
    frontmatter,
    body,
    modified: stat.mtime,
    created: stat.birthtime,
  };
}

// ─── Query Engine ───────────────────────────────────────────────────────────
function matchesFilter(note, filters) {
  for (const [key, target] of Object.entries(filters)) {
    if (target === undefined || target === null) continue;

    const value = note.frontmatter[key];

    // Array field: check if any element matches
    if (Array.isArray(value)) {
      if (Array.isArray(target)) {
        if (!target.some(t => value.includes(t))) return false;
      } else {
        if (!value.includes(target)) return false;
      }
    }
    // Array target against scalar value
    else if (Array.isArray(target)) {
      if (!target.includes(value)) return false;
    }
    // Wildcard matching
    else if (typeof target === 'string' && target.includes('*')) {
      const regex = new RegExp('^' + target.replace(/\*/g, '.*') + '$', 'i');
      if (!regex.test(String(value || ''))) return false;
    }
    // Exact match (case-insensitive for strings)
    else {
      const a = typeof value === 'string' ? value.toLowerCase() : value;
      const b = typeof target === 'string' ? target.toLowerCase() : target;
      if (a !== b) return false;
    }
  }
  return true;
}

function sortNotes(notes, sortSpec) {
  if (!sortSpec) return notes;

  const [field, dir] = sortSpec.split(':');
  const mult = dir === 'asc' ? 1 : -1;

  return notes.sort((a, b) => {
    let va, vb;

    if (field === 'modified') {
      va = a.modified; vb = b.modified;
    } else if (field === 'created') {
      va = a.created; vb = b.created;
    } else if (field === 'filename') {
      va = a.filename; vb = b.filename;
    } else {
      va = a.frontmatter[field]; vb = b.frontmatter[field];
    }

    if (va == null && vb == null) return 0;
    if (va == null) return 1;
    if (vb == null) return -1;

    if (va instanceof Date && vb instanceof Date) return (va - vb) * mult;
    if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * mult;
    return String(va).localeCompare(String(vb)) * mult;
  });
}

// ─── Formatters ─────────────────────────────────────────────────────────────
function truncate(str, len) {
  if (!str) return '';
  str = String(str);
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

function formatDate(d) {
  if (!d) return '';
  if (d instanceof Date) return d.toISOString().split('T')[0];
  return String(d).split('T')[0];
}

function formatArray(arr) {
  if (!arr) return '';
  if (Array.isArray(arr)) return arr.join(', ');
  return String(arr);
}

const STATUS_ICONS = {
  active: '🟢', 'in-progress': '🟡', blocked: '🔴', done: '✅',
  paused: '⏸️', archived: '📦', backlog: '📋', open: '○',
};

const PRIORITY_ICONS = {
  high: '🔴', normal: '🟡', low: '🟢', none: '⚪',
};

function formatTable(notes, columns) {
  if (notes.length === 0) return 'No results found.';

  // Build column definitions
  const cols = columns.map(c => {
    if (typeof c === 'string') return { key: c, label: c, width: null };
    return c;
  });

  // Calculate data
  const rows = notes.map(note => {
    const row = {};
    for (const col of cols) {
      let val;
      if (col.key === 'filename') val = note.filename;
      else if (col.key === 'path') val = note.path;
      else if (col.key === 'modified') val = formatDate(note.modified);
      else if (col.key === 'created') val = formatDate(note.created);
      else val = note.frontmatter[col.key];

      // Apply icons
      if (col.key === 'status') val = (STATUS_ICONS[val] || '·') + ' ' + (val || '');
      else if (col.key === 'priority') val = (PRIORITY_ICONS[val] || '') + ' ' + (val || '');
      else if (Array.isArray(val)) val = val.join(', ');
      else val = val == null ? '' : String(val);

      row[col.key] = val;
    }
    return row;
  });

  // Calculate widths
  for (const col of cols) {
    if (!col.width) {
      const maxData = Math.max(...rows.map(r => r[col.key].length));
      col.width = Math.max(col.label.length, Math.min(maxData, 40));
    }
  }

  // Render
  const header = cols.map(c => c.label.padEnd(c.width)).join('  ');
  const sep = cols.map(c => '─'.repeat(c.width)).join('──');
  const body = rows.map(row =>
    cols.map(c => truncate(row[c.key], c.width).padEnd(c.width)).join('  ')
  ).join('\n');

  return `${header}\n${sep}\n${body}`;
}

function formatDetail(note) {
  const fm = note.frontmatter;
  const lines = [`# ${note.filename}`, `Path: ${note.path}`, ''];

  for (const [k, v] of Object.entries(fm)) {
    if (Array.isArray(v)) lines.push(`${k}: ${v.join(', ')}`);
    else lines.push(`${k}: ${v}`);
  }

  if (note.body) {
    lines.push('', '─'.repeat(60), '');
    // Show first 30 lines of body
    const bodyLines = note.body.split(/\r?\n/).slice(0, 30);
    lines.push(...bodyLines);
    if (note.body.split(/\r?\n/).length > 30) lines.push('\n... (truncated)');
  }

  return lines.join('\n');
}

// ─── Session Management ─────────────────────────────────────────────────────
function generateSessionFilename(project, sessionType) {
  const now = new Date();
  const date = now.toISOString().split('T')[0];
  const slug = (project || 'general').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const type = sessionType || 'code';
  return `${date}-${slug}-${type}.md`;
}

function createSessionNote(args) {
  ensureFolder(FOLDERS.sessions);

  const project = args['--project'] || args['--p'];
  const goal = args['--goal'] || args['--g'] || 'New session';
  const type = args['--type'] || args['--t'] || 'code';
  const branch = args['--branch'] || args['--b'] || '';
  const tags = (args['--tags'] || 'session').split(',').map(t => t.trim());

  if (!tags.includes('session')) tags.unshift('session');
  if (type && !tags.includes(type)) tags.push(type);

  // Create project subfolder under Sessions/
  const projectSlug = (project || '_uncategorized').replace(/[^a-zA-Z0-9]+/g, '-');
  const subfolder = join(FOLDERS.sessions, projectSlug);
  ensureFolder(subfolder);

  const filename = generateSessionFilename(project, type);
  const filepath = join(subfolder, filename);

  if (existsSync(filepath)) {
    console.error(`Session file already exists: ${projectSlug}/${filename}`);
    console.error('Use a different --type or wait for the next date.');
    process.exit(1);
  }

  const now = new Date().toISOString();
  const projectRef = project ? `"[[${project}]]"` : 'null';

  const content = `---
type: session
project: ${projectRef}
status: active
session_type: ${type}
branch: "${branch}"
started: ${now}
ended: null
tags:
${tags.map(t => `  - ${t}`).join('\n')}
---

## Goal
${goal}

## Context
${project ? `- Working on [[${project}]]` : '- General session'}
${branch ? `- Branch: ${branch}` : ''}

## Decisions
- (none yet)

## Blockers
- (none)

## Code Snippets

## Questions to Explore
`;

  writeFileSync(filepath, content, 'utf-8');
  console.log(`✅ Session created: Sessions/${projectSlug}/${filename}`);
  console.log(`   Project: ${project || '(none)'}`);
  console.log(`   Type: ${type}`);
  console.log(`   Goal: ${goal}`);
}

function closeSession(args) {
  const pathArg = args['--path'] || args['--p'] || args._positional[0];
  const summary = args['--summary'] || args['--s'] || 'Session completed';
  const projectFilter = args['--project'] || args['--proj'];

  if (!pathArg) {
    // Find most recent active session, scoped to project if provided
    let sessions = findMarkdownFiles(FOLDERS.sessions, true)
      .map(f => readNote(f))
      .filter(n => n.frontmatter.status === 'active');

    // Scope to project if --project is given
    if (projectFilter) {
      const target = projectFilter.toLowerCase();
      sessions = sessions.filter(n => {
        const p = n.frontmatter.project;
        const pName = typeof p === 'string' ? p.replace(/\[\[|\]\]/g, '').toLowerCase() : '';
        return pName === target || pName.endsWith('/' + target) || pName.includes(target);
      });
    }

    sessions.sort((a, b) => b.modified - a.modified);

    if (sessions.length === 0) {
      console.log(projectFilter
        ? `No active sessions found for project "${projectFilter}".`
        : 'No active sessions found.');
      return;
    }

    const session = sessions[0];
    closeSessionFile(join(VAULT, session.path), summary);
    return;
  }

  const fullPath = pathArg.includes('/') || pathArg.includes('\\')
    ? join(VAULT, pathArg)
    : join(FOLDERS.sessions, pathArg.endsWith('.md') ? pathArg : pathArg + '.md');

  if (!existsSync(fullPath)) {
    console.error(`Session not found: ${pathArg}`);
    process.exit(1);
  }

  closeSessionFile(fullPath, summary);
}

function closeSessionFile(filepath, summary) {
  let content = readFileSync(filepath, 'utf-8');
  const now = new Date().toISOString();

  // Update status
  content = content.replace(/^status:\s*active/m, 'status: done');
  // Update ended
  content = content.replace(/^ended:\s*null/m, `ended: ${now}`);

  // Append summary section if not present
  if (!content.includes('## Session Summary')) {
    content += `\n## Session Summary\n${summary}\n\nClosed: ${now}\n`;
  }

  writeFileSync(filepath, content, 'utf-8');
  const name = basename(filepath);
  console.log(`✅ Session closed: ${name}`);
  console.log(`   Summary: ${summary}`);
}

// ─── Project Management ─────────────────────────────────────────────────────
function createProject(args) {
  ensureFolder(FOLDERS.projects);

  const name = args['--name'] || args['--n'] || args._positional[0];
  if (!name) {
    console.error('Error: --name is required');
    process.exit(1);
  }

  const repo = args['--repo'] || args['--r'] || '';
  const desc = args['--description'] || args['--desc'] || args['--d'] || '';
  const status = args['--status'] || 'active';
  const stack = (args['--stack'] || '').split(',').map(t => t.trim()).filter(Boolean);
  const tags = ['project'];

  const filename = name.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-') + '.md';
  const filepath = join(FOLDERS.projects, filename);

  if (existsSync(filepath)) {
    console.error(`Project already exists: ${filename}`);
    process.exit(1);
  }

  const now = new Date().toISOString().split('T')[0];

  const deadline = args['--deadline'] || args['--due'] || null;

  const content = `---
type: project
name: "${name}"
repo: "${repo}"
status: ${status}
description: "${desc}"
started: ${now}
deadline: ${deadline ? deadline : 'null'}
${stack.length > 0 ? `stack:\n${stack.map(s => `  - ${s}`).join('\n')}` : 'stack: []'}
tags:
${tags.map(t => `  - ${t}`).join('\n')}
---

## Overview
${desc || `Project: ${name}`}

## Current Focus
(Not set)

## Architecture Notes
${repo ? `- Repository: ${repo}` : ''}
${stack.length > 0 ? `- Stack: ${stack.join(', ')}` : ''}

## Links & Context
<!-- Add contextual wikilinks below — explain WHY each link matters -->

### Resources
<!-- [[Resource Note]] — why it's relevant -->

### Related Projects
<!-- [[Other Project]] — how they connect -->

### Connected Notes
\`\`\`dataview
LIST
FROM [[${name}]]
WHERE file.name != this.file.name
SORT file.mtime DESC
\`\`\`
`;

  writeFileSync(filepath, content, 'utf-8');
  console.log(`✅ Project created: 1. Projects/${filename}`);
  console.log(`   Name: ${name}`);
  if (repo) console.log(`   Repo: ${repo}`);
  if (desc) console.log(`   Description: ${desc}`);
  if (deadline) console.log(`   Deadline: ${deadline}`);
}

// ─── Context Loading ────────────────────────────────────────────────────────
function loadContext(args) {
  const project = args._positional[0] || args['--project'] || args['--p'];
  if (!project) {
    console.error('Usage: vault-query.mjs context <project-name>');
    process.exit(1);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  Loading context for: ${project}`);
  console.log(`${'═'.repeat(60)}\n`);

  // 1. Find project note
  const projectFiles = findMarkdownFiles(FOLDERS.projects, false)
    .map(f => readNote(f))
    .filter(n =>
      n.filename.toLowerCase() === project.toLowerCase() ||
      (n.frontmatter.name && n.frontmatter.name.toLowerCase() === project.toLowerCase())
    );

  if (projectFiles.length > 0) {
    const p = projectFiles[0];
    console.log('── PROJECT ──────────────────────────────────────────────');
    console.log(`Name: ${p.frontmatter.name || p.filename}`);
    console.log(`Status: ${p.frontmatter.status || 'unknown'}`);
    if (p.frontmatter.repo) console.log(`Repo: ${p.frontmatter.repo}`);
    if (p.frontmatter.description) console.log(`Description: ${p.frontmatter.description}`);
    if (p.frontmatter.stack) console.log(`Stack: ${formatArray(p.frontmatter.stack)}`);

    // Show body sections
    const sections = p.body.split(/^## /m).filter(Boolean);
    for (const section of sections) {
      const lines = section.split('\n');
      const title = lines[0].trim();
      const content = lines.slice(1).join('\n').trim();
      if (content && content !== '(Not set)') {
        console.log(`\n[${title}]`);
        // Show first 5 lines of each section
        const preview = content.split('\n').slice(0, 5);
        console.log(preview.join('\n'));
        if (content.split('\n').length > 5) console.log('  ...');
      }
    }
  } else {
    console.log(`⚠ No project note found for "${project}"`);
    console.log(`  Create one: node vault-query.mjs project create --name "${project}"`);
  }

  // 2. Active sessions for this project
  console.log('\n── ACTIVE SESSIONS ──────────────────────────────────────');
  const sessions = findMarkdownFiles(FOLDERS.sessions, true)
    .map(f => readNote(f))
    .filter(n => {
      const p = n.frontmatter.project;
      const pName = typeof p === 'string' ? p.replace(/\[\[|\]\]/g, '') : '';
      return pName.toLowerCase() === project.toLowerCase();
    })
    .sort((a, b) => b.modified - a.modified);

  const activeSessions = sessions.filter(s => s.frontmatter.status === 'active');
  const recentDone = sessions.filter(s => s.frontmatter.status === 'done').slice(0, 3);

  if (activeSessions.length > 0) {
    for (const s of activeSessions) {
      console.log(`\n  🟢 ${s.filename}`);
      console.log(`     Type: ${s.frontmatter.session_type || 'code'}`);
      if (s.frontmatter.branch) console.log(`     Branch: ${s.frontmatter.branch}`);
      // Extract goal from body
      const goalMatch = s.body.match(/## Goal\s*\n([\s\S]*?)(?=\n##|\n$)/);
      if (goalMatch) console.log(`     Goal: ${goalMatch[1].trim()}`);
    }
  } else {
    console.log('  No active sessions');
  }

  if (recentDone.length > 0) {
    console.log('\n  Recent completed:');
    for (const s of recentDone) {
      console.log(`    ✅ ${s.filename} (${formatDate(s.frontmatter.ended || s.modified)})`);
    }
  }

  // 3. Summary stats
  console.log(`\n── STATS ────────────────────────────────────────────────`);
  console.log(`  Total sessions: ${sessions.length}`);
  console.log(`  Active: ${activeSessions.length}`);
  console.log(`  Completed: ${sessions.filter(s => s.frontmatter.status === 'done').length}`);
  console.log(`  Blocked: ${sessions.filter(s => s.frontmatter.status === 'blocked').length}`);

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`TIP: Use 'bd ready' (in the project repo) to see actionable tasks`);
  console.log(`${'═'.repeat(60)}\n`);
}

// ─── Dashboard Reading ──────────────────────────────────────────────────────
function readDashboard(args) {
  const name = args._positional[0] || args['--name'] || args['--n'];

  if (!name) {
    // List available dashboards
    console.log('Available dashboards:\n');
    if (existsSync(FOLDERS.dashboards)) {
      const files = findMarkdownFiles(FOLDERS.dashboards, false);
      if (files.length === 0) {
        console.log('  (none created yet)');
      } else {
        for (const f of files) {
          const note = readNote(f);
          console.log(`  📊 ${note.filename}`);
          if (note.frontmatter.description) console.log(`     ${note.frontmatter.description}`);
        }
      }
    } else {
      console.log('  Dashboards folder not created yet.');
    }
    return;
  }

  // Try exact match first, then fuzzy match with number prefix (e.g. "Working" -> "1. Working.md")
  let filepath = join(FOLDERS.dashboards, name.endsWith('.md') ? name : name + '.md');
  if (!existsSync(filepath) && existsSync(FOLDERS.dashboards)) {
    const files = findMarkdownFiles(FOLDERS.dashboards, false);
    const match = files.find(f => basename(f, '.md').replace(/^\d+\.\s*/, '') === name);
    if (match) filepath = match;
  }
  if (!existsSync(filepath)) {
    console.error(`Dashboard not found: ${name}`);
    console.log('Available dashboards:');
    if (existsSync(FOLDERS.dashboards)) {
      findMarkdownFiles(FOLDERS.dashboards, false).forEach(f => {
        console.log(`  - ${basename(f, '.md')}`);
      });
    }
    return;
  }

  const note = readNote(filepath);
  console.log(formatDetail(note));
}

// ─── Helpers ────────────────────────────────────────────────────────────────
function ensureFolder(path) {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function parseArgs(argv) {
  const args = { _positional: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg;
      // Check if next arg is a value or another flag
      if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        args[key] = argv[i + 1];
        i += 2;
      } else {
        args[key] = true;
        i += 1;
      }
    } else {
      args._positional.push(arg);
      i += 1;
    }
  }
  return args;
}

// ─── Main Router ────────────────────────────────────────────────────────────
const [cmd, subcmd, ...rest] = process.argv.slice(2);

if (!cmd) {
  console.log(`vault-query.mjs — Obsidian Vault Frontmatter Query Engine

Commands:
  query <folder>        Query notes by frontmatter
    --status X          Filter by status
    --project X         Filter by project
    --type X            Filter by type
    --tag X             Filter by tag (in tags array)
    --<field> <val>     Filter by any frontmatter field
    --sort field:dir    Sort (e.g., modified:desc, priority:asc)
    --limit N           Max results (default: 20)
    --fields f1,f2      Columns to show

  read <path>           Read a note's frontmatter + body preview

  context <project>     Load full project context

  session start         Create a new session note
    --project X         Project name (becomes wikilink)
    --goal "..."        Session goal
    --type X            code|review|learn|plan|debug (default: code)
    --branch X          Git branch name
    --tags X            Comma-separated tags

  session close [path]  Close active session (most recent if no path)
    --project X         Scope to project (required when no path given)
    --summary "..."     Closing summary

  session list          List sessions
    --status X          active|done|blocked
    --project X         Filter by project

  project create        Create a project note
    --name X            Project name (required)
    --repo X            Repository URL
    --description "..."
    --stack X           Comma-separated tech stack
    --deadline X        Deadline date (YYYY-MM-DD)

  project list          List all projects

  dashboard list        List available dashboards
  dashboard read <name> Read a dashboard note
`);
  process.exit(0);
}

switch (cmd) {
  case 'query': {
    const folder = subcmd;
    const args = parseArgs(rest);

    // Resolve folder path
    let folderPath;
    if (FOLDERS[folder]) {
      folderPath = FOLDERS[folder];
    } else if (existsSync(join(VAULT, folder))) {
      folderPath = join(VAULT, folder);
    } else {
      console.error(`Folder not found: ${folder}`);
      console.log('Known folders:', Object.keys(FOLDERS).join(', '));
      process.exit(1);
    }

    const recursive = args['--recursive'] !== false;
    const limit = parseInt(args['--limit'] || '20', 10);
    const sort = args['--sort'] || 'modified:desc';
    const fieldsArg = args['--fields'];

    // Build filters from remaining args
    const filters = {};
    const skipKeys = ['--limit', '--sort', '--fields', '--recursive', '--columns'];
    for (const [k, v] of Object.entries(args)) {
      if (k === '_positional' || skipKeys.includes(k)) continue;
      if (k.startsWith('--')) {
        const field = k.slice(2);
        // Special handling for 'tag' → search in 'tags' array
        if (field === 'tag') {
          filters['tags'] = v;
        } else {
          filters[field] = v;
        }
      }
    }

    // Query
    let notes = findMarkdownFiles(folderPath, recursive).map(f => readNote(f));
    notes = notes.filter(n => matchesFilter(n, filters));
    notes = sortNotes(notes, sort);
    notes = notes.slice(0, limit);

    // Determine columns
    let columns;
    if (fieldsArg) {
      columns = fieldsArg.split(',').map(f => f.trim());
    } else {
      // Auto-detect from first few results
      const commonFields = new Set();
      for (const n of notes.slice(0, 5)) {
        for (const k of Object.keys(n.frontmatter)) {
          commonFields.add(k);
        }
      }
      columns = ['filename', 'status', 'type'];
      for (const f of ['project', 'priority', 'session_type', 'branch', 'due', 'started']) {
        if (commonFields.has(f)) columns.push(f);
      }
      columns.push('modified');
    }

    console.log(`Found ${notes.length} notes in ${folder}\n`);
    console.log(formatTable(notes, columns));
    break;
  }

  case 'read': {
    const pathArg = subcmd;
    if (!pathArg) {
      console.error('Usage: vault-query.mjs read <path>');
      process.exit(1);
    }
    const fullPath = existsSync(pathArg) ? pathArg : join(VAULT, pathArg);
    if (!existsSync(fullPath)) {
      console.error(`File not found: ${pathArg}`);
      process.exit(1);
    }
    console.log(formatDetail(readNote(fullPath)));
    break;
  }

  case 'context': {
    const args = parseArgs(subcmd ? [subcmd, ...rest] : rest);
    loadContext(args);
    break;
  }

  case 'session': {
    const args = parseArgs(rest);
    switch (subcmd) {
      case 'start':
      case 'create':
        createSessionNote(args);
        break;
      case 'close':
      case 'done':
        closeSession(args);
        break;
      case 'list': {
        const filters = {};
        if (args['--status']) filters.status = args['--status'];
        if (args['--project']) {
          // We'll handle project matching manually
        }
        if (args['--type']) filters.session_type = args['--type'];

        let notes = findMarkdownFiles(FOLDERS.sessions, true).map(f => readNote(f));
        notes = notes.filter(n => matchesFilter(n, filters));

        // Project filter (special handling for wikilinks)
        if (args['--project']) {
          const target = args['--project'].toLowerCase();
          notes = notes.filter(n => {
            const p = n.frontmatter.project;
            const pName = typeof p === 'string' ? p.replace(/\[\[|\]\]/g, '').toLowerCase() : '';
            return pName === target;
          });
        }

        notes = sortNotes(notes, args['--sort'] || 'modified:desc');
        notes = notes.slice(0, parseInt(args['--limit'] || '20', 10));

        console.log(`Sessions: ${notes.length} found\n`);
        console.log(formatTable(notes, [
          { key: 'filename', label: 'Session', width: 40 },
          { key: 'status', label: 'Status', width: 12 },
          { key: 'session_type', label: 'Type', width: 10 },
          { key: 'project', label: 'Project', width: 20 },
          { key: 'modified', label: 'Modified', width: 12 },
        ]));
        break;
      }
      default:
        console.error(`Unknown session command: ${subcmd}`);
        console.log('Available: start, close, list');
    }
    break;
  }

  case 'project': {
    const args = parseArgs(rest);
    switch (subcmd) {
      case 'create':
        createProject(args);
        break;
      case 'list': {
        let notes = findMarkdownFiles(FOLDERS.projects, false).map(f => readNote(f));
        if (args['--status']) notes = notes.filter(n => matchesFilter(n, { status: args['--status'] }));
        notes = sortNotes(notes, args['--sort'] || 'filename:asc');

        console.log(`Projects: ${notes.length} found\n`);
        console.log(formatTable(notes, [
          { key: 'filename', label: 'Project', width: 25 },
          { key: 'status', label: 'Status', width: 12 },
          { key: 'description', label: 'Description', width: 35 },
          { key: 'repo', label: 'Repo', width: 30 },
        ]));
        break;
      }
      default:
        console.error(`Unknown project command: ${subcmd}`);
        console.log('Available: create, list');
    }
    break;
  }

  case 'dashboard': {
    const args = parseArgs(rest);
    switch (subcmd) {
      case 'list':
        readDashboard({ _positional: [] });
        break;
      case 'read':
        readDashboard(args);
        break;
      default:
        readDashboard({ _positional: subcmd ? [subcmd] : [] });
    }
    break;
  }

  default:
    console.error(`Unknown command: ${cmd}`);
    console.log('Available: query, read, context, session, project, dashboard');
    process.exit(1);
}
