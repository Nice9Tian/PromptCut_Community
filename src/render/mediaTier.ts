import { reachableMediaIds } from "../kernel/cutIdentity.mjs";
import type { MediaAsset, Project } from "../kernel/project";
import { playableOnThisHost, probePlayable, shouldProbe } from "./playability.ts";

/**
 * 「这一刻该拿哪个地址去播」—— 素材的换档判据(`docs/semantics/product/asset-service.md`「两档素材」「拉取」;
 * `docs/plan/c66-design.md` 第 4 节)。
 *
 * 放在 src/render/ 而不是 src/editor/ 是因为舞台 bundle(预览 / 预渲染 / 导出页)
 * 也要 import 它 —— 舞台够不着编辑器那一侧的任何模块。
 *
 * # 谁用它(T1a 审查 #5)
 *
 * 只有**实时播放**的几条路:舞台里的 `VideoTrack`(视频槽位和图片层)、`FrameScene` live 路的像素映射
 * 素材(`PixelMappedMedia`)、编辑器主文档的声音层(`MediaLayers` 的 `AudioLayer`)。
 * 导出、预渲染、`see_frames`、`FrameScene` 的 placeholder 路**一律用 `media.url`(素材原尺寸)**,不经这里 ——
 * 导出和像素级检查只用素材原尺寸。
 *
 * # 规则
 *
 * `localHashes`(标识符沿用)= **当前连接的素材服务报 `complete` 的哈希集合**,判据只看它
 * (mechanism/asset-service.md「同步状态只问素材服务」);本机缓存落没落盘、项目文档里写了什么都不算数。
 * 集合由主文档每 2 秒轮询 `GET media/<hash>/chunks` 得到(`src/editor/media/assetTiers.ts`),
 * 轮询回过一次之后集合里一定带一个**标记**(`TIERS_KNOWN_LOCAL` / `TIERS_KNOWN_REMOTE`),
 * 所以「问过了、一个都没到齐」和「还没问过」分得开。
 *
 *   0. 集合为空(还没问过)→ 有素材小尺寸给素材小尺寸,没有给素材原尺寸:打开项目的第一帧不直接拉素材原尺寸(A1「先小后大」)。
 *   1. 素材原尺寸在集合里 → 素材原尺寸;但**这台设备放不了素材原尺寸**(本机缓存 `playability.ts`)且素材小尺寸也在集合里时 → 素材小尺寸。
 *   2. 素材原尺寸不在、素材小尺寸在 → 素材小尺寸(先小后大)。
 *   3. 两档都不在 → 素材原尺寸(「还没有素材小尺寸时直接拉素材原尺寸」;哪一档都没传完时也只能给素材原尺寸,那一层等待上传方)。
 *
 * 素材原尺寸和素材小尺寸都在、可播性还不知道时:先给素材小尺寸,顺手在后台探一次;探出来能放,下一次渲染就换回素材原尺寸
 * (「先拉素材小尺寸显示,再拉素材原尺寸替换它」)。只有真有两档可选时才探 —— 不白白去拉素材原尺寸的首帧。
 *
 * 地址里不带扩展名 —— 哈希就是身份,Content-Type 由服务端按入库时记下的扩展名给
 * (server/vite-plugin-media.ts 的 resolveHashFile / contentTypeForExt)。
 *
 * `opts.cloudBase`:给了就把 `/@media/...` 换成绝对地址(在线浏览器模式直接打远程素材服务)。
 * `opts.playable`:可播性从哪读,缺省读本机缓存(单测注入)。
 */

/** 轮询回过、当前连的是本地素材服务 */
export const TIERS_KNOWN_LOCAL = "@known:local";
/** 轮询回过、当前连的是远程素材服务(可播性探测按远端超时) */
export const TIERS_KNOWN_REMOTE = "@known:remote";

type TierMedia = Pick<MediaAsset, "url" | "hash" | "tiers"> & Partial<Pick<MediaAsset, "ext" | "kind" | "width" | "height">>;
type HashList = ReadonlySet<string> | readonly string[];

export interface TierChoice {
  /** 该挂的地址 */
  url: string;
  /** 挂的是哪一档 */
  tier: "small" | "original" | "none";
  /** 轮询回过、而挂的这一档在当前素材服务上还没到齐:这一层在等上传方 */
  awaiting: boolean;
}

