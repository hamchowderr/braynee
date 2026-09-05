/**
 * Shared source of truth for braynee's vault operating instructions.
 *
 * Both host adapters consume this one function:
 *   - Claude Code  -> hooks/memory-reminder.js prints it on every UserPromptSubmit
 *   - Mastra Code  -> mastracode/src/index.ts returns it as plugin `instructions`
 *
 * Mastra Code cannot inject context from hooks (its TUI never reads a hook's
 * additionalContext), so on that host this text has to arrive as plugin
 * instructions instead. Keeping one generator means the two surfaces cannot
 * drift.
 *
 * All paths are emitted ABSOLUTE and resolved from the caller's braynee root.
 * Never emit a `${CLAUDE_PLUGIN_ROOT}`-style placeholder: Claude Code expands
 * that token, no other host does, and an unexpanded placeholder reaches the
 * agent as literal text and produces a command that cannot run.
 *
 * SCOPE RULE: this text tells the agent to reach for QMD and how to drive ALL
 * of it. It must never narrow the tool — no "use search first", no ranking of
 * the modes by speed, no omitting the retrieval step. An agent that only ever
 * runs bare BM25 and answers off snippets is the failure this text caused
 * before; QMD's own bundled skill (`qmd skill show`) is the fuller reference
 * and this must stay compatible with it.
 */

import path from 'node:path';

/**
 * @param {object} options
 * @param {string} options.brayneeRoot Absolute path to the braynee plugin root
 *   (the directory containing `scripts/`, `skills/`, `hooks/`).
 * @returns {string} Instruction text with absolute, runnable command paths.
 */
export function vaultInstructions({ brayneeRoot }) {
  if (!brayneeRoot) throw new Error('vaultInstructions: brayneeRoot is required');

  // Native separators on purpose: this must stay byte-identical to what the
  // Claude Code hook emitted before it became a caller of this module.
  const script = name => path.join(brayneeRoot, 'scripts', name);
  const qmd = script('qmd-wrapper.mjs');
  const vaultQuery = script('vault-query.mjs');

  return [
    'MANDATORY: You have complete searchable memory of all past sessions and vault content. ' +
      'Before assuming, guessing, creating workarounds, or asking the user about anything ' +
      'previously discussed — search first.',
    `QMD is the vault's search tool (never grep/find/Glob the vault) — node "${qmd}" <command>:`,
    '  - search "exact terms" — BM25. Best for titles, names, code symbols, rare phrases. ' +
      'AND-based: every term must match, so fewer terms beat more.',
    '  - query $\'intent: what you are looking for, and what to avoid\\nlex: exact terms and ' +
      'aliases\\nvec: the idea in the source\'s own wording\\nhyde: the answer you expect to ' +
      'find\' — hybrid retrieval. Write those fields yourself; a bare query "the user\'s ' +
      'sentence" throws away the context only you have.',
    '  - vsearch "concept" — vector similarity only.',
    '  - Options: -c vault to scope, -n <k> for more hits, --no-rerank to stay fast on CPU.',
    'Hits are LEADS, not answers. Before you state a fact, decision, quote or number from the ' +
      `vault, retrieve the source: node "${qmd}" get "#docid" (slice with "#docid:from:count") ` +
      'or multi-get "#a,#b". Cite the docid.',
    `vault-query (structured): node "${vaultQuery}" context <project> — for session lifecycle ` +
      'and project context aggregation.',
    'If you are confused, encountering errors, or need clarity on any prior decision, ' +
      'architecture, or context — the answer is in the vault. Search, retrieve, then answer. ' +
      'Don\'t guess.',
  ].join('\n');
}
