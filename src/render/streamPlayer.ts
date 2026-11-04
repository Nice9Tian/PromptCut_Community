/**
 * Track streams on the page side: custom fMP4 demuxing, `VideoDecoder` hardware decoding, WebGL
 * compositing by splitting in half (R8, task brief G5). All stream planes share a single WebGL
 * context (`SharedGl`).
 *
 * **Runs only in stage documents with the `front` role** (decoders and decoded frame budgets are
 * both in `front`; `back` does not create decoders or draw, K5).
 * Draws onto sibling planes already rendered by `Stage`: for single-card streams, this is
 * `<canvas data-pc-stream-plane>` in the wrapper layer; for group streams and below-dependent
 * streams (both produced in stage coordinates), this is `<canvas data-pc-group-plane>` under the
 * stage root; here it only draws onto that canvas and sets its position and size per the manifest,
 * **does not perform external `insertBefore`** (task brief "do not do").
 *
 * # Hard constraints (values set in G0-b)
 *
 *   - **`VideoFrame`s held concurrently by a single `VideoDecoder` ≤ 8 frames**: accumulating 11 to
 *     12 frames deadlocks the decoder and `flush()` never returns; this is a frame count upper
 *     limit, independent of resolution;
 *   - Above this, decoded frame budgets are **calculated by bytes**: total ≤ 80 MB (encoded picture
 *     spliced top-and-bottom, NV12 at 1.5 bytes / pixel), guaranteed 3 frames per stream;
 *   - On-screen streams calculate budget by "pixels to decode per second", with an additional hard
 *     limit on stream count (`./streamBudget.mjs`, stream division side uses the same copy); planes
 *     exceeding budget do not create decoders (`planesWithinBudget`, parent page marks exceeding
 *     planes as `over` based on it), that layer displays a placeholder positioned at the position
 *     rectangle of the segment containing this frame in this stream's manifest;
 *   - At most 2 in-flight requests per stream, pulling whole segments at a time;
 *   - `codec` is assembled from `avcC` (actual SPS level changes with content and cannot be
 *     hardcoded); `isConfigSupported` does not validate level and resolution, and is not used as a
 *     capability criterion.
 *
 * # Rendering method
 *
 * The color half stores **premultiplied color** (G3), shared context outputs with
 * `premultipliedAlpha: true` without performing `rgb × a` again; the plane's 2D canvas is taken as is
 * (see `SharedGl`); shader **clamps once with `rgb = min(rgb, vec3(a))`** (G0-b (5): without
 * clamping, encoding noise in transparent areas is output as is).
 * Texture coordinates are split into two halves per `alphaTop = (H + 8) / (2H + 16)` and
 * `half = H / (2H + 16)`.
 *
 * # Timing
 *
 * The stream is segmented into 15 frames per segment starting from **its own first frame**
 * (`originFrame`, project frame number): project frame F is at sample `(F − originFrame) % 15` of
 * segment `floor((F − originFrame) / 15)` (conversion lives only in `./streamSegments.mjs`, stream
 * production side uses the same copy). `originFrame` is brought by parent page with the stream
 * plane (`StreamPlaneRequest.originFrame`, originating from stream plan), **not fetched from
 * manifest**: that item in manifest records the position when the stream was produced.
 * `EncodedVideoChunk.timestamp = F × 1e6 / fps` (microseconds, rounded; F is project frame number).
 *
 * # When this tick's frame cannot be rendered (same for play, pause, scrub; mechanism/rendering.md "fallback order")
 *
 *   - **Keep the previous frame**, holding at most the duration of one segment (`HOLD_FRAMES`
 *     frames, calculated in real time); only clear stream plane if there is still no new picture
 *     when expired, falling back to a placeholder for this layer.
 *     **The playhead never stops for it**. When paused there is no next tick, so it is cleared by a
 *     real timer upon expiration.
 *   - **Decode only the latest requested frame**. Jumping randomly to a frame requires resetting
 *     decoder and decoding from keyframe of its segment; when seeking continuously (scrubbing), do
 *     not interrupt in-flight seek (resetting at every step yields zero frames, allow at most
 *     `SEEK_PATIENCE_MS`); once decoded, draw it first, then decode frame requested **at this
 *     moment**: intermediate frames were never queued, so none are dropped.
 *   - **Sparse segments contain only duplicated pictures** (`stride` in manifest for this segment is
 *     > 1: every `stride` samples are the same frame). When jumping into a sparse segment, as soon
 *     as nearest frame no later than target frame (`pictureOf`, searching backward only) is decoded,
 *     draw it immediately without decoding all the way to target frame; does not depend on how dense
 *     the sparse version is.
 *   - Notify host once when pictures appear or disappear (`onShowingChange`): frames decode
 *     asynchronously, and there is no next tick while paused: dismissing placeholders and hiding
 *     live subtrees all rely on this notification.
 *
 * # Lowest tier: decode only the first frame of each segment (`StreamPlaneRequest.first`, `presentFirst`)
 *
 * Online browsers with insufficient performance only paste sparse versions of track streams ((user
 * decision, 2026-10-13); assigned to lowest tier starting 2026-10-22). When parent page sets `first`
 * on stream plane, this stream **decodes only the first frame of the segment regardless of whether
 * that segment is sparse or full density**, and pastes it for every frame in this segment (frame
 * number conversion in `streamFirstFrameOf` of `./streamSegments.mjs`):
 *
 *   - Feed only one chunk per segment (that keyframe), call decoder `flush()` after feeding to emit
 *     it; only one chunk is decoding concurrently on the same decoder;
 *   - After drawing, immediately close decode output, keeping only a reference to the canvas frame:
 *     1 frame per stream in steady state, 2 frames during segment switch (3-8 frames per stream in
 *     other tiers);
 *   - Do not decode ahead (no pre-decoding next segment), skip frame-seeking and proxy machinery:
 *     every chunk is a keyframe, seeking to any segment decodes just one chunk;
 *   - If decoder reports errors `FIRST_FRAME_MAX_FAILURES` consecutive times (this device cannot
 *     decode this stream's encoding), stop trying and fall back to placeholder for this layer;
 *   - Everything else (holding previous frame at most one segment, clearing, redrawing on canvas
 *     switch, placeholder positions) follows the same machinery as other tiers.
 */

import { isStreamOrigin, STREAM_SEGMENT_FRAMES, streamFirstFrameOf, streamSegmentFirstFrame, streamSegmentOf } from "./streamSegments.mjs";
import { STREAM_COUNT_BUDGET, streamCost, withinStreamBudget, type StreamBudget } from "./streamBudget.mjs";

/** Number of frames per segment; values and conversions are in `./streamSegments.mjs`, re-exported under legacy name */
export const SEGMENT_FRAMES = STREAM_SEGMENT_FRAMES;
/** G0-b (4): Upper limit on frames held concurrently by a single decoder (hard constraint) */
export const MAX_FRAMES_PER_DECODER = 8;
/** G5: Total decoded frame budget */
export const DECODED_BYTES_BUDGET = 80 * 1024 * 1024;
/** G5: Guaranteed minimum per stream */
export const MIN_FRAMES_PER_STREAM = 3;
/** Hard limit on number of on-screen streams (budget is measured in pixels, see `./streamBudget.mjs`; re-exported under legacy name) */
export const DECODER_BUDGET = STREAM_COUNT_BUDGET;
/** G5: At most 2 in-flight requests per stream */
export const MAX_INFLIGHT_PER_STREAM = 2;
/** When this tick's frame cannot be rendered, keep previous frame for at most this many frames (one segment; converted to real ms by stream frame rate) */
export const HOLD_FRAMES = SEGMENT_FRAMES;
/** How soon the manifest can be queried again (segments will be replaced: sparse → full density) */
export const MANIFEST_REFRESH_MS = 2000;
/**
 * How long an in-flight frame seek (resetting decoder, decoding from segment keyframe to target
 * frame) is allowed to run at most without being interrupted by a new target.
 * When scrubbing continuously, resetting decoder at every step yields zero frames; if target is
 * still not decoded past this threshold, a new target resets it anyway.
 */
export const SEEK_PATIENCE_MS = 250;
/**
 * When there is no frame yet, the frame decoded by an in-flight frame seek (not the frame requested
 * at this moment) is drawn as the first frame only if "fresh enough": elapsed time since this frame
 * seek started does not exceed this duration.
 * The host waits for the first frame before hiding live subtrees; replacing a live component
 * tracking the playhead with an old frame causes the picture to jump backward momentarily.
 * (Measured in prototype `claude/scrub-streams`: at 50, the first frame in rapid scrubbing waits
 * 400 ms; at 100, it does not.)
 */
export const FIRST_PICTURE_LAG_MS = 100;
/** Lowest tier (decode first frame of segment only): after this many consecutive decoder errors, stop trying this stream (falls back to placeholder); resets after decoding a frame */
export const FIRST_FRAME_MAX_FAILURES = 3;
/** Lowest tier: if the chunk sent for decoding has not returned after this long (decoder stuck), reset decoder and resend */
export const FIRST_FRAME_STALL_MS = 1000;

/** Real milliseconds: `performance.now` / `Date.now` in stage are taken over as stage time, escape hatch is `__pcRealNow`; elsewhere (unit tests) it is `Date.now` */
const realNow = (): number => {
  const hatch = (globalThis as { __pcRealNow?: () => number }).__pcRealNow;
  return typeof hatch === "function" ? hatch() : Date.now();
};
/**
 * Real timer: when paused, the stage virtual clock does not tick and virtual timers never fire.
 * Places without an escape hatch (unit tests in Node) use normal timers without holding the
 * process: the refresh timer parked on a sparse segment keeps rescheduling itself, persisting
 * until the stream closes, which would prevent unit test files from exiting.
 */
const realTimeout = (fn: () => void, ms: number): void => {
  const hatch = (globalThis as { __pcRealSetTimeout?: (cb: () => void, ms?: number) => unknown }).__pcRealSetTimeout;
  if (typeof hatch === "function") { hatch(fn, ms); return; }
  const timer = setTimeout(fn, ms) as unknown as { unref?: () => void };
  if (typeof timer?.unref === "function") timer.unref();
};
/** Acquire another reference to this frame (points to same decode output as original; released to decoder only when both closed). Mock frames in unit tests lack `clone` */
const cloneFrame = (frame: VideoFrame): VideoFrame | null => {
  try { return typeof frame.clone === "function" ? frame.clone() : null; } catch { return null; }
};

export interface StreamRect { x: number; y: number; w: number; h: number }

/** An entry sent from parent page via `setStreamPlanes` (C3: composited from layers with `kind: 'stream'` in ready index) */
export interface StreamPlaneRequest {
  /** Length 1 = single-card stream or below-dependent stream (see `plane`); > 1 = group stream (painter's order, last is on top) */
  clipIds: string[];
  /**
   * `"stage"`: this stream with only one card is produced in **stage coordinates** (below-dependent
   * stream, manifest `kind` is `below`; contract `prerender-products-contract.md` section 5.4).
   * Its canvas hangs under stage root (same plane type as group streams) instead of wrapper layer:
   * wrapper layer position, opacity, and emphasis are already rendered into the stream. The stream
   * contains only the layer modified by the target card (premultiplied color plus opacity), overlaying
   * the live lower layer on stage like a normal overlay.
   * Group streams do not need this (more than one member implies stage coordinates).
   */
  plane?: "stage";
  /** Stream key (`key` of that layer in ready index) */
  key?: string;
  /** Closed interval of ready **segment numbers** (unit in C3 `stream` table is segment number) */
  ranges?: Array<[number, number]>;
  /**
   * First frame of this stream itself (project frame number): segments run 15 frames each starting
   * from it. Comes from that layer in ready index (desktop) / that row in layer table (online), both
   * provided by the planning side per current project. Planes lacking it do not create decoders or
   * draw (`planesWithinBudget`).
   */
  originFrame?: number;
  /**
   * Lowest tier: this stream decodes only the first frame of each segment, pasted for every frame in
   * that segment (see "Lowest tier" in file header).
   * Attached by parent page based on tier (`src/editor/snapshotFeed.ts`); absent means decoding frame
   * by frame as usual.
   */
  first?: true;
  /**
   * Over budget for this tick (determined by parent page using `planesWithinBudget`, stage follows it):
   * stage does not create decoders or draw for it, fetching only its manifest and positioning a
   * placeholder using the position rectangle of the segment containing this frame. On online pages,
   * such planes carry only manifests, not bytes.
   */
  over?: true;
  /**
   * Online pages (`docs/plan/browser-stream-task.md` item 7): manifest for this stream is brought along
   * with stream plane by parent page; stage does not fetch it itself.
   * When attached, bytes for this stream are only retrieved from chunks pushed by parent page
   * (`PushedStreamSource`), without touching prerender process URLs. Desktop does not attach it and
   * behaves as before.
   */
  manifest?: StreamManifest;
  /** Chunks pushed with this update (hash → bytes): head files and segments used by manifest not yet held by this stage (calculated by `StreamPlaneSender`) */
  blocks?: Record<string, ArrayBuffer>;
}

