import { actions, getState, subscribe } from "../../store/project";
import type { MediaAsset } from "../../kernel/project";
import { isViewOnly } from "./viewOnly";
import { confirmedMissing } from "../../audio/missingMaterialRecord";
import { publishMissingMaterials, type MissingMaterialNotice } from "./missingMaterialBus";
import { onGoneConversion } from "../sync/recoveryAssociation";
import { transcodeVideoSmall, sha256Blob } from "../../online/mediaTranscode";
import { enqueueOnlineMedia } from "../../online/mediaUploadQueue";
import { onlinePage } from "../../online/pageFlag";
import { classifyFileDetailed } from "./mediaKinds";

/**
 * 在线构建的编译期常量(写法与用意见 `src/online/pageFlag.ts` 的「在线构建剪枝」)。在线浏览器模式没有本机内容库与转码:
 * 导入媒体置灰(C10 契约第 10 节),素材小尺寸补转也不跑(`Preview` 按 `ONLINE` 不起)。下面几个入口在在线构建里直接回空,
 * 背后的 /api/media/upload、adopt、tiers 调用一起剪掉(M8 遗留 L24)。
 */
const ONLINE_BUILD = typeof import.meta.env !== "undefined" && import.meta.env.VITE_PC_ONLINE === "1";

/**
 * 导入 = 先入库再引用(A1)。
 *
 * **为什么不在页面里算哈希**:素材键是文件内容的 sha256,4 GB 的视频在主线程上读一遍
 * 就是几秒的长任务,连 Worker 里读也要把整份字节搬进页面内存。这里改成把 File 直接
 * 交给 fetch 当 body —— 浏览器从磁盘流式发出去,页面一份字节都不持有;服务端
 * (server/vite-plugin-media.ts 的 storeMediaStream)边落盘边 update sha256,同样是
 * 常数内存、没有长任务。算完回一个 `<hash>`,素材地址就是 /@media/<hash>。
 * 于是主线程和 dev server 的事件循环在整个导入期间都是空的,时间轴照常能编辑。
 *
 * 上传期间素材先挂 `pending: true`、`url: ""`:素材层画「上传中」占位,
 * 不会再出现一个渲染进程 / 导出进程够不着的 blob: 地址。
 */

export interface UploadedMedia {
  hash: string;
  ext: string;
  name: string;
  /** 本地内容库里的绝对路径(迁移期的老代码还在看它) */
  path?: string;
  /** /@media/<hash> */
  url: string;
  bytes: number;
  /** 库里本来就有同样内容 */
  deduped?: boolean;
  /**
   * C6.6 两档(只有视频有):`original` 就是 `hash`(缺 faststart 的已经重封装过,哈希是重封装后的),
   * `small` 是素材小尺寸哈希;素材小尺寸还在本机后台转时是 null、`smallState` 是 pending,由 watchSmallTier 补上。
   */
  tiers?: { original: string; small: string | null };
  /** 素材小尺寸的状态:pending / ready / failed / none(没有视频流) */
  smallState?: string;
}

/** 服务端回包里的两档字段 → UploadedMedia 的那两项 */
function tiersOf(data: { tiers?: { original?: unknown; small?: unknown }; small?: unknown }): Pick<UploadedMedia, "tiers" | "smallState"> {
  const t = data?.tiers;
  if (!t || typeof t.original !== "string") return {};
  return {
    tiers: { original: t.original, small: typeof t.small === "string" ? t.small : null },
    smallState: typeof data.small === "string" ? data.small : undefined,
  };
}

/**
 * 在线浏览器端导入素材：页面直接计算内容哈希并分片上传到素材服务，
 * 视频在浏览器内转出小尺寸 MP4，按「所有小尺寸先传、再传原尺寸」入队。
 */
export async function uploadOnlineMediaFile(
  file: File,
  opts?: { transcode?: typeof transcodeVideoSmall },
): Promise<UploadedMedia | null> {
  try {
    const detected = classifyFileDetailed(file);
    const kind = detected.kind;
    const ext = file.name.split(".").pop()?.toLowerCase() || (kind === "video" ? "mp4" : kind === "audio" ? "mp3" : "png");
    const transcode = opts?.transcode ?? transcodeVideoSmall;

    if (kind === "video") {
      let smallResult = null;
      try {
        smallResult = await transcode(file);
      } catch {
        smallResult = null;
      }
      const originalHash = await sha256Blob(file);

      if (smallResult) {
        const tiers = { original: originalHash, small: smallResult.hash };
        await enqueueOnlineMedia({
          id: originalHash,
          name: file.name,
          tiers: [
            { tier: "small", hash: smallResult.hash, ext: "mp4", blob: smallResult.blob },
            { tier: "original", hash: originalHash, ext, blob: file },
          ],
        });
        return {
          hash: originalHash,
          ext,
          name: file.name,
          url: `/@media/${originalHash}`,
          bytes: file.size,
          tiers,
          smallState: "ready",
        };
      } else {
        const tiers = { original: originalHash, small: null };
        await enqueueOnlineMedia({
          id: originalHash,
          name: file.name,
          tiers: [{ tier: "original", hash: originalHash, ext, blob: file }],
        });
        return {
          hash: originalHash,
          ext,
          name: file.name,
          url: `/@media/${originalHash}`,
          bytes: file.size,
          tiers,
          smallState: "none",
        };
      }
    } else {
      // 图片与音频：没有小尺寸档，直接算 SHA-256 并进上传队列
      const originalHash = await sha256Blob(file);
      const tiers = { original: originalHash, small: null };
      await enqueueOnlineMedia({
        id: originalHash,
        name: file.name,
        tiers: [{ tier: "original", hash: originalHash, ext, blob: file }],
      });
      return {
        hash: originalHash,
        ext,
        name: file.name,
        url: `/@media/${originalHash}`,
        bytes: file.size,
        tiers,
        smallState: "none",
      };
    }
  } catch (err) {
    console.warn(`[io] 在线导入素材异常: ${file.name}`, err);
    return null;
  }
}

