import type { PickedSnapshot, ReadyKind, ReadyLayer, ReadyRange } from "./snapshotPick.mjs";
import { cachedClipInputSig, inputSigStale } from "./layerInputSig.mjs";
import { streamInputSig, streamSigStale } from "./streamInputSig.mjs";
import { SEGMENT_FRAMES, type StreamManifest, type StreamRect } from "./streamPlayer.ts";
import { isStreamOrigin, streamSegmentOf } from "./streamSegments.mjs";

/**
 * J3 舞台侧的快照来源接口。
 *
 * 页面里消费快照的**两处** —— C3 就绪索引的 SSE 订阅、C4 取快照字节的
 * `GET ${prerenderBase()}/api/frames/snapshot/<kind>/<key>/<localFrame>` —— 收口到
 * 这一个文件。`StageView` / `Preview` 不直接 `fetch` 快照、不直接 `new EventSource`:
 * 在线浏览器模式(L2)换成 `IdbSnapshotSource` 时,消费方一行都不用改。
 *
 * 本地模式的实现是 `HttpSnapshotSource`:**直连预渲染进程**(和 SSE 同源,同走
 * `PROMPTCUT_CORS_ORIGINS`;编辑器进程不代理)。断线按 1s / 2s / 4s / 8s(封顶 8s)
 * 退避重连**同一条 SSE**,重连成功时服务端照 F5 的做法先发 `reset` 再发全量 `layer` ——
 * 和 F5 共用一条恢复路径,没有轮询端点。
 *
 * **这一层只负责「拿得到」**:33 ms 的换 DOM 节流、`setSnapshots` 的投递基线、
 * 一次投递 ≤ 2 MB 的拆分都是父页消费方的事(R5)。所以接口做成了两个无状态的动词
 * 加一个订阅,消费方想怎么排程就怎么排程。
 */

export type { ReadyKind, ReadyLayer, ReadyRange, PickedSnapshot };

/** C3 的三种消息,形状定死 */
export type ReadyMessage =
  | { type: "reset"; localRev: number }
  | { type: "layer"; clipId: string; kind: ReadyKind; key: string; ranges: ReadyRange[]; groupClipIds?: string[];
      /** `stream` 层才有:这条流自己的第一帧(项目帧号),分段从它起每 15 帧一段(`streamSegments.mjs`) */
      originFrame?: number;
      /** 依赖下层的流才有(`server/frame-stream.mjs` 的 `belowLayerMark`):这条流按舞台坐标产,平面挂在舞台根下 */
      streamKind?: "below";
      /** 依赖下层的流才有:产这条流的那一版项目的输入签名(`streamInputSig.mjs`);父页按当前项目算的对不上就不贴 */
      inputSig?: string }
  | { type: "done"; localRev: number };

export interface SnapshotSource {
  /** 订阅就绪索引。返回退订函数;重连、`reset` 都在实现里处理掉 */
  subscribeReady(session: string, localRev: number, onMessage: (m: ReadyMessage) => void): () => void;
  /** 取一帧快照的 HTML。缺帧抛(那一层按缺料处理,C4 会选更早的一帧) */
  fetchSnapshot(kind: ReadyKind, key: string, localFrame: number, signal?: AbortSignal): Promise<string>;
}

/** A3c / J3:页面内存缓存 64 条,LRU */
export const SNAPSHOT_CACHE_MAX = 64;
/** J3:断线重连的退避,封顶 8 秒 */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000];

/**
 * 拼快照地址。`kind` 为 `local` 时 `key` 是 `<entry.key>/<共享键>`、**自带一个斜杠**
 * (C3),所以按段 `encodeURIComponent`,不能对整个 `key` 编码 —— 整编会把那个斜杠
 * 变成 `%2F`,服务端的路由正则就配不上了。
 */
