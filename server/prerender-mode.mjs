/**
 * Three modes of the prerender process (`docs/semantics/mechanism/rendering.md`
 * "Query rendering and prerender process"; plan `docs/plan/cloud-task.md` I1, I4(a)).
 *
 *   - `user`  : Only the user is editing on this machine. Only performs prerendering (the
 *               background pass, queue tasks, track streams, AI panel operation preview, 3D view
 *               textures), **does not create an Agent lane**, and Agent queries return
 *               `503 NO_AGENT_LANE`.
 *   - `agent` : Only the Agent (or Agent cloud environment) is on this machine. Only accepts Agent
 *               queries, **does not prerender**: only creates the Agent lane; `/preload` returns
 *               `{ ok: true, skipped: 'agent' }`, and other prerender requests return
 *               `503 NO_PRERENDER`; does not start render nodes, does not produce streams.
 *   - `full`  : Both are on this machine. Creates all three, with Agent priority simply jumping the
 *               queue (current behavior, default).
 *
 * Mode names and lane names (`user` / `agent` / `background` …) share words but represent different
 * things: the constant here is called `PRERENDER_MODE`, do not confuse it with lane.
 *
 * Passed via the environment variable `PROMPTCUT_PRERENDER_MODE` when the editor process starts the
 * prerender process (`vite-plugin-prerender.ts`); the Agent cloud environment bypasses the editor
 * process and starts on its own with `PROMPTCUT_ROLE=prerender PROMPTCUT_PRERENDER_MODE=agent`.
 */

export const PRERENDER_MODE = Object.freeze({ USER: 'user', AGENT: 'agent', FULL: 'full' });
const MODES = new Set(Object.values(PRERENDER_MODE));

/** Normalizes a mode value: returns the lowercase mode name if recognized, or null if unrecognized (including empty) */
export function parsePrerenderMode(value) {
  if (typeof value !== 'string') return null;
  const mode = value.trim().toLowerCase();
  return MODES.has(mode) ? mode : null;
}

/** Prerender process side: determines its mode from environment variables. Defaults to `full` if unset or unrecognized (same behavior as before adding modes) */
export function prerenderModeOf(env = process.env) {
  return parsePrerenderMode(env?.PROMPTCUT_PRERENDER_MODE) ?? PRERENDER_MODE.FULL;
}

/**
 * Which mode to select when the editor process starts the local prerender process (I4(a): defaults
 * to one process on the user's machine, `full` when an Agent is local, `user` when not).
 *
 * [ruling] "Agent is local" is judged by current code status: the editor process always mounts
 * `vite-plugin-ai` (server-side tools for the local Agent reside in the editor process, plugin list
 * in `vite.config.ts`), identical in both the desktop app and dev server, so it defaults to `full`,
 * and existing users will see no difference.
 * When a valid `PROMPTCUT_PRERENDER_MODE` is explicitly provided in the editor process environment,
 * follow it (for troubleshooting and acceptance check; e.g. `user` means not opening queries for
 * the local Agent).
 */
export function localPrerenderMode(env = process.env) {
  return parsePrerenderMode(env?.PROMPTCUT_PRERENDER_MODE) ?? PRERENDER_MODE.FULL;
}

/** Whether this mode accepts Agent queries (whether it creates an Agent lane) */
export function modeServesAgent(mode) {
  return mode === PRERENDER_MODE.AGENT || mode === PRERENDER_MODE.FULL;
}

/** Whether this mode runs prerendering (the background pass, queue, streams, user interactive frames and playback, operation preview) */
export function modeServesPrerender(mode) {
  return mode === PRERENDER_MODE.USER || mode === PRERENDER_MODE.FULL;
}

/** Which lanes this mode creates (keys of `FramePipeline.laneChains`, plus `'queue'` and track streams; for diagnostics and unit tests only) */
export function lanesOfMode(mode) {
  const lanes = [];
  if (modeServesPrerender(mode)) lanes.push('user', 'background', 'queue', 'stream');
  if (modeServesAgent(mode)) lanes.push('agent');
  return lanes;
}

/**
 * Error when a request for a lane is rejected in this mode (`status` / `code` / `retryable`,
 * returned as is by the router); returns null if not rejected.
 *
 * - Agent requests (`lane === 'agent'`) arriving in `user` mode: `503 NO_AGENT_LANE` (same code as
 *   when editor process has no Agent lane, which callers already recognize); not retryable: mode
 *   is fixed at process startup, retrying still hits this process.
 * - Prerender requests (remaining lanes) arriving in `agent` mode: `503 NO_PRERENDER`, likewise not
 *   retryable.
 */
export function modeRefusal(mode, lane) {
  if (lane === 'agent') {
    if (modeServesAgent(mode)) return null;
    return Object.assign(new Error(`This prerender process is in ${mode} mode and has no Agent lane: it does not accept Agent queries.`),
      { status: 503, code: 'NO_AGENT_LANE', retryable: false, mode });
  }
  if (modeServesPrerender(mode)) return null;
  return Object.assign(new Error(`This prerender process is in ${mode} mode: it only accepts Agent queries and does not prerender (requested lane: ${lane}).`),
    { status: 503, code: 'NO_PRERENDER', retryable: false, mode });
}
