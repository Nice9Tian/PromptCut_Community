/**
 * Browser-side generation of track streams: encode a card's frame-by-frame output into track
 * stream segments using the browser's built-in encoder (WebCodecs `VideoEncoder`).
 *
 * Semantics: `docs/plan/render-standard.md` "Prerender output" (user decision, 2026-10-09: online
 * browsers must also be able to generate and play track streams; cards whose visuals are
 * inherently expensive are streamed directly into H.264, without storing images). The server-side
 * path is in `server/frame-stream.mjs` (using ffmpeg); the byte format output here has the same
 * shape as that, playable by `streamPlayer.ts` without changes.
 *
 * # How frames are packed (same as `streamFilter` in `server/bakery/ffmpeg.mjs`)
 *
 *   Card frame W × H (even) → encoded frame W × (2H + 16):
 *     Rows 0 to H    Color half, stores **premultiplied color** (transparent areas are pure black)
 *     Rows H to H+8  Black
 *     Rows H+8 to 2H+8 Alpha half, alpha stored as grayscale
 *     Rows 2H+8 to 2H+16 Black
 *
 * # Segmentation
 *
 *   One segment every `SEGMENT_FRAMES` frames, starting with a keyframe; each completed segment is
 *   packaged into `moof + mdat` and delivered, without accumulating the entire stream (streaming).
 *   No B-frames produced: samples exit in the order they entered; an error is raised if the order
 *   mismatches, avoiding writing out-of-order streams.
 *
 * This layer belongs to render: does not import editor; only handles "frames → segment bytes",
 * leaving where to publish and which manifest to record in up to the caller.
 */
import { buildStreamInit, buildStreamSegment, codecOfAvcC, type MuxSample } from "./streamMux.ts";
import { SEGMENT_FRAMES } from "./streamPlayer.ts";

/**
 * Number of black padding rows padded under each half (matches `pad=iw:ih+8` in the ffmpeg filter)
 */
export const STREAM_HALF_PAD = 8;

/** Width and height of the encoded frame */
export function packedSize(width: number, height: number): { width: number; height: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error(`Track stream: width and height must be positive integers, got ${width}×${height}`);
  if (width % 2 || height % 2) throw new Error(`Track stream: width and height must be even (4:2:0 sampling), got ${width}×${height}`);
  return { width, height: 2 * height + 2 * STREAM_HALF_PAD };
}

/**
 * H.264 level is chosen based on the pixel count of the encoded frame (High profile). 4.0 only
 * goes up to 1920×1088; a full 1080p packed frame is 1920×2176, requiring 5.0. The level actually
 * written into the bitstream by the browser is governed by `decoderConfig.description`
 * (`codecOfAvcC`); this is only to ensure the config passes capability queries.
 */
export function avcCodecFor(packedWidth: number, packedHeight: number): string {
  const px = packedWidth * packedHeight;
  const level = px <= 414720 ? 0x1e : px <= 921600 ? 0x1f : px <= 2088960 ? 0x28 : px <= 5652480 ? 0x32 : px <= 9437184 ? 0x33 : 0x34;
  return `avc1.6400${level.toString(16).padStart(2, "0")}`;
}

/**
 * Bitrate is set based on pixels: roughly 0.2 bits per pixel per frame, not lower than 1 Mbps.
 * Not used when quantization mode is available (see `openStreamEncoder`).
 */
export function streamBitrateFor(packedWidth: number, packedHeight: number, fps: number): number {
  return Math.max(1_000_000, Math.round(packedWidth * packedHeight * fps * 0.2));
}

/**
 * Minimal shape of a 2D canvas: in browsers, the 2D context of `OffscreenCanvas` /
 * `HTMLCanvasElement`
 */
interface Ctx2D {
  globalCompositeOperation: string;
  fillStyle: unknown;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void;
}