export function snapshotPath(kind: ReadyKind, key: string, localFrame: number): string {
  const segments = String(key).split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/api/frames/snapshot/${encodeURIComponent(kind)}/${segments}/${localFrame}`;
}

/** 就绪索引的页面侧形状(C3):同一张重卡的 `stream` 表和 `html` 表并存、互不覆盖 */
export type ReadyIndex = Map<string, Map<ReadyKind, { key: string; ranges: ReadyRange[]; groupClipIds?: string[]; originFrame?: number; streamKind?: "below"; inputSig?: string }>>;

/**
 * 把一条消息应用到页面的 `readyIndex`。`reset` 清表,`layer` 整层替换
 * (C3 是全量语义 —— 不能合并,否则卡的参数变了之后旧区间会赖着不走)。
 */
export function applyReadyMessage(index: ReadyIndex, message: ReadyMessage): ReadyIndex {
  if (message.type === "reset") { index.clear(); return index; }
  if (message.type !== "layer") return index;
  let byKind = index.get(message.clipId);
  if (!byKind) { byKind = new Map(); index.set(message.clipId, byKind); }
  // 组流(R8 / G1)的层带 `groupClipIds`:父页按它合成一条 `{ clipIds: groupClipIds }` 的流平面
  // `stream` 层另带这条流的第一帧(`originFrame`):父页与舞台按它把帧号换成分段号
  byKind.set(message.kind, { key: message.key, ranges: message.ranges, ...(message.groupClipIds?.length ? { groupClipIds: [...message.groupClipIds] } : {}),
    ...(isStreamOrigin(message.originFrame) ? { originFrame: message.originFrame } : {}),
    // 依赖下层的流的两项(只有 `stream` 层认):按舞台坐标贴、输入签名
    ...(message.kind === "stream" && message.streamKind === "below"
      ? { streamKind: "below" as const, ...(typeof message.inputSig === "string" && message.inputSig ? { inputSig: message.inputSig } : {}) } : {}) });
  return index;
}

/** 就绪索引里取一层;没有就 null(那一层这一拍透明) */
export function layerOf(index: ReadyIndex, clipId: string, kind: ReadyKind): ReadyLayer | null {
  const hit = index.get(clipId)?.get(kind);
  return hit ? { clipId, kind, key: hit.key, ranges: hit.ranges } : null;
}

/**
 * 内存 LRU:`Map` 的插入序就是使用序,命中就删了再放回去。
 *
 * (这个文件里不用 TS 的「构造函数参数属性」`constructor(private x)` —— 那是
 * 非类型语法,Node 的类型擦除跑不了,单测就 import 不进来。)
 */
class SnapshotCache {
  private map = new Map<string, string>();
  private max: number;
  constructor(max = SNAPSHOT_CACHE_MAX) { this.max = max; }
  get(id: string): string | undefined {
    const hit = this.map.get(id);
    if (hit === undefined) return undefined;
    this.map.delete(id);
    this.map.set(id, hit);
    return hit;
  }
  set(id: string, html: string) {
    if (this.map.has(id)) this.map.delete(id);
    this.map.set(id, html);
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }
  get size() { return this.map.size; }
  clear() { this.map.clear(); }
}

/**
 * 预渲染进程的源。**按需 import** `./prerender.ts`:那个模块带 React hook
 * (`usePrerenderBase`),静态 import 会把 React 拖进这条本该只有 fetch 的路
 * (以及 Node 侧的单测)。调用方自己传 `base` 时这一行永远不跑。
 */
const defaultBase = async (): Promise<string> => (await import("./prerender.ts")).prerenderBase();

/** 本地模式:直连预渲染进程 */
export class HttpSnapshotSource implements SnapshotSource {
  private cache = new SnapshotCache();
  /** 同一帧同时被两处要到时只飞一次 */
  private inflight = new Map<string, Promise<string>>();
  private base: () => Promise<string>;

  constructor(base: () => Promise<string> = defaultBase) { this.base = base; }

  subscribeReady(session: string, localRev: number, onMessage: (m: ReadyMessage) => void): () => void {
    let stopped = false;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;

    const connect = async () => {
      if (stopped) return;
      /*
       * D5「同源退回删除」:拿不到预渲染的源就**不连**,退避之后重新问。
       * 以前这里退回空串(同源),EventSource 于是连到编辑器自己的源上 ——
       * 那里没有这个端点,连上就错、错了又重连,白占一条连接还把真实故障藏起来。
       */
      let base: string;
      try { base = await this.base(); } catch { return retry(); }
      if (stopped) return;
      const url = `${base}/api/frames/ready?session=${encodeURIComponent(session)}&localRev=${encodeURIComponent(String(localRev))}`;
      try {
        source = new EventSource(url);
      } catch {
        return retry();
      }
      source.onopen = () => { attempt = 0; };
      source.onmessage = (event: MessageEvent) => {
        if (stopped) return;
        try { onMessage(JSON.parse(String(event.data)) as ReadyMessage); }
        catch { /* 半条消息:下一条全量 layer 会把这一层补回来 */ }
      };
      source.onerror = () => {
        // EventSource 自己也会重连,但它不会重新问 `prerenderBase()` —— 预渲染崩了
        // 会换一个新端口,所以这里自己关掉、退避、重新问地址再连。
        try { source?.close(); } catch { /* 已经关了 */ }
        source = null;
        retry();
      };
    };

    const retry = () => {
      if (stopped || timer !== null) return;
      const delay = RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)];
      attempt++;
      timer = setTimeout(() => { timer = null; void connect(); }, delay);
    };

    void connect();
    return () => {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      try { source?.close(); } catch { /* 已经关了 */ }
      source = null;
    };
  }

  async fetchSnapshot(kind: ReadyKind, key: string, localFrame: number, signal?: AbortSignal): Promise<string> {
    const id = `${kind}/${key}/${localFrame}`;
    const hit = this.cache.get(id);
    if (hit !== undefined) return hit;
    const flying = this.inflight.get(id);
    if (flying) return flying;
    const work = (async () => {
      const base = await this.base();
      const res = await fetch(base + snapshotPath(kind, key, localFrame), { signal, cache: "force-cache" });
      if (!res.ok) throw Object.assign(new Error(`快照还没就绪:${id}`), { status: res.status });
      const html = await res.text();
      this.cache.set(id, html);
      return html;
    })().finally(() => { this.inflight.delete(id); });
    this.inflight.set(id, work);
    return work;
  }

  /** 项目换版之后把缓存丢掉(键是内容寻址的,所以平时不需要) */
  clearCache() { this.cache.clear(); }
  get cacheSize() { return this.cache.size; }
}

/* ======================================================================== *
 * 在线浏览器模式:从素材服务读预渲染小尺寸(`docs/plan/c10a-contract.md` 第 9 节「在线页面拉取」)
 * ======================================================================== */

/**
 * 在线页面没有预渲染进程,也就没有 SSE 就绪索引、没有 `/api/frames/snapshot`。它这样拿重层的画面:
 *
 * 1. **层表**:渲染节点认下一版 card plan 时写进内容库的一条(`snapshot-manifest` 类,键 `layers:<项目 id>`,
 *    `server/artifact-transfer.mjs` 的 `layerMapOf`):每张重卡的线上键、清单的结果键、采样窗口。页面按项目 id 取它,
 *    每 `LAYER_MAP_POLL_MS` 再取一次(改了一处之后,渲染节点重渲、换键,页面跟着换)。
 * 2. **清单**:只取「当前播放头前后各 `PREFETCH_SEC` 秒」落在哪几段的清单(`<resultKey>:<from>-<to>`,段长是层表的 `span`),
 *    每段一份;清单里的 `small` 表就是这一段有哪些帧的小位图、各自的哈希。还没满的清单每 `MANIFEST_POLL_MS` 再取。
 * 3. **就绪**:每层的就绪区间 = 已取到的清单里有小位图的帧,照 C3 的 `layer` 消息(全量语义)交给订阅方 ——
 *    和本地模式同一条消费路(`snapshotFeed` 的选帧、兜底、投递一行不改)。原尺寸不算:小尺寸就绪不是原尺寸就绪,
 *    在线页面也从不拉原尺寸。
 * 4. **取字节**:`GET <素材服务>/px/<hash>`(只读票据,`Authorization` 头),包成一张铺满快照平面的 `<img>`
 *    (data URL,不用 blob URL:舞台是另一个文档,父页撤销 blob 时舞台上的图会断)。
 * 5. **缓存**:只在内存里按 LRU 存小尺寸,上限 `ONLINE_CACHE_MAX_BYTES`(64 MiB,契约第 8 节〔裁〕,不做 IndexedDB)。
 *    预取:播放头前后各 2 秒、当前可见的重层。导出前 `clearCache()` 释放(契约第 11.1 节)。
 *
 * 6. **轨道流**(`docs/plan/browser-stream-task.md` 第六处;各档都取,只贴稀疏版时的不同见第 7 条):层表另带一张 `streams` 表(每条流一行:成员、候选的结果键、
 *    分段范围、每份清单几段)。页面按播放头附近的分段去内容库取流清单(`render-manifest`,键 `<结果键>:<起>-<止>`),清单里列着的
 *    开头文件与分段按哈希从素材服务取到本页内存(`px/<hash>`,同一张只读票据);**字节到了本页的分段才算就绪**,照 C3 的
 *    `layer` 消息(`kind: 'stream'`,单位是分段号,组流带 `groupClipIds`)交给订阅方 —— 和桌面的就绪索引同一种消息,`snapshotFeed` 不用改。
 *    舞台不自己取:父页发流平面时把清单和字节一起带过去(`streamPlane`,配 `streamPlayer.ts` 的 `StreamPlaneSender`)。
 *    候选的认定、输入签名过期的处理照快照层的规矩;流这一段没取到时这一层照旧每拍换快照。
 *
 * 7. **只有一个舞台时只贴轨道流的稀疏版**(2026-10-13 用户定「性能不足时只贴稀疏版、同时活着的解码器给得少」;2026-10-22 起归只有一个舞台的页面(精简模式与最低一档),
 *    `mechanism/platforms.md`「三道闸门」〔裁〕):取流的路和别的档是同一条(层表、清单、分段),
 *    舞台那边每个分段只解第一帧(`streamPlayer.ts` 的 `presentFirst`)。这里只有三处不同:
 *      - 先问浏览器解不解得了(`StreamDecodeSupport`):没有 `VideoDecoder` 就一条流都不取、不发;某个开头文件的编码配置
 *        `isConfigSupported` 说不行,用它的分段不取、不算就绪 —— 父页那边就是「这张卡没有流」,落到占位符;
 *      - 流字节在本页内存里留得少(`SPARSE_STREAM_CACHE_MAX_BYTES`);
 *      - 分段**整段取**:只要第一帧,但块按内容哈希存取、取回来要核哈希,取不了半块。稀疏的分段本来就只有一张图加十几个几乎为空的
 *        重复帧,整段约等于第一帧;满密度的分段多取了后面 14 个差分帧(用不上),代价是这部分流量。
 *    预渲染小尺寸那条路(上面第 2～5 条的 `small`)原样留着作过渡。〔撤快照时删:`small` 那一档连同 `tier` 的分支〕
 *
 * 文档服务与素材服务都经注入的依赖访问(页面里由 `Preview` 接到 `assetTiers.ts` 的 `docRequest` / `assetAuthHeaders`),
 * 这里不认识 `/api`,单测注入假的。
 */

/** 在线页面的小尺寸缓存上限(契约第 8 节〔裁〕) */
export const ONLINE_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** 预取范围:播放头前后各这么多秒(契约第 9 节) */
export const PREFETCH_SEC = 2;
/** 层表多久再取一次 */
export const LAYER_MAP_POLL_MS = 3000;
/** 还没满的清单多久再取一次 */
export const MANIFEST_POLL_MS = 2000;
/** 同时在飞的小位图请求 */
export const ONLINE_FETCH_CONCURRENCY = 4;
/** 层表在内容库里的键前缀(与 `server/artifact-transfer.mjs` 的 `LAYER_MAP_PREFIX` 同值) */
export const LAYER_MAP_PREFIX = "layers:";
/** 轨道流的分段字节在本页内存里最多留这么多(按最近用过的留;三级数字:6 条流、每条前后 6 段、每段不超过 512 KB 约 18 MiB,留三倍余量) */
export const STREAM_CACHE_MAX_BYTES = 64 * 1024 * 1024;
/** 只贴稀疏版时:流字节在本页内存里最多留这么多(三级数字:4 条流、每条播放头前后 6 段、每段不超过 512 KB 约 12 MiB) */
export const SPARSE_STREAM_CACHE_MAX_BYTES = 16 * 1024 * 1024;
/** 轨道流预取:播放头所在分段往回这么多段(刚播过的那一段留着,往回拖一点不用重取) */
export const STREAM_BEHIND_SEGMENTS = 1;
/** 一块流字节取失败之后,过这么久才再取(缺块、票据过期:不每一轮都打素材服务) */
export const STREAM_RETRY_MS = 2000;

export interface OnlineLayer {
  clipId: string;
  kind: ReadyKind;
  key: string;
  resultKey: string;
  firstFrame: number;
  count: number;
  /** 层表 v 2(C10 契约第 18 节第 3 条):共享档的内容键;v 1 或取不到为 null */
  contentKey?: string | null;
  /** 层表 v 2:产出这一层的环境的指纹;v 1 或取不到为 null */
  envFingerprint?: string | null;
  /**
   * 层表 v 3(M7 契约 D12):这一层的候选 —— 切分方自己的、纯浏览器的,各是一种环境出的一套键;层上的 `resultKey` /
   * `envFingerprint` / `key` 就是第一个候选。哪一份活着由页面按 `task.done` 与清单认定(`layerRefOf` 的 `alive`)。
   * v 2 没有这一项,当作一个候选(`layerCandidates`)。
   */
  candidates?: LayerCandidate[];
  /**
   * 〔裁〕stale-layer:生成这一层的片段输入的签名(`layerInputSig.mjs`)。页面按当前项目算同一个签名,对不上就是旧参数的层,
   * 不贴(C10 契约第 9 节)。旧节点写的层表没有这一项:照旧贴。
   */
  inputSig?: string | null;
}

/** 层表 v 3 的一个候选(M7 契约 D12):一种环境出的一套键 */
export interface LayerCandidate {
  envFingerprint: string;
  resultKey: string;
  /** 就绪索引线上的键 */
  key: string;
}

/** 轨道流的一个候选:一种环境产的一条流。流在就绪索引线上的键就是结果键 */
export interface StreamCandidate {
  envFingerprint: string;
  resultKey: string;
}

/**
 * 层表 `streams` 表的一行(`server/artifact-transfer.mjs` 的 `layerStreamsOf`):一条轨道流。
 * 流清单在内容库里按 `<结果键>:<起>-<止>` 存,分段号从 0 起每 `segmentsPerTask` 段一份、最后一份到 `lastSegment`。
 * 分段号是这条流自己的:从它的第一帧 `originFrame`(项目帧号)起每 15 帧一段(`streamSegments.mjs`)。
 */
export interface OnlineStream {
  /** 就绪消息挂在哪张卡上:单卡流是它自己,组流是组里最上面那张 */
  topClipId: string;
  /** 成员(画家顺序,最后一个在最上面)。依赖下层的流只有目标卡一张(算进键里的下层不列,页面按当前项目自己找) */
  clipIds: string[];
  /**
   * `below`:依赖下层的流(毛玻璃这一类卡;`docs/plan/prerender-products-contract.md` 第 5 节)。流里只有目标卡改动过的那一层,
   * 按舞台坐标产(`plane` 是 `stage`);就绪消息带 `streamKind: "below"`,父页据此发 `plane: "stage"` 的流平面。
   */
  kind: "card" | "group" | "below";
  plane: "local" | "stage";
  contentKey: string;
  /** 候选:切分实际出键的那几种环境,再补上写层表的节点自己的。哪一份活着的认定同快照层 */
  candidates: StreamCandidate[];
  /** 这条流自己的第一帧(项目帧号):层表那一行带的,由写层表的一侧按当时的项目给 */
  originFrame: number;
  /** 恒为 0(层表的行里不写它;留着是因为取清单按「从 firstSegment 到 lastSegment」分份) */
  firstSegment: number;
  lastSegment: number;
  segmentsPerTask: number;
  /** 生成这条流的项目输入的签名(`streamInputSig.mjs`);页面算的对不上就不播。没有这一项照播 */
  inputSig?: string | null;
}

export interface LayerMap {
  /** 层表的版本(`server/artifact-transfer.mjs` 的 `LAYER_MAP_VERSION`);没写当 1 */
  v: number;
  projectId: string | null;
  fps: number;
  span: number;
  layers: OnlineLayer[];
  /** 轨道流表;旧节点写的层表没有这一项,解析成空表(页面行为和以前一样) */
  streams: OnlineStream[];
}

/** 在线页面认的层表版本(C10 契约第 18 节第 3 条);只贴稀疏版时(`small`)v 1、v 2 都认 */
export const LAYER_MAP_V2 = 2;
/** 层表 v 3(M7 契约 D12):每层带候选;v 2 的字段照旧(等于第一个候选),旧读法照样能读 */
export const LAYER_MAP_V3 = 3;
/** 页面认得的层表版本;不认得的 `v` 整张当没有 */
export const KNOWN_LAYER_MAP_VERSIONS = [1, 2, 3] as const;

export interface OnlineSnapshotDeps {
  /** 文档服务上的一次请求(`content.get`);没连上就抛 */
  request(msg: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** 远程素材服务的 API 基址(形如 `https://host/media/api/asset`);还没有给 null */
  assetBase(): string | null;
  /** 带只读素材票据的请求头 */
  authHeaders(): Promise<Record<string, string>>;
  fetch?: typeof fetch;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  /** 单次内容库请求的兜底超时；连接实现也应自行超时 */
  requestTimeoutMs?: number;
  /** 取单张小位图的兜底超时 */
  assetTimeoutMs?: number;
  /**
   * 要知道整段覆盖情况的层(C10 契约第 9 节:这台设备跑不了的卡要看预渲染结果
   * 覆盖没覆盖整段)。这些层的清单不只取播放头那一窗口,整段每一段都取(慢一点,`COVERAGE_POLL_MS`);不给就只取窗口。
   */
  coverageLayer?: (clipId: string) => boolean;
}

/**
 * 层过期(输入签名对不上,stale-layer)之后,多久之内当「新结果在路上」:这段时间里父页不确认缺料(用户卡、素材效果卡显示沙漏、
 * 时间轴不出徽标),等渲染节点按新输入重写层表;过了还没等到就和「层表里没有这一层」一样确认缺料(图标、徽标)。三级数字。
 */
export const STALE_AWAIT_MS = 15_000;

/** 整段覆盖:还没取齐的清单多久再取一次(窗口之外的段) */
export const COVERAGE_POLL_MS = 5000;
/** 整段覆盖:一轮最多取这么多份窗口之外的清单(长片段分几轮取完,不一下子打满内容库) */
export const COVERAGE_FETCHES_PER_TICK = 16;

/**
 * 一个片段的预渲染结果覆盖了多少:还不知道(层表没取到,或者有哪一段的清单从没取到过)/ 没有可用的层 /
 * 有层但没覆盖整段 / 整段都有(这一档的帧)。
 */
export type LayerCoverage = "unknown" | "none" | "partial" | "full";

/** 层表 v 3 的候选表:只留三项都是非空字符串的,坏项跳过 */
function candidatesOf(raw: unknown): LayerCandidate[] {
  if (!Array.isArray(raw)) return [];
  const out: LayerCandidate[] = [];
  for (const c of raw as Record<string, unknown>[]) {
    if (!c || typeof c !== "object") continue;
    const { envFingerprint, resultKey, key } = c;
    if (typeof envFingerprint !== "string" || !envFingerprint || typeof resultKey !== "string" || !resultKey || typeof key !== "string" || !key) continue;
    out.push({ envFingerprint, resultKey, key });
  }
  return out;
}

/**
 * 这一层的候选(M7 契约 D12):v 3 的 `candidates`;v 2(或 v 3 的层没写候选、候选全坏)当作一个候选 —— 层自己的键与指纹;
 * v 1、缺指纹的层没有候选。
 */
export function layerCandidates(layer: OnlineLayer): LayerCandidate[] {
  if (layer.candidates?.length) return layer.candidates.map((c) => ({ ...c }));
  if (layer.envFingerprint && layer.resultKey && layer.key) return [{ envFingerprint: layer.envFingerprint, resultKey: layer.resultKey, key: layer.key }];
  return [];
}

/**
 * 层表的 `streams` 表:形状不对的行跳过,不抛;不是数组回空表。
 * 只认带 `originFrame` 的行:没有它的行是改分段规则之前的节点写的(分段按项目帧号数),照现在的换算贴上去画面会错位。
 * 依赖下层的流(`kind: "below"`)只认「一个成员、舞台坐标」的行:形状不对的贴上去位置会错,跳过(当作这张卡没有流)。
 */