function asSet(list: HashList): ReadonlySet<string> {
  return list instanceof Set ? list as ReadonlySet<string> : new Set(list as readonly string[]);
}

/* ------------------------------------------------------------------ *
 * 在线浏览器模式与素材闸门(`docs/plan/c10a-contract.md` 第 8 节;语义 `product/platforms.md`「在线浏览器」的「素材闸门」与「最低一档」)
 * ------------------------------------------------------------------ */

/**
 * 这一侧(主文档或舞台,各自一份)的取档策略。缺省 = 桌面运行环境,和 C6.6 一字不差。
 *
 * - `smallOnly`:最低一档。**视频素材只拉小尺寸**:有小尺寸就恒给小尺寸(轮询回过、它还没到齐时这一层等待上传方,
 *   不去拉);没有小尺寸的视频这一层显示「等待上传方」角标与占位,**不拉原尺寸**(导出除外,导出不经这里)。
 * - `decodeMaxPixels`:素材闸门的解码上限(打开时测一次,这次使用期间不变;`src/online/mediaGate.ts`)。宽 × 高超过它的视频素材
 *   照 `smallOnly` 办(按素材判,不是整台设备一刀切);没超过的照常。null = 不限(桌面、还没测完)。
 * - `smallFirst`:素材闸门的网速(看素材实际下载的快慢,随时调整)。慢:两档都在时先给小尺寸显示,在后台探原尺寸(拉它的首帧),
 *   探出来能放再换原尺寸;快:两档都在时只拉原尺寸(不先挂小尺寸)。只在在线页面给。
 * - `remote`:在线浏览器模式下没有本机编辑器进程代理 `/@media/*`,按哈希寻址的地址换成远程素材服务的
 *   `GET <base>/media/<hash>?t=<只读票据>`(`server/asset-service.ts`「凭票据读写」:查询串只认 `r` 票据)。
 *   `<video>` / `<img>` 带不了 `Authorization` 头,所以票据走查询串。
 *
 * 舞台是另一个文档,它那一份由父页经 RPC `setMediaPolicy` 下发(`stageRpc.ts`)。
 */
