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
    'Search tools:',
    `  - QMD keyword (DEFAULT — fast ~3s, no LLM): node "${qmd}" search "exact terms" — use this ` +
      'first for finding notes/files; covers the whole vault regardless of embedding state',
    `  - QMD semantic (slow ~20s+ LLM expansion, can time out on CPU): node "${qmd}" query ` +
      '"concept" — only for open-ended "what do I know about X"; add --no-rerank to stay fast',
    `  - vault-query (structured): node "${vaultQuery}" context <project> — for session lifecycle ` +
      'and project context aggregation',
    'If you are confused, encountering errors, or need clarity on any prior decision, ' +
      'architecture, or context — the answer is in the vault. Search first (start with keyword ' +
      '`search`), fall back to vault-query for structured queries. Don\'t guess.',
  ].join('\n');
}
