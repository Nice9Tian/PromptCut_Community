/**
 * Wiring of guest asset quota on asset service (user decision, 2026-10-23; default limits and
 * predicate are built into this module, overridable via `registerGuestQuotaPolicy`).
 *
 * The user's specification: "No source file may exceed 100M. Total video assets cannot exceed three."
 * Thus guest writes to `media` are governed on two dimensions:
 * - **Size**: every uploaded file (video, image, audio, small tier) must not exceed
 *   `GUEST_LIMITS.assetBytes`;
 * - **Count**: at most `GUEST_LIMITS.videos` **distinct video sources** per project. Images and audio
 *   do not count.
 * Accounts, local loopback sources, and host services never go through here. `snap` and `px` are
 * prerender outputs, not user-uploaded assets, so they do not go through here either.
 *
 * **Never trust what the page reports** (claude/guest-fix [ruling 2026-10-23], review A1 and A2 of
 * REVIEW-guest-identity: originally counted by extension and tier reported by page; a guest could
 * report videos as `jpg` or mark every chunk as `X-Media-Tier: small`, accepting all 5 mp4 files):
 * - **Whether it is a video is identified by header bytes** (`media-sniff.mjs`). If the extension
 *   reported by the page is a video, it is counted as such; if reported as non-video, inspect header:
 *   if identified as video, or unrecognized (and not text), it counts as a video. Every stored file is
 *   identified this way (conclusions cached by hash, as content does not change).
 * - **Number of video sources is counted as the greater of original-size tier count and small-tier
 *   count**. The online editor uploads two files per video (small-tier preview and original size,
 *   `src/online/mediaUploadQueue.ts`); one video source corresponds to one original and at most one
 *   small tier, so under normal usage this count equals the number of videos. Tiers are still reported
 *   by the page, but cannot be bypassed: if all reported as small tier, small tier has that many items
 *   and is counted anyway; only "3 reported as original, 3 reported as small tier" can fit 3 extra
 *   files: at most 6 files, each under 100 MB, with a hard cap (previously uncapped).
 *
 * **Gates**:
 * - Opening a **new** staging directory (this hash is neither stored nor being received) when the
 *   extension reported by the page is a video: count "already stored (by file header) + currently
 *   receiving (by registered extension and tier) + this item"; if exceeded, reject immediately without
 *   opening staging. This tells well-behaved pages "no" early;
 * - **Finalization** is the real gate: first count once by registered extension and tier (if full, do
 *   not finalize; staging is kept, and finalizing after deleting one will succeed); after admission,
 *   the data layer stores it, then recounts by **this item's own file header** along with stored files;
 *   if exceeded, delete the newly stored item and return 403;
 * - **Whole-file upload** (`POST /api/media/upload/<name>`): caller first reads the first few dozen
 *   bytes from request body and passes them (`head`) for identification;
 * - Guests cannot use `POST /api/media/adopt` (calculates content keys for media collection, not needed
 *   by guests; it can attach unfinalized staging into storage, review S3); rejected in
 *   `gateWholeMediaWrite` of `asset-service.ts`.
 *
 * **How "how many are already stored" is counted**: query the data layer's `inventory()` (`BlobStore`
 * interface, implemented in both fs and memory) and count on the spot without separate bookkeeping.
 * Tiers are stored by data layer alongside hashes ("Tiers" in `blob-store.mjs`); deleting one naturally
 * updates subsequent counts. Three-day cleanup deletes the entire project from asset service
 * (`removeProject` in `project-stores.mjs`, called by `server/hosted/asset-runtime.mjs` upon receiving
 * deletion events); cleared project ids are never reissued to others (`createProject` in
 * `server/account/authority.mjs`), so no one inherits a previous user's quota or bytes. Does not use
 * `service-usage.mjs` bookkeeping: that only tracks host render service outputs and represents another
 * state to reconcile with the data layer.
 *
 * Under cloud hosting, each project has an independent data layer (`project-stores.mjs`); guests can
 * only create one project of their own, enter others' projects as read-only, and cannot write, so "how
 * many videos in this project's `media`" equals "how many this guest uploaded".
 *
 * **Concurrency**: there is a gap between counting and writing; two concurrent paths opening new staging
 * or finalizing simultaneously might both see "one remaining slot" and let both through. Therefore, a
 * guest's "count + first chunk of new staging", "count + finalize", and "count + whole-file upload" are
 * queued per project (`serialize`); account writes do not queue here.
 *
 * Only imports Node built-in modules and small modules in the same directory; does not import
 * `server/account/` or `cloud/`.
 */

