/**
 * "Fast export" fetches frames from track streams (semantics in `docs/semantics/product/platforms.md`
 * "Online browser" "Export"): reads the `streams` table in the layer table and stream manifests to
 * determine which segments in each stream are full density; during export, fetches segment bytes
 * frame by frame, decodes, and composites top and bottom halves (premultiplied color + opacity)
 * into a transparent image.
 *
 * Uses the same data and conversions as preview:
 *   - Layer table (content store `snapshot-manifest`, key `layers:<project id>`), stream manifests
 *     (`render-manifest`, key `<result key>:<start>-<end>`), segment bytes (asset service `px/<hash>`);
 *   - Segment numbers start from the stream's first frame, 15 frames per segment (`streamSegments.mjs`);
 *     demuxing uses `parseInit` / `parseSegment` from `streamPlayer.ts`;
 *   - Compositing follows `streamPlayer.ts` shader: color half is premultiplied color clamped to
 *     `rgb ≤ a`, opacity is luminance of bottom half; 8 rows between halves, 8 rows reserved at bottom.
 *
 * Only accepts **one stream per card** (single-card stream, including source-dependent cards and
 * cards with 3D bounding boxes; below-dependent stream rows recognized by the page are also
 * accepted); group streams are omitted (`cardLayers.ts` file header).
 * Stale-input streams (input signature in row mismatches that computed for this project version)
 * are omitted. When a stream has multiple candidates (produced by different environments), pick the
 * one with the most full-density segments; a stream uses segments from only one candidate, never
 * mixing environments.
 *
 * Decoding proceeds sequentially in ascending frame number order (export naturally moves forward):
 * feeds continuously within the same segment without resetting decoder; across segments, resumes
 * from the next segment's keyframe.
 * The same bytes and decoder produce deterministic pixels, so exporting the same project twice
 * yields identical frames.
 */
import { isFlatClipId } from "../kernel/cutFlatten.mjs";
import { LAYER_MAP_PREFIX, parseLayerMap, streamSpansInWindow, type OnlineStream } from "../render/snapshotSource";
import { chunkTimestamp, parseInit, parseSegment, type SegmentSample } from "../render/streamPlayer";
import { streamInputSig, streamSigStale } from "../render/streamInputSig.mjs";
import { streamSegmentFirstFrame, streamSegmentOf } from "../render/streamSegments.mjs";
import type { LayerRect, StreamCoverage } from "./cardLayers";
import { tr } from "../i18n/index.ts";

export interface StreamFrameDeps {
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  assetBase(): string | null;
  authHeaders(): Promise<Record<string, string>>;
  fetch?: typeof fetch;
}

const HASH_RE = /^[0-9a-f]{64}$/;
/** Row count reserved between the top and bottom halves and at the bottom (matches `server/bakery/ffmpeg.mjs` layout and `streamPlayer.ts` shader) */
export const HALF_GAP_ROWS = 8;
/** Maximum wait time for decoding a frame (only to prevent hanging) */
export const DECODE_TIMEOUT_MS = 30_000;

interface InitMeta { hash: string; rect: LayerRect }
interface SegMeta { hash: string; init: string; stride: number; samples: number }

/** An eligible stream, along with the manifest required to fetch bytes */
export interface ReadableStream extends StreamCoverage {
  fps: number;
  inits: Map<string, InitMeta>;
  segments: Map<number, SegMeta>;
}

const rectOf = (r: unknown): LayerRect | null => {
  const o = r as Partial<LayerRect> | null;
  if (!o || typeof o !== "object") return null;
  const { x, y, w, h } = o;
  return [x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n)) && (w as number) > 0 && (h as number) > 0 ? { x: x as number, y: y as number, w: w as number, h: h as number } : null;
};

/** Segments with matching shape in this range and their head files from a stream manifest returned by the content store (same as `parseStreamManifest` in `snapshotSource.ts`) */
export function readStreamManifest(body: unknown, resultKey: string, span: [number, number]): { fps: number; inits: Map<string, InitMeta>; segments: Map<number, SegMeta> } | null {
  const b = body as { kind?: unknown; resultKey?: unknown; header?: Record<string, unknown>; inits?: Record<string, Record<string, unknown>>; segments?: Record<string, Record<string, unknown>> } | null;
  if (!b || typeof b !== "object" || b.kind !== "stream" || b.resultKey !== resultKey) return null;
  const fps = Number(b.header?.fps);
  if (!(fps > 0)) return null;
  const inits = new Map<string, InitMeta>();
  for (const [id, meta] of Object.entries(b.inits && typeof b.inits === "object" ? b.inits : {})) {
    const rect = rectOf(meta?.rect);
    if (!HASH_RE.test(String(meta?.hash)) || !rect) continue;
    inits.set(id, { hash: String(meta.hash), rect });
  }
  const segments = new Map<number, SegMeta>();
  for (const [name, meta] of Object.entries(b.segments && typeof b.segments === "object" ? b.segments : {})) {
    const n = Number(name);
    if (!Number.isInteger(n) || n < span[0] || n > span[1] || !HASH_RE.test(String(meta?.hash)) || !inits.has(String(meta.init))) continue;
    const stride = Number(meta.stride), samples = Number(meta.samples);
    if (!Number.isInteger(stride) || stride < 1 || !Number.isInteger(samples) || samples < 1) continue;
    segments.set(n, { hash: String(meta.hash), init: String(meta.init), stride, samples });
  }
  return { fps, inits, segments };
}