export interface MediaTierPolicy {
  smallOnly: boolean;
  decodeMaxPixels: number | null;
  smallFirst: boolean;
  /** 在线页面在远程地址就绪前不得请求本机的 /@media 路由 */
  online: boolean;
  remote: { base: string; ticket: string | null } | null;
}
// Vite 的在线构建按完整属性名替换常量；Node 单测里 import.meta.env 不存在。
let policy: MediaTierPolicy = { smallOnly: false, decodeMaxPixels: null, smallFirst: true, online: typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1", remote: null };

export function setMediaTierPolicy(next: Partial<MediaTierPolicy>): void {
  const remote = next.remote === undefined ? policy.remote
    : next.remote && next.remote.base ? { base: next.remote.base.replace(/\/+$/, ""), ticket: next.remote.ticket || null } : null;
  const prev = policy;
  const decode = next.decodeMaxPixels === undefined ? policy.decodeMaxPixels
    : typeof next.decodeMaxPixels === "number" && Number.isFinite(next.decodeMaxPixels) && next.decodeMaxPixels > 0 ? Math.floor(next.decodeMaxPixels) : null;
  policy = { smallOnly: next.smallOnly ?? policy.smallOnly, decodeMaxPixels: decode, smallFirst: next.smallFirst ?? policy.smallFirst, online: next.online ?? policy.online, remote };
  if (prev.smallOnly === policy.smallOnly && prev.decodeMaxPixels === policy.decodeMaxPixels && prev.smallFirst === policy.smallFirst && prev.online === policy.online
    && prev.remote?.base === policy.remote?.base && prev.remote?.ticket === policy.remote?.ticket) {
    policy = prev; // 没变:不换对象、不通知(订阅方按对象身份判断)
    return;
  }
  for (const l of [...policyListeners]) { try { l(); } catch { /* 一个订阅者坏了不影响别人 */ } }
}

const policyListeners = new Set<() => void>();
/** 取档策略变了(在线页面的远程素材服务就绪、换票据、素材闸门的结果变了)时通知;回退订。编辑界面里的素材预览靠它重画 */
export function subscribeMediaTierPolicy(cb: () => void): () => void {
  policyListeners.add(cb);
  return () => { policyListeners.delete(cb); };
}

export function mediaTierPolicy(): MediaTierPolicy {
  return policy;
}

const IMAGE_EXT = /^(png|jpe?g|gif|webp|avif|bmp|svg|tiff?|heic)$/i;
/** 按 C6.6 设计本来就没有素材小尺寸这一档的素材:图片、音频 */
function noSmallTierByDesign(media: TierMedia): boolean {
  if (media.kind === "audio" || media.kind === "image") return true;
  const ext = String(media.ext || "").replace(/^\./, "");
  return IMAGE_EXT.test(ext);
}

/**
 * 这份素材是不是只用小尺寸:最低一档(`smallOnly`),或宽 × 高超过素材闸门的解码上限(`decodeMaxPixels`;没记下宽高的不按它判)。
 * 图片、音频不在这里管(它们按设计没有小尺寸,见 `chooseTier`)。
 */
export function smallOnlyFor(media: Pick<TierMedia, "width" | "height">, p: Pick<MediaTierPolicy, "smallOnly" | "decodeMaxPixels"> = policy): boolean {
  if (p.smallOnly) return true;
  const limit = p.decodeMaxPixels;
  if (limit === null || !(limit > 0)) return false;
  const w = Number(media.width), h = Number(media.height);
  if (!(w > 0) || !(h > 0)) return false;
  return w * h > limit;
}

/** 按哈希寻址的地址(`/@media/<hash>`)换成远程素材服务的取回地址;别的地址原样 */
export function remoteMediaUrl(url: string, remote: MediaTierPolicy["remote"] = policy.remote): string {
  if (!remote || !url) return url;
  const hash = hashFromUrl(url);
  if (!hash) return url;
  const q = remote.ticket ? `?t=${encodeURIComponent(remote.ticket)}` : "";
  return `${remote.base}/media/${hash}${q}`;
}

const resolvedParamsCache = new WeakMap<object, WeakMap<MediaTierPolicy, Record<string, unknown>>>();

/**
 * 舞台给卡片传参数时，把形如 `/@media/<哈希>[.扩展名]` 的字符串换成远程素材服务地址（如 `/media-s/<sid>/media/<哈希>`）。
 * 桌面运行环境（`!p.online && !p.remote`）原样返回；在线页面在远程地址就绪前（`p.online && !p.remote`）换成空串，不请求不存在的 `/@media/…`。
 */
export function resolveCardParams<T extends Record<string, unknown>>(params: T, p: MediaTierPolicy = policy): T {
  if (!params || typeof params !== "object" || (!p.online && !p.remote)) return params;
  let byPolicy = resolvedParamsCache.get(params);
  const hit = byPolicy?.get(p);
  if (hit) return hit as T;
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(params)) {
    if (typeof v !== "string" || !hashFromUrl(v)) continue;
    const mapped = p.remote ? remoteMediaUrl(v, p.remote) : "";
    if (mapped === v) continue;
    if (!out) out = { ...params };
    out[k] = mapped;
  }
  const result = (out as T) ?? params;
  if (!byPolicy) {
    byPolicy = new WeakMap();
    resolvedParamsCache.set(params, byPolicy);
  }
  byPolicy.set(p, result);
  return result;
}

