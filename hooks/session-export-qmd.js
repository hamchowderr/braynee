// session-export-qmd.js
// Hook: Stop — keeps the vault's search index current at the end of a session
// and schedules the distillation of this session into a structured note.
//
// Flow:
// 1. Find current session JSONL from ~/.claude/projects/{encoded-cwd}/
// 2. Parse it far enough to confirm this was a real session worth acting on
// 3. Run `qmd update -c vault` to re-index, and schedule embed + summary
//
// It does NOT write the raw transcript into the vault — see the note at the
// write site. The vault holds the distilled summary; the raw conversation
// stays at its source in ~/.claude/projects. The name is kept for continuity
// with existing hook wiring.
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
const { resolveProjectLink } = require(path.join(__dirname, 'lib', 'project-resolver.js'));
const VAULT_DIR = getVaultRoot();
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

function buildMarkdown(messages, meta) {
  const date = meta.timestamp ? new Date(meta.timestamp).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
  const folderName = meta.cwd ? path.basename(meta.cwd) : 'unknown';
  const projectLink = resolveProjectLink(folderName, VAULT_DIR);

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

    // Raw transcripts are deliberately NOT written to the vault.
    //
    // They duplicated ~/.claude/projects/*.jsonl verbatim while accounting for
    // ~79% of the vault's markdown (82 MB across 2.6k files vs 7.6 MB of
    // distilled notes). Worse, they outranked the distilled per-project
    // summaries in search — a vector query for "mastra agent deployment"
    // returned three raw transcripts above the actual curated note — and they
    // made up essentially the entire embedding backlog.
    //
    // Nothing downstream depends on a vault copy: the summary pipeline
    // (skills/session-backfill) reads the raw .jsonl straight from
    // ~/.claude/projects, and braynee:recap does its temporal scans there too.
    // The vault keeps the distilled summary; the raw conversation stays at its
    // source. This is the vault's own rule — it is the thinking layer, not a
    // transcript archive.
    const { date, slug } = buildMarkdown(messages, meta);
    const sidPrefix = (meta.sessionId || '').slice(0, 8) || 'nosid000';
    const sessionLabel = `${date}-${slug}-${sidPrefix}`;

    // Reindex QMD (cheap BM25 now; embed throttled + detached).
    const rx = updateQmdIndex();

    log.info(HOOK, `session ${sessionLabel} (${messages.length} msgs, transcript not vaulted); qmd update=${rx.kw.ran ? 'ok' : rx.kw.reason}, embed=${rx.em.scheduled ? 'scheduled' : rx.em.reason}, summary=${rx.sm.scheduled ? 'scheduled' : rx.sm.reason}`);
    process.exit(0);
  } catch (e) {
    log.error(HOOK, `crash: ${e.message}`);
    // Don't block stop
    process.exit(0);
  }
});