import { normalizeTier } from './blob-store.mjs';
import { SNIFF_BYTES, countsAsVideoFile } from './media-sniff.mjs';

export const GUEST_ID_RE = /^gst_[0-9a-f]{24}$/;
export const isGuestId = value => typeof value === 'string' && GUEST_ID_RE.test(value);

export function guestIdOfUserId(userId) {
  if (isGuestId(userId)) return userId;
  if (typeof userId !== 'string') return null;
  const at = userId.lastIndexOf('@');
  const head = at > 0 ? userId.slice(0, at) : userId;
  const id = head.startsWith('account:') ? head.slice('account:'.length) : null;
  return isGuestId(id) ? id : null;
}

export const GUEST_LIMITS = Object.freeze({
  projects: 1,
  conversations: 1,
  videos: 3,
  assetBytes: 100 * 1024 * 1024,
  ttlMs: 3 * 24 * 60 * 60 * 1000,
  tokenTtlMs: 24 * 60 * 60 * 1000,
  renewGraceMs: 3 * 24 * 60 * 60 * 1000,
});

function defaultCheckGuestAsset({ accountId, bytes, countsAsVideo = false, storedVideos = 0 } = {}) {
  if (!isGuestId(accountId)) return { ok: true };
  if (!Number.isSafeInteger(bytes) || bytes < 0) return { ok: false, code: 'invalid-asset' };
  if (bytes > GUEST_LIMITS.assetBytes) return { ok: false, code: 'guest-file-too-large' };
  if (countsAsVideo && (storedVideos ?? 0) >= GUEST_LIMITS.videos) return { ok: false, code: 'guest-video-limit' };
  return { ok: true };
}

let customGuestQuotaPolicy = null;
export function registerGuestQuotaPolicy(fn) {
  customGuestQuotaPolicy = typeof fn === 'function' ? fn : null;
}

export function checkGuestAsset(args) {
  return customGuestQuotaPolicy ? customGuestQuotaPolicy(args) : defaultCheckGuestAsset(args);
}

/** Whether this write is subject to guest quota: only governs guest writes to `media` */
export const guestQuotaApplies = (accountId, ns) => ns === 'media' && isGuestId(accountId);

const DENY = code => ({ ok: false, status: 403, error: code });

/** Maximum entries cached by hash for "whether this file counts as video by header"; clears entirely when full (content-addressed, re-evaluating gives identical results) */
const SNIFF_CACHE_MAX = 20_000;

/** Reads the start of a stored file. Returns null if unreadable (not stored, implementation refuses read) */
async function headOf(store, hash) {
  let stream;
  try { stream = await store.read(hash, { start: 0, end: SNIFF_BYTES - 1 }); } catch { return null; }
  if (!stream) return null;
  const parts = [];
  let got = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      parts.push(buf); got += buf.length;
      if (got >= SNIFF_BYTES) break;
    }
  } catch { return parts.length ? Buffer.concat(parts) : null; }
  finally { try { stream.destroy?.(); } catch { /* No effect */ } }
  return Buffer.concat(parts).subarray(0, SNIFF_BYTES);
}

/**
 * Number of video sources in a group of files: count originals and small tiers, take the greater.
 * @param {Array<{ video: boolean, tier: string }>} entries
 */
export function videoSourcesOf(entries) {
  let originals = 0, smalls = 0;
  for (const e of entries) {
    if (!e.video) continue;
    if (normalizeTier(e.tier) === 'small') smalls++; else originals++;
  }
  return Math.max(originals, smalls);
}

/**
 * One instance per asset service middleware: contains per-project queuing locks and header
 * conclusions cached by hash. `key` identifies "the same data layer": project id in hosted mode,
 * or the data layer object itself locally.
 *
 * @param {{ isVideoExt: (ext: string) => boolean }} options
 *   `isVideoExt`: whether this extension (lowercase, without leading dot) is a video. Must be
 *   provided: omitting it equates to "none of what the page reports counts as video"
 */