export interface StreamManifest {
  streamKey: string;
  kind: "card" | "group" | "below";
  plane: "local" | "stage";
  clipIds: string[];
  fps: number;
  segmentFrames: number;
  /** First frame recorded in manifest (project frame number when stream was produced). For record only: playback conversion uses `originFrame` from stream plane */
  originFrame?: number | null;
  bound: StreamRect;
  tight: StreamRect | null;
  /** Single-card stream: where wrapper layer box is placed in isolated project (plane coords plus this equal project stage coords); zero for streams produced in stage coordinates */
  offset?: { x: number; y: number } | null;
  /** `hash`: present only in manifests pushed by online pages, content hash of head file (bytes looked up in pushed chunks by it) */
  inits: Record<string, { codec: string; width: number; height: number; rect: StreamRect; hash?: string }>;
  /** `file`: segment file name on desktop; segment content hash in manifests pushed by online pages (both follow "rename on content change") */
  /** `box`: position rectangle measured for this segment when producing sparse version (tight box, plane coordinates); omitted if unmeasured. Placeholders follow it */
  segments: Record<string, { init: string; file: string; stride: number; samples: number; box?: StreamRect | null }>;
}

/* ======================================================================== *
 * fMP4 demuxing
 * ======================================================================== */

interface Box { type: string; start: number; end: number; header: number }

function boxesOf(view: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let off = start;
  while (off + 8 <= end) {
    let size = view.getUint32(off);
    const type = String.fromCharCode(view.getUint8(off + 4), view.getUint8(off + 5), view.getUint8(off + 6), view.getUint8(off + 7));
    let header = 8;
    if (size === 1) { size = Number(view.getBigUint64(off + 8)); header = 16; }
    else if (size === 0) size = end - off;
    if (size < header || off + size > end) break;
    out.push({ type, start: off, end: off + size, header });
    off += size;
  }
  return out;
}

const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "moof", "traf", "mvex", "edts"]);

function findBox(view: DataView, type: string, start: number, end: number): Box | null {
  for (const b of boxesOf(view, start, end)) {
    if (b.type === type) return b;
    let inner: number | null = null;
    if (CONTAINERS.has(b.type)) inner = b.start + b.header;
    else if (b.type === "stsd") inner = b.start + b.header + 8;
    else if (b.type === "avc1" || b.type === "avc3") inner = b.start + b.header + 78;
    if (inner !== null) {
      const hit = findBox(view, type, inner, b.end);
      if (hit) return hit;
    }
  }
  return null;
}

/** init.mp4 → required decoder configuration items. **`codec` assembled from `avcC`** */
export function parseInit(buf: ArrayBuffer): { codec: string; description: Uint8Array; width: number; height: number } {
  const view = new DataView(buf);
  const avcC = findBox(view, "avcC", 0, buf.byteLength);
  if (!avcC) throw new Error("No avcC in init.mp4");
  const description = new Uint8Array(buf.slice(avcC.start + avcC.header, avcC.end));
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const codec = `avc1.${hex(description[1])}${hex(description[2])}${hex(description[3])}`;
  const avc1 = findBox(view, "avc1", 0, buf.byteLength);
  let width = 0, height = 0;
  if (avc1) {
    const p = avc1.start + avc1.header;
    width = view.getUint16(p + 24);
    height = view.getUint16(p + 26);
  }
  return { codec, description, width, height };
}

export interface SegmentSample { offset: number; size: number; isSync: boolean }

/** One segment (moof + mdat) → sample table. `default-base-is-moof`: offset based from start of moof */
export function parseSegment(buf: ArrayBuffer): SegmentSample[] {
  const view = new DataView(buf);
  const moof = boxesOf(view, 0, buf.byteLength).find((b) => b.type === "moof");
  if (!moof) throw new Error("No moof in the segment");
  const tfhd = findBox(view, "tfhd", moof.start + moof.header, moof.end);
  const trun = findBox(view, "trun", moof.start + moof.header, moof.end);
  if (!tfhd || !trun) throw new Error("No tfhd / trun in the segment");
  let defSize = 0, defFlags = 0;
  {
    const p = tfhd.start + tfhd.header;
    const flags = view.getUint32(p) & 0xffffff;
    let o = p + 8;
    if (flags & 0x1) o += 8;
    if (flags & 0x2) o += 4;
    if (flags & 0x8) o += 4;
    if (flags & 0x10) { defSize = view.getUint32(o); o += 4; }
    if (flags & 0x20) { defFlags = view.getUint32(o); o += 4; }
  }
  const p = trun.start + trun.header;
  const flags = view.getUint32(p) & 0xffffff;
  const count = view.getUint32(p + 4);
  let o = p + 8;
  let dataOffset = 0;
  if (flags & 0x1) { dataOffset = view.getInt32(o); o += 4; }
  let firstFlags: number | null = null;
  if (flags & 0x4) { firstFlags = view.getUint32(o); o += 4; }
  let cursor = moof.start + dataOffset;
  const samples: SegmentSample[] = [];
  for (let i = 0; i < count; i++) {
    let size = defSize;
    let sflags = i === 0 && firstFlags !== null ? firstFlags : defFlags;
    if (flags & 0x100) o += 4;
    if (flags & 0x200) { size = view.getUint32(o); o += 4; }
    if (flags & 0x400) { sflags = view.getUint32(o); o += 4; }
    if (flags & 0x800) o += 4;
    samples.push({ offset: cursor, size, isSync: (sflags & 0x00010000) === 0 });
    cursor += size;
  }
  return samples;
}

/** G5: `timestamp = (originFrame + segmentIndex × 15 + sampleIndex) × 1e6 / fps` = project frame number × 1e6 / fps */
export const chunkTimestamp = (frame: number, fps: number): number => Math.round((frame * 1e6) / fps);
export const frameOfTimestamp = (timestamp: number, fps: number): number => Math.round((timestamp * fps) / 1e6);

/** Whether this segment exists in the ready interval */
export function rangesHave(ranges: ReadonlyArray<readonly number[]> | undefined, n: number): boolean {
  for (const r of ranges ?? []) if (r[0] <= n && n <= r[1]) return true;
  return false;
}

/**
 * Pure calculation on the parent page side (C3 end section): layers with `kind: 'stream'` in ready
 * index → arguments for `setStreamPlanes`.
 * For entries with `groupClipIds`, `{ clipIds: groupClipIds }`; otherwise `{ clipIds: [clipId] }`;
 * layers for below-dependent streams carry `plane: "stage"`, passed through as is; only provided to
 * cards that are **suppressed at this moment** and whose segment is already ready (stream pasting
 * during playback, K5). "This segment" is converted per each layer's own `originFrame`; layers
 * without `originFrame` (emitted by producers before segment rule changes) do not yield stream planes.
 * Called by parent page at the same place where `setSuppressed(H(t))` is sent (see report: this site
 * is in `src/editor/`, not in files editable in this task).
 */
export function streamPlanesFor(
  layers: Iterable<{ clipId: string; key: string; ranges: Array<[number, number]>; groupClipIds?: string[]; originFrame?: number; plane?: "stage" }>,
  suppressed: ReadonlySet<string>,
  globalFrame: number,
): StreamPlaneRequest[] {
  const out: StreamPlaneRequest[] = [];
  for (const layer of layers) {
    const members = layer.groupClipIds?.length ? layer.groupClipIds : [layer.clipId];
    if (!members.every((id) => suppressed.has(id))) continue;
    if (!streamLayerHas(layer, globalFrame)) continue;
    out.push({ clipIds: [...members], key: layer.key, ranges: layer.ranges.map((r) => [r[0], r[1]] as [number, number]), originFrame: layer.originFrame,
      ...(layer.plane === "stage" && members.length === 1 ? { plane: "stage" as const } : {}) });
  }
  return out;
}

/**
 * Whether this layer (layer with `kind: 'stream'` in ready index) has a ready segment at project
 * frame `globalFrame`. The parent page only checks here to determine "whether this frame has a stream",
 * and the stage player uses the same conversion (`./streamSegments.mjs`). Layers without `originFrame`
 * are consistently treated as having none.
 */
export function streamLayerHas(layer: { ranges?: ReadonlyArray<readonly number[]>; originFrame?: number }, globalFrame: number): boolean {
  if (!isStreamOrigin(layer.originFrame)) return false;
  return rangesHave(layer.ranges, streamSegmentOf(globalFrame, layer.originFrame));
}

/**
 * Budget for on-screen streams (budget for steps 1 and 2 of fallback order, mechanism/rendering.md
 * "fallback order"): planes that **will actually create decoders** for this tick.
 *
 * Only accepts planes with a stream key, carrying the first frame (`originFrame`) (planes without
 * keys only hold places without decoding; planes without first frames cannot convert frame numbers
 * to segment numbers), and not marked `over`.
 * Budget metrics are in `./streamBudget.mjs`: up to 6 on-screen streams ignore pixels (what passed
 * before still passes); beyond 6 streams, the combined cost (encoded aspect ratio multiplied by frame
 * rate) of each stream must not exceed the pixel budget; with a separate hard limit on stream count.
 * `pixelsOf` gives encoded aspect ratio for each plane (calculated by parent page per current project,
 * `streamPixelsOf` in `snapshotFeed.ts`); if non-positive, treated as a 1920×1080 full-screen card.
 * Admitted in the order passed in: stops when stream count reaches limit; when a stream's pixels
 * do not fit, skips it and inspects subsequent ones (smaller ones behind it may still fit).
 *
 * **Parent page determines who exceeds budget** (`planFeed`): it marks exceeding planes as `over`
 * before sending to stage, and uses this result to decide which cards count as "covered by a stream".
 * Stage does not recompute pixels (it lacks project bounds), following parent page markings and using
 * this function only to enforce the hard limit on count (`STAGE_PLANE_PIXELS`).
 * Planes whose canvases are not yet attached still consume their budget (parent page does not know
 * whether canvas arrived), handled as stream blank for that tick.
 *
 * `budget`: if omitted, uses production numbers; lowest tier passes `sparseStreamBudget()` and passes
 * `STREAM_BUDGET_MIN_FPS` for `fps` (see `./streamBudget.mjs` file header).
 */
export function planesWithinBudget<P extends { clipIds?: readonly string[]; key?: string; originFrame?: number; over?: boolean }>(
  planes: readonly P[], fps = 30, pixelsOf: (plane: P) => number | null | undefined = () => undefined, budget: StreamBudget = undefined,
): P[] {
  const valid = planes.filter((p) => Array.isArray(p?.clipIds) && p.clipIds.length > 0 && typeof p.key === "string" && !!p.key && isStreamOrigin(p.originFrame) && !p.over);
  return withinStreamBudget(valid.map((p) => streamCost(pixelsOf(p), fps)), budget).map((i) => valid[i]);
}
/** Pixels reported per plane when passing `planesWithinBudget` on stage side: small enough that pixel budget never fills, leaving only hard limit on count effective */
const STAGE_PLANE_PIXELS = () => 1;

/** Whether this plane's canvas hangs under stage root and draws in stage coordinates: group streams and below-dependent streams */
export function stagePlane(plane: { clipIds?: readonly string[]; plane?: string } | null | undefined): boolean {
  return (plane?.clipIds?.length ?? 0) > 1 || plane?.plane === "stage";
}

/* ======================================================================== *
 * Where bytes come from
 * ======================================================================== */

export interface StreamSource {
  manifest(key: string, signal?: AbortSignal): Promise<StreamManifest>;
  init(key: string, id: string, signal?: AbortSignal): Promise<ArrayBuffer>;
  segment(key: string, file: string, signal?: AbortSignal): Promise<ArrayBuffer>;
}

declare global {
  interface Window {
    /** For probe: point stream byte source elsewhere (defaults to prerender process, sharing source with snapshot bytes) */
    __pcStreamBase?: string;
  }
}

/** Source for prerender process. Dynamic import (`prerender.ts` has React hooks; static import would drag it into this path) */
const defaultBase = async (): Promise<string> => {
  if (typeof window !== "undefined" && typeof window.__pcStreamBase === "string") return window.__pcStreamBase;
  return (await import("./prerender.ts")).prerenderBase();
};

/** Local mode: direct connection to prerender process `/api/frames/stream/…` (shares source with C3 snapshot bytes) */
export class HttpStreamSource implements StreamSource {
  private base: () => Promise<string>;
  constructor(base: () => Promise<string> = defaultBase) { this.base = base; }
  private async get(path: string, init: RequestInit): Promise<Response> {
    const res = await fetch((await this.base()) + path, init);
    if (!res.ok) throw Object.assign(new Error(`Track stream not ready yet: ${path}`), { status: res.status });
    return res;
  }
  async manifest(key: string, signal?: AbortSignal): Promise<StreamManifest> {
    return (await this.get(`/api/frames/stream/${encodeURIComponent(key)}/manifest`, { cache: "no-store", signal })).json();
  }
  async init(key: string, id: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    return (await this.get(`/api/frames/stream/${encodeURIComponent(key)}/init/${encodeURIComponent(id)}`, { cache: "force-cache", signal })).arrayBuffer();
  }
  async segment(key: string, file: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    return (await this.get(`/api/frames/stream/${encodeURIComponent(key)}/seg/${encodeURIComponent(file)}`, { cache: "force-cache", signal })).arrayBuffer();
  }
}

