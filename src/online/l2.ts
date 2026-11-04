/**
 * In-page snapshot store L2 (C10 contract `docs/plan/c10-contract.md` Section 4, Section 18 Item 2;
 * for numbers see `docs/semantics/mechanism/platforms.md` "Online browser mode").
 *
 * IndexedDB for the editor page, one database and three stores; content can always be refetched
 * from document service and asset service, or remeasured (semantics: local browser stores only
 * refetchable cache, `product/platforms.md` "Online browser mode"):
 *
 *   - `costs`: cost records (keyed by "card identity + local environment", `mode=build`); does not
 *     participate in eviction;
 *   - `snapshots`: prerender chunks fetched from asset service (`snap/<hash>`, `px/<hash>`,
 *     content hash as key, bytes and type as value);
 *   - `ranges`: ready tracking by layer (which local frame ranges of chunks for this layer are in
 *     store). **Ready-on-write**: notifies subscribers once `putRange` settles.
 *
 * # Quotas and eviction
 *
 * - Soft limit: allocated based on measured environment (`l2LimitOf`; no fixed number by identity or
 *   tier, user decision, 2026-10-07), guarded by its own LRU here:
 *   when `navigator.storage.estimate()` is available, takes 10% of remaining quota, clamped between
 *   [`L2_SOFT_LIMIT_MIN`, `L2_SOFT_LIMIT_MAX`] (not exceeding remaining quota);
 *   when unavailable, calculates `navigator.deviceMemory`(GiB) × 32 MiB, clamped to [64, 256] MiB;
 *   if neither is available (Safari, Firefox), takes 128 MiB.
 *   Performs LRU by chunk byte size; `costs` does not participate in eviction.
 *   LRU order: persisted to disk at write time (`snapshots` `at`); read hits only update order in
 *   memory, without rewriting entire chunk bytes just to update a timestamp:
 *   after reopening the page, falls back to write-time order (approximate LRU, see report).
 * - On `QuotaExceededError` during write: in **a single delete transaction**, deletes via LRU until
 *   freeing `max(16 MiB, byte size of this chunk)` (up to 64 MiB), then opens another write
 *   transaction to retry this chunk; if it still fails, keeps this chunk in memory only (lost once
 *   page is closed) and no longer writes to store.
 * - Listens to both `error` and `abort` transaction events; one transaction per frame, no batching.
 * - Does not rely on `persist()`: being cleared by browser only requires refetching, without
 *   affecting correctness.
 *
 * This module belongs to the render layer (`src/online/`): does not import editor; does not read
 * `import.meta.env` (Node unit tests inject in-memory stubs).
 */

export const MiB = 1024 * 1024;
/**
 * Constants for allocating soft limit by environment (tier-3 numbers, `mechanism/platforms.md`
 * "In-page snapshot store" [ruling]; for rationale see `docs/reports/AGENT-claude-online-browser.md`
 * "Numbers and rationale"): bounds when quota is available, allocation per GiB memory and bounds
 * when quota is unavailable, and default when neither is available.
 */
export const L2_SOFT_LIMIT_MIN = 32 * MiB;
export const L2_SOFT_LIMIT_MAX = 1024 * MiB;
export const L2_PER_MEMORY_GIB = 32 * MiB;
export const L2_MEMORY_LIMIT_MIN = 64 * MiB;
export const L2_MEMORY_LIMIT_MAX = 256 * MiB;
export const L2_SOFT_LIMIT_DEFAULT = 128 * MiB;
/** Lower and upper bounds reclaimed in a single delete transaction after quota error (Section 18 Item 2) */
export const L2_RECLAIM_MIN = 16 * MiB;
export const L2_RECLAIM_MAX = 64 * MiB;
/** When `estimate()` is available, upper limit does not exceed this ratio of remaining quota */
export const L2_QUOTA_SHARE = 0.1;
/** Memory-only chunks (from failed store writes) keep at most this many bytes; discarded FIFO when exceeded */
export const L2_MEMORY_FALLBACK_MAX = 32 * MiB;

export const L2_DB_NAME = "promptcut-l2";
export const L2_DB_VERSION = 1;
export const L2_STORES = { costs: "costs", snapshots: "snapshots", ranges: "ranges" } as const;

export type Range = [number, number];

