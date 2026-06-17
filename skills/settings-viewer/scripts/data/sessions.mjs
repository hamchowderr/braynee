// Session transcript index for the Second Brain Dashboard.
//
// Why this exists: Claude Code's native /resume picker only DISPLAYS the most
// recent ~50 sessions per folder, but every session persists on disk as a JSONL
// transcript under ~/.claude/projects/<encoded-cwd>/<session-id>.jsonl (retained
// for `cleanupPeriodDays`). Users routinely have thousands of sessions they can
// no longer find in the picker. This loader indexes ALL of them so the dashboard
// can surface + search the full history, each with a copy-able `claude --resume`.
//
// Cost discipline: there can be thousands of transcripts totalling multiple GB.
// We NEVER read a whole file. We stream the head of each one and bail the moment
// we have what we need (a clean first-message preview + the cwd), with hard line
// and byte caps as a backstop. stat() gives us mtime + size for free.
import { readdirSync, statSync, createReadStream, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createInterface } from 'readline';

// Backstops so a transcript with huge leading attachments can never make us read
// the whole file just to find the first human turn.
const MAX_LINES_SCAN = 600;
const MAX_BYTES_SCAN = 1024 * 1024; // 1 MB
const PREVIEW_LEN = 180;
const MAX_USER_TRIES = 6; // first few user turns are often just caveat/command wrappers

// Mirror of data/claude.mjs's path helpers — kept here so this module is
// self-contained. decodeDirName is a fallback for when a transcript carries no
// `cwd` field; encodePath maps real cwds back to their on-disk dir names.
function decodeDirName(enc) {
  return enc.replace('--', ':/').replace(/-/g, '/');
}
function encodePath(p) {
  return p.replace(/:/g, '--').replace(/[/\\]/g, '-').replace(/ /g, '-');
}

// The first user turn is usually wrapped in slash-command / caveat / transcript
// scaffolding. Turn that into something a human recognizes at a glance.
export function cleanPreview(raw) {
  if (!raw) return '';
  let t = String(raw);

  // Slash command? Surface the command itself — that's the most recognizable label.
  const cmd = t.match(/<command-name>\s*([^<\n]+?)\s*<\/command-name>/);
  if (cmd) {
    const args = t.match(/<command-args>\s*([^<\n]*?)\s*<\/command-args>/);
    const a = args && args[1] ? args[1].trim() : '';
    return (cmd[1].trim() + (a ? ' ' + a : '')).trim();
  }

  // Strip known wrapper blocks wholesale.
  t = t.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, ' ');
  t = t.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, ' ');
  t = t.replace(/<command-message>[\s\S]*?<\/command-message>/g, ' ');
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ');
  // Any remaining stray tags.
  t = t.replace(/<[^>]+>/g, ' ');
  // Plain (untagged) caveat sentence used by older transcripts.
  t = t.replace(/Caveat:[\s\S]*?running local commands\.[\s\S]*?messages\./i, ' ');
  // Continuation/recap sessions begin "Session transcript:" with USER:/ASST: markers.
  t = t.replace(/Session transcript:/gi, ' ').replace(/\b(USER|ASST|ASSISTANT)\s*:/g, ' ');

  return t.replace(/\s+/g, ' ').trim().slice(0, PREVIEW_LEN);
}

function extractText(message) {
  const c = message && message.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    const txt = c.find(x => x && x.type === 'text' && typeof x.text === 'string');
    return txt ? txt.text : '';
  }
  return '';
}

