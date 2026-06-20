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

const path = require('path');
const os = require('os');
const fs = require('fs');
const log = require(path.join(__dirname, 'lib', 'hook-logger.js'));
const reindex = require(path.join(__dirname, 'lib', 'qmd-reindex.js'));
const summary = require(path.join(__dirname, 'lib', 'session-summary.js'));

const HOOK = 'session-export-qmd';

const { getVaultRoot } = require(path.join(__dirname, '..', 'scripts', 'lib', 'vault-root.js'));
const VAULT_DIR = getVaultRoot();
const TRANSCRIPTS_DIR = path.join(VAULT_DIR, '2. Areas', 'Sessions', 'Transcripts');
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
// Use braynee's bundled qmd-wrapper (cross-platform) — handles qmd discovery internally.
const QMD_WRAPPER = path.join(__dirname, '..', 'scripts', 'qmd-wrapper.mjs');

function encodeCwd(cwd) {
  // Claude Code encodes CWD by replacing every non-word/non-hyphen char with `-`.
  // Examples:
  //   C:\Users\HamCh\code\workspace        -> C--Users-HamCh-code-workspace
  //   C:\Users\HamCh\Obsidian Vault         -> C--Users-HamCh-Obsidian-Vault (space too)
  //   C:\Users\HamCh\Obsidian Vault\1. Projects -> C--Users-HamCh-Obsidian-Vault-1--Projects
  // The old regex only handled : \ / and missed spaces + periods, so paths like
  // "Obsidian Vault" silently failed JSONL lookup.
  return cwd.replace(/[^\w-]/g, '-').replace(/^-+/, '');
}

function findCurrentSessionJsonl(cwd, transcriptPath) {
  // cp-wqi / HD-R1.1: Claude Code passes the conversation transcript path
  // on stdin as the documented common input field data.transcript_path
  // (guaranteed every event). Prefer it directly when present — sidesteps
  // the fragile cwd→encoded-projects-dir reconstruction (cp-d9g). The
  // directory scan below is kept as a defensive fallback for when absent.
  if (typeof transcriptPath === 'string' && transcriptPath && fs.existsSync(transcriptPath)) {
    return {
      name: path.basename(transcriptPath),
      path: transcriptPath,
      mtime: fs.statSync(transcriptPath).mtimeMs
    };
  }

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

// Resolve a cwd folder slug (e.g. "resincraft", "myrp-build", "sophon-make-app")
// to the real project note under "1. Projects/" (or "4. Archives/Projects/") so the
// transcript carries a graph-visible `project: "[[...]]"` wikilink and isn't orphaned.
// Matching: alphanumeric-normalized exact, then safe prefix (project basename >=6 chars).
function resolveProjectLink(folderName) {
  try {
    const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
    const target = norm(folderName);
    if (!target) return null;
    const candidates = new Map(); // norm(basename) -> rel path without .md
    const walk = (dir) => {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.name.endsWith('.md')) continue;
        const base = e.name.replace(/\.md$/, '');
        if (base.startsWith('_')) continue; // skip _index.md placeholders
        const rel = path.relative(VAULT_DIR, full).split(path.sep).join('/').replace(/\.md$/, '');
        const n = norm(base);
        if (n && !candidates.has(n)) candidates.set(n, rel);
      }
    };
    walk(path.join(VAULT_DIR, '1. Projects'));
    walk(path.join(VAULT_DIR, '4. Archives', 'Projects'));
    if (candidates.has(target)) return candidates.get(target);
    let best = null; // longest prefix match
    for (const [n, rel] of candidates) {
      if (n.length >= 6 && target.startsWith(n) && target.length > n.length) {
        if (!best || n.length > best.n.length) best = { n, rel };
      }
    }
    return best ? best.rel : null;
  } catch {
    return null;
  }
}