/**
 * Draws one frame of card visuals into a vertically packed encoded frame.
 *
 * - Color half: drawn once over a black background using standard compositing. "source color ×
 *   alpha" on a black background is precisely premultiplied color; transparent areas are pure
 *   black.
 * - Alpha half: first draw the source image onto the scratch canvas, then fill with white using
 *   `source-in`: yields "white × source alpha"; drawing this onto a black background makes
 *   grayscale equal to alpha.
 *
 * @param packed  2D context of the encoded frame (width W, height 2H+16)
 * @param scratch 2D context of the scratch canvas (width W, height H), reused by the caller
 * @param scratchCanvas The scratch canvas itself (to be drawn back as an image source)
 */
export function drawPackedFrame(packed: Ctx2D, scratch: Ctx2D, scratchCanvas: unknown, source: unknown, width: number, height: number): void {
  const total = 2 * height + 2 * STREAM_HALF_PAD;
  packed.globalCompositeOperation = "source-over";
  packed.fillStyle = "#000";
  packed.fillRect(0, 0, width, total);
  packed.drawImage(source, 0, 0, width, height);

  scratch.globalCompositeOperation = "source-over";
  scratch.clearRect(0, 0, width, height);
  scratch.drawImage(source, 0, 0, width, height);
  scratch.globalCompositeOperation = "source-in";
  scratch.fillStyle = "#fff";
  scratch.fillRect(0, 0, width, height);
  scratch.globalCompositeOperation = "source-over";
  packed.drawImage(scratchCanvas, 0, height + STREAM_HALF_PAD, width, height);
}

export interface StreamSegmentOut {
  /**
   * Segment index: the first frame of this segment is frame `index × SEGMENT_FRAMES` of the entire
   * stream
   */
  index: number;
  /** `moof + mdat` */
  bytes: Uint8Array;
  /** Number of samples in this segment (the last segment may not be full) */
  samples: number;
}

export interface StreamInitOut {
  /** `ftyp + moov` */
  bytes: Uint8Array;
  /**
   * Codec string constructed from bitstream `avcC` (what `inits[..].codec` in the manifest expects)
   */
  codec: string;
  /** Width and height of the encoded frame (packed) */
  width: number;
  height: number;
}

export interface StreamEncoderOptions {
  /** Width and height of the card frame (even numbers) */
  width: number;
  height: number;
  fps: number;
  /** Which segment to start encoding this stream from (for resuming); defaults to 0 */
  firstSegment?: number;
  /**
   * `no-preference` / `prefer-hardware` / `prefer-software`; defaults to letting the browser decide
   */
  hardwareAcceleration?: "no-preference" | "prefer-hardware" | "prefer-software";
  /**
   * Quantization parameter per frame in quantization mode (smaller is clearer); defaults to 20,
   * on the same scale as crf / cq 16 in the ffmpeg pipeline
   */
  quantizer?: number;
  /** Called once when the initialization segment is produced (after the first frame is encoded) */
  onInit(init: StreamInitOut): void | Promise<void>;
  /** Called once per segment encoded, in ascending order of segment index */
  onSegment(segment: StreamSegmentOut): void | Promise<void>;
  /** For testing: replaces the encoder and canvas constructors */
  env?: Partial<StreamEncodeEnv>;
}

/**
 * Browser capabilities used by this layer, gathered here so unit tests can replace them entirely
 */
export interface StreamEncodeEnv {
  VideoEncoder: any;
  VideoFrame: any;
  createCanvas(width: number, height: number): { getContext(kind: "2d", opts?: unknown): Ctx2D | null };
}

function defaultEnv(): StreamEncodeEnv {
  const g = globalThis as any;
  return {
    VideoEncoder: g.VideoEncoder,
    VideoFrame: g.VideoFrame,
    createCanvas: (w, h) => new g.OffscreenCanvas(w, h),
  };
}

/**
 * Queries whether each of a set of encoding configs is supported: returns an array with the same
 * length as `configs`; returns null if unable to query (no Worker, failed to start, no encoder
 * inside, or timed out)
 */
export type ConfigSupportAsker = (configs: Record<string, unknown>[]) => Promise<boolean[] | null>;