/** 把一个 File 流进本地内容库,拿回它的内容哈希。失败给 null(调用方负责提示) */
export async function uploadMediaFile(
  file: File,
  opts?: { transcode?: typeof transcodeVideoSmall; forceOnline?: boolean },
): Promise<UploadedMedia | null> {
  if (ONLINE_BUILD || onlinePage() || opts?.forceOnline) {
    return uploadOnlineMediaFile(file, opts);
  }
  try {
    // tiers=1:视频在服务端做 faststart 判定(缺了就同容器重封装),并在后台生成素材小尺寸(C6.6)
    const res = await fetch(`/api/media/upload/${encodeURIComponent(file.name)}?tiers=1`, { method: "POST", body: file });
    if (!res.ok) {
      console.warn(`[io] 上传素材失败(HTTP ${res.status}): ${file.name}`);
      return null;
    }
    const data = await res.json();
    if (!data?.ok || typeof data.hash !== "string") {
      console.warn(`[io] 上传素材没拿到内容哈希: ${file.name}`);
      return null;
    }
    return {
      hash: data.hash,
      ext: String(data.ext || ""),
      name: String(data.name || file.name),
      path: typeof data.path === "string" ? data.path : undefined,
      url: String(data.url || `/@media/${data.hash}`),
      bytes: Number(data.bytes) || file.size,
      deduped: !!data.deduped,
      ...tiersOf(data),
    };
  } catch (err) {
    console.warn(`[io] 上传素材异常: ${file.name}`, err);
    return null;
  }
}

/**
 * 给一个**已经在服务端素材目录里**的文件补算内容键(素材收集下载好的那种)。
 *
 * 不上传 —— 文件本来就在服务端,几百 MB 再往回传一遍纯属浪费;服务端就地流式
 * 算 sha256 并把它挂进内容库(见 vite-plugin-media.ts 的 adoptMediaFile)。
 * 失败给 null,那条素材就按没有 hash 的迁移期素材走(仍然能按文件名播)。
 */
export async function adoptServerMedia(filePath: string): Promise<UploadedMedia | null> {
  return (await adoptServerMediaVerdict(filePath)).up;
}

/**
 * 编辑器进程对「这个文件取不取得到」的回答,只有两种算明确的「没有」:
 * - `absent`:404,确实没有这个文件(以及落到页面回退的 html);
 * - `outside`:403 且带 `X-PC-Media-Verdict: outside`,路径不在素材目录里,这个接口永远不会给(另一台机器上的路径多半如此)。
 * 其余一律 `unsure`:别的 403、5xx、限速、请求本身出错 —— 没读成不等于不存在,不据此认定缺失。
 */
export type MediaVerdict = "found" | "absent" | "outside" | "unsure";
export function mediaVerdictOf(res: { ok: boolean; status: number; headers: { get(name: string): string | null } }): MediaVerdict {
  if (res.ok) return HTML_TYPE.test(res.headers.get("content-type") || "") ? "absent" : "found";
  if (res.status === 404) return "absent";
  if (res.status === 403 && res.headers.get("x-pc-media-verdict") === "outside") return "outside";
  return "unsure";
}
const HTML_TYPE = new RegExp("text/html", "i");

/** 同 adoptServerMedia,另带判词:没拿到时分得清是「没有」还是「说不清」 */
export async function adoptServerMediaVerdict(filePath: string): Promise<{ up: UploadedMedia | null; verdict: MediaVerdict }> {
  if (ONLINE_BUILD) return { up: null, verdict: "unsure" };
  try {
    const res = await fetch(`/api/media/adopt?path=${encodeURIComponent(filePath)}&tiers=1`, { method: "POST" });
    if (!res.ok) {
      console.warn(`[io] 补算素材哈希失败(HTTP ${res.status}): ${filePath}`);
      const verdict = mediaVerdictOf(res);
      return { up: null, verdict: verdict === "found" ? "unsure" : verdict };
    }
    const data = await res.json();
    if (!data?.ok || typeof data.hash !== "string") return { up: null, verdict: "unsure" };
    return { verdict: "found", up: {
      hash: data.hash,
      ext: String(data.ext || ""),
      name: String(data.name || ""),
      path: typeof data.path === "string" ? data.path : filePath,
      url: String(data.url || `/@media/${data.hash}`),
      bytes: Number(data.bytes) || 0,
      deduped: !!data.deduped,
      ...tiersOf(data),
    } };
  } catch (err) {
    console.warn(`[io] 补算素材哈希异常: ${filePath}`, err);
    return { up: null, verdict: "unsure" };
  }
}

