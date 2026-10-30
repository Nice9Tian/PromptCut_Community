/**
 * 在线浏览器端的素材上传队列。
 *
 * 语义：`docs/plan/user-decisions-2026-10-14.md` 第 2.5 节、`docs/reports/AGENT-rr-small-first.md` 第 3 节。
 * 与桌面端 `server/upload-queue.mjs` 保持完全一致的调度规则：
 *   - **所有小尺寸先传、再传原尺寸**：队里只要还有哪个素材的素材小尺寸（`small`）没传完，就优先传它（按进队先后）；
 *     所有素材的素材小尺寸都在素材服务上 `complete` 之后，才按进队先后传素材原尺寸（`original`）。
 *   - **原尺寸传码期间新插队**：传素材原尺寸期间新进队的素材（或后补上的小尺寸），它的小尺寸排在剩下的原尺寸前面，
 *     正在传的那一档传完后立即优先派发该小尺寸。
 *   - **严格按序与退避**：轮到的那一档在退避时，后面的都等着（小尺寸在退避，任何原尺寸都不传）。
 *   - **分片与对账**：每一档向远程素材服务 `media` 命名空间对账（`GET media/<hash>/chunks`），
 *     只补缺的片（`PUT media/<hash>/<n>`，每片 8 MiB，带 `X-Media-Size` 与 `X-Media-Ext`），最后 `POST media/<hash>/complete`。
 *     云端账号项目另带 `X-Media-Tier: small | original`（这一档是小尺寸还是原尺寸）：游客的视频条数按「原尺寸几个、
 *     小档几个取多的」数（`server/asset-store/guest-quota.mjs`），服务端认不出这个头就当原尺寸。只在云端带，是因为游客只在云端有，
 *     而本地项目经托管中继（`server/hosting/service.mjs`）走的那条路，预检放行的头里没有它，带上浏览器就把整个 PUT 拦了。
 *   - **所有档位 complete 才出队**：两档都向素材服务确认 `complete: true` 后才出队。
 *   - **被限额拒掉的不再重试**（claude/guest-fix〔裁〕，二级：用户看得见；审查 D）：素材服务回 403 且错误是
 *     `PERMANENT_REFUSALS` 里的一种（游客视频条数满了、文件太大、只读），这一项整项出队、记成被拒，不进退避，
 *     后面的照常传；并告诉订阅的人（`subscribeMediaUploadRejected`，编辑台据此显示「游客最多上传 3 条视频」那句话）。
 *     原先它按暂时性失败无限退避重试，严格按序之下后面所有项（包括图片）都排在它后面传不上去。
 *   - **写入票据**：带写票据 `Authorization: Bearer <rw 票据>`；账号项目带 `credentials: "omit"`。
 */
import {
  remoteAssetBase,
  remoteAccountProjectId,
  remoteAssetTicketInfo,
  hasDocLink,
  docRequest,
} from "../editor/media/assetTiers";
import { onlinePage } from "./pageFlag";

export const CHUNK_SIZE = 8 * 1024 * 1024;
/**
 * 素材服务回 403 时，哪些错误是「再试也不会过」的：这一项出队、记成被拒，不挡后面的。
 * 只收限额与只读这几种；别的 403（票据过期之类）仍按暂时性失败退避重试。
 */
export const PERMANENT_REFUSALS: ReadonlySet<string> = new Set(["guest-video-limit", "guest-file-too-large", "guest-read-only"]);

/** 被拒的那一项 */
export interface MediaUploadRejection { id: string; name: string; mediaId?: string; projectId?: string; code: string }
export const UPLOAD_BACKOFF_MS = Object.freeze([5_000, 30_000, 120_000, 600_000]);
const HASH = /^[0-9a-f]{64}$/;
const TIER_ORDER: Array<"small" | "original"> = ["small", "original"];

export interface MediaUploadTier {
  tier: "small" | "original";
  hash: string;
  ext?: string;
  blob: Blob;
  size?: number;
}