/* ======================================================================== *
 * Online pages: manifest and bytes pushed by parent page
 * ======================================================================== */

/**
 * Why the stage on the online page does not fetch stream bytes from the asset service itself, but
 * has the parent page fetch and pass them over (decided 2026-10-12, three reasons):
 *
 *   1. **The isolated cross-origin stage cannot fetch them.** When reading assets, it only has
 *      `/media-s/<session-id>/media/<hash>` on its own origin (`MEDIA_S_PATH_PATTERN` in
 *      `src/online/stagePolicy.mjs`), and `px/`, where prerender outputs reside, is not among
 *      allowed paths; allowing it requires changing policy files and nginx templates and
 *      redeploying the stage origin.
 *   2. **Tickets cannot enter stage scripts.** `px/<hash>` requires a request header with a
 *      read-only ticket; and a stage document that has received a ticket permanently refuses to
 *      execute user cards and media effect cards (`online/isolation/execGate.ts`). Letting the
 *      stage fetch streams with a ticket is equivalent to disabling online execution.
 *   3. **The parent page already has this pathway.** Layer tables, manifests, candidate
 *      qualification, ticket renewals, concurrency, and timeouts are all in the parent page's
 *      online source (`snapshotSource.ts`); ready intervals are calculated by "bytes already on
 *      parent page", and bytes arrive along with stream planes when sent, so the stage does not
 *      need to wait for the network itself, and the only situation where a stream fails to draw on
 *      this tick is when decoding falls behind.
 *
 * Cost: one extra postMessage structured clone per byte chunk (at most 512 KB per segment). The
 * protocol only borrows the existing `setStreamPlanes`, without adding new message types:
 *
 *   Parent page `StreamPlaneSender.decorate(planes)`: attaches manifests to each plane; chunks
 *   only include those that this stage does not yet have.
 *   Stage `PushedStreamSource.accept(planes)`: accepts new chunks; **chunks not used by this batch
 *   of manifests are discarded on the spot**.
 *
 * Both sides keep books by the same rule (chunks held by the stage = chunks used by the previous
 * batch of manifests), so the parent page does not need to ask the stage what is missing; if a call
 * fails (stage is reloading), the parent page clears the books and resends everything.
 */

/** Hashes of chunks used by a manifest (head file + segments); lists only hash-like ones */
export function manifestBlockHashes(manifest: StreamManifest | null | undefined): string[] {
  const out = new Set<string>();
  for (const seg of Object.values(manifest?.segments ?? {})) {
    if (typeof seg?.file === "string" && /^[0-9a-f]{64}$/.test(seg.file)) out.add(seg.file);
    const hash = manifest?.inits?.[seg?.init]?.hash;
    if (typeof hash === "string" && /^[0-9a-f]{64}$/.test(hash)) out.add(hash);
  }
  return [...out];
}

const isBuffer = (v: unknown): v is ArrayBuffer => !!v && typeof (v as ArrayBuffer).byteLength === "number" && typeof (v as ArrayBuffer).slice === "function";
const missingBlock = (what: string) => Object.assign(new Error(`The parent page has not pushed this block yet: ${what}`), { status: 404 });

/** Stage side: byte source is chunks pushed by the parent page along with stream planes */
export class PushedStreamSource implements StreamSource {
  private manifests = new Map<string, StreamManifest>();
  private blocks = new Map<string, ArrayBuffer>();

  /**
   * A `setStreamPlanes` from the parent page: records each stream's manifest, accepts new chunks,
   * and discards chunks not used by this batch of manifests
   */
  accept(planes: readonly StreamPlaneRequest[]): void {
    const manifests = new Map<string, StreamManifest>();
    const keep = new Set<string>();
    for (const p of planes) {
      if (typeof p?.key !== "string" || !p.key || !p.manifest || typeof p.manifest !== "object") continue;
      manifests.set(p.key, p.manifest);
      for (const hash of manifestBlockHashes(p.manifest)) keep.add(hash);
      for (const [hash, buf] of Object.entries(p.blocks ?? {})) if (isBuffer(buf)) this.blocks.set(hash, buf);
    }
    this.manifests = manifests;
    for (const hash of [...this.blocks.keys()]) if (!keep.has(hash)) this.blocks.delete(hash);
  }
  async manifest(key: string): Promise<StreamManifest> {
    const m = this.manifests.get(key);
    if (!m) throw missingBlock(`manifest ${key}`);
    return m;
  }
  async init(key: string, id: string): Promise<ArrayBuffer> {
    const hash = this.manifests.get(key)?.inits?.[id]?.hash;
    const buf = hash ? this.blocks.get(hash) : undefined;
    if (!buf) throw missingBlock(`head file ${id}`);
    return buf;
  }
  async segment(_key: string, file: string): Promise<ArrayBuffer> {
    const buf = this.blocks.get(file);
    if (!buf) throw missingBlock(`segment ${file}`);
    return buf;
  }
  /** Whether this chunk is held (inspected by probes and unit tests) */
  has(hash: string): boolean { return this.blocks.has(hash); }
  get size(): number { return this.blocks.size; }
  get bytes(): number { let n = 0; for (const b of this.blocks.values()) n += b.byteLength; return n; }
}

/** A stream's manifest and bytes held by parent page (from `OnlineSnapshotSource.streamPlane`) */
export interface StreamPlaneData {
  manifest: StreamManifest;
  blocks: ReadonlyMap<string, Uint8Array | ArrayBuffer>;
}

const toArrayBuffer = (bytes: Uint8Array | ArrayBuffer): ArrayBuffer => {
  if (!(bytes instanceof Uint8Array)) return bytes;
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
};

/**
 * Parent page side: passes through stream planes before sending them to **one** stage, attaching
 * manifests and chunks that this stage does not yet have. One instance per stage (one RPC client).
 * `lookup(key)` returns this stream's manifest and bytes at this moment; planes returning null are
 * sent as-is (on the stage side, this stream cannot fetch a manifest and falls back to snapshot).
 */
export class StreamPlaneSender {
  private held = new Set<string>();
  private lookup: (key: string) => StreamPlaneData | null;
  constructor(lookup: (key: string) => StreamPlaneData | null) { this.lookup = lookup; }

  decorate(planes: readonly StreamPlaneRequest[]): StreamPlaneRequest[] {
    const next = new Set<string>();
    const sending = new Set<string>();
    const out: StreamPlaneRequest[] = [];
    for (const p of planes) {
      const base: StreamPlaneRequest = { clipIds: [...p.clipIds], ...(p.key ? { key: p.key } : {}), ...(p.ranges ? { ranges: p.ranges } : {}),
        ...(isStreamOrigin(p.originFrame) ? { originFrame: p.originFrame } : {}), ...(p.plane === "stage" ? { plane: "stage" as const } : {}),
        ...(p.over ? { over: true as const } : {}), ...(p.first ? { first: true as const } : {}) };
      const data = p.key ? this.lookup(p.key) : null;
      if (!data) { out.push(base); continue; }
      // Planes over budget are not decoded by stage: only manifests are attached (placeholders
      // placed by position rect), without bytes, and not counted in "chunks held by stage"
      if (p.over) { out.push({ ...base, manifest: data.manifest }); continue; }
      const blocks: Record<string, ArrayBuffer> = {};
      let added = 0;
      for (const hash of manifestBlockHashes(data.manifest)) {
        const bytes = data.blocks.get(hash);
        if (!bytes) continue;   // Listed in manifest but bytes absent: stage cannot fetch this segment; that tick falls to snapshot
        next.add(hash);
        if (this.held.has(hash) || sending.has(hash)) continue;
        sending.add(hash);
        blocks[hash] = toArrayBuffer(bytes);
        added++;
      }
      out.push({ ...base, manifest: data.manifest, ...(added ? { blocks } : {}) });
    }
    // After receiving, the stage holds exactly the chunks used by this batch of manifests (see
    // `PushedStreamSource.accept`)
    this.held = next;
    return out;
  }
  /** Undelivered this time (stage switching, response lost): clear the books, resend all next time */
  reset(): void { this.held = new Set(); }
  /** Number of chunks believed to be held by the stage (inspected by unit tests) */
  get heldCount(): number { return this.held.size; }
}

/* ======================================================================== *
 * WebGL composition
 * ======================================================================== */