/**
 * 入库结果写回素材表。
 *
 * 走 `actions.updateMedia`(不进撤销栈:撤销管的是时间轴,不该把「素材传完了」这件事也收进去),
 * 拷一份新对象写回。**不许原地改** store 里那条记录:共享项目里 store 的项目就是 docsync 的
 * 本地副本,原地改过的字段 diffProject 看不出变化,hash / tiers / pending 就到不了文档服务,
 * 别的设备上这条素材永远是 pending(C6.6 T9 就是这么发现的)。
 *
 * 传失败时不退回 blob: —— 那种地址渲染进程和导出进程都打不开,留着只会在更远的
 * 地方炸(见 importAssets.ts 的说明)。素材留空地址、pending 落回 false,
 * 素材层就是透明的,用户重新导入即可。
 */
export function applyUploadedMedia(mediaId: string, up: UploadedMedia | null, { imported = true }: { imported?: boolean } = {}): void {
  const media = getState().project.media.find((m) => m.id === mediaId);
  if (!media) return;
  const patch: Partial<Omit<MediaAsset, "id">> = { pending: undefined, path: up?.path ?? media.path ?? "" };
  if (up) {
    patch.url = up.url;
    patch.hash = up.hash;
    patch.ext = up.ext || undefined;
    patch.size = up.bytes || undefined;
    // 两档(C6.6):项目里只记两个哈希,不记同步状态(传没传完只问素材服务的 chunks)
    if (up.tiers) patch.tiers = up.tiers.small ? { original: up.tiers.original, small: up.tiers.small } : { original: up.tiers.original };
  }
  actions.updateMedia(mediaId, patch);
  if (up?.tiers && !up.tiers.small && up.smallState === "pending") watchSmallTier(mediaId, up.tiers.original);
  // 导入完成(所有导入路径都汇到这里):共享项目里按哈希交给上传队列,上传目标还没就绪的先记下(见 BackfillHooks.afterImport)
  if (up && imported && importHook) {
    const fresh = getState().project.media.find((m) => m.id === mediaId);
    if (fresh) { try { void Promise.resolve(importHook(fresh)).catch(() => {}); } catch { /* 挂的事出错不影响导入 */ } }
  }
}

/** `startTierBackfill` 挂上的 `hooks.afterImport`;没挂(在线构建、单测)就不做 */
let importHook: ((media: MediaAsset) => unknown) | null = null;

/** 素材小尺寸在本机后台转码,每隔这么久问一次 */
const SMALL_POLL_MS = 2000;
/** 最多问这么久 */
const SMALL_POLL_LIMIT_MS = 6 * 60 * 60 * 1000;
const watching = new Set<string>();

/**
 * 素材小尺寸好了就把它的哈希写进 `project.media[i].tiers.small`(C6.6)。问的是本机的
 * `GET /api/media/tiers?hashes=<素材原尺寸>`(本机转码的登记,不是同步状态)。素材被删了、素材原尺寸换了、
 * 转码失败或确定没有素材小尺寸就停。只在编辑器会话里跑:页面关了就不再问(素材小尺寸照样在本机生成、照样上传,
 * 只是这条素材的项目记录里没有 small,别的设备按「还没有素材小尺寸时直接拉素材原尺寸」处理)。
 */
export function watchSmallTier(mediaId: string, original: string): void {
  if (ONLINE_BUILD || onlinePage()) return;
  const key = `${mediaId}:${original}`;
  if (watching.has(key)) return;
  watching.add(key);
  const started = Date.now();
  const stop = () => { watching.delete(key); };
  const tick = async () => {
    const media = getState().project.media.find((m) => m.id === mediaId);
    if (!media || (media.tiers?.original ?? media.hash) !== original || media.tiers?.small || Date.now() - started > SMALL_POLL_LIMIT_MS) return stop();
    let state: string | null = null;
    let small: string | null = null;
    try {
      const res = await fetch(`/api/media/tiers?hashes=${original}`);
      const data = res.ok ? await res.json() : null;
      const item = data?.items?.[original];
      state = typeof item?.state === "string" ? item.state : null;
      small = typeof item?.small === "string" ? item.small : null;
    } catch { /* 下一次再问 */ }
    if (state === "ready" && small) {
      writeSmallTier(mediaId, original, small);
      return stop();
    }
    if (state && state !== "pending") return stop();
    setTimeout(() => { void tick(); }, SMALL_POLL_MS);
  };
  setTimeout(() => { void tick(); }, SMALL_POLL_MS);
}

/* ---------------- 打开项目时补转素材小尺寸(C6.6 设计稿第 9 节第 2 条) ---------------- */

/** 这一页已经问过补转的素材原尺寸哈希(同一会话里不重复问;素材小尺寸在转的由 watchSmallTier 接着盯) */
const backfillAsked = new Set<string>();

