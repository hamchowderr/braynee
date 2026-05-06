// memory-reminder.js
// Hook: UserPromptSubmit — Injects a memory reminder with every message
// This ensures Claude always knows it can search past sessions via vault-query and QMD,
// even deep into a session after compaction when CLAUDE.md instructions fade.
//
// Outputs to stdout = injected into Claude's context before processing the message.
// Lightweight, static, no file I/O or API calls.

process.stdout.write(
  'MANDATORY: You have complete searchable memory of all past sessions and vault content. ' +
  'Before assuming, guessing, creating workarounds, or asking the user about anything previously discussed — search first.\n' +
  'Search tools:\n' +
  '  - QMD (fast, semantic): node "%USERPROFILE%\\.claude\\scripts\\qmd-wrapper.mjs" query "search terms" — best for finding decisions, patterns, past work across the whole vault\n' +
  '  - QMD (keyword): node "%USERPROFILE%\\.claude\\scripts\\qmd-wrapper.mjs" search "exact terms" — BM25 keyword search, no LLM\n' +
  '  - vault-query (structured): node "%USERPROFILE%\\.claude\\scripts\\vault-query.mjs" context <project> — for session lifecycle and project context aggregation\n' +
  'If you are confused, encountering errors, or need clarity on any prior decision, architecture, or context — the answer is in the vault. Search with QMD first (faster), fall back to vault-query for structured queries. Don\'t guess.'
);
process.exit(0);
