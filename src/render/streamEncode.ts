/**
 * 轨道流的浏览器侧生成:用浏览器自带的编码器(WebCodecs 的 `VideoEncoder`)把一张卡的逐帧画面压成轨道流分段。
 *
 * 语义:`docs/plan/render-standard.md`「预渲染的产物」(2026-10-09 用户定:在线浏览器也要能生成和播放轨道流;
 * 画面本身贵的卡直接流式压进 H.264,不存图片)。服务端那条路在 `server/frame-stream.mjs`(用 ffmpeg),
 * 这里产出的字节形状与它相同,`streamPlayer.ts` 不用改就能播。
 *
 * # 画面怎么拼(和 `server/bakery/ffmpeg.mjs` 的 `streamFilter` 同一种)
 *
 *   卡片画面 W × H(偶数)→ 编码画面 W × (2H + 16):
 *     第 0 ～ H 行      色半区,存**预乘色**(透明处是纯黑)
 *     第 H ～ H+8 行    黑
 *     第 H+8 ～ 2H+8 行 透明度半区,透明度当灰度存
 *     第 2H+8 ～ 2H+16  黑
 *
 * # 分段
 *
 *   每 `SEGMENT_FRAMES` 帧一段,段首是关键帧;一段编完就封成 `moof + mdat` 交出去,不攒整条流(流式)。
 *   不产 B 帧:样本按送进去的顺序出来,顺序对不上就报错,不写乱序的流。
 *
 * 这一层属于 render:不引 editor;只管「帧 → 分段字节」,发布到哪、记进哪张清单由调用方决定。
 */
import { buildStreamInit, buildStreamSegment, codecOfAvcC, type MuxSample } from "./streamMux.ts";
import { SEGMENT_FRAMES } from "./streamPlayer.ts";

/** 两个半区下面各垫的黑边行数(和 ffmpeg 滤镜里的 `pad=iw:ih+8` 一致) */
export const STREAM_HALF_PAD = 8;

/** 编码画面的宽高 */
export function packedSize(width: number, height: number): { width: number; height: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error(`轨道流:宽高要是正整数,收到 ${width}×${height}`);
  if (width % 2 || height % 2) throw new Error(`轨道流:宽高要是偶数(4:2:0 取样),收到 ${width}×${height}`);
  return { width, height: 2 * height + 2 * STREAM_HALF_PAD };
}

/**
 * H.264 的级别按编码画面的像素数挑(High 档)。4.0 只到 1920×1088,整幅 1080p 拼合后是 1920×2176,要 5.0。
 * 浏览器真正写进码流的级别以 `decoderConfig.description` 为准(`codecOfAvcC`),这里只是让配置过得了能力查询。
 */
export function avcCodecFor(packedWidth: number, packedHeight: number): string {
  const px = packedWidth * packedHeight;
  const level = px <= 414720 ? 0x1e : px <= 921600 ? 0x1f : px <= 2088960 ? 0x28 : px <= 5652480 ? 0x32 : px <= 9437184 ? 0x33 : 0x34;
  return `avc1.6400${level.toString(16).padStart(2, "0")}`;
}

/** 码率按像素给:每像素每帧约 0.2 比特,不低于 1 Mbps。量化模式可用时不用它(见 `openStreamEncoder`) */
export function streamBitrateFor(packedWidth: number, packedHeight: number, fps: number): number {
  return Math.max(1_000_000, Math.round(packedWidth * packedHeight * fps * 0.2));
}

/** 2D 画布的最小形状:浏览器里是 `OffscreenCanvas` / `HTMLCanvasElement` 的 2D 上下文 */
interface Ctx2D {
  globalCompositeOperation: string;
  fillStyle: unknown;
  fillRect(x: number, y: number, w: number, h: number): void;
  clearRect(x: number, y: number, w: number, h: number): void;
  drawImage(image: unknown, dx: number, dy: number, dw: number, dh: number): void;
}

/**
 * 把一帧卡片画面画成上下拼合的编码画面。
 *
 * - 色半区:黑底上按常规合成画一遍。黑底上的「源色 × 透明度」正是预乘色,透明处是纯黑。
 * - 透明度半区:先在草稿画布上画源图,再用 `source-in` 铺白 —— 得到「白色 × 源的透明度」;
 *   把它画到黑底上,灰度就等于透明度。
 *
 * @param packed  编码画面的 2D 上下文(宽 W、高 2H+16)
 * @param scratch 草稿画布的 2D 上下文(宽 W、高 H),调用方复用
 * @param scratchCanvas 草稿画布本身(要当图源画回去)
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
  /** 分段号:这一段的第一帧是整条流的第 `index × SEGMENT_FRAMES` 帧 */
  index: number;
  /** `moof + mdat` */
  bytes: Uint8Array;
  /** 这一段的样本数(最后一段可能不满) */
  samples: number;
}