/**
 * 项目里缺 `tiers.small`、按哈希入库的视频:请编辑器进程补转(`POST /api/media/tiers/backfill`)。
 * 本地内容库里有这份素材原尺寸的才转(没有的回 `absent`,不为了转素材小尺寸去拉素材原尺寸),转好补写 `tiers.small`。
 * 页面在素材小尺寸好之前关了,下次打开再补。没有本机编辑器(在线浏览器模式)时请求失败,什么都不做。
 * 回这次问了几份。
 */
export async function backfillSmallTiers(project = getState().project): Promise<number> {
  if (ONLINE_BUILD || onlinePage() || isViewOnly()) return 0; // 在线页面没有本机转码;只读页面不改项目
  const want: { mediaId: string; hash: string; name: string }[] = [];
  for (const m of project.media ?? []) {
    // 认定过「确认缺失」的不问:内容库里没有它,转不出小尺寸
    if (m.kind !== "video" || m.pending || m.tiers?.small || confirmedMissing(m)) continue;
    const hash = String(m.tiers?.original ?? m.hash ?? "").toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(hash) || backfillAsked.has(hash)) continue;
    backfillAsked.add(hash);
    want.push({ mediaId: m.id, hash, name: m.name ?? "" });
  }
  if (!want.length) return 0;
  let items: Record<string, { state?: string; small?: string }> = {};
  try {
    const res = await fetch("/api/media/tiers/backfill", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: want.map(({ hash, name }) => ({ hash, name })) }),
    });
    if (!res.ok) { for (const w of want) backfillAsked.delete(w.hash); return 0; }
    items = (await res.json())?.items ?? {};
  } catch {
    for (const w of want) backfillAsked.delete(w.hash);
    return 0;
  }
  for (const w of want) {
    const it = items[w.hash];
    if (it?.state === "ready" && typeof it.small === "string") writeSmallTier(w.mediaId, w.hash, it.small);
    else if (it?.state === "pending") watchSmallTier(w.mediaId, w.hash);
  }
  return want.length;
}

/** 把素材小尺寸哈希写进这条素材的 `tiers`(素材原尺寸没换过才写);写法同 applyUploadedMedia 的说明 */
function writeSmallTier(mediaId: string, original: string, small: string): void {
  const fresh = getState().project.media.find((m) => m.id === mediaId);
  if (!fresh || (fresh.tiers?.original ?? fresh.hash) !== original || fresh.tiers?.small) return;
  actions.updateMedia(mediaId, { tiers: { original, small } });
}

/**
 * 打开项目(以及素材表变了)时补转素材小尺寸,回停止函数。预览挂上时调。
 * 同一份素材原尺寸一个页面会话里只问一次;素材表没变就不问。
 * 同一时机在后台补入库没有哈希的老素材(`ingestUnhashedMedia`):本机取不到文件的标「(缺失)」,
 * 做完交给 `hooks.afterIngest`(放云端时补上哈希的进上传队列,见 `sync/backfillUpload.ts`)。
 */
export function startTierBackfill(hooks: BackfillHooks = {}): () => void {
  if (ONLINE_BUILD) return () => {};
  const myImportHook = hooks.afterImport ?? null;
  importHook = myImportHook;
  const background = async () => {
    // 本机取不到文件的标「(缺失)」。只在本机项目里判:共享项目里不标(见 BackfillHooks.shared);还带着协作关联、只是没连上的
    // (断网、要认证、等主机)也不判 —— 那时只在远端有的素材本机没有是常态,判了还会随重连同步给所有成员(见 BackfillHooks.associated)。
    // 检查中途项目变了(换了项目、连上了、进了云端项目)就停手,不把这一轮的结论写进去。
    const local = () => !hooks.shared?.() && !hooks.associated?.();
    const started = loadMark();
    const allowed = () => local() && sameLoad(started);
    const r = await ingestUnhashedMedia({ background: true, markMissing: local(), allowed });
    // 带哈希、本地内容库里却没有的(另一台机器存的 .proc)同样标;共享项目里本机没有是常态,不判
    if (allowed()) await checkHashedMedia({ allowed });
    await hooks.afterIngest?.(r);
  };
  let lastMedia: unknown = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const check = () => {
    const media = getState().project.media;
    if (media === lastMedia) return;
    lastMedia = media;
    // 打开项目的那一阵先让路(测量、首帧),稍后再问
    if (timer) clearTimeout(timer);
    // 没有哈希的老素材先补入库(老项目自己愈合),再补转素材小尺寸;补入库写回素材表会再触发一次 check,新补上的视频也会被问到
    timer = setTimeout(() => { timer = null; void background().catch(() => {}); void backfillSmallTiers(); }, 1500);
  };
  const unsub = subscribe(check);
  check();
  // 过期的云端项目刚转成本地项目:素材表没换(内容原样),但它现在是本机项目了,重新判一遍
  const again = () => { lastMedia = null; ingestBackgroundFailed.clear(); check(); };
  recheckers.add(again);
  return () => { recheckers.delete(again); unsub(); if (timer) clearTimeout(timer); if (importHook === myImportHook) importHook = null; };
}

