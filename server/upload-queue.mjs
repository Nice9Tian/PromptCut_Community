/**
 * Asset upload queue (C6.6, Section 3 of `docs/plan/c66-design.md`; semantics
 * `docs/semantics/product/asset-service.md` "Upload").
 *
 * A persistent queue in the editor process that transfers locally imported assets (two tiers:
 * small-size asset, original-size asset) to the **currently connected asset service**:
 *   - **Upload all small sizes first** (user decision, 2026-10-13: "Force uploading small size
 *     first, then uploading large size"): as long as any asset in the queue has an unfinished
 *     small-size asset, transfer it first (by enqueue order); only after all small-size assets
 *     in the queue are `complete` on the asset service are original-size assets transferred by
 *     enqueue order. During original-size asset transfers, newly enqueued assets (or late-arriving
 *     small-size assets) are queued ahead of remaining original-size assets, yielding only after
 *     the currently transferring tier finishes.
 *     Assets without a small-size asset (not video, or small-size asset not generated) have only
 *     the original-size asset tier, queued behind all small-size assets.
 *   - **Strictly sequential**: when the current tier is backing off, subsequent items wait
 *     (if a small-size asset is backing off, no original-size asset is transferred).
 *   - Which tier has already transferred is recorded only in memory and not persisted to disk:
 *     after restart, it re-queries starting from small-size assets; already transferred tiers pass
 *     as soon as `putFile` queries `chunks` once.
 *   - **Chunked, resumable transfers**: each tier uses the asset service client's `putFile`
 *     (queries `chunks` first, only uploads chunks missing from `received`, and finally `complete`
 *     is verified by server via sha256). On interruption, retries with backoff (5 s, 30 s, 120 s,
 *     then every 10 min), never giving up.
 *   - **Dequeue only when both tiers are complete**: after transfer, queries `chunks` once for each
 *     tier; considered done only when both tiers report `complete: true`. Sync status only queries
 *     the asset service, not written to the project or `.proc` (semantics "query sync status only
 *     from asset service"); this file only tracks "what remains to transfer".
 *   - **Includes asset ticket**: carried by asset service client from `target()`
 *     (`createAssetClient({ base, ticket })`); this module does not touch tickets.
 *   - **Low priority**: acquires bandwidth gate (`acquireMedia` in `bandwidth-gate.mjs`) before
 *     sending each chunk; pushing prerender outputs takes priority.
 *   - **No-op when connected to local asset service**: `target()` returning null means currently
 *     connected to the local asset service: the import step is already a local write, so it does
 *     not enter the queue. Existing queue items (entered while connected remotely) pause while
 *     `target()` returns null, resuming when switched back to remote.
 *   - **Persisted to disk**: `upload-queue.json`, atomically written back on every enqueue,
 *     dequeue, and failure; re-read on restart to resume transfer.
 *
 * Log events (T3 checks order against them): `upload.enqueued`, `upload.tier-start`,
 * `upload.tier-done`, `upload.item-done`, `upload.retry`, `upload.skip-local`, `upload.missing`.
 *
 * Uses only Node built-in modules; asset service client, bandwidth gate, and file lookup functions
 * are all passed in by the caller.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

export const UPLOAD_QUEUE_FILE = 'upload-queue.json';
export const UPLOAD_BACKOFF_MS = Object.freeze([5_000, 30_000, 120_000, 600_000]);
const FILE_VERSION = 1;
const HASH = /^[0-9a-f]{64}$/;
const EXT = /^[a-z0-9]{1,8}$/;
const TIER_ORDER = ['small', 'original'];

/** Organizes an asset's two tiers into "small first, large second"; returns null if invalid */
export function normalizeUploadItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const tiers = [];
  for (const tier of TIER_ORDER) {
    const t = (raw.tiers ?? []).find?.((x) => x?.tier === tier) ?? null;
    if (!t) continue;
    const hash = String(t.hash ?? '').toLowerCase();
    if (!HASH.test(hash)) return null;
    const ext = t.ext ? String(t.ext).toLowerCase().replace(/^\./, '') : '';
    if (ext && !EXT.test(ext)) return null;
    tiers.push({ tier, hash, ext });
  }
  const original = tiers.find((t) => t.tier === 'original');
  if (!original) return null;
  const projectId = typeof raw.projectId === 'string' && raw.projectId ? raw.projectId : null;
  return { id: projectId ? `${projectId}:${original.hash}` : original.hash, name: typeof raw.name === 'string' ? raw.name.slice(0, 200) : '', tiers, ...(projectId ? { projectId } : {}) };
}

