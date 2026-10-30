/**
 * 在线浏览器的逐帧导出(`docs/plan/c10a-contract.md` 第 11.1 节;语义 `product/platforms.md`「在线浏览器」的「导出」)。
 *
 *   能力探测 → (没有 AAC 就先问一次)→ 导出前核对(素材原尺寸 complete;卡片画面的来源备齐,`exportLayers.ts`;不设超时,可取消)
 *   → 提示保持前台 → 混音并编 AAC → 逐帧:合成一帧到复用的原尺寸画布 → `VideoEncoder.encode()` → `frame.close()`
 *   (`encodeQueueSize` 不超过 3)→ 封装(`mp4Mux.ts`)写出。
 *
 * 时间按帧号定(`i / fps`,导出页的钉时间办法同 `src/kernel/exportClock.ts`)。导出只用原尺寸:素材原尺寸(导出页按它的地址、
 * Range 取);小尺寸在这里一张都不用。
 *
 * 分两种方式(用户 2026-10-13 定,点导出时二选一,`mode`):
 *   - **完整导出**(`full`):本页能运行的卡由导出页逐帧渲,不管它平时判轻判重(导出不是实时的,重卡这时不抑制、不等预渲染);
 *     本页不执行的卡(同步来的用户卡与素材效果卡)导出开始时请渲染节点按原尺寸逐帧渲好再用,没到齐时提示等待;
 *   - **快速导出**(`fast`):有满密度轨道流的那一段直接取流里的画面(整段都有流的卡导出页连组件都不挂);只有稀疏版或没有流的那一段
 *     照完整导出的办法出。
 * 〔分界〕2026-10-13 之前的做法(重卡逐帧取每张卡存好的 HTML 快照,`originals.ts`)两种方式都不再走;那份代码留到撤快照那一块一并删。
 *
 * 这一层不认识编辑器:项目、素材服务、文档服务、提示、确认都由调用方(`src/editor/io/index.ts` 的 `exportVideo` 在线分支)注入。
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

/** 编码队列上限(契约第 11.1 节) */
export const MAX_ENCODE_QUEUE = 3;
/** 关键帧间隔(秒) */
export const KEYFRAME_SEC = 2;
/** 导出前核对没过时,多久再核一次 */
export const PRECHECK_RETRY_MS = 3000;

