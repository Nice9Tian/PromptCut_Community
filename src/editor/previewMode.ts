/**
 * Which path the preview takes: **the rollback switch `?preview=legacy` and the dual-stage switch
 * `?preview=stage`** (D5 / F2).
 *
 * **R7 flipped the default**: with no parameter, with `?preview=stage`, or with any other value,
 * the preview runs on the cross-origin dual stage. The stage iframe is exposed directly, the
 * playhead is pushed by the visible stage on its frame tick (K4), and the main document keeps only
 * audio. To go back to the old path you must write `?preview=legacy` explicitly: one same-origin
 * stage iframe, a full-frame `<img>` preview, and the playhead pushed by the rAF loop in `Preview`.
 *
 * During R2~R6 the default was legacy and everything new hid behind `?preview=stage`. The
 * acceptance check for those steps was "visible behavior unchanged item by item", while the new
 * behavior needs two more ports and iframe source swaps, which the editor in a user's hands would
 * hit on any refresh. R7 is the first step that **deliberately** changes user-visible behavior,
 * so this is the step where the default flips.
 * **Why it must flip atomically together with the rest of D5**: see the end of D5 in
 * `docs/archive/restructure_planning/r2-r7-task.md`.
 *
 * The `LEGACY` in `StageView` itself (with `?preview=legacy`, `setProject` immediately recomputes
 * this frame as a jump) is **the other half** of the rollback. Before R7-6, `Preview` never passed
 * the `preview` parameter into the iframe, so it never took effect. Now `stageSrc` passes
 * `&preview=legacy` along under legacy, which makes D5's "both things take effect" true. The
 * `?preview=stage` branch is unaffected (the stage only recognizes `preview=stage` to enable the
 * live variant; the two values are mutually exclusive).
 */

import { ONLINE } from "../online/mode";
import { singleStageTier, tierStart } from "../online/onlineTier";
import { onlineStageState, stageLayout } from "../online/stageOrigins";
import { STAGE_ENTRY_FILE } from "../online/isolation/stageGuard";
import { tr } from "../i18n/index.ts";

/** Stage instance name. **Only an instance name, unrelated to the role** (E1): which one is `front` is decided by `setRole` */
export type StageId = "A" | "B";

export const STAGE_IDS: readonly StageId[] = ["A", "B"];

/** Initial role assignment: A is the visible stage, B is the background stage. After the K5 swap this table no longer applies */
export const INITIAL_ROLE_OF: Record<StageId, "front" | "back"> = { A: "front", B: "back" };

export type PreviewMode = "legacy" | "stage";

const paramOf = (): string => (typeof location === "undefined" ? "" : new URLSearchParams(location.search).get("preview") || "");

/**
 * **The default is stage (R7's atomic switch)**; only an explicit `?preview=legacy` falls back to
 * the single stage + full-frame path.
 *
 * `?preview=stage` is still accepted. It now means the same as no parameter, and is kept because
 * the probes, docs and users' bookmarks from R2~R6 all use it. Any other value (typos, old links)
 * always takes the default, stage.
 */
export function previewMode(): PreviewMode {
  return paramOf() === "legacy" ? "legacy" : "stage";
}

/**
 * The stage ports the editor process actually started (injected by
 * `server/vite-plugin-stage-ports.ts`). If a port is taken, or in an environment without this
 * plugin (the vite preview bundle), this is an empty table.
 */
export function stagePorts(): number[] {
  const v = (window as unknown as { __PC_STAGE_PORTS__?: unknown }).__PC_STAGE_PORTS__;
  return Array.isArray(v) ? v.filter((n): n is number => typeof n === "number") : [];
}

/**
 * Which origin each stage instance loads from. **Built from the current page's hostname** (not
 * hardcoded 127.0.0.1): when the user opens from `localhost`, both iframes must also be on
 * `localhost`. Same host with different ports + OAC headers is the path that was verified in
 * practice (`docs/archive/restructure_planning/g0-a-webview2-probe.md`); any other host would be a
 * different matter.
 */
export function stageOrigins(): Record<StageId, string> | null {
  // Online browser mode (C10 contract, section 2): the stage origin comes from the runtime config (`/editor/runtime-config.json`), not the stage port table
  if (ONLINE) return onlineStageState().origins;
  const ports = stagePorts();
  if (ports.length < STAGE_IDS.length) return null;
  const out = {} as Record<StageId, string>;
  STAGE_IDS.forEach((id, i) => { out[id] = `${location.protocol}//${location.hostname}:${ports[i]}`; });
  return out;
}

/**
 * Whether to enable the dual stage this time. Both conditions are required: `?preview=stage` was
 * explicitly set, and both stage ports are up. If either is missing, fall back to legacy's
 * same-origin single stage. Better to lack a background stage than to leave the editor unable to
 * show a picture.
 */
export function dualStage(): boolean {
  /*
   * Online browser mode (C10 contract, section 2): open two same-site cross-origin stages, with the
   * stage origin from the runtime config. If the stage gate stops at the first tier (lean mode,
   * low-spec mode), only the cross-origin single stage A is opened (`online/onlineTier.ts`). If the
   * handshake fails, fall back to the cross-origin single stage A. If the config can't be read, no
   * stage is mounted and there is no fallback to the same-origin single stage (user decision,
   * 2026-10-14). The stage port table is never consulted online.
   */
  if (ONLINE) {
    const st = onlineStageState();
    return stageLayout({ single: singleStageTier(), origins: st.origins, handshake: st.handshake, pageOrigin: typeof location === "undefined" ? undefined : location.origin }) === "dual";
  }
  return previewMode() === "stage" && stageOrigins() !== null;
}

