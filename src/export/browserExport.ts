/**
 * Frame-by-frame export for online browser (`docs/plan/c10a-contract.md` Section 11.1; semantics in
 * `product/platforms.md` "Online browser" > "Export").
 *
 *   Capability probe → (ask once if no AAC) → pre-export check (original-size asset complete; card
 *   visual sources ready, `exportLayers.ts`; no timeout, cancellable) → prompt to stay in foreground
 *   → mix audio and encode AAC → frame-by-frame: composite one frame onto reused original-size canvas
 *   → `VideoEncoder.encode()` → `frame.close()` (`encodeQueueSize` not exceeding 3) → mux (`mp4Mux.ts`)
 *   and write out.
 *
 * Time is determined by frame index (`i / fps`, export page time-pinning method is identical to
 * `src/kernel/exportClock.ts`). Export only uses original size: original-size asset (export page
 * fetches by its URL and Range); small size is never used here.
 *
 * Two modes (user decision, 2026-10-13, choose between two when clicking export, `mode`):
 *   - **Full export** (`full`): cards runnable on this page are rendered frame-by-frame by the
 *     export page, regardless of whether normally classified as light or heavy (export is non-realtime;
 *     heavy cards are not suppressed and do not wait for prerender); cards not executed on this page
 *     (synced user cards and media effect cards) request render nodes to render frame-by-frame at
 *     original size before use, showing a waiting prompt if not fully ready;
 *   - **Fast export** (`fast`): sections with full-density track streams directly take visuals from
 *     the stream (for cards with streams throughout, the export page does not even mount components);
 *     sections with only sparse versions or no streams follow the full export approach.
 * [Cutoff] The pre-2026-10-13 approach (heavy cards taking saved HTML snapshots of each card frame by
 * frame, `originals.ts`) is no longer used by either mode; that code remains until the snapshot
 * removal phase to be deleted together.
 *
 * This layer is unaware of the editor: project, asset service, document service, prompts, and
 * confirmations are all injected by the caller (online branch of `exportVideo` in
 * `src/editor/io/index.ts`).
 */
import { assertProjectCardAudio } from "../audio/cardAudio";
import type { Project } from "../kernel/project";
import { audioPlanOf } from "../kernel/audioPlan.mjs";
import { renderMix, encodeWavFloat32, type MixPlan } from "../audio/renderMix";
import { MISSING_MATERIAL_WAV_URL, confirmedMissing, confirmedMissingAudio, missingMaterialAudibleDuration } from "../audio/missingMaterial";
import { awaitingUploaderMessage, type MissingOriginal } from "../render/mediaTier";
import { AUDIO_CHANNELS, AUDIO_SAMPLE_RATE, audioConfigOf, probeExportCapability, videoConfigOf, type EncoderEnv } from "./capability";
import { Mp4Muxer, type MuxSink } from "./mp4Mux";
import { ExportCompositor } from "./frameCompositor";
import type { ExportMode } from "./cardLayers";
import { prepareExportLayers, type ExportLayerDeps, type ExportLayerStats, type FrameLayers } from "./exportLayers";
import { ONLINE_EXPORT_TEXT } from "./text";
import { rgbaToI420 } from "./yuv";
import { resampleVarispeed } from "../kernel/clipTime.mjs";
import { tr } from "../i18n/index.ts";

/** Encoding queue upper limit (Section 11.1 of contract) */
export const MAX_ENCODE_QUEUE = 3;
/** Keyframe interval (seconds) */
export const KEYFRAME_SEC = 2;
/** How often to recheck when pre-export check fails */
export const PRECHECK_RETRY_MS = 3000;

