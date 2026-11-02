/**
 * Media upload queue on the online browser side.
 *
 * Semantics: `docs/plan/user-decisions-2026-10-14.md` Section 2.5, `docs/reports/AGENT-rr-small-first.md` Section 3.
 * Maintains scheduling rules fully consistent with desktop `server/upload-queue.mjs`:
 *   - **Upload all small sizes first, then original sizes**: As long as any asset has an incomplete
 *     small-size asset (`small`) in the queue, upload it first (in enqueue order); only after
 *     the small-size assets of all assets are `complete` on the asset service are original-size
 *     assets (`original`) uploaded in enqueue order.
 *   - **New insertions during original-size upload**: For assets newly enqueued while uploading
 *     original-size assets (or small sizes added later), their small sizes are queued ahead of
 *     remaining original sizes; once the currently uploading tier finishes, that small size is
 *     dispatched with priority immediately.
 *   - **Strict ordering and backoff**: When the active tier is backing off, all subsequent ones
 *     wait (if a small size is backing off, no original size is uploaded).
 *   - **Chunking and reconciliation**: Each tier reconciles with the remote asset service `media`
 *     namespace (`GET media/<hash>/chunks`), only uploading missing chunks (`PUT media/<hash>/<n>`,
 *     8 MiB per chunk, with `X-Media-Size` and `X-Media-Ext`), and finally `POST media/<hash>/complete`.
 *     Cloud account projects additionally send `X-Media-Tier: small | original` (whether this tier is
 *     small size or original size): guest video counts are counted as "the greater of the original-size
 *     count and the small-tier count" (`server/asset-store/guest-quota.mjs`); if the server does not
 *     recognize this header, it treats it as original size. It is only included in the cloud because
 *     guests only exist in the cloud; for local projects routed via the hosted relay
 *     (`server/hosting/service.mjs`), this header is not in the preflight-allowed headers, and
 *     including it causes the browser to block the entire PUT.
 *   - **Dequeue only when all tiers are complete**: Only dequeued after both tiers confirm
 *     `complete: true` with the asset service.
 *   - **Do not retry items rejected due to quota** (claude/guest-fix [ruling], level 2: user-visible;
 *     review D): When the asset service returns 403 and the error is one of `PERMANENT_REFUSALS`
 *     (guest video limit reached, file too large, read-only), this entire item is dequeued,
 *     recorded as rejected, does not enter backoff, and subsequent items upload normally; it also
 *     notifies subscribers (`subscribeMediaUploadRejected`, based on which the editor displays
 *     "Guests can upload up to 3 videos"). Previously, it retried indefinitely with backoff as a
 *     transient failure; under strict ordering, all subsequent items (including images) were blocked
 *     behind it and could not be uploaded.
 *   - **Write ticket**: Includes write ticket `Authorization: Bearer <rw ticket>`; account projects
 *     include `credentials: "omit"`.
 */
import {
  remoteAssetBase,
  remoteAccountProjectId,
  remoteAssetTicketInfo,
  hasDocLink,
  docRequest,
} from "../editor/media/assetTiers";
import { onlinePage } from "./pageFlag";
import { tr } from "../i18n/index.ts";

export const CHUNK_SIZE = 8 * 1024 * 1024;
/**
 * When the asset service returns 403, errors that "will not succeed even if retried": this item is
 * dequeued and recorded as rejected without blocking subsequent ones.
 * Only covers quota and read-only errors; other 403s (expired tickets, etc.) are still retried
 * with backoff as transient failures.
 */
export const PERMANENT_REFUSALS: ReadonlySet<string> = new Set(["guest-video-limit", "guest-file-too-large", "guest-read-only"]);

