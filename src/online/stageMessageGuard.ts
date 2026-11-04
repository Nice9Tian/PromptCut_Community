/**
 * Parent page validation of stage messages (contract `docs/plan/online-card-exec-contract.md`
 * section 3.2 "Protocol plane").
 *
 * Cross-origin stages execute code from user cards and media effect cards; **treat everything sent
 * by the stage as untrusted input**: only accept messages where `event.source` is the stage mounted
 * by itself and `event.origin` is the stage origin in the runtime config (origins are verified in
 * the `stageRpc.ts` client and `Preview.tsx`); content is validated by shape here, numbers are
 * clamped to reasonable ranges, and unrecognized types or incorrect shapes are discarded without
 * exception. The parent page never passes credentials or tickets back over RPC, nor does it insert
 * HTML handed over by the stage into its live document.
 *
 * Enabled only on online cross-origin stages (`createStageRpc(…, { untrusted: true })`); desktop
 * runtime environments and same-origin single stages remain as before, not a single byte changed.
 * Pure functions, no dependencies, verified line by line by unit tests.
 */

/** Various upper bounds. All are "an order of magnitude wider than normal usage", only to block bad data, not business rules */
export const STAGE_MESSAGE_LIMITS = Object.freeze({
  /** Time (seconds): even the longest project will not reach a day */
  maxSec: 86_400,
  /** Elapsed time values (milliseconds): capped at ten minutes */
  maxMs: 600_000,
  /** Frame number */
  maxFrame: 10_000_000,
  /** Short strings such as clip IDs and session IDs */
  maxIdLength: 512,
  /** Cost identity (stable JSON of the node) */
  maxIdentityLength: 262_144,
  /** Number of clips in a single event */
  maxClipIds: 5_000,
  /** HTML of a single-frame snapshot (characters) */
  maxHtmlLength: 16 * 1024 * 1024,
  /** Byte chunk transferred with the message */
  maxBufferBytes: 64 * 1024 * 1024,
  /** Maximum length of a side of a bitmap transferred with the message (pixels needed when generating snapshots), and upper bound for absolute values of rectangle coordinates */
  maxPixelSide: 8192,
  /** Nesting depth and total node count of RPC responses */
  maxDepth: 12,
  maxNodes: 400_000,
  /** Absolute value of ordinary numbers in RPC responses */
  maxAbs: 1e12,
});

const L = STAGE_MESSAGE_LIMITS;
const HASH = /^[0-9a-f]{64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Clamps finite numbers to [min, max]; returns null if not a finite number */
function num(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  return v < min ? min : v > max ? max : v;
}
function int(v: unknown, min: number, max: number): number | null {
  const n = num(v, min, max);
  return n === null ? null : Math.trunc(n);
}
function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length <= max ? v : null;
}
function buf(v: unknown, max: number = L.maxBufferBytes): ArrayBuffer | null {
  return v instanceof ArrayBuffer && v.byteLength <= max ? v : null;
}

/**
 * Pixels for `bake-frame` (used by browser nodes to produce track streams): `{ rect: { x, y, w, h }, bitmap }`.
 * The rectangle values must be integers, with even width and height not exceeding the upper limit;
 * the bitmap must actually be an `ImageBitmap`, with size matching the rectangle. The bitmap is just
 * an image; the parent page sends it to the encoder and does not put it into the live document.
 * Returns null if the shape does not match.
 */
function pixelsOf(v: unknown): { rect: { x: number; y: number; w: number; h: number }; bitmap: unknown } | null {
  if (!isObj(v) || !isObj(v.rect)) return null;
  const x = v.rect.x as number, y = v.rect.y as number, w = v.rect.w as number, h = v.rect.h as number;
  for (const n of [x, y, w, h]) if (typeof n !== "number" || !Number.isInteger(n)) return null;
  if (w < 2 || h < 2 || w % 2 || h % 2 || w > L.maxPixelSide || h > L.maxPixelSide) return null;
  if (Math.abs(x) > L.maxPixelSide || Math.abs(y) > L.maxPixelSide) return null;
  const Bitmap = (globalThis as { ImageBitmap?: new (...a: never[]) => unknown }).ImageBitmap;
  const bitmap = v.bitmap as { width?: unknown; height?: unknown } | null;
  if (typeof Bitmap !== "function" || !(bitmap instanceof Bitmap) || bitmap?.width !== w || bitmap?.height !== h) return null;
  return { rect: { x, y, w, h }, bitmap };
}

