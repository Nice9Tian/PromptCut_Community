/**
 * The two stages of the online dual stage (C10 contract `docs/plan/c10-contract.md` section 2;
 * semantics `mechanism/rendering.md` "Stage": there are two stages).
 *
 * - **Stage origins**: The two stages A and B each use one origin, same-site cross-origin with the
 *   editor page, and responses from all three parties carry `Origin-Agent-Cluster: ?1` (added by
 *   nginx or the local proxy).
 *   The page fetches stage origins from the runtime config `/editor/runtime-config.json` (written
 *   by `cloud/scripts/remote/docservice.mjs deploy-hosted --stage-origins`):
 *
 *       { "v": 1, "stageOrigins": ["https://s1.<host>", "https://s2.<host>"] }
 *
 *   The same config also contains the host's master switch `"onlineCardExec": false` (contract
 *   `online-card-exec-contract.md`; enabled by default): turning it off disables online execution
 *   of user cards and media effect cards, falling back completely to the original approach
 *   (`parseCardExecSwitch`).
 *
 * - **Cross-origin isolation**: All stages are strictly cross-origin isolated, removing the path to
 *   fall back to a same-origin single stage (user decision, 2026-10-14). When config cannot be read
 *   or is invalid, stages are not mounted; on handshake failure, fall back to cross-origin single
 *   stage A (applies only to the current run, leaving no crash records).
 * - **Stage gate stopped at the first tier** (lite mode, low-spec mode, `onlineTier.ts`): only open
 *   single stage A, not background stage B; single stage A must likewise be a cross-origin isolated
 *   stage.
 *
 * This module belongs to the render layer (`src/online/`): does not import editor; does not read
 * `import.meta.env` (caller passes `base` in).
 */

export type StageLetter = "A" | "B";
export type StageOrigins = Record<StageLetter, string>;
/**
 * Progress of the initial handshake. The `interim` transition period has been revoked (all stages
 * are strictly cross-origin isolated, no longer falling back to a same-origin single stage; user
 * decision, 2026-10-14).
 */
export type Handshake = "pending" | "interim" | "ok" | "failed";
export type StageLayout = "dual" | "single";

/** Filename of the runtime config (relative to the base of the online build, i.e., `/editor/`) */
export const RUNTIME_CONFIG_FILE = "runtime-config.json";
/** Time limit for fetching the runtime config */
export const RUNTIME_CONFIG_TIMEOUT_MS = 5000;
/** Time limit for each stage waiting for handshake starting from its iframe's `load`; exceeding it counts as handshake failure, falling back to cross-origin single stage A (see `stageHandshake.ts` for timing and total upper bound) */
export const STAGE_HANDSHAKE_TIMEOUT_MS = 20_000;

/** An origin: `http(s)://host[:port]`, without path, query, or fragment */
function originOf(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const text = v.trim().replace(/\/+$/, "");
  if (!text) return null;
  try {
    const u = new URL(text);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (u.pathname !== "/" || u.search || u.hash || u.username || u.password) return null;
    return u.origin === text ? text : null;
  } catch {
    return null;
  }
}

/**
 * Runtime config → two stage origins. Accepts a parsed object or JSON text; `stageOrigins` must be
 * two different valid origins (an array, or `{ A, B }`).
 * Returns null without throwing if unreadable or invalid.
 */
export function parseStageOrigins(config: unknown): StageOrigins | null {
  let c: unknown = config;
  if (typeof c === "string") {
    try { c = JSON.parse(c); } catch { return null; }
  }
  if (!c || typeof c !== "object") return null;
  const raw = (c as { stageOrigins?: unknown }).stageOrigins;
  let a: unknown, b: unknown;
  if (Array.isArray(raw)) {
    if (raw.length !== 2) return null;
    [a, b] = raw;
  } else if (raw && typeof raw === "object") {
    a = (raw as { A?: unknown }).A;
    b = (raw as { B?: unknown }).B;
  } else {
    return null;
  }
  const A = originOf(a), B = originOf(b);
  if (!A || !B || A === B) return null;
  return { A, B };
}

/**
 * Master switch "Online execution of user cards and media effect cards" in the runtime config (can
 * be turned off by host): only explicitly writing `"onlineCardExec": false` counts as off; omitting
 * it, writing other values, or config not being an object are all treated as default (on).
 * When config cannot be read, there are no stage origins; it is inherently a same-origin single
 * stage and does not execute, so "cannot be read" needs no separate check.
 */
export function parseCardExecSwitch(config: unknown): boolean {
  let c: unknown = config;
  if (typeof c === "string") {
    try { c = JSON.parse(c); } catch { return true; }
  }
  if (!c || typeof c !== "object") return true;
  return (c as { onlineCardExec?: unknown }).onlineCardExec !== false;
}

