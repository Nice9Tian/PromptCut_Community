/**
 * 浏览器端视频小尺寸转码与流式哈希计算。
 *
 * 语义：`docs/plan/user-decisions-2026-10-14.md` 第 2.5 节「在线浏览器导入素材：页面上传，浏览器里转视频小尺寸」。
 * - 小尺寸规格：保持宽高比、缩放至 800×600 以内的偶数尺寸 H.264 MP4（无音频，仅供预览）。
 * - 抽帧与编码：复用 WebCodecs `VideoEncoder` + `src/export/mp4Mux.ts`，通过 `<video>` + Canvas 逐帧抽帧压制。
 * - 优雅降级：若浏览器不支持 WebCodecs、编码配置不支持或视频解码失败，则优雅降级为 null（只传原尺寸一档，绝不卡死导入流程）。
 * - 流式哈希：纯 TypeScript 实现 SHA-256 分块计算，支持任意大小的 Blob/File 流式哈希，避免大文件占用页面内存。
 */
import { Mp4Muxer, MemorySink } from "../export/mp4Mux.ts";

export const SMALL_MAX_WIDTH = 800;
export const SMALL_MAX_HEIGHT = 600;
export const SMALL_DEFAULT_FPS = 24;

/**
 * 计算素材小尺寸的偶数宽高（800×600 以内，保持宽高比，不放大）。
 */
export function smallVideoDimensions(srcWidth: number, srcHeight: number): { width: number; height: number } {
  if (srcWidth <= 0 || srcHeight <= 0) return { width: SMALL_MAX_WIDTH, height: 450 };
  let scale = 1;
  if (srcWidth > SMALL_MAX_WIDTH || srcHeight > SMALL_MAX_HEIGHT) {
    scale = Math.min(SMALL_MAX_WIDTH / srcWidth, SMALL_MAX_HEIGHT / srcHeight);
  }
  let w = Math.round(srcWidth * scale);
  let h = Math.round(srcHeight * scale);
  w = Math.max(2, Math.floor(w / 2) * 2);
  h = Math.max(2, Math.floor(h / 2) * 2);
  if (w > SMALL_MAX_WIDTH) w = SMALL_MAX_WIDTH;
  if (h > SMALL_MAX_HEIGHT) h = SMALL_MAX_HEIGHT;
  return { width: w, height: h };
}

/**
 * 根据编码画面的像素量挑 H.264 编码级别。
 */
export function avcCodecFor(width: number, height: number): string {
  const px = width * height;
  const level = px <= 414720 ? 0x1e : px <= 921600 ? 0x1f : px <= 2088960 ? 0x28 : 0x32;
  return `avc1.6400${level.toString(16).padStart(2, "0")}`;
}

export interface TranscodeEnv {
  VideoEncoder?: any;
  VideoFrame?: any;
  createCanvas: (width: number, height: number) => {
    getContext(type: "2d", options?: unknown): any;
  };
  createVideo: () => any;
}

export interface TranscodeOptions {
  signal?: AbortSignal;
  onProgress?: (ratio: number) => void;
  fps?: number;
  env?: Partial<TranscodeEnv>;
}

export interface TranscodeResult {
  blob: Blob;
  hash: string;
  width: number;
  height: number;
  duration: number;
}