export function chooseTier(
  media: TierMedia,
  localHashes: HashList = [],
  opts: { cloudBase?: string; playable?: (hash: string) => boolean | undefined; probe?: boolean; smallOnly?: boolean; decodeMaxPixels?: number | null; smallFirst?: boolean; online?: boolean; remote?: MediaTierPolicy["remote"] } = {},
): TierChoice {
  const original = originalUrl(media);
  const complete = asSet(localHashes);
  const originalHash = (media.tiers?.original || media.hash || hashFromUrl(original) || "").toLowerCase();
  const smallHash = (media.tiers?.small || "").toLowerCase();
  const smallTier = !!smallHash && smallHash !== originalHash;
  const small = smallTier ? `/@media/${smallHash}` : null;
  const remote = opts.remote !== undefined ? opts.remote : policy.remote;
  const pick = (tier: "small" | "original", awaiting: boolean): TierChoice => {
    const url = tier === "small" && small ? small : original;
    if ((opts.online ?? policy.online) && !remote && hashFromUrl(url)) return { url: "", tier: "none", awaiting: true };
    return { url: remoteMediaUrl(withBase(url, opts.cloudBase), remote), tier: url ? tier : "none", awaiting: awaiting && !!url && !!originalHash };
  };
  /*
   * 只用小尺寸(最低一档,或超过素材闸门的解码上限;c10a 第 8 节的做法)。按哈希寻址、而没有小尺寸这一档的视频一律不给地址、等待上传方;
   * 有小尺寸:还没问过素材服务就先给它(先小后大的「小」),问过了而它没到齐就等,不回退到原尺寸。
   * 迁移期没有哈希的老素材不经素材服务,原样给(它们本来就只有一份)。
   */
  const smallOnly = smallOnlyFor(media, { smallOnly: opts.smallOnly ?? policy.smallOnly, decodeMaxPixels: opts.decodeMaxPixels !== undefined ? opts.decodeMaxPixels : policy.decodeMaxPixels });
  if (smallOnly) {
    if (!originalHash) return pick("original", false);
    /*
     * 图片、音频按 C6.6 设计不生成素材小尺寸(`c66-design.md`「只对视频做」)。照字面「没有小尺寸就等待上传方」
     * 它们会永远等下去,所以只对视频执行「只拉小尺寸」,图片、音频照常给原尺寸〔偏离,见报告〕。
     */
    if (!smallTier && noSmallTierByDesign(media)) return pick("original", false);
    if (!small) return { url: "", tier: "none", awaiting: true };
    if (!complete.size || complete.has(smallHash)) return pick("small", false);
    return { url: "", tier: "none", awaiting: true };
  }
  // 0. 还没问过素材服务:先小后大
  if (!complete.size) return pick(small ? "small" : "original", false);
  const hasOriginal = !!originalHash && complete.has(originalHash);
  const hasSmall = smallTier && complete.has(smallHash);
  if (hasOriginal) {
    if (!hasSmall) return pick("original", false);
    const playable = (opts.playable ?? playableOnThisHost)(originalHash);
    if (playable === true) return pick("original", false);
    // The playability probe is itself a fetch. Wait for the hosted asset address
    // just as the visible media element does.
    if (playable === undefined && opts.probe !== false && shouldProbe(originalHash)
      && !((opts.online ?? policy.online) && !remote && hashFromUrl(original))) {
      void probePlayable(originalHash, remoteMediaUrl(withBase(original, opts.cloudBase), remote), media.ext, media.kind === "audio" ? "audio" : "video",
        { remote: !!opts.cloudBase || !!remote || complete.has(TIERS_KNOWN_REMOTE) });
    }
    // 素材闸门的网速够快(在线页面的舞台看出来的,`netSpeed.ts`):只拉原尺寸,不先挂小尺寸;可播性照样在后台探,探出来放不了就回小尺寸
    if (playable === undefined && (opts.smallFirst ?? policy.smallFirst) === false) return pick("original", false);
    return pick("small", false);
  }
  if (hasSmall) return pick("small", false);
  return pick("original", true);
}

export function playbackUrl(
  media: TierMedia,
  localHashes: HashList = [],
  opts: { cloudBase?: string; playable?: (hash: string) => boolean | undefined; probe?: boolean; smallOnly?: boolean; decodeMaxPixels?: number | null; smallFirst?: boolean; online?: boolean; remote?: MediaTierPolicy["remote"] } = {},
): string {
  return chooseTier(media, localHashes, opts).url;
}

/**
 * 编辑界面里**给人看的素材预览**(素材库的缩略、时间轴与素材库的波形、转场卡的静帧)该拿哪个地址。
 *
 * - 桌面运行环境(`policy.online` 为假):原样 `media.url`,和以前一字不差。
 * - 在线浏览器模式:没有本机编辑器进程,`/@media/*` 这条路由不存在(c10a 2026-09-27 阿里云演示里手机的两次
 *   `404 /@media/<原尺寸哈希>` 就是素材库缩略的 `<video src>` 与时间轴波形的 `fetch` 拿 `media.url` 发的)。
 *   这里按取档判据换成远程素材服务的地址:只用小尺寸的视频(最低一档、超过解码上限)只给素材小尺寸(没有就给 "",不拉原尺寸);其余是
 *   「先小后大」里的小;远程地址还没就绪时给 ""。调用方拿到 "" 就不挂 src、不发请求。
 *   不探可播性(`probe: false`):预览只是缩略,不值得为它去拉原尺寸的首帧。
 */