const recheckers = new Set<() => void>();
onGoneConversion(() => { for (const again of [...recheckers]) again(); });

/** 这一刻载入的是哪个项目(`loadProject` 每次加一);后台检查跨着几次请求,回来时用它看项目换没换 */
const loadMark = () => ({ token: getState().projectLoadToken, id: getState().project.id });
const sameLoad = (mark: ReturnType<typeof loadMark>) => getState().projectLoadToken === mark.token && getState().project.id === mark.id;

/* ---------------- 补入库:没有哈希、但本机还取得到字节的老素材 ---------------- */

/*
 * 老项目里有一批素材只有 `path`、地址是 `/api/media/file?path=…` 或 `/@media/<文件名>`,没有内容哈希
 * (0.7.7 之前生成的配音、迁移期导入的素材)。按哈希挑素材的两处 —— 打包保存 `.procp`(procp.ts 的 mediaEntries)
 * 和开启「放云端」时交给上传队列(assetTiers.ts 的 existingMediaItems)—— 都只认哈希,这些素材就被悄悄漏掉了。
 * 语义 `product/asset-service.md`「入库这一步不能省」:这里把它们补进本地内容库。
 *
 * 怎么补:能指到素材目录里那个文件的(有 `path`,或地址里带 `path=`),走 `adoptServerMedia`
 * (服务端就地算哈希、硬链接进内容库,一份字节都不往回传);服务端不收那条路径(不在素材目录内、换了机器
 * 路径对不上)时,经现有读接口(`/api/media/file?path=…`、`/@media/<文件名>`)取回字节再走 `uploadMediaFile` 入库。
 * 结果用 `applyUploadedMedia` 写回素材表(换新对象,不原地改)。
 *
 * 三处调用:打包前、放云端交给上传队列之前、打开项目后在后台(`startTierBackfill` 同一时机)。
 * 在线构建与只读页面不做(没有本机内容库、不改项目)。
 */

const HASH_RE = /^[0-9a-f]{64}$/i;
const MISSING_PREFIX = "(缺失) ";

/** 这条素材有合法的内容哈希 */
export function hasMediaHash(m: { hash?: string } | null | undefined): boolean {
  return HASH_RE.test(String(m?.hash ?? ""));
}

/** 一条素材在本机可能取得到字节的地方:先试的路径(adopt)、再试的读地址(取字节再入库) */
export function localSourcesOf(m: Pick<MediaAsset, "path" | "url" | "name">): { paths: string[]; urls: string[] } {
  const paths: string[] = [];
  const urls: string[] = [];
  const addPath = (p: string | null | undefined) => { if (p && !paths.includes(p)) paths.push(p); };
  const addUrl = (u: string) => { if (u && !urls.includes(u)) urls.push(u); };
  const url = String(m.url || "");
  if (url.startsWith("/api/media/file?")) {
    try { addPath(new URLSearchParams(url.slice(url.indexOf("?") + 1)).get("path")); } catch { /* 地址坏了就只看 path */ }
  }
  addPath(m.path);
  if (url.startsWith("/api/media/file?")) addUrl(url);
  else if (url.startsWith("/@media/") && !HASH_RE.test(url.slice("/@media/".length).split(/[.?]/)[0])) addUrl(url.split("?")[0]);
  for (const p of paths) addUrl(`/api/media/file?path=${encodeURIComponent(p)}`);
  for (const p of paths) {
    const base = p.split(/[/\\]/).pop();
    if (base) addUrl(`/@media/${encodeURIComponent(base)}`);
  }
  return { paths, urls };
}

/** 地址本身就是 `/@media/<hash>`(内容寻址)时的那个哈希 */
function hashInUrl(url: string | undefined): string | null {
  const u = String(url || "");
  if (!u.startsWith("/@media/")) return null;
  const h = u.slice("/@media/".length).split(/[.?/]/)[0];
  return HASH_RE.test(h) ? h.toLowerCase() : null;
}

function uploadNameOf(m: Pick<MediaAsset, "name" | "path">): string {
  const fromPath = m.path ? m.path.split(/[/\\]/).pop() : "";
  const name = (m.name || "").startsWith(MISSING_PREFIX) ? m.name.slice(MISSING_PREFIX.length) : m.name || "";
  return fromPath || name || "media";
}

/**
 * 补一条:能 adopt 就 adopt,不行再取字节上传。都不行 `up` 为 null。
 * `unreachable`:每条路径、每个读地址都**明确**答了「没有」(判词见 `mediaVerdictOf`:404、落到页面回退、路径不在素材目录里)
 * —— 本机确实取不到这个文件;别的非 2xx(没权限、5xx、限速)、取到了字节但上传失败、请求本身出错(编辑器进程不在)都不算,
 * 那时说不清文件在不在。
 */
