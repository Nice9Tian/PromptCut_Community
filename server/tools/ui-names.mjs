/**
 * Tools that affect the user interface: prefix name with `user_interface_` (user decision,
 * 2026-10-21, `product/agent.md` "Tools").
 *
 * User's original words: "The cut-switching action can be changed to
 * user_interface.swith_cut() so at the code level it is understood that it affects the UI. Same
 * for timeline operations: add user_interface to whatever affects the user interface." Model-side
 * tool names only accept `^[a-zA-Z0-9_-]{1,64}$` (both Claude and OpenAI) and cannot contain dots,
 * so underscores are used.
 *
 * Criterion: the **primary effect** of this tool is changing the interface state in front of the
 * user (all members, or the initiator's own page/machine), rather than changing project content.
 * Rationale for each tool is in `docs/reports/AGENT-cut-look-ui.md` "Tool renaming table".
 *
 * Three places for names:
 *   - **Name seen by the model** (tool manifest, system prompt, tool descriptions): new name. Old
 *     names no longer appear in the manifest given to the model;
 *   - **Tool call entry point**: accepts both new and old, old names are converted to new names on
 *     the fly (old chat history still has old names; model calling old names executes normally);
 *   - **Internal operation name sent to the page** (SSE `call`, `tool` in reverse channel
 *     requests): keeps old name, 0.7.18 desktop app recognizes it normally as initiator page; the
 *     page side recognizes both (`src/ai/mcpExecutor.ts`, `src/ai/cloud/pageRequests.ts` convert
 *     back to old name on entry).
 *
 * This file does not reference `src/` (standalone entry points for Agent services may only
 * reference `src/` via loading seams); the page side imports this file directly.
 */

export const UI_TOOL_PREFIX = 'user_interface_';

/** Old name → new name */
export const UI_TOOL_RENAMES = Object.freeze({
  switch_cut: 'user_interface_switch_cut',
  seek: 'user_interface_seek',
  play: 'user_interface_play',
  pause: 'user_interface_pause',
  web_handoff: 'user_interface_web_handoff',
  collect_login: 'user_interface_collect_login',
});

/** New name → old name (internal operation name sent to page) */
export const UI_TOOL_LEGACY = Object.freeze(Object.fromEntries(Object.entries(UI_TOOL_RENAMES).map(([oldName, newName]) => [newName, oldName])));

const own = (table, key) => typeof key === 'string' && Object.hasOwn(table, key);

/** Any name → model-side name (old name to new name, others unchanged) */
export function modelToolName(name) {
  return own(UI_TOOL_RENAMES, name) ? UI_TOOL_RENAMES[name] : name;
}

/** Any name → internal operation name sent to page (new name to old name, others unchanged) */
export function pageToolName(name) {
  return own(UI_TOOL_LEGACY, name) ? UI_TOOL_LEGACY[name] : name;
}

/** Whether this name (old or new) is a tool that affects the user interface */
export function isUserInterfaceTool(name) {
  return own(UI_TOOL_RENAMES, name) || own(UI_TOOL_LEGACY, name);
}

/** That sentence in the system prompt (shared between local and cloud) */
export const UI_TOOLS_PROMPT_LINE =
  '- **Tools whose name contains `user_interface_` act on the user\'s interface** (switching the active cut shared by all members, moving the playhead, starting or pausing playback, bringing a window or login dialog in front of the user). Avoid them whenever you can:' +
  ' To view the frames of another cut, use `cutId` of `see_frames`; to change existing clips in another cut, edit them directly by clipId; neither needs a switch. Use these only when the user explicitly asks to switch, jump or play, or when this step can only be done by the user in person.';