export interface BrowserExportDeps {
  project: Project;
  sink: MuxSink;
  signal: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** Pre-export check failed: user-facing message (null = passed) */
  onWaiting?: (message: string | null) => void;
  confirm: (message: string) => boolean | Promise<boolean>;
  notify: (message: string, tone?: "info" | "warn") => void;
  /** Referenced original-size assets that are not yet complete (`exportGate` in C6.6) */
  checkMediaOriginals: () => Promise<MissingOriginal[]>;
  /** Export mode; omitted = full export */
  mode?: ExportMode;
  /**
   * Where to fetch ready-made sources for card visuals (document service, asset service, render queue);
   * null = always live render via export page (only for probes and desktop comparison: in this case,
   * cards not executed on this page have no visuals).
   */
  cardLayers: (ExportLayerDeps & { projectId: () => string | null }) | null;
  /**
   * Card clips not executed on this page (synced user cards and media effect cards: export page and
   * editor are same-origin, not executing their code).
   */
  nonRunnable?: () => string[];
  /**
   * Probe: called once after each frame is composited (for pixel-by-pixel check; canvas is reused,
   * copy immediately if retaining).
   */
  onFrame?: (frame: number, canvas: HTMLCanvasElement) => void | Promise<void>;
  /**
   * URL of original-size asset: replaced with remote asset service + read-only ticket on online
   * pages (`remoteMediaUrl` in `mediaTier.ts`).
   */
  mediaUrl?: (url: string) => string;
  /**
   * Current read-only ticket (renewed during export, Section 12 of C10 contract; `ticketRenewal.ts`):
   * swapped into asset URL before loading assets for each frame.
   */
  freshTicket?: () => string | null;
  /** Export page URL (constructed from current page by default) */
  exportUrl?: string;
  env?: EncoderEnv;
  /** Probe: export first n frames only */
  maxFrames?: number;
}

export interface BrowserExportResult {
  frames: number;
  bytes: number;
  audio: boolean;
  videoCodec: string;
  ms: number;
  stats: Record<string, number>;
  mode: ExportMode;
  /** Which ready-made sources were used for card visuals (null when `cardLayers` is not used) */
  layers: ExportLayerStats | null;
}

const cancelled = () => Object.assign(new Error(ONLINE_EXPORT_TEXT.cancelled), { cancelled: true });

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(cancelled());
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(cancelled()); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Pre-export check: proceed only after original-size assets have all arrived and ready-made
 * sources for card visuals are prepared; if incomplete, prompt and keep waiting without a timeout
 * (the user can cancel).
 * First wait for assets (re-check after a short interval), then prepare card visuals (for those
 * requesting the render node to render frame by frame, wait for rendering to finish;
 * `exportLayers.ts`). Returns the card visual sources (or null if none).
 */
async function precheck(deps: BrowserExportDeps, mode: ExportMode): Promise<FrameLayers | null> {
  for (;;) {
    if (deps.signal.aborted) throw cancelled();
    const media = await deps.checkMediaOriginals();
    if (!media.length) break;
    deps.onWaiting?.(awaitingUploaderMessage(media));
    await sleep(PRECHECK_RETRY_MS, deps.signal);
  }
  deps.onWaiting?.(null);
  if (!deps.cardLayers) return null;
  const layers = await prepareExportLayers({
    project: deps.project, projectId: deps.cardLayers.projectId(), mode, nonRunnable: deps.nonRunnable?.() ?? [],
    deps: deps.cardLayers, signal: deps.signal, onWaiting: (message) => deps.onWaiting?.(message),
  });
  deps.onWaiting?.(null);
  return layers;
}

/* ---------------- Audio ---------------- */

interface EncodedAudio { chunks: { data: Uint8Array; timestampUs: number; durationUs: number }[]; asc: Uint8Array }

/** Slice of an original-size asset trimmed along timeline → 48 kHz stereo float WAV (passed to `renderMix` as "trimmed wav") */
/**
 * Whether an ISO-BMFF (mp4 / mov) file has an audio track: check whether handler_type in `hdlr`
 * box is `soun`.
 * For non-ISO-BMFF files, return null (unknown, decode as usual; if decoding fails, fail export).
 * Desktop export uses ffprobe for the same purpose (`hasAudioStream` in `mux-audio.mjs`):
 * videos do not necessarily have an audio track; those without are excluded from the mix.
 */
export function isoHasSoundTrack(bytes: Uint8Array): boolean | null {
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(4, 8)) !== "ftyp") return null;
  for (let i = 4; i + 16 <= bytes.length; i++) {
    if (bytes[i] !== 0x68 || bytes[i + 1] !== 0x64 || bytes[i + 2] !== 0x6c || bytes[i + 3] !== 0x72) continue; // "hdlr"
    if (bytes[i + 12] === 0x73 && bytes[i + 13] === 0x6f && bytes[i + 14] === 0x75 && bytes[i + 15] === 0x6e) return true; // "soun"
  }
  return false;
}