const VS = `attribute vec2 p; varying vec2 uv;
void main(){ uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
/*
 * Color half is premultiplied color: output directly, **clamp once to rgb ≤ a** (a constraint
 * that premultiplied color must satisfy originally; G0-b (5): without clamping, encoding noise
 * in the transparent area outputs as-is, with color noise peaking at 146/255, reduced to 59 after
 * clamping).
 */
const FS = `precision mediump float; uniform sampler2D tex; uniform float alphaTop; uniform float half_;
varying vec2 uv;
void main(){
  vec3 rgb = texture2D(tex, vec2(uv.x, uv.y * half_)).rgb;
  float a = texture2D(tex, vec2(uv.x, alphaTop + uv.y * half_)).r;
  gl_FragColor = vec4(min(rgb, vec3(a)), a);
}`;

/**
 * Shared offscreen canvas: when creation fails or the lost context is not restored for a long
 * time, rebuild after this interval (real milliseconds)
 */
export const GL_RETRY_MS = 1000;
/** If consecutive creations fail, double interval each time, up to this max (avoid spinning) */
export const GL_RETRY_MAX_MS = 30000;

type GlCanvas = OffscreenCanvas | HTMLCanvasElement;
const newGlCanvas = (): GlCanvas | null => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(2, 2);
  if (typeof document !== "undefined") return document.createElement("canvas");
  return null;
};

/**
 * **A single WebGL context shared across all stream planes** (one per stage, held by
 * `StreamPlayer`).
 *
 * Why not one per plane: a browser gives at most 16 WebGL contexts per page; any beyond that
 * evicts the earliest created one without restoring it (`docs/reports/AGENT-rr-merged-eval.md`
 * Section 4: 8 lost out of 24 layers, 14 lost out of 30 layers; lost layers never drew a frame);
 * the shared renderer of canvas cards and cards' own WebGL in the stage also occupy slots.
 *
 * Approach: an offscreen canvas **not attached to the document** creates the context; for each
 * frame drawn, that frame is uploaded as a texture and split in half according to the original
 * shader to draw onto the top-left of the offscreen canvas (`rect.w × rect.h`, 1:1), and the
 * plane's own 2D canvas fetches it on the spot with `drawImage`. This was chosen over
 * `transferToImageBitmap` plus `bitmaprenderer`: the latter must reallocate a back buffer for the
 * offscreen canvas on every handoff, and since planes have different sizes, the offscreen canvas
 * size would have to change each frame; a 2D fetch is a single copy on the GPU, and the offscreen
 * canvas only grows, never shrinking. The picture is pixel-by-pixel identical to having one context
 * per plane (Section 4 of the same report, diff 0): the offscreen canvas outputs in premultiplied
 * color (`premultipliedAlpha: true`), the 2D canvas also stores premultiplied color internally,
 * and clearing first then drawing 1:1 without scaling passes values through as-is. The offscreen
 * canvas does not preserve drawing buffers (`preserveDrawingBuffer: false`): each time, the
 * needed rect is fully drawn first and fetched immediately within the same task, so there is no
 * need to keep it; keeping it adds an extra copy on each fetch (measured by
 * `scripts/probes/stream-budget-probe.mjs`: 30 concurrent small-card streams on screen, 4.2 ms vs
 * 3.1 ms per tick).
 *
 * Cost (same probe, 30 fps, 704×864 small-card streams, average milliseconds per `present` tick,
 * former is one context per plane): 1 stream 0.20 vs 0.28, 6 streams 0.57 vs 0.80, 16 streams
 * 1.24 vs 1.65; at 30 streams, the original approach lost 14 contexts with 14 planes empty, whereas
 * with sharing, all 30 planes draw, taking 2.74. Broken down, that is an extra 0.03 to 0.08 ms per
 * stream per tick (the overhead is that single fetch from offscreen canvas to 2D canvas; numbers
 * for each round in `docs/reports/AGENT-rr-pixel-budget.md`). Further savings are possible: draw
 * streams within a tick into an atlas first, then fetch together (the approach measured in the
 * evaluation report, adding virtually no cost per tick); not implemented.
 *
 * When context is lost (GPU process restarted, slot evicted by another canvas): the plane's 2D
 * canvas is unaffected, and the previous picture remains; during this time, new frames cannot be
 * drawn, treated as "cannot draw on this tick" (retain previous picture, use placeholder when time
 * expires). When the browser restores it (`webglcontextrestored`), rebuild shaders and textures;
 * if not restored after `GL_RETRY_MS` (evicted ones are never restored), discard this offscreen
 * canvas and create a new one; if creating anew fails, retry after a while (doubling interval each
 * time, up to `GL_RETRY_MAX_MS`). In each case, schedule with the player to rerun this frame when
 * the time comes (when paused, there is no next tick).
 */
class SharedGl {
  private canvas: GlCanvas | null = null;
  private gl: WebGLRenderingContext | null = null;
  private tex: WebGLTexture | null = null;
  private uAlphaTop: WebGLUniformLocation | null = null;
  private uHalf: WebGLUniformLocation | null = null;
  private lostAt: number | null = null;
  private failedAt: number | null = null;
  /** Consecutive creation failure count (cleared on success); retry interval doubles based on this */
  private failures = 0;
  private onLost: () => void;
  private onBack: () => void;
  private onRetry: (ms: number) => void;
  stats = { creates: 0, losses: 0, restores: 0, failures: 0, draws: 0, lastError: "" };

  /**
   * `onRetry(ms)`: cannot draw at this moment; worth retrying after `ms` milliseconds (player
   * schedules a real timer based on this to replay this frame; when paused, there is no next tick)
   */
  constructor(onLost: () => void, onBack: () => void, onRetry: (ms: number) => void) {
    this.onLost = onLost;
    this.onBack = onBack;
    this.onRetry = onRetry;
  }

  private get retryMs(): number { return Math.min(GL_RETRY_MAX_MS, GL_RETRY_MS * 2 ** Math.max(0, this.failures - 1)); }

  /** Shaders, vertices, and textures (run once after context creation and once after restoration) */
  private setup(gl: WebGLRenderingContext): void {
    const shader = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) || "shader");
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, shader(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || "program");
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.uAlphaTop = gl.getUniformLocation(prog, "alphaTop");
    this.uHalf = gl.getUniformLocation(prog, "half_");
  }

  private drop(): void {
    this.canvas = null;
    this.gl = null;
    this.tex = null;
    this.lostAt = null;
  }

  private ensure(): WebGLRenderingContext | null {
    const now = realNow();
    if (this.gl && this.lostAt === null) return this.gl;
    if (this.gl) {
      // Lost: wait for browser to restore; if not restored after timeout (evicted ones never do), rebuild
      const waited = now - (this.lostAt as number);
      if (waited < GL_RETRY_MS) { this.onRetry(GL_RETRY_MS - waited); return null; }
      this.drop();
    }
    // Failed to build last time: retry after a while (interval doubles on consecutive failures);
    // if requested to draw during this period, schedule to rerun once the timer fires
    if (this.failedAt !== null && now - this.failedAt < this.retryMs) { this.onRetry(this.retryMs - (now - this.failedAt)); return null; }
    try {
      const canvas = newGlCanvas();
      const gl = canvas?.getContext("webgl", { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: false, antialias: false }) as WebGLRenderingContext | null;
      if (!canvas || !gl) throw new Error("Track stream could not get a WebGL context");
      this.setup(gl);
      const target = canvas as unknown as Partial<EventTarget>;
      target.addEventListener?.("webglcontextlost", (e) => {
        if (this.canvas !== canvas) return;
        e.preventDefault();
        this.lostAt = realNow();
        this.stats.losses++;
        this.onLost();
      });
      target.addEventListener?.("webglcontextrestored", () => {
        if (this.canvas !== canvas) return;
        try { this.setup(gl); this.lostAt = null; this.stats.restores++; }
        catch (e) { this.stats.lastError = String((e as Error)?.message || e); this.drop(); }
        this.onBack();
      });
      this.canvas = canvas;
      this.gl = gl;
      this.failedAt = null;
      this.failures = 0;
      this.stats.creates++;
      return gl;
    } catch (e) {
      this.failedAt = now;
      this.failures++;
      this.stats.failures++;
      this.stats.lastError = String((e as Error)?.message || e);
      this.onRetry(this.retryMs);
      return null;
    }
  }

  /**
   * Splits a frame (top-bottom stacked) in half, composites premultiplied color, and draws to
   * top-left `w × h` of the offscreen canvas (1:1). Returns offscreen canvas; caller fetches that
   * rect **on the spot**; returns null if unable to draw (no context, context lost). `w` and `h` are
   * width and height of the rectangle of the variant containing this frame.
   */
  render(frame: VideoFrame, w: number, h: number): GlCanvas | null {
    const gl = this.ensure();
    const c = this.canvas;
    if (!gl || !c) return null;
    // Only grows, never shrinks: changing WebGL canvas dimensions reallocates the back buffer
    if (c.width < w) c.width = w;
    if (c.height < h) c.height = h;
    const total = frame.displayHeight || frame.codedHeight;
    // WebGL origin is at bottom-left: w × h at canvas top-left
    gl.viewport(0, c.height - h, w, h);
    gl.uniform1f(this.uAlphaTop, (h + 8) / total);
    gl.uniform1f(this.uHalf, h / total);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (typeof gl.isContextLost === "function" && gl.isContextLost() === true) return null;
    this.stats.draws++;
    return c;
  }

  /**
   * Stage yields to `back`: offscreen canvas shrinks to minimum (releases back buffer); context
   * is kept so next time it acts as `front` it does not need rebuilding
   */
  shrink(): void {
    const c = this.canvas;
    if (!c || this.lostAt !== null) return;
    if (c.width !== 2) c.width = 2;
    if (c.height !== 2) c.height = 2;
  }

  get state(): "none" | "ready" | "lost" { return !this.gl ? "none" : this.lostAt !== null ? "lost" : "ready"; }
}

/** A stream plane: only has a 2D context of its own; compositing is done in shared `SharedGl` */
class PlaneCompositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private shared: SharedGl;
  private blank = true;
  constructor(canvas: HTMLCanvasElement, shared: SharedGl) {
    this.canvas = canvas;
    this.shared = shared;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Track stream plane could not get a 2D context");
    this.ctx = ctx;
  }
  /** Canvas position and size = stream bounding box (plane coordinates). Written only when changed */
  place(bound: StreamRect): void {
    const c = this.canvas;
    if (c.width !== bound.w) c.width = bound.w;
    if (c.height !== bound.h) c.height = bound.h;
    const s = c.style;
    const want: Record<string, string> = { left: `${bound.x}px`, top: `${bound.y}px`, width: `${bound.w}px`, height: `${bound.h}px` };
    for (const [k, v] of Object.entries(want)) if (s.getPropertyValue(k) !== v) s.setProperty(k, v);
  }
  /**
   * Draws a frame. `rect` is the rectangle of the variant containing this frame (plane coordinates),
   * and `bound` is the rectangle covered by the canvas. Returns false if shared context cannot draw
   * at this moment, **leaving the original picture on the canvas untouched**: canvas position and
   * size are updated only when drawing succeeds (changing 2D canvas dimensions clears it; if manifest
   * `bound` changes while context is lost, resizing first erases the previous picture while books
   * still record that a picture is present).
   */
  draw(frame: VideoFrame, rect: StreamRect, bound: StreamRect): boolean {
    const src = this.shared.render(frame, rect.w, rect.h);
    if (!src) return false;
    this.place(bound);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // 1:1, unscaled: rect.w × rect.h from offscreen canvas top-left copied as-is into this frame's
    // rectangle on the plane
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, rect.w, rect.h, rect.x - bound.x, rect.y - bound.y, rect.w, rect.h);
    this.blank = false;
    return true;
  }
  clear(): void {
    if (this.blank) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.blank = true;
  }
  get isBlank(): boolean { return this.blank; }
}

/* ======================================================================== *
 * A stream
 * ======================================================================== */

interface HeldFrame { frame: VideoFrame; segment: number }
/**
 * `rect`: rectangle of its variant in the manifest when fetching these bytes (if manifest
 * changes later and this segment switches to another variant, decoded frames on hand still lay
 * out by it)
 */
interface SegmentData { buf: ArrayBuffer; samples: SegmentSample[]; init: string; file: string; rect: StreamRect | null }

class StreamTrack {
  readonly id: string;
  plane: StreamPlaneRequest;
  canvas: HTMLCanvasElement;
  private player: StreamPlayer;
  private compositor: PlaneCompositor | null = null;
  manifest: StreamManifest | null = null;
  private manifestAt = 0;
  private manifestLoading: Promise<void> | null = null;
  private decoder: VideoDecoder | null = null;
  private configuredInit: string | null = null;
  private inits = new Map<string, { config: VideoDecoderConfig; bytesPerFrame: number }>();
  private initLoading = new Map<string, Promise<void>>();
  readonly frames = new Map<number, HeldFrame>();
  private nextFeed: number | null = null;
  private discardBefore = 0;
  private segments = new Map<number, SegmentData>();
  private fetching = new Map<number, Promise<void>>();
  private lastDrawn: number | null = null;
  /**
   * Another reference to the current picture on the canvas. When the wrapper layer is remounted by
   * clip (stopping frame catch-up start), canvas is replaced with a new empty one; this is relied on
   * to redraw that picture as-is without waiting for decode; closed when picture changes or clears.
   */
  private shown: { frame: VideoFrame; f: number } | null = null;
  private wantFrame: number | null = null;
  /** Real timestamp when `wantFrame` was updated to current value */
  private wantAt = 0;
  /**
   * Target frame for in-flight frame seek (cleared once this frame or later is decoded) and the
   * real timestamp when initiated
   */
  private seekTarget: number | null = null;
  private seekAt = 0;
  /**
   * Number of chunks fed to decoder since this frame seek. When none fed yet (bytes not arrived,
   * decoder not created), changing target costs little, so no need to yield to it
   */
  private fedSinceSeek = 0;
  /**
   * Requested picture not yet drawn after frame seek (used to measure "from requesting frame to
   * drawing")
   */
  private seeking = false;
  /**
   * Most recent frame seek: target frame, milliseconds from request to drawing (recording only;
   * probe measures decode latency of random frame jumps)
   */
  private lastSeek: { frame: number; ms: number } | null = null;
  /**
   * Stand-in for sparse segment: during frame seek, the closest frame not later than target
   * frame is this one: drawn immediately once decoded
   */
  private standIn: number | null = null;
  /**
   * Timestamp (real ms) since drawn picture differs from requested one; cleared when requested
   * picture is drawn
   */
  private staleSince: number | null = null;
  private staleTimer = false;
  private refreshTimer = false;
  /**
   * Number of frames fed into decoder but not yet output (`decodeQueueSize` only counts frames
   * not yet submitted to decoder, excluding those currently decoding)
   */
  private pending = 0;
  private pumpQueued = false;
  private disposed = false;
  /**
   * Lowest tier: which frame is in chunk sent for decoding but not yet output (first frame of
   * segment), and the real timestamp when sent
   */
  private firstFed: number | null = null;
  private firstFedAt = 0;
  /** Lowest tier: consecutive decoder error count (cleared once a frame is decoded) */
  private firstFailures = 0;
  bytesPerFrame = 1920 * 2176 * 1.5;
  stats = { decoded: 0, drawn: 0, holds: 0, blanks: 0, seeks: 0, deferred: 0, standIns: 0, seekMaxMs: 0, errors: 0, maxHeld: 0, lastError: "" };

  constructor(player: StreamPlayer, plane: StreamPlaneRequest, canvas: HTMLCanvasElement) {
    this.player = player;
    this.plane = plane;
    this.canvas = canvas;
    this.id = planeId(plane);
    if (plane.manifest) this.adoptPushed(plane.manifest);
  }

  /** Manifest brought by parent page with plane: use directly without querying byte source */
  private adoptPushed(manifest: StreamManifest): void {
    this.manifest = manifest;
    this.manifestAt = realNow();
    this.placeBlank(manifest.bound);
  }

  /**
   * Manifest arrived: places canvases **without pictures yet** at the stream bounding box (suppressed
   * cards must have a clickable box). Those already with pictures are left untouched: resizing width
   * and height clears them; `PlaneCompositor.draw` positions them itself next time drawing succeeds.
   */
  private placeBlank(bound: StreamRect): void {
    if (this.lastDrawn !== null) return;
    this.ensureCompositor()?.place(bound);
  }

  /**
   * Where stream bytes come from: planes with manifests only accept chunks pushed by parent
   * page; otherwise player's byte source (desktop: prerender process)
   */
  private get bytes(): StreamSource { return this.plane.manifest ? this.player.pushed : this.player.source; }

  get key(): string { return this.plane.key ?? ""; }
  private get fps(): number { return this.manifest?.fps || this.player.fps; }
  /**
   * First frame of this stream itself (project frame number); player only accepts planes
   * carrying it (`StreamPlayer.setPlanes`)
   */
  private get origin(): number { return this.plane.originFrame as number; }
  /**
   * Project frame number → segment number for this stream (negative before first frame; none in ready
   * interval)
   */
  private segmentOf(f: number): number { return streamSegmentOf(f, this.origin); }
  /** First frame of this segment (project frame number) */
  private segmentStart(seg: number): number { return streamSegmentFirstFrame(seg, this.origin); }
  /**
   * Lowest tier: decodes only the first frame of each segment (`first` carried by parent page with
   * stream plane)
   */
  private get firstOnly(): boolean { return this.plane.first === true; }
  /**
   * Frames currently occupying decoder output pool: unclosed on hand + fed in but not yet
   * output + one on canvas (counted as another chunk when no longer on hand)
   */
  get heldCount(): number { return this.frames.size + this.pending + (this.shown && !this.frames.has(this.shown.f) ? 1 : 0); }

  private ensureCompositor(): PlaneCompositor | null {
    if (this.compositor && this.compositor.canvas === this.canvas) return this.compositor;
    try { this.compositor = new PlaneCompositor(this.canvas, this.player.gl); }
    catch (e) { this.compositor = null; this.stats.lastError = String((e as Error)?.message || e); }
    return this.compositor;
  }

  /**
   * Async data (manifest / init / segment) arrived: reruns `present` for the frame needed on this
   * tick. When paused or scrubbing, there is no next tick to trigger it, and without this, random
   * access would stall at "manifest just arrived, decode not yet started". Runs only once per
   * microtask.
   */
  private wakeQueued = false;
  private wake(): void {
    if (this.wakeQueued || this.disposed) return;
    this.wakeQueued = true;
    queueMicrotask(() => {
      this.wakeQueued = false;
      if (!this.disposed && this.wantFrame !== null) this.present(this.wantFrame);
    });
  }

  /**
   * Ready interval changed for the same stream key (producer published a new segment): next `present`
   * is allowed to query manifest once more (suspicion G). Cleared only when actually sent: retained
   * if throttled back, retried on next tick.
   */
  private manifestDirty = false;

  /**
   * Manifest: fetched if absent; with `force`, refetched if over 2s elapsed (segments can be
   * replaced: sparse → full frame). Returns whether this request was actually initiated.
   */
  private loadManifest(force = false): boolean {
    // Streams whose manifests are pushed by parent page: nowhere to query; wait for parent page to
    // bring a new one next time (`setPlane`)
    if (this.plane.manifest) return false;
    if (!this.key || this.manifestLoading) return false;
    const now = realNow();
    if (this.manifest && !force) return false;
    if (this.manifest && now - this.manifestAt < MANIFEST_REFRESH_MS) return false;
    this.manifestAt = now;
    this.manifestLoading = this.player.source.manifest(this.key)
      .then((m) => {
        if (this.disposed) return;
        this.manifest = m;
        this.manifestAt = realNow();
        // Once manifest arrives, place canvas at stream bounding box: before first frame is drawn,
        // suppressed cards must also have a clickable box
        this.placeBlank(m.bound);
        this.wake();
      })
      .catch(() => { /*
 * Not ready yet: this layer falls to next step in fallback order on this tick (snapshot /
 * placeholder); retry next tick
 */ })
      .finally(() => { this.manifestLoading = null; });
    return true;
  }

  /** Decoder configuration for an init (variant) */
  private loadInit(id: string): void {
    if (this.inits.has(id) || this.initLoading.has(id) || !this.key) return;
    const work = this.bytes.init(this.key, id)
      .then((buf) => {
        const info = parseInit(buf);
        this.inits.set(id, {
          config: { codec: info.codec, description: info.description, codedWidth: info.width, codedHeight: info.height,
            hardwareAcceleration: "prefer-hardware", optimizeForLatency: true },
          bytesPerFrame: info.width * info.height * 1.5,
        });
        this.wake();
      })
      .catch((e) => { this.stats.lastError = String(e?.message || e); })
      .finally(() => { this.initLoading.delete(id); });
    this.initLoading.set(id, work);
  }

  /** Fetch whole segments; at most 2 in-flight per stream */
  private loadSegment(n: number): void {
    if (this.segments.has(n) || this.fetching.has(n) || this.fetching.size >= MAX_INFLIGHT_PER_STREAM || !this.manifest) return;
    const meta = this.manifest.segments[String(n)];
    if (!meta) return;
    const work = this.bytes.segment(this.key, meta.file)
      .then((buf) => {
        if (this.disposed) return;
        this.segments.set(n, { buf, samples: parseSegment(buf), init: meta.init, file: meta.file, rect: this.manifest?.inits[meta.init]?.rect ?? null });
        // Keep current segment and one segment before and after; discard others
        for (const k of [...this.segments.keys()]) if (Math.abs(k - n) > 2) this.segments.delete(k);
        this.wake();
      })
      .catch(() => {
        // Deleted by replacement (G6) or not yet ready: fetch by new manifest next time
        this.loadManifest(true);
      })
      .finally(() => { this.fetching.delete(n); });
    this.fetching.set(n, work);
  }

  private newDecoder(): VideoDecoder | null {
    if (typeof VideoDecoder === "undefined") return null;
    const decoder = new VideoDecoder({
      output: (frame) => this.onFrame(frame),
      error: (e) => {
        this.stats.errors++;
        this.stats.lastError = String(e?.message || e);
        if (this.decoder === decoder) {
          this.decoder = null; this.configuredInit = null; this.nextFeed = null; this.pending = 0; this.seekTarget = null; this.standIn = null;
          // Lowest tier: sent chunk is gone, record one failure; if below limit, resend for frame
          // currently needed (when paused, there is no next tick to trigger it)
          if (this.firstOnly) { this.firstFed = null; this.firstFailures++; this.wake(); }
        }
      },
    });
    return decoder;
  }

  private onFrame(frame: VideoFrame): void {
    if (this.pending > 0) this.pending--;
    const f = frameOfTimestamp(frame.timestamp, this.fps);
    if (this.firstOnly) { this.onFirstFrame(frame, f); return; }
    // The in-flight frame seek has resolved
    const reached = this.seekTarget !== null && f >= this.seekTarget;
    if (reached) this.seekTarget = null;
    if (this.disposed) {
      frame.close();
    } else {
      // Stand-in for sparse segment: requested frame shares picture with it, draw first (handle this
      // frame normally below: mostly earlier than target frame, closed after drawing)
      if (this.standIn === f) {
        this.standIn = null;
        if (this.wantFrame !== null && this.wantFrame !== f && this.pictureOf(this.wantFrame) === f && this.drawFrame(frame, f)) this.stats.standIns++;
      }
      if (f < this.discardBefore || this.frames.has(f)) {
        frame.close();
      } else {
        this.frames.set(f, { frame, segment: this.segmentOf(f) });
        this.stats.decoded++;
        this.stats.maxHeld = Math.max(this.stats.maxHeld, this.heldCount);
        // Random access: draw immediately once target frame is output, without waiting for next tick
        if (this.wantFrame === f) this.drawAt(f);
        /*
         * Target changed again during frame seek (continuous scrubbing): draw this decoded frame first so
         * picture follows along; re-seek below for the frame needed now. When there is no picture yet, draw
         * only "recent enough" frames (`FIRST_PICTURE_LAG_MS`): host hides live subtree only after first
         * picture appears.
         */
        else if (reached && (this.lastDrawn !== null || realNow() - this.seekAt <= FIRST_PICTURE_LAG_MS)) this.drawAt(f);
      }
    }
    if (reached && !this.disposed && this.wantFrame !== null && this.wantFrame !== f) this.wake();
    // Space freed up: keep feeding (paused state has no next tick to trigger it; random access
    // must decode all the way to target frame)
    if (!this.pumpQueued && !this.disposed) {
      this.pumpQueued = true;
      queueMicrotask(() => { this.pumpQueued = false; this.pump(); });
    }
  }

  /** Release all decoded frames on hand, reset decoder (next chunk must be a keyframe) */
  private resetDecode(): void {
    for (const h of this.frames.values()) h.frame.close();
    this.frames.clear();
    if (this.decoder && this.decoder.state !== "closed") {
      try { this.decoder.reset(); } catch { /* Already broken */ }
    }
    this.pending = 0;
    this.configuredInit = null;
    this.seekTarget = null;
    this.standIn = null;
    this.fedSinceSeek = 0;
    this.firstFed = null;
  }

  /**
   * Segment jump / start: decode starting from IDR of segment containing target; close frames
   * before target as soon as they output
   */
  private seek(f: number): void {
    this.stats.seeks++;
    this.resetDecode();
    this.nextFeed = this.segmentStart(this.segmentOf(f));
    this.discardBefore = f;
    this.seekTarget = f;
    this.seekAt = realNow();
    this.seeking = true;
    // Sparse segment: this frame and closest frame not later than it share the same picture; that
    // one decodes first (closer to keyframe)
    const picture = this.pictureOf(f);
    this.standIn = picture !== f ? picture : null;
  }

  /**
   * Variant rectangle of the segment containing this frame. When bytes for this segment are in hand,
   * use the rectangle recorded when fetching it: after re-querying the manifest, this segment may
   * have been replaced with another variant (sparse version is produced with upper bounds, full
   * density with tight rectangles), but file switching only happens at segment starts (`pump`);
   * mid-segment still draws the frames decoded from what is currently in hand.
   */
  private rectOf(f: number): StreamRect | null {
    const held = this.segments.get(this.segmentOf(f));
    if (held?.rect) return held.rect;
    const seg = this.manifest?.segments[String(this.segmentOf(f))];
    const init = seg ? this.manifest!.inits[seg.init] : null;
    return init?.rect ?? null;
  }

  /**
   * Which frame image (project frame number) in this stream corresponds to project frame F.
   * Full-density segments are just the frame itself; in sparse segments (`stride` > 1 in the
   * manifest), every `stride` samples share the same image: take the latest one no later than this
   * frame: **only search backward**, do not take later ones. If `stride` does not evenly divide the
   * segment frame count, reject it (cannot determine which sample repetition starts from), treat each
   * sample as a distinct image, and decode up to this frame itself as usual.
   */
  private pictureOf(f: number): number {
    // Lowest tier: regardless of how dense this segment is, always the first frame of the segment
    if (this.firstOnly) return streamFirstFrameOf(f, this.origin);
    const seg = this.segmentOf(f);
    const stride = this.manifest?.segments[String(seg)]?.stride ?? 1;
    if (!(stride > 1) || SEGMENT_FRAMES % stride !== 0) return f;
    const start = this.segmentStart(seg);
    return start + Math.floor((f - start) / stride) * stride;
  }

  /**
   * Whether what is on the canvas right now is the expected image for frame F (in sparse segments,
   * one image covers multiple frames)
   */
  private fresh(f: number): boolean {
    return this.lastDrawn !== null && this.pictureOf(this.lastDrawn) === this.pictureOf(f);
  }

  private closeShown(): void {
    if (!this.shown) return;
    try { this.shown.frame.close(); } catch { /* Already closed */ }
    this.shown = null;
  }

  /**
   * The coordinate system in the manifest matches this canvas: streams marked `stage` in the
   * manifest are drawn only on the canvas under the stage root; streams marked `local` only on the
   * canvas inside the wrapper layer. If they do not match (parent page did not state this is a
   * below-dependent stream, but manifest did), do not draw: drawing results in wrong position and
   * appearance, so fall back to placeholder instead. Streams omitted in manifest are drawn as usual.
   */
  private get planeFits(): boolean {
    const said = this.manifest?.plane;
    if (said !== "stage" && said !== "local") return true;
    return (said === "stage") === stagePlane(this.plane);
  }

  /** Draw a frame onto the plane (this frame is recorded at project frame `f`) */
  private drawFrame(frame: VideoFrame, f: number): boolean {
    const rect = this.rectOf(f);
    const compositor = this.ensureCompositor();
    if (!rect || !compositor || !this.manifest || !this.planeFits) return false;
    // Shared context cannot draw at this moment (lost): treat this tick as not drawn, keep previous
    // image (canvas position and size remain unchanged, see `PlaneCompositor.draw`)
    if (!compositor.draw(frame, rect, this.manifest.bound)) return false;
    const was = this.lastDrawn;
    this.lastDrawn = f;
    this.stats.drawn++;
    if (!this.shown || this.shown.f !== f) {
      const copy = cloneFrame(frame);
      this.closeShown();
      if (copy) this.shown = { frame: copy, f };
    }
    if (this.wantFrame !== null && this.fresh(this.wantFrame)) {
      this.staleSince = null;
      if (this.seeking) {
        this.seeking = false;
        const ms = Math.round((realNow() - this.wantAt) * 10) / 10;
        this.lastSeek = { frame: this.wantFrame, ms };
        if (ms > this.stats.seekMaxMs) this.stats.seekMaxMs = ms;
      }
    } else if (this.staleSince !== null) {
      // What was drawn is the result of the in-flight seek, not the one needed right now: count as having
      // a new image, and recalculate retention duration from this moment
      this.staleSince = realNow();
    }
    if (was === null) this.player.noteShowing();
    return true;
  }

  private drawAt(f: number): boolean {
    const held = this.frames.get(f);
    return held ? this.drawFrame(held.frame, f) : false;
  }

  /** Canvas replaced (wrapper layer remounted): redraw previous image as is. Returns false if cannot draw */
  private redraw(): boolean {
    const shown = this.shown;
    const rect = shown ? this.rectOf(shown.f) : null;
    const compositor = shown ? this.ensureCompositor() : null;
    if (!shown || !rect || !compositor || !this.manifest || !this.planeFits) return false;
    if (!compositor.draw(shown.frame, rect, this.manifest.bound)) return false;
    this.lastDrawn = shown.f;
    return true;
  }

  private blank(): void {
    if (this.compositor && !this.compositor.isBlank) {
      this.compositor.clear();
      this.stats.blanks++;
    }
    const was = this.lastDrawn;
    this.lastDrawn = null;
    this.staleSince = null;
    this.closeShown();
    if (was !== null) this.player.noteShowing();
  }

  /**
   * The image needed for this tick was not drawn: keep the previous image for at most one segment
   * duration (`HOLD_FRAMES`, real time); if there is still no new image when expired, clear it,
   * and fall back this layer to placeholders (mechanism/rendering.md "Fallback order"). Schedule a
   * real timer on first entry: when paused there is no next tick, and without scheduling the old
   * image would remain indefinitely. If there was originally no image, keep it cleared.
   */
  private miss(): void {
    if (this.lastDrawn === null) { this.blank(); return; }
    const now = realNow();
    const holdMs = (HOLD_FRAMES * 1000) / this.fps;
    if (this.staleSince === null) this.staleSince = now;
    else if (now - this.staleSince >= holdMs) { this.blank(); return; }
    this.stats.holds++;
    if (this.staleTimer) return;
    this.staleTimer = true;
    realTimeout(() => {
      this.staleTimer = false;
      if (!this.disposed && this.staleSince !== null && this.wantFrame !== null) this.present(this.wantFrame);
    }, Math.max(1, holdMs - (now - this.staleSince)) + 20);
  }

  /**
   * Whether stream image is present this tick (drawn, or keeping previous). Placeholder T1 is decided
   * by this
   */
  get showing(): boolean { return this.lastDrawn !== null; }

  /**
   * Whether this tick draws a full-frame segment or a sparse segment (fallback order steps 1 / 2;
   * probe classifies by it). null when no image
   */
  get level(): "dense" | "sparse" | null {
    if (this.lastDrawn === null) return null;
    // The lowest tier always pastes the first frame of the segment (like the sparse version),
    // regardless of how dense this segment is in the manifest
    if (this.firstOnly) return "sparse";
    const meta = this.manifest?.segments[String(this.segmentOf(this.lastDrawn))];
    return (meta?.stride ?? 1) > 1 ? "sparse" : "dense";
  }

  /**
   * Entity box (tight rectangle from manifest, or upper bound if absent; plane coordinates).
   * Placeholder geometry is laid out from it
   */
  get box(): StreamRect | null { return this.manifest ? this.manifest.tight ?? this.manifest.bound : null; }

  /**
   * This tick: draw frame F (or keep previous image / clear to transparent when expired), then
   * decode a few frames ahead
   */
  present(f: number): void {
    // Repeated on the same frame (paused: data arrived, timer fired, or parent page resent stream planes)
    const again = this.wantFrame === f;
    if (!again) this.wantAt = realNow();
    this.wantFrame = f;
    const seg = this.segmentOf(f);
    if (!rangesHave(this.plane.ranges, seg)) {
      // This segment is not ready yet: this layer falls back to next step in fallback order (keep
      // previous image, then placeholder when expired); playhead does not stop
      this.miss();
      this.dropFrames();
      this.nextFeed = null;
      this.seekTarget = null;
      this.standIn = null;
      return;
    }
    this.loadManifest();
    if (!this.manifest) { this.miss(); return; }
    const meta = this.manifest.segments[String(seg)];
    if (!meta) { this.loadManifest(true); this.miss(); return; }
    if (this.firstOnly) { this.presentFirst(seg); return; }
    /*
     * Question G: previously only re-queried the manifest when a segment was missing or fetch failed:
     * after a sparse segment is replaced by a full-frame segment, the ready range sent by the producer
     * does not change by a single character, so the page keeps using the sparse segment (old file is
     * still in HTTP cache, fetch does not fail either). Now if current segment is a sparse segment, or
     * ready range for the same stream key changed, re-query with `MANIFEST_REFRESH_MS` throttling;
     * the replaced full-frame segment splices in at segment boundaries (comparing file names in `pump`),
     * not mid-segment, to avoid splicing onto delta frames from a different encoding.
     */
    const sparse = (meta.stride ?? 1) > 1;
    if (this.manifestDirty || sparse) {
      if (this.loadManifest(true)) this.manifestDirty = false;
    }
    // Jump backward (earlier than released frames) or jump forward too far (beyond fed segment):
    // decode again from the IDR of the segment containing the target
    let far = this.nextFeed === null || f < this.discardBefore || f > this.nextFeed + SEGMENT_FRAMES;
    /*
     * Parked on the same frame while the file for this segment in hand has been replaced (sparse →
     * full density): decode this frame again from the new file, and the better result replaces it
     * automatically. During playback the frame number changes every tick, so it does not go through
     * here: do not switch mid-segment (see note above).
     */
    const data = this.segments.get(seg);
    if (again && !far && data && data.file !== meta.file) {
      this.segments.delete(seg);
      far = true;
    }
    if (far) {
      if (this.seekTarget !== null && this.seekTarget !== f && this.fedSinceSeek > 0 && realNow() - this.seekAt < SEEK_PATIENCE_MS) {
        /*
         * Consecutive jumps (scrubbing): the previous frame seek is already decoding, do not interrupt it:
         * resetting the decoder at every step would yield zero frames and freeze the display. Once decoded,
         * draw it first (`onFrame`), then seek again for the frame requested at that time (`wake`); frames
         * skipped in between are not decoded. The target to feed next is that in-flight frame (`pump`).
         * If not a single chunk was fed last time (bytes have not arrived), do not wait: switch directly
         * to this frame.
         */
        this.stats.deferred++;
        this.miss();
        this.pump();
        return;
      }
      this.seek(f);
    }
    if (!this.drawAt(f)) {
      // Not decoded. If what is on canvas is already the expected image for this frame (sparse segments
      // share one image across frames), not counted as missing; otherwise keep previous image, timed
      if (this.fresh(f)) this.staleSince = null;
      else this.miss();
    }
    this.releaseBefore(f);
    this.pump();
    if (sparse) this.armRefresh();
  }

  /**
   * A tick in lowest tier (file header "Lowest tier"): if the first frame image of the segment
   * containing this frame is already on canvas, do nothing; if in hand, draw it; if neither, send
   * that keyframe to decode, keeping previous image for this tick (time-limited, same as other
   * tiers). `present` has already verified that this segment is ready and in the manifest.
   */
  private presentFirst(seg: number): void {
    const p = this.segmentStart(seg);
    // Discard all decoder outputs that are not the first frame of this segment (emerged after scrubbing
    // back or jumping away)
    for (const [k, h] of this.frames) if (k !== p) { h.frame.close(); this.frames.delete(k); }
    if (this.manifestDirty && this.loadManifest(true)) this.manifestDirty = false;
    if (this.lastDrawn === p) { this.staleSince = null; this.releaseFirst(p); return; }
    if (this.drawAt(p)) { this.releaseFirst(p); return; }
    this.miss();
    this.feedFirst(seg, p);
  }

  /**
   * Lowest tier: once drawn, close decoder output immediately (relies on `shown` reference to redraw
   * when canvas is replaced)
   */
  private releaseFirst(p: number): void {
    const held = this.frames.get(p);
    if (!held) return;
    held.frame.close();
    this.frames.delete(p);
  }

  /**
   * Lowest tier: send the first sample (keyframe) of segment `seg` to decode. If bytes or head file
   * have not arrived, fetch them first; once arrived, run `present` again.
   */
  private feedFirst(seg: number, p: number): void {
    if (this.disposed || !this.manifest || this.firstFailures >= FIRST_FRAME_MAX_FAILURES) return;
    if (this.firstFed !== null) {
      // A chunk is decoding: the same decoder only decodes one chunk at a time. Once it emerges
      // (`onFirstFrame`), retry for the frame requested at that time; reset if stuck too long
      if (realNow() - this.firstFedAt < FIRST_FRAME_STALL_MS) return;
      this.stats.errors++;
      this.stats.lastError = "first-frame decode stalled";
      this.firstFailures++;
      this.resetDecode();
      if (this.firstFailures >= FIRST_FRAME_MAX_FAILURES) return;
    }
    const meta = this.manifest.segments[String(seg)];
    if (!meta) return;
    const data = this.segments.get(seg);
    // Segment changed files in manifest (sparse → full density): the first frame is the same image, so
    // keep using the existing one if in hand without fetching again
    if (!data) { this.loadSegment(seg); return; }
    const init = this.inits.get(data.init);
    if (!init) { this.loadInit(data.init); return; }
    const sample = data.samples[0];
    if (!sample || !sample.isSync) { this.firstFailures = FIRST_FRAME_MAX_FAILURES; this.stats.errors++; this.stats.lastError = "segment does not start with a key frame"; return; }
    if (!this.decoder || this.decoder.state === "closed") {
      this.decoder = this.newDecoder();
      this.configuredInit = null;
      // Browser lacks `VideoDecoder`: cannot paste this stream, fall back to placeholder (parent page
      // should not have sent this in lowest tier to begin with, `snapshotSource.ts` `decodeSupport`)
      if (!this.decoder) { this.firstFailures = FIRST_FRAME_MAX_FAILURES; return; }
    }
    const decoder = this.decoder;
    try {
      if (this.configuredInit !== data.init) {
        // Do not specify hardware decoding on mobile: let browser fall back to software decoding when
        // hardware decoder cannot be created
        decoder.configure({ ...init.config, hardwareAcceleration: "no-preference" });
        this.configuredInit = data.init;
        this.bytesPerFrame = init.bytesPerFrame;
      }
      this.pending++;
      this.stats.maxHeld = Math.max(this.stats.maxHeld, this.heldCount);
      decoder.decode(new EncodedVideoChunk({
        type: "key", timestamp: chunkTimestamp(p, this.fps), duration: Math.round(1e6 / this.fps),
        data: new Uint8Array(data.buf, sample.offset, sample.size),
      }));
      this.firstFed = p;
      this.firstFedAt = realNow();
      // Only fed this chunk: tell decoder to output it (some decoders wait for later chunks before
      // emitting frames). After `flush`, next chunk must be a keyframe; this tier only feeds keyframes
      if (typeof decoder.flush === "function") void decoder.flush().catch(() => { /* Reset / closed */ });
    } catch (e) {
      this.pending = 0;
      this.firstFed = null;
      this.firstFailures++;
      this.stats.errors++;
      this.stats.lastError = String((e as Error)?.message || e);
      try { if (decoder.state !== "closed") decoder.close(); } catch { /* Already broken */ }
      if (this.decoder === decoder) { this.decoder = null; this.configuredInit = null; }
    }
  }

  /**
   * Lowest tier: the chunk sent to decode has emerged. If still the one needed right now, draw and
   * close; otherwise (playhead already moved to another segment), close and retry for what is
   * currently needed.
   */
  private onFirstFrame(frame: VideoFrame, f: number): void {
    if (this.firstFed === f) this.firstFed = null;
    if (this.disposed) { frame.close(); return; }
    this.firstFailures = 0;
    this.stats.decoded++;
    const want = this.wantFrame;
    if (want === null || this.pictureOf(want) !== f || this.frames.has(f) || !rangesHave(this.plane.ranges, this.segmentOf(want))) {
      frame.close();
      if (want !== null && this.pictureOf(want) !== f) this.wake();
      return;
    }
    this.frames.set(f, { frame, segment: this.segmentOf(f) });
    this.stats.maxHeld = Math.max(this.stats.maxHeld, this.heldCount);
    // Cannot draw (shared context lost): keep in hand for now, draw on next tick or when context returns
    if (this.drawAt(f)) this.releaseFirst(f);
  }

  /**
   * Parked on a sparse segment: re-query manifest periodically on its own. Replace once full-density
   * segment is produced, without waiting for user action (product/rendering.md "Fallback order");
   * the ready range will not change because of this step, so parent page will not call. Streams whose
   * manifest is pushed by parent page do not need this (parent page resending stream planes with a
   * new manifest will run `present` again).
   */
  private armRefresh(): void {
    if (this.refreshTimer || this.plane.manifest) return;
    this.refreshTimer = true;
    realTimeout(() => {
      this.refreshTimer = false;
      if (this.disposed || this.wantFrame === null) return;
      // Playhead did not move for a while (paused): run again (query manifest, switch files; if
      // still sparse, `present` schedules next).
      // Still moving (playing, scrubbing), do not intervene, but keep scheduling: once it stops,
      // nobody will call again
      if (realNow() - this.wantAt >= MANIFEST_REFRESH_MS) this.present(this.wantFrame);
      else this.armRefresh();
    }, MANIFEST_REFRESH_MS + 50);
  }

  /**
   * Release frames before target; earlier frames decoded afterwards are closed immediately
   * (`discardBefore` only increases).
   */
  private releaseBefore(f: number): void {
    for (const [k, h] of this.frames) {
      if (k < f) { h.frame.close(); this.frames.delete(k); }
    }
    if (f > this.discardBefore) this.discardBefore = f;
  }

  private dropFrames(): void {
    for (const h of this.frames.values()) h.frame.close();
    this.frames.clear();
  }

  /** Feed into decoder: feed until "held + queued" reaches this stream's quota, or looked far enough ahead */
  pump(): void {
    if (this.disposed || this.nextFeed === null || !this.manifest || this.wantFrame === null) return;
    const cap = this.player.capFor(this);
    /*
     * How far to feed: normally look ahead two segments beyond the frame currently needed. When there
     * is an in-flight seek and the frame needed right now has moved to another frame (scrubbing
     * continuously), feed only up to that in-flight frame: once decoded, a new seek starts for the frame
     * needed at that moment; extra fed frames are wasted decoding, and would fetch later segments in vain.
     */
    const chasing = this.seekTarget !== null && this.seekTarget !== this.wantFrame;
    const horizon = chasing ? (this.seekTarget as number) : this.wantFrame + 2 * SEGMENT_FRAMES;
    let guard = 0;
    for (;;) {
      if (this.nextFeed === null || this.nextFeed > horizon || guard++ >= 64) break;
      // Frames before target (decoded from IDR for random access) close immediately upon emission without
      // taking quota: only enforce the 8-frame hard limit per decoder;
      // frames at or after target are kept for drawing, fed according to this stream's quota
      const limit = this.nextFeed < this.discardBefore ? MAX_FRAMES_PER_DECODER : cap;
      if (this.heldCount >= limit) break;
      const seg = this.segmentOf(this.nextFeed);
      if (!rangesHave(this.plane.ranges, seg)) break;
      const meta = this.manifest.segments[String(seg)];
      if (!meta) { this.loadManifest(true); break; }
      const data = this.segments.get(seg);
      // Segment changed files in manifest (sparse → full frame, question G): switch only at segment
      // starts, continue using copy in hand mid-segment (delta frames cannot cross encodings)
      const replaced = !!data && data.file !== meta.file && this.nextFeed === this.segmentStart(seg);
      if (!data || replaced) {
        if (data) this.segments.delete(seg);
        this.loadSegment(seg);
        break;
      }
      const init = this.inits.get(data.init);
      if (!init) { this.loadInit(data.init); break; }
      if (!this.decoder || this.decoder.state === "closed") {
        this.decoder = this.newDecoder();
        this.configuredInit = null;
        if (!this.decoder) break;
      }
      if (this.configuredInit !== data.init) {
        try { this.decoder.configure(init.config); }
        catch (e) {
          this.stats.errors++;
          this.stats.lastError = String((e as Error)?.message || e);
          try { this.decoder.configure({ ...init.config, hardwareAcceleration: "no-preference" }); }
          catch { break; }
        }
        this.configuredInit = data.init;
        this.bytesPerFrame = init.bytesPerFrame;
        // Variant changes must start from this segment's IDR
        const segStart = this.segmentStart(seg);
        if (this.nextFeed !== segStart) this.nextFeed = segStart;
      }
      const index = this.nextFeed - this.segmentStart(seg);
      const sample = data.samples[index];
      if (!sample) { this.nextFeed = this.segmentStart(seg + 1); continue; }
      try {
        this.pending++;
        this.fedSinceSeek++;
        this.stats.maxHeld = Math.max(this.stats.maxHeld, this.heldCount);
        this.decoder.decode(new EncodedVideoChunk({
          type: sample.isSync ? "key" : "delta",
          timestamp: chunkTimestamp(this.nextFeed, this.fps),
          duration: Math.round(1e6 / this.fps),
          data: new Uint8Array(data.buf, sample.offset, sample.size),
        }));
      } catch (e) {
        this.pending = Math.max(0, this.pending - 1);
        this.stats.errors++;
        this.stats.lastError = String((e as Error)?.message || e);
        this.nextFeed = null;
        this.seekTarget = null;
        this.standIn = null;
        break;
      }
      this.nextFeed++;
    }
  }

  setPlane(plane: StreamPlaneRequest, canvas: HTMLCanvasElement): void {
    // Stream changed, or same stream was placed at different frames (first frame changed: decoded
    // frames in hand are indexed by old project frame numbers): start over
    if (plane.key !== this.plane.key || plane.originFrame !== this.plane.originFrame || !!plane.first !== !!this.plane.first) {
      this.firstFailures = 0;
      this.manifest = null;
      this.segments.clear();
      this.resetDecode();
      this.nextFeed = null;
      this.discardBefore = 0;
      // Canvas image belongs to old stream (input changed, or frame numbers mismatched): do not keep
      this.blank();
    } else if (JSON.stringify(plane.ranges ?? []) !== JSON.stringify(this.plane.ranges ?? [])) {
      // Same key, ready range changed: producer published new segments, manifest may have changed too (question G)
      this.manifestDirty = true;
    }
    this.plane = plane;
    if (canvas !== this.canvas) {
      this.canvas = canvas;
      // Wrapper layer remounted (start of stopping frame catch-up) with a new empty canvas: redraw
      // previous image as is, without waiting for decode
      if (!this.redraw()) {
        const was = this.lastDrawn;
        this.lastDrawn = null;
        this.staleSince = null;
        this.closeShown();
        if (was !== null) this.player.noteShowing();
      }
    }
    // Parent page brought a new manifest (added segments, segment changed file): swap immediately;
    // segments with changed files splice in at segment starts (compare file names in `pump`)
    if (plane.manifest && plane.manifest !== this.manifest) this.adoptPushed(plane.manifest);
  }

  dispose(): void {
    this.disposed = true;
    for (const h of this.frames.values()) h.frame.close();
    this.frames.clear();
    this.closeShown();
    try { if (this.decoder && this.decoder.state !== "closed") this.decoder.close(); } catch { /* Already closed */ }
    this.decoder = null;
    this.compositor?.clear();
    this.compositor = null;
    this.segments.clear();
  }

  diag() {
    return { id: this.id, key: this.key, pushed: !!this.plane.manifest, held: this.frames.size, queue: this.decoder?.decodeQueueSize ?? 0,
      decoder: this.decoder?.state ?? null, nextFeed: this.nextFeed, lastDrawn: this.lastDrawn,
      // Requested frame, currently drawn image (in sparse segments, latest one no later than that frame),
      // whether it is a retained old image, in-flight seek, duration of last seek
      want: this.wantFrame, picture: this.lastDrawn === null ? null : this.pictureOf(this.lastDrawn), level: this.level,
      // Density in manifest of segment containing drawn image (1 = full density; lowest tier only decodes
      // first frame regardless of density)
      stride: this.lastDrawn === null ? null : this.manifest?.segments[String(this.segmentOf(this.lastDrawn))]?.stride ?? null,
      stale: this.staleSince !== null, seekTarget: this.seekTarget, lastSeek: this.lastSeek,
      segments: [...this.segments.keys()], manifest: !!this.manifest, bound: this.manifest?.bound ?? null,
      // Which plane type drawn on (under stage root / in wrapper layer), which stream type manifest
      // specifies, and whether it matches this plane
      plane: stagePlane(this.plane) ? "stage" : "local", kind: this.manifest?.kind ?? null, fits: this.planeFits,
      cap: this.player.capFor(this), first: this.firstOnly, firstFailures: this.firstFailures, ...this.stats };
  }
}

/** Whether this is a position rectangle (four finite numbers, positive width and height) */
const isRect = (r: unknown): r is StreamRect => {
  const v = r as StreamRect | null;
  return !!v && typeof v === "object" && [v.x, v.y, v.w, v.h].every(Number.isFinite) && v.w > 0 && v.h > 0;
};

/**
 * A stream exceeding budget: does not create decoders, does not draw, only holds its manifest,
 * reporting to placeholders the "position rectangle of the segment containing this frame"
 * (`segments[n].box` in manifest, the tight box measured for each segment when producing sparse
 * version). If manifest is brought by parent page (online page), use what was brought; if not
 * (desktop), query byte source; if segment containing this frame has no position rectangle yet,
 * re-query after `MANIFEST_REFRESH_MS`. Returns null if manifest cannot be fetched or segment was
 * unmeasured; placeholders position via old method.
 */
class OverPlane {
  plane: StreamPlaneRequest;
  private player: StreamPlayer;
  manifest: StreamManifest | null;
  private askedAt = 0;
  private loading = false;
  disposed = false;

  constructor(player: StreamPlayer, plane: StreamPlaneRequest) {
    this.player = player;
    this.plane = plane;
    this.manifest = plane.manifest ?? null;
  }

  setPlane(plane: StreamPlaneRequest): void {
    this.plane = plane;
    if (plane.manifest) this.manifest = plane.manifest;
  }

  /**
   * Position rectangle of the segment containing this frame (plane coordinates: single-card stream
   * uses wrapper layer coordinates, stage-coordinate stream uses stage coordinates); null if none
   */
  boxAt(f: number): StreamRect | null {
    const m = this.manifest;
    if (!m || !isStreamOrigin(this.plane.originFrame)) return null;
    // Discard if coordinate system in manifest does not match parent page (same as `StreamTrack.planeFits`)
    if ((m.plane === "stage" || m.plane === "local") && (m.plane === "stage") !== stagePlane(this.plane)) return null;
    const box = m.segments?.[String(streamSegmentOf(f, this.plane.originFrame))]?.box;
    return isRect(box) ? box : null;
  }

  /**
   * Called every tick: fetch manifest if missing; if manifest in hand does not contain the segment
   * for this frame yet (stale manifest), re-query after a delay. If segment is already in manifest
   * but lacks a position rectangle (unmeasured segments will not have one later either), do not ask
   * again. If manifest is brought by parent page, do not query; wait for it to bring a new one.
   */
  tick(f: number): void {
    if (this.plane.manifest || this.loading || !this.plane.key) return;
    if (this.manifest && isStreamOrigin(this.plane.originFrame) && this.manifest.segments?.[String(streamSegmentOf(f, this.plane.originFrame))]) return;
    const now = realNow();
    if (this.askedAt && now - this.askedAt < MANIFEST_REFRESH_MS) return;
    this.askedAt = now;
    this.loading = true;
    this.player.source.manifest(this.plane.key)
      .then((m) => { if (!this.disposed) { this.manifest = m; this.player.noteBoxes(); } })
      .catch(() => { /* No manifest yet: placeholders position via old method, re-query after a while */ })
      .finally(() => { this.loading = false; });
  }
}

const planeId = (plane: StreamPlaneRequest) => `${plane.clipIds.join(",")}#${plane.key ?? ""}${plane.plane === "stage" ? "@stage" : ""}`;