async function ingestOne(m: MediaAsset): Promise<{ up: UploadedMedia | null; unreachable: boolean }> {
  const { paths, urls } = localSourcesOf(m);
  let unsure = false;
  for (const p of paths) {
    const { up, verdict } = await adoptServerMediaVerdict(p);
    if (up) return { up, unreachable: false };
    if (verdict === "unsure") unsure = true;
  }
  for (const u of urls) {
    try {
      const res = await fetch(u);
      const verdict = mediaVerdictOf(res);
      // 明确没有(404、页面回退、路径不在素材目录里):看下一个地址;别的失败是没读成,说不清
      if (verdict === "unsure") { unsure = true; continue; }
      if (verdict !== "found") continue;
      // 兜底:落到页面回退(index.html)的不是素材
      if (/text\/html/i.test(res.headers.get("content-type") || "")) continue;
      unsure = true; // 字节取到了:文件在,只是没入上库
      const blob = await res.blob();
      const up = await uploadMediaFile(new File([blob], uploadNameOf(m)));
      if (up) return { up, unreachable: false };
    } catch { unsure = true; /* 下一个地址 */ }
  }
  return { up: null, unreachable: !unsure && urls.length > 0 };
}

export interface IngestResult {
  /** 这次补上哈希的素材 id */
  ingested: string[];
  /**
   * 补不上的素材。`unreachable`:本机经读接口确实取不到这个文件(见 ingestOne);
   * 没有这个标记的是说不清(字节取到了但入库失败、编辑器进程不在、连地址都没有)。
   */
  failed: { id: string; name: string; unreachable?: boolean }[];
}

/**
 * 打开项目后的后台检查可以挂的两件事(由 `Preview` 传进 `startTierBackfill`,见 `sync/backfillUpload.ts`)。
 * 这里不直接引同步层:`syncManager` 在 Node 单测里加载不了,也免得 io 反过来依赖 sync。
 */
export interface BackfillHooks {
  /**
   * 这个文件是不是还带着协作关联(连没连上都算)。带着就不认定缺失:没连上时本机没有远端的素材是常态,
   * 认定了会写进待同步的内容,重连后发给所有成员。
   */
  associated?: () => boolean;
  /** 当前是不是共享项目。共享项目里不给素材标「(缺失)」:取不取得到是这台机器的事,不该同步给别的成员 */
  shared?: () => boolean;
  /** 后台补入库做完之后(放云端时把补上哈希的交给上传队列、补不上的列给用户) */
  afterIngest?: (r: IngestResult) => unknown;
  /**
   * 一条素材导入完成、写回了哈希之后(`applyUploadedMedia`;用户导入、配音、素材收集都经这里)。共享项目里用它把
   * 素材按哈希交给上传队列:打开共享项目后、编辑器进程拿到上传目标之前导入的,编辑器进程那一侧的入队看到的是本机目标、
   * 当空操作丢掉,要由页面记下、就绪后补交(`media/assetTiers.ts` 的 queueImportedMedia)。
   */
  afterImport?: (media: MediaAsset) => unknown;
}

/** 同一来源正在补的(打包与后台同时触发时只补一次) */
const ingestInflight = new Map<string, Promise<{ up: UploadedMedia | null; unreachable: boolean }>>();
/** 后台补过、没补上的来源:同一会话里后台不再反复试(打包、放云端照样再试一次) */
const ingestBackgroundFailed = new Set<string>();

/**
 * 把素材表里没有合法哈希、本机还取得到字节的条目补进本地内容库,并写回哈希。
 * 还在导入(`pending`)的不动:入库由导入那一路负责。回补上了哪些、哪些补不上。
 * `background`:打开项目后在后台做,补不上的记下来,同一会话里后台不再试。
 * `markMissing`:本机确实取不到文件的(`unreachable`),照打开项目时的老规矩标「(缺失)」:清空地址、名字前面加标记
 * (`mediaUrls.ts` 的 restoreMediaUrls;空地址的素材预览和导出都跳过,不再拿一个打不开的地址去等)。`path` 留着,
 * 换回有这个文件的机器、或文件放回原处后,下一次补入库照样补得上(补上时去掉标记)。
 */
