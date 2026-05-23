#!/usr/bin/env node
/**
 * backfill-facets.mjs
 * Generates facet JSON files for sessions that don't have them.
 *
 * Uses `claude -p` (Claude Code OAuth subscription) — no ANTHROPIC_API_KEY,
 * no Console billing. ANTHROPIC_API_KEY is stripped from the subprocess env
 * so a set var can't silently re-enable API billing.
 *
 * Usage:
 *   node backfill-facets.mjs [--chunk 50] [--dry-run]
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawnSync } from 'child_process';

const HOME = process.env.USERPROFILE || process.env.HOME;
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const FACETS_DIR = path.join(HOME, '.claude', 'usage-data', 'facets');

const args = process.argv.slice(2);
const CHUNK_SIZE = parseInt(args.find(a => a.startsWith('--chunk='))?.split('=')[1] || '50');
const DRY_RUN = args.includes('--dry-run');
const VERBOSE = args.includes('--verbose');

// ── Distillation via `claude -p` ─────────────────────────────────────────────
function callClaude(systemPrompt, userMessage) {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const tmpFile = path.join(os.tmpdir(), `braynee-facet-sys-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(tmpFile, systemPrompt, 'utf8');
  try {
    const res = spawnSync(
      'claude',
      ['-p', '--append-system-prompt-file', tmpFile],
      { input: userMessage, encoding: 'utf8', env, timeout: 120_000 }
    );
    if (res.status !== 0 || /Credit balance is too low/.test(res.stdout || '')) {
      const err = (res.stderr || res.stdout || '').slice(0, 500);
      throw new Error(`claude -p failed: ${err}`);
    }
    return (res.stdout || '').trim();
  } finally {
    try { fs.unlinkSync(tmpFile); } catch {}
  }
}

// ── Facet schema prompt ───────────────────────────────────────────────────────
const SYSTEM_PROMPT = `You analyze Claude Code session transcripts and return structured JSON facets.
Output ONLY valid JSON — no markdown, no explanation, no code fences.

The JSON must match this exact schema:
{
  "underlying_goal": "string — the user's main goal in 1 sentence",
  "goal_categories": {
    // one or more of these keys with value 1:
    // coding, debugging, refactoring, architecture, devops, infra, database,
    // ui_frontend, api_integration, research, planning, documentation,
    // tooling, debugging_tooling, content_creation, data_analysis,
    // status_check, command_reference, learning, other
  },
  "outcome": "achieved | partially_achieved | not_achieved | unclear",
  "user_satisfaction_counts": {
    // counts of turns showing these signals (omit if 0):
    // satisfied, likely_satisfied, neutral, dissatisfied, frustrated
  },
  "claude_helpfulness": "very_helpful | helpful | moderately_helpful | unhelpful | harmful",
  "session_type": "one_shot | iterative_refinement | exploratory | debugging | planning | status_check | mixed",
  "friction_counts": {
    // counts of friction events (omit if 0):
    // wrong_approach, buggy_code, misunderstood_request, tool_failure,
    // overexplained, scope_creep, repeated_corrections
  },
  "friction_detail": "string | null — brief description of friction if any",
  "primary_success": "string | null — what went well in 1 sentence",
  "brief_summary": "string — 1-2 sentence summary of what happened"
}`;

// ── Extract condensed transcript ──────────────────────────────────────────────
function extractTranscript(filePath, maxLines = 80) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.trim().split('\n');
    const messages = [];
    let userCount = 0;
    let assistantCount = 0;
    let toolNames = new Set();

    for (const line of lines) {
      if (!line.trim()) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }

      const type = entry.type;
      if (type !== 'user' && type !== 'assistant') continue;

      const msg = entry.message || {};
      const role = msg.role || type;
      const content = msg.content;

      if (role === 'user') {
        userCount++;
        if (typeof content === 'string' && content.trim()) {
          messages.push(`[user] ${content.slice(0, 300)}`);
        } else if (Array.isArray(content)) {
          for (const c of content) {
            if (c?.type === 'text' && c.text?.trim()) {
              messages.push(`[user] ${c.text.slice(0, 300)}`);
            }
          }
        }
      } else if (role === 'assistant') {
        assistantCount++;
        if (Array.isArray(content)) {
          let textParts = [];
          for (const c of content) {
            if (c?.type === 'text' && c.text?.trim()) {
              textParts.push(c.text.slice(0, 200));
            } else if (c?.type === 'tool_use') {
              toolNames.add(c.name);
            }
          }
          if (textParts.length > 0) {
            messages.push(`[assistant] ${textParts.join(' ').slice(0, 300)}`);
          }
        } else if (typeof content === 'string' && content.trim()) {
          messages.push(`[assistant] ${content.slice(0, 300)}`);
        }
      }

      if (messages.length >= maxLines) break;
    }

    const header = `Session stats: ${userCount} user turns, ${assistantCount} assistant turns, tools used: ${[...toolNames].join(', ') || 'none'}`;
    return header + '\n\n' + messages.join('\n');
  } catch {
    return null;
  }
}

// ── Generate facet for one session ───────────────────────────────────────────
function generateFacet(sessionId, filePath) {
  const transcript = extractTranscript(filePath);
  if (!transcript || transcript.length < 50) return null;

  const text = callClaude(
    SYSTEM_PROMPT,
    `Analyze this Claude Code session transcript and return the facet JSON:\n\n${transcript}`
  );
  if (!text) return null;

  // Strip any accidental markdown fences
  const cleaned = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    if (VERBOSE) console.error(`  [warn] JSON parse failed for ${sessionId}`);
    return null;
  }

  parsed.session_id = sessionId;
  return { facet: parsed };
}

// ── Find sessions to backfill ─────────────────────────────────────────────────
function findMissingSessions() {
  const existing = new Set(
    fs.existsSync(FACETS_DIR)
      ? fs.readdirSync(FACETS_DIR).map(f => f.replace('.json', ''))
      : []
  );

  const missing = [];
  const projectDirs = fs.existsSync(PROJECTS_DIR) ? fs.readdirSync(PROJECTS_DIR) : [];

  for (const proj of projectDirs) {
    const projPath = path.join(PROJECTS_DIR, proj);
    try {
      if (!fs.statSync(projPath).isDirectory()) continue;
      for (const file of fs.readdirSync(projPath)) {
        if (!file.endsWith('.jsonl')) continue;
        const sid = file.replace('.jsonl', '');
        // Skip agent sub-sessions
        if (sid.startsWith('agent-')) continue;
        // Skip already faceted
        if (existing.has(sid)) continue;
        const fullPath = path.join(projPath, file);
        // Skip tiny files
        const stat = fs.statSync(fullPath);
        if (stat.size < 1000) continue;
        missing.push({ sessionId: sid, filePath: fullPath, size: stat.size });
      }
    } catch { continue; }
  }

  // Sort by file size descending (larger = more content = more valuable to analyze)
  missing.sort((a, b) => b.size - a.size);
  return missing;
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!fs.existsSync(FACETS_DIR)) fs.mkdirSync(FACETS_DIR, { recursive: true });

  const allMissing = findMissingSessions();
  const chunk = allMissing.slice(0, CHUNK_SIZE);

  console.log(`Total sessions missing facets: ${allMissing.length}`);
  console.log(`Processing chunk of: ${chunk.length}`);
  if (DRY_RUN) console.log('DRY RUN — no API calls will be made\n');

  let success = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < chunk.length; i++) {
    const { sessionId, filePath } = chunk[i];
    const prefix = `[${i + 1}/${chunk.length}]`;

    if (DRY_RUN) {
      const transcript = extractTranscript(filePath);
      if (!transcript || transcript.length < 50) {
        console.log(`${prefix} SKIP ${sessionId} (empty transcript)`);
        skipped++;
      } else {
        console.log(`${prefix} WOULD process ${sessionId} (~${transcript.length} chars)`);
        success++;
      }
      continue;
    }

    process.stdout.write(`${prefix} ${sessionId.slice(0, 8)}... `);

    try {
      const result = generateFacet(sessionId, filePath);
      if (!result) {
        process.stdout.write('SKIP (empty)\n');
        skipped++;
        continue;
      }

      fs.writeFileSync(
        path.join(FACETS_DIR, `${sessionId}.json`),
        JSON.stringify(result.facet, null, 2)
      );

      success++;
      process.stdout.write('OK\n');
    } catch (err) {
      process.stdout.write(`ERROR: ${err.message?.slice(0, 60)}\n`);
      failed++;
    }
  }

  console.log('\n═══════════════════════════════════════');
  console.log('Results:');
  console.log(`  Success:  ${success}`);
  console.log(`  Skipped:  ${skipped}`);
  console.log(`  Failed:   ${failed}`);
  if (!DRY_RUN) {
    console.log(`\nUsed claude -p (CC subscription) — no API billing.`);
    console.log(`Facets remaining after this chunk: ${allMissing.length - success}`);
  }
}

main().catch(console.error);