/**
 * Snippet running inside the Worker: queries `VideoEncoder.isConfigSupported` one by one and
 * returns a boolean array; returns null if there is no encoder inside the Worker
 */
const PROBE_WORKER_SOURCE = `self.onmessage = async (ev) => {
  if (typeof VideoEncoder !== "function") { self.postMessage(null); return; }
  const out = [];
  for (const c of ev.data) { try { const r = await VideoEncoder.isConfigSupported(c); out.push(!!(r && r.supported)); } catch (e) { out.push(false); } }
  self.postMessage(out);
};`;
const PROBE_WORKER_TIMEOUT_MS = 5000;

/**
 * Query inside a Worker whether the encoder supports these configurations.
 * `VideoEncoder.isConfigSupported` is an asynchronous interface, but the thread where this page
 * calls it for the first time will be occupied for 50-120 ms (measured: in Chrome without hardware
 * acceleration, on a 1920×1080 frame, the main thread experiences a 115 ms long task; measured at
 * 53-57 ms in online pages). Browser nodes probe inside the main document of the editor page,
 * and this probe falls squarely within the "no long tasks in main document while generating
 * snapshots" time window (M7-A12 in `m7-contract.md`). Asking inside a Worker yields the same
 * result while leaving the main thread unaffected; configuring the encoder and compressing
 * frame-by-frame on the main thread afterwards has no long tasks (from the same benchmark).
 * Workers start from a blob URL (permitted by both editor page and stage Content Security
 * Policies). If any step fails, return null, and the caller falls back to querying on this thread.
 */
export const askConfigSupportInWorker: ConfigSupportAsker = (configs) => {
  const g = globalThis as any;
  if (typeof g.Worker !== "function" || typeof g.Blob !== "function" || typeof g.URL?.createObjectURL !== "function") return Promise.resolve(null);
  return new Promise<boolean[] | null>((resolve) => {
    let worker: any = null, url = "", timer: unknown = null, settled = false;
    const finish = (v: boolean[] | null) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer as ReturnType<typeof setTimeout>);
      try { worker?.terminate(); } catch { /* Already stopped */ }
      try { if (url) g.URL.revokeObjectURL(url); } catch { /* Fine even if it cannot be revoked */ }
      resolve(v);
    };
    try {
      url = g.URL.createObjectURL(new g.Blob([PROBE_WORKER_SOURCE], { type: "text/javascript" }));
      worker = new g.Worker(url);
      worker.onmessage = (ev: { data: unknown }) => {
        const d = ev.data;
        finish(Array.isArray(d) && d.length === configs.length ? d.map((x) => x === true) : null);
      };
      worker.onerror = () => finish(null);
      timer = setTimeout(() => finish(null), PROBE_WORKER_TIMEOUT_MS);
      worker.postMessage(configs);
    } catch {
      finish(null);
    }
  });
};

/**
 * Whether this browser can encode this kind of frame; if so, returns the configuration to actually
 * use. When using the browser's own encoder (without an injected `env.VideoEncoder`), query in a
 * Worker first (`askConfigSupportInWorker`, without blocking the main thread); only query on this
 * thread if that is unavailable; passing null for `askOffThread` queries only on this thread,
 * while passing a function replaces it (for testing).
 */