/* ======================================================================== *
 * All streams on stage
 * ======================================================================== */

export class StreamPlayer {
  readonly source: StreamSource;
  /**
   * Manifest and bytes pushed by parent page with stream planes (online page); desktop planes omit
   * manifest, so always empty here
   */
  readonly pushed = new PushedStreamSource();
  fps = 30;
  private root: () => Element | null;
  private planes: StreamPlaneRequest[] = [];
  private tracks = new Map<string, StreamTrack>();
  private proxy = false;
  private stopped = false;
  private lastFrame: number | null = null;
  private onShowingChange: (() => void) | null;
  private showingQueued = false;
  /** Streams exceeding budget (clip id → that stream; group stream members all point to the same one) */
  private over = new Map<string, OverPlane>();
  private onBoxChange: (() => void) | null;
  private boxesQueued = false;
  private boxesSig = "";
  private onContextLost: (() => void) | null;
  /**
   * WebGL context shared across all stream planes (created only when first actually drawing; stages
   * with `back` role never draw, so not created)
   */
  readonly gl: SharedGl;

  constructor({ root, source = new HttpStreamSource(), onShowingChange, onContextLost, onBoxChange }: {
    root: () => Element | null; source?: StreamSource;
    /**
     * Called when a stream image appears or disappears (asynchronously decoded, or expired and
     * cleared); called only once in the same microtask. When paused there is no next tick: host relies
     * on it to dismiss placeholders and hide live subtrees waiting for the first frame image.
     */
    onShowingChange?: () => void;
    /**
     * Shared WebGL context lost (canvas not in document, events cannot reach `document`; online page
     * uses it to report "Runtime error occurred")
     */
    onContextLost?: () => void;
    /**
     * Called when the position rectangle of an over-budget layer changes (manifest arrived, playhead
     * entered next segment); called only once in the same microtask. Placeholder geometry is fetched
     * during host rendering (`boxOf` / `stageBoxOf`), host relies on it to re-fetch.
     */
    onBoxChange?: () => void;
  }) {
    this.root = root;
    this.source = source;
    this.onShowingChange = onShowingChange ?? null;
    this.onContextLost = onContextLost ?? null;
    this.onBoxChange = onBoxChange ?? null;
    /*
     * Shared context lost / restored: run this frame again (when paused there is no next tick). Once
     * lost, browser might not restore it (those evicted by other canvases are not restored), so the
     * moment it is lost, schedule a separate real timer to run again at `GL_RETRY_MS`: `SharedGl` will
     * create a new one then.
     */
    this.gl = new SharedGl(
      () => { this.onContextLost?.(); this.retryLater(GL_RETRY_MS); },
      () => this.represent(),
      (ms) => this.retryLater(ms),
    );
  }