export function parseLayerStreams(raw: unknown): OnlineStream[] {
  if (!Array.isArray(raw)) return [];
  const out: OnlineStream[] = [];
  const str = (x: unknown): x is string => typeof x === "string" && !!x;
  for (const r of raw as Record<string, unknown>[]) {
    if (!r || typeof r !== "object") continue;
    const clipIds = Array.isArray(r.clipIds) ? (r.clipIds as unknown[]).filter(str) : [];
    if (!clipIds.length || clipIds.length !== (r.clipIds as unknown[]).length) continue;
    const kind = r.kind === "group" ? "group" : r.kind === "card" ? "card" : r.kind === "below" ? "below" : null;
    const plane = r.plane === "stage" ? "stage" : r.plane === "local" ? "local" : null;
    const firstSegment = 0, lastSegment = Number(r.lastSegment), segmentsPerTask = Number(r.segmentsPerTask);
    const originFrame = r.originFrame;
    if (!kind || !plane || !str(r.contentKey)) continue;
    if (kind === "below" && (clipIds.length !== 1 || plane !== "stage")) continue;
    if (!isStreamOrigin(originFrame) || !Number.isInteger(lastSegment) || lastSegment < firstSegment) continue;
    if (!Number.isInteger(segmentsPerTask) || segmentsPerTask < 1) continue;
    const candidates: StreamCandidate[] = [];
    for (const c of Array.isArray(r.candidates) ? (r.candidates as Record<string, unknown>[]) : []) {
      if (c && typeof c === "object" && str(c.envFingerprint) && str(c.resultKey)) candidates.push({ envFingerprint: c.envFingerprint, resultKey: c.resultKey });
    }
    if (!candidates.length) continue;
    const topClipId = str(r.topClipId) ? r.topClipId : clipIds[clipIds.length - 1];
    out.push({ topClipId, clipIds, kind, plane, contentKey: r.contentKey, candidates, originFrame, firstSegment, lastSegment, segmentsPerTask,
      ...(str(r.inputSig) ? { inputSig: r.inputSig } : {}) });
  }
  return out;
}

/**
 * 一条流落在分段号 `[loSeg, hiSeg]`(闭区间)里的那几份清单的范围:从 `firstSegment` 起每 `segmentsPerTask` 段一份、最后一份到
 * `lastSegment`(与 `server/render-node/split.mjs`、推送队列同一种切法)。
 */
export function streamSpansInWindow(row: Pick<OnlineStream, "firstSegment" | "lastSegment" | "segmentsPerTask">, loSeg: number, hiSeg: number): Array<[number, number]> {
  const lo = Math.max(row.firstSegment, loSeg), hi = Math.min(row.lastSegment, hiSeg);
  if (hi < lo) return [];
  const per = Math.max(1, row.segmentsPerTask);
  const out: Array<[number, number]> = [];
  for (let from = row.firstSegment + Math.floor((lo - row.firstSegment) / per) * per; from <= hi; from += per) out.push([from, Math.min(row.lastSegment, from + per - 1)]);
  return out;
}

/** 内容库回包里的层表;形状不对回 null */
export function parseLayerMap(body: unknown): LayerMap | null {
  const b = body as { v?: unknown; kind?: unknown; projectId?: unknown; fps?: unknown; span?: unknown; layers?: unknown; streams?: unknown } | null;
  if (!b || b.kind !== "layer-map" || !Array.isArray(b.layers)) return null;
  // 不认得的版本整张当没有(C10 契约第 18 节第 3 条);没写版本的是 v 1(C10a 的形状)
  const v = b.v === undefined ? 1 : Number(b.v);
  if (!(KNOWN_LAYER_MAP_VERSIONS as readonly number[]).includes(v)) return null;
  const span = Math.max(1, Math.floor(Number(b.span) || 60));
  const layers: OnlineLayer[] = [];
  const str = (x: unknown) => (typeof x === "string" && x ? x : null);
  for (const raw of b.layers as Record<string, unknown>[]) {
    const kind = raw?.kind;
    if (kind !== "html" && kind !== "local") continue;
    const firstFrame = Number(raw.firstFrame), count = Number(raw.count);
    if (typeof raw.clipId !== "string" || typeof raw.key !== "string" || typeof raw.resultKey !== "string") continue;
    if (!Number.isInteger(firstFrame) || firstFrame < 0 || !Number.isInteger(count) || count < 1) continue;
    const candidates = v >= LAYER_MAP_V3 ? candidatesOf(raw.candidates) : [];
    const inputSig = str(raw.inputSig);
    layers.push({ clipId: raw.clipId, kind, key: raw.key, resultKey: raw.resultKey, firstFrame, count,
      ...(v >= LAYER_MAP_V2 ? { contentKey: str(raw.contentKey), envFingerprint: str(raw.envFingerprint) } : {}),
      ...(candidates.length ? { candidates } : {}),
      ...(inputSig ? { inputSig } : {}) });
  }
  // 轨道流表是 v 3 起才可能有的(候选的概念从 v 3 起);更早的版本不读
  const streams = v >= LAYER_MAP_V3 ? parseLayerStreams(b.streams) : [];
  return { v, projectId: typeof b.projectId === "string" ? b.projectId : null, fps: Number(b.fps) || 30, span, layers, streams };
}

/**
 * 这一层在这一档能不能用(C10 契约第 5 节、第 18 节第 3 条):
 *   - 取预渲染原尺寸(`original`):只认 v 2、且带 `contentKey` 与 `envFingerprint` 的层 —— 页面不算键,
 *     部署的 `/editor` 与渲染节点代码版本对不上、层表缺这两项时,这一层按「没有预渲染结果」处理(占位、暂停活渲),不报错;
 *   - 只贴稀疏版时(`small`):v 1、v 2 都认。
 */
export function usableLayer(map: Pick<LayerMap, "v">, layer: OnlineLayer, { anyVersion = false }: { anyVersion?: boolean } = {}): boolean {
  if (anyVersion) return true;
  return map.v >= LAYER_MAP_V2 && !!layer.contentKey && !!layer.envFingerprint;
}

/**
 * 层表里某个片段那一层(`original` 口径):层表对得上回 `{ …, contentKey, envFingerprint }`;对不上(不认得的版本、v 1、
 * 缺内容键、缺指纹、没这一层、层表坏)回 null,不抛。`table` 收内容库回包的 body 或已解析的层表。
 *
 * 层表 v 3(M7 契约 D12):`opts.alive` 是页面认定活着的结果键(由 `task.done` 与清单得出)。候选里有活着的,
 * 就整份换成那个候选(结果键、指纹、线上键同出一个候选,不混);没有 `alive` 或认不出时回层上的(第一个候选)。
 * v 2 不看 `alive`。
 * `opts.inputSig`(stale-layer):页面按当前项目算的这个片段的输入签名;这一层带签名而且对不上(旧参数的层)回 null。
 */
export function layerRefOf(table: unknown, clipId: string, opts: { anyVersion?: boolean; alive?: ReadonlySet<string>; inputSig?: string | null } = {}): OnlineLayer | null {
  let map: LayerMap | null = null;
  try {
    map = table && typeof table === "object" && Array.isArray((table as LayerMap).layers) && (table as LayerMap).v !== undefined && typeof (table as { kind?: unknown }).kind !== "string"
      ? (table as LayerMap) : parseLayerMap(table);
  } catch { map = null; }
  if (!map) return null;
  const layer = map.layers.find((l) => l.clipId === clipId);
  if (!layer) return null;
  if (inputSigStale(layer.inputSig, opts.inputSig)) return null;
  if (map.v >= LAYER_MAP_V3 && opts.alive && layer.candidates?.length) {
    const pick = layer.candidates.find((c) => opts.alive!.has(c.resultKey));
    if (pick) {
      const chosen: OnlineLayer = { ...layer, resultKey: pick.resultKey, envFingerprint: pick.envFingerprint, key: pick.key };
      return usableLayer(map, chosen, opts) ? chosen : null;
    }
  }
  return usableLayer(map, layer, opts) ? layer : null;
}

/** 一层落在 `[fromGlobal, toGlobal]`(全局帧,闭区间)的那几段:本地帧 0 起每 `span` 帧一段、最后一段到 `count - 1` */
export function segmentsInWindow(layer: Pick<OnlineLayer, "firstFrame" | "count">, span: number, fromGlobal: number, toGlobal: number): Array<[number, number]> {
  const lo = Math.max(0, fromGlobal - layer.firstFrame);
  const hi = Math.min(layer.count - 1, toGlobal - layer.firstFrame);
  if (hi < lo) return [];
  const out: Array<[number, number]> = [];
  for (let from = lo - (lo % span); from <= hi; from += span) out.push([from, Math.min(layer.count - 1, from + span - 1)]);
  return out;
}

/** 帧号表 → 合并好的闭区间 */
export function framesToRanges(frames: Iterable<number>): ReadyRange[] {
  const sorted = [...new Set(frames)].filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const f of sorted) {
    const last = out[out.length - 1];
    if (last && f === last[1] + 1) last[1] = f;
    else out.push([f, f]);
  }
  return out as unknown as ReadyRange[];
}