export interface L2OpenOptions {
  /** IndexedDB factory; defaults to `globalThis.indexedDB` */
  indexedDB?: IDBFactory;
  /** Defaults to `navigator.deviceMemory` (GiB; Chromium-only) */
  deviceMemory?: number;
  /** Defaults to `navigator.storage.estimate` */
  estimate?: () => Promise<{ quota?: number; usage?: number }>;
  now?: () => number;
  /** Store name (can be overridden by unit tests and probes) */
  name?: string;
}

export interface L2Block { bytes: Uint8Array; type: string }
export interface L2ReadyEvent { layerKey: string; ranges: Range[] }

export interface L2Stats {
  limit: number;
  bytes: number;
  blocks: number;
  memoryBlocks: number;
  memoryBytes: number;
  writes: number;
  hits: number;
  misses: number;
  evicted: number;
  quotaErrors: number;
  reclaimed: number;
  memoryOnly: number;
  txErrors: number;
}

export interface L2Store {
  /** Current soft limit (bytes) */
  limit(): number;
  putBlock(key: string, bytes: Uint8Array | ArrayBuffer, type?: string): Promise<"db" | "memory">;
  getBlock(key: string): Promise<L2Block | null>;
  hasBlock(key: string): boolean;
  putCost(key: string, record: unknown): Promise<void>;
  getCost(key: string): Promise<unknown | null>;
  listCosts(): Promise<unknown[]>;
  /** Merges `[from, to]` (local frames, closed interval) into this layer's ready ranges; notifies subscribers once settled */
  putRange(layerKey: string, from: number, to: number): Promise<Range[]>;
  getRanges(layerKey: string): Promise<Range[]>;
  /** Subscribes to "ready-on-write"; returns unsubscribe function */
  subscribeReady(cb: (e: L2ReadyEvent) => void): () => void;
  stats(): L2Stats;
  close(): void;
}

interface Meta { size: number; at: number }

const isQuota = (e: unknown): boolean => {
  const name = (e as { name?: string } | null)?.name ?? "";
  return name === "QuotaExceededError" || /quota/i.test(String((e as Error | null)?.message ?? ""));
};

const toBytes = (b: Uint8Array | ArrayBuffer): Uint8Array => (b instanceof Uint8Array ? b : new Uint8Array(b));

/** Merges two closed interval lists (input does not need to be sorted) */
export function mergeRanges(list: readonly (readonly number[])[]): Range[] {
  const sorted = list
    .map((r) => [Math.floor(Number(r[0])), Math.floor(Number(r[1]))] as Range)
    .filter((r) => Number.isFinite(r[0]) && Number.isFinite(r[1]) && r[0] >= 0 && r[1] >= r[0])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  }
  return out;
}

/** A request → Promise (also handles the request's own error) */
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB request failed"));
  });
}

/**
 * Runs a transaction: issues requests in `body`; succeeds only on transaction `complete`, while
 * `error` / `abort` count as failure (bubbles error, quota errors preserve `name`).
 * Aborts this transaction if `body` throws.
 */
function runTx<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, body: (tx: IDBTransaction) => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let tx: IDBTransaction;
    try { tx = db.transaction(stores, mode); } catch (e) { reject(e); return; }
    let out: T;
    let settled = false;
    let failure: unknown = null;
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      reject(e ?? new Error("IndexedDB transaction failed"));
    };
    tx.oncomplete = () => { if (!settled) { settled = true; resolve(out); } };
    tx.onerror = (ev) => {
      // Request errors bubble to the transaction; record the first one (quota errors usually here), wait for abort or fail directly
      const err = (ev?.target as IDBRequest | null)?.error ?? tx.error;
      failure ??= err;
      fail(failure);
    };
    tx.onabort = () => fail(failure ?? tx.error ?? Object.assign(new Error("IndexedDB transaction aborted"), { name: "AbortError" }));
    const abortWith = (e: unknown) => {
      failure ??= e;
      try { tx.abort(); } catch { fail(e); }
    };
    // Issue requests synchronously: transactions are only active in the task that created them
    try {
      const v = body(tx);
      if (v && typeof (v as Promise<T>).then === "function") (v as Promise<T>).then((x) => { out = x; }, abortWith);
      else out = v as T;
    } catch (e) {
      abortWith(e);
    }
  });
}