export interface BrowserExportDeps {
  project: Project;
  sink: MuxSink;
  signal: AbortSignal;
  onProgress?: (done: number, total: number) => void;
  /** 导出前核对没过:给用户看的话(null = 过了) */
  onWaiting?: (message: string | null) => void;
  confirm: (message: string) => boolean | Promise<boolean>;
  notify: (message: string, tone?: "info" | "warn") => void;
  /** 被引用的素材原尺寸里还没 complete 的(C6.6 的 `exportGate`) */
  checkMediaOriginals: () => Promise<MissingOriginal[]>;
  /** 导出方式;不给 = 完整导出 */
  mode?: ExportMode;
  /**
   * 卡片画面的现成来源从哪取(文档服务、素材服务、渲染任务队列);null = 一律由导出页活渲(只给探针与桌面对照:
   * 这时本页不执行的卡没有画面)。
   */
  cardLayers: (ExportLayerDeps & { projectId: () => string | null }) | null;
  /** 本页不执行的卡片段(同步来的用户卡与素材效果卡:导出页与编辑页面同源,不执行它们的代码) */
  nonRunnable?: () => string[];
  /** 探针:每合成完一帧调一次(逐像素核对用;画布是复用的,要留就当场拷走) */
  onFrame?: (frame: number, canvas: HTMLCanvasElement) => void | Promise<void>;
  /** 素材原尺寸的地址:在线页面换成远程素材服务 + 只读票据(`mediaTier.ts` 的 `remoteMediaUrl`) */
  mediaUrl?: (url: string) => string;
  /** 当前的只读票据(导出途中续签,C10 契约第 12 节;`ticketRenewal.ts`):每一帧装素材前换进素材地址 */
  freshTicket?: () => string | null;
  /** 导出页地址(缺省按当前页面拼) */
  exportUrl?: string;
  env?: EncoderEnv;
  /** 探针:只导前 n 帧 */
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
  /** 卡片画面取了哪些现成的来源(没用 `cardLayers` 时为 null) */
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
 * 导出前核对:素材原尺寸到齐、卡片画面的现成来源备齐才往下走;不齐就提示、接着等,不设超时(用户可以取消)。
 * 先等素材(隔一会儿再核一次),再备卡片画面(要请渲染节点逐帧渲的,等它渲完;`exportLayers.ts`)。回卡片画面的来源(没有就 null)。
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

/* ---------------- 音频 ---------------- */

interface EncodedAudio { chunks: { data: Uint8Array; timestampUs: number; durationUs: number }[]; asc: Uint8Array }

/** 一段素材原尺寸按时间轴裁出来的那一截 → 48 kHz 立体声浮点 WAV(给 `renderMix` 当「裁好的 wav」) */
/**
 * ISO-BMFF(mp4 / mov)文件里有没有声音轨:找 `hdlr` 盒的 handler_type 是不是 `soun`。
 * 不是 ISO-BMFF 的回 null(不知道,照常解;解不出就让导出失败)。桌面导出用 ffprobe 做同一件事(`mux-audio.mjs` 的 `hasAudioStream`):
 * 视频不一定有声轨,没有的不进混音。
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
    // 变速的声音段:素材按 speed 倍步进取样(变速变调,和 ffmpeg 两条路的 ffmpegVarispeed 同一个语义;kernel/clipTime.mjs)
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
  // 每份素材原尺寸取一次(同一份被好几段引用时共用);没有声音轨的视频不进混音
  const sources = new Map<string, ArrayBuffer>();
  const entries: typeof all = [];
  for (const e of all) {
    const m = byId.get(e.mediaId);
    if (!m) continue;
    let bytes = sources.get(m.id);
    if (!bytes) {
      if (confirmedMissingAudio(m, project)) {
        const res = await fetch(MISSING_MATERIAL_WAV_URL, { signal: deps.signal });
        if (!res.ok) throw new Error(`内置缺失素材人声无法读取:HTTP ${res.status}`);
        bytes = await res.arrayBuffer();
      } else {
        const res = await fetch(deps.mediaUrl ? deps.mediaUrl(m.url) : m.url, { signal: deps.signal });
        if (!res.ok) throw new Error(`${m.name || m.id} 的声音取不到:HTTP ${res.status}`);
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
    if (!s) throw new Error(`不认识的声音 ${String(input)}`);
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
  if (!asc) throw new Error("AAC 编码器没给出 AudioSpecificConfig");
  return { chunks, asc };
}

/* ---------------- 主流程 ---------------- */

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
    // 认定过「确认缺失」的素材地址原样留着:占位核对的是记录与素材的地址逐字相同,换成远程取回地址占位就失效、转去解一个不存在的文件
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
        // 音频先写(块小、已经编好了):mdat 里音频在前、视频在后,偏移表各记各的
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
    // 原尺寸画布 → I420(BT.601 有限范围,和桌面导出同一个换算,见 `yuv.ts`);缓冲复用
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
    if (!muxer) throw new Error("编码器一帧都没给出");
    const bytes = await (muxer as Mp4Muxer).finalize();
    // 先收掉合成器(连同卡片画面的来源):解码用时、取了多少字节这几项统计在收的时候才落定
    compositor.close();
    return { frames: total, bytes, audio: !!audio, videoCodec: cap.videoCodec, ms: performance.now() - t0, stats: { ...compositor.stats }, mode, layers: layers ? { ...layers.stats } : null };
  } finally {
    try { if (encoder.state !== "closed") encoder.close(); } catch { /* 已经关了 */ }
    compositor.close();
  }
}