/** Maximum number of assets accepted per enqueue-by-hash */
export const ENQUEUE_MAX_ITEMS = 2000;

/**
 * Hands over assets **already in local content store** to the upload queue by hash (C10a
 * integration rework: when enabling multi-user collaboration "move to the cloud", assets already
 * in the project before enabling must also move to the cloud; called by
 * `POST /api/media/upload-queue/enqueue`).
 *
 * - `items`: `[{ name?, original, small? }]`, one item per asset (two tiers for video: `small` is
 *   `tiers.small`, `original` is `tiers.original`; only one tier for images and audio, providing
 *   only `original`). Also accepts `hashes: string[]` (each treated as original-size asset tier only).
 * - Only accepts locally available assets: original-size asset missing locally → whole asset does
 *   not enter queue, original-size asset hash recorded in `missing`; small-size asset missing
 *   locally → transfers only original-size asset, small-size asset hash recorded in `missing`.
 * - Enqueues following standard queue rules: all small-size assets transferred first, then
 *   original-size assets, dequeued only when both tiers are complete; merges tiers if the same
 *   original-size asset is already in queue.
 * - When a registered small size is still transcoding, hands it off to persistent two-tier manager
 *   to enqueue upon completion, returning deferred without transferring original size early.
 *   When small size has already been generated but page has not written back the hash, fills in
 *   from local two-tier registry, still enqueuing small first, large second.
 * - When currently connected to local asset service (queue is a no-op), returns `local: true`
 *   and enqueues nothing.
 *
 * @param {{ enqueue(raw: object): Promise<{ queued: boolean, reason?: string }> }} queue
 * @param {{ items?: unknown, hashes?: unknown }} body
 * @param {(hash: string) => (string | null | Promise<string | null>)} resolveFile
 * @param {{ getTiers?: (hash: string) => any, isLocal?: () => boolean }} [options]
 * @returns {Promise<{ queued: string[], missing: string[], bad: number, local: boolean, deferred?: string[] }>}
 */
export async function enqueueLocalMedia(queue, body, resolveFile, { getTiers = () => null, isLocal = () => false } = {}) {
  const raw = Array.isArray(body?.items) ? body.items
    : Array.isArray(body?.hashes) ? body.hashes.map((h) => ({ original: h })) : [];
  const out = { queued: [], missing: [], bad: 0, local: false };
  const extOf = (file) => path.extname(String(file)).slice(1).toLowerCase();
  for (const it of raw.slice(0, ENQUEUE_MAX_ITEMS)) {
    const original = String(it?.original ?? '').toLowerCase();
    let small = it?.small ? String(it.small).toLowerCase() : '';
    if (!HASH.test(original) || (small && !HASH.test(small))) { out.bad++; continue; }
    const origFile = await resolveFile(original);
    if (!origFile) { out.missing.push(original); continue; }
    if (isLocal()) { out.local = true; break; }
    const known = getTiers(original);
    if (known?.state === 'pending') {
      (out.deferred ??= []).push(original);
      continue;
    }
    if (!small && known?.state === 'ready' && HASH.test(String(known.small ?? ''))) small = known.small;
    const tiers = [];
    if (small && small !== original) {
      const smallFile = await resolveFile(small);
      if (smallFile) tiers.push({ tier: 'small', hash: small, ext: extOf(smallFile) });
      else out.missing.push(small);
    }
    tiers.push({ tier: 'original', hash: original, ext: extOf(origFile) });
    const r = await queue.enqueue({ name: typeof it?.name === 'string' ? it.name : '', tiers });
    if (r?.queued) out.queued.push(original);
    else if (r?.reason === 'local') { out.local = true; break; }
    else out.bad++;
  }
  return out;
}