function openDb(factory: IDBFactory, name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let r: IDBOpenDBRequest;
    try { r = factory.open(name, L2_DB_VERSION); } catch (e) { reject(e); return; }
    r.onupgradeneeded = () => {
      const db = r.result;
      if (!db.objectStoreNames.contains(L2_STORES.costs)) db.createObjectStore(L2_STORES.costs, { keyPath: "key" });
      if (!db.objectStoreNames.contains(L2_STORES.snapshots)) db.createObjectStore(L2_STORES.snapshots, { keyPath: "key" });
      if (!db.objectStoreNames.contains(L2_STORES.ranges)) db.createObjectStore(L2_STORES.ranges, { keyPath: "key" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("cannot open the in-page snapshot store"));
    r.onblocked = () => { /* Another tab holds an older version: wait for it to close */ };
  });
}

/** Portion allocated based on memory when quota is unavailable (returns `L2_SOFT_LIMIT_DEFAULT` if `deviceMemory` cannot be read) */
export function l2LimitByMemory(deviceMemory: number | undefined): number {
  const gib = Number(deviceMemory);
  if (!Number.isFinite(gib) || gib <= 0) return L2_SOFT_LIMIT_DEFAULT;
  return Math.max(L2_MEMORY_LIMIT_MIN, Math.min(L2_MEMORY_LIMIT_MAX, Math.floor(gib * L2_PER_MEMORY_GIB)));
}

/**
 * Soft limit allocated based on measured environment: takes 10% of remaining quota when `estimate()`
 * is available, clamped between [`L2_SOFT_LIMIT_MIN`, `L2_SOFT_LIMIT_MAX`] (lower bound also does not
 * exceed remaining quota itself); when unavailable, based on memory (`l2LimitByMemory`).
 */
export async function l2LimitOf(estimate?: () => Promise<{ quota?: number; usage?: number }>, deviceMemory?: number): Promise<number> {
  const fallback = l2LimitByMemory(deviceMemory);
  if (!estimate) return fallback;
  try {
    const e = await estimate();
    const quota = Number(e?.quota), usage = Number(e?.usage) || 0;
    if (!Number.isFinite(quota) || quota <= 0) return fallback;
    const free = Math.max(0, quota - usage);
    const share = Math.floor(L2_QUOTA_SHARE * free);
    return Math.min(free, Math.max(L2_SOFT_LIMIT_MIN, Math.min(L2_SOFT_LIMIT_MAX, share)));
  } catch {
    return fallback;
  }
}

/**
 * Opens L2. When IndexedDB is unavailable (no factory or cannot open), returns an in-memory-only
 * implementation (same interface); page works as usual, except data is lost once closed.
 */