export interface StreamInitOut {
  /** `ftyp + moov` */
  bytes: Uint8Array;
  /** 从码流的 `avcC` 拼出来的编码串(清单里 `inits[..].codec` 要的就是它) */
  codec: string;
  /** 编码画面的宽高(拼合后的) */
  width: number;
  height: number;
}

export interface StreamEncoderOptions {
  /** 卡片画面的宽高(偶数) */
  width: number;
  height: number;
  fps: number;
  /** 这条流从第几段开始编(续编用);缺省 0 */
  firstSegment?: number;
  /** `no-preference` / `prefer-hardware` / `prefer-software`;缺省交给浏览器 */
  hardwareAcceleration?: "no-preference" | "prefer-hardware" | "prefer-software";
  /** 量化模式下每帧的量化参数(越小越清楚);缺省 20,和 ffmpeg 那条路的 crf / cq 16 是同一个量级 */
  quantizer?: number;
  /** 初始化段出来时调一次(第一帧编出来之后) */
  onInit(init: StreamInitOut): void | Promise<void>;
  /** 每编完一段调一次,按段号从小到大 */
  onSegment(segment: StreamSegmentOut): void | Promise<void>;
  /** 测试用:换掉编码器与画布的构造 */
  env?: Partial<StreamEncodeEnv>;
}

/** 这一层用到的浏览器能力,集中在这里,单测可以整个换掉 */
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

/** 问一组编码配置各自支不支持:回与 `configs` 等长的数组;问不了(没有 Worker、起不来、里面没有编码器、超时)回 null */
export type ConfigSupportAsker = (configs: Record<string, unknown>[]) => Promise<boolean[] | null>;

/** Worker 里跑的那一小段:逐个问 `VideoEncoder.isConfigSupported`,回布尔数组;Worker 里没有编码器回 null */
const PROBE_WORKER_SOURCE = `self.onmessage = async (ev) => {
  if (typeof VideoEncoder !== "function") { self.postMessage(null); return; }
  const out = [];
  for (const c of ev.data) { try { const r = await VideoEncoder.isConfigSupported(c); out.push(!!(r && r.supported)); } catch (e) { out.push(false); } }
  self.postMessage(out);
};`;
const PROBE_WORKER_TIMEOUT_MS = 5000;

/**
 * 在 Worker 里问编码器支不支持这些配置。`VideoEncoder.isConfigSupported` 是异步接口,但这个页面第一次调用它的那个线程会被占住
 * 50～120 毫秒(实测:无硬件加速的 Chrome,1920×1080 的画面主线程上是一个 115 毫秒的长任务;在线页面里量到 53～57 毫秒)。
 * 浏览器节点是在编辑页面的主文档里探的,这一下正落在「生成快照期间主文档没有长任务」的时间段里(`m7-contract.md` 的 M7-A12)。
 * 放到 Worker 里问,答案相同,主线程不受影响;之后在主线程上配置编码器、逐帧压没有长任务(同一组实测)。
 * Worker 从 blob 地址起(编辑页面与舞台的内容安全策略都许)。任何一步不成回 null,调用方退回在本线程问。
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
      try { worker?.terminate(); } catch { /* 已经停了 */ }
      try { if (url) g.URL.revokeObjectURL(url); } catch { /* 撤不了也无妨 */ }
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
 * 这个浏览器压不压得了这种画面;压得了就回实际要用的配置。
 * 用浏览器自己的编码器时(没有注入 `env.VideoEncoder`)先在 Worker 里问(`askConfigSupportInWorker`,不占主线程),问不了才在本线程问;
 * `askOffThread` 给 null 就只在本线程问,给函数就换成它(测试用)。
 */
export async function probeStreamEncoder(o: { width: number; height: number; fps: number; hardwareAcceleration?: StreamEncoderOptions["hardwareAcceleration"]; env?: Partial<StreamEncodeEnv>;
  askOffThread?: ConfigSupportAsker | null }): Promise<{ supported: boolean; config?: Record<string, unknown>; mode?: "quantizer" | "variable"; reason?: string }> {
  const env = { ...defaultEnv(), ...o.env };
  if (typeof env.VideoEncoder !== "function" || typeof env.VideoFrame !== "function") return { supported: false, reason: "这个浏览器没有 VideoEncoder" };
  const size = packedSize(o.width, o.height);
  const base = {
    codec: avcCodecFor(size.width, size.height),
    width: size.width,
    height: size.height,
    framerate: o.fps,
    avc: { format: "avc" },                 // 样本用长度前缀,参数集放进 description(avcC)
    latencyMode: "quality",
    ...(o.hardwareAcceleration ? { hardwareAcceleration: o.hardwareAcceleration } : {}),
  };
  // 优先按固定量化压(画质不随内容复杂度掉);浏览器不认就退到按码率
  const modes = [["quantizer", { bitrateMode: "quantizer" }], ["variable", { bitrateMode: "variable", bitrate: streamBitrateFor(size.width, size.height, o.fps) }]] as const;
  const unsupported = { supported: false, reason: `这个浏览器压不了 ${size.width}×${size.height} 的 H.264` };
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
    } catch { /* 这个模式不认,试下一个 */ }
  }
  return unsupported;
}