export interface MediaUploadItem {
  id?: string;
  mediaId?: string;
  name?: string;
  projectId?: string;
  tiers: MediaUploadTier[];
}

export interface InternalQueueItem {
  id: string;
  mediaId?: string;
  name: string;
  projectId?: string;
  tiers: MediaUploadTier[];
  attempts: number;
  nextAt: number;
  seq: number;
  sent: Set<"small" | "original">;
  uploaded: MediaUploadTier[];
}

export interface MediaUploadQueueDeps {
  target: () => { base: string; ticket?: string | null; accountProject?: boolean; projectId?: string } | null | Promise<{ base: string; ticket?: string | null; accountProject?: boolean; projectId?: string } | null>;
  fetch?: typeof fetch;
  chunkSize?: number;
  backoff?: number[];
  now?: () => number;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** 有一项被素材服务永久拒掉（`PERMANENT_REFUSALS`）时调 */
  onRejected?: (rejection: MediaUploadRejection) => void;
}

export interface MediaUploadQueue {
  enqueue(item: MediaUploadItem): Promise<{ queued: boolean; reason?: string }>;
  start(): void;
  stop(): Promise<void>;
  drain(): Promise<void>;
  poke(): void;
  holdOriginals(): () => void;
  stats(): {
    enqueued: number;
    merged: number;
    done: number;
    failures: number;
    rejected: number;
    items: string[];
    working: boolean;
  };
}