/** The rejected item */
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
  /** Called when an item is permanently rejected by the asset service (`PERMANENT_REFUSALS`) */
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
   * Scheduling logic for the next active tier (strict rule):
   * 1. Scan unsent small tiers across all assets first, picking the earliest enqueued (smallest seq).
   * 2. If there are no unsent small tiers:
   *    If an import batch is currently in hold state (preparing subsequent assets), do not dispatch
   *    original for now;
   *    otherwise dispatch the original tier in enqueue order (smallest seq).
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

    /** Format failed response as error: includes status code and asset service error code (used to recognize `PERMANENT_REFUSALS`) */
    const failure = async (res: Response, what: string) => {
      const body = (await res.json().catch(() => null)) as { error?: string } | null;
      return Object.assign(new Error(tr("{0} returned {1}{2}", what, res.status, body?.error ? ` ${body.error}` : "")), { status: res.status, code: body?.error });
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
        // Retry once on 401 with refreshed ticket
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

    // 1. Reconcile
    const chunksRes = await authedFetch(`${base}/media/${t.hash}/chunks`, { method: "GET", cache: "no-store" });
    if (!chunksRes.ok) throw await failure(chunksRes, "chunks");
    let chunksData = (await chunksRes.json()) as { size?: number | null; received?: number[]; complete?: boolean };

    // 2. Fill in missing chunks
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
        if (!putRes.ok) throw await failure(putRes, tr("PUT part {0}", n));
      }

      // 3. Finalize
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
        throw Object.assign(new Error(tr("complete returned {0}{1}", completeRes.status, body?.error ? ` ${body.error}` : "")), { status: completeRes.status, code: body?.error });
      }
    }

    // 4. Confirm complete with asset service again
    const verifyRes = await authedFetch(`${base}/media/${t.hash}/chunks`, { method: "GET", cache: "no-store" });
    const verifyData = (await verifyRes.json().catch(() => null)) as { complete?: boolean } | null;
    if (!verifyData?.complete) {
      throw Object.assign(new Error(`${t.tier} ${t.hash} on the asset service is not complete yet`), { code: "not-complete" });
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
      // Not yet connected to asset service: check every 2 seconds
      return schedule(2000);
    }

    working = true;
    controller = new AbortController();
    const signal = controller.signal;

    try {
      await uploadTier(item, job.tier, where, signal);
      item.attempts = 0;

      if (job.tier === "original") {
        // Dequeue the entire item only after all tiers are complete on the asset service
        for (const t of item.uploaded) {
          const checkRes = await f(`${where.base.replace(/\/+$/, "")}/media/${t.hash}/chunks`, {
            headers: where.ticket ? { Authorization: `Bearer ${where.ticket}` } : {},
            signal,
            ...(where.accountProject ? { credentials: "omit" as const } : {}),
          });
          const checkData = (await checkRes.json().catch(() => null)) as { complete?: boolean } | null;
          if (!checkData?.complete) {
            throw Object.assign(new Error(tr("{0} {1} is not complete yet on the asset service", t.tier, t.hash)), { code: "not-complete" });
          }
        }
        items.delete(item.id);
        counters.done++;
        say("upload.item-done", { id: item.id, name: item.name, tiers: item.tiers.map((t) => t.tier) });
        settle();
      }
    } catch (error: any) {
      if (!running && error?.name === "AbortError") {
        // Queue explicitly stopped, retain in queue
      } else if (error?.status === 403 && PERMANENT_REFUSALS.has(error?.code)) {
        // Will not succeed even if retried: dequeue entire item, record as rejected, without blocking subsequent items (see file header description)
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
 * Global singleton and editor wiring
 * ------------------------------------------------------------------ */

let globalQueue: MediaUploadQueue | null = null;
const rejectionListeners = new Set<(rejection: MediaUploadRejection) => void>();

/**
 * Subscribe to "an item in the online upload queue was permanently rejected by the asset service"
 * (guest video limit reached, etc.). Returns an unsubscribe function.
 * The media library in the editor uses this to display that message
 * (`src/editor/left/LibrarySection.tsx`).
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