export interface StreamEncoder {
  /** 送下一帧(按顺序,从 `firstSegment × SEGMENT_FRAMES` 那一帧起)。`source` 是任何 `drawImage` 收的东西 */
  add(source: unknown): Promise<void>;
  /** 编完:把没满的最后一段也交出去,关掉编码器。回总帧数与用的模式 */
  finish(): Promise<{ frames: number; segments: number; mode: "quantizer" | "variable"; codec: string }>;
  /** 出错或不要了:直接关掉,不再交任何东西 */
  abort(): void;
}

/**
 * 开一个轨道流编码器。帧按顺序 `add()`,每满一段经 `onSegment` 交出去。
 *
 * 背压:编码器里排着的帧超过 3 个时 `add()` 会等(和导出那条路同一个数),调用方 `await` 它就不会把内存撑大。
 */
export async function openStreamEncoder(opts: StreamEncoderOptions): Promise<StreamEncoder> {
  const env = { ...defaultEnv(), ...opts.env };
  const { width, height, fps } = opts;
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("轨道流:要帧率");
  const size = packedSize(width, height);
  const probe = await probeStreamEncoder({ width, height, fps, hardwareAcceleration: opts.hardwareAcceleration, env });
  if (!probe.supported || !probe.config || !probe.mode) throw new Error(probe.reason ?? "轨道流:这个浏览器压不了");
  const mode = probe.mode;
  const quantizer = Number.isFinite(opts.quantizer) ? Math.max(0, Math.min(51, Math.round(opts.quantizer as number))) : 20;

  const packedCanvas = env.createCanvas(size.width, size.height);
  const scratchCanvas = env.createCanvas(width, height);
  const packed = packedCanvas.getContext("2d", { alpha: false });
  const scratch = scratchCanvas.getContext("2d");
  if (!packed || !scratch) throw new Error("轨道流:拿不到 2D 画布");

  const firstSegment = Math.max(0, Math.floor(opts.firstSegment ?? 0));
  let fed = 0;                       // 送进编码器的帧数
  let out = 0;                       // 编码器交回来的样本数
  let segments = 0;
  let pending: MuxSample[] = [];
  let avcC: Uint8Array | null = null;
  let initSent = false;
  let lastTimestamp = -1;
  let failure: Error | null = null;
  let closed = false;
  /** 交付排成一条链:段要按顺序交,而且 `onSegment` 可能是异步的(上传) */
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
      if (!description) throw new Error("轨道流:编码器没有给出参数集(avcC)");
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
        // 不产 B 帧:出来的顺序就是送进去的顺序。时间戳倒退说明编码器重排了,这种流播放器没法按「第几个样本」取帧
        if (chunk.timestamp <= lastTimestamp) throw new Error("轨道流:编码器重排了帧(出现 B 帧),这种流不能用");
        lastTimestamp = chunk.timestamp;
        const isSync = chunk.type === "key";
        const at = out % SEGMENT_FRAMES;
        if (at === 0 && !isSync) throw new Error(`轨道流:第 ${out} 个样本应当是关键帧`);
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

  const close = () => { if (!closed) { closed = true; try { encoder.close(); } catch { /* 已经关了 */ } } };

  return {
    async add(source) {
      if (closed) throw new Error("轨道流:编码器已经关了");
      if (failure) { close(); throw failure; }
      drawPackedFrame(packed, scratch, scratchCanvas, source, width, height);
      // 时间戳按「这条流里的第几帧」给(从流自己的第一帧起数,不是项目帧号);它只管编码器内部的先后,
      // 播放器解码时自己按项目帧号另给时间戳(`streamPlayer.ts` 的 `chunkTimestamp`),不读这里写的
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
      if (closed) throw failure ?? new Error("轨道流:编码器已经关了");
      try {
        await encoder.flush();
        flushSegment();
        await delivery;
      } catch (err) { fail(err); }
      close();
      if (failure) throw failure;
      if (out !== fed) throw new Error(`轨道流:送进去 ${fed} 帧,只出来 ${out} 个样本`);
      return { frames: fed, segments, mode, codec: avcC ? codecOfAvcC(avcC) : String(probe.config!.codec) };
    },
    abort() {
      fail(new Error("轨道流:已取消"));
      close();
    },
  };
}
