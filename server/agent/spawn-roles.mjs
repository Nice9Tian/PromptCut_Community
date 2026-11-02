/**
 * Preset roles that `spawn_agent` can launch (plan A3 in `docs/plan/agent-workflow-plan.md`).
 * Contains only constants and imports no Node built-in modules: tool table
 * `server/tools/agent.mjs` imports it, and the tool table is statically imported by the page
 * (`src/ai/mcpExecutor.ts` → `server/mcp-tools.mjs`). Reading role prompts (which requires reading
 * files) is in `agent-roles.mjs`.
 */

/**
 * Preset roles that can be launched (allowed values for `role` in `spawn_agent`); order
 * matches the order in tool description.
 */
export const SPAWN_ROLE_IDS = Object.freeze(['director', 'fx-assistant', 'collector']);

/** One-line description shown to the model in the tool table */
export const SPAWN_ROLE_HINTS = Object.freeze({
  director: 'Cut director: lines up the media, orders it onto the timeline, and arranges the script',
  'fx-assistant': 'Effects assistant: adds captions to the video and adds motion graphics cards based on the content',
  collector: 'Media collector: grabs videos from web links into the media library',
});