// Stream the head of one transcript, stopping as early as possible.
function readSessionHead(filePath) {
  return new Promise((resolve) => {
    const out = { preview: '', cwd: '', gitBranch: '', startedTs: '' };
    let lines = 0, bytes = 0, tries = 0, done = false;

    const stream = createReadStream(filePath, { encoding: 'utf8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    const finish = () => {
      if (done) return;
      done = true;
      try { rl.close(); } catch {}
      try { stream.destroy(); } catch {}
      resolve(out);
    };

    rl.on('line', (line) => {
      if (done) return;
      lines++; bytes += line.length + 1;
      let o;
      try { o = JSON.parse(line); } catch { return; }

      if (!out.cwd && o.cwd) out.cwd = o.cwd;
      if (!out.gitBranch && o.gitBranch) out.gitBranch = o.gitBranch;
      if (!out.startedTs && o.timestamp) out.startedTs = o.timestamp;

      if (!out.preview && o.type === 'user' && o.message) {
        const cleaned = cleanPreview(extractText(o.message));
        if (cleaned) out.preview = cleaned;
        else tries++;
      }

      // We have everything useful, or we've scanned far enough — stop reading.
      if ((out.preview && out.cwd) || tries >= MAX_USER_TRIES ||
          lines >= MAX_LINES_SCAN || bytes >= MAX_BYTES_SCAN) {
        finish();
      }
    });
    rl.on('close', finish);
    stream.on('error', finish);
  });
}

export async function loadSessions() {
  const home = homedir();
  const root = join(home, '.claude', 'projects');

  // Resolve accurate cwds from .claude.json's project map (keyed by real path).
  // Falls back to the naive dir-name decode when a path isn't listed there.
  let dotClaudeByEncoded = {};
  try {
    const c = JSON.parse(readFileSync(join(home, '.claude.json'), 'utf8'));
    for (const p of Object.keys(c.projects || {})) {
      dotClaudeByEncoded[encodePath(p)] = p;
    }
  } catch {}

  // 1) Enumerate every top-level transcript (subagent transcripts live in
  //    nested subdirs and are intentionally skipped — they aren't resumable).
  const files = [];
  let dirs = [];
  try { dirs = readdirSync(root, { withFileTypes: true }); } catch { return emptyResult(); }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dirPath = join(root, d.name);
    const decodedPath = dotClaudeByEncoded[d.name] || decodeDirName(d.name);
    const projectName = decodedPath.split(/[/\\]/).filter(Boolean).pop() || d.name;
    let entries = [];
    try { entries = readdirSync(dirPath); } catch { continue; }
    for (const f of entries) {
      if (!f.endsWith('.jsonl')) continue;
      let stat;
      try { stat = statSync(join(dirPath, f)); } catch { continue; }
      if (!stat.isFile()) continue;
      files.push({
        id: f.slice(0, -6), // strip ".jsonl"
        path: join(dirPath, f),
        projectName,
        projectPath: decodedPath,
        mtimeMs: stat.mtimeMs,
        sizeBytes: stat.size,
      });
    }
  }

  // 2) Newest first — the head scan is the expensive part, so do it after we know
  //    the full set (lets us cap previews to the most relevant if ever needed).
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);

  // 3) Extract a preview for each (bounded per-file reads, run concurrently in
  //    capped batches so thousands of files don't open thousands of fds at once).
  const sessions = [];
  const BATCH = 48;
  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const heads = await Promise.all(batch.map(f => readSessionHead(f.path)));
    batch.forEach((f, j) => {
      const h = heads[j];
      sessions.push({
        id: f.id,
        project: f.projectName,
        cwd: h.cwd || f.projectPath,
        gitBranch: h.gitBranch || '',
        mtimeMs: f.mtimeMs,
        sizeBytes: f.sizeBytes,
        preview: h.preview || '',
      });
    });
  }

  const totalSizeBytes = sessions.reduce((s, x) => s + x.sizeBytes, 0);
  const projectCount = new Set(sessions.map(s => s.project)).size;
  const mtimes = sessions.map(s => s.mtimeMs);

  return {
    sessions,
    totalSessions: sessions.length,
    totalSizeBytes,
    projectCount,
    oldestMs: mtimes.length ? Math.min(...mtimes) : 0,
    newestMs: mtimes.length ? Math.max(...mtimes) : 0,
  };
}

function emptyResult() {
  return { sessions: [], totalSessions: 0, totalSizeBytes: 0, projectCount: 0, oldestMs: 0, newestMs: 0 };
}
