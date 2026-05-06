#!/usr/bin/env node
/**
 * tasknotes.mjs — TaskNotes CLI for Claude Code
 * Zero-dependency Node.js script for managing TaskNotes tasks via HTTP API.
 *
 * Usage: node tasknotes.mjs <command> [options]
 *
 * Commands:
 *   list                  List tasks with filters
 *   get <id>              Get full task details
 *   create "title"        Create task via structured API
 *   subtasks "parent" "child1" "child2" ...  Create parent + child tasks
 *   nlp "natural text"    Create task via NLP API
 *   update <id>           Update task fields
 *   complete <id>         Toggle task to done
 *   search                Advanced query with filters
 *   stats                 Show task statistics
 *   timer start <id>      Start time tracking on a task
 *   timer stop <id>       Stop time tracking on a task
 *   timer active          Show active timer sessions
 *   timer summary         Show time summary (today/week/month/all)
 *   timer info <id>       Show time entries for a task
 */

import http from 'http';
import net from 'net';

// ─── Configuration ──────────────────────────────────────────────────────────
const LOCAL_URL = 'http://localhost:8081/api';
const AUTH_TOKEN = process.env.TASKNOTES_TOKEN || '5Z3IySQ9uI5jzH0q8sMp+Np0vruJILVSLhX1PITANl0=';

// ─── HTTP Client ────────────────────────────────────────────────────────────

