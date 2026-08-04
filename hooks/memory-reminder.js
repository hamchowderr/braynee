// memory-reminder.js
// Hook: UserPromptSubmit — Injects a memory reminder with every message.
// This ensures Claude always knows it can search past sessions via vault-query and QMD,
// even deep into a session after compaction when CLAUDE.md instructions fade.
//
// Outputs to stdout = injected into Claude's context before processing the message.
//
// The text itself lives in scripts/lib/vault-instructions.mjs so the Claude Code
// and Mastra Code surfaces cannot drift. Mastra Code cannot inject context from a
// hook at all, so it consumes the same generator as plugin `instructions` instead.

const path = require('path');

const BRAYNEE_ROOT = path.join(__dirname, '..');

(async () => {
  try {
    const { vaultInstructions } = await import(
      require('node:url').pathToFileURL(
        path.join(BRAYNEE_ROOT, 'scripts', 'lib', 'vault-instructions.mjs'),
      ).href
    );
    process.stdout.write(vaultInstructions({ brayneeRoot: BRAYNEE_ROOT }));
  } catch {
    // Never break the user's turn over a reminder — emit nothing and exit clean.
  }
  process.exit(0);
})();
