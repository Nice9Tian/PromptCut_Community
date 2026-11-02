/**
 * The `device` string of cost records (K1 / J4): **assembled in one place, shared by both paths.**
 *
 * The deduplication key in `costs-store.mjs` is `${identityKey} ${device}`, so every single byte
 * of this string determines "which entries are the same benchmark result". Today, two paths write
 * cost records:
 *
 *   - Offline probe `scripts/probe-card-costs.mjs` (Node + one host page);
 *   - Resident probe `src/editor/probeRunner.ts` (editor main document, runs under `ProbeGate` overlay).
 *
 * If each path assembled it separately, any discrepancy in ordering, whitespace, or `true` / `false`
 * formatting would make measured records invisible to each other: every time a project is opened,
 * the resident probe would re-measure all 62 cards that the offline probe just tested, and both
 * sets of records would sit in `out/card-costs.json` unable to use each other (singled out by R4a
 * report §8 item 10 for extraction). Therefore, only this single assembly format is kept,
 * and both sides `import` it.
 *
 * # What is in the string and why
 *
 *   `<UA> | <GPU renderer> | lowMemory=<bool> | offscreenGl=<bool> | glRoute=<route> | mode=<dev|build> | stepP=<percentile> | stepN=<minSamples>`
 *
 *   The field name of the third segment is a historical name (an old tier revoked on 2026-10-07),
 *   kept **solely to preserve every single byte of old record keys** (constantly `false` in desktop app;
 *   renaming it would cause every desktop app to re-measure all cards in projects after upgrading);
 *   its current value is "only one stage" (`compact`: online page stage gate stops at level one,
 *   the lowest tier), ensuring numbers measured from single-stage and dual-stage setups on the same
 *   device do not mix.
 *
 * - **UA + GPU renderer**: Switching machines or graphics cards makes elapsed time for the same card
 *   a completely different story (K1).
 * - **`compact` / `offscreenGl` / `glRoute`** (J4): Which route the shared WebGL renderer takes
 *   changes canvas card costs; `glRoute` takes the **effective value** (online page follows the stage
 *   gate; desktop app follows project options, defaulting to route 1, 3.6).
 * - **`mode`** (3.1): The desktop app runs on the vite dev server, so dev numbers represent the real
 *   runtime environment; build numbers are for the future online browser mode. If not included, the
 *   two sets would overwrite each other.
 * - **`stepP` / `stepN`** (K2 "tunable coefficients"): They determine how `stepMs` is sampled;
 *   changing them is equivalent to **changing the measurement method**, and old results should no
 *   longer be used: by including them, old records naturally miss and will be re-measured.
 *   **`COST_SCALE` is not included**: it only affects how these numbers are used (classification
 *   as heavy and weights), not the measured numbers themselves.
 *
 * # Pure function
 *
 * `costDeviceString` does not read files, inspect environment variables, or touch the DOM; identical
 * inputs produce identical outputs: calling it once in Node and once in the browser is guaranteed
 * to be byte-for-byte identical. The two items that need to touch the DOM (GPU string, UA) are
 * separated out to be read by callers on their own side and passed in.
 */

import { resolveTuning } from './pipelineTuning.mjs';

/** Separator between fields. Changing it invalidates all old records, so it is singled out as a constant reminder */
export const COST_DEVICE_SEPARATOR = ' | ';

/** Field name of the third segment (historical name, see file header). Changing it invalidates all old records */
export const COST_DEVICE_COMPACT_FIELD = 'lowMemory';

/**
 * Two routes for the shared WebGL renderer (3.6 / M2): use the valid route if provided, otherwise
 * use `fallback` (default route 1 `perDocument`).
 * Desktop app: project options take precedence, defaulting to route 1; online page: caller passes
 * the route determined by the stage gate as `glRoute` (`tierGlRoute` in `online/onlineTier.ts`).
 */
export function resolveGlRoute(glRoute, fallback = 'perDocument') {
  if (glRoute === 'perDocument' || glRoute === 'shared') return glRoute;
  return fallback === 'shared' ? 'shared' : 'perDocument';
}

/**
 * Assemble a `device` string.
 *
 * @param {object} parts
 * @param {string} parts.ua           `navigator.userAgent`
 * @param {string} parts.renderer     WebGL's `UNMASKED_RENDERER_WEBGL` (provide `'unknown'` if unreadable)
 * @param {boolean} parts.compact     J4 host capability: only one stage (written under historical field name, see file header)
 * @param {boolean} parts.offscreenGl J4 host capability
 * @param {string} [parts.glRoute]    Effective route; defaults to route 1 if omitted
 * @param {string} parts.mode         `'dev' | 'build'`; all other values are treated as `'dev'` (records prior to R1 are dev)
 * @param {object} [parts.tuning]     K2 coefficients (accepts both resolved and raw override values, `resolveTuning` is idempotent)
 */
export function costDeviceString(parts) {
  const p = parts && typeof parts === 'object' ? parts : {};
  const tuning = resolveTuning(p.tuning);
  const compact = !!p.compact;
  return [
    String(p.ua ?? ''),
    String(p.renderer ?? 'unknown'),
    `${COST_DEVICE_COMPACT_FIELD}=${compact}`,
    `offscreenGl=${!!p.offscreenGl}`,
    `glRoute=${resolveGlRoute(p.glRoute)}`,
    `mode=${p.mode === 'build' ? 'build' : 'dev'}`,
    `stepP=${tuning.STEP_PERCENTILE}`,
    `stepN=${tuning.STEP_MIN_SAMPLES}`,
  ].join(COST_DEVICE_SEPARATOR);
}

/**
 * Read the local GPU's `UNMASKED_RENDERER_WEBGL`. **Creates a one-off canvas in caller's document**,
 * without touching the stage's own shared WebGL context (route 1 of M2 permits only one per
 * document); immediately releases it via `WEBGL_lose_context` after reading, avoiding taking up
 * a context slot (Chrome caps at 16 per document).
 *
 * Returns `'unknown'` if unreadable: software rendering, `--disable-gpu`, or disabled extensions
 * will all hit this branch, in which case the `device` string contains `unknown`, remaining
 * self-consistent on the same machine.
 */
export function readGpuRenderer(doc = typeof document === 'undefined' ? null : document) {
  if (!doc) return 'unknown';
  try {
    const canvas = doc.createElement('canvas');
    const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) return 'unknown';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const value = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    try { gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* Not getting back does not count as a failure either */ }
    return value;
  } catch {
    return 'unknown';
  }
}