export async function ingestUnhashedMedia(opts: { background?: boolean; markMissing?: boolean; allowed?: () => boolean } = {}): Promise<IngestResult> {
  const out: IngestResult = { ingested: [], failed: [] };
  if (ONLINE_BUILD || isViewOnly()) return out;
  // 等请求的那一阵项目可能换了:回来再认定缺失之前先看一眼还许不许(`allowed`),并且始终不跨项目写
  const mark = loadMark();
  const mayMark = () => !!opts.markMissing && sameLoad(mark) && (opts.allowed?.() ?? true);
  const media = getState().project.media ?? [];
  const byId = new Map(media.map((m) => [m.id, m]));
  // 同一来源(同一文件)的几条记录一起补
  const groups = new Map<string, MediaAsset[]>();
  for (const m of media) {
    if (m.pending || hasMediaHash(m)) continue;
    // 「只要声音」的那份和源视频指着同一个文件:源视频有哈希就直接用它的
    const src = m.soundOf ? byId.get(m.soundOf) : undefined;
    const direct = src && hasMediaHash(src) ? String(src.hash).toLowerCase() : hashInUrl(m.url);
    if (direct) {
      const fresh = getState().project.media.find((x) => x.id === m.id);
      if (fresh && !hasMediaHash(fresh)) {
        actions.updateMedia(m.id, { hash: direct, url: `/@media/${direct}`, pending: undefined, ...(src && hasMediaHash(src) && src.ext ? { ext: src.ext } : {}) });
        out.ingested.push(m.id);
      }
      continue;
    }
    const { paths, urls } = localSourcesOf(m);
    const key = paths[0] ?? urls[0] ?? "";
    if (!key) {
      out.failed.push({ id: m.id, name: m.name });
      // 没有哈希、没有路径、也没有读得到的地址(打开时已被清空的失效地址):没有任何线索能找回它,同样认定缺失
      if (mayMark() && !m.url && !m.soundOf) markMediaMissing(m.id);
      continue;
    }
    const g = groups.get(key);
    if (g) g.push(m); else groups.set(key, [m]);
  }
  for (const [key, list] of groups) {
    if (opts.background && ingestBackgroundFailed.has(key)) continue;
    let p = ingestInflight.get(key);
    if (!p) {
      p = ingestOne(list[0]).finally(() => ingestInflight.delete(key));
      ingestInflight.set(key, p);
    }
    const { up, unreachable } = await p;
    if (!sameLoad(mark)) return out; // 项目换了:这一轮到此为止,什么都不写
    if (!up) {
      if (opts.background) ingestBackgroundFailed.add(key);
      for (const m of list) {
        out.failed.push({ id: m.id, name: m.name, ...(unreachable ? { unreachable: true } : {}) });
        if (unreachable && mayMark()) markMediaMissing(m.id);
      }
      continue;
    }
    ingestBackgroundFailed.delete(key);
    for (const m of list) {
      const fresh = getState().project.media.find((x) => x.id === m.id);
      if (!fresh || hasMediaHash(fresh)) continue; // 期间被删了,或别处已经补上
      // 派生的声音不挂视频的两档
      // 补上哈希的交给上传队列走 hooks.afterIngest(queueBackfilledMedia),这里不再按「导入」交一遍
      applyUploadedMedia(m.id, fresh.soundOf ? { ...up, tiers: undefined, smallState: undefined } : up, { imported: false });
      // 以前在别的机器上被标过「(缺失)」、现在取到了:去掉标记,连同「确认缺失」的记录(占位随之消失)
      if (fresh.name.startsWith(MISSING_PREFIX) || fresh.missingMaterial) actions.updateMedia(m.id, { name: nameWithoutMissing(fresh.name), missingMaterial: undefined });
      out.ingested.push(m.id);
    }
  }
  return out;
}

/** 问过、本地内容库里有的素材原尺寸哈希(哈希不可变,有了就一直有;没有的每轮再问,期间可能被导入进来) */
const hashPresent = new Set<string>();

/**
 * 带哈希的素材在本地内容库里有没有这份字节(`GET /api/media/local?hashes=…`,素材服务的现有接口)。只在本机项目里调:
 * 共享项目里本机没有是常态(按需从远程素材服务拉)。
 * - 没有的标「(缺失)」(同 markMediaMissing:清空地址、名字加标记;哈希留着,下次打开照样按哈希找);
 * - 以前标过、现在有了的(导入了同样内容的文件、打开了带这份字节的包)去掉标记、换回 `/@media/<hash>`。
 * 编辑器进程答不上来时什么都不改。回标了哪些、恢复了哪些。
 */