  /**
   * Run this frame again after `ms` milliseconds (shared context is lost, or not yet created). Only
   * one scheduled at a time; when it fires, if there are no streams to draw (stopped, no tracks), do
   * not schedule further; if still unable to draw, `SharedGl` schedules next attempt (doubled
   * interval) to avoid spinning.
   */
  private retryPending = false;
  private retryLater(ms: number): void {
    if (this.retryPending) return;
    this.retryPending = true;
    realTimeout(() => { this.retryPending = false; this.represent(); }, Math.max(1, ms) + 20);
  }

  /** Run the frame requested on the last tick again (shared context restored) */
  private represent(): void {
    if (this.stopped || this.proxy || this.lastFrame === null) return;
    for (const track of this.tracks.values()) track.present(this.lastFrame);
  }

  /**
   * Track reports: image presence changed. Batched into microtask to notify host (avoid re-entering
   * host in `present` loop)
   */
  noteShowing(): void {
    if (!this.onShowingChange || this.showingQueued) return;
    this.showingQueued = true;
    queueMicrotask(() => {
      this.showingQueued = false;
      if (!this.stopped) this.onShowingChange?.();
    });
  }

  /**
   * Position rectangle of over-budget layer may have changed: batched into microtask, notify host
   * only if actually changed
   */
  noteBoxes(): void {
    if (!this.onBoxChange || this.boxesQueued) return;
    this.boxesQueued = true;
    queueMicrotask(() => {
      this.boxesQueued = false;
      if (this.stopped) return;
      const f = this.lastFrame ?? 0;
      let sig = "";
      // Only record those with rectangles: layers without rectangles position placeholders via old
      // method, adding or removing them does not require host re-fetch
      for (const [id, o] of this.over) { const b = o.boxAt(f); if (b) sig += `${id}:${b.x},${b.y},${b.w},${b.h};`; }
      if (sig === this.boxesSig) return;
      this.boxesSig = sig;
      this.onBoxChange?.();
    });
  }