/** 小位图包成一张铺满快照平面的图(快照平面是包裹层里 inset:0 的一层,小位图画的正是包裹层的框) */
export function smallSnapshotHtml(dataUrl: string): string {
  return `<img data-pc-small-snapshot="" alt="" src="${dataUrl}" style="position:absolute;left:0;top:0;width:100%;height:100%;display:block;pointer-events:none">`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

/** 按字节计的 LRU(data URL 的长度就是它在内存里的大小的量级) */
export class ByteLru {
  private map = new Map<string, string>();
  private bytes = 0;
  private max: number;
  constructor(max: number) { this.max = max; }
  get(id: string): string | undefined {
    const hit = this.map.get(id);
    if (hit === undefined) return undefined;
    this.map.delete(id);
    this.map.set(id, hit);
    return hit;
  }
  set(id: string, value: string): void {
    const old = this.map.get(id);
    if (old !== undefined) { this.bytes -= old.length; this.map.delete(id); }
    this.map.set(id, value);
    this.bytes += value.length;
    while (this.bytes > this.max && this.map.size > 1) {
      const first = this.map.keys().next().value as string;
      this.bytes -= this.map.get(first)!.length;
      this.map.delete(first);
    }
  }
  has(id: string): boolean { return this.map.has(id); }
  get size(): number { return this.map.size; }
  get total(): number { return this.bytes; }
  clear(): void { this.map.clear(); this.bytes = 0; }
}

/** 按字节计的 LRU,存原始字节(轨道流的开头文件与分段) */
export class BlockLru {
  private map = new Map<string, Uint8Array>();
  private bytes = 0;
  private max: number;
  constructor(max: number) { this.max = max; }
  get(id: string): Uint8Array | undefined {
    const hit = this.map.get(id);
    if (hit === undefined) return undefined;
    this.map.delete(id);
    this.map.set(id, hit);
    return hit;
  }
  /** 放进去;回这一次被挤掉的键 */
  set(id: string, value: Uint8Array): string[] {
    const old = this.map.get(id);
    if (old !== undefined) { this.bytes -= old.byteLength; this.map.delete(id); }
    this.map.set(id, value);
    this.bytes += value.byteLength;
    const dropped: string[] = [];
    while (this.bytes > this.max && this.map.size > 1) {
      const first = this.map.keys().next().value as string;
      this.bytes -= this.map.get(first)!.byteLength;
      this.map.delete(first);
      dropped.push(first);
    }
    return dropped;
  }
  has(id: string): boolean { return this.map.has(id); }
  get size(): number { return this.map.size; }
  get total(): number { return this.bytes; }
  clear(): void { this.map.clear(); this.bytes = 0; }
}

/** 流清单里的一个开头文件(变体) */
interface StreamInitMeta { hash: string; codec: string; width: number; height: number; rect: StreamRect }
/** 流清单里的一个分段 */
interface StreamSegMeta { hash: string; init: string; stride: number; samples: number }
/** 一份流清单(`render-manifest`,`<结果键>:<起>-<止>`)取回来之后的样子 */
interface StreamManifestState {
  resultKey: string;
  header: { kind: "card" | "group" | "below"; plane: "local" | "stage"; clipIds: string[]; fps: number; bound: StreamRect; tight: StreamRect | null } | null;
  inits: Map<string, StreamInitMeta>;
  segments: Map<number, StreamSegMeta>;
  /** 这一份里每个分段都有、而且都是满密度的:不必再取(稀疏段以后会被满密度的换掉,所以还要再取) */
  full: boolean;
  fetchedAt: number;
  sig: string;
}
/** 选定了候选的一条流 */
interface ChosenStream { row: OnlineStream; resultKey: string; envFingerprint: string }

const HASH_RE = /^[0-9a-f]{64}$/;
const rectOf = (r: unknown): StreamRect | null => {
  const o = r as Partial<StreamRect> | null;
  if (!o || typeof o !== "object") return null;
  const { x, y, w, h } = o;
  return [x, y, w, h].every((n) => typeof n === "number" && Number.isFinite(n)) && (w as number) > 0 && (h as number) > 0 ? { x: x as number, y: y as number, w: w as number, h: h as number } : null;
};

/** 内容库回的一份流清单 → 状态;形状不对的开头文件、分段跳过。`seg` 是这份清单该盖住的分段范围 */
function parseStreamManifest(body: unknown, resultKey: string, seg: [number, number], now: number): StreamManifestState {
  const b = body as { kind?: unknown; resultKey?: unknown; header?: Record<string, unknown>; inits?: Record<string, Record<string, unknown>>; segments?: Record<string, Record<string, unknown>> } | null;
  const state: StreamManifestState = { resultKey, header: null, inits: new Map(), segments: new Map(), full: false, fetchedAt: now, sig: "" };
  if (!b || typeof b !== "object" || b.kind !== "stream" || b.resultKey !== resultKey) return state;
  const h = b.header;
  const bound = rectOf(h?.bound);
  const clipIds = Array.isArray(h?.clipIds) ? (h!.clipIds as unknown[]).filter((x): x is string => typeof x === "string" && !!x) : [];
  if (h && bound && clipIds.length && Number(h.fps) > 0) {
    state.header = { kind: h.kind === "group" ? "group" : h.kind === "below" ? "below" : "card", plane: h.plane === "stage" ? "stage" : "local", clipIds, fps: Number(h.fps), bound, tight: rectOf(h.tight) };
  }
  for (const [id, meta] of Object.entries(b.inits && typeof b.inits === "object" ? b.inits : {})) {
    const rect = rectOf(meta?.rect);
    if (!/^[0-9a-f]{16}$/.test(id) || !HASH_RE.test(String(meta?.hash)) || !rect || typeof meta.codec !== "string") continue;
    state.inits.set(id, { hash: String(meta.hash), codec: meta.codec, width: Number(meta.width) || 0, height: Number(meta.height) || 0, rect });
  }
  for (const [name, meta] of Object.entries(b.segments && typeof b.segments === "object" ? b.segments : {})) {
    const n = Number(name);
    if (!Number.isInteger(n) || n < seg[0] || n > seg[1] || !HASH_RE.test(String(meta?.hash)) || !state.inits.has(String(meta.init))) continue;
    const stride = Number(meta.stride), samples = Number(meta.samples);
    if (!Number.isInteger(stride) || stride < 1 || !Number.isInteger(samples) || samples < 1) continue;
    state.segments.set(n, { hash: String(meta.hash), init: String(meta.init), stride, samples });
  }
  let full = !!state.header;
  for (let n = seg[0]; n <= seg[1] && full; n++) full = state.segments.get(n)?.stride === 1;
  state.full = full;
  state.sig = JSON.stringify([state.header, [...state.inits], [...state.segments]]);
  return state;
}

/** 取回来的字节是不是这个哈希(浏览器没有 WebCrypto 时不核,当是) */
async function bytesMatchHash(bytes: Uint8Array, hash: string): Promise<boolean> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) return true;
  try {
    const digest = new Uint8Array(await subtle.digest("SHA-256", bytes as unknown as BufferSource));
    let hex = "";
    for (const v of digest) hex += v.toString(16).padStart(2, "0");
    return hex === hash;
  } catch {
    return true;
  }
}

/** 每份项目(不可变对象)一张「流 → 签名」的缓存 */
const streamSigCache = new WeakMap<object, Map<string, string | null>>();
function cachedStreamSig(project: unknown, row: Pick<OnlineStream, "clipIds" | "kind">): string | null {
  if (!project || typeof project !== "object") return null;
  let byRow = streamSigCache.get(project);
  if (!byRow) { byRow = new Map(); streamSigCache.set(project, byRow); }
  const id = `${row.kind}:${row.clipIds.join(",")}`;
  if (byRow.has(id)) return byRow.get(id) ?? null;
  const sig = streamInputSig(project, row);
  byRow.set(id, sig);
  return sig;
}

interface ManifestState {
  /** 本地帧 → 小位图哈希 */
  small: Map<number, string>;
  /** 本地帧 → 原尺寸 HTML 快照哈希(`frames` 表) */
  frames: Map<number, string>;
  /** 这一段每一帧都有这一档了:不必再取 */
  full: boolean;
  fetchedAt: number;
}

/**
 * 在线来源取哪一档(C10 契约第 5 节):`original` 取预渲染原尺寸(`snap/<hash>` 的 HTML 快照);`small` 是只贴稀疏版时:
 * 轨道流只贴稀疏版(文件头第 7 条),快照那一路取 `px/<hash>` 的小位图(预渲染小尺寸 2026-10-13 起停产,这一路取不到东西,留到撤快照时删)。
 */
export type OnlineTier = "small" | "original";

/** 页面内快照库 L2 用到的那几样(`src/online/l2.ts` 的 `L2Store`;这里只列接口,不引实现) */
export interface L2Like {
  putBlock(key: string, bytes: Uint8Array | ArrayBuffer, type?: string): Promise<unknown>;
  getBlock(key: string): Promise<{ bytes: Uint8Array; type: string } | null>;
  hasBlock(key: string): boolean;
  putRange(layerKey: string, from: number, to: number): Promise<Array<[number, number]>>;
  getRanges(layerKey: string): Promise<Array<[number, number]>>;
  subscribeReady(cb: (e: { layerKey: string; ranges: Array<[number, number]> }) => void): () => void;
}

/**
 * 只贴稀疏版时问「这台浏览器解不解得了轨道流」用的两样(文件头第 7 条)。别的档不问(照现状)。单测注入假的。
 */
export interface StreamDecodeSupport {
  /** 浏览器有没有 `VideoDecoder` */
  available(): boolean;
  /** 这一种编码配置(流清单里开头文件那一项的 `codec` 与编码画幅)解不解得了 */
  supports(config: { codec: string; codedWidth: number; codedHeight: number }): Promise<boolean>;
}
/** 缺省:问浏览器自己。`isConfigSupported` 抛错、回不出结果都算不行;没有这个方法的旧实现只看有没有 `VideoDecoder` */
export const browserDecodeSupport: StreamDecodeSupport = {
  available: () => typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === "function",
  supports: async (config) => {
    const VD = (globalThis as { VideoDecoder?: unknown }).VideoDecoder;
    if (typeof VD !== "function") return false;
    const ask = (VD as { isConfigSupported?: (c: unknown) => Promise<{ supported?: boolean }> }).isConfigSupported;
    if (typeof ask !== "function") return true;
    try { return (await ask.call(VD, config))?.supported === true; } catch { return false; }
  },
};

export interface OnlineSourceOptions {
  /** 没有 L2 时的内存缓存上限(C10a 的 64 MiB) */
  maxBytes?: number;
  tier?: OnlineTier;
  /** 只贴稀疏版时问浏览器解不解得了流(缺省 `browserDecodeSupport`) */
  decodeSupport?: StreamDecodeSupport;
  /** 页面内快照库 L2(C10 契约第 4 节);给了就把块存进它,内存里只留一小份刚用过的 */
  store?: L2Like | Promise<L2Like | null> | null;
}

/** 等 L2 打开最多这么久(毫秒),打不开就照内存走 */
export const STORE_WAIT_MS = 5000;
/** 有 L2 时内存里只留这么多刚用过的(免得同一窗口里反复解码 / 反复读库) */
export const ONLINE_HOT_CACHE_BYTES = 16 * 1024 * 1024;

const textDecoder = typeof TextDecoder !== "undefined" ? new TextDecoder() : null;

/** 在线实现(见上) */
export class OnlineSnapshotSource implements SnapshotSource {
  private deps: OnlineSnapshotDeps;
  private cache: ByteLru;
  private inflight = new Map<string, Promise<string>>();
  private projectId: string | null = null;
  private map: LayerMap | null = null;
  private mapSig = "";
  private manifests = new Map<string, ManifestState>();
  private manifestFlying = new Set<string>();
  /** 轨道流:各份流清单(`<结果键>:<起>-<止>` → 状态) */
  private streamManifests = new Map<string, StreamManifestState>();
  /** 轨道流:已取到本页的开头文件与分段(哈希 → 字节) */
  private streamBlocks = new BlockLru(STREAM_CACHE_MAX_BYTES);
  private streamFlying = new Map<string, Promise<void>>();
  /** 取失败的块:哈希 → 失败的时刻(过 `STREAM_RETRY_MS` 再取) */
  private streamFailedAt = new Map<string, number>();
  private streamPlaneMemo = new Map<string, { rev: number; plane: { manifest: StreamManifest; blocks: Map<string, Uint8Array> } | null }>();
  /** 流的清单或字节变了就加一:父页据此重发流平面(同一段换了文件时就绪区间一个字不变,光比区间看不出来) */
  streamRev = 0;
  /** 各层最后发出去的就绪(`<kind>:<clipId>` → 签名与撤层要用的键);层不能用了(过期、没了)就发空层撤掉 */
  private emitted = new Map<string, { sig: string; clipId: string; kind: ReadyKind; key: string }>();
  /** 页面此刻的项目(按它算各片段的输入签名,stale-layer);没给就不比签名 */
  private inputProject: unknown = null;
  /** 过期的层:片段 → 从哪一刻起(层的签名与页面的签名那一对没变就不重计) */
  private staleSince = new Map<string, { key: string; since: number; expired: boolean }>();
  private listeners = new Set<(m: ReadyMessage) => void>();
  private timer: unknown = null;
  private playhead = { t: 0, fps: 30 };
  private lastMapAt = -Infinity;
  private stopped = false;
  private running: Promise<void> | null = null;
  private again = false;
  private queue: Array<() => Promise<void>> = [];
  private active = 0;
  readonly tier: OnlineTier;
  private store: L2Like | null = null;
  private storeOff: (() => void) | null = null;
  /**
   * L2 还在打开时先别取:不然第一轮预取在库打开之前就发出去,关掉再开时已在库里的块又被请求一遍(C10-A2)。
   * 最多等 `STORE_WAIT_MS`,打不开就照内存走。
   */
  private storeWait: Promise<unknown> | null = null;
  /** 原尺寸:每层(按结果键)已在 L2 里的本地帧(`ranges` 表的镜像) */
  private inStore = new Map<string, Set<number>>();
  private rangesLoaded = new Set<string>();
  /** 取到一张新的块之后叫(宿主据此重投一次) */
  onFetched: (() => void) | null = null;
  /** 层表取回来过没有(取到了,或者内容库回「没有这一项」);取之前判不了哪些层缺产物 */
  private mapKnown = false;
  /** 覆盖情况可能变了(层表换了、清单到了)时叫的订阅方 */
  private coverageListeners = new Set<() => void>();
  readonly stats = { mapFetches: 0, manifestFetches: 0, smallFetches: 0, smallBytes: 0, snapFetches: 0, snapBytes: 0, l2Hits: 0, errors: 0,
    streamManifestFetches: 0, streamFetches: 0, streamBytes: 0, streamFailures: 0 };

  private decodeSupport: StreamDecodeSupport;
  /** 只贴稀疏版时:开头文件(按哈希)的编码配置这台浏览器解不解得了;在问的是 null */
  private initDecodable = new Map<string, boolean | null>();

  constructor(deps: OnlineSnapshotDeps, { maxBytes = ONLINE_CACHE_MAX_BYTES, tier = "small", store = null, decodeSupport = browserDecodeSupport }: OnlineSourceOptions = {}) {
    this.deps = deps;
    this.tier = tier;
    this.decodeSupport = decodeSupport;
    if (tier === "small") this.streamBlocks = new BlockLru(SPARSE_STREAM_CACHE_MAX_BYTES);
    this.cache = new ByteLru(store ? Math.min(maxBytes, ONLINE_HOT_CACHE_BYTES) : maxBytes);
    if (store) {
      const opened = Promise.resolve(store).then((s) => {
        if (!s || this.stopped) return;
        this.store = s;
        this.storeOff = s.subscribeReady((e) => this.onStoreReady(e.layerKey, e.ranges));
        this.rangesLoaded.clear();
      }, () => { /* 打不开 L2:照内存走 */ });
      this.storeWait = Promise.race([opened, new Promise((r) => setTimeout(r, STORE_WAIT_MS))]).then(() => { this.storeWait = null; });
    }
  }