export async function checkHashedMedia(opts: { allowed?: () => boolean } = {}): Promise<{ missing: string[]; restored: string[] }> {
  const out = { missing: [] as string[], restored: [] as string[] };
  if (ONLINE_BUILD || isViewOnly()) return out;
  // 下面要等好几次请求;期间换了项目(或不再许认定)就停手,不把这一轮的结论写进别的项目
  const mark = loadMark();
  const go = () => sameLoad(mark) && (opts.allowed?.() ?? true);
  const hashOf = (m: MediaAsset) => String(m.tiers?.original || m.hash || "").toLowerCase();
  const ask = [...new Set((getState().project.media ?? [])
    .filter((m) => !m.pending && hasMediaHash(m))
    .map(hashOf)
    .filter((h) => HASH_RE.test(h) && !hashPresent.has(h)))];
  const answered = new Set<string>();
  for (let i = 0; i < ask.length; i += 40) {
    const part = ask.slice(i, i + 40);
    try {
      const res = await fetch(`/api/media/local?hashes=${part.join(",")}`, { cache: "no-store" });
      if (!res.ok) continue;
      const body = (await res.json()) as { hashes?: unknown };
      if (!Array.isArray(body?.hashes)) continue;
      for (const h of body.hashes) hashPresent.add(String(h).toLowerCase());
      for (const h of part) answered.add(h);
    } catch { /* 编辑器进程不在:这一批不判 */ }
  }
  if (!go()) return out;
  // 内容库里没有的,再按原来记的本机路径找一次(素材找回的先后:包里落库的、内容库里已有的都先于它,见 `workflow/materials.md`):
  // 文件还在原处、内容也对得上,就地挂回内容库,不算缺失;原处的文件内容变了(哈希对不上)记下来,弹窗里单独说明。
  const changed = new Set<string>();
  /** 按原路径找的时候没读成(没权限、5xx、请求出错)的:说不清文件在不在,这一轮不认定 */
  const unsure = new Set<string>();
  const triedPath = new Set<string>();
  for (const m of getState().project.media ?? []) {
    if (m.pending || !hasMediaHash(m) || !m.path) continue;
    const h = hashOf(m);
    if (hashPresent.has(h) || !answered.has(h) || h !== String(m.hash).toLowerCase() || triedPath.has(`${h}
${m.path}`)) continue;
    triedPath.add(`${h}
${m.path}`);
    const { up, verdict } = await adoptServerMediaVerdict(m.path);
    if (!go()) return out;
    if (up && up.hash.toLowerCase() === h) hashPresent.add(h);
    else if (up) changed.add(h);
    else if (verdict === "unsure") unsure.add(h);
  }
  if (!go()) return out;
  const notices: MissingMaterialNotice[] = [];
  for (const m of getState().project.media ?? []) {
    if (m.pending || !hasMediaHash(m)) continue;
    const h = hashOf(m);
    const url = `/@media/${String(m.hash).toLowerCase()}`;
    if (hashPresent.has(h)) {
      if (m.name.startsWith(MISSING_PREFIX) || !m.url || m.missingMaterial) {
        actions.updateMedia(m.id, { name: nameWithoutMissing(m.name), url: m.url || url, missingMaterial: undefined });
        out.restored.push(m.id);
      }
    } else if (answered.has(h) && !unsure.has(h)) {
      // 已经认定过、记录也还对得上的不重复写(保存重开后就是这种:占位一直在,不再弹窗)
      if (m.name.startsWith(MISSING_PREFIX) && confirmedMissing(m)) continue;
      console.warn(`[io] 缺失素材: ${m.name} (${m.hash})`);
      // 地址留着按哈希的那一个(存盘重开后 restoreMediaUrls 给的也是它,记录才对得上);画面、声音、导出见到记录就不去取它
      const name = m.name.startsWith(MISSING_PREFIX) ? m.name : `${MISSING_PREFIX}${m.name}`;
      actions.updateMedia(m.id, { url, name, missingMaterial: missingRecordOf({ ...m, url, name }) });
      out.missing.push(m.id);
      notices.push({ id: m.id, name: nameWithoutMissing(m.name), kind: m.kind, ...(changed.has(h) ? { changed: true } : {}) });
    }
  }
  publishMissingMaterials(notices);
  return out;
}

const nameWithoutMissing = (name: string) => (name.startsWith(MISSING_PREFIX) ? name.slice(MISSING_PREFIX.length) : name);

/** 没有哈希、没有路径的素材认定缺失后用的地址:只为不留空(时间轴的出声清单不收空地址的素材),谁也不会真去取它 */
const NOWHERE_URL = "/@media/__missing__";

/**
 * 「确认缺失」的记录(形状见 `MediaAsset.missingMaterial`):只在本机项目里、编辑器进程明确答了「没有」之后写。
 * 记下认定那一刻素材的类别、名字、地址、哈希、路径,画面与声音的占位核对这几项与素材现状逐字相同才启用;
 * 视频按画面与声音都缺记(素材不在,没法知道它本来有没有声音),图片只有画面,声音素材只有声音。
 */
function missingRecordOf(m: MediaAsset): NonNullable<MediaAsset["missingMaterial"]> {
  return {
    v: 1, mediaId: m.id, reason: "confirmed-missing",
    original: { kind: m.kind, name: m.name, url: m.url, ...(m.hash ? { hash: m.hash } : {}), ...(m.path ? { path: m.path } : {}) },
    visual: m.kind !== "audio", audio: m.kind !== "image",
  };
}

/** 标「(缺失)」:清空地址、名字加标记(换新对象写回;已经标过的不重复加) */
function markMediaMissing(mediaId: string): void {
  const fresh = getState().project.media.find((x) => x.id === mediaId);
  if (!fresh || hasMediaHash(fresh) || fresh.pending) return;
  const name = fresh.name.startsWith(MISSING_PREFIX) ? fresh.name : `${MISSING_PREFIX}${fresh.name}`;
  if (name === fresh.name && confirmedMissing(fresh)) return;
  console.warn(`[io] 缺失素材: ${fresh.name} (${fresh.path || fresh.url})`);
  // 地址不清空:留着原来的读地址(存盘重开后 restoreMediaUrls 按 path 给的还是它),没有就给一个不存在的占位地址
  const url = fresh.url || NOWHERE_URL;
  actions.updateMedia(mediaId, { url, name, missingMaterial: missingRecordOf({ ...fresh, url, name }) });
  publishMissingMaterials([{ id: fresh.id, name: nameWithoutMissing(fresh.name), kind: fresh.kind }]);
}

/** 单测用 */
export function resetTierBackfillForTest(): void {
  importHook = null;
  backfillAsked.clear();
  ingestBackgroundFailed.clear();
  ingestInflight.clear();
  hashPresent.clear();
}
