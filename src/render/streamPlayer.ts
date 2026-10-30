/**
 * 轨道流的页面侧:自写 fMP4 解封装、`VideoDecoder` 硬解、WebGL 拆两半合成(R8,任务书 G5)。全部流平面共用一个 WebGL 上下文(`SharedGl`)。
 *
 * **只在 `front` 角色的舞台文档里跑**(解码器和解码帧预算都在 `front`;`back` 不建 decoder、不画,K5)。
 * 画在 `Stage` 已经渲好的兄弟平面上 —— 单卡流是包裹层里的 `<canvas data-pc-stream-plane>`,
 * 组流和依赖下层的流(都按舞台坐标产)是舞台根下的 `<canvas data-pc-group-plane>`;这里只往那块画布上画、按清单设它的位置和尺寸,
 * **不做外部 `insertBefore`**(任务书「不做」)。
 *
 * # 硬约束(G0-b 定的数)
 *
 *   - **单个 `VideoDecoder` 同时持有的 `VideoFrame` ≤ 8 帧**:攒到 11～12 帧解码器就死锁、`flush()`
 *     永不返回,这是帧数上限、与分辨率无关;
 *   - 在这之上解码帧预算**按字节算**:总量 ≤ 80 MB(上下拼合的编码画面,NV12 按 1.5 字节 / 像素),
 *     每流保底 3 帧;
 *   - 同屏的流按「每秒要解的像素」算预算,另有条数的硬上限(`./streamBudget.mjs`,划分流的一侧用的是同一份);超出的平面不建解码器
 *     (`planesWithinBudget`,父页据它给超出的平面标上 `over`),那一层显示占位符,位置取这条流清单里这一帧所在分段的位置矩形;
 *   - 每流最多 2 个在途请求,分段整段拉;
 *   - `codec` 从 `avcC` 拼(真实 SPS 的 level 随内容变,不能写死);`isConfigSupported` 不校验 level
 *     与分辨率,不拿它当能力判据。
 *
 * # 画法
 *
 * 色半区存的是**预乘色**(G3),共用的上下文按 `premultipliedAlpha: true` 输出,不再做 `rgb × a`;平面的 2D 画布原样取走(见 `SharedGl`);
 * 着色器**钳一次 `rgb = min(rgb, vec3(a))`**(G0-b (5):不钳时透明区的编码噪声原样输出)。
 * 纹理坐标按 `alphaTop = (H + 8) / (2H + 16)`、`half = H / (2H + 16)` 拆两半。
 *
 * # 时间
 *
 * 流从**它自己的第一帧**(`originFrame`,项目帧号)起每 15 帧一段:项目的第 F 帧在第 `floor((F − originFrame) / 15)` 段的
 * 第 `(F − originFrame) % 15` 个样本(换算只在 `./streamSegments.mjs` 一处,产流的一侧用的是同一份)。`originFrame` 由父页随
 * 流平面带来(`StreamPlaneRequest.originFrame`,源头是流的计划),**不从清单取**:清单里那一项记的是产流时的位置。
 * `EncodedVideoChunk.timestamp = F × 1e6 / fps`(微秒,取整;F 是项目帧号)。
 *
 * # 这一拍要的画面画不出来时(播放、暂停、拖动同一套;mechanism/rendering.md「兜底顺序」)
 *
 *   - **留着上一张**,最多留一个分段的时长(`HOLD_FRAMES` 帧,按真实时间算);到时还没有新画面才清空流平面,这一层落到占位符。
 *     **播放头从不为它停**。暂停着没有下一拍,所以到时由一个真定时器来清。
 *   - **只解最新要的那一帧**。随机跳到一帧要重置解码器、从它所在分段的关键帧解起;连着跳(拖动)时不打断在途的那一次
 *     (每一步都重置的话一帧也解不出来,最多让它 `SEEK_PATIENCE_MS`),它解到了先画上,再去解**此刻**要的那一帧 ——
 *     中间经过的那些帧从没排过队,也就没有要丢的。
 *   - **稀疏分段里只有重复的画面**(清单里这一段的 `stride` 大于 1:每 `stride` 个样本是同一张)。跳进稀疏段时,
 *     不晚于目标帧的最近一张(`pictureOf`,只往回找)一解出来就先画上,不用一路解到目标帧;不依赖稀疏版多密。
 *   - 画面从无到有、从有到无时叫宿主一次(`onShowingChange`):帧是异步解出来的,暂停着没有下一拍,
 *     占位符撤不撤、活子树藏不藏都靠这一下。
 *
 * # 最低一档:每个分段只解第一帧(`StreamPlaneRequest.first`,`presentFirst`)
 *
 * 性能不足的在线浏览器只贴轨道流的稀疏版(2026-10-13 用户定;2026-10-22 起归最低一档)。父页给流平面带上 `first`,这条流就**不管那一段是稀疏还是满密度,
 * 都只解分段的第一帧那一张**,这一段的每一帧都贴它(帧号换算在 `./streamSegments.mjs` 的 `streamFirstFrameOf`):
 *
 *   - 一个分段只喂一块(那个关键帧),喂完叫解码器 `flush()` 把它吐出来;同一个解码器同时只有一块在解;
 *   - 画上以后解码输出当场关掉,只留画布上那一张的引用:稳态每条流占 1 帧,换分段的那一下 2 帧(别的档每流 3～8 帧);
 *   - 不往后多解(不预解下一段),不做寻帧、替身那一套 —— 每一块都是关键帧,跳到哪一段都是解一块;
 *   - 解码器连着报错 `FIRST_FRAME_MAX_FAILURES` 次(这条流的编码这台设备解不了)就不再试,这一层落到占位符;
 *   - 别的(留着上一张最多一个分段、清空、换画布重画、占位符的位置)和别的档同一套。
 */

import { isStreamOrigin, STREAM_SEGMENT_FRAMES, streamFirstFrameOf, streamSegmentFirstFrame, streamSegmentOf } from "./streamSegments.mjs";
import { STREAM_COUNT_BUDGET, streamCost, withinStreamBudget, type StreamBudget } from "./streamBudget.mjs";

/** 一个分段的帧数;数和换算都在 `./streamSegments.mjs`,这里只是照旧的名字再导出一次 */
export const SEGMENT_FRAMES = STREAM_SEGMENT_FRAMES;
/** G0-b (4):单个解码器同时持有的帧数上限(硬约束) */
export const MAX_FRAMES_PER_DECODER = 8;
/** G5:解码帧总预算 */
export const DECODED_BYTES_BUDGET = 80 * 1024 * 1024;
/** G5:每流保底 */
export const MIN_FRAMES_PER_STREAM = 3;
/** 同屏流的条数硬上限(预算的口径是数像素,见 `./streamBudget.mjs`;这个名字照旧导出) */
export const DECODER_BUDGET = STREAM_COUNT_BUDGET;
/** G5:每流最多 2 个在途请求 */
export const MAX_INFLIGHT_PER_STREAM = 2;
/** 这一拍的画面没画出来时,上一张最多留这么多帧的时长(一个分段;按这条流的帧率换成真实毫秒) */
export const HOLD_FRAMES = SEGMENT_FRAMES;
/** 清单多久可以再问一次(分段会被替换:稀疏 → 满密度) */
export const MANIFEST_REFRESH_MS = 2000;
/**
 * 在途的那一次寻帧(重置解码器、从分段的关键帧解到目标帧)最多让它跑这么久不被新的目标打断。
 * 连着拖时每一步都重置解码器的话一帧也解不出来;超过这个数还没解到,新的目标照样重置。
 */
export const SEEK_PATIENCE_MS = 250;
/**
 * 还没有画面时,在途那一次寻帧解出来的帧(不是此刻要的那一帧)只有「够新」才画上当第一张:这一次寻帧发起到现在不超过这么久。
 * 宿主等第一张画面出来才把活子树藏起来,拿一张旧时刻的帧去换正跟着播放头走的活组件,画面会往回跳一下。
 * (原型 `claude/scrub-streams` 量的:取 50 时快速拖动里第一张画面要等 400 毫秒,取 100 不会。)
 */
export const FIRST_PICTURE_LAG_MS = 100;
/** 最低一档(只解分段第一帧):解码器连着报错这么多次,这条流就不再试(落到占位符);解出一帧就清零 */
export const FIRST_FRAME_MAX_FAILURES = 3;
/** 最低一档:送去解的那一块过这么久还没出来(解码器卡住了),重置解码器再送 */
export const FIRST_FRAME_STALL_MS = 1000;

/** 真实毫秒:舞台里 `performance.now` / `Date.now` 都被接管成舞台时间,留的口子是 `__pcRealNow`;别处(单测)就是 `Date.now` */
const realNow = (): number => {
  const hatch = (globalThis as { __pcRealNow?: () => number }).__pcRealNow;
  return typeof hatch === "function" ? hatch() : Date.now();
};
/**
 * 真定时器:暂停着舞台的虚拟时钟不走,虚拟定时器永远不响。没有口子的地方(Node 里的单测)用普通定时器,并且不让它拖住进程:
 * 停在稀疏段上的那个刷新定时器是自己接着排的,流不关它就一直在,单测文件会退不出去。
 */
const realTimeout = (fn: () => void, ms: number): void => {
  const hatch = (globalThis as { __pcRealSetTimeout?: (cb: () => void, ms?: number) => unknown }).__pcRealSetTimeout;
  if (typeof hatch === "function") { hatch(fn, ms); return; }
  const timer = setTimeout(fn, ms) as unknown as { unref?: () => void };
  if (typeof timer?.unref === "function") timer.unref();
};
/** 再拿一份这一帧的引用(和原来那份指同一块解码输出;两份都关了才放回解码器)。单测里的假帧没有 `clone` */
const cloneFrame = (frame: VideoFrame): VideoFrame | null => {
  try { return typeof frame.clone === "function" ? frame.clone() : null; } catch { return null; }
};

