/**
 * PNG snapshots (`bake_card`, 3D views, and textures from idle prerender) are accessed via the asset
 * service. The "PNG snapshot" referred to here is a **PNG bitmap** (the visual frame of a single card
 * at a given moment, rendered on the spot, see `vision/card-bitmap.ts`), not HTML: this module only
 * sends and receives PNGs, and never stores HTML for this card anywhere
 * (`docs/semantics/glossary.md` "PNG snapshot", `mechanism/asset-service.md` "Single-card frames
 * bypassing task queue"). Comments and error messages are standardized as "PNG snapshot"
 * (user decision, 2026-10-14).
 *
 * Semantics: `docs/semantics/product/asset-service.md` "Prerender artifacts" (all prerender artifacts
 * produced by rendering are pushed unconditionally to the asset service once generated, even when
 * the asset service is on this machine), item 3 of "Responsibilities" and `product/agent.md`
 * "Assets and artifacts" (Agent processes and prerender processes read and write artifacts via the
 * asset service interface, never reading its storage directory directly even on the same machine),
 * `mechanism/asset-service.md` "Sync status queries asset service only".
 *
 * Previously, `server/vision/bake.ts` wrote PNGs atomically into the asset directory
 * `out/media/bake-<clipId>-<input-hash>.png`, and `bake-cache.ts` listed and deleted this directory
 * directly. Now:
 *
 * - **Bytes** enter the asset service's `px` namespace (`PUT/POST <origin>/api/asset/px/<sha256>…`,
 *   client `asset-store/client.mjs`), path `/api/asset/px/<sha256>`. Content-addressed; identical
 *   images are stored only once.
 * - **Cache key** remains the input hash (12 characters computed by `bakeTarget`), which does not
 *   equal the content hash, so a small index is recorded separately:
 *   `<outRoot>/bake-index/<key>.json` = `{ key, hash, bytes, width, height, clipId, name, at, pushed? }`.
 *   The index is merely a local cache record, storing no bytes and not located in the asset service's
 *   storage directory; the editor process (warm-standby renderer path `ui-render/bake-batch`) and
 *   prerender process share it, one file per key, written via atomic rename, so even if both sides
 *   write the same key concurrently, it remains a single complete copy.
 * - **Hits** must query the asset service: counts only if present in the index and
 *   `GET px/<hash>/chunks` reports `complete` (the index does not serve as ground truth).
 *   If no longer in the asset service, the index entry is deleted immediately, treated as never
 *   rendered.
 * - **Legacy URLs**: parameters in legacy projects store `/@media/bake-….png`. Old files in the asset
 *   catalog are neither deleted nor moved; the asset service's legacy read route
 *   `/@media/<filename>` continues to serve them, so legacy URLs remain accessible as usual. When the
 *   same key is requested again, the old file is first fetched via this legacy route (an asset
 *   service interface, not direct directory reading); once retrieved, it is pushed into `px` and
 *   recorded in the index (migration on read), avoiding re-rendering.
 * - **Eviction** only deletes index entries: the asset service has no delete API (content-addressed,
 *   immutable after write), so bytes remain in the asset service, leaving reclamation to the asset
 *   service side (see `docs/reports/AGENT-bake-asset.md` "Decisions required from lead session").
 * - **Shared projects**: when this process has registered a connected remote asset service client
 *   (`setBakeRemote`), after writing to the local asset service, an additional copy is pushed to
 *   remote; on success, `pushed: <base-url>` is recorded in the index; if pushing fails, it will be
 *   pushed again on the next hit. When other members' local asset services lack this chunk locally,
 *   they pull from remote via `/api/asset/px/<hash>` (on-demand artifact pull in `asset-service.ts`).
 *
 * When the asset service is unreachable (cannot get URL, connection failed, timeout) or rejects
 * (4xx / 5xx), throw `BakeStoreError` with a message stating the asset service URL and reason,
 * which the caller forwards as-is to the Agent / page.
 *
 * This file does not import vite, does not recognize the asset catalog, and
 * `server/test/bake-store.test.mjs` tests it directly.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAssetClient } from './asset-store/client.mjs';
import { tr } from './i18n.mjs';

export const BAKE_INDEX_DIR = 'bake-index';
export const BAKE_NS = 'px';
/** Timeout for fetching legacy files via legacy read route; a single PNG over local loopback */
export const LEGACY_FETCH_TIMEOUT_MS = 15_000;
/** Timeout for an asset service request (writing a snapshot, querying reconciliation) */
export const BAKE_ASSET_TIMEOUT_MS = 30_000;
/** Number of concurrent requests querying the asset service during inventory */
const STATUS_CONCURRENCY = 8;
/** Maximum size of legacy files (same order of magnitude as 2048² texture limit for RGBA PNG, leaving ample margin) */
const LEGACY_MAX_BYTES = 64 * 1024 * 1024;