export async function probeStreamEncoder(o: { width: number; height: number; fps: number; hardwareAcceleration?: StreamEncoderOptions["hardwareAcceleration"]; env?: Partial<StreamEncodeEnv>;
  askOffThread?: ConfigSupportAsker | null }): Promise<{ supported: boolean; config?: Record<string, unknown>; mode?: "quantizer" | "variable"; reason?: string }> {
  const env = { ...defaultEnv(), ...o.env };
  if (typeof env.VideoEncoder !== "function" || typeof env.VideoFrame !== "function") return { supported: false, reason: "This browser has no VideoEncoder" };
  const size = packedSize(o.width, o.height);
  const base = {
    codec: avcCodecFor(size.width, size.height),
    width: size.width,
    height: size.height,
    framerate: o.fps,
    avc: { format: "avc" },                 // Samples use length prefixes, parameter sets go into description (avcC)
    latencyMode: "quality",
    ...(o.hardwareAcceleration ? { hardwareAcceleration: o.hardwareAcceleration } : {}),
  };
  // Prefer encoding with fixed quantization (visual quality does not drop with content complexity);
  // fall back to bitrate if unsupported by the browser
  const modes = [["quantizer", { bitrateMode: "quantizer" }], ["variable", { bitrateMode: "variable", bitrate: streamBitrateFor(size.width, size.height, o.fps) }]] as const;
  const unsupported = { supported: false, reason: `This browser cannot encode H.264 at ${size.width}×${size.height}` };
  const ask = o.askOffThread === undefined ? (o.env?.VideoEncoder === undefined ? askConfigSupportInWorker : null) : o.askOffThread;
  if (ask) {
    let answers: boolean[] | null = null;
    try { answers = await ask(modes.map(([, extra]) => ({ ...base, ...extra }))); } catch { answers = null; }
    if (answers) {
      const i = answers.findIndex((x) => x === true);
      return i >= 0 ? { supported: true, config: { ...base, ...modes[i][1] }, mode: modes[i][0] } : unsupported;
    }
  }
  for (const [mode, extra] of modes) {
    const config = { ...base, ...extra };
    try {
      const r = await env.VideoEncoder.isConfigSupported(config);
      if (r?.supported) return { supported: true, config, mode };
    } catch { /* Mode unsupported, try the next one */ }
  }
  return unsupported;
}

export interface StreamEncoder {
  /**
   * Submits the next frame (in order, starting from frame `firstSegment × SEGMENT_FRAMES`). `source`
   * is anything accepted by `drawImage`
   */
  add(source: unknown): Promise<void>;
  /**
   * Finish encoding: deliver any incomplete final segment as well, and close the encoder. Returns
   * total frame count and mode used
   */
  finish(): Promise<{ frames: number; segments: number; mode: "quantizer" | "variable"; codec: string }>;
  /** Error or discarded: close directly without delivering anything further */
  abort(): void;
}

/**
 * Opens a track stream encoder. Frames are passed to `add()` in order, and each completed segment
 * is delivered via `onSegment`.
 *
 * Backpressure: `add()` waits when more than 3 frames are queued in the encoder (the same number
 * as the export pipeline); callers that `await` it will not bloat memory.
 */