export function createGuestAssetQuota({ isVideoExt } = /** @type {any} */ ({})) {
  if (typeof isVideoExt !== 'function') throw new TypeError('createGuestAssetQuota: isVideoExt is required');
  const claimedVideo = ext => !!isVideoExt(String(ext || '').toLowerCase().replace(/^\./, ''));

  /** @type {Map<string, boolean>} Hash → whether it counts as video by header (excluding the "extension reported by page" half) */
  const sniffed = new Map();
  /** Whether this stored file counts as video: counts if reported extension is video, otherwise by header */
  async function storedIsVideo(store, entry) {
    if (claimedVideo(entry.ext)) return true;
    const hash = String(entry.hash).toLowerCase();
    if (sniffed.has(hash)) return sniffed.get(hash);
    const head = await headOf(store, hash);
    // Cannot read start: count it (fail-closed), do not cache, read again next time
    if (head === null) return true;
    const verdict = countsAsVideoFile(head, false);
    if (sniffed.size >= SNIFF_CACHE_MAX) sniffed.clear();
    sniffed.set(hash, verdict);
    return verdict;
  }

  /** @type {Map<unknown, Promise<unknown>>} */
  const tails = new Map();
  function serialize(key, task) {
    const prev = tails.get(key) ?? Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.then(() => {}, () => {});
    tails.set(key, tail);
    void tail.then(() => { if (tails.get(key) === tail) tails.delete(key); });
    return run;
  }
  /** Acquires the guest queue for this data layer, returns unlock function. When acquired, all previously queued tasks have completed */
  function acquire(key) {
    return new Promise(resolveAcquired => {
      void serialize(key, () => new Promise(release => resolveAcquired(release)));
    });
  }

  /**
   * Labels existing files in data layer with whether each counts as video. Stored files are checked
   * by header (except for the `except` hash: that is the item currently being evaluated); when
   * `withStaging` is true, includes currently receiving files: without full bytes yet, they are
   * evaluated by registered extension.
   */
  async function entriesOf(store, { withStaging, except = null }) {
    const inv = await store.inventory();
    const out = [];
    for (const e of inv?.stored ?? []) {
      if (except && e.hash === except) continue;
      out.push({ video: await storedIsVideo(store, e), tier: e.tier });
    }
    if (withStaging) for (const e of inv?.staging ?? []) {
      if (except && e.hash === except) continue;
      out.push({ video: claimedVideo(e.ext), tier: e.tier });
    }
    return out;
  }
  /** Number of video sources after adding this video of tier `tier`; `checkGuestAsset` expects "number of sources before adding", so subtract one before passing */
  const verdictFor = ({ accountId, bytes, entries, tier }) => {
    const after = videoSourcesOf([...entries, { video: true, tier }]);
    return checkGuestAsset({ accountId, bytes, countsAsVideo: true, storedVideos: after - 1 });
  };

  return {
    acquire,

    /**
     * `PUT media/<hash>/<n>`: first check size (`X-Media-Size`, carried by every chunk regardless of
     * type), then check whether to open a new staged upload reported as video. Neither already stored
     * (deduplicated, data layer returns complete) nor this hash already being received (resumed upload,
     * subsequent out-of-order chunks) counts as a new item; those reported as image or audio are not
     * counted here (re-identified by file header during finalize). When counting is needed, count in
     * the queue before writing this chunk, and only release the queue after writing is done.
     *
     * @param {{ accountId?: string, ns: string, size: number, hash: string, ext?: string, tier?: string, store: any, key: unknown }} who
     *   `ext` and `tier` are `X-Media-Ext` and `X-Media-Tier` of this chunk
     * @param {() => Promise<void>} put Actually writes this chunk (response is also inside)
     * @param {(denied: { status: number, error: string }) => void} deny
     */
    async putChunk({ accountId, ns, size, hash, ext, tier, store, key }, put, deny) {
      if (!guestQuotaApplies(accountId, ns)) return put();
      const sized = checkGuestAsset({ accountId, bytes: size });
      if (!sized.ok) return deny(DENY(sized.code));
      if (!claimedVideo(ext)) return put();
      const known = await store.chunks(hash);
      if (known.complete || known.size !== null) return put();
      const release = await acquire(key);
      try {
        const again = await store.chunks(hash);
        if (!again.complete && again.size === null) {
          const verdict = verdictFor({ accountId, bytes: size, entries: await entriesOf(store, { withStaging: true }), tier });
          if (!verdict.ok) return deny(DENY(verdict.code));
        }
        return await put();
      } finally { release(); }
    },

    /**
     * `POST media/<hash>/complete`. Two stages:
     * 1. Before finalize, count by extension and tier registered in the data layer (not what the
     *    finalize request says, as the finalize request does not include these two): if those reported
     *    as video plus already stored ones exceed the limit, do not finalize and keep the staged
     *    upload. If no registration for this item is found in staging (e.g. just deleted elsewhere),
     *    treat it as video;
     * 2. After storing, re-identify once more by **its own file header** (`gate`, called by the caller
     *    after data-layer finalize succeeds and before the response): if it is a video and together
     *    with already stored ones exceeds the limit, return `{ ok: false }`, and the caller deletes
     *    this newly stored item and returns 403.
     * Finalizing an already stored item again is permitted as usual.
     *
     * @param {{ accountId?: string, ns: string, hash: string, store: any, key: unknown }} who
     * @param {(gate: (() => Promise<{ ok: true } | { ok: false, status: number, error: string }>) | null) => Promise<void>} complete
     * @param {(denied: { status: number, error: string }) => void} deny
     */
    async complete({ accountId, ns, hash, store, key }, complete, deny) {
      if (!guestQuotaApplies(accountId, ns)) return complete(null);
      const release = await acquire(key);
      try {
        const known = await store.chunks(hash);
        if (known.complete || known.size === null) return await complete(null);
        const own = String(hash).toLowerCase();
        const inv = await store.inventory();
        const mine = (inv?.staging ?? []).find(e => e.hash === own);
        const tier = mine?.tier;
        if (!mine || claimedVideo(mine.ext)) {
          const verdict = verdictFor({ accountId, bytes: known.size, entries: await entriesOf(store, { withStaging: false, except: own }), tier });
          if (!verdict.ok) return deny(DENY(verdict.code));
        }
        const gate = async () => {
          const head = await headOf(store, own);
          const video = head === null ? true : countsAsVideoFile(head, !mine || claimedVideo(mine.ext));
          if (sniffed.size >= SNIFF_CACHE_MAX) sniffed.clear();
          if (head !== null) sniffed.set(own, countsAsVideoFile(head, false));
          if (!video) return { ok: true };
          const verdict = verdictFor({ accountId, bytes: known.size, entries: await entriesOf(store, { withStaging: false, except: own }), tier });
          return verdict.ok ? { ok: true } : DENY(verdict.code);
        };
        return await complete(gate);
      } finally { release(); }
    },

    /**
     * Whole file upload (`POST /api/media/upload/<name>`, also mounted under hosted): extension is
     * taken from file name, no tier (whole file upload only has originals); if the reported extension
     * is video, it counts; if not, call `peek` to read the first few dozen bytes from the request
     * body and identify by file header (`peek` is called only after size passes; requests reporting
     * oversized dimensions are rejected without reading a single byte). Content hash is only known
     * after reading is complete, so those that count can only be counted as "one more item", rejecting
     * if already full (even if uploading an existing copy); those that do not count only check size.
     * Size is determined by `Content-Length` (Node will not accept more); guest whole file upload
     * requests without it return 411.
     * When permitted, returns a release-lock function, which the caller holds until after the response;
     * when rejected, returns `{ status, error }`.
     *
     * @param {{ accountId?: string, bytes: number | null, ext?: string, peek?: () => Promise<Buffer>, store: any, key: unknown, needsLength: boolean }} who
     * @returns {Promise<{ ok: true, release: () => void } | { ok: false, status: number, error: string }>}
     */
    async whole({ accountId, bytes, ext, peek, store, key, needsLength }) {
      if (!guestQuotaApplies(accountId, 'media')) return { ok: true, release: () => {} };
      if (needsLength && bytes === null) return { ok: false, status: 411, error: 'length-required' };
      if (bytes !== null) {
        const sized = checkGuestAsset({ accountId, bytes });
        if (!sized.ok) return DENY(sized.code);
      }
      let video = claimedVideo(ext);
      if (!video && typeof peek === 'function') {
        const head = await peek();
        video = head.length ? countsAsVideoFile(head, false) : false;
      }
      if (!video) return { ok: true, release: () => {} };
      const release = await acquire(key);
      try {
        const verdict = verdictFor({ accountId, bytes: bytes ?? 0, entries: await entriesOf(store, { withStaging: true }), tier: 'original' });
        if (!verdict.ok) { release(); return DENY(verdict.code); }
        return { ok: true, release };
      } catch (error) { release(); throw error; }
    },
  };
}
