/**
 * 父页对舞台消息的校验(契约 `docs/plan/online-card-exec-contract.md` 第 3.2 节「协议面」)。
 *
 * 跨源舞台里会执行用户卡与素材效果卡的代码,**舞台发来的一切当不可信输入**:只认 `event.source` 是自己挂的那个舞台、`event.origin`
 * 是运行配置里那个舞台源的消息(来源在 `stageRpc.ts` 的客户端与 `Preview.tsx` 里核);内容在这里按形状校验,数字钳到合理范围,
 * 认不出的类型、形状不对的一律丢弃。父页从不经 RPC 回传凭证或票据,也不把舞台交来的 HTML 放进自己的活文档。
 *
 * 只在在线的跨源舞台上启用(`createStageRpc(…, { untrusted: true })`);桌面运行环境与同源单舞台照旧,一个字节不变。
 * 纯函数,没有依赖,单测逐条核。
 */

/** 各种上限。都是「正常用到的量再宽一个数量级」,只为挡坏数据,不是业务规则 */
export const STAGE_MESSAGE_LIMITS = Object.freeze({
  /** 时间(秒):项目最长也到不了一天 */
  maxSec: 86_400,
  /** 耗时类的数(毫秒):十分钟封顶 */
  maxMs: 600_000,
  /** 帧号 */
  maxFrame: 10_000_000,
  /** 片段 id、会话号这类短串 */
  maxIdLength: 512,
  /** 成本身份(节点的稳定 JSON) */
  maxIdentityLength: 262_144,
  /** 一次事件里的片段数 */
  maxClipIds: 5_000,
  /** 一帧快照的 HTML(字符) */
  maxHtmlLength: 16 * 1024 * 1024,
  /** 随消息转移的字节块 */
  maxBufferBytes: 64 * 1024 * 1024,
  /** 随消息转移的位图(生成快照时要的像素)一边最长多少、矩形坐标的绝对值上限 */
  maxPixelSide: 8192,
  /** RPC 回包的嵌套深度与节点总数 */
  maxDepth: 12,
  maxNodes: 400_000,
  /** RPC 回包里普通数字的绝对值 */
  maxAbs: 1e12,
});

const L = STAGE_MESSAGE_LIMITS;
const HASH = /^[0-9a-f]{64}$/;

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** 有限数钳到 [min, max];不是有限数回 null */
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
 * `bake-frame` 的像素(浏览器节点产轨道流用):`{ rect: { x, y, w, h }, bitmap }`。矩形要是整数、宽高为偶数且不超过上限;
 * 位图要真是 `ImageBitmap`、大小与矩形一致。位图只是一张图,父页拿它送编码器、不放进活文档。不合形状回 null。
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
 * 舞台事件(`StageEvent`)按形状校验;回一份只含认得的字段的新对象,不合形状回 null。
 * 回值的静态类型留给调用方断言(本文件不引 render 层的类型,免得成环)。
 * `opts.maxSec`:时间类字段(`sec`)的上限,一般给项目时长。
 */
export function sanitizeStageEvent(d: unknown, opts: { maxSec?: number } = {}): Clean | null {
  if (!isObj(d) || typeof d.type !== "string") return null;
  // 时间的上限:调用方给了项目时长就用它(播放头不许被舞台报的时刻带出时间轴),没给用通用上限
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
      // 在线执行用户卡与素材效果卡:每张卡的运行状态。状态名只认契约第 8 节那十种,文字截短;图形能力只认名单上的几种
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
/** 同步卡的张数上限(与同步表、清单计划的上限同量级) */
const MAX_CARDS = 500;

/** `[卡片 id, 运行状态][]`:逐条按形状收;形状不对回 null */
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

/** `{ 卡片 id: 短文字 }`:只留字符串值,截短;不是对象回 null */
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

/** 进成本记录的那几个数所在的方法:里面的耗时一律钳到 [0, maxMs] */
const TIMING_METHODS = new Set(["render", "setTime", "bakeFrame", "settleLayers"]);
const TIMING_KEYS = new Set(["elapsedMs", "stepMs", "inlineMs", "rasterMs", "serializeMs", "seekMs", "ms", "pausedMs", "smallMs", "readyMs", "catchUpMs"]);

/**
 * RPC 回包的结果按形状收一遍:只许普通对象、数组、字符串、布尔、null、有限数与字节块;深度、节点数、字符串长度有上限;
 * 数字钳到合理范围(耗时类的不许为负、十分钟封顶)。不合形状就抛(调用方把这次调用按失败回绝)。原地改、回同一个值。
 */
export function sanitizeRpcResult(method: string, result: unknown): unknown {
  let nodes = 0;
  const timing = TIMING_METHODS.has(method);
  const walk = (v: unknown, depth: number, key: string | null, inTiming: boolean): unknown => {
    if (++nodes > L.maxNodes) throw new Error("stage rpc: 回包太大");
    if (v === null || v === undefined || typeof v === "boolean") return v;
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return 0;
      if (timing && (inTiming || (key !== null && TIMING_KEYS.has(key)))) return v < 0 ? 0 : v > L.maxMs ? L.maxMs : v;
      return v < -L.maxAbs ? -L.maxAbs : v > L.maxAbs ? L.maxAbs : v;
    }
    if (typeof v === "string") {
      if (v.length > L.maxHtmlLength) throw new Error("stage rpc: 回包里的字符串太长");
      return v;
    }
    if (typeof v !== "object") throw new Error("stage rpc: 回包里有不认得的值");
    if (v instanceof ArrayBuffer) { if (v.byteLength > L.maxBufferBytes) throw new Error("stage rpc: 回包里的字节块太大"); return v; }
    if (ArrayBuffer.isView(v)) { if (v.byteLength > L.maxBufferBytes) throw new Error("stage rpc: 回包里的字节块太大"); return v; }
    if (depth >= L.maxDepth) throw new Error("stage rpc: 回包嵌套太深");
    if (Array.isArray(v)) {
      // `steps`(每帧活渲耗时)是一串数:整串按耗时钳
      const t = inTiming || (timing && (key === "steps"));
      for (let i = 0; i < v.length; i++) v[i] = walk(v[i], depth + 1, null, t);
      return v;
    }
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) throw new Error("stage rpc: 回包里有不认得的对象");
    const o = v as Record<string, unknown>;
    // `snapshot` / `snapshotSteps[]` 里的三段耗时本身的键就在 TIMING_KEYS 里;`glGpuMs` 是「卡 → 毫秒」的表,整张按耗时钳
    const t = inTiming || (timing && key === "glGpuMs");
    for (const k of Object.keys(o)) o[k] = walk(o[k], depth + 1, k, t);
    return o;
  };
  return walk(result, 0, null, false);
}

/** RPC 回包的外壳(`pc-rpc-reply`):`error` 只留一段不长的字符串 */
export function sanitizeRpcError(error: unknown): string | undefined {
  if (typeof error !== "string") return undefined;
  return error.length > 2000 ? `${error.slice(0, 2000)}…` : error;
}

/** 握手里的宿主能力表:只认这几项、各按类型收;不是对象回 null */
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