export async function openStreamEncoder(opts: StreamEncoderOptions): Promise<StreamEncoder> {
  const env = { ...defaultEnv(), ...opts.env };
  const { width, height, fps } = opts;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("Track stream: frame rate required");
  const size = packedSize(width, height);
  const probe = await probeStreamEncoder({ width, height, fps, hardwareAcceleration: opts.hardwareAcceleration, env });
  if (!probe.supported || !probe.config || !probe.mode) throw new Error(probe.reason ?? "Track stream: this browser cannot encode");
  const mode = probe.mode;
  const quantizer = Number.isFinite(opts.quantizer) ? Math.max(0, Math.min(51, Math.round(opts.quantizer as number))) : 20;

  const packedCanvas = env.createCanvas(size.width, size.height);
  const scratchCanvas = env.createCanvas(width, height);
  const packed = packedCanvas.getContext("2d", { alpha: false });
  const scratch = scratchCanvas.getContext("2d");
  if (!packed || !scratch) throw new Error("Track stream: could not get a 2D canvas");

  const firstSegment = Math.max(0, Math.floor(opts.firstSegment ?? 0));
  let fed = 0;                       // Number of frames submitted to the encoder
  let out = 0;                       // Number of samples returned by the encoder
  let segments = 0;
  let pending: MuxSample[] = [];
  let avcC: Uint8Array | null = null;
  let initSent = false;
  let lastTimestamp = -1;
  let failure: Error | null = null;
  let closed = false;
  /**
   * Deliveries are chained: segments must be delivered in order, and `onSegment` may be
   * asynchronous (upload)
   */
  let delivery: Promise<void> = Promise.resolve();

  const fail = (err: unknown) => { if (!failure) failure = err instanceof Error ? err : new Error(String(err)); };

  const flushSegment = () => {
    if (!pending.length) return;
    const samples = pending;
    pending = [];
    const index = firstSegment + segments;
    segments += 1;
    const description = avcC;
    delivery = delivery.then(async () => {
      if (failure) return;
      if (!description) throw new Error("Track stream: the encoder did not provide a parameter set (avcC)");
      if (!initSent) {
        initSent = true;
        await opts.onInit({ bytes: buildStreamInit({ width: size.width, height: size.height, fps: Math.round(fps), avcC: description }), codec: codecOfAvcC(description), width: size.width, height: size.height });
      }
      await opts.onSegment({ index, bytes: buildStreamSegment({ sequence: index + 1, baseDecodeTime: index * SEGMENT_FRAMES, samples }), samples: samples.length });
    }).catch(fail);
  };

  const encoder = new env.VideoEncoder({
    output: (chunk: any, meta: any) => {
      try {
        const desc = meta?.decoderConfig?.description;
        if (desc && !avcC) avcC = desc instanceof Uint8Array ? new Uint8Array(desc) : new Uint8Array(desc as ArrayBuffer);
        // No B-frames produced: output order matches input order. Decreasing timestamps indicate the
        // encoder reordered frames; players cannot fetch frames from such streams by "sample index"
        if (chunk.timestamp <= lastTimestamp) throw new Error("Track stream: the encoder reordered frames (B-frames appeared), this stream is unusable");
        lastTimestamp = chunk.timestamp;
        const isSync = chunk.type === "key";
        const at = out % SEGMENT_FRAMES;
        if (at === 0 && !isSync) throw new Error(`Track stream: sample ${out} should be a keyframe`);
        const data = new Uint8Array(chunk.byteLength);
        chunk.copyTo(data);
        pending.push({ data, isSync });
        out += 1;
        if (pending.length === SEGMENT_FRAMES) flushSegment();
      } catch (err) { fail(err); }
    },
    error: (err: unknown) => fail(err),
  });
  encoder.configure(probe.config);

  const close = () => { if (!closed) { closed = true; try { encoder.close(); } catch { /* Already closed */ } } };

  return {
    async add(source) {
      if (closed) throw new Error("Track stream: the encoder is already closed");
      if (failure) { close(); throw failure; }
      drawPackedFrame(packed, scratch, scratchCanvas, source, width, height);
      // Timestamps are given as "frame index within this stream" (counted from the stream's own first
      // frame, not the project frame number); they only govern internal ordering inside the encoder,
      // while the player assigns its own timestamps by project frame number upon decoding
      // (`chunkTimestamp` in `streamPlayer.ts`), ignoring what is written here
      const streamFrame = firstSegment * SEGMENT_FRAMES + fed;
      const frame = new env.VideoFrame(packedCanvas, { timestamp: Math.round((streamFrame * 1e6) / fps), duration: Math.round(1e6 / fps) });
      try {
        encoder.encode(frame, { keyFrame: fed % SEGMENT_FRAMES === 0, ...(mode === "quantizer" ? { avc: { quantizer } } : {}) });
      } finally {
        frame.close();
      }
      fed += 1;
      while (!failure && encoder.encodeQueueSize > 3) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (failure) { close(); throw failure; }
    },
    async finish() {
      if (closed) throw failure ?? new Error("Track stream: the encoder is already closed");
      try {
        await encoder.flush();
        flushSegment();
        await delivery;
      } catch (err) { fail(err); }
      close();
      if (failure) throw failure;
      if (out !== fed) throw new Error(`Track stream: fed ${fed} frames, only ${out} samples came out`);
      return { frames: fed, segments, mode, codec: avcC ? codecOfAvcC(avcC) : String(probe.config!.codec) };
    },
    abort() {
      fail(new Error("Track stream: canceled"));
      close();
    },
  };
}
