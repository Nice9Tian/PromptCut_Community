/**
 * Creativity level gate (plan `docs/plan/agent-workflow-plan.md` A1; semantics `user-workflow.md`
 * "Creativity level").
 *
 * Placed at the general entrance of all tool calls, `callToolInternal` in
 * `server/vite-plugin-ai.ts`, alongside the review loop read-only lock and the SKILL gate: both
 * direct API (closure) and command line (`mcp-server.mjs` → `POST /api/mcp/call`) paths go through
 * it. **Blocks before execution**: calls exceeding the level do nothing, returning an explanation
 * from which the Agent can stop and explain.
 *
 * The "Tool → Required level" mapping table is only written here (`TOOL_CREATIVITY`); tools not in
 * the table require "low" (i.e. anyone can use them):
 *
 * | Tool | Required | Reason |
 * |---|---|---|
 * | `create_card` (user card with same name exists) | Medium | Rewriting an entire existing card = modifying its code (without overwrite, implementation returns 409 pointing to edit_card) |
 * | `create_card` (card does not exist) | High | Create new card |
 * | `edit_card` | Medium | Modify source code of existing cards (user cards, built-in cards) |
 * | `create_filter`, `create_pixel_map`, `create_audio_fx` | High | Create new effect |
 * | `update_filter`, `update_pixel_map`, `update_audio_fx` (touches definition) | Medium | Modify effect expression / steps / parameter declarations; all clips attaching it change |
 * | `update_*` (only modifies name, description) | Low | Only modifies display name and description in library, without touching effect itself |
 * | `measure_audio_js` | High | Write custom measurement code (plan A6; semantics `user-workflow.md` "Creativity level": low tier "measurement uses built-in methods only") |
 * | Remainder (incl. `apply_card`, `apply_*`, composite card part tools, `measure_audio`) | Low | Use existing cards / effects / parts, modify parameters, built-in measurement |
 */
import { CREATIVITY_HINT, CREATIVITY_LABEL, creativityAllows, normalizeCreativity } from './ssr-host.mjs';

/** Shape of user card id (matches kebab-case whitelist in `server/vite-plugin-cards.ts`); does not touch the filesystem if shape does not match */
const CARD_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Fields in effect update_* that only change display information: modifying only these does not count as changing the effect itself */
const EFFECT_META_KEYS = new Set(['name', 'description']);

/** Effect update_* tool → its id parameter name */
const EFFECT_UPDATE_ID = Object.freeze({ update_filter: 'filterId', update_pixel_map: 'pixelMapId', update_audio_fx: 'fxId' });

function effectUpdate(idKey) {
  return (args) => {
    const touched = Object.keys(args ?? {}).filter((k) => k !== idKey && args[k] !== undefined);
    return touched.every((k) => EFFECT_META_KEYS.has(k))
      ? { level: 'low', what: 'Change the name or description of an effect' }
      : { level: 'medium', what: 'Change the definition of an existing effect (expressions, steps or parameter declarations)' };
  };
}

/**
 * Tool → required level. Value is fixed `{ level, what }`, or a function evaluated from arguments
 * `(args, ctx) => { level, what }`; `ctx.cardExists(id)` returns whether this user card exists
 * (injected by caller, mock used in pure-function tests).
 */
export const TOOL_CREATIVITY = Object.freeze({
  create_card: (args, ctx) => {
    const id = typeof args?.id === 'string' ? args.id : '';
    const exists = !!id && CARD_ID_RE.test(id) && !!ctx?.cardExists?.(id);
    return exists
      ? { level: 'medium', what: `Rewrite the whole existing card ${id}` }
      : { level: 'high', what: 'Create a new card' };
  },
  edit_card: { level: 'medium', what: 'Change the source of an existing card' },
  create_filter: { level: 'high', what: 'Create a new filter' },
  create_pixel_map: { level: 'high', what: 'Create a new pixel map' },
  create_audio_fx: { level: 'high', what: 'Create a new audio effect' },
  update_filter: effectUpdate(EFFECT_UPDATE_ID.update_filter),
  update_pixel_map: effectUpdate(EFFECT_UPDATE_ID.update_pixel_map),
  update_audio_fx: effectUpdate(EFFECT_UPDATE_ID.update_audio_fx),
  measure_audio_js: { level: 'high', what: 'Write custom measurement code' },
});

/** Level required for this call */
export function requiredCreativity(tool, args, ctx = {}) {
  const rule = Object.hasOwn(TOOL_CREATIVITY, tool) ? TOOL_CREATIVITY[tool] : null;
  if (!rule) return { level: 'low', what: null };
  return typeof rule === 'function' ? rule(args ?? {}, ctx) : rule;
}

/**
 * Evaluates a call. Passing returns `{ ok: true, required }`; exceeding level returns
 * `{ ok: false, error, creativity: { current, required } }`, where `error` states current level,
 * required level for this operation, and how to adjust: adjusted by user, Agent stops and explains,
 * does not switch tools to bypass.
 *
 * @param {string} tool
 * @param {object} args
 * @param {'low'|'medium'|'high'} current Effective level for this chat
 * @param {{ cardExists?: (id: string) => boolean, source?: string }} [ctx] source: where the level came
 *   from (used for error reporting)
 */
export function checkCreativity(tool, args, current, ctx = {}) {
  const level = normalizeCreativity(current) ?? 'high';
  const req = requiredCreativity(tool, args, ctx);
  if (creativityAllows(level, req.level)) return { ok: true, required: req.level };
  const from = ctx.source ? `(${ctx.source})` : '';
  return {
    ok: false,
    creativity: { current: level, required: req.level, tool },
    error:
      `Creativity level too low, ${tool} was not executed: this chat is currently at "${CREATIVITY_LABEL[level]}"${from}, ` +
      `${req.what ? `${req.what}` : 'This operation'} requires "${CREATIVITY_LABEL[req.level]}".\n` +
      `"${CREATIVITY_LABEL[level]}" tier: ${CREATIVITY_HINT[level]}.\n` +
      `Stop and tell the user: this step requires setting the creativity level to "${CREATIVITY_LABEL[req.level]}"` +
      ' (change the project\'s default level in project settings, or raise it for this chat alone in its run options in the AI panel), the user decides; ' +
      'Do not work around it with other tools or approaches. What can be done within the level may proceed as usual.',
  };
}