/* ------------------------------------------------------------------ *
 * 流式 SHA-256
 * ------------------------------------------------------------------ */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;

  private block = new Uint8Array(64);
  private blockLen = 0;
  private totalBytes = 0;
  private w = new Uint32Array(64);

  update(data: Uint8Array): this {
    let offset = 0;
    let len = data.length;
    this.totalBytes += len;

    while (len > 0) {
      if (this.blockLen === 0 && len >= 64) {
        this.processBlock(data, offset);
        offset += 64;
        len -= 64;
      } else {
        const toCopy = Math.min(64 - this.blockLen, len);
        this.block.set(data.subarray(offset, offset + toCopy), this.blockLen);
        this.blockLen += toCopy;
        offset += toCopy;
        len -= toCopy;
        if (this.blockLen === 64) {
          this.processBlock(this.block, 0);
          this.blockLen = 0;
        }
      }
    }
    return this;
  }

  private processBlock(buf: Uint8Array, offset: number): void {
    const w = this.w;
    for (let i = 0; i < 16; i++) {
      const idx = offset + i * 4;
      w[i] = ((buf[idx] << 24) | (buf[idx + 1] << 16) | (buf[idx + 2] << 8) | buf[idx + 3]) >>> 0;
    }
    for (let i = 16; i < 64; i++) {
      const v0 = w[i - 15];
      const s0 = (((v0 >>> 7) | (v0 << 25)) ^ ((v0 >>> 18) | (v0 << 14)) ^ (v0 >>> 3)) >>> 0;
      const v1 = w[i - 2];
      const s1 = (((v1 >>> 17) | (v1 << 15)) ^ ((v1 >>> 19) | (v1 << 13)) ^ (v1 >>> 10)) >>> 0;
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }

    let a = this.h0;
    let b = this.h1;
    let c = this.h2;
    let d = this.h3;
    let e = this.h4;
    let f = this.h5;
    let g = this.h6;
    let h = this.h7;

    for (let i = 0; i < 64; i++) {
      const s1 = (((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))) >>> 0;
      const ch = ((e & f) ^ (~e & g)) >>> 0;
      const temp1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = (((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))) >>> 0;
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0;
      const temp2 = (s0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    this.h0 = (this.h0 + a) >>> 0;
    this.h1 = (this.h1 + b) >>> 0;
    this.h2 = (this.h2 + c) >>> 0;
    this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0;
    this.h5 = (this.h5 + f) >>> 0;
    this.h6 = (this.h6 + g) >>> 0;
    this.h7 = (this.h7 + h) >>> 0;
  }

  digest(): string {
    const pad = new Uint8Array(64);
    pad[0] = 0x80;
    const bits = this.totalBytes * 8;
    const padLen = this.blockLen < 56 ? 56 - this.blockLen : 120 - this.blockLen;
    this.update(pad.subarray(0, padLen));

    const lenBytes = new Uint8Array(8);
    const hi = Math.floor(bits / 0x100000000);
    const lo = bits >>> 0;
    lenBytes[0] = (hi >>> 24) & 0xff;
    lenBytes[1] = (hi >>> 16) & 0xff;
    lenBytes[2] = (hi >>> 8) & 0xff;
    lenBytes[3] = hi & 0xff;
    lenBytes[4] = (lo >>> 24) & 0xff;
    lenBytes[5] = (lo >>> 16) & 0xff;
    lenBytes[6] = (lo >>> 8) & 0xff;
    lenBytes[7] = lo & 0xff;
    this.update(lenBytes);

    const parts = [this.h0, this.h1, this.h2, this.h3, this.h4, this.h5, this.h6, this.h7];
    return parts.map((p) => p.toString(16).padStart(8, "0")).join("");
  }
}

/**
 * 流式计算一个 Blob/File 的 SHA-256（小写 64 位十六进制）。
 * 按 2 MiB 分片顺序读取，常数内存开销，大文件不会爆页面内存。
 */
export async function sha256Blob(blob: Blob, signal?: AbortSignal): Promise<string> {
  const hasher = new Sha256();
  const CHUNK_SIZE = 2 * 1024 * 1024;
  let offset = 0;
  while (offset < blob.size) {
    if (signal?.aborted) throw new Error("aborted");
    const end = Math.min(blob.size, offset + CHUNK_SIZE);
    const slice = blob.slice(offset, end);
    const buffer = await slice.arrayBuffer();
    hasher.update(new Uint8Array(buffer));
    offset = end;
  }
  return hasher.digest();
}

/* ------------------------------------------------------------------ *
 * 浏览器端视频小尺寸转码
 * ------------------------------------------------------------------ */

function resolveEnv(env?: Partial<TranscodeEnv>): TranscodeEnv {
  const g = typeof globalThis !== "undefined" ? (globalThis as any) : {};
  return {
    VideoEncoder: env?.VideoEncoder ?? g.VideoEncoder,
    VideoFrame: env?.VideoFrame ?? g.VideoFrame,
    createCanvas: env?.createCanvas ?? ((w: number, h: number) => {
      if (typeof g.OffscreenCanvas !== "undefined") return new g.OffscreenCanvas(w, h);
      if (typeof document !== "undefined") {
        const el = document.createElement("canvas");
        el.width = w;
        el.height = h;
        return el;
      }
      throw new Error("没有可用画布");
    }),
    createVideo: env?.createVideo ?? (() => {
      if (typeof document !== "undefined") {
        const el = document.createElement("video");
        el.preload = "auto";
        el.muted = true;
        el.playsInline = true;
        return el;
      }
      throw new Error("没有可用视频元素");
    }),
  };
}

/**
 * 等待视频就绪或超时（默认 5 秒）。
 */
function waitForVideoReady(video: any, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (video.readyState >= 1 && video.duration > 0) return resolve();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      video.removeEventListener?.("loadedmetadata", onLoaded);
      video.removeEventListener?.("error", onError);
    };
    const onLoaded = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("视频加载失败")); };
    timer = setTimeout(() => { cleanup(); reject(new Error("探测元数据超时")); }, timeoutMs);
    video.addEventListener?.("loadedmetadata", onLoaded);
    video.addEventListener?.("error", onError);
  });
}

/**
 * 等待视频单次 seek 完成。
 */
function waitForSeeked(video: any, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      video.removeEventListener?.("seeked", onSeeked);
      video.removeEventListener?.("error", onError);
    };
    const onSeeked = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error("seek 出错")); };
    timer = setTimeout(() => { cleanup(); resolve(); }, timeoutMs); // seek 超时容忍按当前帧过
    video.addEventListener?.("seeked", onSeeked);
    video.addEventListener?.("error", onError);
  });
}

/**
 * 当在线浏览器导入视频文件时，在页面内转出一份「素材小尺寸」：
 * 800×600 以内保持宽高比的偶数尺寸 H.264 MP4（无音频，仅供预览）。
 *
 * 若浏览器不支持 WebCodecs、编码配置不支持或视频解码失败，优雅降级返回 null。
 */