  /**
   * Over-budget planes (marked `over` by parent page): only recorded to fetch manifest, without
   * creating decoders
   */
  private setOver(planes: readonly StreamPlaneRequest[]): void {
    const before = new Map<string, OverPlane>();
    for (const o of this.over.values()) before.set(planeId(o.plane), o);
    const next = new Map<string, OverPlane>();
    const kept = new Set<OverPlane>();
    for (const plane of planes) {
      let entry = before.get(planeId(plane)) ?? null;
      if (entry) entry.setPlane(plane); else entry = new OverPlane(this, plane);
      kept.add(entry);
      for (const clipId of plane.clipIds) next.set(clipId, entry);
    }
    for (const o of before.values()) if (!kept.has(o)) o.disposed = true;
    const had = this.over.size > 0;
    this.over = next;
    if (had || next.size) this.noteBoxes();
  }

  /**
   * `setStreamPlanes` from parent page. Only stores; binds canvas on next `present` (canvas exists
   * only after React commit). `over`: planes exceeding budget this tick (not decoded, only used to
   * fetch position rectangles for placeholders); planes marked `over` in `planes` also count.
   */
  setPlanes(planes: readonly StreamPlaneRequest[], fps: number, over: readonly StreamPlaneRequest[] = []): void {
    const usable = (p: StreamPlaneRequest) => Array.isArray(p?.clipIds) && p.clipIds.length > 0 && typeof p.key === "string" && !!p.key && isStreamOrigin(p.originFrame);
    this.setOver([...over, ...planes.filter((p) => p?.over)].filter(usable));
    const list = planes.filter((p) => usable(p) && !p.over);
    // Online page: take chunks pushed with planes first (discard unused old chunks immediately), planes
    // themselves do not retain bytes
    this.pushed.accept(list);
    this.planes = list.map((p) => {
      if (!p.blocks) return p;
      const { blocks: _blocks, ...rest } = p;
      return rest;
    });
    this.fps = Math.max(1, fps || 30);
    this.stopped = false;
    // Close unneeded streams immediately (decoders, held VideoFrames): when paused parent page sends
    // an empty table, next tick might not come
    const keep = new Set(this.planes.map(planeId));
    for (const [id, track] of this.tracks) {
      if (!keep.has(id)) { track.dispose(); this.tracks.delete(id); }
    }
  }

