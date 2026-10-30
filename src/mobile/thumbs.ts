/**
 * 手机版素材格子、缩略卡的真画面(`docs/plan/mobile-online-task.md` 待用户项第 5 条,用户 2026-10-21 定「要」):
 * 视频取首帧(时间轴上的段取它的入点那一帧),图片取缩略图。
 *
 * - **取素材的路**:只用编辑界面现成的素材预览地址 `usePreviewMediaUrl`(`src/editor/media/previewUrl.ts` →
 *   `render/mediaTier.ts` 的 `previewMediaUrl`)。在线页面上它给的是远程素材服务带只读票据的地址
 *   (`product/asset-service.md`「凭票据读写」),先小后大;远程地址还没就绪、确认缺失时给 "",这时不发请求。
 *   不另造取素材的路,也不碰本机路径。
 * - **按需**:格子进了视口附近才排队取(`IntersectionObserver`),滑走了还没轮到的撤掉。
 * - **限流**:同时最多解码 `MAX_ACTIVE` 个,其余排队;手机上素材多也不会一次全解。
 * - **缓存**:按「去掉票据查询串的地址 + 取帧时刻」记成一张小 JPEG(data URL),最近用过的留 `CACHE_MAX` 张;
 *   票据轮换不重取,面板关了再开不重取。
 * - **取不到**:解码失败、超时、跨源画不进画布,一律当没取到,格子仍是原来的取色底色加类型图标,不出现空白或破图;
 *   失败不记缓存,下次再出现在视口里重试。
 */

/** 缩略图宽度上限(像素):格子 / 缩略卡最宽约 110 CSS 像素,两倍屏够用 */
export const THUMB_W = 224;
/** 同时最多解码几个 */
export const MAX_ACTIVE = 2;
/** 缓存几张 */
export const CACHE_MAX = 160;
/** 一张最多等多久(毫秒);只为防卡死 */
export const GRAB_TIMEOUT_MS = 20000;

export type ThumbKind = "video" | "image";

/** 缓存键:地址去掉查询串与锚点(在线的查询串是会轮换的票据),视频再加取帧时刻(精确到 0.01 秒) */
export function thumbKey(url: string, kind: ThumbKind, t = 0): string {
  const base = String(url || "").split(/[?#]/, 1)[0];
  return kind === "video" ? `${base}@${(Math.max(0, t) || 0).toFixed(2)}` : base;
}

/** 视频取帧时刻:钳在 [0, 时长 - 一帧] 里;0 换成一个极小值,好让浏览器真的发出一次 seeked */
export function seekTarget(t: number, duration: number): number {
  const d = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const x = Math.min(Math.max(0, Number.isFinite(t) ? t : 0), Math.max(0, d - 0.04));
  return x > 0 ? x : 0.001;
}

/** 缩到宽不超过 maxW,保持比例,至少 1 像素 */
export function fitSize(w: number, h: number, maxW = THUMB_W): { w: number; h: number } {
  if (!(w > 0) || !(h > 0)) return { w: 0, h: 0 };
  const s = Math.min(1, maxW / w);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** 地址里按哈希寻址的那一段(`/@media/<哈希>` 或远程素材服务的 `.../media/<哈希>`) */
export function urlHash(url: string): string | null {
  const m = /\/(?:@media|media)\/([0-9a-f]{64})(?:[.?#/]|$)/i.exec(String(url || ""));
  return m ? m[1].toLowerCase() : null;
}

/**
 * 现在去取会不会白跑一趟(素材服务还没收全,会答 404):判据只问素材服务(`mechanism/asset-service.md`「同步状态只问素材服务」),
 * 即编辑器每 2 秒轮询得到的「已收全哈希」集合 `tierHashes`(带标记,问过才非空)。
 * - 问过了:地址里的哈希(或这份素材的原尺寸哈希)在集合里才取;
 * - 还没问过:素材还在入库(`pending`)就等,否则先取(取不到按退避重试);
 * - 不是按哈希寻址的地址(老素材):照取。
 */
export function fetchableNow(url: string, tierHashes: readonly string[], pending: boolean, originalHash?: string | null): boolean {
  const h = urlHash(url);
  if (!h) return true;
  // 原尺寸收全之后轮询就不再问小尺寸(`assetTiers.ts` 的 hashesToAsk),小尺寸先于原尺寸上传,原尺寸在集合里也算
  if (tierHashes.length) return tierHashes.includes(h) || (!!originalHash && tierHashes.includes(originalHash.toLowerCase()));
  return !pending;
}

export type Grab = (url: string, kind: ThumbKind, t: number) => Promise<string>;

interface Job { key: string; url: string; kind: ThumbKind; t: number; wanted: number; promise: Promise<string | null>; resolve: (v: string | null) => void }

/**
 * 取缩略图的队列与缓存。`grab` 真去解码(浏览器里是 `grabFrame`,单测里注入假的)。
 * `request` 返回一个取消函数:还在排队、又没人要了,就撤掉不取。
 */
export function createThumbLoader(opts: { grab: Grab; maxActive?: number; cacheMax?: number }) {
  const maxActive = opts.maxActive ?? MAX_ACTIVE;
  const cacheMax = opts.cacheMax ?? CACHE_MAX;
  const cache = new Map<string, string>();
  const jobs = new Map<string, Job>();
  const queue: Job[] = [];
  let active = 0;
  /** 谁在等某一张:别处取到了也告诉它(同一素材同一时刻在格子和缩略卡上各出现一次,先失败的那处不用等重试) */
  const watchers = new Map<string, Set<(v: string) => void>>();

  const remember = (key: string, v: string) => {
    const fresh = !cache.has(key);
    cache.delete(key);
    cache.set(key, v);
    if (fresh) for (const w of [...(watchers.get(key) ?? [])]) w(v);
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value as string);
  };

  const pump = () => {
    while (active < maxActive && queue.length) {
      const job = queue.shift()!;
      if (job.wanted <= 0) { jobs.delete(job.key); job.resolve(null); continue; }
      active++;
      opts.grab(job.url, job.kind, job.t).then(
        (v) => { if (v) remember(job.key, v); job.resolve(v || null); },
        () => job.resolve(null),
      ).finally(() => { active--; jobs.delete(job.key); pump(); });
    }
  };

  return {
    /** 已缓存的那张(最近使用顺序往后挪) */
    peek(key: string): string | null {
      const v = cache.get(key);
      if (v === undefined) return null;
      remember(key, v);
      return v;
    },
    request(url: string, kind: ThumbKind, t: number, onDone: (v: string | null) => void): () => void {
      const key = thumbKey(url, kind, t);
      const hit = this.peek(key);
      if (hit) { onDone(hit); return () => {}; }
      let job = jobs.get(key);
      if (!job) {
        let resolve!: (v: string | null) => void;
        const promise = new Promise<string | null>((r) => { resolve = r; });
        job = { key, url, kind, t, wanted: 0, promise, resolve };
        jobs.set(key, job);
        queue.push(job);
      }
      const j = job;
      j.wanted++;
      let live = true;
      void j.promise.then((v) => { if (live) onDone(v); });
      pump();
      return () => {
        if (!live) return;
        live = false;
        j.wanted--;
        if (j.wanted <= 0) {
          const i = queue.indexOf(j);
          if (i >= 0) { queue.splice(i, 1); jobs.delete(j.key); j.resolve(null); }
        }
      };
    },
    /** 这一张一旦取到(不论是谁要的)就回调;回退订 */
    watch(key: string, fn: (v: string) => void): () => void {
      let set = watchers.get(key);
      if (!set) { set = new Set(); watchers.set(key, set); }
      set.add(fn);
      return () => { set!.delete(fn); if (!set!.size) watchers.delete(key); };
    },
    /** 单测用:排队数、在解码数、缓存数 */
    stats() { return { queued: queue.length, active, cached: cache.size }; },
  };
}

const withTimeout = <T,>(p: Promise<T>, ms: number, cleanup: () => void): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error("取缩略图超时")); }, ms);
    p.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });

function toDataUrl(src: CanvasImageSource, w: number, h: number): string {
  const size = fitSize(w, h);
  if (!size.w) throw new Error("没有画面尺寸");
  const canvas = document.createElement("canvas");
  canvas.width = size.w;
  canvas.height = size.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("没有 2D 画布");
  ctx.drawImage(src, 0, 0, size.w, size.h);
  // 跨源又没给 CORS 的画面会污染画布,这里抛错 → 当没取到
  return canvas.toDataURL("image/jpeg", 0.72);
}

/** 浏览器里真去解码一帧,缩成小 JPEG。视频用一个不挂到页面上的 <video>,取完立刻卸掉源 */
export const grabFrame: Grab = (url, kind, t) => {
  if (kind === "image") {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    const p = new Promise<string>((resolve, reject) => {
      img.onload = () => { try { resolve(toDataUrl(img, img.naturalWidth, img.naturalHeight)); } catch (e) { reject(e); } };
      img.onerror = () => reject(new Error("图片解不了"));
    });
    img.src = url;
    return withTimeout(p, GRAB_TIMEOUT_MS, () => { img.src = ""; }).finally(() => { img.onload = img.onerror = null; });
  }
  const v = document.createElement("video");
  v.crossOrigin = "anonymous";
  v.muted = true;
  v.playsInline = true;
  v.preload = "auto";
  const release = () => { v.removeAttribute("src"); try { v.load(); } catch { /* 已经卸了 */ } };
  const p = new Promise<string>((resolve, reject) => {
    v.onerror = () => reject(new Error("视频解不了"));
    v.onloadedmetadata = () => {
      v.onseeked = () => { try { resolve(toDataUrl(v, v.videoWidth, v.videoHeight)); } catch (e) { reject(e); } };
      v.currentTime = seekTarget(t, v.duration);
    };
  });
  v.src = url;
  return withTimeout(p, GRAB_TIMEOUT_MS, release).finally(() => { v.onerror = v.onloadedmetadata = v.onseeked = null; release(); });
};