  private now(): number { return (this.deps.now ?? Date.now)(); }
  /** 只贴稀疏版时(只有一个舞台;层表 v 1 也认) */
  private get sparseOnly(): boolean { return this.tier === "small"; }

  /** 这一档此刻能用的层(`original` 只认 v 2 且两项齐的层;输入签名对不上的旧层不算) */
  private layers(): OnlineLayer[] {
    const map = this.map;
    if (!map) return [];
    return map.layers.map((l) => this.chosen(map, l)).filter((l) => usableLayer(map, l, { anyVersion: this.sparseOnly }) && !this.stale(l));
  }

  /** 页面按当前项目算的这个片段的输入签名;没给项目回 null(不比) */
  private pageSig(clipId: string): string | null {
    return this.inputProject ? cachedClipInputSig(this.inputProject, clipId) : null;
  }

  /** 这一层是旧输入的结果(层带签名,页面也算得出,两者不同) */
  private stale(layer: OnlineLayer): boolean {
    return !!layer.inputSig && inputSigStale(layer.inputSig, this.pageSig(layer.clipId));
  }

  /** 层表里这个片段那一层过期了(这一档本来能用、只是输入对不上) */
  private staleLayerOf(clipId: string): OnlineLayer | null {
    const map = this.map;
    if (!map) return null;
    for (const raw of map.layers) {
      if (raw.clipId !== clipId) continue;
      const l = this.chosen(map, raw);
      if (usableLayer(map, l, { anyVersion: this.sparseOnly }) && this.stale(l)) return l;
    }
    return null;
  }

  /** 记下哪些层过期、从哪一刻起;不再过期的删掉。回「过期集合变了没有」 */
  private noteStale(): boolean {
    const map = this.map;
    const now = this.now();
    const seen = new Set<string>();
    let changed = false;
    for (const raw of map?.layers ?? []) {
      if (seen.has(raw.clipId)) continue;
      const l = this.staleLayerOf(raw.clipId);
      if (!l) continue;
      seen.add(l.clipId);
      const key = `${l.inputSig}|${this.pageSig(l.clipId)}`;
      const rec = this.staleSince.get(l.clipId);
      if (!rec || rec.key !== key) { this.staleSince.set(l.clipId, { key, since: now, expired: false }); changed = true; }
    }
    for (const id of [...this.staleSince.keys()]) if (!seen.has(id)) { this.staleSince.delete(id); changed = true; }
    return changed;
  }

  /** 过期的层还在「新结果在路上」那段时间里(`STALE_AWAIT_MS`) */
  private staleAwaiting(clipId: string): boolean {
    if (!this.staleLayerOf(clipId)) return false;
    const rec = this.staleSince.get(clipId);
    if (!rec) return true;
    return this.now() - rec.since < STALE_AWAIT_MS;
  }

  /**
   * 页面此刻的项目(stale-layer):按它算各片段的输入签名,与层表里每层的 `inputSig` 比对,对不上的旧层马上撤掉
   * (就绪区间发空,页面按兜底顺序显示占位或活渲),对上了(改回原来的参数)照贴。项目换了新对象才重算。
   */
  setInputs(project: unknown): void {
    const next = project && typeof project === "object" ? project : null;
    if (next === this.inputProject) return;
    this.inputProject = next;
    const changed = this.noteStale();
    // 流的输入签名跟着项目变:过期的流在 publishLayers 里撤掉(发空层),对回来了照发
    this.streamPlaneMemo.clear();
    this.publishLayers();
    if (changed) this.coverageChanged();
  }

  /*
   * 层表 v 3 的候选(M7 契约 D12):哪一份活着由本页按队列推来的 `task.done`(活)与 `task.failed { error: 'superseded' }`
   * (那一份作废了 —— 另一份活着,不是失败)认定。认定活着的候选优先;都没认定时取第一个没作废的;全作废或没有候选照旧用层上的。
   * 选定之后整份换成那个候选(`layerRefOf` 的 `alive`,结果键、指纹、线上键同出一个候选)。
   */
  private aliveKeys = new Set<string>();
  private deadKeys = new Set<string>();

  private chosen(map: LayerMap, layer: OnlineLayer): OnlineLayer {
    if (map.v < LAYER_MAP_V3 || !layer.candidates?.length) return layer;
    const pick = layer.candidates.find((c) => this.aliveKeys.has(c.resultKey)) ?? layer.candidates.find((c) => !this.deadKeys.has(c.resultKey));
    if (!pick || pick.resultKey === layer.resultKey) return layer;
    return layerRefOf(map, layer.clipId, { anyVersion: this.sparseOnly, alive: new Set([pick.resultKey]) }) ?? layer;
  }

  /**
   * 队列推给本页(作为发布方)的 `task.done` / `task.failed`(M7 D12):完成的结果键认定活着,`superseded` 作废的那一份当死。
   * 认定变了就马上重发各层(换了候选的层整层换键)。别的消息不理。
   */
  noteQueueEvent(msg: { type?: unknown; id?: unknown; resultKey?: unknown; error?: unknown }): void {
    const id = typeof msg?.id === "string" ? msg.id : "";
    const keyOf = () => {
      if (typeof msg.resultKey === "string" && msg.resultKey) return msg.resultKey;
      // 细任务 id:`<kind>:<resultKey>:<from>-<to>`;稀疏流任务的 id 末尾多一段 `:sparse`(`server/render-queue/messages.mjs` 的 `taskIdOf`)
      const m = /^(?:snapshot|stream):(.+):\d+-\d+(?::sparse)?$/.exec(id);
      return m ? m[1] : null;
    };
    let changed = false;
    if (msg?.type === "task.done") {
      const key = keyOf();
      if (key && !this.aliveKeys.has(key)) { this.aliveKeys.add(key); this.deadKeys.delete(key); changed = true; }
    } else if (msg?.type === "task.failed" && msg.error === "superseded") {
      const key = keyOf();
      if (key && !this.deadKeys.has(key) && !this.aliveKeys.has(key)) { this.deadKeys.add(key); changed = true; }
    }
    if (changed) { this.publishLayers(); this.kick(); }
  }

  /** 本页自己产出并完成了这一段(纯浏览器节点):这个结果键活着 */
  markAlive(resultKey: string): void {
    this.noteQueueEvent({ type: "task.done", resultKey });
  }

  /** 看哪个项目(层表的键);换了项目就清表重来 */
  setProject(projectId: string | null): void {
    const next = projectId || null;
    if (next === this.projectId) return;
    this.projectId = next;
    this.map = null;
    this.mapSig = "";
    this.mapKnown = false;
    this.manifests.clear();
    this.streamManifests.clear();
    this.streamFailedAt.clear();
    this.streamPlaneMemo.clear();
    this.streamRev++;
    this.emitted.clear();
    this.staleSince.clear();
    this.lastMapAt = -Infinity;
    this.emit({ type: "reset", localRev: 0 });
    this.coverageChanged();
    this.kick();
  }

  /**
   * 队列报了 `task.done`(C10 契约第 7 节「页面订阅 task.done,并入层表与就绪」):不等下一轮轮询,马上重取层表、
   * 还没满的清单也重取。
   */
  refresh(): void {
    this.lastMapAt = -Infinity;
    for (const st of this.manifests.values()) if (!st.full) st.fetchedAt = -Infinity;
    for (const st of this.streamManifests.values()) if (!st.full) st.fetchedAt = -Infinity;
    this.kick();
  }

  /** 播放头挪了:取这一窗口的清单,预取这一窗口可见重层的块 */
  focus(t: number, fps: number): void {
    this.playhead = { t: Number(t) || 0, fps: Math.max(1, Number(fps) || 30) };
    this.kick();
  }

  subscribeReady(_session: string, _localRev: number, onMessage: (m: ReadyMessage) => void): () => void {
    this.listeners.add(onMessage);
    // 新订阅方:先 reset,再把手里已有的层全量发一遍(C3 的恢复路)
    try { onMessage({ type: "reset", localRev: 0 }); } catch { /* 订阅方坏了 */ }
    for (const layer of this.layers()) {
      try { onMessage(this.layerMessage(layer)); } catch { /* 同上 */ }
    }
    for (const s of this.streamsNow()) {
      const msg = this.streamMessage(s);
      if (msg.type === "layer" && msg.ranges.length) { try { onMessage(msg); } catch { /* 同上 */ } }
    }
    this.kick();
    return () => { this.listeners.delete(onMessage); };
  }

  async fetchSnapshot(kind: ReadyKind, key: string, localFrame: number, signal?: AbortSignal): Promise<string> {
    if (this.storeWait) await this.storeWait;
    if (this.tier === "original") {
      const hit = this.frameOf(kind, key, localFrame);
      if (!hit) throw Object.assign(new Error(`没有这一帧的预渲染原尺寸:${kind}/${key}/${localFrame}`), { status: 404 });
      const cached = this.cache.get(`snap/${hit.hash}`);
      if (cached !== undefined) return cached;
      return this.fetchOriginal(hit.hash, hit.layer, localFrame, signal);
    }
    const hash = this.smallHashOf(kind, key, localFrame);
    if (!hash) throw Object.assign(new Error(`没有这一帧的预渲染小尺寸:${kind}/${key}/${localFrame}`), { status: 404 });
    const hit = this.cache.get(hash);
    if (hit !== undefined) return smallSnapshotHtml(hit);
    return smallSnapshotHtml(await this.fetchSmall(hash, signal));
  }

  /**
   * 这个片段的预渲染结果覆盖了多少(C10 契约第 9 节,时间轴徽标用):层表还没取到 → `unknown`;这一档没有可用的层 → `none`;
   * 层在,但有哪一段的清单从没取到过 → `unknown`;每一段的清单都取到过、有哪一段这一档的帧不齐 → `partial`;每一段都齐 → `full`。
   * 「齐」看清单(结果在素材服务里),不看字节有没有取到本页。整段的清单由 `coverageLayer` 点名的层才取(见 `loadWindow`)。
   * 徽标只在确认没覆盖整段(`none` / `partial`)时出;`unknown` 不出(刚打开页面时不闪)。
   */
  coverage(clipId: string): LayerCoverage {
    if (!this.mapKnown) return "unknown";
    const layer = this.layers().find((l) => l.clipId === clipId);
    // 旧输入的层:新结果在路上的那段时间里还不知道(不出徽标)
    if (!layer) return this.staleAwaiting(clipId) ? "unknown" : "none";
    const span = this.map?.span ?? 60;
    let partial = false;
    for (let from = 0; from < layer.count; from += span) {
      const seg = this.segOf(layer, from);
      const st = this.manifests.get(this.manifestKey(layer, seg));
      if (!st) return "unknown";
      const mine = this.tier === "original" ? st.frames : st.small;
      if (mine.size < seg[1] - seg[0] + 1) partial = true;
    }
    return partial ? "partial" : "full";
  }

  /**
   * 父页能不能确认「这个片段这一帧没有可贴的预渲染结果」(C10 契约第 9 节;2026-10-21 起舞台一律显示沙漏,不再据此换图标):
   * 层表已经取到、这片段没有可用的层;或者这一帧所在那一段的清单已经取到、这一帧(这一档)不在里面。
   * 层表没取到、清单没到、清单里有而字节还在路上,都不算确认(舞台显示普通加载占位)。
   * `localFrame` 按片段本地帧,夹进层的帧数里。
   */
  frameConfirmedMissing(clipId: string, localFrame: number): boolean {
    if (!this.mapKnown) return false;
    const layer = this.layers().find((l) => l.clipId === clipId);
    // 旧输入的层(stale-layer):渲染节点还没按新输入重写层表的那段时间里不确认(沙漏),过了 `STALE_AWAIT_MS` 才确认
    if (!layer) return !this.staleAwaiting(clipId);
    if (layer.count <= 0) return true;
    const f = Math.min(layer.count - 1, Math.max(0, Math.round(Number(localFrame) || 0)));
    const st = this.manifests.get(this.manifestKey(layer, this.segOf(layer, f)));
    if (!st) return false;
    return !(this.tier === "original" ? st.frames : st.small).has(f);
  }