export interface StreamRect { x: number; y: number; w: number; h: number }

/** 父页经 `setStreamPlanes` 发来的一条(C3:由就绪索引里 `kind: 'stream'` 的层合成) */
export interface StreamPlaneRequest {
  /** 长度 1 = 单卡流或依赖下层的流(看 `plane`);> 1 = 组流(按画家顺序,最后一个在最上面) */
  clipIds: string[];
  /**
   * `"stage"`:这条只有一张卡的流是按**舞台坐标**产的(依赖下层的流,清单的 `kind` 是 `below`;契约
   * `prerender-products-contract.md` 第 5.4 节)。它的画布挂在舞台根下(和组流同一种平面),不挂进包裹层:包裹层的位置、
   * 不透明度、强调都已经画进流里。流里只有目标卡改动过的那一层(预乘色加不透明度),照普通的叠加盖在舞台上活着的下层上面。
   * 组流不用带(成员多于一张就是舞台坐标)。
   */
  plane?: "stage";
  /** 流键(就绪索引里那一层的 `key`) */
  key?: string;
  /** 就绪的**分段号**闭区间(C3 的 `stream` 表单位是分段号) */
  ranges?: Array<[number, number]>;
  /**
   * 这条流自己的第一帧(项目帧号):分段从它起每 15 帧一段。来自就绪索引那一层(桌面)/ 层表那一行(在线),
   * 都是计划的一侧按当前项目给的。没有它的平面不建解码器、不画(`planesWithinBudget`)。
   */
  originFrame?: number;
  /**
   * 最低一档:这条流每个分段只解第一帧那一张,这一段的每一帧都贴它(文件头「最低一档」)。
   * 父页按档位带(`src/editor/snapshotFeed.ts`);不带就是照常逐帧解。
   */
  first?: true;
  /**
   * 这一拍超出预算(父页用 `planesWithinBudget` 判的,舞台照它办):舞台不为它建解码器、不画,只取它的清单,
   * 拿这一帧所在分段的位置矩形摆占位符。在线页面这种平面只带清单、不带字节。
   */
  over?: true;
  /**
   * 在线页面(`docs/plan/browser-stream-task.md` 第七处):这条流的清单由父页随流平面带过来,舞台不自己去取。
   * 带了它,这条流的字节也只从父页推来的块里拿(`PushedStreamSource`),不碰预渲染进程的地址。桌面不带,照旧。
   */
  manifest?: StreamManifest;
  /** 随这一次一起推来的块(哈希 → 字节):清单用到、而这台舞台手里还没有的开头文件与分段(`StreamPlaneSender` 算) */
  blocks?: Record<string, ArrayBuffer>;
}

export interface StreamManifest {
  streamKey: string;
  kind: "card" | "group" | "below";
  plane: "local" | "stage";
  clipIds: string[];
  fps: number;
  segmentFrames: number;
  /** 清单里记的第一帧(产这条流时它在项目的第几帧)。只作记录:播放时的换算用流平面带来的 `originFrame` */
  originFrame?: number | null;
  bound: StreamRect;
  tight: StreamRect | null;
  /** 单卡流:包裹层的框在隔离工程里摆到哪儿(平面坐标加它是那份工程的舞台坐标);按舞台坐标产的流是零 */
  offset?: { x: number; y: number } | null;
  /** `hash`:在线页面推来的清单才有,开头文件的内容哈希(字节按它在推来的块里找) */
  inits: Record<string, { codec: string; width: number; height: number; rect: StreamRect; hash?: string }>;
  /** `file`:桌面是分段的文件名;在线页面推来的清单里是分段的内容哈希(两种都是「换了内容就换名」) */
  /** `box`:产稀疏版时这个分段量到的位置矩形(收紧的框,平面坐标);没量过的分段不带。占位符照它摆 */
  segments: Record<string, { init: string; file: string; stride: number; samples: number; box?: StreamRect | null }>;
}

