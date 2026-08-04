import path from 'node:path';
import { defineMastraCodePlugin } from 'mastracode/plugin';
import { vaultInstructions } from '../../scripts/lib/vault-instructions.mjs';

/**
 * Mastra Code adapter for braynee.
 *
 * The manifest (.mastracode-plugin.json) sits at the braynee repo root, so the
 * plugin ROOT is the repo itself. That is deliberate: Mastra Code discovers a
 * plugin's skills at `<pluginRoot>/skills`, which is already braynee's real
 * skills directory. No copies, no symlinks, no build step, and the Claude Code
 * and Mastra Code surfaces cannot drift apart.
 *
 * Beware the two different directories:
 *   pluginRoot  = <repo>              -> where skills/ and commands/ are found
 *   ctx.pluginDir = <repo>/mastracode/src -> path.dirname(entryPath), NOT the root
 * Verified in @mastra/code-sdk loader.ts.
 */

/** Resolve the braynee repo root from the entry directory (`<repo>/mastracode/src`). */
function brayneeRootFrom(pluginDir: string): string {
  return path.resolve(pluginDir, '..', '..');
}

export default defineMastraCodePlugin({
  id: 'braynee',
  name: 'Braynee',
  description:
    'Turns Mastra Code into your second brain: Obsidian PARA vault, QMD search over every past ' +
    'session, beads task tracking, and the daily workflow skills.',

  // Mastra Code cannot inject context from hooks — its TUI never reads a hook's
  // additionalContext — so the vault search mandate has to arrive as plugin
  // instructions. Same generator the Claude Code UserPromptSubmit hook uses, so
  // the two hosts stay byte-identical.
  instructions: ctx => vaultInstructions({ brayneeRoot: brayneeRootFrom(ctx.pluginDir) }),
});