/**
 * Reads layer table and manifest for each stream, returning eligible streams in this project version
 * (only listing those with at least one full-density segment). If layer table is unavailable or has
 * no streams, returns an empty table (fast export falls back to full export behavior).
 * `clipIds`: only inspect streams for these clips (omitted = all).
 */
export async function loadReadableStreams(projectId: string | null, project: unknown, deps: StreamFrameDeps, { clipIds = null as ReadonlySet<string> | null } = {}): Promise<ReadableStream[]> {
  if (!projectId) return [];
  let rows: OnlineStream[] = [];
  try {
    const r = await deps.request({ type: "content.get", kind: "snapshot-manifest", key: LAYER_MAP_PREFIX + projectId });
    const map = r?.type === "content.item" && !r.missing ? parseLayerMap(r.body) : null;
    rows = map?.streams ?? [];
  } catch { rows = []; }
  const out: ReadableStream[] = [];
  for (const row of rows) {
    // Only accepts single-card streams; group streams are omitted
    if (row.clipIds.length !== 1 || (row.kind as string) === "group") continue;
    const clipId = row.clipIds[0];
    if (clipIds && !clipIds.has(clipId)) continue;
    // Cards inside cut segments (virtual clips in `kernel/cutFlatten.mjs`) are not fetched from streams: nested scenes are live rendered whole frame during export
    if (isFlatClipId(clipId)) continue;
    // Stale-input streams are omitted (the signature in the row differs from that computed by the page
    // for this project version). Rows without signatures cannot be verified and are likewise omitted
    // during export (preview pastes as before according to its own rules):
    // pasting visuals from a different version into the final video is worse than being slightly slower
    if (!row.inputSig || streamSigStale(row.inputSig, streamInputSig(project, row))) continue;
    let best: ReadableStream | null = null;
    for (const candidate of row.candidates) {
      const inits = new Map<string, InitMeta>();
      const segments = new Map<number, SegMeta>();
      let fps = 0;
      for (const span of streamSpansInWindow(row, row.firstSegment, row.lastSegment)) {
        let body: unknown;
        try {
          const r = await deps.request({ type: "content.get", kind: "render-manifest", key: `${candidate.resultKey}:${span[0]}-${span[1]}` });
          body = r?.type === "content.item" && !r.missing ? r.body : null;
        } catch { body = null; }
        const got = readStreamManifest(body, candidate.resultKey, span);
        if (!got) continue;
        fps = got.fps;
        for (const [id, meta] of got.inits) inits.set(id, meta);
        for (const [n, meta] of got.segments) segments.set(n, meta);
      }
      const dense = new Map<number, number>();
      for (const [n, seg] of segments) if (seg.stride === 1) dense.set(n, seg.samples);
      if (!dense.size || !(fps > 0)) continue;
      if (!best || dense.size > best.dense.size) {
        best = { clipId, plane: row.plane, resultKey: candidate.resultKey, originFrame: row.originFrame, dense, fps, inits, segments };
      }
    }
    if (best) out.push(best);
  }
  return out;
}

/** Decoded frame: canvas with transparency (width/height = `rect` dimensions) and the rectangle it covers (plane coordinates) */
export interface StreamPicture { canvas: HTMLCanvasElement | OffscreenCanvas; rect: LayerRect }

/**
 * Vertically stitched frame (`rgba` is the full frame pixels, width `width`, height `total`) →
 * straight RGBA with transparency (width `width`, height `h`).
 * Color half is on top (premultiplied color), opacity is in red channel of bottom half, starting
 * from row `h + HALF_GAP_ROWS`. Clamp once to `rgb ≤ a` before dividing back to straight.
 */