export async function transcodeVideoSmall(file: Blob, opts: TranscodeOptions = {}): Promise<TranscodeResult | null> {
  const env = resolveEnv(opts.env);
  if (typeof env.VideoEncoder !== "function" || typeof env.VideoFrame !== "function") {
    return null;
  }

  let videoUrl = "";
  let videoEl: any = null;
  try {
    const g = typeof globalThis !== "undefined" ? (globalThis as any) : {};
    if (typeof g.URL?.createObjectURL === "function") {
      videoUrl = g.URL.createObjectURL(file);
    }
    videoEl = env.createVideo();
    if (videoUrl) videoEl.src = videoUrl;

    await waitForVideoReady(videoEl, 5000);
    opts.signal?.throwIfAborted();

    const srcW = Number(videoEl.videoWidth) || 0;
    const srcH = Number(videoEl.videoHeight) || 0;
    const duration = Number(videoEl.duration) || 0;
    if (srcW <= 0 || srcH <= 0 || duration <= 0 || !Number.isFinite(duration)) {
      return null;
    }

    const { width, height } = smallVideoDimensions(srcW, srcH);
    const fps = opts.fps && opts.fps > 0 ? opts.fps : SMALL_DEFAULT_FPS;
    const bitrate = Math.max(500_000, Math.min(2_000_000, Math.round(width * height * fps * 0.15)));

    // 探测编码器配置支持
    const candidateCodecs = [avcCodecFor(width, height), "avc1.42001e", "avc1.4d001f", "avc1.640028"];
    let chosenCodec: string | null = null;
    for (const codec of candidateCodecs) {
      try {
        const support = await env.VideoEncoder.isConfigSupported({
          codec,
          width,
          height,
          framerate: fps,
          bitrate,
          avc: { format: "avc" },
        });
        if (support?.supported) {
          chosenCodec = codec;
          break;
        }
      } catch {
        // 继续试下一个候选
      }
    }
    if (!chosenCodec) return null;

    const sink = new MemorySink();
    let muxer: Mp4Muxer | null = null;
    let avcC: Uint8Array | null = null;
    let encodeErr: Error | null = null;

    const encoder = new env.VideoEncoder({
      output: (chunk: any, meta: any) => {
        try {
          const desc = meta?.decoderConfig?.description;
          if (desc && !avcC) {
            avcC = desc instanceof Uint8Array ? new Uint8Array(desc) : new Uint8Array(desc as ArrayBuffer);
            const finalCodec = meta?.decoderConfig?.codec || chosenCodec;
            muxer = new Mp4Muxer({
              video: {
                codec: finalCodec,
                width,
                height,
                fps,
                avcC,
              },
              sink,
            });
          }
          if (muxer) {
            const data = new Uint8Array(chunk.byteLength);
            chunk.copyTo(data);
            muxer.addVideoChunk(data, {
              timestampUs: chunk.timestamp,
              key: chunk.type === "key",
            });
          }
        } catch (e: any) {
          encodeErr = e instanceof Error ? e : new Error(String(e));
        }
      },
      error: (e: any) => {
        encodeErr = e instanceof Error ? e : new Error(String(e));
      },
    });

    encoder.configure({
      codec: chosenCodec,
      width,
      height,
      framerate: fps,
      bitrate,
      avc: { format: "avc" },
    });

    const canvas = env.createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      try { encoder.close(); } catch {}
      return null;
    }

    const dt = 1 / fps;
    const totalFrames = Math.max(1, Math.min(3600, Math.ceil(duration * fps))); // 最多采样 3600 帧（约 2.5 分钟）
    for (let i = 0; i < totalFrames; i++) {
      opts.signal?.throwIfAborted();
      if (encodeErr) break;

      const t = i * dt;
      if (t >= duration && i > 0) break;

      videoEl.currentTime = t;
      await waitForSeeked(videoEl, 2000);

      ctx.drawImage(videoEl, 0, 0, width, height);
      const frame = new env.VideoFrame(canvas, {
        timestamp: Math.round(i * (1e6 / fps)),
        duration: Math.round(1e6 / fps),
      });

      try {
        encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      } finally {
        frame.close?.();
      }

      opts.onProgress?.((i + 1) / totalFrames);

      while (encoder.encodeQueueSize > 4 && !encodeErr) {
        await new Promise((r) => setTimeout(r, 0));
      }
    }

    await encoder.flush();
    try { encoder.close(); } catch {}

    const readyMuxer = muxer as Mp4Muxer | null;
    if (encodeErr || !readyMuxer) return null;

    await readyMuxer.finalize();
    const blob = sink.blob("video/mp4");
    const hash = await sha256Blob(blob, opts.signal);

    return {
      blob,
      hash,
      width,
      height,
      duration,
    };
  } catch (err) {
    return null;
  } finally {
    if (videoUrl) {
      try {
        const g = typeof globalThis !== "undefined" ? (globalThis as any) : {};
        g.URL?.revokeObjectURL(videoUrl);
      } catch {}
    }
    if (videoEl) {
      try { videoEl.src = ""; } catch {}
    }
  }
}