type Clean = Record<string, unknown> & { type: string };

/**
 * Validates stage events (`StageEvent`) by shape; returns a new object containing only recognized
 * fields, or returns null if shape does not match.
 * The static type of the return value is left for caller to assert (this file does not import
 * render-layer types to avoid cycles).
 * `opts.maxSec`: upper bound for time fields (`sec`), typically given as project duration.
 */
export function sanitizeStageEvent(d: unknown, opts: { maxSec?: number } = {}): Clean | null {
  if (!isObj(d) || typeof d.type !== "string") return null;
  // Upper bound for time: use project duration if provided by the caller (the playhead must not be
  // carried outside the timeline by timestamps reported by the stage), or use general upper bound
  // if not provided
  const maxSec = typeof opts.maxSec === "number" && Number.isFinite(opts.maxSec) && opts.maxSec >= 0 ? Math.min(opts.maxSec, L.maxSec) : L.maxSec;
  switch (d.type) {
    case "mediaReady": case "frame": case "ended": {
      const sec = num(d.sec, 0, maxSec);
      return sec === null ? null : { type: d.type, sec };
    }
    case "settled": {
      const sec = num(d.sec, 0, maxSec);
      if (sec === null || !Array.isArray(d.clipIds) || d.clipIds.length > L.maxClipIds) return null;
      const clipIds: string[] = [];
      for (const c of d.clipIds) { const s = str(c, L.maxIdLength); if (s === null) return null; clipIds.push(s); }
      return { type: "settled", sec, clipIds };
    }
    case "probe": {
      const identityKey = str(d.identityKey, L.maxIdentityLength);
      const fps = num(d.fps, 1, 240);
      const stepMs = num(d.stepMs, 0, L.maxMs), inlineMs = num(d.inlineMs, 0, L.maxMs), rasterMs = num(d.rasterMs, 0, L.maxMs);
      const serializeMs = num(d.serializeMs, 0, L.maxMs), catchUpMs = num(d.catchUpMs, 0, L.maxMs);
      if (identityKey === null || fps === null || stepMs === null || inlineMs === null || rasterMs === null || serializeMs === null || catchUpMs === null) return null;
      if (d.kind !== "random" && d.kind !== "stepped") return null;
      const out: Clean = { type: "probe", identityKey, fps, stepMs, inlineMs, rasterMs, serializeMs, catchUpMs, kind: d.kind };
      if (typeof d.capped === "boolean") out.capped = d.capped;
      if (typeof d.vtOk === "boolean") out.vtOk = d.vtOk;
      if (typeof d.seekOk === "boolean") out.seekOk = d.seekOk;
      if (d.seekMs === null) out.seekMs = null;
      else if (d.seekMs !== undefined) { const s = num(d.seekMs, 0, L.maxMs); if (s === null) return null; out.seekMs = s; }
      return out;
    }
    case "net-speed": {
      const samples = int(d.samples, 0, 1e9);
      if (samples === null || typeof d.smallFirst !== "boolean") return null;
      const mbps = d.mbps === null ? null : num(d.mbps, 0, 1e6);
      if (d.mbps !== null && mbps === null) return null;
      return { type: "net-speed", mbps, samples, smallFirst: d.smallFirst };
    }
    case "demote": {
      const clipId = str(d.clipId, L.maxIdLength);
      return clipId === null ? null : { type: "demote", clipId };
    }
    case "probe-frame": {
      const clipId = str(d.clipId, L.maxIdLength), localFrame = int(d.localFrame, 0, L.maxFrame), html = str(d.html, L.maxHtmlLength);
      if (clipId === null || localFrame === null || html === null) return null;
      const out: Clean = { type: "probe-frame", clipId, localFrame, html };
      if (d.htmlGz !== undefined) { const b = buf(d.htmlGz); if (!b) return null; out.htmlGz = b; }
      return out;
    }
    case "bake-frame": {
      const session = str(d.session, L.maxIdLength), clipId = str(d.clipId, L.maxIdLength), localFrame = int(d.localFrame, 0, L.maxFrame);
      const hash = str(d.hash, 64), bytes = int(d.bytes, 0, L.maxBufferBytes);
      if (session === null || clipId === null || localFrame === null || hash === null || !HASH.test(hash) || bytes === null) return null;
      const out: Clean = { type: "bake-frame", session, clipId, localFrame, hash, bytes };
      if (d.htmlGz !== undefined) { const b = buf(d.htmlGz); if (!b) return null; out.htmlGz = b; }
      if (d.htmlRaw !== undefined) { const b = buf(d.htmlRaw); if (!b) return null; out.htmlRaw = b; }
      if (d.small === null) out.small = null;
      else if (d.small !== undefined) {
        if (!isObj(d.small)) return null;
        const sh = str(d.small.hash, 64), sb = int(d.small.bytes, 0, L.maxBufferBytes), webp = buf(d.small.webp);
        if (sh === null || !HASH.test(sh) || sb === null || !webp) return null;
        out.small = { hash: sh, bytes: sb, webp };
      }
      if (d.pixels === null) out.pixels = null;
      else if (d.pixels !== undefined) {
        const px = pixelsOf(d.pixels);
        if (!px) return null;
        out.pixels = px;
      }
      return out;
    }
    case "card-states": {
      // Online execution of user cards and media effect cards: execution status of each card.
      // Status names recognize only the ten kinds in contract section 8, text is truncated;
      // graphics capabilities recognize only the few on the list
      const states = runStatePairs(d.states);
      if (!states) return null;
      const graph = typeof d.graph === "string" && GRAPH_CAPS.has(d.graph) ? d.graph : null;
      if (graph === null || typeof d.visual !== "boolean") return null;
      return { type: "card-states", states, graph, visual: d.visual };
    }
    case "sound-state": {
      if (d.state === null) return { type: "sound-state", state: null };
      if (!isObj(d.state)) return null;
      const ready = textMap(d.state.ready, 64), blocked = textMap(d.state.blocked, 240);
      if (!ready || !blocked) return null;
      return { type: "sound-state", state: { ready, blocked } };
    }
    default:
      return null;
  }
}