  /** 覆盖情况可能变了就叫 `cb`(层表换了、清单到了);回退订函数 */
  subscribeCoverage(cb: () => void): () => void {
    this.coverageListeners.add(cb);
    return () => { this.coverageListeners.delete(cb); };
  }

  private coverageChanged() {
    for (const l of [...this.coverageListeners]) { try { l(); } catch { /* 订阅方坏了 */ } }
  }

  /**
   * 层表里列着的片段(c10a 契约第 17 节「预渲染重试」按清单判产物:不在层表里的判重层,素材服务里就没有它的产物)。
   * 层表还没取回来过回 null(判不了);内容库里没有层表回空集合(一层都没有)。
   */
  layerClipIds(): ReadonlySet<string> | null {
    if (!this.mapKnown) return null;
    return new Set(this.layers().map((l) => l.clipId));
  }

  /** 此刻的层表(探针用);还没有回 null */
  layerMap(): LayerMap | null {
    return this.map;
  }

  /** 导出前释放缓存(契约第 11.1 节):内存里那一份;L2 是可重建的缓存库,不动 */
  clearCache(): void { this.cache.clear(); }
  get cacheBytes(): number { return this.cache.total; }
  get cacheSize(): number { return this.cache.size; }
  /** 探针用:此刻的层表与各层就绪帧数 */
  debug() {
    const usable = this.layers();
    return {
      projectId: this.projectId,
      tier: this.tier,
      mapVersion: this.map?.v ?? null,
      store: !!this.store,
      layers: usable.map((l) => ({ clipId: l.clipId, kind: l.kind, key: l.key, resultKey: l.resultKey, envFingerprint: l.envFingerprint ?? null, ready: this.readyFrames(l).length,
        candidates: l.candidates?.length ?? 0, inputSig: l.inputSig ?? null })),
      stale: [...this.staleSince.entries()].map(([clipId, r]) => ({ clipId, sinceMs: this.now() - r.since, awaiting: this.now() - r.since < STALE_AWAIT_MS })),
      aliveKeys: this.aliveKeys.size,
      deadKeys: this.deadKeys.size,
      skipped: (this.map?.layers ?? []).filter((l) => !usable.includes(l)).map((l) => l.clipId),
      manifests: this.manifests.size,
      streams: this.streamsNow().map((s) => ({ clipId: s.row.topClipId, kind: s.row.kind, members: s.row.clipIds.length, resultKey: s.resultKey, envFingerprint: s.envFingerprint,
        candidates: s.row.candidates.length, originFrame: s.row.originFrame, firstSegment: s.row.firstSegment, lastSegment: s.row.lastSegment, ready: this.streamReady(s).length, inputSig: s.row.inputSig ?? null })),
      staleStreams: (this.map?.streams ?? []).filter((r) => this.streamStale(r)).map((r) => r.topClipId),
      streamManifests: this.streamManifests.size, streamBlocks: this.streamBlocks.size, streamBlockBytes: this.streamBlocks.total, streamRev: this.streamRev,
      cacheBytes: this.cache.total, cacheSize: this.cache.size, ...this.stats,
    };
  }

  /* ---------------- 轨道流(对外) ---------------- */

  /**
   * 父页给舞台发流平面时要带过去的东西(`streamPlayer.ts` 的 `StreamPlaneSender` 来问):这条流(就绪索引线上的键 = 结果键)此刻的清单
   * 与字节。清单只列字节已在本页的分段(与发出去的就绪区间同一个口径),分段的 `file` 就是它的哈希,开头文件另带 `hash`;
   * `blocks` 是清单用到的全部块。这条流不在层表里、过期了、或一段都没取到回 null。
   */
  streamPlane(key: string): { manifest: StreamManifest; blocks: Map<string, Uint8Array> } | null {
    const memo = this.streamPlaneMemo.get(key);
    if (memo && memo.rev === this.streamRev) {
      // 用到的块算最近用过(不让正在播的这几段被挤掉)
      if (memo.plane) for (const hash of memo.plane.blocks.keys()) this.streamBlocks.get(hash);
      return memo.plane;
    }
    const plane = this.buildStreamPlane(key);
    if (this.streamPlaneMemo.size > 64) this.streamPlaneMemo.clear();
    this.streamPlaneMemo.set(key, { rev: this.streamRev, plane });
    return plane;
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) (this.deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
    this.listeners.clear();
    this.coverageListeners.clear();
    this.queue.length = 0;
    this.streamBlocks.clear();
    this.streamPlaneMemo.clear();
    this.storeOff?.();
    this.storeOff = null;
  }

  /** 单测用:手动跑一轮(取层表、取窗口里的清单、预取) */
  async tickNow(): Promise<void> { await this.tick(); }

  /** 单测用:等在飞的取块都落定 */
  async idle(): Promise<void> {
    for (let i = 0; i < 50 && (this.inflight.size || this.streamFlying.size || this.active || this.queue.length); i++) {
      await Promise.allSettled([...this.inflight.values(), ...this.streamFlying.values()]);
    }
  }

  /* ---------------- 内部 ---------------- */

  private emit(m: ReadyMessage) {
    for (const l of [...this.listeners]) { try { l(m); } catch { /* 订阅方坏了不影响别人 */ } }
  }

  private manifestKey(layer: OnlineLayer, seg: [number, number]) { return `${layer.resultKey}:${seg[0]}-${seg[1]}`; }

  private segOf(layer: OnlineLayer, localFrame: number): [number, number] {
    const span = this.map?.span ?? 60;
    const from = localFrame - (localFrame % span);
    return [from, Math.min(layer.count - 1, from + span - 1)];
  }

  private readyFrames(layer: OnlineLayer): number[] {
    const out: number[] = [];
    const span = this.map?.span ?? 60;
    const have = this.inStore.get(layer.resultKey);
    for (let from = 0; from < layer.count; from += span) {
      const st = this.manifests.get(this.manifestKey(layer, this.segOf(layer, from)));
      if (!st) continue;
      if (this.tier === "original") {
        // 写入即就绪(C10 契约第 4 节):清单里有、块也已写进 L2 的帧才算就绪;没有 L2 时退回「清单里有」
        for (const f of st.frames.keys()) if (!this.store || have?.has(f)) out.push(f);
      } else {
        for (const f of st.small.keys()) out.push(f);
      }
    }
    return out;
  }

  private layerMessage(layer: OnlineLayer): ReadyMessage {
    return { type: "layer", clipId: layer.clipId, kind: layer.kind, key: layer.key, ranges: framesToRanges(this.readyFrames(layer)) };
  }

  /** 各层的就绪区间变了才发(全量语义);发过、现在不能用了的层(输入对不上、这一档不认了)发空层撤掉 */
  private publishLayers() {
    const live = new Set<string>();
    for (const layer of this.layers()) {
      const msg = this.layerMessage(layer);
      if (msg.type !== "layer") continue;
      const id = `${layer.kind}:${layer.clipId}`;
      live.add(id);
      const sig = `${msg.key}|${JSON.stringify(msg.ranges)}`;
      if (this.emitted.get(id)?.sig === sig) continue;
      this.emitted.set(id, { sig, clipId: layer.clipId, kind: layer.kind, key: layer.key });
      this.emit(msg);
    }
    // 轨道流:每条流一层(`kind: 'stream'`,区间单位是分段号)。一段都没取到的不发;发过、现在没了的在下面撤掉
    for (const s of this.streamsNow()) {
      const msg = this.streamMessage(s);
      if (msg.type !== "layer" || !msg.ranges.length) continue;
      const id = `stream:${s.row.topClipId}`;
      if (live.has(id)) continue;   // 同一张卡在表里列了两行:只认第一行
      live.add(id);
      const sig = `${msg.key}|${JSON.stringify(msg.ranges)}|${msg.groupClipIds?.join(",") ?? ""}|${msg.originFrame ?? ""}|${msg.streamKind ?? ""}|${msg.inputSig ?? ""}`;
      if (this.emitted.get(id)?.sig === sig) continue;
      this.emitted.set(id, { sig, clipId: s.row.topClipId, kind: "stream", key: s.resultKey });
      this.emit(msg);
    }
    for (const [id, prev] of [...this.emitted]) {
      if (live.has(id)) continue;
      this.emitted.delete(id);
      this.emit({ type: "layer", clipId: prev.clipId, kind: prev.kind, key: prev.key, ranges: [] });
    }
  }

  /** L2 的 `ranges` 写入了(写入即就绪):更新镜像,重发就绪 */
  private onStoreReady(layerKey: string, ranges: Array<[number, number]>) {
    const set = new Set<number>();
    for (const [a, b] of ranges) for (let f = a; f <= b; f++) set.add(f);
    this.inStore.set(layerKey, set);
    if (this.layers().some((l) => l.resultKey === layerKey)) this.publishLayers();
  }

  /** 层表到了:把每层已在 L2 里的区间读进镜像(关掉再开时,已在库里的块不再请求) */
  private async loadStoreRanges(): Promise<void> {
    const store = this.store;
    if (!store || this.tier !== "original") return;
    let changed = false;
    for (const layer of this.layers()) {
      if (this.rangesLoaded.has(layer.resultKey)) continue;
      this.rangesLoaded.add(layer.resultKey);
      try {
        const ranges = await store.getRanges(layer.resultKey);
        const set = this.inStore.get(layer.resultKey) ?? new Set<number>();
        for (const [a, b] of ranges) for (let f = a; f <= b; f++) set.add(f);
        this.inStore.set(layer.resultKey, set);
        changed = true;
      } catch { this.rangesLoaded.delete(layer.resultKey); }
    }
    if (changed) this.publishLayers();
  }

  private smallHashOf(kind: ReadyKind, key: string, localFrame: number): string | null {
    for (const layer of this.layers()) {
      if (layer.kind !== kind || layer.key !== key) continue;
      const hash = this.manifests.get(this.manifestKey(layer, this.segOf(layer, localFrame)))?.small.get(localFrame);
      if (hash) return hash;
    }
    return null;
  }

  /**
   * 原尺寸:这一帧的 HTML 快照哈希与它所在的那一层。一层只取层表记录的那一种环境的帧(C10 契约第 5 节):
   * 清单按层表那一层的结果键取,而结果键就是「内容键 × 那个环境的指纹」。
   */
  private frameOf(kind: ReadyKind, key: string, localFrame: number): { hash: string; layer: OnlineLayer } | null {
    for (const layer of this.layers()) {
      if (layer.kind !== kind || layer.key !== key) continue;
      const hash = this.manifests.get(this.manifestKey(layer, this.segOf(layer, localFrame)))?.frames.get(localFrame);
      if (hash) return { hash, layer };
    }
    return null;
  }

  private kick() {
    if (this.stopped) return;
    void this.tick();
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    const clear = this.deps.clearTimer ?? ((t: unknown) => clearTimeout(t as ReturnType<typeof setTimeout>));
    const set = this.deps.setTimer ?? ((fn: () => void, d: number) => setTimeout(fn, d));
    if (this.timer !== null) clear(this.timer);
    this.timer = set(() => { this.timer = null; void this.tick(); }, ms);
  }