/* ======================================================================== *
 * fMP4 解封装
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

/** init.mp4 → 解码器配置要的东西。**`codec` 从 `avcC` 拼** */
export function parseInit(buf: ArrayBuffer): { codec: string; description: Uint8Array; width: number; height: number } {
  const view = new DataView(buf);
  const avcC = findBox(view, "avcC", 0, buf.byteLength);
  if (!avcC) throw new Error("init.mp4 里没有 avcC");
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

/** 一个分段(moof + mdat)→ 样本表。`default-base-is-moof`:偏移以 moof 起点为基 */
export function parseSegment(buf: ArrayBuffer): SegmentSample[] {
  const view = new DataView(buf);
  const moof = boxesOf(view, 0, buf.byteLength).find((b) => b.type === "moof");
  if (!moof) throw new Error("分段里没有 moof");
  const tfhd = findBox(view, "tfhd", moof.start + moof.header, moof.end);
  const trun = findBox(view, "trun", moof.start + moof.header, moof.end);
  if (!tfhd || !trun) throw new Error("分段里没有 tfhd / trun");
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

/** G5:`timestamp = (originFrame + 分段号 × 15 + 样本序号) × 1e6 / fps` = 项目帧号 × 1e6 / fps */
export const chunkTimestamp = (frame: number, fps: number): number => Math.round((frame * 1e6) / fps);
export const frameOfTimestamp = (timestamp: number, fps: number): number => Math.round((timestamp * fps) / 1e6);

/** 就绪区间里有没有这一段 */
export function rangesHave(ranges: ReadonlyArray<readonly number[]> | undefined, n: number): boolean {
  for (const r of ranges ?? []) if (r[0] <= n && n <= r[1]) return true;
  return false;
}

/**
 * 父页那一侧的纯算(C3 末段):就绪索引里 `kind: 'stream'` 的层 → `setStreamPlanes` 的实参。
 * 有 `groupClipIds` 的一条 `{ clipIds: groupClipIds }`、没有的 `{ clipIds: [clipId] }`;依赖下层的流那一层带着 `plane: "stage"`,原样带过去;
 * 只给**这一刻被抑制**、而且这一段已经就绪的卡(播放中贴流,K5)。「这一段」按每一层自己的 `originFrame` 换算;
 * 没带 `originFrame` 的层(改分段规则之前的生产者发的)不出流平面。
 * 父页在发 `setSuppressed(H(t))` 的同一处调它(见报告:这一处在 `src/editor/`,不在本任务可改的文件里)。
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
 * 这一层(就绪索引里 `kind: 'stream'` 的层)在项目的第 `globalFrame` 帧有没有就绪的分段。父页判「这一帧有没有流」只走这一处,
 * 舞台的播放器用同一份换算(`./streamSegments.mjs`)。没带 `originFrame` 的层一律算没有。
 */
export function streamLayerHas(layer: { ranges?: ReadonlyArray<readonly number[]>; originFrame?: number }, globalFrame: number): boolean {
  if (!isStreamOrigin(layer.originFrame)) return false;
  return rangesHave(layer.ranges, streamSegmentOf(globalFrame, layer.originFrame));
}

/**
 * 同屏流的预算(兜底顺序第 1、2 步的预算,mechanism/rendering.md「兜底顺序」):这一拍**真的会建解码器**的那几条平面。
 *
 * 只收有流键、带着第一帧(`originFrame`)的(没有键的只占位、不解码;没有第一帧的没法把帧号换成分段号)、没标 `over` 的。
 * 预算的口径在 `./streamBudget.mjs`:同屏 6 条以内不看像素(原来放得过的照样放得过);超过 6 条,每条流的开销(编码画幅乘帧率)
 * 加起来不超过像素预算;条数另有硬上限。
 * `pixelsOf` 给每条平面的编码画幅(父页按当前项目算,`snapshotFeed.ts` 的 `streamPixelsOf`);回不出正数的按一张 1920×1080 的满屏卡算。
 * 按传进来的顺序放:条数到了上限就停;某一条的像素放不下时跳过它接着看后面的(后面更小的还放得下)。
 *
 * **谁超预算由父页判**(`planFeed`):它把超出的平面标上 `over` 再发给舞台,自己也照这个结果决定哪些卡算「有流盖着」。
 * 舞台不重算像素(它手里没有项目的框),照父页标的办,只用这个函数守住条数的硬上限(`STAGE_PLANE_PIXELS`)。
 * 画布还没挂上的平面照样占着它的预算(父页不知道画布到没到),那一拍按流 blank 处理。
 *
 * `budget`:不给就是产品的那一组数;最低一档给 `sparseStreamBudget()`、`fps` 传 `STREAM_BUDGET_MIN_FPS`(`./streamBudget.mjs` 文件头)。
 */
export function planesWithinBudget<P extends { clipIds?: readonly string[]; key?: string; originFrame?: number; over?: boolean }>(
  planes: readonly P[], fps = 30, pixelsOf: (plane: P) => number | null | undefined = () => undefined, budget: StreamBudget = undefined,
): P[] {
  const valid = planes.filter((p) => Array.isArray(p?.clipIds) && p.clipIds.length > 0 && typeof p.key === "string" && !!p.key && isStreamOrigin(p.originFrame) && !p.over);
  return withinStreamBudget(valid.map((p) => streamCost(pixelsOf(p), fps)), budget).map((i) => valid[i]);
}
/** 舞台一侧过 `planesWithinBudget` 时每条平面报的像素数:小到像素预算永远不会满,只剩条数的硬上限起作用 */
const STAGE_PLANE_PIXELS = () => 1;

/** 这条平面的画布是不是挂在舞台根下、按舞台坐标画的那一种:组流,和依赖下层的流 */
export function stagePlane(plane: { clipIds?: readonly string[]; plane?: string } | null | undefined): boolean {
  return (plane?.clipIds?.length ?? 0) > 1 || plane?.plane === "stage";
}

/* ======================================================================== *
 * 字节从哪来
 * ======================================================================== */

export interface StreamSource {
  manifest(key: string, signal?: AbortSignal): Promise<StreamManifest>;
  init(key: string, id: string, signal?: AbortSignal): Promise<ArrayBuffer>;
  segment(key: string, file: string, signal?: AbortSignal): Promise<ArrayBuffer>;
}

declare global {
  interface Window {
    /** 探针用:把流的字节源指到别处(缺省是预渲染进程,和快照字节同源) */
    __pcStreamBase?: string;
  }
}

/** 预渲染进程的源。按需 import(`prerender.ts` 带 React hook,静态 import 会把它拖进这条路) */
const defaultBase = async (): Promise<string> => {
  if (typeof window !== "undefined" && typeof window.__pcStreamBase === "string") return window.__pcStreamBase;
  return (await import("./prerender.ts")).prerenderBase();
};

/** 本地模式:直连预渲染进程的 `/api/frames/stream/…`(和 C3 的快照字节同源) */
export class HttpStreamSource implements StreamSource {
  private base: () => Promise<string>;
  constructor(base: () => Promise<string> = defaultBase) { this.base = base; }
  private async get(path: string, init: RequestInit): Promise<Response> {
    const res = await fetch((await this.base()) + path, init);
    if (!res.ok) throw Object.assign(new Error(`轨道流还没就绪:${path}`), { status: res.status });
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
 * 在线页面:清单与字节由父页推来
 * ======================================================================== */

/**
 * 为什么在线页面的舞台不自己去素材服务取流的字节,而由父页取了传过来(2026-10-12 定,理由三条):
 *
 *   1. **隔离的跨源舞台取不到。** 它读素材只有自己源上的 `/media-s/<会话号>/media/<哈希>`(`src/online/stagePolicy.mjs` 的
 *      `MEDIA_S_PATH_PATTERN`),预渲染产物所在的 `px/` 不在放行的路径里;要放行得改策略文件、nginx 模板并重新部署舞台源。
 *   2. **票据不能进舞台的脚本。** `px/<哈希>` 要带只读票据的请求头;而收到过票据的舞台文档永久不执行用户卡与素材效果卡
 *      (`online/isolation/execGate.ts`)。让舞台带票据取流,就等于关掉在线执行。
 *   3. **父页本来就有这条路。** 层表、清单、候选的认定、票据续签、并发与超时都在父页的在线来源里(`snapshotSource.ts`);
 *      就绪区间按「字节已在父页」算,流平面发出去时字节跟着到,舞台不用自己等网络,流这一拍画不出来的情形只剩解码没跟上。
 *
 * 代价:每块字节多一次 postMessage 的结构化克隆(一段不超过 512 KB)。协议只借现有的 `setStreamPlanes`,不加新的消息种类:
 *
 *   父页 `StreamPlaneSender.decorate(planes)`:每条平面带上清单;块只带这台舞台还没有的。
 *   舞台 `PushedStreamSource.accept(planes)`:收下新块;**这一次的清单没用到的块当场丢掉**。
 *
 * 两边按同一条规矩记账(舞台手里的块 = 上一次那批清单用到的块),所以父页不用问舞台缺什么;一次调用失败(舞台在重载)父页清账重发。
 */

/** 一份清单用到的块的哈希(开头文件 + 分段);只列形状像哈希的 */
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
const missingBlock = (what: string) => Object.assign(new Error(`父页还没把这一块推过来:${what}`), { status: 404 });

/** 舞台一侧:字节源是父页随流平面推来的块 */
export class PushedStreamSource implements StreamSource {
  private manifests = new Map<string, StreamManifest>();
  private blocks = new Map<string, ArrayBuffer>();

  /** 父页的一次 `setStreamPlanes`:记下每条流的清单,收下新块,丢掉这一批清单没用到的块 */
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
    if (!m) throw missingBlock(`清单 ${key}`);
    return m;
  }
  async init(key: string, id: string): Promise<ArrayBuffer> {
    const hash = this.manifests.get(key)?.inits?.[id]?.hash;
    const buf = hash ? this.blocks.get(hash) : undefined;
    if (!buf) throw missingBlock(`开头文件 ${id}`);
    return buf;
  }
  async segment(_key: string, file: string): Promise<ArrayBuffer> {
    const buf = this.blocks.get(file);
    if (!buf) throw missingBlock(`分段 ${file}`);
    return buf;
  }
  /** 手里有没有这一块(探针、单测看) */
  has(hash: string): boolean { return this.blocks.has(hash); }
  get size(): number { return this.blocks.size; }
  get bytes(): number { let n = 0; for (const b of this.blocks.values()) n += b.byteLength; return n; }
}

/** 父页手里一条流的清单与字节(`OnlineSnapshotSource.streamPlane` 给) */
export interface StreamPlaneData {
  manifest: StreamManifest;
  blocks: ReadonlyMap<string, Uint8Array | ArrayBuffer>;
}

const toArrayBuffer = (bytes: Uint8Array | ArrayBuffer): ArrayBuffer => {
  if (!(bytes instanceof Uint8Array)) return bytes;
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
};

/**
 * 父页一侧:给**一台**舞台发流平面之前过一遍,带上清单和这台舞台还没有的块。一台舞台(一个 RPC 客户端)一个实例。
 * `lookup(key)` 回这条流此刻的清单与字节;回 null 的平面原样发(舞台那边这条流取不到清单,落到快照)。
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
      // 超出预算的平面舞台不解码:只带清单(占位符照它的位置矩形摆),不带字节,也不记进「舞台手里的块」
      if (p.over) { out.push({ ...base, manifest: data.manifest }); continue; }
      const blocks: Record<string, ArrayBuffer> = {};
      let added = 0;
      for (const hash of manifestBlockHashes(data.manifest)) {
        const bytes = data.blocks.get(hash);
        if (!bytes) continue;   // 清单列着而字节不在:舞台这一段取不到,那一拍落到快照
        next.add(hash);
        if (this.held.has(hash) || sending.has(hash)) continue;
        sending.add(hash);
        blocks[hash] = toArrayBuffer(bytes);
        added++;
      }
      out.push({ ...base, manifest: data.manifest, ...(added ? { blocks } : {}) });
    }
    // 舞台收到之后手里正好是这一批清单用到的块(见 `PushedStreamSource.accept`)
    this.held = next;
    return out;
  }
  /** 这一次没送到(舞台在换、回包丢了):清账,下一次全部重发 */
  reset(): void { this.held = new Set(); }
  /** 认为舞台手里有几块(单测看) */
  get heldCount(): number { return this.held.size; }
}

/* ======================================================================== *
 * WebGL 合成
 * ======================================================================== */

const VS = `attribute vec2 p; varying vec2 uv;
void main(){ uv = vec2((p.x + 1.0) * 0.5, (1.0 - p.y) * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
/*
 * 色半区是预乘色:直接输出,**钳一次 rgb ≤ a**(预乘色本来就必须满足的约束;G0-b (5):
 * 不钳时透明区的编码噪声原样输出,彩色杂点最高 146/255,钳后 59)。
 */
const FS = `precision mediump float; uniform sampler2D tex; uniform float alphaTop; uniform float half_;
varying vec2 uv;
void main(){
  vec3 rgb = texture2D(tex, vec2(uv.x, uv.y * half_)).rgb;
  float a = texture2D(tex, vec2(uv.x, alphaTop + uv.y * half_)).r;
  gl_FragColor = vec4(min(rgb, vec3(a)), a);
}`;

/** 共用的那块离屏画布:建不出来、或丢了上下文迟迟不还时,隔这么久(真实毫秒)再重建一次 */
export const GL_RETRY_MS = 1000;
/** 接连建不出来时每次把间隔加倍,最长到这么久(别空转) */
export const GL_RETRY_MAX_MS = 30000;

type GlCanvas = OffscreenCanvas | HTMLCanvasElement;
const newGlCanvas = (): GlCanvas | null => {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(2, 2);
  if (typeof document !== "undefined") return document.createElement("canvas");
  return null;
};

/**
 * **全部流平面共用的一个 WebGL 上下文**(一台舞台一个,`StreamPlayer` 拿着)。
 *
 * 为什么不是每块平面一个:浏览器一页最多给 16 个 WebGL 上下文,超出的把最早建的那个丢掉、不还
 * (`docs/reports/AGENT-rr-merged-eval.md` 第 4 节:24 层丢 8 个、30 层丢 14 个,丢了的层一帧没画);
 * 舞台里 canvas 卡的共享渲染器、卡片自己的 WebGL 也占名额。
 *
 * 做法:一块**不挂进文档**的离屏画布建上下文;每画一帧,把这一帧上传成纹理、照原来的着色器拆两半画到离屏画布的左上角
 * (`rect.w × rect.h`,一比一),平面自己的 2D 画布当场 `drawImage` 取走。选它而不选 `transferToImageBitmap` 加
 * `bitmaprenderer`:后者每次交出去都要给离屏画布重新分配一块后备缓冲,各平面尺寸不同还得每帧改离屏画布的尺寸;
 * 2D 取走是显卡上的一次拷贝,离屏画布只长不缩。画面与每块平面一个上下文时逐像素相同(同一份报告第 4 节,差 0):
 * 离屏画布按预乘色输出(`premultipliedAlpha: true`),2D 画布内部存的也是预乘色,先清空再一比一不缩放地画上去,数值原样过去。
 * 离屏画布不留绘图缓冲(`preserveDrawingBuffer: false`):每次都是先把要的那一块整块画满、同一个任务里当场取走,用不着留;
 * 留着的话每次取走都多一份拷贝(`scripts/probes/stream-budget-probe.mjs` 量的:同屏 30 条小卡流每拍 4.2 毫秒对 3.1 毫秒)。
 *
 * 代价(同一支探针,30 帧每秒、704×864 的小卡流,每拍 `present` 的平均毫秒,前面是每块平面一个上下文):1 条 0.20 对 0.28,
 * 6 条 0.57 对 0.80,16 条 1.24 对 1.65;30 条时原来的画法丢 14 个上下文、14 块平面是空的,共用以后 30 块都画、2.74。
 * 折下来每条流每拍多 0.03～0.08 毫秒(多出来的是离屏画布到 2D 画布那一次取走;各轮的数见 `docs/reports/AGENT-rr-pixel-budget.md`)。
 * 还能省:一拍里的各条先画进一张图集、再一起取走(评估报告量的那种画法,每拍基本不多花),没有做。
 *
 * 上下文丢了(显卡进程重启、名额被别的画布挤掉):平面的 2D 画布不受影响,上一张画面还在;这期间新的一帧画不上,
 * 照「这一拍画不出来」办(留着上一张、到时占位符)。浏览器还回来(`webglcontextrestored`)就重建着色器和纹理;
 * `GL_RETRY_MS` 以后还没还(被挤掉的不还)就扔掉这块离屏画布另建一块;另建也没建出来的,隔一会儿再试(间隔每次加倍,最长
 * `GL_RETRY_MAX_MS`)。每一种都约播放器到点把这一帧再走一遍(暂停着没有下一拍)。
 */
class SharedGl {
  private canvas: GlCanvas | null = null;
  private gl: WebGLRenderingContext | null = null;
  private tex: WebGLTexture | null = null;
  private uAlphaTop: WebGLUniformLocation | null = null;
  private uHalf: WebGLUniformLocation | null = null;
  private lostAt: number | null = null;
  private failedAt: number | null = null;
  /** 接连建不出来几次了(建成一次清零);下一次隔多久再试按它加倍 */
  private failures = 0;
  private onLost: () => void;
  private onBack: () => void;
  private onRetry: (ms: number) => void;
  stats = { creates: 0, losses: 0, restores: 0, failures: 0, draws: 0, lastError: "" };

  /** `onRetry(ms)`:这一刻画不了,过 `ms` 毫秒值得再试一次(播放器据此排一个真定时器把这一帧再走一遍;暂停着没有下一拍) */
  constructor(onLost: () => void, onBack: () => void, onRetry: (ms: number) => void) {
    this.onLost = onLost;
    this.onBack = onBack;
    this.onRetry = onRetry;
  }

  private get retryMs(): number { return Math.min(GL_RETRY_MAX_MS, GL_RETRY_MS * 2 ** Math.max(0, this.failures - 1)); }

  /** 着色器、顶点、纹理(新建上下文和上下文还回来以后各做一次) */
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
      // 丢了:先等浏览器还;等够了还没还(被别的画布挤掉的不还)就另建
      const waited = now - (this.lostAt as number);
      if (waited < GL_RETRY_MS) { this.onRetry(GL_RETRY_MS - waited); return null; }
      this.drop();
    }
    // 上一次没建出来:隔一会儿再试(接连失败间隔加倍);这期间有人要画,就约好到点再走一遍
    if (this.failedAt !== null && now - this.failedAt < this.retryMs) { this.onRetry(this.retryMs - (now - this.failedAt)); return null; }
    try {
      const canvas = newGlCanvas();
      const gl = canvas?.getContext("webgl", { premultipliedAlpha: true, alpha: true, preserveDrawingBuffer: false, antialias: false }) as WebGLRenderingContext | null;
      if (!canvas || !gl) throw new Error("轨道流拿不到 WebGL 上下文");
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
   * 把一帧(上下拼合)拆两半、合成预乘色,画到离屏画布左上角的 `w × h`(一比一)。回离屏画布,调用方**当场**取走那一块;
   * 画不了(没有上下文、上下文丢着)回 null。`w`、`h` 是这一帧所在变体的矩形的宽高。
   */
  render(frame: VideoFrame, w: number, h: number): GlCanvas | null {
    const gl = this.ensure();
    const c = this.canvas;
    if (!gl || !c) return null;
    // 只长不缩:改 WebGL 画布的尺寸要重新分配后备缓冲
    if (c.width < w) c.width = w;
    if (c.height < h) c.height = h;
    const total = frame.displayHeight || frame.codedHeight;
    // WebGL 的原点在左下:画布左上角的 w × h
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

  /** 舞台退到 `back`:离屏画布缩回最小(放掉后备缓冲),上下文留着,下一次当 `front` 不用重建 */
  shrink(): void {
    const c = this.canvas;
    if (!c || this.lostAt !== null) return;
    if (c.width !== 2) c.width = 2;
    if (c.height !== 2) c.height = 2;
  }

  get state(): "none" | "ready" | "lost" { return !this.gl ? "none" : this.lostAt !== null ? "lost" : "ready"; }
}

/** 一块流平面:自己只有一个 2D 上下文,合成在共用的 `SharedGl` 里做 */
class PlaneCompositor {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private shared: SharedGl;
  private blank = true;
  constructor(canvas: HTMLCanvasElement, shared: SharedGl) {
    this.canvas = canvas;
    this.shared = shared;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("轨道流平面拿不到 2D 上下文");
    this.ctx = ctx;
  }
  /** 画布的位置和尺寸 = 流的矩形上界(平面坐标)。只在变了的时候写 */
  place(bound: StreamRect): void {
    const c = this.canvas;
    if (c.width !== bound.w) c.width = bound.w;
    if (c.height !== bound.h) c.height = bound.h;
    const s = c.style;
    const want: Record<string, string> = { left: `${bound.x}px`, top: `${bound.y}px`, width: `${bound.w}px`, height: `${bound.h}px` };
    for (const [k, v] of Object.entries(want)) if (s.getPropertyValue(k) !== v) s.setProperty(k, v);
  }
  /**
   * 画一帧。`rect` 是这一帧所在变体的矩形(平面坐标),`bound` 是画布覆盖的矩形。共用的上下文这一刻画不了回 false,
   * **画布上原来那一张原样不动**:画布的位置和尺寸是画得了才改的(改 2D 画布的宽高会把它清空;清单的 `bound` 变了而上下文丢着时,
   * 先改尺寸的话上一张就没了,账上却还记着有画面)。
   */
  draw(frame: VideoFrame, rect: StreamRect, bound: StreamRect): boolean {
    const src = this.shared.render(frame, rect.w, rect.h);
    if (!src) return false;
    this.place(bound);
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    // 一比一、不缩放:离屏画布左上角的 rect.w × rect.h 原样搬到平面上这一帧的矩形里
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
 * 一条流
 * ======================================================================== */

interface HeldFrame { frame: VideoFrame; segment: number }
/** `rect`:拉这一份字节时清单里它那个变体的矩形(之后清单换了、这一段换成别的变体,手里这份解出来的帧仍按它摆) */
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
   * 画布上现在这一张的另一份引用。包裹层被按片段重挂载(停下追帧的起步)时画布会换成一块新的、空的,
   * 靠它把刚才那张原样画回去,不等解码;换了画面 / 清空时关掉。
   */
  private shown: { frame: VideoFrame; f: number } | null = null;
  private wantFrame: number | null = null;
  /** `wantFrame` 换成现在这个值的真实时刻 */
  private wantAt = 0;
  /** 在途的那一次寻帧要解到哪一帧(解出这一帧或更后的帧就清掉)和它发起的真实时刻 */
  private seekTarget: number | null = null;
  private seekAt = 0;
  /** 这一次寻帧以来喂给解码器几块了。一块都还没喂(字节没到、解码器没建)时换目标不花什么,不用让着它 */
  private fedSinceSeek = 0;
  /** 寻帧之后还没把要的画面画出来(量「从要这一帧到画出来」用) */
  private seeking = false;
  /** 最近一次寻帧:要的哪一帧、从要到画出来的毫秒(只记录;探针量随机跳帧的解码耗时) */
  private lastSeek: { frame: number; ms: number } | null = null;
  /** 稀疏段的替身:寻帧时,不晚于目标帧的最近一张是这一帧 —— 它一解出来就先画上 */
  private standIn: number | null = null;
  /** 画着的不是要的那一张,从什么时候起(真实毫秒);画上要的那一张就清掉 */
  private staleSince: number | null = null;
  private staleTimer = false;
  private refreshTimer = false;
  /** 喂进解码器、还没出来的帧数(`decodeQueueSize` 只数还没交给解码器的,解码器里正在解的不算) */
  private pending = 0;
  private pumpQueued = false;
  private disposed = false;
  /** 最低一档:送去解、还没出来的那一块是哪一帧(分段的第一帧),和送的真实时刻 */
  private firstFed: number | null = null;
  private firstFedAt = 0;
  /** 最低一档:解码器连着报错几次了(解出一帧就清零) */
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

  /** 父页随平面带来的清单:直接用,不去问字节源 */
  private adoptPushed(manifest: StreamManifest): void {
    this.manifest = manifest;
    this.manifestAt = realNow();
    this.placeBlank(manifest.bound);
  }

  /**
   * 清单到了:把**还没有画面的**画布摆到流的矩形上界(被抑制的卡要有一块能点中的框)。上面已经有画面的不动 ——
   * 改宽高会清空它;下一次画得上的时候 `PlaneCompositor.draw` 自己会摆。
   */
  private placeBlank(bound: StreamRect): void {
    if (this.lastDrawn !== null) return;
    this.ensureCompositor()?.place(bound);
  }

  /** 这条流的字节从哪来:带了清单的平面只认父页推来的块,否则是播放器的字节源(桌面:预渲染进程) */
  private get bytes(): StreamSource { return this.plane.manifest ? this.player.pushed : this.player.source; }

  get key(): string { return this.plane.key ?? ""; }
  private get fps(): number { return this.manifest?.fps || this.player.fps; }
  /** 这条流自己的第一帧(项目帧号);播放器只收带着它的平面(`StreamPlayer.setPlanes`) */
  private get origin(): number { return this.plane.originFrame as number; }
  /** 项目帧号 → 这条流的分段号(早于第一帧的是负数,就绪区间里不会有) */
  private segmentOf(f: number): number { return streamSegmentOf(f, this.origin); }
  /** 这个分段的第一帧(项目帧号) */
  private segmentStart(seg: number): number { return streamSegmentFirstFrame(seg, this.origin); }
  /** 最低一档:每个分段只解第一帧(父页随流平面带的 `first`) */
  private get firstOnly(): boolean { return this.plane.first === true; }
  /** 此刻占着解码器输出池的帧:手里没关的 + 喂进去还没出来的 + 画布上那一张(它已经不在手里时另算一块) */
  get heldCount(): number { return this.frames.size + this.pending + (this.shown && !this.frames.has(this.shown.f) ? 1 : 0); }

  private ensureCompositor(): PlaneCompositor | null {
    if (this.compositor && this.compositor.canvas === this.canvas) return this.compositor;
    try { this.compositor = new PlaneCompositor(this.canvas, this.player.gl); }
    catch (e) { this.compositor = null; this.stats.lastError = String((e as Error)?.message || e); }
    return this.compositor;
  }

  /**
   * 异步的料(清单 / init / 分段)到了:按这一拍要的帧再走一遍 `present`。暂停 / 拖动时没有下一拍来叫它,
   * 不这样的话随机访问会停在「清单刚到、还没开始解」那一步。同一个微任务里只走一次。
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
   * 同一个流键的就绪区间变了(生产者发布了新分段):下一次 `present` 允许再问一次清单(疑点 G)。
   * 真的发出去了才清掉 —— 被节流挡回来的话留着,下一拍再试。
   */
  private manifestDirty = false;

  /**
   * 清单:没有就拉;`force` 时隔 2 秒以上再拉一次(分段会被替换:稀疏 → 满帧)。
   * 回这一次有没有真的发起。
   */
  private loadManifest(force = false): boolean {
    // 清单由父页推来的流:没有可问的地方,等父页下一次带新的来(`setPlane`)
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
        // 清单一到就把画布摆到流的矩形上界:还没画出第一帧时,被抑制的卡也要有一块能点中的框
        this.placeBlank(m.bound);
        this.wake();
      })
      .catch(() => { /* 还没就绪:这一层这一拍落到兜底顺序的下一步(快照 / 占位符),下一拍再说 */ })
      .finally(() => { this.manifestLoading = null; });
    return true;
  }

  /** 一个 init(变体)的解码器配置 */
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

  /** 分段整段拉,每流最多 2 个在途 */
  private loadSegment(n: number): void {
    if (this.segments.has(n) || this.fetching.has(n) || this.fetching.size >= MAX_INFLIGHT_PER_STREAM || !this.manifest) return;
    const meta = this.manifest.segments[String(n)];
    if (!meta) return;
    const work = this.bytes.segment(this.key, meta.file)
      .then((buf) => {
        if (this.disposed) return;
        this.segments.set(n, { buf, samples: parseSegment(buf), init: meta.init, file: meta.file, rect: this.manifest?.inits[meta.init]?.rect ?? null });
        // 留当前段和它前后各一段,别的扔掉
        for (const k of [...this.segments.keys()]) if (Math.abs(k - n) > 2) this.segments.delete(k);
        this.wake();
      })
      .catch(() => {
        // 被替换删掉了(G6)或者还没就绪:下一次按新清单拉
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
          // 最低一档:送去的那一块没了,记一次失败;没到上限就按此刻要的那一帧再送一次(暂停着没有下一拍来叫)
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
    // 在途的那一次寻帧解到了
    const reached = this.seekTarget !== null && f >= this.seekTarget;
    if (reached) this.seekTarget = null;
    if (this.disposed) {
      frame.close();
    } else {
      // 稀疏段的替身:此刻要的那一帧和它是同一张画面,先画上(下面照常处理这一帧:多半比目标帧早,画完就关)
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
        // 随机访问:目标帧出来了就立刻画,不等下一拍
        if (this.wantFrame === f) this.drawAt(f);
        /*
         * 寻帧期间目标又换了(连着拖):解出来的这一帧先画上,画面跟着走;下面再按此刻要的那一帧重新寻。
         * 还没有画面时只画「够新」的(`FIRST_PICTURE_LAG_MS`):宿主等第一张画面出来才藏活子树。
         */
        else if (reached && (this.lastDrawn !== null || realNow() - this.seekAt <= FIRST_PICTURE_LAG_MS)) this.drawAt(f);
      }
    }
    if (reached && !this.disposed && this.wantFrame !== null && this.wantFrame !== f) this.wake();
    // 腾出了位置:接着喂(暂停态没有下一拍来叫它,随机访问要一路解到目标帧)
    if (!this.pumpQueued && !this.disposed) {
      this.pumpQueued = true;
      queueMicrotask(() => { this.pumpQueued = false; this.pump(); });
    }
  }

  /** 手里解好的帧全部放掉、解码器重置(下一块必须是关键帧) */
  private resetDecode(): void {
    for (const h of this.frames.values()) h.frame.close();
    this.frames.clear();
    if (this.decoder && this.decoder.state !== "closed") {
      try { this.decoder.reset(); } catch { /* 已经坏了 */ }
    }
    this.pending = 0;
    this.configuredInit = null;
    this.seekTarget = null;
    this.standIn = null;
    this.fedSinceSeek = 0;
    this.firstFed = null;
  }

  /** 跳段 / 起步:从目标所在分段的 IDR 起解,目标之前的帧一出来就关 */
  private seek(f: number): void {
    this.stats.seeks++;
    this.resetDecode();
    this.nextFeed = this.segmentStart(this.segmentOf(f));
    this.discardBefore = f;
    this.seekTarget = f;
    this.seekAt = realNow();
    this.seeking = true;
    // 稀疏段:这一帧和不晚于它的最近一张是同一张画面,那一张先解出来(离关键帧更近)
    const picture = this.pictureOf(f);
    this.standIn = picture !== f ? picture : null;
  }

  /**
   * 这一帧所在分段的变体矩形。手里有这一段的字节时用拉它时记下的矩形:清单重问以后这一段可能已经换成别的变体
   * (稀疏版按上界产、满密度按收紧矩形产),而换文件只在分段起点做(`pump`),段中间画的还是手里这份解出来的帧。
   */
  private rectOf(f: number): StreamRect | null {
    const held = this.segments.get(this.segmentOf(f));
    if (held?.rect) return held.rect;
    const seg = this.manifest?.segments[String(this.segmentOf(f))];
    const init = seg ? this.manifest!.inits[seg.init] : null;
    return init?.rect ?? null;
  }

  /**
   * 项目的第 F 帧在这条流里是哪一张画面(项目帧号)。满密度的分段就是它自己;稀疏分段(清单里 `stride` 大于 1)里每 `stride` 个样本
   * 是同一张,取不晚于这一帧的最近一张 —— **只往回找**,不拿后面的。`stride` 不整除分段帧数时不认(没法确定重复是从哪一个样本数起的),
   * 当成每个样本各是一张,照样解到这一帧自己。
   */
  private pictureOf(f: number): number {
    // 最低一档:不管这一段多密,都是分段第一帧那一张
    if (this.firstOnly) return streamFirstFrameOf(f, this.origin);
    const seg = this.segmentOf(f);
    const stride = this.manifest?.segments[String(seg)]?.stride ?? 1;
    if (!(stride > 1) || SEGMENT_FRAMES % stride !== 0) return f;
    const start = this.segmentStart(seg);
    return start + Math.floor((f - start) / stride) * stride;
  }

  /** 画布上现在这一张是不是第 F 帧该有的画面(稀疏段里同一张画面管好几帧) */
  private fresh(f: number): boolean {
    return this.lastDrawn !== null && this.pictureOf(this.lastDrawn) === this.pictureOf(f);
  }

  private closeShown(): void {
    if (!this.shown) return;
    try { this.shown.frame.close(); } catch { /* 已经关了 */ }
    this.shown = null;
  }

  /**
   * 清单说的坐标系和这块画布对得上:清单写着 `stage` 的流只画在舞台根下的画布上,写着 `local` 的只画在包裹层里的画布上。
   * 对不上(父页没说这是依赖下层的流、而清单是)就不画 —— 画上去位置和外观都是错的,宁可落到占位符。清单没写的照旧画。
   */
  private get planeFits(): boolean {
    const said = this.manifest?.plane;
    if (said !== "stage" && said !== "local") return true;
    return (said === "stage") === stagePlane(this.plane);
  }

  /** 把一帧画到平面上(这一帧记在项目的第 `f` 帧上) */
  private drawFrame(frame: VideoFrame, f: number): boolean {
    const rect = this.rectOf(f);
    const compositor = this.ensureCompositor();
    if (!rect || !compositor || !this.manifest || !this.planeFits) return false;
    // 共用的上下文这一刻画不了(丢着):当这一拍没画上,留着上一张(画布的位置和尺寸也不动,见 `PlaneCompositor.draw`)
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
      // 画上的是在途那一次寻帧的结果,不是此刻要的那一张:算有了新画面,留多久从这一刻重新算
      this.staleSince = realNow();
    }
    if (was === null) this.player.noteShowing();
    return true;
  }

  private drawAt(f: number): boolean {
    const held = this.frames.get(f);
    return held ? this.drawFrame(held.frame, f) : false;
  }

  /** 画布换了一块(包裹层重挂载):把刚才那张原样画回去。画不了回 false */
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
   * 这一拍要的画面没画上:留着上一张,最多留一个分段的时长(`HOLD_FRAMES`,真实时间);到时还没有新画面就清空,
   * 这一层落到占位符(mechanism/rendering.md「兜底顺序」)。第一次进来时排一个真定时器 —— 暂停着没有下一拍,
   * 不排的话旧画面会一直留着。本来就没有画面的,保持清空。
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

  /** 这一拍流画面在不在(画了、或留着上一张)。占位符 T1 按它判 */
  get showing(): boolean { return this.lastDrawn !== null; }

  /** 这一拍画的是满帧段还是稀疏段(兜底顺序第 1 / 2 步;探针按它分级)。没画面时 null */
  get level(): "dense" | "sparse" | null {
    if (this.lastDrawn === null) return null;
    // 最低一档贴的一律是分段第一帧那一张(照稀疏版的样子),不看清单里这一段多密
    if (this.firstOnly) return "sparse";
    const meta = this.manifest?.segments[String(this.segmentOf(this.lastDrawn))];
    return (meta?.stride ?? 1) > 1 ? "sparse" : "dense";
  }

  /** 实体框(清单的收紧矩形,没有就用上界;平面坐标)。占位符的几何按它摆 */
  get box(): StreamRect | null { return this.manifest ? this.manifest.tight ?? this.manifest.bound : null; }

  /** 这一拍:画第 F 帧(或留着上一张 / 到时清成透明),再往后多解几帧 */
  present(f: number): void {
    // 停在同一帧上又来一次(暂停着:料到了、定时器到了、父页重发了流平面)
    const again = this.wantFrame === f;
    if (!again) this.wantAt = realNow();
    this.wantFrame = f;
    const seg = this.segmentOf(f);
    if (!rangesHave(this.plane.ranges, seg)) {
      // 这一段还没就绪:这一层落到兜底顺序的下一步(留着上一张,到时占位符),播放头不停
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
     * 疑点 G:以前只在分段缺失或拉取失败时才再问清单 —— 稀疏段被满帧段替换之后,生产者发的就绪区间
     * 一个字不变,页面就一直用着稀疏段(旧文件还在 HTTP 缓存里,拉取也不失败)。现在当前段是稀疏段、
     * 或者同一个流键的就绪区间变了,就按 `MANIFEST_REFRESH_MS` 的节流再问一次;换上的满帧段在
     * 分段边界接上(`pump` 里比对文件名),不在段中间换,免得接到别的编码的差分帧上。
     */
    const sparse = (meta.stride ?? 1) > 1;
    if (this.manifestDirty || sparse) {
      if (this.loadManifest(true)) this.manifestDirty = false;
    }
    // 往回跳(比已经放掉的帧还早)或者往前跳太远(超出已喂进去的一段):从目标所在分段的 IDR 重新解
    let far = this.nextFeed === null || f < this.discardBefore || f > this.nextFeed + SEGMENT_FRAMES;
    /*
     * 停在同一帧上、而手里这一段的文件已经被换掉了(稀疏 → 满密度):从新文件把这一帧重解一遍,更好的结果自己换上。
     * 播放中每拍的帧号都在变,不走这里 —— 段中间不换(上面那一条)。
     */
    const data = this.segments.get(seg);
    if (again && !far && data && data.file !== meta.file) {
      this.segments.delete(seg);
      far = true;
    }
    if (far) {
      if (this.seekTarget !== null && this.seekTarget !== f && this.fedSinceSeek > 0 && realNow() - this.seekAt < SEEK_PATIENCE_MS) {
        /*
         * 连着跳(拖动):上一次寻帧已经在解了,不打断它 —— 每一步都重置解码器,一帧也解不出来,画面就不动了。
         * 它解到之后先画上(`onFrame`),再按那时要的那一帧重新寻(`wake`);这中间要过的帧都不解。
         * 接着喂的目标是在途的那一帧(`pump`)。上一次还一块都没喂进去(字节没到)的不让:直接换成这一帧。
         */
        this.stats.deferred++;
        this.miss();
        this.pump();
        return;
      }
      this.seek(f);
    }
    if (!this.drawAt(f)) {
      // 没解出来。画布上那一张就是这一帧该有的画面(稀疏段里同一张管好几帧)不算缺;否则留着上一张,限时
      if (this.fresh(f)) this.staleSince = null;
      else this.miss();
    }
    this.releaseBefore(f);
    this.pump();
    if (sparse) this.armRefresh();
  }

  /**
   * 最低一档的一拍(文件头「最低一档」):这一帧所在分段的第一帧那一张已经在画布上就什么都不做;在手里就画;都不在就把那一个关键帧送去解,
   * 这一拍留着上一张(限时,同别的档)。`present` 已经确认过这一段就绪、清单里有它。
   */
  private presentFirst(seg: number): void {
    const p = this.segmentStart(seg);
    // 不是这一段第一帧的解码输出都不要了(往回拖、跳走以后才出来的)
    for (const [k, h] of this.frames) if (k !== p) { h.frame.close(); this.frames.delete(k); }
    if (this.manifestDirty && this.loadManifest(true)) this.manifestDirty = false;
    if (this.lastDrawn === p) { this.staleSince = null; this.releaseFirst(p); return; }
    if (this.drawAt(p)) { this.releaseFirst(p); return; }
    this.miss();
    this.feedFirst(seg, p);
  }

  /** 最低一档:画上了,解码输出当场关掉(画布换一块时靠 `shown` 那一份引用画回去) */
  private releaseFirst(p: number): void {
    const held = this.frames.get(p);
    if (!held) return;
    held.frame.close();
    this.frames.delete(p);
  }

  /** 最低一档:把第 `seg` 段的第一个样本(关键帧)送去解。字节、开头文件没到就先去取,到了会再走一遍 `present` */
  private feedFirst(seg: number, p: number): void {
    if (this.disposed || !this.manifest || this.firstFailures >= FIRST_FRAME_MAX_FAILURES) return;
    if (this.firstFed !== null) {
      // 有一块在解:同一个解码器同时只解一块。它出来以后(`onFirstFrame`)按那时要的那一帧再来;卡住太久就重置
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
    // 清单里这一段换了文件(稀疏 → 满密度):第一帧是同一张画面,手里有旧的就接着用,不为它再取一次
    if (!data) { this.loadSegment(seg); return; }
    const init = this.inits.get(data.init);
    if (!init) { this.loadInit(data.init); return; }
    const sample = data.samples[0];
    if (!sample || !sample.isSync) { this.firstFailures = FIRST_FRAME_MAX_FAILURES; this.stats.errors++; this.stats.lastError = "segment does not start with a key frame"; return; }
    if (!this.decoder || this.decoder.state === "closed") {
      this.decoder = this.newDecoder();
      this.configuredInit = null;
      // 浏览器没有 `VideoDecoder`:这条流贴不了,落到占位符(父页在最低一档本来就不该发来,`snapshotSource.ts` 的 `decodeSupport`)
      if (!this.decoder) { this.firstFailures = FIRST_FRAME_MAX_FAILURES; return; }
    }
    const decoder = this.decoder;
    try {
      if (this.configuredInit !== data.init) {
        // 手机上不指定硬解:硬件解码器开不出来时让浏览器自己退到软解
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
      // 只喂了这一块:叫解码器把它吐出来(有的解码器要等后面的块才出帧)。`flush` 之后下一块必须是关键帧,这一档喂的都是
      if (typeof decoder.flush === "function") void decoder.flush().catch(() => { /* 被重置 / 关掉了 */ });
    } catch (e) {
      this.pending = 0;
      this.firstFed = null;
      this.firstFailures++;
      this.stats.errors++;
      this.stats.lastError = String((e as Error)?.message || e);
      try { if (decoder.state !== "closed") decoder.close(); } catch { /* 已经坏了 */ }
      if (this.decoder === decoder) { this.decoder = null; this.configuredInit = null; }
    }
  }

  /** 最低一档:送去解的那一块出来了。还是此刻要的那一张就画上、关掉;不是(播放头已经走到别的分段)就关掉,按此刻要的再来 */
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
    // 画不上(共用的上下文丢着)就先留在手里,下一拍 / 上下文回来时再画
    if (this.drawAt(f)) this.releaseFirst(f);
  }

  /**
   * 停在稀疏段上:隔一会儿自己再问一次清单。满密度的分段产出来以后换上,不等用户操作(product/rendering.md「兜底顺序」);
   * 就绪区间不会因为这一步变,父页不会来叫。清单由父页推来的流不用(父页带着新清单重发流平面时会再走一遍 `present`)。
   */
  private armRefresh(): void {
    if (this.refreshTimer || this.plane.manifest) return;
    this.refreshTimer = true;
    realTimeout(() => {
      this.refreshTimer = false;
      if (this.disposed || this.wantFrame === null) return;
      // 这一会儿播放头没动(暂停着):再走一遍(问清单、换文件;还是稀疏的话 `present` 会再排下一次)。
      // 还在动(播放、拖动)就不插手 —— 但要接着排:它一停下就没有人再来叫了
      if (realNow() - this.wantAt >= MANIFEST_REFRESH_MS) this.present(this.wantFrame);
      else this.armRefresh();
    }, MANIFEST_REFRESH_MS + 50);
  }

  /** 放掉目标之前的帧;之后才解出来的更早的帧一出来就关(`discardBefore` 只增不减) */
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

  /** 往解码器里喂:喂到「持有 + 队列里的」达到本流的配额,或者看得够远了 */
  pump(): void {
    if (this.disposed || this.nextFeed === null || !this.manifest || this.wantFrame === null) return;
    const cap = this.player.capFor(this);
    /*
     * 喂到哪:平时往此刻要的那一帧后面多看两个分段。有在途的寻帧、而此刻要的已经是别的帧(连着拖)时,只喂到在途的那一帧为止 ——
     * 它一解到就要按此刻要的那一帧重新寻,多喂的都白解,还会白取后面的分段。
     */
    const chasing = this.seekTarget !== null && this.seekTarget !== this.wantFrame;
    const horizon = chasing ? (this.seekTarget as number) : this.wantFrame + 2 * SEGMENT_FRAMES;
    let guard = 0;
    for (;;) {
      if (this.nextFeed === null || this.nextFeed > horizon || guard++ >= 64) break;
      // 目标帧之前的那些(随机访问从 IDR 解过来的)一出来就关,不占配额 —— 只守住单个解码器 8 帧的硬上限;
      // 目标帧及以后的要留着画,按本流的配额喂
      const limit = this.nextFeed < this.discardBefore ? MAX_FRAMES_PER_DECODER : cap;
      if (this.heldCount >= limit) break;
      const seg = this.segmentOf(this.nextFeed);
      if (!rangesHave(this.plane.ranges, seg)) break;
      const meta = this.manifest.segments[String(seg)];
      if (!meta) { this.loadManifest(true); break; }
      const data = this.segments.get(seg);
      // 清单里这一段换了文件(稀疏 → 满帧,疑点 G):只在分段起点换,段中间接着用手里这份(差分帧不能跨编码)
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
        // 换了变体必须从这一段的 IDR 起
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
    // 换了流,或者同一条流被摆到了别的帧上(第一帧变了:手里解好的帧是按旧位置记的项目帧号):从头来
    if (plane.key !== this.plane.key || plane.originFrame !== this.plane.originFrame || !!plane.first !== !!this.plane.first) {
      this.firstFailures = 0;
      this.manifest = null;
      this.segments.clear();
      this.resetDecode();
      this.nextFeed = null;
      this.discardBefore = 0;
      // 画布上那一张是旧流的(输入变了,或者帧号对不上了):不留
      this.blank();
    } else if (JSON.stringify(plane.ranges ?? []) !== JSON.stringify(this.plane.ranges ?? [])) {
      // 同键、就绪区间变了:生产者发布了新分段,清单可能也换了(疑点 G)
      this.manifestDirty = true;
    }
    this.plane = plane;
    if (canvas !== this.canvas) {
      this.canvas = canvas;
      // 包裹层重挂载(停下追帧的起步)换了一块新的空画布:把刚才那张原样画回去,不等解码
      if (!this.redraw()) {
        const was = this.lastDrawn;
        this.lastDrawn = null;
        this.staleSince = null;
        this.closeShown();
        if (was !== null) this.player.noteShowing();
      }
    }
    // 父页带来了新的清单(多了分段、某一段换了文件):当场换上;换了文件的段在分段起点接上(`pump` 里比对文件名)
    if (plane.manifest && plane.manifest !== this.manifest) this.adoptPushed(plane.manifest);
  }

  dispose(): void {
    this.disposed = true;
    for (const h of this.frames.values()) h.frame.close();
    this.frames.clear();
    this.closeShown();
    try { if (this.decoder && this.decoder.state !== "closed") this.decoder.close(); } catch { /* 已经关了 */ }
    this.decoder = null;
    this.compositor?.clear();
    this.compositor = null;
    this.segments.clear();
  }

  diag() {
    return { id: this.id, key: this.key, pushed: !!this.plane.manifest, held: this.frames.size, queue: this.decoder?.decodeQueueSize ?? 0,
      decoder: this.decoder?.state ?? null, nextFeed: this.nextFeed, lastDrawn: this.lastDrawn,
      // 要哪一帧、画着的是哪一张画面(稀疏段里是不晚于那一帧的最近一张)、是不是留着的旧画面、在途的寻帧、上一次寻帧的耗时
      want: this.wantFrame, picture: this.lastDrawn === null ? null : this.pictureOf(this.lastDrawn), level: this.level,
      // 画着的那一张所在的分段在清单里多密(1 = 满密度;最低一档不管它多密都只解第一帧)
      stride: this.lastDrawn === null ? null : this.manifest?.segments[String(this.segmentOf(this.lastDrawn))]?.stride ?? null,
      stale: this.staleSince !== null, seekTarget: this.seekTarget, lastSeek: this.lastSeek,
      segments: [...this.segments.keys()], manifest: !!this.manifest, bound: this.manifest?.bound ?? null,
      // 画在哪种平面上(舞台根下 / 包裹层里),清单是哪一种流、和这块平面对不对得上
      plane: stagePlane(this.plane) ? "stage" : "local", kind: this.manifest?.kind ?? null, fits: this.planeFits,
      cap: this.player.capFor(this), first: this.firstOnly, firstFailures: this.firstFailures, ...this.stats };
  }
}

/** 是不是一个位置矩形(四个有限数,宽高为正) */
const isRect = (r: unknown): r is StreamRect => {
  const v = r as StreamRect | null;
  return !!v && typeof v === "object" && [v.x, v.y, v.w, v.h].every(Number.isFinite) && v.w > 0 && v.h > 0;
};

/**
 * 超出预算的一条流:不建解码器、不画,只拿着它的清单,给占位符报「这一帧所在分段的位置矩形」(清单里 `segments[n].box`,
 * 产稀疏版时每个分段量的收紧的框)。清单由父页带来(在线页面)就用带来的;没带(桌面)就问字节源,这一帧所在的分段还没有
 * 位置矩形时隔 `MANIFEST_REFRESH_MS` 再问一次。取不到清单、分段没量过的回 null,占位符照老办法定位。
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

  /** 这一帧所在分段的位置矩形(平面坐标:单卡流是包裹层自己的坐标,按舞台坐标产的流是舞台坐标);没有回 null */
  boxAt(f: number): StreamRect | null {
    const m = this.manifest;
    if (!m || !isStreamOrigin(this.plane.originFrame)) return null;
    // 清单说的坐标系和父页说的对不上的不用(同 `StreamTrack.planeFits`)
    if ((m.plane === "stage" || m.plane === "local") && (m.plane === "stage") !== stagePlane(this.plane)) return null;
    const box = m.segments?.[String(streamSegmentOf(f, this.plane.originFrame))]?.box;
    return isRect(box) ? box : null;
  }

  /**
   * 每拍叫一次:没有清单就取;手里的清单还没有这一帧所在的分段(清单是旧的)就隔一会儿再问。清单里已经有这一段、只是没有位置矩形
   * (没量过的分段,以后也不会有)的不再问。父页带清单来的不问,等它带新的来。
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
      .catch(() => { /* 还没有清单:占位符照老办法定位,过一会儿再问 */ })
      .finally(() => { this.loading = false; });
  }
}

const planeId = (plane: StreamPlaneRequest) => `${plane.clipIds.join(",")}#${plane.key ?? ""}${plane.plane === "stage" ? "@stage" : ""}`;

/* ======================================================================== *
 * 舞台上的全部流
 * ======================================================================== */

export class StreamPlayer {
  readonly source: StreamSource;
  /** 父页随流平面推来的清单与字节(在线页面);桌面的平面不带清单,这里一直是空的 */
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
  /** 超出预算的流(片段 id → 那一条;组流的每个成员都指向同一条) */
  private over = new Map<string, OverPlane>();
  private onBoxChange: (() => void) | null;
  private boxesQueued = false;
  private boxesSig = "";
  private onContextLost: (() => void) | null;
  /** 全部流平面共用的那个 WebGL 上下文(头一次真的要画时才建;`back` 角色的舞台从不画,也就不建) */
  readonly gl: SharedGl;

  constructor({ root, source = new HttpStreamSource(), onShowingChange, onContextLost, onBoxChange }: {
    root: () => Element | null; source?: StreamSource;
    /**
     * 某条流的画面从无到有、或从有到无(异步解出来了、留到时限清空了)时叫一次;同一个微任务里只叫一次。
     * 暂停着没有下一拍:宿主靠它撤占位符、把等着第一张画面的活子树藏起来。
     */
    onShowingChange?: () => void;
    /** 共用的 WebGL 上下文丢了(那块画布不在文档里,事件到不了 `document`;在线页面靠它报「运行中出事了」) */
    onContextLost?: () => void;
    /**
     * 超出预算的层的位置矩形变了(清单到了、播放头进了下一个分段)时叫一次;同一个微任务里只叫一次。
     * 占位符的几何是宿主渲染时取的(`boxOf` / `stageBoxOf`),宿主靠它重取一遍。
     */
    onBoxChange?: () => void;
  }) {
    this.root = root;
    this.source = source;
    this.onShowingChange = onShowingChange ?? null;
    this.onContextLost = onContextLost ?? null;
    this.onBoxChange = onBoxChange ?? null;
    /*
     * 共用的上下文丢了 / 回来了:把这一帧再走一遍(暂停着没有下一拍)。丢了以后浏览器不一定还(被别的画布挤掉的不还),
     * 所以丢的那一刻另排一个真定时器,到 `GL_RETRY_MS` 再走一遍 —— 那时 `SharedGl` 会另建一块。
     */
    this.gl = new SharedGl(
      () => { this.onContextLost?.(); this.retryLater(GL_RETRY_MS); },
      () => this.represent(),
      (ms) => this.retryLater(ms),
    );
  }

  /**
   * 过 `ms` 毫秒把这一帧再走一遍(共用的上下文丢着、或者没建出来)。同时只排一个;到点时没有要画的流(停了、没有轨道)就不再排,
   * 还画不了的话 `SharedGl` 会再约下一次(间隔加倍),不会空转。
   */
  private retryPending = false;
  private retryLater(ms: number): void {
    if (this.retryPending) return;
    this.retryPending = true;
    realTimeout(() => { this.retryPending = false; this.represent(); }, Math.max(1, ms) + 20);
  }

  /** 把上一拍要的那一帧再走一遍(共用的上下文回来了) */
  private represent(): void {
    if (this.stopped || this.proxy || this.lastFrame === null) return;
    for (const track of this.tracks.values()) track.present(this.lastFrame);
  }

  /** 轨道报:画面有无变了。攒到微任务里叫宿主(`present` 的循环里不重入宿主) */
  noteShowing(): void {
    if (!this.onShowingChange || this.showingQueued) return;
    this.showingQueued = true;
    queueMicrotask(() => {
      this.showingQueued = false;
      if (!this.stopped) this.onShowingChange?.();
    });
  }

  /** 超出预算的层的位置矩形可能变了:攒到微任务里,真的变了才叫宿主 */
  noteBoxes(): void {
    if (!this.onBoxChange || this.boxesQueued) return;
    this.boxesQueued = true;
    queueMicrotask(() => {
      this.boxesQueued = false;
      if (this.stopped) return;
      const f = this.lastFrame ?? 0;
      let sig = "";
      // 只记有矩形的:没有矩形的层占位符照老办法定位,多一条少一条都不用宿主重取
      for (const [id, o] of this.over) { const b = o.boxAt(f); if (b) sig += `${id}:${b.x},${b.y},${b.w},${b.h};`; }
      if (sig === this.boxesSig) return;
      this.boxesSig = sig;
      this.onBoxChange?.();
    });
  }

  /** 超出预算的平面(父页标了 `over` 的):只记下来取清单,不建解码器 */
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
   * 父页的 `setStreamPlanes`。只存,下一次 `present` 才绑画布(画布要等 React 提交之后才在)。
   * `over`:这一拍超出预算的平面(不解码,只为占位符取位置矩形);`planes` 里标了 `over` 的也算。
   */
  setPlanes(planes: readonly StreamPlaneRequest[], fps: number, over: readonly StreamPlaneRequest[] = []): void {
    const usable = (p: StreamPlaneRequest) => Array.isArray(p?.clipIds) && p.clipIds.length > 0 && typeof p.key === "string" && !!p.key && isStreamOrigin(p.originFrame);
    this.setOver([...over, ...planes.filter((p) => p?.over)].filter(usable));
    const list = planes.filter((p) => usable(p) && !p.over);
    // 在线页面:先收下随平面推来的块(没用到的旧块当场丢),平面自己不留着字节
    this.pushed.accept(list);
    this.planes = list.map((p) => {
      if (!p.blocks) return p;
      const { blocks: _blocks, ...rest } = p;
      return rest;
    });
    this.fps = Math.max(1, fps || 30);
    this.stopped = false;
    // 不再要的流当场关掉(解码器、持有的 VideoFrame):暂停时父页发一张空表,下一拍不一定还会来
    const keep = new Set(this.planes.map(planeId));
    for (const [id, track] of this.tracks) {
      if (!keep.has(id)) { track.dispose(); this.tracks.delete(id); }
    }
  }

  /** 实体模式开着时 `.pc-proxy` 连流平面一起藏,这里停解码、不占解码帧预算(E7 第 4 条) */
  setProxy(on: boolean): void {
    this.proxy = !!on;
    if (this.proxy) this.disposeAll();
  }

  /** 平面画布的引用缓存(P4 性能修正):`sync()` 每拍对每条流都从场景根 querySelector 一遍太贵 */
  private canvasCache = new Map<string, HTMLCanvasElement>();

  private canvasOf(plane: StreamPlaneRequest): HTMLCanvasElement | null {
    const root = this.root();
    if (!root) return null;
    // 单卡流的画布在它的包裹层里;组流和依赖下层的流的画布在舞台根下(`Stage` 的 `[data-pc-group-plane]`)
    const single = !stagePlane(plane);
    const key = plane.clipIds.join(",");
    const hit = this.canvasCache.get(key);
    // 还在场景里、仍挂在同一个包裹层(单卡流)/ 同一个组(组流)下就直接用
    if (hit && hit.isConnected && root.contains(hit)
      && (single ? (hit.parentElement?.getAttribute("data-pc-clip") === key || hit.parentElement?.getAttribute("data-pc-flat-clip") === key) : hit.getAttribute("data-pc-stream-group") === key)) return hit;
    // 剪辑段里的卡(`kernel/cutFlatten.mjs` 的虚拟片段):包裹层在嵌套场景里,挂的是 `data-pc-flat-clip`
    const found = single
      ? (root.querySelector<HTMLCanvasElement>(`[data-pc-clip="${CSS.escape(key)}"] > canvas[data-pc-stream-plane]`)
        ?? root.querySelector<HTMLCanvasElement>(`[data-pc-flat-clip="${CSS.escape(key)}"] > canvas[data-pc-stream-plane]`))
      : root.querySelector<HTMLCanvasElement>(`canvas[data-pc-group-plane][data-pc-stream-group="${CSS.escape(key)}"]`);
    if (found) this.canvasCache.set(key, found);
    else this.canvasCache.delete(key);
    if (this.canvasCache.size > 256) this.canvasCache.clear();
    return found;
  }

  /** 场景根(组流藏 / 露成员快照平面时用) */
  rootElement(): Element | null {
    return this.root();
  }

  /**
   * 把平面和画布对上:新来的建流,没了的关掉。超出预算的平面父页已经标了 `over`,不在 `this.planes` 里(`setPlanes`);
   * 这里只再守一次条数的硬上限。
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
   * 这一拍(K4 的节拍循环、或暂停 / 拖动的 `setTime`)。同步:手里有这一帧就当场画上,
   * 没有就留着上一张或透明,再把后面几帧的解码排上 —— **从不阻塞调用方**。
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
      // 播放头进了下一个分段,位置矩形可能换了
      if (moved) this.noteBoxes();
    }
  }

  /**
   * 本流的持有上限:字节预算按流均分(≤ 80 MB 总量),夹在 [3, 8] 之间 ——
   * 8 是单个解码器的硬上限(G0-b (4)),3 是每流保底(G5)。
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

  /** `setRole('back')`:停下、`close()` 全部 `VideoFrame`、清掉画布(E0 的清理全集第 3 条) */
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
   * 这一拍流画面在的那些卡(组流算到每个成员头上)。占位符 T1:被抑制、这一拍流 blank、
   * 又没挂快照的层才显示占位符 —— 在 `present` 之后当拍读(`StageView` 的 `refreshPlaceholders`)。
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

  /** 这一拍每张卡的流画面是满帧段还是稀疏段(只列有画面的;探针用) */
  levels(): Map<string, "dense" | "sparse"> {
    const out = new Map<string, "dense" | "sparse">();
    if (this.stopped || this.proxy) return out;
    for (const track of this.tracks.values()) {
      const level = track.level;
      if (level) for (const id of track.plane.clipIds) out.set(id, level);
    }
    return out;
  }

  /** 预算以内的单卡流的实体框(清单的收紧矩形,没有就用上界;包裹层坐标 = 平面坐标)。组流、依赖下层的流的框在舞台坐标里,不回 */
  boxOf(clipId: string): StreamRect | null {
    for (const track of this.tracks.values()) {
      if (!stagePlane(track.plane) && track.plane.clipIds[0] === clipId) return track.box;
    }
    return null;
  }

  /**
   * **超出预算的**单卡流:清单里这一帧所在分段的位置矩形(包裹层坐标);没量过、没有清单回 null。和 `boxOf` 分开回:
   * 这个矩形只管这一帧,宿主不该把它记下来留到以后用。组流、依赖下层的流见 `stageBoxOf`。
   */
  overBoxOf(clipId: string): StreamRect | null {
    const over = this.over.get(clipId);
    if (over && !stagePlane(over.plane) && this.lastFrame !== null) return over.boxAt(this.lastFrame);
    return null;
  }

  /**
   * 超出预算的组流里,这一帧有位置矩形的那几组的成员(每组按画家顺序,最后一个在最上面)。整组只有一个矩形(成员的并集),
   * 宿主只让其中一个成员显示占位符(4:不然 N 个成员叠 N 块同样的框)。
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
   * 超出预算、按舞台坐标产的流(组流、依赖下层的流)这一帧所在分段的位置矩形,**舞台坐标**(清单里的矩形加清单的 `offset`,
   * 这种流的 `offset` 是零)。宿主要自己换到包裹层的坐标再给占位符。别的情形回 null。
   */
  stageBoxOf(clipId: string): StreamRect | null {
    const over = this.over.get(clipId);
    if (!over || !stagePlane(over.plane) || this.lastFrame === null) return null;
    const box = over.boxAt(this.lastFrame);
    if (!box) return null;
    const off = over.manifest?.offset;
    return { x: box.x + (Number(off?.x) || 0), y: box.y + (Number(off?.y) || 0), w: box.w, h: box.h };
  }

  /** 这一拍有超出预算的平面在(没有流平面时宿主据此还要每拍叫 `present`:位置矩形跟着播放头换) */
  get hasOver(): boolean { return this.over.size > 0; }

  /** 此刻持有的解码帧字节(验收「解码帧总内存 ≤ 80 MB」看它) */
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