const RUN_STATES = new Set(["ready", "loading", "unsupported-syntax", "missing-module", "load-error", "gpu", "media", "runtime-error", "not-isolated"]);
const GRAPH_CAPS = new Set(["unknown", "ok", "no-webgl2", "software", "texture", "context-lost"]);
/** Upper bound on the number of synced cards (same order of magnitude as sync tables and manifest plans) */
const MAX_CARDS = 500;

/** `[card id, execution status][]`: collected item by item by shape; returns null if shape does not match */
function runStatePairs(v: unknown): [string, Record<string, string>][] | null {
  if (!Array.isArray(v) || v.length > MAX_CARDS) return null;
  const out: [string, Record<string, string>][] = [];
  for (const pair of v) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const id = str(pair[0], 200), s = pair[1];
    if (id === null || !id || !isObj(s) || typeof s.state !== "string" || !RUN_STATES.has(s.state)) return null;
    const state: Record<string, string> = { state: s.state };
    for (const [k, max] of [["detail", 300], ["file", 200], ["version", 64]] as const) {
      if (s[k] === undefined) continue;
      if (typeof s[k] !== "string") return null;
      if (s[k]) state[k] = (s[k] as string).slice(0, max);
    }
    out.push([id, state]);
  }
  return out;
}

/** `{ card id: short text }`: retains only string values and truncates them; returns null if not an object */
function textMap(v: unknown, max: number): Record<string, string> | null {
  if (!isObj(v)) return null;
  const out: Record<string, string> = {};
  let n = 0;
  for (const k of Object.keys(v)) {
    if (++n > MAX_CARDS) return null;
    const t = v[k];
    if (!k || k.length > 200 || typeof t !== "string") return null;
    if (t) out[k] = t.slice(0, max);
  }
  return out;
}