export async function openL2(opts: L2OpenOptions = {}): Promise<L2Store> {
  const now = opts.now ?? Date.now;
  const g = globalThis as unknown as { indexedDB?: IDBFactory; navigator?: { deviceMemory?: number; storage?: { estimate?: () => Promise<{ quota?: number; usage?: number }> } } };
  const factory = opts.indexedDB ?? g.indexedDB;
  const estimate = opts.estimate ?? (g.navigator?.storage?.estimate ? () => g.navigator!.storage!.estimate!() : undefined);
  const deviceMemory = opts.deviceMemory ?? (typeof g.navigator?.deviceMemory === "number" ? g.navigator.deviceMemory : undefined);
  const limit = await l2LimitOf(estimate, deviceMemory);

  let db: IDBDatabase | null = null;
  if (factory) {
    try { db = await openDb(factory, opts.name ?? L2_DB_NAME); } catch { db = null; }
  }

  /** Order and size of chunks in the store (Map insertion order = least recently used first) */
  const lru = new Map<string, Meta>();
  let total = 0;
  const memory = new Map<string, L2Block>();
  let memoryBytes = 0;
  const readyListeners = new Set<(e: L2ReadyEvent) => void>();
  /** Cost records that failed to write to the store (kept in memory only) */
  const memoryCosts = new Map<string, unknown>();
  const rangeCache = new Map<string, Range[]>();
  const st = { writes: 0, hits: 0, misses: 0, evicted: 0, quotaErrors: 0, reclaimed: 0, memoryOnly: 0, txErrors: 0 };

  if (db) {
    // Load chunk sizes and write timestamps (cursor reads; only read once at open). Order by write timestamp
    try {
      const metas = await runTx(db, [L2_STORES.snapshots], "readonly", (tx) => new Promise<{ key: string; size: number; at: number }[]>((resolve, reject) => {
        const out: { key: string; size: number; at: number }[] = [];
        const r = tx.objectStore(L2_STORES.snapshots).openCursor();
        r.onsuccess = () => {
          const c = r.result;
          if (!c) { resolve(out); return; }
          const v = c.value as { key: string; size?: number; at?: number; bytes?: { byteLength?: number } };
          out.push({ key: String(v.key), size: Number(v.size) || Number(v.bytes?.byteLength) || 0, at: Number(v.at) || 0 });
          c.continue();
        };
        r.onerror = () => reject(r.error);
      }));
      metas.sort((a, b) => a.at - b.at);
      for (const m of metas) { lru.set(m.key, { size: m.size, at: m.at }); total += m.size; }
    } catch { /* Cannot read: treat as empty store */ }
  }

  const touch = (key: string) => {
    const m = lru.get(key);
    if (!m) return;
    lru.delete(key);
    lru.set(key, m);
  };

  const rememberMemory = (key: string, block: L2Block) => {
    const old = memory.get(key);
    if (old) { memoryBytes -= old.bytes.byteLength; memory.delete(key); }
    memory.set(key, block);
    memoryBytes += block.bytes.byteLength;
    while (memoryBytes > L2_MEMORY_FALLBACK_MAX && memory.size > 1) {
      const first = memory.keys().next().value as string;
      memoryBytes -= memory.get(first)!.bytes.byteLength;
      memory.delete(first);
    }
  };

  /** Picks chunks to delete using LRU until `need` bytes are freed (excluding `except`) */
  const pickVictims = (need: number, except?: string): string[] => {
    const out: string[] = [];
    let freed = 0;
    for (const [key, m] of lru) {
      if (freed >= need) break;
      if (key === except) continue;
      out.push(key);
      freed += m.size;
    }
    return out;
  };
  const forget = (keys: string[]) => {
    for (const k of keys) {
      const m = lru.get(k);
      if (!m) continue;
      total -= m.size;
      lru.delete(k);
    }
  };

  const writeBlock = async (key: string, block: L2Block, size: number, victims: string[]) => {
    await runTx(db!, [L2_STORES.snapshots], "readwrite", (tx) => {
      const store = tx.objectStore(L2_STORES.snapshots);
      for (const v of victims) store.delete(v);
      store.put({ key, bytes: block.bytes, type: block.type, size, at: now() });
    });
  };

  const store: L2Store = {
    limit: () => limit,

    async putBlock(key, raw, type = "application/octet-stream") {
      const bytes = toBytes(raw);
      const block: L2Block = { bytes, type };
      const size = bytes.byteLength;
      if (!db || size > limit) {
        st.memoryOnly++;
        rememberMemory(key, block);
        return "memory";
      }
      if (lru.has(key)) { touch(key); return "db"; }
      // Soft limit: in the same transaction, delete the least recently used first, then write this chunk
      const over = total + size - limit;
      const victims = over > 0 ? pickVictims(over, key) : [];
      try {
        await writeBlock(key, block, size, victims);
        forget(victims);
        st.evicted += victims.length;
        lru.set(key, { size, at: now() });
        total += size;
        st.writes++;
        memory.delete(key);
        return "db";
      } catch (e) {
        st.txErrors++;
        if (!isQuota(e)) { st.memoryOnly++; rememberMemory(key, block); return "memory"; }
        st.quotaErrors++;
        // Quota error: a delete transaction frees max(16 MiB, this chunk) via LRU, up to 64 MiB; then opens another write transaction to retry
        const need = Math.min(L2_RECLAIM_MAX, Math.max(L2_RECLAIM_MIN, size));
        const reclaim = pickVictims(need, key);
        try {
          if (reclaim.length) {
            await runTx(db!, [L2_STORES.snapshots], "readwrite", (tx) => {
              const s = tx.objectStore(L2_STORES.snapshots);
              for (const v of reclaim) s.delete(v);
            });
            forget(reclaim);
            st.reclaimed += reclaim.length;
          }
          await writeBlock(key, block, size, []);
          lru.set(key, { size, at: now() });
          total += size;
          st.writes++;
          return "db";
        } catch {
          st.txErrors++;
          st.memoryOnly++;
          rememberMemory(key, block);
          return "memory";
        }
      }
    },

    async getBlock(key) {
      const mem = memory.get(key);
      if (mem) { st.hits++; return mem; }
      if (!db || !lru.has(key)) { st.misses++; return null; }
      try {
        const v = await runTx(db, [L2_STORES.snapshots], "readonly", (tx) => req(tx.objectStore(L2_STORES.snapshots).get(key)));
        const rec = v as { bytes?: Uint8Array | ArrayBuffer; type?: string } | undefined;
        if (!rec?.bytes) { forget([key]); st.misses++; return null; }
        touch(key);
        st.hits++;
        return { bytes: toBytes(rec.bytes), type: rec.type || "application/octet-stream" };
      } catch {
        st.misses++;
        return null;
      }
    },

    hasBlock: (key) => memory.has(key) || lru.has(key),

    async putCost(key, record) {
      if (!db) { memoryCosts.set(key, record); return; }
      try {
        await runTx(db, [L2_STORES.costs], "readwrite", (tx) => { tx.objectStore(L2_STORES.costs).put({ key, record, at: now() }); });
      } catch {
        st.txErrors++;
        memoryCosts.set(key, record);
      }
    },

    async getCost(key) {
      if (memoryCosts.has(key)) return memoryCosts.get(key) ?? null;
      if (!db) return null;
      try {
        const v = await runTx(db, [L2_STORES.costs], "readonly", (tx) => req(tx.objectStore(L2_STORES.costs).get(key)));
        return (v as { record?: unknown } | undefined)?.record ?? null;
      } catch { return null; }
    },

    async listCosts() {
      const out = new Map<string, unknown>();
      if (db) {
        try {
          const all = await runTx(db, [L2_STORES.costs], "readonly", (tx) => req(tx.objectStore(L2_STORES.costs).getAll()));
          for (const v of (all as { key: string; record: unknown }[]) ?? []) out.set(v.key, v.record);
        } catch { /* Cannot read: return in-memory only */ }
      }
      for (const [k, v] of memoryCosts) out.set(k, v);
      return [...out.values()];
    },

    async putRange(layerKey, from, to) {
      const prev = await store.getRanges(layerKey);
      const next = mergeRanges([...prev, [from, to]]);
      rangeCache.set(layerKey, next);
      if (db) {
        try {
          await runTx(db, [L2_STORES.ranges], "readwrite", (tx) => { tx.objectStore(L2_STORES.ranges).put({ key: layerKey, ranges: next, at: now() }); });
        } catch { st.txErrors++; }
      }
      // Ready-on-write (contract Section 4): notify once settled
      for (const l of [...readyListeners]) { try { l({ layerKey, ranges: next }); } catch { /* A broken subscriber must not affect others */ } }
      return next;
    },

    async getRanges(layerKey) {
      const hit = rangeCache.get(layerKey);
      if (hit) return hit;
      if (!db) return [];
      try {
        const v = await runTx(db, [L2_STORES.ranges], "readonly", (tx) => req(tx.objectStore(L2_STORES.ranges).get(layerKey)));
        const list = mergeRanges(((v as { ranges?: number[][] } | undefined)?.ranges ?? []) as number[][]);
        rangeCache.set(layerKey, list);
        return list;
      } catch { return []; }
    },

    subscribeReady(cb) {
      readyListeners.add(cb);
      return () => { readyListeners.delete(cb); };
    },

    stats: () => ({ limit, bytes: total, blocks: lru.size, memoryBlocks: memory.size, memoryBytes, ...st }),

    close() {
      readyListeners.clear();
      try { db?.close(); } catch { /* Closed */ }
      db = null;
    },
  };
  return store;
}

/* ------------------------------------------------------------------ The single store for this page */

let shared: Promise<L2Store> | null = null;

/**
 * L2 for this page (only one opened per editor page; shared by cost records and prerender chunks).
 */
export function pageL2(): Promise<L2Store> {
  shared ??= openL2();
  return shared;
}
