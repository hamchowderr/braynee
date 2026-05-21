const fs = require('fs');
const path = require('path');
const readline = require('readline');

// ── Paths (generic, works for any user on any OS) ──────────────────────
const HOME = process.env.USERPROFILE || process.env.HOME;
const CLAUDE_DIR = path.join(HOME, '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const FACETS_DIR = path.join(CLAUDE_DIR, 'usage-data', 'facets');
const STATS_CACHE_PATH = path.join(CLAUDE_DIR, 'stats-cache.json');
const HISTORY_PATH = path.join(CLAUDE_DIR, 'history.jsonl');
const OUTPUT_PATH = path.join(CLAUDE_DIR, 'usage-data', 'insightful-data.json');

// ── Helpers ─────────────────────────────────────────────────────────────

function readJsonSafe(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

/**
 * Derive a short friendly name from a full project path.
 * "C:\Users\<you>\code\my-app" → "my-app"
 * "C:\Users\<you>\code\some-sdk" → "some-sdk"
 * "C:\Users\<you>" → "home"
 * "/home/<you>/projects/my-app" → "my-app"
 */
function friendlyName(fullPath) {
  if (!fullPath) return 'unknown';
  const norm = fullPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const home = HOME.replace(/\\/g, '/').replace(/\/+$/, '');
  if (norm === home) return 'home';
  // Use the last path segment, or last two if the last one is generic
  const parts = norm.split('/').filter(Boolean);
  const last = parts[parts.length - 1];
  if (['code', 'projects', 'src', 'dev', 'repos'].includes(last.toLowerCase())) {
    return parts.slice(-2).join('/');
  }
  return last;
}

/**
 * Convert a projects dir name back to a real path.
 * "C--Users-you-code-myapp" → "C:\Users\you\code\myapp"
 * Works by reversing Claude Code's encoding: replace leading drive-- and subsequent -- with separators.
 */
function projectDirToPath(dirName) {
  // Claude Code encodes path separators (\ and :) as '-', so the original
  // path can't be perfectly reversed. Return as-is for display and rely on
  // history.jsonl for the real paths.
  return dirName;
}

// ── Phase 1: Parse history.jsonl (THE primary source of truth) ──────────

async function parseHistory() {
  const sessions = {}; // sessionId → { prompts, project, timestamps }

  if (!fs.existsSync(HISTORY_PATH)) {
    console.error('[insightful] WARNING: history.jsonl not found — session discovery will be limited');
    return sessions;
  }

  return new Promise((resolve) => {
    const stream = fs.createReadStream(HISTORY_PATH, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let lineCount = 0;

    rl.on('line', (line) => {
      lineCount++;
      if (!line.trim()) return;
      let entry;
      try { entry = JSON.parse(line); } catch { return; }

      const sid = entry.sessionId;
      const project = entry.project || null;
      const ts = entry.timestamp; // Unix ms
      const display = entry.display || '';
      const pasted = entry.pastedContents || '';

      if (!sessions[sid]) {
        sessions[sid] = {
          session_id: sid,
          project_path: project,
          prompts: [],
          first_timestamp_ms: ts,
          last_timestamp_ms: ts,
          prompt_count: 0,
        };
      }

      const s = sessions[sid];
      if (ts && (!s.first_timestamp_ms || ts < s.first_timestamp_ms)) s.first_timestamp_ms = ts;
      if (ts && (!s.last_timestamp_ms || ts > s.last_timestamp_ms)) s.last_timestamp_ms = ts;
      s.prompt_count++;

      // Keep first 3 prompts for context (truncated)
      if (s.prompts.length < 3 && display) {
        s.prompts.push(display.substring(0, 200));
      }
      // Update project path if we didn't have one
      if (!s.project_path && project) s.project_path = project;
    });

    rl.on('close', () => {
      console.error(`[insightful] history.jsonl: ${lineCount} lines, ${Object.keys(sessions).length} sessions`);
      resolve(sessions);
    });

    rl.on('error', (err) => {
      console.error('[insightful] Error reading history.jsonl:', err.message);
      resolve(sessions);
    });
  });
}

// ── Phase 2: Extract detailed metadata from .jsonl session files ────────

async function extractSessionMetadata(filePath, sessionId) {
  const meta = {
    session_id: sessionId,
    source: 'jsonl',
    first_timestamp: null,
    last_timestamp: null,
    user_message_count: 0,
    assistant_message_count: 0,
    first_prompt: null,
    tools_used: {},
    models: new Set(),
    total_output_tokens: 0,
    total_input_tokens: 0,
    git_commits: 0,
    version: null,
    git_branch: null,
    permission_mode: null,
    slug: null,
  };

  return new Promise((resolve) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    rl.on('line', (line) => {
      if (!line.trim()) return;
      let entry;
      try { entry = JSON.parse(line); } catch { return; }
      if (entry.type === 'file-history-snapshot') return;

      const ts = entry.timestamp;
      if (ts) {
        if (!meta.first_timestamp || ts < meta.first_timestamp) meta.first_timestamp = ts;
        if (!meta.last_timestamp || ts > meta.last_timestamp) meta.last_timestamp = ts;
      }

      if (entry.type === 'user') {
        meta.user_message_count++;
        if (!meta.first_prompt && entry.message && entry.message.content) {
          const content = typeof entry.message.content === 'string'
            ? entry.message.content : JSON.stringify(entry.message.content);
          meta.first_prompt = content.substring(0, 300);
        }
        if (!meta.version && entry.version) meta.version = entry.version;
        if (!meta.git_branch && entry.gitBranch) meta.git_branch = entry.gitBranch;
        if (!meta.permission_mode && entry.permissionMode) meta.permission_mode = entry.permissionMode;
        if (!meta.slug && entry.slug) meta.slug = entry.slug;
      }

      if (entry.type === 'assistant') {
        meta.assistant_message_count++;
        const msg = entry.message;
        if (msg) {
          if (msg.model) meta.models.add(msg.model);
          if (msg.usage) {
            meta.total_output_tokens += msg.usage.output_tokens || 0;
            meta.total_input_tokens += msg.usage.input_tokens || 0;
          }
          if (Array.isArray(msg.content)) {
            for (const block of msg.content) {
              if (block.type === 'tool_use' && block.name) {
                meta.tools_used[block.name] = (meta.tools_used[block.name] || 0) + 1;
                // Detect git commits from Bash tool calls
                if (block.name === 'Bash' || block.name === 'bash') {
                  const cmd = block.input?.command || block.input?.cmd || '';
                  if (/git\s+commit\b/.test(cmd) && !/--amend/.test(cmd)) {
                    meta.git_commits++;
                  }
                }
              }
            }
          }
        }
      }
    });

    rl.on('close', () => {
      meta.models = Array.from(meta.models);
      if (meta.first_timestamp && meta.last_timestamp) {
        meta.duration_minutes = Math.round(
          (new Date(meta.last_timestamp) - new Date(meta.first_timestamp)) / 60000
        );
      }
      resolve(meta);
    });

    rl.on('error', () => {
      meta.models = Array.from(meta.models);
      resolve(meta);
    });
  });
}

// ── Facets summary ──────────────────────────────────────────────────────

function computeFacetsSummary(facets) {
  const summary = {
    total: facets.length,
    outcomes: {}, session_types: {}, friction_counts: {},
    satisfaction_counts: {}, helpfulness_counts: {},
    goal_categories: {}, primary_successes: {},
  };
  for (const f of facets) {
    if (f.outcome) summary.outcomes[f.outcome] = (summary.outcomes[f.outcome] || 0) + 1;
    if (f.session_type) summary.session_types[f.session_type] = (summary.session_types[f.session_type] || 0) + 1;
    if (f.claude_helpfulness) summary.helpfulness_counts[f.claude_helpfulness] = (summary.helpfulness_counts[f.claude_helpfulness] || 0) + 1;
    if (f.primary_success) summary.primary_successes[f.primary_success] = (summary.primary_successes[f.primary_success] || 0) + 1;
    if (f.friction_counts) for (const [k, v] of Object.entries(f.friction_counts)) summary.friction_counts[k] = (summary.friction_counts[k] || 0) + v;
    if (f.user_satisfaction_counts) for (const [k, v] of Object.entries(f.user_satisfaction_counts)) summary.satisfaction_counts[k] = (summary.satisfaction_counts[k] || 0) + v;
    if (f.goal_categories) for (const [k, v] of Object.entries(f.goal_categories)) summary.goal_categories[k] = (summary.goal_categories[k] || 0) + v;
  }
  return summary;
}

// ── Main ────────────────────────────────────────────────────────────────

async function main() {
  console.error('[insightful] Starting data collection...');
  console.error(`[insightful] Claude dir: ${CLAUDE_DIR}`);

  // Ensure output directory exists
  const outputDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // ── Source 1: history.jsonl (primary — discovers ALL sessions) ──────
  const historySessions = await parseHistory();

  // ── Source 2: stats-cache.json (aggregate totals) ──────────────────
  const statsCache = readJsonSafe(STATS_CACHE_PATH);
  console.error(`[insightful] Stats cache: ${statsCache ? 'loaded' : 'not found'}`);

  // ── Source 3: facets (qualitative analysis per session) ────────────
  const facets = {};
  const allFacetData = [];
  if (fs.existsSync(FACETS_DIR)) {
    for (const f of fs.readdirSync(FACETS_DIR)) {
      if (!f.endsWith('.json')) continue;
      const data = readJsonSafe(path.join(FACETS_DIR, f));
      if (data) {
        const sid = data.session_id || f.replace('.json', '');
        facets[sid] = data;
        allFacetData.push(data);
      }
    }
  }
  console.error(`[insightful] Facets loaded: ${allFacetData.length}`);

  // ── Source 4: sessions-index.json files (session metadata) ─────────
  const indexedSessions = {};
  const projectDirs = fs.existsSync(PROJECTS_DIR) ? fs.readdirSync(PROJECTS_DIR) : [];
  for (const proj of projectDirs) {
    const indexPath = path.join(PROJECTS_DIR, proj, 'sessions-index.json');
    const idx = readJsonSafe(indexPath);
    if (idx && idx.entries) {
      for (const entry of idx.entries) {
        indexedSessions[entry.sessionId] = { ...entry, projectDir: proj };
      }
    }
  }
  console.error(`[insightful] Indexed sessions: ${Object.keys(indexedSessions).length}`);

  // ── Source 5: .jsonl session files (full conversation transcripts) ──
  // Build a map of sessionId → filePath for all .jsonl files
  const jsonlFiles = {};
  for (const proj of projectDirs) {
    const projPath = path.join(PROJECTS_DIR, proj);
    try {
      if (!fs.statSync(projPath).isDirectory()) continue;
      for (const file of fs.readdirSync(projPath)) {
        if (!file.endsWith('.jsonl')) continue;
        jsonlFiles[file.replace('.jsonl', '')] = path.join(projPath, file);
      }
    } catch { continue; }
  }
  const totalJsonlFound = Object.keys(jsonlFiles).length;
  const JSONL_SCAN_LIMIT = 300;
  if (totalJsonlFound > JSONL_SCAN_LIMIT) {
    const sorted = Object.entries(jsonlFiles)
      .map(([sid, fp]) => {
        let mtime = 0;
        try { mtime = fs.statSync(fp).mtimeMs; } catch {}
        return { sid, fp, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, JSONL_SCAN_LIMIT);
    for (const sid of Object.keys(jsonlFiles)) delete jsonlFiles[sid];
    for (const { sid, fp } of sorted) jsonlFiles[sid] = fp;
  }
  console.error(`[insightful] .jsonl files: ${totalJsonlFound} found, ${Object.keys(jsonlFiles).length} to scan (most recent)`);


  // ── Merge all sources into unified session records ─────────────────
  // Start with history sessions as the base (most complete discovery)
  const allSessionIds = new Set([
    ...Object.keys(historySessions),
    ...Object.keys(indexedSessions),
    ...Object.keys(jsonlFiles),
    ...Object.keys(facets),
  ]);
  console.error(`[insightful] Total unique session IDs: ${allSessionIds.size}`);

  // Group sessions by project
  const projects = {};
  let jsonlScanned = 0;

  for (const sid of allSessionIds) {
    const hist = historySessions[sid] || null;
    const idx = indexedSessions[sid] || null;
    const facet = facets[sid] || null;
    const hasJsonl = !!jsonlFiles[sid];

    // Determine project path (prefer history, then index)
    let projectPath = hist?.project_path || idx?.projectPath || null;
    const projectName = friendlyName(projectPath);

    if (!projects[projectName]) {
      projects[projectName] = {
        full_path: projectPath || '',
        sessions: [],
      };
    }

    // Build the session record
    let session;

    if (hasJsonl) {
      // Full detail available — scan the file
      jsonlScanned++;
      if (jsonlScanned % 10 === 0) {
        console.error(`[insightful] Scanning .jsonl ${jsonlScanned}/${Object.keys(jsonlFiles).length}...`);
      }
      session = await extractSessionMetadata(jsonlFiles[sid], sid);

      // Skip truly empty sessions
      if (session.user_message_count === 0 && session.assistant_message_count === 0) {
        // Still create a minimal record from history if available
        if (hist && hist.prompt_count > 0) {
          session = buildHistoryOnlySession(sid, hist);
        } else {
          continue;
        }
      }
    } else if (idx) {
      // Index metadata available
      session = {
        session_id: sid,
        source: 'index',
        first_timestamp: idx.created,
        last_timestamp: idx.modified,
        user_message_count: Math.floor((idx.messageCount || 0) / 2),
        assistant_message_count: Math.ceil((idx.messageCount || 0) / 2),
        first_prompt: idx.firstPrompt !== 'No prompt' ? idx.firstPrompt : null,
        tools_used: {},
        models: [],
        total_output_tokens: 0,
        total_input_tokens: 0,
        duration_minutes: idx.created && idx.modified
          ? Math.round((new Date(idx.modified) - new Date(idx.created)) / 60000) : null,
        git_branch: idx.gitBranch || null,
        slug: null,
        index_summary: idx.summary,
      };
    } else if (hist) {
      // History-only session (most common for older sessions)
      session = buildHistoryOnlySession(sid, hist);
    } else {
      // Facet-only (rare edge case)
      session = {
        session_id: sid,
        source: 'facet-only',
        first_timestamp: null,
        last_timestamp: null,
        user_message_count: 0,
        assistant_message_count: 0,
        first_prompt: null,
        tools_used: {},
        models: [],
        total_output_tokens: 0,
        total_input_tokens: 0,
      };
    }

    // Enrich with history data (prompts, timestamps)
    if (hist) {
      if (!session.first_prompt && hist.prompts.length > 0) {
        session.first_prompt = hist.prompts[0];
      }
      session.history_prompts = hist.prompts;
      session.history_prompt_count = hist.prompt_count;
      // Use history timestamps if session doesn't have them (they're Unix ms)
      if (!session.first_timestamp && hist.first_timestamp_ms) {
        session.first_timestamp = new Date(hist.first_timestamp_ms).toISOString();
      }
      if (!session.last_timestamp && hist.last_timestamp_ms) {
        session.last_timestamp = new Date(hist.last_timestamp_ms).toISOString();
      }
    }

    // Enrich with index data
    if (idx) {
      if (!session.index_summary) session.index_summary = idx.summary;
      if (!session.first_prompt && idx.firstPrompt && idx.firstPrompt !== 'No prompt') {
        session.first_prompt = idx.firstPrompt;
      }
    }

    // Attach facet
    session.has_facet = !!facet;
    session.facet = facet || null;

    projects[projectName].sessions.push(session);
  }

  console.error(`[insightful] Scanned ${jsonlScanned} .jsonl files`);

  // ── Compute project-level aggregates ───────────────────────────────
  for (const [name, proj] of Object.entries(projects)) {
    proj.sessions.sort((a, b) => {
      const da = a.first_timestamp || '';
      const db = b.first_timestamp || '';
      return da < db ? -1 : da > db ? 1 : 0;
    });
    proj.session_count = proj.sessions.length;
    proj.first_session = proj.sessions[0]?.first_timestamp || null;
    proj.last_session = proj.sessions[proj.sessions.length - 1]?.last_timestamp || null;

    const toolTotals = {};
    let totalMessages = 0;
    let totalOutputTokens = 0;
    let totalPrompts = 0;
    let totalGitCommits = 0;
    let totalDurationMinutes = 0;
    for (const s of proj.sessions) {
      totalMessages += (s.user_message_count || 0) + (s.assistant_message_count || 0);
      totalOutputTokens += s.total_output_tokens || 0;
      totalPrompts += s.history_prompt_count || s.user_message_count || 0;
      totalGitCommits += s.git_commits || 0;
      if (s.duration_minutes && s.duration_minutes > 0 && s.duration_minutes < 1440) {
        // Only count sessions under 24h to avoid inflating with idle long-lived sessions
        totalDurationMinutes += s.duration_minutes;
      }
      for (const [tool, count] of Object.entries(s.tools_used || {})) {
        toolTotals[tool] = (toolTotals[tool] || 0) + count;
      }
    }
    proj.total_messages = totalMessages;
    proj.total_output_tokens = totalOutputTokens;
    proj.total_prompts = totalPrompts;
    proj.total_git_commits = totalGitCommits;
    proj.total_hours = Math.round(totalDurationMinutes / 60 * 10) / 10;
    proj.tool_totals = toolTotals;
  }

  // ── Global aggregates ──────────────────────────────────────────────
  const globalToolTotals = {};
  let totalSessionsFound = 0;
  let totalPromptsAllSessions = 0;
  let totalMessagesFromJsonl = 0; // real counted messages from .jsonl files
  let sessionsWithRealMsgCount = 0;
  let preStatsSessions = 0;
  let preStatsPrompts = 0;
  let globalGitCommits = 0;
  let globalDurationMinutes = 0;

  const statsCacheFirstDate = statsCache?.firstSessionDate
    ? new Date(statsCache.firstSessionDate) : null;

  for (const proj of Object.values(projects)) {
    totalSessionsFound += proj.session_count;
    globalGitCommits += proj.total_git_commits || 0;
    globalDurationMinutes += Math.round((proj.total_hours || 0) * 60);
    for (const [tool, count] of Object.entries(proj.tool_totals)) {
      globalToolTotals[tool] = (globalToolTotals[tool] || 0) + count;
    }
    for (const s of proj.sessions) {
      totalPromptsAllSessions += s.history_prompt_count || s.user_message_count || 0;
      if (s.source === 'jsonl') {
        totalMessagesFromJsonl += (s.user_message_count || 0) + (s.assistant_message_count || 0);
        sessionsWithRealMsgCount++;
      }
      // Count sessions that predate the stats-cache tracking period
      if (statsCacheFirstDate && s.first_timestamp) {
        const sessionDate = new Date(s.first_timestamp);
        if (sessionDate < statsCacheFirstDate) {
          preStatsSessions++;
          preStatsPrompts += s.history_prompt_count || s.user_message_count || 0;
        }
      }
    }
  }

  // Sort projects by session count descending
  const sortedProjects = {};
  Object.entries(projects)
    .sort((a, b) => b[1].session_count - a[1].session_count)
    .forEach(([k, v]) => { sortedProjects[k] = v; });

  // ── Output ─────────────────────────────────────────────────────────
  const result = {
    generated_at: new Date().toISOString(),
    stats_cache: statsCache,
    projects: sortedProjects,
    facets_summary: computeFacetsSummary(allFacetData),
    all_facets: allFacetData,
    global_tool_totals: globalToolTotals,
    total_sessions_found: totalSessionsFound,
    total_sessions_from_stats: statsCache?.totalSessions || 0,
    total_messages_from_stats: statsCache?.totalMessages || 0,
    total_projects: Object.keys(projects).length,
    total_git_commits: globalGitCommits,
    total_hours: Math.round(globalDurationMinutes / 60 * 10) / 10,
    sessions_with_facets: allFacetData.length,
    sessions_without_facets: totalSessionsFound - allFacetData.length,
    // Accurate message accounting
    message_accounting: {
      tracked_messages: statsCache?.totalMessages || 0,  // from stats-cache (Jan 4+)
      tracked_sessions: statsCache?.totalSessions || 0,
      tracked_period_start: statsCache?.firstSessionDate || null,
      pre_tracking_sessions: preStatsSessions,            // sessions before stats-cache existed
      pre_tracking_prompts: preStatsPrompts,              // user prompts from those sessions (from history.jsonl)
      pre_tracking_messages_unavailable: true,             // assistant msgs not recoverable
      jsonl_verified_messages: totalMessagesFromJsonl,     // messages counted from existing .jsonl files
      jsonl_verified_sessions: sessionsWithRealMsgCount,
      total_user_prompts: totalPromptsAllSessions,         // all prompts across all sources
    },
    data_sources: {
      history_sessions: Object.keys(historySessions).length,
      indexed_sessions: Object.keys(indexedSessions).length,
      jsonl_files: Object.keys(jsonlFiles).length,
      facet_files: allFacetData.length,
      has_stats_cache: !!statsCache,
    },
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(result, null, 2), 'utf8');
  console.error(`[insightful] Done! ${totalSessionsFound} sessions across ${Object.keys(projects).length} projects`);
  console.error(`[insightful] Output: ${OUTPUT_PATH}`);

  // ── Facet coverage warning ─────────────────────────────────────────────────
  const facetCoverage = totalSessionsFound > 0 ? allFacetData.length / totalSessionsFound : 1;
  if (facetCoverage < 0.8 && totalSessionsFound > 10) {
    const missing = totalSessionsFound - allFacetData.length;
    console.log('\n⚠️  FACET COVERAGE LOW');
    console.log(`   ${allFacetData.length}/${totalSessionsFound} sessions have qualitative analysis (${Math.round(facetCoverage * 100)}%)`);
    console.log(`   ${missing} sessions are missing facets — your report will have gaps in satisfaction,`);
    console.log(`   friction, and helpfulness data.`);
    console.log(`\n   To backfill all missing sessions, run:`);
    console.log(`   node "\${CLAUDE_PLUGIN_ROOT}/skills/insightful/backfill-facets.mjs" --chunk=50`);
    console.log(`   (shows cost estimate first — ~$0.004 per session using claude-haiku)`);
  }

  console.log(OUTPUT_PATH);
}

function buildHistoryOnlySession(sid, hist) {
  return {
    session_id: sid,
    source: 'history',
    first_timestamp: hist.first_timestamp_ms ? new Date(hist.first_timestamp_ms).toISOString() : null,
    last_timestamp: hist.last_timestamp_ms ? new Date(hist.last_timestamp_ms).toISOString() : null,
    user_message_count: hist.prompt_count || 0,
    assistant_message_count: 0, // can't know from history alone
    first_prompt: hist.prompts[0] || null,
    tools_used: {},
    models: [],
    total_output_tokens: 0,
    total_input_tokens: 0,
    duration_minutes: hist.first_timestamp_ms && hist.last_timestamp_ms
      ? Math.round((hist.last_timestamp_ms - hist.first_timestamp_ms) / 60000) : null,
    git_branch: null,
    slug: null,
    history_prompts: hist.prompts,
    history_prompt_count: hist.prompt_count,
  };
}

main().catch((err) => {
  console.error('[insightful] Fatal error:', err);
  process.exit(1);
});
