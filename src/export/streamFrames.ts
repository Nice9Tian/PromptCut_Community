/**
 * 「快速导出」取轨道流里的画面(语义 `docs/semantics/product/platforms.md`「在线浏览器」的「导出」):读层表的 `streams` 表与流清单,
 * 定出每条流哪几个分段是满密度的;导出时按帧取分段字节、解码、把上下两半(预乘色 + 不透明度)合成一张带透明的图。
 *
 * 和预览一侧同一份数据、同一套换算:
 *   - 层表(内容库 `snapshot-manifest`,键 `layers:<项目 id>`)、流清单(`render-manifest`,键 `<结果键>:<起>-<止>`)、分段字节(素材服务 `px/<哈希>`);
 *   - 分段号从这条流自己的第一帧起每 15 帧一段(`streamSegments.mjs`);解封装用 `streamPlayer.ts` 的 `parseInit` / `parseSegment`;
 *   - 合成照 `streamPlayer.ts` 的着色器:色半区是预乘色、钳一次 `rgb ≤ a`,不透明度取下半区的亮度;上下两半之间隔 8 行、底下再留 8 行。
 *
 * 只认**一张卡一条**的流(单卡流,含源依赖卡与三维外框的卡;依赖下层的流的行页面认得时同样认),组流不取(`cardLayers.ts` 文件头)。
 * 旧输入的流(行里的输入签名和这一版项目算的对不上)不取。一条流有几个候选(几种环境各产了一份)时取满密度分段最多的那一份,
 * 一条流只用一个候选的分段,不混环境。
 *
 * 解码按帧号递增顺着来(导出本来就是顺推):同一个分段里接着喂,不重置解码器;跨分段时从下一段的关键帧起。
 * 同一份字节、同一个解码器解出来的像素是确定的,所以同一个项目导两次逐帧相同。
 */
import { isFlatClipId } from "../kernel/cutFlatten.mjs";
import { LAYER_MAP_PREFIX, parseLayerMap, streamSpansInWindow, type OnlineStream } from "../render/snapshotSource";
import { chunkTimestamp, parseInit, parseSegment, type SegmentSample } from "../render/streamPlayer";
import { streamInputSig, streamSigStale } from "../render/streamInputSig.mjs";
import { streamSegmentFirstFrame, streamSegmentOf } from "../render/streamSegments.mjs";
import type { LayerRect, StreamCoverage } from "./cardLayers";

export interface StreamFrameDeps {
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  assetBase(): string | null;
  authHeaders(): Promise<Record<string, string>>;
  fetch?: typeof fetch;
}

const HASH_RE = /^[0-9a-f]{64}$/;
/** 上下两半之间、以及底下各留的行数(与 `server/bakery/ffmpeg.mjs` 的拼法、`streamPlayer.ts` 的着色器同值) */
export const HALF_GAP_ROWS = 8;
/** 等一帧解出来最多这么久(只为防卡死) */
export const DECODE_TIMEOUT_MS = 30_000;

interface InitMeta { hash: string; rect: LayerRect }
interface SegMeta { hash: string; init: string; stride: number; samples: number }

/** 一条可取的流,连同取字节要的清单 */
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

/** 内容库回的一份流清单里,这个范围内形状对的分段与它们的开头文件(同 `snapshotSource.ts` 的 `parseStreamManifest`) */
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
 * 读层表和每条流的清单,回这一版项目里可取的流(只列至少有一个满密度分段的)。取不到层表、没有流,回空表(快速导出照完整导出的办法出)。
 * `clipIds`:只看这些片段的流(不给 = 全部)。
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
    // 只认一张卡一条的流;组流不取
    if (row.clipIds.length !== 1 || (row.kind as string) === "group") continue;
    const clipId = row.clipIds[0];
    if (clipIds && !clipIds.has(clipId)) continue;
    // 剪辑段里的卡(`kernel/cutFlatten.mjs` 的虚拟片段)不从流取:导出时嵌套场景整帧活渲
    if (isFlatClipId(clipId)) continue;
    // 旧输入的流不取(行里的签名和页面按这一版项目算的不同)。没带签名的行没法核对,导出时同样不取(预览照旧贴,那是它自己的规矩):
    // 成片里贴进一段别的版本的画面比慢一点更糟
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

/** 一帧解出来的画面:带透明的画布(宽高 = `rect` 的宽高),和它盖住的矩形(平面坐标) */
export interface StreamPicture { canvas: HTMLCanvasElement | OffscreenCanvas; rect: LayerRect }

/**
 * 上下拼合的一帧(`rgba` 是整帧的像素,宽 `width`、高 `total`)→ 带透明的 straight RGBA(宽 `width`、高 `h`)。
 * 色半区在上(预乘色),不透明度在下半区的红色通道,从第 `h + HALF_GAP_ROWS` 行起。钳一次 `rgb ≤ a` 再除回 straight。
 */
