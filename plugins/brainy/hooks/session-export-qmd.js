// session-export-qmd.js
// Hook: Stop — Exports current session's JSONL conversation to clean markdown
// and updates QMD index so past conversations are searchable.
//
// Flow:
// 1. Find current session JSONL from ~/.claude/projects/{encoded-cwd}/
// 2. Parse: extract user messages + assistant text (skip tool_use, system, snapshots)
// 3. Write clean markdown to vault: 2. Areas/Sessions/Transcripts/{date}-{slug}.md
// 4. Run `qmd update -c vault` to re-index
//
// This runs after session-auto-close.js so the session note is already written.

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const VAULT_DIR = path.join(process.env.USERPROFILE, 'Obsidian Vault');
const TRANSCRIPTS_DIR = path.join(VAULT_DIR, '2. Areas', 'Sessions', 'Transcripts');
const CLAUDE_PROJECTS_DIR = path.join(process.env.USERPROFILE, '.claude', 'projects');
const QMD_PATH = path.join(process.env.APPDATA, 'npm', 'node_modules', '@tobilu', 'qmd', 'dist', 'qmd.js');
const NODE_PATH = 'C:\\Program Files\\nodejs\\node.exe';

function encodeCwd(cwd) {
  // Claude Code encodes CWD: C:\Users\HamCh\code\workspace -> C--Users-HamCh-code-workspace
  return cwd.replace(/[:\\\/]/g, '-').replace(/^-+/, '');
}

function findCurrentSessionJsonl(cwd) {
  const projectDir = path.join(CLAUDE_PROJECTS_DIR, encodeCwd(cwd));
  if (!fs.existsSync(projectDir)) return null;

  // Find most recently modified JSONL file
  const jsonlFiles = fs.readdirSync(projectDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      name: f,
      path: path.join(projectDir, f),
      mtime: fs.statSync(path.join(projectDir, f)).mtimeMs
    }))
    .sort((a, b) => b.mtime - a.mtime);

  return jsonlFiles.length > 0 ? jsonlFiles[0] : null;
}

function parseJsonl(filepath) {
  const lines = fs.readFileSync(filepath, 'utf8').split('\n').filter(Boolean);
  const messages = [];
  let sessionMeta = null;

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      // Grab session metadata from first user message
      if (!sessionMeta && entry.type === 'user' && entry.sessionId) {
        sessionMeta = {
          sessionId: entry.sessionId,
          slug: entry.slug || 'session',
          cwd: entry.cwd || '',
          timestamp: entry.timestamp,
          version: entry.version || ''
        };
      }

      // Skip non-message types
      if (entry.type !== 'user' && entry.type !== 'assistant') continue;

      const msg = entry.message;
      if (!msg || !msg.content) continue;

      // Extract text content
      let text = '';
      if (typeof msg.content === 'string') {
        text = msg.content.trim();
      } else if (Array.isArray(msg.content)) {
        // Only take text blocks, skip tool_use, tool_result, thinking
        text = msg.content
          .filter(block => block.type === 'text' && block.text)
          .map(block => block.text.trim())
          .filter(Boolean)
          .join('\n\n');
      }

      if (!text) continue;

      messages.push({
        role: msg.role,
        text,
        timestamp: entry.timestamp
      });
    } catch {
      continue;
    }
  }

  return { messages, meta: sessionMeta };
}

function buildMarkdown(messages, meta) {
  const date = meta.timestamp ? new Date(meta.timestamp).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
  const folderName = meta.cwd ? path.basename(meta.cwd) : 'unknown';

  const parts = [];

  // Frontmatter
  parts.push('---');
  parts.push(`type: transcript`);
  parts.push(`session_id: "${meta.sessionId}"`);
  parts.push(`project_folder: "${folderName}"`);
  parts.push(`date: ${date}`);
  parts.push(`slug: "${meta.slug}"`);
  parts.push(`messages: ${messages.length}`);
  parts.push(`tags:\n  - transcript\n  - session`);
  parts.push('---');
  parts.push('');

  // Title
  parts.push(`# Session Transcript — ${date} — ${meta.slug}`);
  parts.push(`Project: \`${folderName}\` | Messages: ${messages.length}`);
  parts.push('');

  // Messages
  for (const msg of messages) {
    const label = msg.role === 'user' ? '## User' : '## Assistant';
    parts.push(label);
    parts.push('');
    parts.push(msg.text);
    parts.push('');
  }

  return { content: parts.join('\n'), date, slug: meta.slug };
}

function updateQmdIndex() {
  try {
    execSync(`"${NODE_PATH}" "${QMD_PATH}" update -c vault`, {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 30000
    });
  } catch {
    // Non-blocking — index will catch up on next update
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const cwd = process.cwd();

    // Find current session JSONL
    const jsonlFile = findCurrentSessionJsonl(cwd);
    if (!jsonlFile) {
      process.exit(0);
    }

    // Parse
    const { messages, meta } = parseJsonl(jsonlFile.path);
    if (!messages.length || !meta) {
      process.exit(0);
    }

    // Skip tiny sessions (less than 4 messages = probably just a quick question)
    if (messages.length < 4) {
      process.exit(0);
    }

    // Build markdown
    const { content, date, slug } = buildMarkdown(messages, meta);

    // Ensure transcripts directory exists
    if (!fs.existsSync(TRANSCRIPTS_DIR)) {
      fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
    }

    // Write transcript
    const filename = `${date}-${slug}.md`;
    const filepath = path.join(TRANSCRIPTS_DIR, filename);

    // Don't overwrite if already exported (e.g., multiple stops)
    if (fs.existsSync(filepath)) {
      // Update in place — session may have continued
      fs.writeFileSync(filepath, content, 'utf8');
    } else {
      fs.writeFileSync(filepath, content, 'utf8');
    }

    // Update QMD index
    updateQmdIndex();

    process.stderr.write(`Session exported: ${filename} (${messages.length} messages)\n`);
    process.exit(0);
  } catch (e) {
    // Don't block stop
    process.exit(0);
  }
});