async function sliceWav(source: ArrayBuffer, offset: number, dur: number, speed = 1): Promise<ArrayBuffer> {
  const ctx = new OfflineAudioContext(AUDIO_CHANNELS, 1, AUDIO_SAMPLE_RATE);
  const decoded = await ctx.decodeAudioData(source.slice(0));
  const from = Math.max(0, Math.floor(offset * AUDIO_SAMPLE_RATE));
  const n = Math.max(1, Math.ceil(dur * AUDIO_SAMPLE_RATE));
  const chans = Array.from({ length: AUDIO_CHANNELS }, (_, c) => {
    const src = decoded.getChannelData(Math.min(c, decoded.numberOfChannels - 1));
    // Speed-changed audio clip: sample asset with speed step factor (speed and pitch change,
    // same semantics as ffmpegVarispeed in both ffmpeg paths; kernel/clipTime.mjs)
    if (speed !== 1) return resampleVarispeed(src, from, speed, n);
    const out = new Float32Array(n);
    out.set(src.subarray(from, Math.min(src.length, from + n)));
    return out;
  });
  return encodeWavFloat32({ numberOfChannels: AUDIO_CHANNELS, length: n, sampleRate: AUDIO_SAMPLE_RATE, getChannelData: (c: number) => chans[c] } as unknown as AudioBuffer);
}

export async function encodeAudio(deps: BrowserExportDeps, durationSec: number): Promise<EncodedAudio | null> {
  const project = deps.project;
  assertProjectCardAudio(project);
  const all = audioPlanOf(project).filter((e: { start: number }) => e.start < durationSec);
  if (!all.length) return null;
  const byId = new Map(project.media.map((m) => [m.id, m]));
  // Fetch each original-size asset once (shared when referenced by multiple clips);
  // videos without audio tracks are excluded from the mix
  const sources = new Map<string, ArrayBuffer>();
  const entries: typeof all = [];
  for (const e of all) {
    const m = byId.get(e.mediaId);
    if (!m) continue;
    let bytes = sources.get(m.id);
    if (!bytes) {
      if (confirmedMissingAudio(m, project)) {
        const res = await fetch(MISSING_MATERIAL_WAV_URL, { signal: deps.signal });
        if (!res.ok) throw new Error(tr("Cannot read the built-in missing-media voice: HTTP {0}", res.status));
        bytes = await res.arrayBuffer();
      } else {
        const res = await fetch(deps.mediaUrl ? deps.mediaUrl(m.url) : m.url, { signal: deps.signal });
        if (!res.ok) throw new Error(tr("Cannot get the audio of {0}: HTTP {1}", m.name || m.id, res.status));
        bytes = await res.arrayBuffer();
      }
      sources.set(m.id, bytes);
    }
    if (!confirmedMissingAudio(m, project) && isoHasSoundTrack(new Uint8Array(bytes)) === false) continue;
    entries.push(e);
  }
  if (!entries.length) return null;
  const slices = new Map<string, { mediaId: string; offset: number; dur: number; speed?: number }>();
  const plan: MixPlan = {
    sampleRate: AUDIO_SAMPLE_RATE,
    duration: durationSec,
    clips: entries.map((e: { clipId: string; mediaId: string; start: number; dur: number; offset: number; volume: number; fadeIn: number; fadeOut: number; fx: MixPlan["clips"][number]["fx"]; env?: MixPlan["clips"][number]["env"]; speed?: number }, i: number) => {
      const m = byId.get(e.mediaId)!;
      const key = `pc-slice:${i}`;
      const missing = confirmedMissingAudio(m, project);
      slices.set(key, { mediaId: m.id, offset: missing ? 0 : e.offset, dur: missing ? missingMaterialAudibleDuration({ start: 0, end: e.dur }) : e.dur, ...(!missing && e.speed ? { speed: e.speed } : null) });
      return { clipId: e.clipId, url: key, start: e.start, dur: e.dur, volume: e.volume, fadeIn: e.fadeIn, fadeOut: e.fadeOut, fx: e.fx, ...(e.env ? { env: e.env } : null) };
    }),
  };
  const fetchSlice = (async (input: RequestInfo | URL) => {
    const s = slices.get(String(input));
    if (!s) throw new Error(tr("Unknown voice {0}", String(input)));
    return new Response(await sliceWav(sources.get(s.mediaId)!, s.offset, s.dur, s.speed ?? 1));
  }) as typeof fetch;
  const { buffer } = await renderMix(plan, fetchSlice);
  sources.clear();
  if (deps.signal.aborted) throw cancelled();

  const chunks: EncodedAudio["chunks"] = [];
  let asc: Uint8Array | null = null;
  let failure: unknown = null;
  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, timestampUs: chunk.timestamp, durationUs: chunk.duration ?? (1024 * 1e6) / AUDIO_SAMPLE_RATE });
      const d = meta?.decoderConfig?.description;
      if (d && !asc) asc = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array((d as ArrayBufferView).buffer.slice((d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteOffset + (d as ArrayBufferView).byteLength));
    },
    error: (e) => { failure = e; },
  });
  encoder.configure(audioConfigOf() as unknown as AudioEncoderConfig);
  const FRAMES = 4096;
  const planes = Array.from({ length: AUDIO_CHANNELS }, (_, c) => buffer.getChannelData(c));
  for (let at = 0; at < buffer.length; at += FRAMES) {
    if (deps.signal.aborted) { encoder.close(); throw cancelled(); }
    const n = Math.min(FRAMES, buffer.length - at);
    const data = new Float32Array(n * AUDIO_CHANNELS);
    for (let c = 0; c < AUDIO_CHANNELS; c++) data.set(planes[c].subarray(at, at + n), c * n);
    const ad = new AudioData({ format: "f32-planar", sampleRate: AUDIO_SAMPLE_RATE, numberOfFrames: n, numberOfChannels: AUDIO_CHANNELS, timestamp: Math.round((at * 1e6) / AUDIO_SAMPLE_RATE), data });
    encoder.encode(ad);
    ad.close();
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;
  if (!asc) throw new Error(tr("The AAC encoder did not provide an AudioSpecificConfig"));
  return { chunks, asc };
}