/**
 * The transition period for the first online dual-stage handshake (`interim` in
 * `stageHandshake.ts`) has been revoked (user decision, 2026-10-14: all stages are cross-origin
 * isolated, and the path back to the same-origin single stage is removed).
 * Returns false directly.
 */
export function interimStage(): boolean {
  return false;
}

/**
 * **Single-stage live preview** in online browser mode (`docs/plan/c10a-contract.md`, section 8.1):
 * the cross-origin single stage A renders the live variant (the media layer is drawn into the
 * stage and the six planes take effect, equivalent to the `&preview=stage` variant in the dual
 * stage). A is the visible stage, and there is no B. Both the dual stage and the single stage (the
 * stage gate's first tier, the fallback after a handshake failure) use it; `?preview=legacy` is
 * not recognized on online pages (no prerender process supplies full frames).
 */
export function singleLiveStage(): boolean {
  return ONLINE;
}

/** The visible stage renders the live variant (dual stage, or the single stage of an online page): the playhead follows the stage's `frame`, and snapshots / suppression are delivered via RPC */
export function liveStage(): boolean {
  return dualStage() || singleLiveStage();
}

/**
 * The address of the stage iframe. Under legacy (or when ports didn't start) it is same-origin,
 * with only A.
 *
 * **`&preview=stage` is added only when the dual stage is enabled** (R3): the stage page uses it to
 * decide whether to render the live variant of `FrameScene` (the media layer enters the stage and
 * the six plane props take effect) or, as before, render only `Stage`. Without it = the editor in
 * users' hands today, with the stage content unchanged by a single character. This is where "new
 * behavior only takes effect outside legacy" lands.
 *
 * **`?preview=legacy` is passed along as well** (D5 / R7-6): the `LEGACY` of the same name in
 * `StageView` (`setProject` immediately recomputes this frame as a jump) is the other half of the
 * rollback. It never received this parameter before and never took effect. Under legacy, after the
 * project was edited, the stage DOM stayed in its old state until the next `setTime`, yet legacy
 * relies on the stage for hit testing and entity boxes. The fallback when ports didn't start
 * **does not pass it**: that is not a rollback but the dual stage failing to open, and the stage
 * content should follow the default.
 */
export function stageSrc(id: StageId, opts: { dual?: boolean } = {}): string {
  // `opts.dual`: build the address for the dual-stage / single-stage shape, ignoring the current layout (needed for the handover when switching back)
  const dual = opts.dual ?? dualStage();
  const origins = ONLINE ? stageOrigins() : dual ? stageOrigins() : null;
  if (ONLINE && (!origins || !origins[id])) {
    throw new Error(tr("[previewMode] The online stage has no cross-origin isolated origin configured, falling back to the same-origin stage is forbidden: stage {0}", id));
  }
  const mode = dual || singleLiveStage() ? "&preview=stage" : previewMode() === "legacy" ? "&preview=legacy" : "";
  // Online browser mode has no runtime criterion yet, so it is turned on explicitly by `platform=browser` in the editor page address and forwarded to the stage (`unsupported` placeholder)
  const platform = new URLSearchParams(location.search).get("platform") === "browser" ? "&platform=browser" : "";
  /*
   * `dual=1`: this stage has a background stage as a companion, so the host capability table
   * honestly reports "can measure, can frame catch-up on live render" (C10 contract, section 2).
   * Online pages also carry a few items decided by the parent page according to the gate (a
   * cross-origin stage can't read the page-local storage of the editor page's origin; crash records
   * and gate results are all on the editor page):
   * `gl=shared|perDocument`, the initial canvas rendering route (when trying the third tier the
   * parent page switches it via RPC `setGlRoute`); `compact=1`, only one stage (the atlas opens with
   * a small limit); `lowest=1`, the lowest tier (media starts with only small sizes, without waiting
   * for the parent page's tier selection policy to take effect).
   */
  const dualFlag = dual ? "&dual=1" : "";
  // Built only from the initial shape fixed at page load (`tierStart`): switching route mid-trial goes through RPC `setGlRoute`, and when the benchmark card judges the lowest tier it goes through the tier selection policy; neither changes the address (changing it would reload the iframe)
  const tier = ONLINE ? `&gl=${tierStart().route}${dual ? "" : "&compact=1"}${tierStart().lowest ? "&lowest=1" : ""}` : "";
  /*
   * The online cross-origin stage loads a separate stage entry, `stage.html` (the same script
   * bundle; contract `online-card-exec-contract.md`, section 3.3): it carries the stage's content
   * security policy (`<meta>` as a fallback), and hardening and self-checks recognize it by this
   * path (`isolation/stageGuard.ts`). The fallback address when the desktop runtime ports aren't up
   * is unchanged by a single character.
   */
  // Built from the build's base (`/editor/stage.html`): the editor page's address may be `/editor` without a trailing slash, so its directory part can't be used
  const base = typeof import.meta.env !== "undefined" && import.meta.env.BASE_URL ? import.meta.env.BASE_URL : "/";
  const path = ONLINE && origins ? `${base.endsWith("/") ? base : `${base}/`}${STAGE_ENTRY_FILE}` : location.pathname;
  return `${origins ? origins[id] : ""}${path}?stage=1&id=${id}${mode}${platform}${dualFlag}${tier}`;
}

/** The `targetOrigin` for `createStageRpc`: when cross-origin it must be named explicitly, and `location.origin` can't be used */
export function stageTargetOrigin(id: StageId): string {
  const origins = ONLINE ? stageOrigins() : dualStage() ? stageOrigins() : null;
  if (ONLINE && (!origins || !origins[id])) {
    throw new Error(tr("[previewMode] The online stage has no cross-origin isolated origin configured, falling back to the same-origin stage is forbidden: stage {0}", id));
  }
  return origins ? origins[id] : location.origin;
}