  /** 跑一轮;正在跑就记一笔、跑完再跑一轮(播放头、项目在这一轮里又变了) */
  private tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.running) { this.again = true; return this.running; }
    this.running = (async () => {
      do {
        this.again = false;
        try { await this.tickOnce(); } catch { this.stats.errors++; }
      } while (this.again && !this.stopped);
    })().finally(() => {
      this.running = null;
      this.schedule(MANIFEST_POLL_MS);
    });
    return this.running;
  }

  private async tickOnce(): Promise<void> {
    if (this.storeWait) await this.storeWait;
    const now = this.now();
    // 过期的层等满 `STALE_AWAIT_MS` 还没等到新层:从「在路上」转成确认缺料,叫覆盖订阅方重算(图标、徽标)
    let expired = false;
    for (const rec of this.staleSince.values()) {
      if (!rec.expired && now - rec.since >= STALE_AWAIT_MS) { rec.expired = true; expired = true; }
    }
    if (expired) this.coverageChanged();
    if (this.projectId && now - this.lastMapAt >= LAYER_MAP_POLL_MS) {
      this.lastMapAt = now;
      await this.loadMap();
    }
    await this.loadStoreRanges();
    await this.loadWindow(now);
    await this.loadStreamWindow(now);
    this.prefetchStreams();
  }

  /* ---------------- 轨道流(内部) ---------------- */

  /** 这条流是旧输入的结果(行里带签名,页面也算得出,两者不同) */
  private streamStale(row: OnlineStream): boolean {
    return !!row.inputSig && !!this.inputProject && streamSigStale(row.inputSig, cachedStreamSig(this.inputProject, row));
  }

  /**
   * 只贴稀疏版时:用这个开头文件的流这台浏览器贴不贴得了(文件头第 7 条)。别的档恒为 true。头一次问到时去问浏览器,
   * 问完之前当不行(那几段先不取、不算就绪),问到「行」再重发就绪。
   */
  private decodable(init: StreamInitMeta): boolean {
    if (!this.sparseOnly) return true;
    const known = this.initDecodable.get(init.hash);
    if (known !== undefined) return known === true;
    this.initDecodable.set(init.hash, null);
    if (this.initDecodable.size > 1024) { this.initDecodable.clear(); this.initDecodable.set(init.hash, null); }
    void Promise.resolve()
      .then(() => this.decodeSupport.supports({ codec: init.codec, codedWidth: init.width, codedHeight: init.height }))
      .catch(() => false)
      .then((ok) => {
        this.initDecodable.set(init.hash, ok === true);
        if (ok === true && !this.stopped) { this.prefetchStreams(); this.streamChanged(); }
      });
    return false;
  }

  /**
   * 此刻能用的流(只贴稀疏版时要浏览器有 `VideoDecoder`,没有就照没有流办),各自选定一个候选:认定活着的优先,都没认定时取第一个没作废的,
   * 全作废照旧用第一个 —— 同快照层的 `chosen`。旧输入的流不算。
   */
  private streamsNow(): ChosenStream[] {
    const map = this.map;
    if (!map || !map.streams.length) return [];
    if (this.sparseOnly && !this.decodeSupport.available()) return [];
    const out: ChosenStream[] = [];
    for (const row of map.streams) {
      if (this.streamStale(row)) continue;
      const pick = row.candidates.find((c) => this.aliveKeys.has(c.resultKey)) ?? row.candidates.find((c) => !this.deadKeys.has(c.resultKey)) ?? row.candidates[0];
      if (pick) out.push({ row, resultKey: pick.resultKey, envFingerprint: pick.envFingerprint });
    }
    return out;
  }

  private streamManifestKey(resultKey: string, seg: [number, number]) { return `${resultKey}:${seg[0]}-${seg[1]}`; }

  /** 第 n 段在哪一份清单里(那份清单取到过才有) */
  private streamSegment(s: ChosenStream, n: number): { seg: StreamSegMeta; init: StreamInitMeta; state: StreamManifestState } | null {
    const span = streamSpansInWindow(s.row, n, n)[0];
    if (!span) return null;
    const state = this.streamManifests.get(this.streamManifestKey(s.resultKey, span));
    const seg = state?.segments.get(n);
    const init = seg ? state!.inits.get(seg.init) : undefined;
    return state && seg && init ? { seg, init, state } : null;
  }

  /** 这条流就绪的分段号:清单里列着、而且分段与它的开头文件的字节都已在本页 */
  private streamReady(s: ChosenStream): number[] {
    const out: number[] = [];
    for (const state of this.streamManifests.values()) {
      if (state.resultKey !== s.resultKey || !state.header) continue;
      for (const [n, seg] of state.segments) {
        if (n < s.row.firstSegment || n > s.row.lastSegment) continue;
        const init = state.inits.get(seg.init);
        if (init && this.streamBlocks.has(seg.hash) && this.streamBlocks.has(init.hash) && this.decodable(init)) out.push(n);
      }
    }
    return out;
  }

  /**
   * 依赖下层的流另带两项(同桌面预渲染进程发的那一层,`server/frame-stream.mjs` 的 `belowLayerMark`):`streamKind: "below"` ——
   * 父页据此发 `plane: "stage"` 的流平面(`src/editor/snapshotFeed.ts` 的 `streamLayers`),舞台把它挂在舞台根下、按舞台坐标贴;
   * `inputSig` —— 层表那一行带的输入签名,父页按 store 里当前的项目再比一次(项目一改当场撤,不等本来源收到新项目重发就绪)。
   */
  private streamMessage(s: ChosenStream): ReadyMessage {
    return { type: "layer", clipId: s.row.topClipId, kind: "stream", key: s.resultKey, ranges: framesToRanges(this.streamReady(s)),
      originFrame: s.row.originFrame, ...(s.row.kind === "group" ? { groupClipIds: [...s.row.clipIds] } : {}),
      ...(s.row.kind === "below" ? { streamKind: "below" as const, ...(s.row.inputSig ? { inputSig: s.row.inputSig } : {}) } : {}) };
  }

  /** 流的清单或字节变了:记一笔、重发就绪、叫宿主重投(流平面要带上新到的字节) */
  private streamChanged(): void {
    this.streamRev++;
    this.streamPlaneMemo.clear();
    if (this.stopped) return;
    this.publishLayers();
    try { this.onFetched?.(); } catch { /* 宿主坏了 */ }
  }

  /**
   * 播放头这一窗口落在**这条流**的哪几个分段:往回 `STREAM_BEHIND_SEGMENTS` 段,往前 `PREFETCH_SEC` 秒。回 `[lo, hi, cur]`,
   * `cur` 是播放头所在的分段号。分段号是每条流自己的(从它的第一帧起数),所以窗口按流各算各的;播放头还没到这条流、
   * 往前这几秒也够不着它时 `hi` 是负数,这条流这一轮什么都不取。
   */
  private streamWindow(row: Pick<OnlineStream, "originFrame">): [number, number, number] {
    const fps = this.map?.fps || this.playhead.fps;
    const g = Math.max(0, Math.floor(this.playhead.t * fps + 1e-6));
    const cur = streamSegmentOf(g, row.originFrame);
    return [Math.max(0, cur - STREAM_BEHIND_SEGMENTS), streamSegmentOf(g + Math.ceil(PREFETCH_SEC * fps), row.originFrame), cur];
  }

  /** 取这一窗口里各条流的清单(没取过的、还没满的隔 `MANIFEST_POLL_MS` 再取) */
  private async loadStreamWindow(now: number): Promise<void> {
    const map = this.map;
    const streams = this.streamsNow();
    if (!map || !streams.length) return;
    const wanted: { resultKey: string; seg: [number, number]; key: string }[] = [];
    for (const s of streams) {
      const [lo, hi] = this.streamWindow(s.row);
      for (const seg of streamSpansInWindow(s.row, lo, hi)) {
        const key = this.streamManifestKey(s.resultKey, seg);
        const st = this.streamManifests.get(key);
        if (st?.full) continue;
        if (st && now - st.fetchedAt < MANIFEST_POLL_MS) continue;
        if (this.manifestFlying.has(`stream|${key}`) || wanted.some((w) => w.key === key)) continue;
        wanted.push({ resultKey: s.resultKey, seg, key });
      }
    }
    if (!wanted.length) return;
    let changed = false;
    await Promise.all(wanted.map(async ({ resultKey, seg, key }) => {
      this.manifestFlying.add(`stream|${key}`);
      try {
        const reply = await this.request({ type: "content.get", kind: "render-manifest", key });
        this.stats.streamManifestFetches++;
        const prev = this.streamManifests.get(key);
        const next = reply?.type === "content.item" && !reply.missing
          ? parseStreamManifest(reply.body, resultKey, seg, this.now())
          : parseStreamManifest(null, resultKey, seg, this.now());
        // 内容库这一次没回(或回了个空的)而手里有:留着手里的,只记下取过的时刻
        if (!next.segments.size && prev?.segments.size) { prev.fetchedAt = this.now(); return; }
        if (!prev || prev.sig !== next.sig) changed = true;
        this.streamManifests.set(key, next);
      } catch {
        this.stats.errors++;
      } finally {
        this.manifestFlying.delete(`stream|${key}`);
      }
    }));
    if (changed && this.map === map && !this.stopped) this.streamChanged();
  }

  /** 预取:这一窗口里各条流的分段与它们的开头文件,离播放头近的先取;已在本页的、在飞的、刚失败过的不取 */
  private prefetchStreams(): void {
    const map = this.map;
    if (!map || !this.deps.assetBase()) return;
    const streams = this.streamsNow();
    if (!streams.length) return;
    const now = this.now();
    const wanted: { hash: string; dist: number }[] = [];
    const want = (hash: string, dist: number) => {
      if (this.streamBlocks.has(hash) || this.streamFlying.has(hash)) return;
      const failed = this.streamFailedAt.get(hash);
      if (failed !== undefined && now - failed < STREAM_RETRY_MS) return;
      wanted.push({ hash, dist });
    };
    for (const s of streams) {
      const [lo, hi, cur] = this.streamWindow(s.row);
      for (let n = Math.max(lo, s.row.firstSegment); n <= Math.min(hi, s.row.lastSegment); n++) {
        const hit = this.streamSegment(s, n);
        if (!hit) continue;
        // 只贴稀疏版时:这台浏览器解不了的编码(或者还没问完)不取它的字节
        if (!this.decodable(hit.init)) continue;
        // 往回的那一段排在往前的后面
        const dist = n >= cur ? n - cur : hi - cur + (cur - n);
        want(hit.init.hash, dist);
        want(hit.seg.hash, dist);
      }
    }
    wanted.sort((a, b) => a.dist - b.dist);
    const seen = new Set<string>();
    for (const w of wanted) {
      if (seen.has(w.hash)) continue;
      seen.add(w.hash);
      this.fetchStreamBlock(w.hash);
    }
  }

  /** 取一块流字节(`px/<hash>`,只读票据),核对哈希后放进本页内存;失败记下时刻,过一会儿再取 */
  private fetchStreamBlock(hash: string): void {
    if (this.streamBlocks.has(hash) || this.streamFlying.has(hash)) return;
    const work = new Promise<void>((resolve) => {
      this.queue.push(async () => {
        try {
          const block = await this.fetchAsset("px", hash);
          if (!(await bytesMatchHash(block.bytes, hash))) throw new Error(`流字节与哈希对不上:${hash}`);
          if (this.stopped) return;
          this.stats.streamFetches++;
          this.stats.streamBytes += block.bytes.length;
          this.streamBlocks.set(hash, block.bytes);
          this.streamFailedAt.delete(hash);
          this.streamChanged();
        } catch {
          this.stats.errors++;
          this.stats.streamFailures++;
          this.streamFailedAt.set(hash, this.now());
          if (this.streamFailedAt.size > 4096) this.streamFailedAt.clear();
        } finally {
          resolve();
        }
      });
      this.pump();
    }).finally(() => { this.streamFlying.delete(hash); });
    this.streamFlying.set(hash, work);
  }

  /** `streamPlane` 的本体:把这条流各份清单里字节已在本页的分段合成一份舞台认得的清单 */
  private buildStreamPlane(key: string): { manifest: StreamManifest; blocks: Map<string, Uint8Array> } | null {
    const s = this.streamsNow().find((x) => x.resultKey === key);
    if (!s) return null;
    let header: StreamManifestState["header"] = null;
    let headerAt = -Infinity;
    const inits: StreamManifest["inits"] = {};
    const segments: StreamManifest["segments"] = {};
    const blocks = new Map<string, Uint8Array>();
    for (const state of this.streamManifests.values()) {
      if (state.resultKey !== key || !state.header) continue;
      let used = false;
      for (const [n, seg] of state.segments) {
        if (n < s.row.firstSegment || n > s.row.lastSegment) continue;
        const init = state.inits.get(seg.init);
        if (!init) continue;
        const segBytes = this.streamBlocks.get(seg.hash), initBytes = this.streamBlocks.get(init.hash);
        if (!segBytes || !initBytes || !this.decodable(init)) continue;
        segments[String(n)] = { init: seg.init, file: seg.hash, stride: seg.stride, samples: seg.samples };
        inits[seg.init] = { codec: init.codec, width: init.width, height: init.height, rect: init.rect, hash: init.hash };
        blocks.set(seg.hash, segBytes);
        blocks.set(init.hash, initBytes);
        used = true;
      }
      // 头(矩形上界、收紧矩形)取最近取到的那一份清单的
      if (used && state.fetchedAt >= headerAt) { header = state.header; headerAt = state.fetchedAt; }
    }
    if (!header || !blocks.size) return null;
    return {
      manifest: { streamKey: key, kind: s.row.kind, plane: s.row.plane, clipIds: [...s.row.clipIds], fps: header.fps, segmentFrames: SEGMENT_FRAMES,
        originFrame: s.row.originFrame, bound: header.bound, tight: header.tight, inits, segments },
      blocks,
    };
  }

  private request(msg: Record<string, unknown>): Promise<Record<string, unknown>> {
    const ms = this.deps.requestTimeoutMs ?? 12_000;
    let timer: ReturnType<typeof setTimeout>;
    return Promise.race([
      this.deps.request(msg, ms),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("内容库请求超时")), ms); }),
    ]).finally(() => clearTimeout(timer));
  }

  private async loadMap(): Promise<void> {
    const projectId = this.projectId;
    if (!projectId) return;
    let reply: Record<string, unknown>;
    try {
      reply = await this.request({ type: "content.get", kind: "snapshot-manifest", key: LAYER_MAP_PREFIX + projectId });
    } catch { this.stats.errors++; this.lastMapAt = -Infinity; return; }
    if (this.projectId !== projectId || this.stopped) return;
    this.stats.mapFetches++;
    if (reply?.type !== "content.item" || reply.missing) {
      // 内容库明确回「没有」:渲染节点还没写过层表,这个项目一层产物都没有
      if (reply?.type === "content.item") this.mapKnown = true;
      return;
    }
    const map = parseLayerMap(reply.body);
    if (!map) return;
    this.mapKnown = true;
    const sig = `v${map.v}|` + JSON.stringify(map.layers) + `|${map.span}|` + JSON.stringify(map.streams);
    if (sig === this.mapSig) return;
    const prevLayers = this.layers();
    this.map = map;
    this.mapSig = sig;
    const alive = new Set(this.layers().map((l) => `${l.kind}:${l.clipId}`));
    for (const old of prevLayers) {
      const id = `${old.kind}:${old.clipId}`;
      if (alive.has(id)) continue;
      // 这张卡不在层表里了(改判轻、删了、这一档不认了):发一条空层,把页面表里的旧区间撤掉
      this.emitted.delete(id);
      this.emit({ type: "layer", clipId: old.clipId, kind: old.kind, key: old.key, ranges: [] });
    }
    this.noteStale();
    this.streamRev++;
    this.streamPlaneMemo.clear();
    // 换了键的层(重渲之后):就绪区间按新键重算、全量发;新键的清单还没到时区间是空的,页面按兜底顺序显示占位
    this.publishLayers();
    this.coverageChanged();
  }

  /** 播放头这一窗口(前后各 `PREFETCH_SEC` 秒)的全局帧区间 */
  private windowFrames(): [number, number] {
    const fps = this.map?.fps || this.playhead.fps;
    const g = Math.max(0, Math.floor(this.playhead.t * fps + 1e-6));
    const pad = Math.ceil(PREFETCH_SEC * fps);
    return [Math.max(0, g - pad), g + pad];
  }

  private async loadWindow(now: number): Promise<void> {
    const map = this.map;
    if (!map) return;
    const [lo, hi] = this.windowFrames();
    const wanted: { seg: [number, number]; key: string }[] = [];
    for (const layer of this.layers()) {
      for (const seg of segmentsInWindow(layer, map.span, lo, hi)) {
        const key = this.manifestKey(layer, seg);
        const st = this.manifests.get(key);
        if (st?.full) continue;
        if (st && now - st.fetchedAt < MANIFEST_POLL_MS) continue;
        if (this.manifestFlying.has(key) || wanted.some((w) => w.key === key)) continue;
        wanted.push({ seg, key });
      }
    }
    // 整段覆盖(`coverageLayer` 点名的层):窗口之外的段也取,慢一点、一轮有上限
    let extra = 0;
    for (const layer of this.deps.coverageLayer ? this.layers() : []) {
      if (!this.deps.coverageLayer!(layer.clipId)) continue;
      for (let from = 0; from < layer.count && extra < COVERAGE_FETCHES_PER_TICK; from += map.span) {
        const seg = this.segOf(layer, from);
        const key = this.manifestKey(layer, seg);
        const st = this.manifests.get(key);
        if (st?.full) continue;
        if (st && now - st.fetchedAt < COVERAGE_POLL_MS) continue;
        if (this.manifestFlying.has(key) || wanted.some((w) => w.key === key)) continue;
        wanted.push({ seg, key });
        extra++;
      }
    }
    if (!wanted.length) return;
    let changed = false;
    const pick = (list: unknown, seg: [number, number]) => {
      const out = new Map<number, string>();
      for (const item of Array.isArray(list) ? (list as unknown[]) : []) {
        if (!Array.isArray(item) || !Number.isInteger(item[0]) || !/^[0-9a-f]{64}$/.test(String(item[1]))) continue;
        const f = item[0] as number;
        if (f < seg[0] || f > seg[1]) continue;
        out.set(f, String(item[1]));
      }
      return out;
    };
    await Promise.all(wanted.map(async ({ seg, key }) => {
      this.manifestFlying.add(key);
      try {
        const reply = await this.request({ type: "content.get", kind: "snapshot-manifest", key });
        this.stats.manifestFetches++;
        const prev = this.manifests.get(key);
        if (reply?.type !== "content.item" || reply.missing) {
          this.manifests.set(key, { small: prev?.small ?? new Map(), frames: prev?.frames ?? new Map(), full: false, fetchedAt: this.now() });
          return;
        }
        const body = reply.body as { small?: unknown; frames?: unknown } | undefined;
        const small = pick(body?.small, seg);
        const frames = pick(body?.frames, seg);
        const mine = this.tier === "original" ? frames : small;
        const full = mine.size === seg[1] - seg[0] + 1;
        const before = this.tier === "original" ? prev?.frames : prev?.small;
        if (!before || before.size !== mine.size || [...mine].some(([f, h]) => before.get(f) !== h)) changed = true;
        this.manifests.set(key, { small, frames, full, fetchedAt: this.now() });
      } catch {
        this.stats.errors++;
      } finally {
        this.manifestFlying.delete(key);
      }
    }));
    if (changed && this.map === map && !this.stopped) {
      this.publishLayers();
      this.coverageChanged();
    }
  }

  /** 预取:这一窗口里当前可见的重层、这一档有块的帧,离播放头近的先取;已在 L2 里的不再请求 */
  private prefetchWindow() {
    const map = this.map;
    if (!map || !this.deps.assetBase()) return;
    const [lo, hi] = this.windowFrames();
    const g = Math.max(0, Math.floor(this.playhead.t * (map.fps || this.playhead.fps) + 1e-6));
    const wanted: { hash: string; dist: number; layer: OnlineLayer; local: number }[] = [];
    for (const layer of this.layers()) {
      const first = Math.max(lo, layer.firstFrame), last = Math.min(hi, layer.firstFrame + layer.count - 1);
      for (let gf = first; gf <= last; gf++) {
        const local = gf - layer.firstFrame;
        if (this.tier === "original") {
          const hit = this.frameOf(layer.kind, layer.key, local);
          if (!hit) continue;
          const id = `snap/${hit.hash}`;
          if (this.store?.hasBlock(id)) {
            // 块已在库里(同一内容别的层取过、或上次打开取过):不请求,补记这一层的就绪
            if (!this.inStore.get(layer.resultKey)?.has(local)) void this.store.putRange(layer.resultKey, local, local).catch(() => {});
            continue;
          }
          if (!this.cache.has(id) && !this.inflight.has(id)) wanted.push({ hash: hit.hash, dist: Math.abs(gf - g), layer, local });
        } else {
          const hash = this.smallHashOf(layer.kind, layer.key, local);
          if (hash && !this.cache.has(hash) && !this.inflight.has(hash)) wanted.push({ hash, dist: Math.abs(gf - g), layer, local });
        }
      }
    }
    wanted.sort((a, b) => a.dist - b.dist);
    const seen = new Set<string>();
    for (const w of wanted) {
      if (seen.has(w.hash)) continue;
      seen.add(w.hash);
      if (this.tier === "original") void this.fetchOriginal(w.hash, w.layer, w.local).catch(() => { /* 下一轮再取 */ });
      else void this.fetchSmall(w.hash).catch(() => { /* 下一轮再取 */ });
    }
  }

  /** 从素材服务取一块(凭只读票据);超时、中止都算失败 */
  private async fetchAsset(ns: "px" | "snap", hash: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; type: string }> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const ms = this.deps.assetTimeoutMs ?? 15_000;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        (async () => {
          const base = this.deps.assetBase();
          if (!base) throw new Error("还没有远程素材服务");
          const headers = await this.deps.authHeaders();
          const f = this.deps.fetch ?? fetch;
          const res = await f(`${base.replace(/\/+$/, "")}/${ns}/${hash}`, { headers, signal: controller.signal, cache: "force-cache" });
          if (!res.ok) throw Object.assign(new Error(`取不到 ${ns}/${hash}:${res.status}`), { status: res.status });
          const bytes = new Uint8Array(await res.arrayBuffer());
          const fallback = ns === "px" ? "image/webp" : "text/html";
          const type = (res.headers.get("content-type") || fallback).split(";")[0].trim() || fallback;
          return { bytes, type };
        })(),
        new Promise<never>((_, reject) => { deadline = setTimeout(() => { controller.abort(); reject(new Error("素材请求超时")); }, ms); }),
      ]);
    } finally {
      if (deadline !== null) clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
    }
  }

  private fetchSmall(hash: string, signal?: AbortSignal): Promise<string> {
    const flying = this.inflight.get(hash);
    if (flying) return flying;
    const work = new Promise<string>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          let block = this.store ? await this.store.getBlock(`px/${hash}`) : null;
          if (block) this.stats.l2Hits++;
          else {
            block = await this.fetchAsset("px", hash, signal);
            this.stats.smallFetches++;
            this.stats.smallBytes += block.bytes.length;
            // 只贴稀疏版时的 L2 只存小尺寸(C10 契约第 4 节)
            if (this.store) void this.store.putBlock(`px/${hash}`, block.bytes, block.type).catch(() => {});
          }
          const url = `data:${block.type || "image/webp"};base64,${bytesToBase64(block.bytes)}`;
          this.cache.set(hash, url);
          resolve(url);
          try { this.onFetched?.(); } catch { /* 宿主坏了 */ }
        } catch (e) {
          this.stats.errors++;
          reject(e);
        }
      });
      this.pump();
    }).finally(() => { this.inflight.delete(hash); });
    this.inflight.set(hash, work);
    return work;
  }

  /**
   * 原尺寸(C10 契约第 5 节「流程」):可见范围的重层 → 按层表取清单 → 缺的块凭只读票据从素材服务拉 → 写 L2 →
   * `ranges` 就绪 → 可见舞台下一拍换上。块在 L2 里就不请求。
   */
  private fetchOriginal(hash: string, layer: OnlineLayer, localFrame: number, signal?: AbortSignal): Promise<string> {
    const id = `snap/${hash}`;
    const flying = this.inflight.get(id);
    if (flying) return flying;
    const work = new Promise<string>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          let block = this.store ? await this.store.getBlock(id) : null;
          if (block) this.stats.l2Hits++;
          else {
            block = await this.fetchAsset("snap", hash, signal);
            this.stats.snapFetches++;
            this.stats.snapBytes += block.bytes.length;
            if (this.store) await this.store.putBlock(id, block.bytes, block.type || "text/html").catch(() => {});
          }
          const html = textDecoder ? textDecoder.decode(block.bytes) : String.fromCharCode(...block.bytes);
          this.cache.set(id, html);
          // 写入即就绪:这一层这一帧记进 ranges;L2 通知之后本来源重发就绪(onStoreReady)
          if (this.store && !this.inStore.get(layer.resultKey)?.has(localFrame)) await this.store.putRange(layer.resultKey, localFrame, localFrame).catch(() => {});
          resolve(html);
          try { this.onFetched?.(); } catch { /* 宿主坏了 */ }
        } catch (e) {
          this.stats.errors++;
          reject(e);
        }
      });
      this.pump();
    }).finally(() => { this.inflight.delete(id); });
    this.inflight.set(id, work);
    return work;
  }

  private pump() {
    while (this.active < ONLINE_FETCH_CONCURRENCY && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void job().finally(() => { this.active--; this.pump(); });
    }
  }
}

/** 此刻在用的在线来源(导出前释放它的小尺寸缓存:契约第 11.1 节);没有给 null */
let activeOnline: OnlineSnapshotSource | null = null;
export function setActiveOnlineSource(src: OnlineSnapshotSource | null): void {
  activeOnline = src;
}
export function activeOnlineSource(): OnlineSnapshotSource | null {
  return activeOnline;
}