async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, text);
  try { await fs.rename(tmp, file); }
  catch (error) { await fs.rm(tmp, { force: true }); throw error; }
}

/**
 * @param {object} options
 * @param {string | null} options.file  Queue file (`<local-data-dir>/upload-queue.json`);
 *   null = in-memory only
 * @param {() => ({ client: any, base?: string } | null)} options.target  Currently connected
 *   asset service; null = local asset service (no-op)
 * @param {(hash: string) => (string | null | Promise<string | null>)} options.resolveFile
 *   Hash → file in local content store
 * @param {any} [options.gate]  Bandwidth gate; does not yield if not granted
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {number[]} [options.backoff]
 * @param {() => number} [options.now]
 */
export function createUploadQueue({
  file, target, resolveFile, gate = null, log = () => {}, backoff = UPLOAD_BACKOFF_MS, now = Date.now, ownership = null,
} = /** @type {any} */ ({})) {
  if (typeof target !== 'function') throw new TypeError('createUploadQueue needs target()');
  if (typeof resolveFile !== 'function') throw new TypeError('createUploadQueue needs resolveFile()');
  const delays = Array.isArray(backoff) && backoff.length ? backoff.map((ms) => Math.max(0, Number(ms) || 0)) : [...UPLOAD_BACKOFF_MS];
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging errors do not affect upload */ } };

  /** id(original-size asset hash) → { id, name, tiers, attempts, nextAt, seq } */
  const items = new Map();
  let seq = 0;
  let running = false;
  let working = false;
  let timer = null;
  let controller = null;
  const waiters = [];
  const counters = { enqueued: 0, merged: 0, done: 0, failures: 0, chunks: 0, restored: 0, skippedLocal: 0, missing: 0 };
  let lastError = null;
  let current = null;

  /* ---------- Persistence ---------- */
  let chain = Promise.resolve();
  let pending = null;
  const snapshot = () => JSON.stringify({
    v: FILE_VERSION,
    items: [...items.values()].sort((a, b) => a.seq - b.seq).map(({ id, name, tiers, attempts, projectId }) => ({ id, name, tiers, attempts, ...(projectId ? { projectId } : {}) })),
  });
  const persist = () => {
    if (!file) return Promise.resolve();
    if (pending) return pending;
    const write = chain.then(async () => {
      if (pending === write) pending = null;
      try { await atomicWrite(file, snapshot()); }
      catch (error) { say('upload.persist-failed', { message: String(error?.message ?? error) }); }
    });
    pending = write;
    chain = write;
    return write;
  };

  (function restore() {
    if (!file) return;
    let saved = null;
    try { saved = JSON.parse(fsSync.readFileSync(file, 'utf8')); } catch { return; }
    if (!saved || saved.v !== FILE_VERSION || !Array.isArray(saved.items)) return;
    for (const record of saved.items) {
      const item = normalizeUploadItem(record);
      if (ownership && item?.projectId !== ownership.projectId) continue;
      if (!item || items.has(item.id)) continue;
      items.set(item.id, { ...item, attempts: Math.max(0, Math.floor(Number(record.attempts) || 0)), nextAt: 0, seq: seq++, sent: new Set(), uploaded: [] });
      counters.restored++;
    }
  })();

  /* ---------- Scheduling ---------- */
  /**
   * Next tier of work: if any small-size asset is not yet transferred, pick the earliest enqueued;
   * if all transferred, pick the earliest enqueued asset to transfer its original-size asset.
   */
  const nextJob = () => {
    let small = null;
    let first = null;
    for (const item of items.values()) {
      if (!first || item.seq < first.seq) first = item;
      if (item.tiers.some((t) => t.tier === 'small') && !item.sent.has('small') && (!small || item.seq < small.seq)) small = item;
    }
    if (small) return { item: small, tier: 'small' };
    return first ? { item: first, tier: 'original' } : null;
  };
  const settle = () => { if (!items.size) for (const resolve of waiters.splice(0)) resolve(); };
  const clearTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };
  const schedule = (delay = 0) => {
    if (!running) return;
    clearTimer();
    timer = setTimeout(() => { timer = null; void pump(); }, Math.max(0, delay));
    timer.unref?.();
  };

  async function pump() {
    if (!running || working) return;
    const job = nextJob();
    if (!job) return settle();
    const item = job.item;
    const wait = item.nextAt - now();
    if (wait > 0) return schedule(wait);
    const where = target();
    if (!where || !where.client) {
      // Currently connected to local asset service: pause, resume when switched back to remote
      // (checks every 5 s)
      return schedule(5_000);
    }
    working = true;
    current = item.id;
    controller = new AbortController();
    const signal = controller.signal;
    try {
      await ownership?.assert();
      if (ownership && (item.projectId !== ownership.projectId || where.projectId !== ownership.projectId)) throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch' });
      await uploadTier(item, job.tier, where.client, signal);
      await ownership?.assert();
      item.attempts = 0;
      if (job.tier === 'original') {
        // Dequeue only when both tiers are complete on the asset service (sync status queries asset
        // service only)
        for (const t of item.uploaded) {
          const st = await where.client.chunks('media', t.hash);
          if (!st.complete) throw Object.assign(new Error(`${t.tier} ${t.hash} on the asset service is not complete yet`), { code: 'not-complete' });
        }
        items.delete(item.id);
        counters.done++;
        say('upload.item-done', { id: item.id, name: item.name, tiers: item.tiers.map((t) => t.tier) });
        await persist();
        settle();
      }
    } catch (error) {
      if (!items.has(item.id)) {
        // This item has been cancelled and removed from the queue; do not retry or count as failure
      } else if (!running && (error?.name === 'AbortError')) {
        // Stopped: keep in queue, resume transfer next time
      } else {
        counters.failures++;
        item.attempts++;
        const delay = delays[Math.min(item.attempts - 1, delays.length - 1)];
        item.nextAt = now() + delay;
        lastError = { id: item.id, code: error?.code ?? error?.status ?? null, message: String(error?.message ?? error), at: now() };
        say('upload.retry', { id: item.id, attempts: item.attempts, delayMs: delay, code: lastError.code, message: lastError.message });
        void persist();
      }
    } finally {
      working = false;
      current = null;
      controller = null;
    }
    if (running) schedule(0);
  }

  /**
   * Transfers one tier of an asset; only records "transferred" after asset service confirms complete.
   * If local file for this tier is missing, records a skip.
   */
  async function uploadTier(item, tier, client, signal) {
    const t = item.tiers.find((x) => x.tier === tier);
    if (!t || item.sent.has(tier)) return;
    await ownership?.assert();
    if (ownership && target()?.projectId !== item.projectId) throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch' });
    const filePath = await resolveFile(t.hash);
    if (!filePath) {
      // Missing this tier in local content store (deleted): cannot transfer, record a skip for this tier;
      // drop the entire asset if original-size asset is also missing
      counters.missing++;
      say('upload.missing', { id: item.id, tier: t.tier, hash: t.hash });
      item.sent.add(tier);
      return;
    }
    say('upload.tier-start', { id: item.id, tier: t.tier, hash: t.hash });
    const r = await client.putFile('media', filePath, {
      hash: t.hash,
      ext: t.ext || undefined,
      signal,
      beforeChunk: async () => {
        await ownership?.assert();
        if (ownership && target()?.projectId !== item.projectId) throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch' });
        if (!running || signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const release = gate ? await gate.acquireMedia({ signal }) : null;
        counters.chunks++;
        return release;
      },
    });
    say('upload.tier-done', { id: item.id, tier: t.tier, hash: t.hash, uploaded: r.uploaded, sent: r.sent });
    if (tier === 'small') {
      // Small-size asset counts as transferred only when complete on asset service: if not complete,
      // retry it and do not proceed to original-size asset
      const st = await client.chunks('media', t.hash);
      if (!st.complete) throw Object.assign(new Error(`${t.tier} ${t.hash} on the asset service is not complete yet`), { code: 'not-complete' });
    }
    item.sent.add(tier);
    if (!item.uploaded.some((x) => x.tier === tier)) item.uploaded.push(t);
  }

  /* ---------- Public API ---------- */
  return {
    /**
     * Enqueues an asset's two tiers. No-op when connected to local asset service (returns
     * `{ queued: false, reason: 'local' }`). If the same original-size asset is already in queue,
     * merges tiers (for example, small-size asset arriving later) without changing its position.
     * Returned promise resolves after queue file is written back.
     * @param {{ name?: string, tiers: { tier: 'small' | 'original', hash: string, ext?: string }[] }} raw
     */
    async enqueue(raw) {
      await ownership?.assert();
      if (ownership && raw?.projectId && raw.projectId !== ownership.projectId) return { queued: false, reason: 'project-mismatch' };
      const item = normalizeUploadItem(ownership ? { ...raw, projectId: ownership.projectId } : raw);
      if (!item) { say('upload.bad-item', {}); return { queued: false, reason: 'bad-item' }; }
      const where = target();
      if (!where || !where.client) {
        counters.skippedLocal++;
        say('upload.skip-local', { id: item.id });
        return { queued: false, reason: 'local' };
      }
      const existing = items.get(item.id);
      if (existing) {
        for (const t of item.tiers) if (!existing.tiers.some((x) => x.tier === t.tier)) existing.tiers.push(t);
        existing.tiers.sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
        counters.merged++;
      } else {
        items.set(item.id, { ...item, attempts: 0, nextAt: 0, seq: seq++, sent: new Set(), uploaded: [] });
        counters.enqueued++;
        say('upload.enqueued', { id: item.id, name: item.name, tiers: item.tiers.map((t) => t.tier) });
      }
      await persist();
      if (running && !working) schedule(0);
      return { queued: true };
    },
    start() {
      if (running) return;
      running = true;
      schedule(0);
    },
    /**
     * Stops: dispatches no new work; stops once the currently transferring chunk is sent (this asset
     * remains in queue); waits until queue file finishes writing.
     */
    async stop() {
      running = false;
      clearTimer();
      controller?.abort();
      await persist();
      for (const resolve of waiters.splice(0)) resolve();
    },
    /**
     * Cancels assets in flight or queued.
     * If currently uploading the asset, aborts in-flight chunks and removes from queue; if queued,
     * removes directly from queue.
     * @param {string[] | string} [targets] Hash list to cancel; if unspecified, cancels all
     * @returns {Promise<{ ok: boolean, cancelled: string[] }>}
     */
    async cancel(targets) {
      const filter = targets === undefined || targets === null ? null
        : (Array.isArray(targets) ? targets : [targets]).map((h) => String(h).toLowerCase()).filter(Boolean);
      const matches = (item) => {
        if (!filter || !filter.length) return true;
        const idLower = item.id.toLowerCase();
        if (filter.includes(idLower)) return true;
        if (filter.some((t) => idLower.endsWith(':' + t))) return true;
        if (item.tiers.some((t) => filter.includes(t.hash.toLowerCase()))) return true;
        return false;
      };
      const toRemove = [];
      for (const item of items.values()) {
        if (matches(item)) toRemove.push(item);
      }
      if (!toRemove.length) return { ok: true, cancelled: [] };
      const cancelledIds = [];
      let abortCurrent = false;
      for (const item of toRemove) {
        items.delete(item.id);
        cancelledIds.push(item.id);
        if (current === item.id) abortCurrent = true;
      }
      say('upload.cancelled', { ids: cancelledIds });
      if (abortCurrent && controller) {
        controller.abort();
      }
      await persist();
      settle();
      return { ok: true, cancelled: cancelledIds };
    },
    /** Reschedules immediately (used in tests after advancing the clock; also skips head-of-line backoff) */
    poke({ skipBackoff = false } = {}) {
      if (skipBackoff) for (const item of items.values()) item.nextAt = 0;
      if (running && !working) schedule(0);
    },
    /** Waits for queue to empty; returns immediately if already stopped */
    drain() {
      if (!items.size || !running) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
    stats() {
      return {
        running, working, current, ...counters, lastError,
        items: [...items.values()].sort((a, b) => a.seq - b.seq).map((i) => ({ id: i.id, name: i.name, tiers: i.tiers.map((t) => t.tier), attempts: i.attempts })),
      };
    },
    get file() { return file; },
  };
}