export function previewMediaUrl(media: TierMedia, p: MediaTierPolicy = policy): string {
  if (!p.online) return media.url;
  return chooseTier(media, [], { probe: false, smallOnly: p.smallOnly, decodeMaxPixels: p.decodeMaxPixels, online: true, remote: p.remote }).url;
}

/**
 * 要**原尺寸**的地方(量素材尺寸、打包保存、卡片画进画布)该拿哪个地址(C10 第 10 节 / 交接文件第 4 节末条)。
 * - 桌面运行环境:原样 `media.url`,和以前一字不差。
 * - 在线浏览器模式:远程素材服务上的原尺寸(带只读票据);远程地址还没就绪给 ""(调用方不发请求)。
 *   只用小尺寸的素材(最低一档、超过解码上限)平时不拉原尺寸,调用方自己决定要不要用它(`smallOnlyFor`)。
 */
export function originalMediaUrl(media: Pick<MediaAsset, "url" | "hash">, p: MediaTierPolicy = policy): string {
  if (!p.online) return media.url;
  const url = originalUrl(media);
  if (!url) return "";
  if (!p.remote) return hashFromUrl(url) ? "" : url;
  return remoteMediaUrl(url, p.remote);
}

/** 素材原尺寸的地址:`media.url` 就是身份(`/@media/<original 哈希>`);没有 url 但有哈希的才拼一个 */
function originalUrl(media: Pick<MediaAsset, "url" | "hash">): string {
  if (media.url) return media.url;
  return media.hash ? `/@media/${media.hash}` : "";
}

function withBase(url: string, base?: string): string {
  if (!base || !url.startsWith("/@media/")) return url;
  return base.replace(/\/+$/, "") + url;
}