/** Methods containing numbers that go into cost records: elapsed times inside are all clamped to [0, maxMs] */
const TIMING_METHODS = new Set(["render", "setTime", "bakeFrame", "settleLayers"]);
const TIMING_KEYS = new Set(["elapsedMs", "stepMs", "inlineMs", "rasterMs", "serializeMs", "seekMs", "ms", "pausedMs", "smallMs", "readyMs", "catchUpMs"]);

/**
 * Sanitizes RPC response results by shape: allows only plain objects, arrays, strings, booleans,
 * null, finite numbers, and byte chunks; with upper bounds on depth, node count, and string length;
 * clamps numbers to reasonable ranges (elapsed times cannot be negative and are capped at ten
 * minutes). Throws if shape does not match (the caller rejects this call as failed).
 * Mutates in place and returns the same value.
 */
export function sanitizeRpcResult(method: string, result: unknown): unknown {
  let nodes = 0;
  const timing = TIMING_METHODS.has(method);
  const walk = (v: unknown, depth: number, key: string | null, inTiming: boolean): unknown => {
    if (++nodes > L.maxNodes) throw new Error("stage rpc: response too large");
    if (v === null || v === undefined || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return 0;
      if (timing && (inTiming || (key !== null && TIMING_KEYS.has(key)))) return v < 0 ? 0 : v > L.maxMs ? L.maxMs : v;
      return v < -L.maxAbs ? -L.maxAbs : v > L.maxAbs ? L.maxAbs : v;
    }
    if (typeof v === "string") {
      if (v.length > L.maxHtmlLength) throw new Error("stage rpc: string in response too long");
      return v;
    }
    if (typeof v !== "object") throw new Error("stage rpc: response contains an unrecognized value");
    if (v instanceof ArrayBuffer) { if (v.byteLength > L.maxBufferBytes) throw new Error("stage rpc: byte buffer in response too large"); return v; }
    if (ArrayBuffer.isView(v)) { if (v.byteLength > L.maxBufferBytes) throw new Error("stage rpc: byte buffer in response too large"); return v; }
    if (depth >= L.maxDepth) throw new Error("stage rpc: response nested too deeply");
    if (Array.isArray(v)) {
      // `steps` (live render duration per frame) is a sequence of numbers: clamp the entire sequence
      // as elapsed times
      const t = inTiming || (timing && (key === "steps"));
      for (let i = 0; i < v.length; i++) v[i] = walk(v[i], depth + 1, null, t);
      return v;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error("stage rpc: response contains an unrecognized object");
    const o = v as Record<string, unknown>;
    // Keys for the three elapsed times in `snapshot` / `snapshotSteps[]` are themselves in TIMING_KEYS;
    // `glGpuMs` is a "card → ms" map, clamped across the entire map as elapsed times
    const t = inTiming || (timing && key === "glGpuMs");
    for (const k of Object.keys(o)) o[k] = walk(o[k], depth + 1, k, t);
    return o;
  };
  return walk(result, 0, null, false);
}

/** Shell of RPC responses (`pc-rpc-reply`): `error` retains only a short string */
export function sanitizeRpcError(error: unknown): string | undefined {
  if (typeof error !== "string") return undefined;
  return error.length > 2000 ? `${error.slice(0, 2000)}…` : error;
}

/** Host capabilities table in the handshake: recognizes only these items, accepted by type; returns null if not an object */
export function sanitizeHostCapabilities(d: unknown): { prerender: boolean; offscreenGl: boolean; compact: boolean; glRoute: "perDocument" | "shared" | null; lowest: boolean; measure: boolean; catchUp: boolean; stageId: string } | null {
  if (!isObj(d)) return null;
  return {
    prerender: d.prerender === true,
    offscreenGl: d.offscreenGl === true,
    compact: d.compact === true,
    glRoute: d.glRoute === "perDocument" || d.glRoute === "shared" ? d.glRoute : null,
    lowest: d.lowest === true,
    measure: d.measure === true,
    catchUp: d.catchUp === true,
    stageId: d.stageId === "B" ? "B" : "A",
  };
}