const KEY_RE = /^[0-9a-f]{12}$/;
/** Legacy format keys (filenames as keys) do not enter the index; index accepts current format only */
const HASH_RE = /^[0-9a-f]{64}$/;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class BakeStoreError extends Error {
  constructor(message, extra = {}) {
    super(message);
    this.name = 'BakeStoreError';
    this.kind = 'asset-service';
    Object.assign(this, extra);
  }
}

/** URL of a chunk in the px namespace (this is what is stored in page and card parameters) */
export const bakeUrlOf = (hash) => `/api/asset/${BAKE_NS}/${hash}`;

/* ------------------------------------------------------------------ *
 * Connected remote asset service (shared project)
 * ------------------------------------------------------------------ */

const REMOTE_KEY = Symbol.for('promptcut.bake-store.remote');

/**
 * Register the remote asset service client connected to this process (an instance of `createAssetClient`
 * with a write ticket); null clears it.
 * Prerender process is registered by the push queue (`vite-plugin-frames.ts`), and editor process
 * is registered by the upload queue destination (`vite-plugin-media.ts`).
 * Placed on globalThis: configuration has been bundled once, module may have two instances.
 * @param {null | (() => any)} getClient
 */
export function setBakeRemote(getClient) {
  /** @type {any} */ (globalThis)[REMOTE_KEY] = typeof getClient === 'function' ? getClient : null;
}

/** Currently registered remote asset service client; null if none */
export function bakeRemote() {
  const fn = /** @type {any} */ (globalThis)[REMOTE_KEY];
  try { return typeof fn === 'function' ? fn() ?? null : null; } catch { return null; }
}

/* ------------------------------------------------------------------ */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Error thrown by asset service client -> BakeStoreError stating URL and reason */
function wrap(err, base, what) {
  if (err instanceof BakeStoreError) return err;
  const status = err && typeof err === 'object' ? err.status : undefined;
  const msg = String(err?.message || err);
  if (typeof status === 'number') {
    return new BakeStoreError(tr("Asset service rejected the {0} ({1}, HTTP {2}): {3}", what, base, status, msg), { status });
  }
  return new BakeStoreError(tr("Asset service unreachable ({0}), PNG snapshot failed to {1}: {2}", base, what, msg));
}