export function createMediaUploadQueue(deps: MediaUploadQueueDeps): MediaUploadQueue {
  const f = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const delays = Array.isArray(deps.backoff) && deps.backoff.length ? deps.backoff : [...UPLOAD_BACKOFF_MS];
  const now = deps.now ?? Date.now;
  const chunkSize = deps.chunkSize ?? CHUNK_SIZE;
  const say = (event: string, fields: Record<string, unknown> = {}) => {
    try { deps.log?.(event, fields); } catch {}
  };

  const items = new Map<string, InternalQueueItem>();
  let seq = 0;
  let running = false;
  let working = false;
  let timer: any = null;
  let controller: AbortController | null = null;
  const waiters: Array<() => void> = [];
  const counters = { enqueued: 0, merged: 0, done: 0, failures: 0, rejected: 0 };
  let holdOriginalsCount = 0;

  const clearTimer = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const settle = () => {
    if (!items.size) {
      for (const resolve of waiters.splice(0)) resolve();
    }
  };

  const schedule = (delay = 0) => {
    if (!running) return;
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void pump();
    }, Math.max(0, delay));
    timer?.unref?.();
  };

  /**
   * 下一档活的调度逻辑（铁律）：
   * 1. 优先扫描所有素材未发送的 small 档，取其中最早进队的（最小 seq）。
   * 2. 若没有任何未发送的 small 档：
   *    若此时有导入批次正处于 hold 状态（正准备后续素材），暂不派发 original；
   *    否则按进队先后（最小 seq）派发 original 档。
   */
  const nextJob = (): { item: InternalQueueItem; tier: "small" | "original" } | null => {
    let small: InternalQueueItem | null = null;
    let first: InternalQueueItem | null = null;
    for (const item of items.values()) {
      if (!first || item.seq < first.seq) first = item;
      if (item.tiers.some((t) => t.tier === "small") && !item.sent.has("small") && (!small || item.seq < small.seq)) {
        small = item;
      }
    }
    if (small) return { item: small, tier: "small" };
    if (holdOriginalsCount > 0) return null;
    return first ? { item: first, tier: "original" } : null;
  };

  async function uploadTier(
    item: InternalQueueItem,
    tier: "small" | "original",
    where: { base: string; ticket?: string | null; accountProject?: boolean; projectId?: string },
    signal: AbortSignal,
  ): Promise<void> {
    const t = item.tiers.find((x) => x.tier === tier);
    if (!t || item.sent.has(tier)) return;

    say("upload.tier-start", { id: item.id, tier: t.tier, hash: t.hash });

    const base = where.base.replace(/\/+$/, "");
    const ext = (t.ext || "").toLowerCase().replace(/^\./, "");
    const blob = t.blob;
    const size = blob.size;
    const count = Math.max(1, Math.ceil(size / chunkSize));
    const chunkHeaders: Record<string, string> = {
      "Content-Type": "application/octet-stream",
      "X-Media-Size": String(size),
      "X-Media-Ext": ext,
      ...(where.accountProject ? { "X-Media-Tier": t.tier === "small" ? "small" : "original" } : {}),
    };

    /** 没过的回包摆成错误：带状态码和素材服务说的错误代号（`PERMANENT_REFUSALS` 靠它认） */
    const failure = async (res: Response, what: string) => {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return Object.assign(new Error(`${what} 回 ${res.status}${body?.error ? ` ${body.error}` : ""}`), { status: res.status, code: body?.error });
    };

    const authedFetch = async (url: string, init: RequestInit): Promise<Response> => {
      const getHeaders = (ticket: string | null | undefined) => {
        const h: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
        if (ticket) h.Authorization = `Bearer ${ticket}`;
        return h;
      };
      const res = await f(url, {
        ...init,
        headers: getHeaders(where.ticket),
        signal,
        ...(where.accountProject ? { credentials: "omit" as const } : {}),
      });
      if (res.status === 401) {
        // 401 换票据重试一次
        const freshWhere = await deps.target();
        if (freshWhere?.ticket) {
          where.ticket = freshWhere.ticket;
          return f(url, {
            ...init,
            headers: getHeaders(where.ticket),
            signal,
            ...(where.accountProject ? { credentials: "omit" as const } : {}),
          });
        }
      }
      return res;
    };

    // 1. 对账
    const chunksRes = await authedFetch(`${base}/media/${t.hash}/chunks`, { method: "GET", cache: "no-store" });
    if (!chunksRes.ok) throw await failure(chunksRes, "chunks");
    let chunksData = (await chunksRes.json()) as { size?: number | null; received?: number[]; complete?: boolean };

    // 2. 补齐缺片
    if (!chunksData.complete) {
      let received = new Set<number>(Array.isArray(chunksData.received) ? chunksData.received : []);
      for (let n = 0; n < count; n++) {
        if (received.has(n)) continue;
        if (signal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
        const start = n * chunkSize;
        const end = Math.min(size, (n + 1) * chunkSize);
        const chunkSlice = blob.slice(start, end);
        const putRes = await authedFetch(`${base}/media/${t.hash}/${n}`, {
          method: "PUT",
          headers: chunkHeaders,
          body: chunkSlice,
        });
        if (!putRes.ok) throw await failure(putRes, `PUT 第 ${n} 片`);
      }

      // 3. 收尾
      for (let attempt = 0; attempt < 2; attempt++) {
        const completeRes = await authedFetch(`${base}/media/${t.hash}/complete`, { method: "POST" });
        if (completeRes.ok) break;
        const body = (await completeRes.json().catch(() => null)) as { error?: string } | null;
        if (completeRes.status === 400 && body?.error === "incomplete" && attempt === 0) {
          const reChunks = await authedFetch(`${base}/media/${t.hash}/chunks`, { method: "GET", cache: "no-store" });
          if (reChunks.ok) {
            chunksData = (await reChunks.json()) as any;
            if (chunksData.complete) break;
            received = new Set<number>(Array.isArray(chunksData.received) ? chunksData.received : []);
            for (let n = 0; n < count; n++) {
              if (received.has(n)) continue;
              const start = n * chunkSize;
              const end = Math.min(size, (n + 1) * chunkSize);
              await authedFetch(`${base}/media/${t.hash}/${n}`, {
                method: "PUT",
                headers: chunkHeaders,
                body: blob.slice(start, end),
              });
            }
            continue;
          }
        }
        throw Object.assign(new Error(`complete 回 ${completeRes.status}${body?.error ? ` ${body.error}` : ""}`), { status: completeRes.status, code: body?.error });
      }
    }

    // 4. 再次向素材服务确认 complete
    const verifyRes = await authedFetch(`${base}/media/${t.hash}/chunks`, { method: "GET", cache: "no-store" });
    const verifyData = (await verifyRes.json().catch(() => null)) as { complete?: boolean } | null;
    if (!verifyData?.complete) {
      throw Object.assign(new Error(`素材服务上 ${t.tier} ${t.hash} 还没 complete`), { code: "not-complete" });
    }

    item.sent.add(tier);
    if (!item.uploaded.some((x) => x.tier === tier)) item.uploaded.push(t);
    say("upload.tier-done", { id: item.id, tier: t.tier, hash: t.hash, uploaded: true, sent: [0] });
  }

  async function pump(): Promise<void> {
    if (!running || working) return;
    const job = nextJob();
    if (!job) return settle();

    const item = job.item;
    const wait = item.nextAt - now();
    if (wait > 0) return schedule(wait);

    const where = await deps.target();
    if (!where || !where.base) {
      // 尚未连接素材服务：每 2 秒看一次
      return schedule(2000);
    }

    working = true;
    controller = new AbortController();
    const signal = controller.signal;

    try {
      await uploadTier(item, job.tier, where, signal);
      item.attempts = 0;

      if (job.tier === "original") {
        // 所有档位均在素材服务上 complete 才算整项出队
        for (const t of item.uploaded) {
          const checkRes = await f(`${where.base.replace(/\/+$/, "")}/media/${t.hash}/chunks`, {
            headers: where.ticket ? { Authorization: `Bearer ${where.ticket}` } : {},
            signal,
            ...(where.accountProject ? { credentials: "omit" as const } : {}),
          });
          const checkData = (await checkRes.json().catch(() => null)) as { complete?: boolean } | null;
          if (!checkData?.complete) {
            throw Object.assign(new Error(`素材服务上 ${t.tier} ${t.hash} 尚未 complete`), { code: "not-complete" });
          }
        }
        items.delete(item.id);
        counters.done++;
        say("upload.item-done", { id: item.id, name: item.name, tiers: item.tiers.map((t) => t.tier) });
        settle();
      }
    } catch (error: any) {
      if (!running && error?.name === "AbortError") {
        // 队列主动停止，保留在队内
      } else if (error?.status === 403 && PERMANENT_REFUSALS.has(error?.code)) {
        // 再试也不会过：整项出队、记成被拒，不挡后面的（文件头说明）
        counters.failures++;
        counters.rejected++;
        items.delete(item.id);
        const rejection: MediaUploadRejection = { id: item.id, name: item.name, mediaId: item.mediaId, projectId: item.projectId, code: error.code };
        say("upload.rejected", { id: item.id, name: item.name, tier: job.tier, code: error.code });
        try { deps.onRejected?.(rejection); } catch {}
        settle();
      } else {
        counters.failures++;
        item.attempts++;
        const delay = delays[Math.min(item.attempts - 1, delays.length - 1)];
        item.nextAt = now() + delay;
        say("upload.retry", {
          id: item.id,
          attempts: item.attempts,
          delayMs: delay,
          message: String(error?.message ?? error),
        });
      }
    } finally {
      working = false;
      controller = null;
    }

    if (running) schedule(0);
  }

  return {
    async enqueue(raw: MediaUploadItem) {
      const origTier = raw.tiers.find((t) => t.tier === "original");
      if (!origTier || !HASH.test(origTier.hash)) {
        say("upload.bad-item", {});
        return { queued: false, reason: "bad-item" };
      }
      const id = raw.id ?? (raw.projectId ? `${raw.projectId}:${origTier.hash}` : origTier.hash);
      const existing = items.get(id);

      if (existing) {
        for (const t of raw.tiers) {
          if (!existing.tiers.some((x) => x.tier === t.tier)) existing.tiers.push(t);
        }
        existing.tiers.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
        counters.merged++;
      } else {
        const sortedTiers = [...raw.tiers].sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
        items.set(id, {
          id,
          mediaId: raw.mediaId,
          name: raw.name ?? "",
          projectId: raw.projectId,
          tiers: sortedTiers,
          attempts: 0,
          nextAt: 0,
          seq: seq++,
          sent: new Set(),
          uploaded: [],
        });
        counters.enqueued++;
        say("upload.enqueued", { id, name: raw.name ?? "", tiers: sortedTiers.map((t) => t.tier) });
      }

      if (running) schedule(0);
      return { queued: true };
    },

    start() {
      if (running) return;
      running = true;
      schedule(0);
    },

    async stop() {
      running = false;
      clearTimer();
      controller?.abort();
    },

    async drain() {
      if (!items.size && !working) return;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    },

    poke() {
      if (running) schedule(0);
    },

    holdOriginals() {
      holdOriginalsCount++;
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        holdOriginalsCount = Math.max(0, holdOriginalsCount - 1);
        if (running) schedule(0);
      };
      const safetyTimer = setTimeout(release, 60_000);
      (safetyTimer as any)?.unref?.();
      return release;
    },

    stats() {
      return {
        enqueued: counters.enqueued,
        merged: counters.merged,
        done: counters.done,
        failures: counters.failures,
        rejected: counters.rejected,
        items: [...items.keys()],
        working,
      };
    },
  };
}