// Quick TCP check — fails fast if server is down (500ms timeout)
function isServerUp() {
  return new Promise((resolve) => {
    const sock = net.createConnection({ host: 'localhost', port: 8081 }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.on('error', () => resolve(false));
    sock.setTimeout(500, () => { sock.destroy(); resolve(false); });
  });
}

function request(method, path, body = null) {
  return new Promise(async (resolve, reject) => {
    const url = LOCAL_URL + path;
    const parsed = new URL(url);

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 80,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Authorization': `Bearer ${AUTH_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 3000,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function api(method, path, body = null) {
  if (!(await isServerUp())) {
    console.error('Error: TaskNotes server not running on localhost:8081.');
    console.error('  - Is Obsidian running with the TaskNotes plugin enabled?');
    process.exit(1);
  }
  try {
    return await request(method, path, body);
  } catch (err) {
    console.error(`Error: TaskNotes API request failed: ${err.message}`);
    process.exit(1);
  }
}

// ─── Formatters ─────────────────────────────────────────────────────────────
const STATUS_ICONS = {
  none: '○', backlog: '📋', open: '○', 'next-action': '▶',
  'in-progress': '🟡', waiting: '⏳', review: '👁', someday: '💭',
  done: '✅', cancelled: '✖', todo: '○', archived: '📦',
};

const PRIORITY_ICONS = {
  high: '🔴', medium: '🟡', normal: '🟡', low: '🟢', none: '⚪',
};

function truncate(str, len) {
  if (!str) return '';
  str = String(str);
  return str.length > len ? str.slice(0, len - 1) + '…' : str;
}

function formatDate(d) {
  if (!d) return '';
  return String(d).split('T')[0];
}

function formatTable(rows, columns) {
  if (rows.length === 0) return 'No tasks found.';

  const data = rows.map(row => {
    const out = {};
    for (const col of columns) {
      let val = row[col.key];
      if (col.key === 'status') val = (STATUS_ICONS[val] || '·') + ' ' + (val || '');
      else if (col.key === 'priority') val = (PRIORITY_ICONS[val] || '') + ' ' + (val || '');
      else if (Array.isArray(val)) val = val.join(', ');
      else if (col.key === 'due' || col.key === 'scheduled' || col.key === 'created') val = formatDate(val);
      else val = val == null ? '' : String(val);
      out[col.key] = val;
    }
    return out;
  });

  // Calculate widths
  for (const col of columns) {
    if (!col.width) {
      const maxData = Math.max(...data.map(r => (r[col.key] || '').length));
      col.width = Math.max(col.label.length, Math.min(maxData, col.maxWidth || 40));
    }
  }

  const header = columns.map(c => c.label.padEnd(c.width)).join('  ');
  const sep = columns.map(c => '─'.repeat(c.width)).join('──');
  const body = data.map(row =>
    columns.map(c => truncate(row[c.key], c.width).padEnd(c.width)).join('  ')
  ).join('\n');

  return `${header}\n${sep}\n${body}`;
}

// ─── Arg Parser ─────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { _positional: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg;
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

// ─── ID Helper ──────────────────────────────────────────────────────────────
function resolveId(input) {
  if (!input) return null;
  // Already a full path
  if (input.includes('/') || input.includes('\\')) return input;
  // Add .md if missing
  if (!input.endsWith('.md')) input += '.md';
  // Match vault task folder structure
  return `2. Areas/TaskNotes/Tasks/${input}`;
}

// ─── Commands ───────────────────────────────────────────────────────────────

async function cmdList(args) {
  const params = new URLSearchParams();
  if (args['--status']) params.set('status', args['--status']);
  if (args['--priority']) params.set('priority', args['--priority']);
  if (args['--project']) params.set('project', args['--project']);
  if (args['--tags']) params.set('tags', args['--tags']);
  if (args['--due']) params.set('due', args['--due']);
  if (args['--sort']) params.set('sort', args['--sort']);
  if (args['--limit']) params.set('limit', args['--limit']);
  if (args['--page']) params.set('page', args['--page']);

  const qs = params.toString();
  const res = await api('GET', `/tasks${qs ? '?' + qs : ''}`);

  if (!res.data.success) {
    console.error(`Error: ${res.data.message || 'Failed to list tasks'}`);
    process.exit(1);
  }

  const payload = res.data.data || {};
  const tasks = payload.tasks || (Array.isArray(payload) ? payload : []);
  const pagination = payload.pagination;
  const isJson = args['--json'];

  if (isJson) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }

  const total = pagination ? pagination.total : tasks.length;
  console.log(`Tasks: ${tasks.length} shown (${total} total)\n`);
  console.log(formatTable(tasks, [
    { key: 'title', label: 'Title', maxWidth: 40 },
    { key: 'status', label: 'Status', maxWidth: 15 },
    { key: 'priority', label: 'Priority', maxWidth: 12 },
    { key: 'projects', label: 'Projects', maxWidth: 20 },
    { key: 'scheduled', label: 'Scheduled', maxWidth: 12 },
  ]));
}

async function cmdGet(args) {
  const id = args._positional[0];
  if (!id) {
    console.error('Usage: tasknotes.mjs get <id>');
    process.exit(1);
  }

  const resolved = resolveId(id);
  const res = await api('GET', `/tasks/${encodeURIComponent(resolved)}`);

  if (!res.data.success) {
    console.error(`Error: ${res.data.message || 'Task not found'}`);
    process.exit(1);
  }

  const task = res.data.data;
  const isJson = args['--json'];

  if (isJson) {
    console.log(JSON.stringify(task, null, 2));
    return;
  }

  const icon = STATUS_ICONS[task.status] || '·';
  const pIcon = PRIORITY_ICONS[task.priority] || '';
  console.log(`${icon} ${task.title}`);
  console.log(`${'─'.repeat(50)}`);
  console.log(`ID:       ${task.id}`);
  console.log(`Status:   ${icon} ${task.status || 'none'}`);
  console.log(`Priority: ${pIcon} ${task.priority || 'none'}`);
  if (task.due) console.log(`Due:      ${formatDate(task.due)}`);
  if (task.scheduled) console.log(`Scheduled: ${formatDate(task.scheduled)}`);
  if (task.projects?.length) console.log(`Projects: ${task.projects.join(', ')}`);
  if (task.tags?.length) console.log(`Tags:     ${task.tags.join(', ')}`);
  if (task.contexts?.length) console.log(`Contexts: ${task.contexts.join(', ')}`);
  if (task.timeEstimate) console.log(`Estimate: ${task.timeEstimate}`);
  if (task.details) {
    console.log(`\nDetails:\n${task.details}`);
  }
}

async function cmdCreate(args) {
  const title = args._positional[0];
  if (!title) {
    console.error('Usage: tasknotes.mjs create "Task title" [--priority high] [--project Name] [--tags a,b] [--due date] [--details "..."]');
    process.exit(1);
  }

  const body = { title };
  if (args['--priority']) body.priority = args['--priority'];
  if (args['--due']) body.due = args['--due'];
  if (args['--details']) body.details = args['--details'];
  if (args['--project']) body.projects = [args['--project']];
  if (args['--projects']) body.projects = args['--projects'].split(',').map(s => s.trim());
  if (args['--parent']) {
    // --parent sets the parent task as a wikilink project reference
    // This makes the new task a subtask of the parent in TaskNotes
    const parent = args['--parent'];
    const parentLink = parent.startsWith('[[') ? parent : `[[${parent}]]`;
    body.projects = body.projects ? [...body.projects, parentLink] : [parentLink];
  }
  if (args['--tags']) body.tags = args['--tags'].split(',').map(s => s.trim());
  if (args['--contexts']) body.contexts = args['--contexts'].split(',').map(s => s.trim());
  if (args['--estimate']) body.timeEstimate = args['--estimate'];

  const res = await api('POST', '/tasks', body);

  if (!res.data.success) {
    console.error(`Error: ${res.data.message || 'Failed to create task'}`);
    process.exit(1);
  }

  const task = res.data.data;
  const isJson = args['--json'];

  if (isJson) {
    console.log(JSON.stringify(task, null, 2));
    return;
  }

  console.log(`✅ Task created: ${task.title}`);
  if (task.id) console.log(`   ID: ${task.id}`);
  if (task.priority) console.log(`   Priority: ${task.priority}`);
  if (task.projects?.length) console.log(`   Project: ${task.projects.join(', ')}`);
  if (task.due) console.log(`   Due: ${formatDate(task.due)}`);
}

async function cmdSubtasks(args) {
  const titles = args._positional;
  if (titles.length < 2) {
    console.error('Usage: tasknotes.mjs subtasks "Parent Task" "Subtask 1" "Subtask 2" ...');
    console.error('  Options applied to ALL subtasks:');
    console.error('    --priority X        Priority for subtasks (default: normal)');
    console.error('    --project X         Project for parent + subtasks');
    console.error('    --tags X            Tags for subtasks (comma-separated)');
    console.error('    --parent-priority X Priority for parent (default: high)');
    console.error('    --skip-parent       Don\'t create the parent (it already exists)');
    process.exit(1);
  }

  const parentTitle = titles[0];
  const childTitles = titles.slice(1);
  const isJson = args['--json'];
  const skipParent = args['--skip-parent'];
  const parentPriority = args['--parent-priority'] || 'high';
  const childPriority = args['--priority'] || 'normal';
  const tags = args['--tags'] ? args['--tags'].split(',').map(s => s.trim()) : [];
  const project = args['--project'];

  const results = { parent: null, children: [], errors: [] };

  // 1. Create or find parent task
  if (!skipParent) {
    const parentBody = { title: parentTitle, priority: parentPriority, tags: [...tags] };
    if (project) parentBody.projects = [project];
    const parentRes = await api('POST', '/tasks', parentBody);
    if (!parentRes.data.success) {
      console.error(`Error creating parent: ${parentRes.data.message}`);
      process.exit(1);
    }
    results.parent = parentRes.data.data;
    if (!isJson) console.log(`📦 Parent created: ${results.parent.title}`);
  } else {
    if (!isJson) console.log(`📦 Using existing parent: ${parentTitle}`);
  }

  // 2. Create child tasks with parent wikilink
  const parentLink = `[[${parentTitle}]]`;
  for (const childTitle of childTitles) {
    const childBody = {
      title: childTitle,
      priority: childPriority,
      projects: project ? [project, parentLink] : [parentLink],
      tags: [...tags],
    };

    try {
      const childRes = await api('POST', '/tasks', childBody);
      if (childRes.data.success) {
        results.children.push(childRes.data.data);
        if (!isJson) console.log(`  ✅ ${childRes.data.data.title}`);
      } else {
        results.errors.push({ title: childTitle, error: childRes.data.message });
        if (!isJson) console.log(`  ❌ ${childTitle}: ${childRes.data.message}`);
      }
    } catch (err) {
      results.errors.push({ title: childTitle, error: err.message });
      if (!isJson) console.log(`  ❌ ${childTitle}: ${err.message}`);
    }
  }

  if (isJson) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  console.log(`\n${results.children.length}/${childTitles.length} subtasks created under "${parentTitle}"`);
  if (results.errors.length) console.log(`${results.errors.length} failed`);
}

async function cmdNlp(args) {
  const text = args._positional[0];
  if (!text) {
    console.error('Usage: tasknotes.mjs nlp "Buy groceries tomorrow high priority +Personal #errands"');
    process.exit(1);
  }

  const locale = args['--locale'] || 'en';
  const res = await api('POST', '/nlp/create', { text, locale });

  if (!res.data.success) {
    console.error(`Error: ${res.data.message || 'NLP creation failed'}`);
    process.exit(1);
  }

  const data = res.data.data;
  const isJson = args['--json'];

  if (isJson) {
    console.log(JSON.stringify(data, null, 2));
    return;
  }

  const parsed = data.parsed || {};
  const task = data.taskData || data.task || {};
  console.log(`✅ Task created via NLP`);
  console.log(`   Title: ${parsed.title || task.title}`);
  if (parsed.priority && parsed.priority !== 'none') console.log(`   Priority: ${parsed.priority}`);
  if (parsed.scheduledDate) console.log(`   Scheduled: ${formatDate(parsed.scheduledDate)}`);
  if (parsed.tags?.length) console.log(`   Tags: ${parsed.tags.join(', ')}`);
  if (parsed.projects?.length) console.log(`   Projects: ${parsed.projects.join(', ')}`);
  if (task.id) console.log(`   ID: ${task.id}`);
}

async function cmdUpdate(args) {
  const id = args._positional[0];
  if (!id) {
    console.error('Usage: tasknotes.mjs update <id> [--title "..."] [--priority high] [--status todo] [--due date] [--details "..."]');
    process.exit(1);
  }

  const resolved = resolveId(id);
  const body = {};
  if (args['--title']) body.title = args['--title'];
  if (args['--priority']) body.priority = args['--priority'];
  if (args['--status']) body.status = args['--status'];
  if (args['--due']) body.due = args['--due'];
  if (args['--details']) body.details = args['--details'];
  if (args['--tags']) body.tags = args['--tags'].split(',').map(s => s.trim());
  if (args['--project']) body.projects = [args['--project']];

  if (Object.keys(body).length === 0) {
    console.error('Error: No fields to update. Use --title, --priority, --status, --due, --details, --tags, or --project.');
    process.exit(1);
  }

  const res = await api('PUT', `/tasks/${encodeURIComponent(resolved)}`, body);

  if (!res.data.success) {
    console.error(`Error: ${res.data.message || 'Failed to update task'}`);
    process.exit(1);
  }

  const isJson = args['--json'];
  if (isJson) {
    console.log(JSON.stringify(res.data.data, null, 2));
    return;
  }

  console.log(`✅ Task updated: ${resolved}`);
  for (const [k, v] of Object.entries(body)) {
    console.log(`   ${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
  }
}

async function cmdComplete(args) {
  const id = args._positional[0];
  if (!id) {
    console.error('Usage: tasknotes.mjs complete <id>');
    process.exit(1);
  }

  const resolved = resolveId(id);
  const res = await api('POST', `/tasks/${encodeURIComponent(resolved)}/toggle-status`);

  if (!res.data.success) {
    console.error(`Error: ${res.data.message || 'Failed to toggle task status'}`);
    process.exit(1);
  }

  const task = res.data.data;
  const isJson = args['--json'];

  if (isJson) {
    console.log(JSON.stringify(task, null, 2));
    return;
  }

  const newStatus = task?.status || 'toggled';
  const icon = STATUS_ICONS[newStatus] || '·';
  console.log(`${icon} Task ${newStatus}: ${task?.title || resolved}`);
}

async function cmdSearch(args) {
  const body = { filters: {} };

  if (args['--statuses']) body.filters.status = args['--statuses'].split(',').map(s => s.trim());
  if (args['--priorities']) body.filters.priority = args['--priorities'].split(',').map(s => s.trim());
  if (args['--projects']) body.filters.projects = args['--projects'].split(',').map(s => s.trim());
  if (args['--due-before']) body.filters.dueBefore = args['--due-before'];

  if (args['--sort']) {
    const [field, direction] = args['--sort'].split(':');
    body.sort = { field, direction: direction || 'asc' };
  }

  body.page = parseInt(args['--page'] || '1', 10);
  body.limit = parseInt(args['--limit'] || '25', 10);

  const res = await api('POST', '/tasks/query', body);

  if (!res.data.success) {
    console.error(`Error: ${res.data.message || 'Query failed'}`);
    process.exit(1);
  }

  const payload = res.data.data || {};
  const tasks = payload.tasks || (Array.isArray(payload) ? payload : []);
  const isJson = args['--json'];

  if (isJson) {
    console.log(JSON.stringify(tasks, null, 2));
    return;
  }

  console.log(`Search results: ${tasks.length} found\n`);
  console.log(formatTable(tasks, [
    { key: 'title', label: 'Title', maxWidth: 40 },
    { key: 'status', label: 'Status', maxWidth: 15 },
    { key: 'priority', label: 'Priority', maxWidth: 12 },
    { key: 'projects', label: 'Projects', maxWidth: 20 },
    { key: 'scheduled', label: 'Scheduled', maxWidth: 12 },
  ]));
}

async function cmdStats(args) {
  const res = await api('GET', '/stats');

  if (!res.data.success) {
    console.error(`Error: ${res.data.message || 'Failed to get stats'}`);
    process.exit(1);
  }

  const stats = res.data.data;
  const isJson = args['--json'];

  if (isJson) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }

  console.log('📊 Task Statistics');
  console.log('─'.repeat(40));
  for (const [key, value] of Object.entries(stats)) {
    if (typeof value === 'object' && value !== null) {
      console.log(`\n${key}:`);
      for (const [k, v] of Object.entries(value)) {
        console.log(`  ${k}: ${v}`);
      }
    } else {
      console.log(`${key}: ${value}`);
    }
  }
}

// ─── Timer Commands ─────────────────────────────────────────────────────────

function formatMinutes(mins) {
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

async function cmdTimer(args) {
  const sub = args._positional[0];

  if (!sub || sub === '--help' || sub === '-h') {
    console.log(`Timer commands:
  timer start <id>          Start tracking time on a task
    --description "..."     Optional description for this session
  timer stop <id>           Stop tracking time on a task
  timer active              Show all active timer sessions
  timer summary             Show time summary
    --period X              today, week, month, all (default: today)
  timer info <id>           Show time entries for a task
    --json                  Output as JSON`);
    process.exit(0);
  }

  const isJson = args['--json'];

  switch (sub) {
    case 'start': {
      const id = args._positional[1];
      if (!id) {
        console.error('Usage: tasknotes.mjs timer start <id> [--description "..."]');
        process.exit(1);
      }
      const resolved = resolveId(id);
      const description = args['--description'];
      let res;
      if (description) {
        res = await api('POST', `/tasks/${encodeURIComponent(resolved)}/time/start-with-description`, { description });
      } else {
        res = await api('POST', `/tasks/${encodeURIComponent(resolved)}/time/start`);
      }
      if (!res.data.success) {
        console.error(`Error: ${res.data.message || 'Failed to start timer'}`);
        process.exit(1);
      }
      if (isJson) {
        console.log(JSON.stringify(res.data.data, null, 2));
        return;
      }
      const data = res.data.data;
      const task = data?.task || data;
      console.log(`⏱️  Timer started: ${task?.title || resolved}`);
      if (description) console.log(`   Description: ${description}`);
      break;
    }

    case 'stop': {
      const id = args._positional[1];
      if (!id) {
        console.error('Usage: tasknotes.mjs timer stop <id>');
        process.exit(1);
      }
      const resolved = resolveId(id);
      const res = await api('POST', `/tasks/${encodeURIComponent(resolved)}/time/stop`);
      if (!res.data.success) {
        console.error(`Error: ${res.data.message || 'Failed to stop timer'}`);
        process.exit(1);
      }
      if (isJson) {
        console.log(JSON.stringify(res.data.data, null, 2));
        return;
      }
      const task = res.data.data;
      const lastEntry = task?.timeEntries?.[task.timeEntries.length - 1];
      const duration = lastEntry?.duration;
      console.log(`⏹️  Timer stopped: ${task?.title || resolved}`);
      if (duration != null) console.log(`   Session: ${formatMinutes(duration)}`);
      break;
    }

    case 'active': {
      const res = await api('GET', '/time/active');
      if (!res.data.success) {
        console.error(`Error: ${res.data.message || 'Failed to get active sessions'}`);
        process.exit(1);
      }
      const data = res.data.data;
      if (isJson) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      const sessions = data?.activeSessions || [];
      if (sessions.length === 0) {
        console.log('No active timer sessions.');
        return;
      }
      console.log(`⏱️  Active Sessions: ${sessions.length}\n`);
      for (const s of sessions) {
        const task = s.task || {};
        const session = s.session || {};
        console.log(`  ${task.title || task.id}`);
        console.log(`    Elapsed: ${formatMinutes(s.elapsedMinutes)}`);
        if (session.description) console.log(`    Description: ${session.description}`);
        if (task.projects?.length) console.log(`    Project: ${task.projects.join(', ')}`);
        console.log();
      }
      if (data.totalElapsedMinutes != null) {
        console.log(`Total active: ${formatMinutes(data.totalElapsedMinutes)}`);
      }
      break;
    }

    case 'summary': {
      const period = args['--period'] || 'today';
      const params = new URLSearchParams({ period });
      if (args['--from']) params.set('from', args['--from']);
      if (args['--to']) params.set('to', args['--to']);
      const res = await api('GET', `/time/summary?${params.toString()}`);
      if (!res.data.success) {
        console.error(`Error: ${res.data.message || 'Failed to get time summary'}`);
        process.exit(1);
      }
      const data = res.data.data;
      if (isJson) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      const summary = data?.summary || {};
      console.log(`📊 Time Summary (${data?.period || period})`);
      console.log('─'.repeat(40));
      console.log(`Total: ${formatMinutes(summary.totalMinutes || 0)} (${summary.totalHours || 0}h)`);
      console.log(`Tasks with time: ${summary.tasksWithTime || 0}`);
      console.log(`Active: ${summary.activeTasks || 0}  Completed: ${summary.completedTasks || 0}`);

      const topTasks = data?.topTasks || [];
      if (topTasks.length > 0) {
        console.log(`\nTop Tasks:`);
        for (const t of topTasks) {
          console.log(`  ${truncate(t.title, 35).padEnd(35)}  ${formatMinutes(t.minutes)}`);
        }
      }

      const topProjects = data?.topProjects || [];
      if (topProjects.length > 0) {
        console.log(`\nBy Project:`);
        for (const p of topProjects) {
          console.log(`  ${truncate(p.project, 25).padEnd(25)}  ${formatMinutes(p.minutes)}`);
        }
      }
      break;
    }

    case 'info': {
      const id = args._positional[1];
      if (!id) {
        console.error('Usage: tasknotes.mjs timer info <id>');
        process.exit(1);
      }
      const resolved = resolveId(id);
      const res = await api('GET', `/tasks/${encodeURIComponent(resolved)}/time`);
      if (!res.data.success) {
        console.error(`Error: ${res.data.message || 'Failed to get time data'}`);
        process.exit(1);
      }
      const data = res.data.data;
      if (isJson) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }
      const task = data?.task || {};
      const summary = data?.summary || {};
      console.log(`⏱️  ${task.title || resolved}`);
      console.log('─'.repeat(40));
      console.log(`Total: ${formatMinutes(summary.totalMinutes || 0)} (${summary.totalHours || 0}h)`);
      console.log(`Sessions: ${summary.totalSessions || 0} (${summary.completedSessions || 0} done, ${summary.activeSessions || 0} active)`);
      if (summary.averageSessionMinutes) console.log(`Avg session: ${formatMinutes(Math.round(summary.averageSessionMinutes))}`);

      if (data?.activeSession) {
        const active = data.activeSession;
        console.log(`\n🟢 Active session: ${formatMinutes(active.elapsedMinutes)} elapsed`);
        if (active.description) console.log(`   ${active.description}`);
      }

      const entries = data?.timeEntries || [];
      if (entries.length > 0) {
        console.log(`\nEntries:`);
        for (const e of entries) {
          const start = formatDate(e.startTime);
          const status = e.isActive ? '🟢 active' : `${formatMinutes(e.duration || 0)}`;
          const desc = e.description ? ` — ${e.description}` : '';
          console.log(`  ${start}  ${status}${desc}`);
        }
      }
      break;
    }

    default:
      console.error(`Unknown timer subcommand: ${sub}`);
      console.log('Available: start, stop, active, summary, info');
      process.exit(1);
  }
}

// ─── Main Router ────────────────────────────────────────────────────────────
const [cmd, ...rest] = process.argv.slice(2);

if (!cmd || cmd === '--help' || cmd === '-h') {
  console.log(`tasknotes.mjs — TaskNotes CLI for Claude Code

Commands:
  list                  List tasks
    --status X          Filter: todo, done, archived
    --priority X        Filter: high, medium, low, none
    --project X         Filter by project name
    --tags X            Filter by tags (comma-separated)
    --due X             Filter: today, overdue, YYYY-MM-DD
    --sort X            Sort: priority, due, created
    --limit N           Max results (default: 20)
    --json              Output as JSON

  get <id>              Get task details
    --json              Output as JSON

  create "title"        Create a task
    --priority X        high, medium, low, none
    --project X         Project name
    --parent X          Parent task title (makes this a subtask)
    --tags X            Comma-separated tags
    --due X             Due date (YYYY-MM-DD or natural)
    --details "..."     Task description
    --estimate X        Time estimate (e.g., 30min, 2h)
    --json              Output as JSON

  subtasks "parent" "child1" "child2" ...  Create parent + subtasks
    --priority X        Priority for subtasks (default: normal)
    --parent-priority X Priority for parent (default: high)
    --project X         Project for all tasks
    --tags X            Tags for subtasks
    --skip-parent       Parent already exists, just create children
    --json              Output as JSON

  nlp "text"            Create via natural language
    --locale X          Language (default: en)
    --json              Output as JSON

  update <id>           Update task fields
    --title "..."       New title
    --priority X        New priority
    --status X          New status
    --due X             New due date
    --details "..."     New details
    --tags X            New tags (comma-separated)
    --project X         New project
    --json              Output as JSON

  complete <id>         Toggle task done/todo

  search                Advanced query
    --statuses X        Comma-separated statuses
    --priorities X      Comma-separated priorities
    --projects X        Comma-separated projects
    --due-before X      Due before date
    --sort field:dir    Sort (e.g., due:asc)
    --limit N           Max results
    --json              Output as JSON

  stats                 Show statistics
    --json              Output as JSON

  timer start <id>      Start time tracking
    --description "..."  Session description
  timer stop <id>       Stop time tracking
  timer active          Show active sessions
  timer summary         Time summary
    --period X          today, week, month, all
  timer info <id>       Time entries for a task
    --json              Output as JSON

ID Format:
  Full path:   TaskNotes/Tasks/my-task.md
  Short:       my-task (auto-expands to TaskNotes/Tasks/my-task.md)

API: localhost:8081
`);
  process.exit(0);
}

const args = parseArgs(rest);

switch (cmd) {
  case 'list':     await cmdList(args); break;
  case 'get':      await cmdGet(args); break;
  case 'create':   await cmdCreate(args); break;
  case 'subtasks': await cmdSubtasks(args); break;
  case 'nlp':      await cmdNlp(args); break;
  case 'update':   await cmdUpdate(args); break;
  case 'complete': await cmdComplete(args); break;
  case 'search':   await cmdSearch(args); break;
  case 'stats':    await cmdStats(args); break;
  case 'timer':    await cmdTimer(args); break;
  default:
    console.error(`Unknown command: ${cmd}`);
    console.log('Available: list, get, create, subtasks, nlp, update, complete, search, stats, timer');
    process.exit(1);
}