export function composeHalves(rgba: Uint8ClampedArray | Uint8Array, width: number, total: number, h: number, out: Uint8ClampedArray = new Uint8ClampedArray(width * h * 4)): Uint8ClampedArray {
  const alphaTop = h + HALF_GAP_ROWS;
  if (alphaTop + h > total) throw new Error(tr("The stream frame is {0} high, which cannot fit two halves of {1} rows each", total, h));
  for (let y = 0; y < h; y++) {
    let c = y * width * 4, a = (alphaTop + y) * width * 4, o = y * width * 4;
    for (let x = 0; x < width; x++, c += 4, a += 4, o += 4) {
      const alpha = rgba[a];
      if (alpha === 0) { out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0; continue; }
      const r = Math.min(rgba[c], alpha), g = Math.min(rgba[c + 1], alpha), b = Math.min(rgba[c + 2], alpha);
      out[o] = Math.round((r * 255) / alpha);
      out[o + 1] = Math.round((g * 255) / alpha);
      out[o + 2] = Math.round((b * 255) / alpha);
      out[o + 3] = alpha;
    }
  }
  return out;
}

/** The decoded frame width matches this segment's rectangle width; throws on mismatch (caller does not crop or stretch) */
export function frameWidthOf(decodedWidth: number, rect: LayerRect, frame: number): number {
  if (decodedWidth !== rect.w) throw new Error(tr("Track stream frame {0} decoded to width {1}, which does not match the segment's rect width {2} in the manifest", frame, decodedWidth, rect.w));
  return rect.w;
}

/** Sequential decoder for a stream: fetch frames in ascending frame number order */
export class StreamFrameReader {
  private stream: ReadableStream;
  private deps: StreamFrameDeps;
  private signal?: AbortSignal;
  private blocks = new Map<string, Uint8Array>();
  private decoder: VideoDecoder | null = null;
  private seg = -1;
  private samples: SegmentSample[] = [];
  private segBytes: Uint8Array | null = null;
  private fed = 0;
  private flushed = false;
  private outputs = new Map<number, VideoFrame>();
  private failure: unknown = null;
  private wake: (() => void) | null = null;
  private scratch: HTMLCanvasElement | OffscreenCanvas | null = null;
  private outCanvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  readonly stats = { frames: 0, segments: 0, fetched: 0, bytes: 0, decodeMs: 0 };

  constructor(stream: ReadableStream, deps: StreamFrameDeps, signal?: AbortSignal) {
    this.stream = stream;
    this.deps = deps;
    this.signal = signal;
  }

  private async block(hash: string, keep: boolean): Promise<Uint8Array> {
    const hit = this.blocks.get(hash);
    if (hit) return hit;
    const base = this.deps.assetBase();
    if (!base) throw new Error(tr("There is no remote asset service yet"));
    const f = this.deps.fetch ?? fetch;
    const res = await f(`${base.replace(/\/+$/, "")}/px/${hash}`, { headers: await this.deps.authHeaders(), signal: this.signal });
    if (!res.ok) throw new Error(tr("Cannot fetch the bytes of the track stream {0}: {1}", hash.slice(0, 12), res.status));
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.stats.fetched++;
    this.stats.bytes += bytes.length;
    // There are only one or two head files for a stream, keep them; for segments, only keep the current one
    if (keep) this.blocks.set(hash, bytes);
    return bytes;
  }

  private closeDecoder() {
    for (const f of this.outputs.values()) { try { f.close(); } catch { /* Already closed */ } }
    this.outputs.clear();
    try { if (this.decoder && this.decoder.state !== "closed") this.decoder.close(); } catch { /* Already closed */ }
    this.decoder = null;
  }

  private async openSegment(n: number): Promise<void> {
    this.closeDecoder();
    const seg = this.stream.segments.get(n);
    const init = seg ? this.stream.inits.get(seg.init) : undefined;
    if (!seg || !init) throw new Error(tr("The track stream has no segment {0}", n));
    const [initBytes, segBytes] = await Promise.all([this.block(init.hash, true), this.block(seg.hash, false)]);
    const toBuffer = (b: Uint8Array) => (b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? b.buffer : b.slice().buffer) as ArrayBuffer;
    const config = parseInit(toBuffer(initBytes));
    this.samples = parseSegment(toBuffer(segBytes));
    this.segBytes = segBytes;
    this.fed = 0;
    this.flushed = false;
    this.failure = null;
    this.seg = n;
    const first = streamSegmentFirstFrame(n, this.stream.originFrame);
    const fps = this.stream.fps;
    const decoder = new VideoDecoder({
      output: (frame) => {
        // Timestamp = project frame number × 1e6 / fps; convert back to the sample index in this segment
        const idx = Math.round((frame.timestamp * fps) / 1e6) - first;
        const old = this.outputs.get(idx);
        if (old) { try { old.close(); } catch { /* Already closed */ } }
        this.outputs.set(idx, frame);
        this.wake?.();
      },
      error: (e) => { this.failure = e; this.wake?.(); },
    });
    decoder.configure({ codec: config.codec, description: config.description, optimizeForLatency: true } as VideoDecoderConfig);
    this.decoder = decoder;
    this.stats.segments++;
  }