/* ---------------- Main workflow ---------------- */

export async function runBrowserExport(deps: BrowserExportDeps): Promise<BrowserExportResult> {
  const t0 = performance.now();
  const project = deps.project;
  const fps = Math.max(1, project.fps || 30);
  const total = Math.max(1, Math.min(deps.maxFrames ?? Infinity, Math.floor(project.duration * fps)));
  const durationSec = total / fps;

  const cap = await probeExportCapability({ width: project.width, height: project.height, fps }, deps.env);
  if (!cap.ok || !cap.videoCodec) throw new Error(cap.message || ONLINE_EXPORT_TEXT.unsupportedSize);
  assertProjectCardAudio(project);
  const wantsAudio = audioPlanOf(project).some((e: { start: number }) => e.start < durationSec);
  if (wantsAudio && !cap.audio && !(await deps.confirm(ONLINE_EXPORT_TEXT.noAudio))) throw cancelled();

  const mode: ExportMode = deps.mode === "fast" ? "fast" : "full";
  const layers = await precheck(deps, mode);
  deps.notify(ONLINE_EXPORT_TEXT.start, "info");

  let audio: EncodedAudio | null = null;
  try {
    audio = wantsAudio && cap.audio ? await encodeAudio(deps, durationSec) : null;
  } catch (e) {
    layers?.close();
    throw e;
  }

  const exportProject: Project = deps.mediaUrl
    // Keep asset URLs marked "confirmed missing" as-is: placeholder checks match record and asset URLs
    // verbatim; replacing with remote fetch URLs invalidates placeholder and decodes nonexistent file
    ? { ...project, media: project.media.map((m) => (confirmedMissing(m) ? m : { ...m, url: m.url ? deps.mediaUrl!(m.url) : m.url })) }
    : project;
  let compositor: ExportCompositor;
  try {
    compositor = await ExportCompositor.open({ project: exportProject, exportUrl: deps.exportUrl, layers, signal: deps.signal, freshTicket: deps.freshTicket });
  } catch (e) {
    layers?.close();
    throw e;
  }

  let muxer: Mp4Muxer | null = null;
  let failure: unknown = null;
  const pendingVideo: { data: Uint8Array; timestampUs: number; key: boolean }[] = [];
  const encoder = new VideoEncoder({
    output: (chunk, meta) => {
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      if (!muxer) {
        const d = meta?.decoderConfig?.description;
        if (!d) { pendingVideo.push({ data, timestampUs: chunk.timestamp, key: chunk.type === "key" }); return; }
        const avcC = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0)) : new Uint8Array((d as ArrayBufferView).buffer.slice((d as ArrayBufferView).byteOffset, (d as ArrayBufferView).byteOffset + (d as ArrayBufferView).byteLength));
        muxer = new Mp4Muxer({
          sink: deps.sink,
          video: { codec: cap.videoCodec!, width: project.width, height: project.height, fps, avcC },
          audio: audio ? { codec: "mp4a.40.2", sampleRate: AUDIO_SAMPLE_RATE, channels: AUDIO_CHANNELS, asc: audio.asc } : null,
        });
        // Write audio first (small chunks, already encoded): in mdat audio comes first and video follows,
        // each recording its own offset table
        for (const a of audio?.chunks ?? []) muxer.addAudioChunk(a.data, { timestampUs: a.timestampUs, durationUs: a.durationUs });
        for (const v of pendingVideo.splice(0)) muxer.addVideoChunk(v.data, { timestampUs: v.timestampUs, key: v.key });
      }
      muxer.addVideoChunk(data, { timestampUs: chunk.timestamp, key: chunk.type === "key" });
    },
    error: (e) => { failure = e; },
  });
  encoder.configure(videoConfigOf(cap.videoCodec, project.width, project.height, fps) as unknown as VideoEncoderConfig);

  const waitQueue = async () => {
    while (encoder.encodeQueueSize > MAX_ENCODE_QUEUE - 1) {
      await new Promise<void>((resolve) => {
        const done = () => { encoder.removeEventListener("dequeue", done); resolve(); };
        encoder.addEventListener("dequeue", done);
        setTimeout(done, 50);
      });
      if (failure) throw failure;
    }
  };

  try {
    const keyEvery = Math.max(1, Math.round(KEYFRAME_SEC * fps));
    // Original-size canvas → I420 (BT.601 limited range, same conversion as desktop export, see `yuv.ts`); buffer reused
    let i420: Uint8Array | undefined;
    const colorSpace = { primaries: "smpte170m", transfer: "smpte170m", matrix: "smpte170m", fullRange: false } as VideoColorSpaceInit;
    for (let i = 0; i < total; i++) {
      if (deps.signal.aborted) throw cancelled();
      if (failure) throw failure;
      const canvas = await compositor.frame(i);
      await deps.onFrame?.(i, canvas);
      await waitQueue();
      const pixels = canvas.getContext("2d")!.getImageData(0, 0, project.width, project.height).data;
      i420 = rgbaToI420(pixels, project.width, project.height, i420);
      const frame = new VideoFrame(i420, { format: "I420", codedWidth: project.width, codedHeight: project.height,
        timestamp: Math.round((i * 1e6) / fps), duration: Math.round(1e6 / fps), colorSpace });
      try { encoder.encode(frame, { keyFrame: i % keyEvery === 0 }); } finally { frame.close(); }
      deps.onProgress?.(i + 1, total);
    }
    await encoder.flush();
    if (failure) throw failure;
    if (!muxer) throw new Error(tr("The encoder produced no frames"));
    const bytes = await (muxer as Mp4Muxer).finalize();
    // Tear down compositor first (along with card visual sources): stats like decode time and
    // bytes fetched settle only upon teardown
    compositor.close();
    return { frames: total, bytes, audio: !!audio, videoCodec: cap.videoCodec, ms: performance.now() - t0, stats: { ...compositor.stats }, mode, layers: layers ? { ...layers.stats } : null };
  } finally {
    try { if (encoder.state !== "closed") encoder.close(); } catch { /* Already closed */ }
    compositor.close();
  }
}