  /**
   * When solid mode is on, `.pc-proxy` is hidden along with stream planes; stop decoding here, taking
   * no decoded frame budget (E7 item 4)
   */
  setProxy(on: boolean): void {
    this.proxy = !!on;
    if (this.proxy) this.disposeAll();
  }

  /**
   * Plane canvas reference cache (P4 performance fix): `sync()` running querySelector from scene
   * root for each stream every tick is too expensive
   */
  private canvasCache = new Map<string, HTMLCanvasElement>();

  private canvasOf(plane: StreamPlaneRequest): HTMLCanvasElement | null {
    const root = this.root();
    if (!root) return null;
    // Canvas for single-card stream is in its wrapper layer; canvases for group streams and
    // below-dependent streams are under stage root (`[data-pc-group-plane]` in `Stage`)
    const single = !stagePlane(plane);
    const key = plane.clipIds.join(",");
    const hit = this.canvasCache.get(key);
    // Still in the scene and still mounted under the same wrapper layer (single-card stream) / same
    // group (group stream): use directly
    if (hit && hit.isConnected && root.contains(hit)
      && (single ? (hit.parentElement?.getAttribute("data-pc-clip") === key || hit.parentElement?.getAttribute("data-pc-flat-clip") === key) : hit.getAttribute("data-pc-stream-group") === key)) return hit;
    // A card inside a cut segment (the virtual clip of `kernel/cutFlatten.mjs`): in a nested scene the
    // wrapper layer carries `data-pc-flat-clip`
    const found = single
      ? (root.querySelector<HTMLCanvasElement>(`[data-pc-clip="${CSS.escape(key)}"] > canvas[data-pc-stream-plane]`)
        ?? root.querySelector<HTMLCanvasElement>(`[data-pc-flat-clip="${CSS.escape(key)}"] > canvas[data-pc-stream-plane]`))
      : root.querySelector<HTMLCanvasElement>(`canvas[data-pc-group-plane][data-pc-stream-group="${CSS.escape(key)}"]`);
    if (found) this.canvasCache.set(key, found);
    else this.canvasCache.delete(key);
    if (this.canvasCache.size > 256) this.canvasCache.clear();
    return found;
  }

  /** Scene root (used when group streams hide / show member snapshot planes) */
  rootElement(): Element | null {
    return this.root();
  }

  /**
   * Match planes to canvases: create streams for new ones, close gone ones. Over-budget planes were
   * already marked `over` by the parent page and are not in `this.planes` (`setPlanes`);
   * here we only guard the hard upper limit on the count once more.
   */
  private sync(): void {
    const want = new Map<string, { plane: StreamPlaneRequest; canvas: HTMLCanvasElement }>();
    for (const plane of planesWithinBudget(this.planes, this.fps, STAGE_PLANE_PIXELS)) {
      const canvas = this.canvasOf(plane);
      if (!canvas) continue;
      want.set(planeId(plane), { plane, canvas });
    }
    for (const [id, track] of this.tracks) {
      if (!want.has(id)) { track.dispose(); this.tracks.delete(id); }
    }
    for (const [id, { plane, canvas }] of want) {
      const track = this.tracks.get(id);
      if (track) track.setPlane(plane, canvas);
      else this.tracks.set(id, new StreamTrack(this, plane, canvas));
    }
  }

  /**
   * This tick (K4's tick loop, or `setTime` during pause / scrub). Synchronous: if this frame is
   * on hand, draw it immediately; if not, keep the previous one or transparent, then schedule decoding
   * for the next few frames: **never blocks the caller**.
   */
  present(sec: number): void {
    if (this.stopped || this.proxy) return;
    this.sync();
    const f = Math.max(0, Math.round(sec * this.fps + 1e-6));
    const moved = this.lastFrame !== f;
    this.lastFrame = f;
    for (const track of this.tracks.values()) track.present(f);
    if (this.over.size) {
      for (const o of new Set(this.over.values())) o.tick(f);
      // Playhead entered the next segment; position rectangle may have changed
      if (moved) this.noteBoxes();
    }
  }

  /**
   * Hold limit for this stream: byte budget evenly split across streams (≤ 80 MB total), clamped
   * between [3, 8]: 8 is the hard limit for a single decoder (G0-b (4)), 3 is the per-stream floor (G5).
   */
  capFor(track: StreamTrack): number {
    const n = Math.max(1, this.tracks.size);
    const share = Math.floor(DECODED_BYTES_BUDGET / n / Math.max(1, track.bytesPerFrame));
    return Math.max(MIN_FRAMES_PER_STREAM, Math.min(MAX_FRAMES_PER_DECODER, share));
  }

  private disposeAll(): void {
    for (const track of this.tracks.values()) track.dispose();
    this.tracks.clear();
  }

  /** `setRole('back')`: stop, `close()` all `VideoFrame`, clear canvas (item 3 in E0 complete cleanup) */
  stop(): void {
    this.stopped = true;
    this.planes = [];
    this.disposeAll();
    for (const o of this.over.values()) o.disposed = true;
    this.over = new Map();
    this.boxesSig = "";
    this.gl.shrink();
  }

  /**
   * Cards whose stream visual is present this tick (group streams count toward each member).
   * Placeholder T1: only layers that are suppressed, have a blank stream this tick, and have no
   * snapshot attached show placeholders: read on the same tick after `present`
   * (`StageView`'s `refreshPlaceholders`).
   */
  showingClips(): Set<string> {
    const out = new Set<string>();
    if (this.stopped || this.proxy) return out;
    for (const track of this.tracks.values()) {
      if (!track.showing) continue;
      for (const id of track.plane.clipIds) out.add(id);
    }
    return out;
  }

  /**
   * Whether each card's stream visual this tick is a full-frame or sparse segment
   * (lists only those with visuals; for probes).
   */
  levels(): Map<string, "dense" | "sparse"> {
    const out = new Map<string, "dense" | "sparse">();
    if (this.stopped || this.proxy) return out;
    for (const track of this.tracks.values()) {
      const level = track.level;
      if (level) for (const id of track.plane.clipIds) out.set(id, level);
    }
    return out;
  }

  /**
   * Entity box for single-card streams within budget (manifest's tight rectangle, or upper bound
   * if none; wrapper layer coordinates = plane coordinates). Boxes for group streams and
   * below-dependent streams are in stage coordinates and not returned.
   */
  boxOf(clipId: string): StreamRect | null {
    for (const track of this.tracks.values()) {
      if (!stagePlane(track.plane) && track.plane.clipIds[0] === clipId) return track.box;
    }
    return null;
  }

  /**
   * **Over-budget** single-card streams: position rectangle for the segment containing this frame
   * in the manifest (wrapper layer coordinates); returns null if unmeasured or without a manifest.
   * Returned separately from `boxOf`: this rectangle only applies to this frame, and the host
   * should not cache it for later use. For group streams and below-dependent streams, see `stageBoxOf`.
   */
  overBoxOf(clipId: string): StreamRect | null {
    const over = this.over.get(clipId);
    if (over && !stagePlane(over.plane) && this.lastFrame !== null) return over.boxAt(this.lastFrame);
    return null;
  }

  /**
   * Members of groups with a position rectangle for this frame among over-budget group streams
   * (each group in painter's order, last one on top). The entire group has only one rectangle
   * (union of members); the host only allows one member to display a placeholder (4: otherwise
   * N members would stack N identical boxes).
   */
  overGroups(): string[][] {
    const out: string[][] = [];
    if (this.lastFrame === null) return out;
    for (const o of new Set(this.over.values())) {
      if (o.plane.clipIds.length > 1 && o.boxAt(this.lastFrame)) out.push([...o.plane.clipIds]);
    }
    return out;
  }

  /**
   * Position rectangle for the segment containing this frame for over-budget streams produced in
   * stage coordinates (group streams, below-dependent streams), in **stage coordinates** (rectangle
   * in the manifest plus manifest `offset`; `offset` is zero for such streams). The host must convert
   * it to wrapper layer coordinates before passing to the placeholder. Returns null in other cases.
   */
  stageBoxOf(clipId: string): StreamRect | null {
    const over = this.over.get(clipId);
    if (!over || !stagePlane(over.plane) || this.lastFrame === null) return null;
    const box = over.boxAt(this.lastFrame);
    if (!box) return null;
    const off = over.manifest?.offset;
    return { x: box.x + (Number(off?.x) || 0), y: box.y + (Number(off?.y) || 0), w: box.w, h: box.h };
  }

  /**
   * Over-budget planes exist this tick (when there are no stream planes, the host still calls
   * `present` every tick based on this: position rectangles change with the playhead).
   */
  get hasOver(): boolean { return this.over.size > 0; }

  /** Decoded frame bytes currently held (checked by the acceptance check "total decoded frame memory ≤ 80 MB") */
  heldBytes(): number {
    let bytes = 0;
    for (const track of this.tracks.values()) bytes += track.heldCount * track.bytesPerFrame;
    return bytes;
  }

  diag() {
    return { stopped: this.stopped, proxy: this.proxy, fps: this.fps, lastFrame: this.lastFrame, planes: this.planes.length,
      over: [...new Set(this.over.values())].map((o) => ({ clipIds: o.plane.clipIds, key: o.plane.key ?? "", box: this.lastFrame === null ? null : o.boxAt(this.lastFrame) })),
      heldBytes: this.heldBytes(), gl: { state: this.gl.state, ...this.gl.stats }, pushed: { blocks: this.pushed.size, bytes: this.pushed.bytes },
      tracks: [...this.tracks.values()].map((t) => t.diag()) };
  }
}