/* ------------------------------------------------------------------ *
 * 全局单例与编辑器接线
 * ------------------------------------------------------------------ */

let globalQueue: MediaUploadQueue | null = null;
const rejectionListeners = new Set<(rejection: MediaUploadRejection) => void>();

/**
 * 订阅「在线上传队列里有一项被素材服务永久拒掉」（游客视频条数满了之类）。回退订函数。
 * 编辑台的素材库据此把那句话显示出来（`src/editor/left/LibrarySection.tsx`）。
 */
export function subscribeMediaUploadRejected(listener: (rejection: MediaUploadRejection) => void): () => void {
  rejectionListeners.add(listener);
  return () => { rejectionListeners.delete(listener); };
}
const announceRejection = (rejection: MediaUploadRejection) => {
  for (const listener of [...rejectionListeners]) { try { listener(rejection); } catch {} }
};

export async function defaultOnlineUploadTarget(): Promise<{ base: string; ticket: string | null; accountProject: boolean } | null> {
  const remoteBase = remoteAssetBase();
  const accountProject = remoteBase ? remoteAccountProjectId() : null;
  const base = remoteBase ?? (onlinePage() ? null : "/api/asset");
  if (!base) return null;

  if (!remoteBase) {
    return { base, ticket: null, accountProject: false };
  }
  if (accountProject) {
    const info = await remoteAssetTicketInfo();
    return { base, ticket: info?.ticket ?? null, accountProject: true };
  }
  if (hasDocLink()) {
    try {
      const r = await docRequest({ type: "auth.ticket", kind: "asset", access: "rw" });
      if (r.type === "auth.ticket.ok" && typeof r.ticket === "string") {
        return { base, ticket: r.ticket, accountProject: false };
      }
    } catch {}
  }
  return { base, ticket: null, accountProject: false };
}

export function getOnlineMediaUploadQueue(): MediaUploadQueue {
  if (!globalQueue) {
    globalQueue = createMediaUploadQueue({
      target: defaultOnlineUploadTarget,
      onRejected: announceRejection,
    });
    globalQueue.start();
  }
  return globalQueue;
}

export function setOnlineMediaUploadQueueForTest(q: MediaUploadQueue | null): void {
  globalQueue = q;
}

export function resetOnlineMediaUploadQueueForTest(): void {
  globalQueue?.stop();
  globalQueue = null;
}

export function holdOnlineQueueOriginals(): () => void {
  return getOnlineMediaUploadQueue().holdOriginals();
}

export async function enqueueOnlineMedia(item: MediaUploadItem): Promise<{ queued: boolean; reason?: string }> {
  return getOnlineMediaUploadQueue().enqueue(item);
}