/** 地址里的素材哈希(/@media/<hash> 或 /@media/<hash>.<ext>),不是哈希地址就给 null */
export function hashFromUrl(url: string): string | null {
  const m = /^\/@media\/([0-9a-f]{64})(?:\.[A-Za-z0-9]+)?$/i.exec(String(url || "").split(/[?#]/, 1)[0]);
  return m ? m[1].toLowerCase() : null;
}

/** 素材的原尺寸哈希(按哈希寻址的才有;迁移期按文件名存的给 null) */
export function originalHashOf(media: Pick<MediaAsset, "url" | "hash" | "tiers">): string | null {
  const h = (media.tiers?.original || media.hash || hashFromUrl(media.url) || "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(h) ? h : null;
}

/** 素材的小尺寸哈希(没有素材小尺寸、或素材小尺寸就是素材原尺寸时给 null) */
export function smallHashOf(media: Pick<MediaAsset, "url" | "hash" | "tiers">): string | null {
  const s = (media.tiers?.small || "").toLowerCase();
  return /^[0-9a-f]{64}$/.test(s) && s !== originalHashOf(media) ? s : null;
}

/* ------------------------------------------------------------------ *
 * 预取顺序与导出拦截(C6.6 第 4 节)
 * ------------------------------------------------------------------ */

/** 按片段在时间轴上的先后排素材 id;时间轴上没用到的素材排在最后(按素材表的顺序) */
function mediaInTimelineOrder(project: Pick<Project, "tracks" | "media">): MediaAsset[] {
  const firstUse = new Map<string, number>();
  for (const tr of project.tracks ?? []) {
    for (const c of tr.clips ?? []) {
      if (!c.mediaId) continue;
      const at = Number.isFinite(c.start) ? c.start : 0;
      const had = firstUse.get(c.mediaId);
      if (had === undefined || at < had) firstUse.set(c.mediaId, at);
    }
  }
  const index = new Map((project.media ?? []).map((m, i) => [m.id, i]));
  return [...(project.media ?? [])].sort((a, b) => {
    const ua = firstUse.get(a.id), ub = firstUse.get(b.id);
    if (ua !== undefined && ub !== undefined) return ua - ub || (index.get(a.id)! - index.get(b.id)!);
    if (ua !== undefined) return -1;
    if (ub !== undefined) return 1;
    return index.get(a.id)! - index.get(b.id)!;
  });
}

export interface PrefetchItem {
  hash: string;
  tier: "small" | "original";
  mediaId: string;
}

/**
 * 打开项目后的预取队列(A1「预取队列」):项目引用到的每个哈希,**先全部素材小尺寸、再全部素材原尺寸**,
 * 每一档内按片段在时间轴上的先后。同一个哈希只出现一次。只收按哈希寻址的素材。
 */
export function prefetchOrder(project: Pick<Project, "tracks" | "media">): PrefetchItem[] {
  const ordered = mediaInTimelineOrder(project);
  const seen = new Set<string>();
  const out: PrefetchItem[] = [];
  const add = (hash: string | null, tier: PrefetchItem["tier"], mediaId: string) => {
    if (!hash || seen.has(hash)) return;
    seen.add(hash);
    out.push({ hash, tier, mediaId });
  };
  for (const m of ordered) add(smallHashOf(m), "small", m.id);
  for (const m of ordered) add(originalHashOf(m), "original", m.id);
  return out;
}

export interface MissingOriginal {
  mediaId: string;
  name: string;
  hash: string;
}

/**
 * 导出前的拦截(A1「导出只用素材原尺寸」):时间轴上用到的、按哈希寻址的素材里,素材原尺寸在当前素材服务上
 * 还没 `complete` 的那些。`complete` 是当前素材服务报齐了的哈希集合。
 * 空数组 = 可以导出。迁移期没有哈希的素材不在这里拦(它们不经素材服务)。
 */
export function missingOriginals(project: Pick<Project, "tracks" | "media">, complete: HashList): MissingOriginal[] {
  const have = asSet(complete);
  // 剪辑段引用的剪辑里用到的素材也算(kernel/cutIdentity.mjs):导出要画它们
  const used = reachableMediaIds(project);
  const out: MissingOriginal[] = [];
  const seen = new Set<string>();
  for (const m of mediaInTimelineOrder(project)) {
    if (!used.has(m.id)) continue;
    const h = originalHashOf(m);
    if (!h || have.has(h) || seen.has(h)) continue;
    seen.add(h);
    out.push({ mediaId: m.id, name: m.name || h.slice(0, 12), hash: h });
  }
  return out;
}

export interface ExportGateResult {
  ok: boolean;
  /** 拦下时是 `awaiting-uploader` */
  code?: "awaiting-uploader";
  message?: string;
  missing: MissingOriginal[];
}

/**
 * 导出前的拦截,按「问一个哈希」的形状:`has(hash)` 回这份素材原尺寸在**当前素材服务**上 `complete` 没有
 * (问不到按没有算)。只问被片段引用、带哈希的素材的原尺寸,不问小尺寸。
 * 页面(`src/editor/media/assetTiers.ts`)与预渲染进程的 `/api/export`(`server/export-originals.ts`)共用这一条判据。
 */
export async function checkExportOriginals(
  { project, has }: { project: Pick<Project, "tracks" | "media">; has: (hash: string) => boolean | Promise<boolean> },
): Promise<ExportGateResult> {
  const complete: string[] = [];
  for (const m of missingOriginals(project, [])) {
    try { if (await has(m.hash)) complete.push(m.hash); } catch { /* 问不到按没到齐算 */ }
  }
  const missing = missingOriginals(project, complete);
  if (!missing.length) return { ok: true, missing: [] };
  return { ok: false, code: "awaiting-uploader", message: awaitingUploaderMessage(missing), missing };
}

/** 「等待上传方」的提示文字(导出被拦时给用户看) */
export function awaitingUploaderMessage(missing: readonly MissingOriginal[]): string {
  const names = missing.map((m) => m.name);
  const shown = names.slice(0, 5).join("、") + (names.length > 5 ? ` 等 ${names.length} 个` : "");
  // 用词照 glossary.md「素材原尺寸、素材小尺寸」(取代旧词「原片」「小版」),界面上的字与代码注释都用新词
  return `等待上传方:这些素材的原尺寸还没传完,导出只用素材原尺寸,传完后再导出 —— ${shown}`;
}