function buildMarkdown(messages, meta) {
  const date = meta.timestamp ? new Date(meta.timestamp).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
  const folderName = meta.cwd ? path.basename(meta.cwd) : 'unknown';
  const projectLink = resolveProjectLink(folderName);

  const parts = [];

  // Frontmatter
  parts.push('---');
  parts.push(`type: transcript`);
  parts.push(`session_id: "${meta.sessionId}"`);
  if (projectLink) parts.push(`project: "[[${projectLink}]]"`);
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
  // Cheap BM25 reindex (single-flight; skips if an embed is in flight).
  const kw = reindex.runKeywordUpdate(QMD_WRAPPER);
  // Throttled, detached vector embed so stale embeddings self-heal instead
  // of drifting (braynee never ran `qmd embed` before — see beads cp-8xq).
  const em = reindex.scheduleEmbed(QMD_WRAPPER);
  // Throttled, detached, incremental session-summary sweep so the raw
  // transcript exported above also gets a structured per-project note
  // automatically (was manual-only via the session-backfill skill — cp-z0c).
  const sm = summary.scheduleSummaryBackfill();
  return { kw, em, sm };
}

// ─── Main ────────────────────────────────────────────────────────────────────
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    let data = {};
    if (input) {
      try { data = JSON.parse(input); } catch { data = {}; }
    }
    // cp-wqi / HD-R1.1: prefer the documented data.transcript_path from
    // stdin; the cwd fall-through still uses the event cwd (data.cwd),
    // not the transient process.cwd().
    const cwd = data.cwd || process.cwd();

    // Find current session JSONL
    const jsonlFile = findCurrentSessionJsonl(cwd, data.transcript_path);
    if (!jsonlFile) {
      log.info(HOOK, `skipped: no JSONL found at ~/.claude/projects/${encodeCwd(cwd)}/ (cwd-encoding mismatch?)`);
      process.exit(0);
    }

    // Parse
    const { messages, meta } = parseJsonl(jsonlFile.path);
    if (!messages.length || !meta) {
      log.info(HOOK, `skipped: parsed ${messages.length} messages, meta=${meta ? 'set' : 'null'} from ${jsonlFile.name}`);
      process.exit(0);
    }

    // Skip empty / single-turn sessions only — anything 2+ messages is worth
    // preserving. The old <4 threshold silently dropped useful Q&As.
    if (messages.length < 2) {
      log.info(HOOK, `skipped: only ${messages.length} message(s) — below 2-msg minimum`);
      process.exit(0);
    }

    // Build markdown
    const { content, date, slug } = buildMarkdown(messages, meta);

    // Ensure transcripts directory exists
    if (!fs.existsSync(TRANSCRIPTS_DIR)) {
      fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
    }

    // Filename includes session ID prefix to prevent same-day same-slug
    // collisions across different sessions (the old `${date}-${slug}.md`
    // pattern caused every default-slug session to clobber the previous one
    // because slug defaults to "session" when entry.slug is unset).
    const sidPrefix = (meta.sessionId || '').slice(0, 8) || 'nosid000';
    const filename = `${date}-${slug}-${sidPrefix}.md`;
    const filepath = path.join(TRANSCRIPTS_DIR, filename);

    // Same-session re-Stop (compact, resume, multi-turn): overwrite the file
    // since session ID is now in the filename, this only ever matches the
    // SAME session — never a different session's transcript.
    fs.writeFileSync(filepath, content, 'utf8');

    // Reindex QMD (cheap BM25 now; embed throttled + detached).
    const rx = updateQmdIndex();

    log.info(HOOK, `exported ${filename} (${messages.length} msgs); qmd update=${rx.kw.ran ? 'ok' : rx.kw.reason}, embed=${rx.em.scheduled ? 'scheduled' : rx.em.reason}, summary=${rx.sm.scheduled ? 'scheduled' : rx.sm.reason}`);
    process.stderr.write(`Session exported: ${filename} (${messages.length} messages)\n`);
    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    // Don't block stop
    process.exit(0);
  }
});