export function composeHalves(rgba: Uint8ClampedArray | Uint8Array, width: number, total: number, h: number, out: Uint8ClampedArray = new Uint8ClampedArray(width * h * 4)): Uint8ClampedArray {
  const alphaTop = h + HALF_GAP_ROWS;
  if (alphaTop + h > total) throw new Error(`流的这一帧高 ${total},放不下两半各 ${h} 行`);
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

/** 解出来的一帧的宽度就是这一段矩形的宽;对不上就抛(调用方不裁、不拉伸) */
export function frameWidthOf(decodedWidth: number, rect: LayerRect, frame: number): number {
  if (decodedWidth !== rect.w) throw new Error(`轨道流第 ${frame} 帧解出来宽 ${decodedWidth},和清单里这一段的矩形宽 ${rect.w} 对不上`);
  return rect.w;
}

/** 一条流的顺序解码器:按帧号递增取帧 */
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
    if (!base) throw new Error("还没有远程素材服务");
    const f = this.deps.fetch ?? fetch;
    const res = await f(`${base.replace(/\/+$/, "")}/px/${hash}`, { headers: await this.deps.authHeaders(), signal: this.signal });
    if (!res.ok) throw new Error(`取不到轨道流的字节 ${hash.slice(0, 12)}:${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    this.stats.fetched++;
    this.stats.bytes += bytes.length;
    // 开头文件一条流就那么一两个,留着;分段只留当前这一段
    if (keep) this.blocks.set(hash, bytes);
    return bytes;
  }

  private closeDecoder() {
    for (const f of this.outputs.values()) { try { f.close(); } catch { /* 已经关了 */ } }
    this.outputs.clear();
    try { if (this.decoder && this.decoder.state !== "closed") this.decoder.close(); } catch { /* 已经关了 */ }
    this.decoder = null;
  }

  private async openSegment(n: number): Promise<void> {
    this.closeDecoder();
    const seg = this.stream.segments.get(n);
    const init = seg ? this.stream.inits.get(seg.init) : undefined;
    if (!seg || !init) throw new Error(`轨道流没有第 ${n} 段`);
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
        // 时间戳 = 项目帧号 × 1e6 / fps;换回这一段里的第几个样本
        const idx = Math.round((frame.timestamp * fps) / 1e6) - first;
        const old = this.outputs.get(idx);
        if (old) { try { old.close(); } catch { /* 已经关了 */ } }
        this.outputs.set(idx, frame);
        this.wake?.();
      },
      error: (e) => { this.failure = e; this.wake?.(); },
    });
    decoder.configure({ codec: config.codec, description: config.description, optimizeForLatency: true } as VideoDecoderConfig);
    this.decoder = decoder;
    this.stats.segments++;
  }

  /** 等解码器出点东西(一帧出来、出错,或过一小会儿) */
  private pause(ms = 20): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { this.wake = null; clearTimeout(timer); resolve(); };
      const timer = setTimeout(done, ms);
      this.wake = done;
    });
  }

  /** 取第 `frame` 帧(项目帧号)的画面。调用方保证这一帧在满密度的分段里(`streamCovers`) */
  async picture(frame: number): Promise<StreamPicture> {
    if (this.signal?.aborted) throw Object.assign(new Error("已取消"), { cancelled: true });
    const t0 = performance.now();
    const n = streamSegmentOf(frame, this.stream.originFrame);
    const first = streamSegmentFirstFrame(n, this.stream.originFrame);
    const idx = frame - first;
    // 换了分段,或者这一帧已经喂过去、画面又不在手里(往回跳):从这一段的关键帧重新解
    if (n !== this.seg || !this.decoder || (idx < this.fed && !this.outputs.has(idx))) await this.openSegment(n);
    if (idx < 0 || idx >= this.samples.length) throw new Error(`轨道流第 ${n} 段没有第 ${idx} 个样本`);
    const fps = this.stream.fps;
    const started = performance.now();
    while (!this.outputs.has(idx)) {
      if (this.signal?.aborted) throw Object.assign(new Error("已取消"), { cancelled: true });
      if (this.failure) throw new Error(`轨道流解码出错:${String((this.failure as Error)?.message ?? this.failure)}`);
      if (performance.now() - started > DECODE_TIMEOUT_MS) throw new Error(`轨道流第 ${frame} 帧 ${DECODE_TIMEOUT_MS / 1000} 秒没解出来`);
      const decoder = this.decoder!;
      // 手里攒的帧不多、还有样本没喂:再喂一个(解码器有延迟时要多喂几个才吐前面的)
      if (this.fed < this.samples.length && this.outputs.size < 6 && decoder.decodeQueueSize < 2) {
        const s = this.samples[this.fed];
        decoder.decode(new EncodedVideoChunk({ type: s.isSync ? "key" : "delta", timestamp: chunkTimestamp(first + this.fed, fps),
          data: this.segBytes!.subarray(s.offset, s.offset + s.size) }));
        this.fed++;
        continue;
      }
      if (this.fed >= this.samples.length && !this.flushed) {
        // 这一段全喂完了还没等到:冲一次,把解码器里压着的都吐出来(冲过之后下一段从关键帧起,本来就是)
        this.flushed = true;
        await decoder.flush();
        continue;
      }
      if (this.fed >= this.samples.length && this.flushed) throw new Error(`轨道流第 ${frame} 帧解不出来`);
      await this.pause();
    }
    // 这一帧之前的画面用不着了
    for (const [i, f] of this.outputs) if (i < idx) { try { f.close(); } catch { /* 已经关了 */ } this.outputs.delete(i); }
    const vf = this.outputs.get(idx)!;
    const seg = this.stream.segments.get(n)!;
    const rect = this.stream.inits.get(seg.init)!.rect;
    const width = vf.displayWidth || vf.codedWidth, total = vf.displayHeight || vf.codedHeight;
    // 解出来的宽度应当就是这一段的矩形宽(编码时按矩形编的)。对不上说明清单和字节不是一回事:不裁、不拉伸,报错,不导出错的画面
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