  /** Wait for the decoder to output something (a frame comes out, an error occurs, or after a short while) */
  private pause(ms = 20): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { this.wake = null; clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  /**
   * Fetch the image of frame `frame` (project frame number). The caller guarantees this frame is in
   * a full-density segment (`streamCovers`)
   */
  async picture(frame: number): Promise<StreamPicture> {
    if (this.signal?.aborted) throw Object.assign(new Error(tr("Cancelled")), { cancelled: true });
    const t0 = performance.now();
    const n = streamSegmentOf(frame, this.stream.originFrame);
    const first = streamSegmentFirstFrame(n, this.stream.originFrame);
    const idx = frame - first;
    // Switched segment, or this frame was already fed and the image is not in hand (jumping backwards):
    // decode again from the keyframe of this segment
    if (n !== this.seg || !this.decoder || (idx < this.fed && !this.outputs.has(idx))) await this.openSegment(n);
    if (idx < 0 || idx >= this.samples.length) throw new Error(tr("Track stream segment {0} has no sample {1}", n, idx));
    const fps = this.stream.fps;
    const started = performance.now();
    while (!this.outputs.has(idx)) {
      if (this.signal?.aborted) throw Object.assign(new Error(tr("Cancelled")), { cancelled: true });
      if (this.failure) throw new Error(tr("Track stream decode error: {0}", String((this.failure as Error)?.message ?? this.failure)));
      if (performance.now() - started > DECODE_TIMEOUT_MS) throw new Error(tr("Track stream frame {0} was not decoded within {1} s", frame, DECODE_TIMEOUT_MS / 1000));
      const decoder = this.decoder!;
      // Not many frames accumulated in hand, and still samples left to feed: feed one more
      // (when the decoder has latency, multiple samples must be fed before it emits the earlier ones)
      if (this.fed < this.samples.length && this.outputs.size < 6 && decoder.decodeQueueSize < 2) {
        const s = this.samples[this.fed];
        decoder.decode(new EncodedVideoChunk({ type: s.isSync ? "key" : "delta", timestamp: chunkTimestamp(first + this.fed, fps),
          data: this.segBytes!.subarray(s.offset, s.offset + s.size) }));
        this.fed++;
        continue;
      }
      if (this.fed >= this.samples.length && !this.flushed) {
        // Finished feeding this whole segment and still waiting: flush once to emit everything buffered in
        // the decoder (after flushing, the next segment starts from a keyframe anyway)
        this.flushed = true;
        await decoder.flush();
        continue;
      }
      if (this.fed >= this.samples.length && this.flushed) throw new Error(tr("Track stream frame {0} cannot be decoded", frame));
      await this.pause();
    }
    // Frame images before this frame are no longer needed
    for (const [i, f] of this.outputs) if (i < idx) { try { f.close(); } catch { /* Already closed */ } this.outputs.delete(i); }
    const vf = this.outputs.get(idx)!;
    const seg = this.stream.segments.get(n)!;
    const rect = this.stream.inits.get(seg.init)!.rect;
    const width = vf.displayWidth || vf.codedWidth, total = vf.displayHeight || vf.codedHeight;
    // The decoded width should be the rectangle width of this segment (encoded according to the rectangle).
    // A mismatch indicates the manifest and bytes do not match: do not crop, do not stretch, throw an
    // error, do not export incorrect frames
    const w = frameWidthOf(width, rect, frame), h = rect.h;
    const make = (cw: number, ch: number) => {
      if (typeof document !== "undefined") { const c = document.createElement("canvas"); c.width = cw; c.height = ch; return c; }
      return new OffscreenCanvas(cw, ch);
    };
    if (!this.scratch || this.scratch.width !== width || this.scratch.height !== total) this.scratch = make(width, total);
    const sctx = this.scratch.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
    sctx.clearRect(0, 0, width, total);
    sctx.drawImage(vf, 0, 0, width, total);
    const raw = sctx.getImageData(0, 0, width, total).data;
    if (!this.outCanvas || this.outCanvas.width !== w || this.outCanvas.height !== h) this.outCanvas = make(w, h);
    const octx = this.outCanvas.getContext("2d") as CanvasRenderingContext2D;
    const image = octx.createImageData(w, h);
    if (w === width) composeHalves(raw, width, total, h, image.data);
    else {
      const full = composeHalves(raw, width, total, h);
      for (let y = 0; y < h; y++) image.data.set(full.subarray(y * width * 4, y * width * 4 + w * 4), y * w * 4);
    }
    octx.putImageData(image, 0, 0);
    this.stats.frames++;
    this.stats.decodeMs += performance.now() - t0;
    return { canvas: this.outCanvas, rect: { x: rect.x, y: rect.y, w, h } };
  }

  close(): void {
    this.closeDecoder();
    this.blocks.clear();
    this.segBytes = null;
    this.scratch = this.outCanvas = null;
  }
}