/**
 * How many stages to open: if the stage gate stops at the first tier (`single`), only open
 * cross-origin A and do not open background B; on handshake failure, fall back to cross-origin A;
 * if there are no stage origins (config cannot be read) or same-origin with the editor page,
 * also return single (caller determines not to mount based on `origins`, never mounting a
 * same-origin single stage); otherwise dual stage (mounts iframes as dual stage while handshake is
 * in progress).
 * When `pageOrigin` is provided, stage origins cannot be same-origin with the editor page (that
 * would not be cross-origin isolation, treated as unreadable).
 */
export function stageLayout({ single, origins, handshake, pageOrigin }: { single: boolean; origins: StageOrigins | null; handshake?: Handshake; pageOrigin?: string }): StageLayout {
  if (single) return "single";
  if (!origins) return "single";
  if (pageOrigin && (origins.A === pageOrigin || origins.B === pageOrigin)) return "single";
  if (handshake === "failed" || handshake === "interim") return "single";
  return "dual";
}

/**
 * Converts the asset service base URL to a relative URL when passing it to a cross-origin stage:
 * stages strictly read reverse-proxied `/media` **on their own origin** (C10 contract section 2
 * "Stage reads media": same-origin read without relying on CORS, media drawn into canvas does not
 * taint). Returns the path portion when the base URL is same-origin with the editor page; keeps it
 * as is when cross-origin (asset service is on another host).
 */
export function stageAssetBase(base: string, pageOrigin: string): string {
  try {
    const u = new URL(base);
    if (u.origin !== pageOrigin) return base;
    return u.pathname.replace(/\/+$/, "") || "/";
  } catch {
    return base;
  }
}

/* ------------------------------------------------------------------ Page state */

interface State {
  /** Runtime config: not fetched yet / fetching / fetched (may have no stage origins) */
  config: "idle" | "loading" | "done";
  origins: StageOrigins | null;
  handshake: Handshake;
  /** Reason for handshake failure (diagnostics) */
  reason: string | null;
  /** Host master switch: online execution of user cards and media effect cards (enabled by default; turned off only with `onlineCardExec: false` in runtime config) */
  cardExec: boolean;
  /** When `interim` was entered (`Date.now()`); null if never entered. Retained even after switching back to dual stage (Preview uses this for visual continuity during the switch-back) */
  interimAt: number | null;
}

let state: State = { config: "idle", origins: null, handshake: "pending", reason: null, cardExec: true, interimAt: null };
const listeners = new Set<() => void>();
let loading: Promise<StageOrigins | null> | null = null;

function set(patch: Partial<State>) {
  state = { ...state, ...patch };
  for (const l of [...listeners]) { try { l(); } catch { /* The subscriber is broken */ } }
}

export function onlineStageState(): Readonly<State> {
  return state;
}

export function subscribeOnlineStages(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/**
 * Fetches runtime config (called once when page loads; `base` is the online build base, default
 * `/editor/`). Failure to fetch, timeout, or invalid format are all treated as having no stage
 * origins.
 */
export function loadStageConfig({ base = "/editor/", fetchImpl, timeoutMs = RUNTIME_CONFIG_TIMEOUT_MS }: { base?: string; fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<StageOrigins | null> {
  if (loading) return loading;
  set({ config: "loading" });
  let cardExec = true;
  const f = fetchImpl ?? (typeof fetch === "function" ? fetch : null);
  loading = (async () => {
    if (!f) return null;
    const url = `${base.replace(/\/?$/, "/")}${RUNTIME_CONFIG_FILE}`;
    const ctrl = typeof AbortController === "function" ? new AbortController() : null;
    const timer = setTimeout(() => ctrl?.abort(), timeoutMs);
    try {
      const res = await f(url, { cache: "no-store", signal: ctrl?.signal });
      if (!res.ok) return null;
      const text = await res.text();
      cardExec = parseCardExecSwitch(text);
      return parseStageOrigins(text);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })().then((origins) => {
    set({ config: "done", origins, cardExec });
    return origins;
  });
  return loading;
}

/**
 * Result of stage handshake (reported by Preview): does not retry within this page session on
 * failure, and does not fall back to same-origin single stage.
 * `interim` can only be entered from `pending` (if issues arise after switching back to dual stage,
 * do not return to `interim`, proceed to `failed` per watchdog, avoiding flipping back and forth).
 */
export function markStageHandshake(result: Exclude<Handshake, "pending">, reason: string | null = null): void {
  if (state.handshake === result) return;
  if (state.handshake === "failed") return;
  if (result === "interim") {
    if (state.handshake !== "pending") return;
    set({ handshake: result, reason, interimAt: Date.now() });
    return;
  }
  set({ handshake: result, reason: result === "ok" ? null : reason });
}

/** For tests */
export function resetOnlineStagesForTest(next: Partial<State> = {}): void {
  loading = null;
  state = { config: "idle", origins: null, handshake: "pending", reason: null, cardExec: true, interimAt: null, ...next };
  listeners.clear();
}