async function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, text);
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/** Map with concurrency limit */
async function mapLimit(list, limit, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= list.length) return;
      out[i] = await fn(list[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return out;
}

/**
 * @param {object} p
 * @param {string} p.indexDir  Index directory (`<outRoot>/bake-index`)
 * @param {() => (string | null)} p.origin  Asset service origin (no trailing slash); fetched on demand; null = unreachable
 * @param {typeof fetch} [p.fetchImpl]
 * @param {() => any} [p.remote]  Connected remote asset service client; defaults to registered via `setBakeRemote`
 * @param {(event: string, fields?: object) => void} [p.log]
 * @param {number} [p.timeoutMs]
 * @param {number} [p.retries]  Retry count for asset service client (defaults to 2)
 */
export function createBakeStore({ indexDir, origin, fetchImpl = globalThis.fetch, remote = bakeRemote, log = () => {}, timeoutMs = BAKE_ASSET_TIMEOUT_MS, retries = 2 }) {
  if (typeof indexDir !== 'string' || !indexDir) throw new TypeError('createBakeStore: indexDir is required');
  if (typeof origin !== 'function') throw new TypeError('createBakeStore: origin must be a function');
  let cached = null; // { base, client }

  /** Client for the current asset service; throws if URL cannot be resolved */
  function current(what) {
    const src = String(origin() || '').trim().replace(/\/+$/, '');
    if (!src) throw new BakeStoreError(tr("Asset service unreachable: cannot get the asset service address, PNG snapshot failed to {0}", what));
    const base = `${src}/api/asset`;
    if (cached?.base !== base) cached = { src, base, client: createAssetClient({ base, fetch: fetchImpl, timeoutMs, retries }) };
    return cached;
  }

  const fileOf = (key) => path.join(indexDir, `${key}.json`);

  async function readEntry(key) {
    if (!KEY_RE.test(String(key))) return null;
    let text;
    try { text = await fs.readFile(fileOf(key), 'utf8'); } catch { return null; }
    try {
      const e = JSON.parse(text);
      if (e?.key !== key || !HASH_RE.test(String(e.hash)) || !Number.isSafeInteger(e.bytes)) return null;
      return e;
    } catch { return null; }
  }

  async function writeEntry(entry) {
    await fs.mkdir(indexDir, { recursive: true });
    await writeAtomic(fileOf(entry.key), JSON.stringify(entry));
  }

  async function dropEntry(key) {
    try { await fs.unlink(fileOf(key)); return true; } catch { return false; }
  }

  const withUrl = (e) => ({ ...e, url: bakeUrlOf(e.hash) });

  /**
   * Push a copy to the connected remote asset service (shared project). Runs in background without
   * blocking caller; records `pushed` in index on success.
   * Does not push if remote is the local asset service (push queue has not received registration yet,
   * `asset-select.mjs` falls back to local).
   */
  function pushRemote(entry, bytes) {
    let client;
    try { client = remote(); } catch { client = null; }
    if (!client || typeof client.put !== 'function') return null;
    const base = String(client.base || '').replace(/\/+$/, '');
    if (base && entry.pushed === base) return null;
    // Selected target is the local asset service (falls back to local when push queue has not received
    // other registrations yet): already written there, do not push
    try { if (base && base === current(tr("read")).base) return null; } catch { /* Push anyway if local URL cannot be resolved */ }
    return (async () => {
      try {
        const buf = bytes ?? await current(tr("read")).client.get(BAKE_NS, entry.hash);
        if (!buf) return;
        await client.put(BAKE_NS, buf, { ext: 'png' });
        const now = await readEntry(entry.key);
        if (now && now.hash === entry.hash) await writeEntry({ ...now, pushed: base });
        log('bake.pushed', { key: entry.key, hash: entry.hash, base });
      } catch (err) {
        log('bake.push-failed', { key: entry.key, hash: entry.hash, base, message: String(err?.message || err) });
      }
    })();
  }

  const api = {
    indexDir,

    /**
     * Whether this key has been rendered: present in index, and this chunk is `complete` on the asset service.
     * Returns null if not found; throws `BakeStoreError` if asset service is unreachable.
     * @param {string} key
     */
    async lookup(key) {
      const e = await readEntry(key);
      if (!e) return null;
      const { base, client } = current(tr("read"));
      let complete;
      try { complete = await client.has(BAKE_NS, e.hash); } catch (err) { throw wrap(err, base, tr("read")); }
      if (!complete) {
        // Chunk no longer in asset service: index does not serve as ground truth, delete entry, treat as never rendered
        await dropEntry(key);
        log('bake.stale', { key, hash: e.hash });
        return null;
      }
      void pushRemote(e, null);
      return withUrl(e);
    },

    /**
     * Writes the rendered PNG into `px` via the asset service and records it in the index.
     * Returns the index entry with `url`.
     * @param {string} key
     * @param {Buffer} buf
     * @param {{ width?: number, height?: number, clipId?: string, name?: string }} [meta]
     */
    async put(key, buf, meta = {}) {
      if (!KEY_RE.test(String(key))) throw new TypeError(tr("Invalid PNG snapshot key: {0}", key));
      const { base, client } = current(tr("write"));
      let r;
      try { r = await client.put(BAKE_NS, buf, { ext: 'png' }); } catch (err) { throw wrap(err, base, tr("write")); }
      const entry = {
        key, hash: r.hash, bytes: r.size,
        width: Number(meta.width) || null, height: Number(meta.height) || null,
        clipId: typeof meta.clipId === 'string' ? meta.clipId : null,
        name: typeof meta.name === 'string' ? meta.name : null,
        at: Date.now(),
      };
      await writeEntry(entry);
      void pushRemote(entry, buf);
      return withUrl(entry);
    },

    /**
     * Migration on read: fetches the file for this key in the legacy format (`/@media/<name>`) once via
     * the legacy read route of the asset service; if found, pushes it into `px` and records it in the
     * index. Returns null if missing (404); throws `BakeStoreError` if the asset service is
     * unreachable. The old file is left untouched.
     * @param {string} key
     * @param {string} name  Legacy file name `bake-<clipId>-<key>.png`
     * @param {{ width?: number, height?: number, clipId?: string }} [meta]
     */
    async migrateLegacy(key, name, meta = {}) {
      if (!KEY_RE.test(String(key)) || !/^bake-[\w.-]*\.png$/.test(String(name))) return null;
      const { src, base } = current(tr("read"));
      const url = `${src}/@media/${encodeURIComponent(name)}`;
      let res;
      try {
        res = await fetchImpl(url, { signal: AbortSignal.timeout(LEGACY_FETCH_TIMEOUT_MS) });
      } catch (err) {
        throw new BakeStoreError(tr("Asset service unreachable ({0}), failed to read PNG snapshot: {1}", base, err?.cause?.code || err?.message || err));
      }
      if (res.status === 404) { await res.arrayBuffer().catch(() => {}); return null; }
      if (!res.ok) {
        await res.arrayBuffer().catch(() => {});
        throw new BakeStoreError(tr("Asset service refused the read ({0}, HTTP {1}): /@media/{2}", base, res.status, name), { status: res.status });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // If it is not a PNG (such as another file with the same name during migration, or an empty file),
      // treat as missing and re-render
      if (buf.length < PNG_MAGIC.length || buf.length > LEGACY_MAX_BYTES || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
      const e = await api.put(key, buf, { ...meta, name });
      log('bake.migrated', { key, name, hash: e.hash });
      return { ...e, migrated: true };
    },

    /** All entries in the index (without querying the asset service) */
    async list() {
      let names;
      try { names = await fs.readdir(indexDir); } catch { return []; }
      const out = [];
      for (const n of names) {
        const m = /^([0-9a-f]{12})\.json$/.exec(n);
        if (!m) continue;
        const e = await readEntry(m[1]);
        if (e) out.push(withUrl(e));
      }
      return out;
    },

    /**
     * Inventory: which of these keys are rendered (present in the index, `complete` on the asset
     * service). Returns `Map<key, entry>`, containing only rendered ones. Throws `BakeStoreError` if
     * the asset service is unreachable.
     * @param {string[]} keys
     */
    async status(keys) {
      const uniq = [...new Set((keys || []).filter((k) => KEY_RE.test(String(k))))];
      const entries = (await Promise.all(uniq.map(readEntry))).filter(Boolean);
      const found = new Map();
      if (!entries.length) return found;
      const { base, client } = current(tr("read"));
      const done = await mapLimit(entries, STATUS_CONCURRENCY, async (e) => {
        try { return await client.has(BAKE_NS, e.hash); } catch (err) { throw wrap(err, base, tr("read")); }
      });
      for (let i = 0; i < entries.length; i++) {
        if (done[i]) found.set(entries[i].key, withUrl(entries[i]));
        else { await dropEntry(entries[i].key); log('bake.stale', { key: entries[i].key, hash: entries[i].hash }); }
      }
      return found;
    },

    /**
     * Eviction: deletes index entries for these keys. **Keys only**: compares one by one against its
     * own listed index and deletes only matches, never touching files outside the index.
     * Bytes remain in the asset service (no delete endpoint); `freedBytes` is the byte count recorded
     * by these entries (used by the page to calculate usage).
     * @param {unknown} keys
     */
    async evict(keys) {
      const want = new Set((Array.isArray(keys) ? keys : []).filter((k) => typeof k === 'string' && k.length > 0));
      const deleted = [];
      let freedBytes = 0;
      if (!want.size) return { deleted, freedBytes };
      for (const e of await api.list()) {
        if (!want.has(e.key)) continue;
        if (await dropEntry(e.key)) { deleted.push(e.key); freedBytes += e.bytes; }
      }
      return { deleted, freedBytes };
    },

    /** For unit tests: current asset service API base URL */
    baseForTest() { return current(tr("read")).base; },
  };
  return api;
}

/** SHA-256 of bytes (for unit tests and probe reconciliation) */
export const bakeHashOf = sha256;
