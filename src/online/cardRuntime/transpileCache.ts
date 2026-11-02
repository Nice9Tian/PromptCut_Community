/**
 * Transpile cache for single files (`docs/plan/online-card-exec-contract.md` Sections 1, 5):
 * key = runtime version + file key + content hash. Stored in IndexedDB of the **editor page**
 * (stage is another origin, unable to see it); does not re-transpile if content hash is unchanged,
 * and if transpiler changes (runtime version changed), old entries no longer hit.
 *
 * Reads are synchronous (queried file by file during transpilation): on page load, entries for this
 * runtime version are bulk-loaded from the store into memory (`warm`), querying only memory
 * thereafter; writes enter memory first, then persist asynchronously to the store;
 * persist failures are ignored (re-transpiled next time). In environments without IndexedDB
 * (unit tests, private browsing mode), this functions as an in-memory table.
 * Failed results (unsupported syntax) are also cached: no need to re-evaluate the same source
 * code every 5 seconds.
 */
import type { FileResult } from "./transpile.ts";

export const TRANSPILE_DB = "pc-card-transpile";
const STORE = "files";
/** Maximum entries retained in memory and in the store (oldest evicted in order of write) */
export const TRANSPILE_CACHE_LIMIT = 600;

export interface TranspileCache {
  get(key: string, hash: string): FileResult | undefined;
  set(key: string, hash: string, value: FileResult): void;
  /** Reads entries for this runtime version from the store into memory; treated as empty if store is missing or read fails */
  warm(): Promise<void>;
  readonly size: number;
}

type IdbFactory = Pick<IDBFactory, "open">;

const cacheKey = (runtime: string, key: string, hash: string) => `${runtime}\n${key}\n${hash}`;

const validResult = (v: unknown): v is FileResult => {
  if (!v || typeof v !== "object") return false;
  const r = v as { ok?: unknown; js?: unknown; specifiers?: unknown; state?: { state?: unknown } };
  if (r.ok === true) return typeof r.js === "string" && Array.isArray(r.specifiers) && r.specifiers.every((s) => typeof s === "string");
  return r.ok === false && !!r.state && typeof r.state.state === "string";
};

export function createTranspileCache(runtime: string, idb: IdbFactory | null = typeof indexedDB === "undefined" ? null : indexedDB): TranspileCache {
  const mem = new Map<string, FileResult>();
  let db: Promise<IDBDatabase | null> | null = null;
  const open = () => {
    if (!idb) return Promise.resolve(null);
    db ??= new Promise<IDBDatabase | null>((resolve) => {
      try {
        const req = idb.open(TRANSPILE_DB, 1);
        req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      } catch { resolve(null); }
    });
    return db;
  };
  const trim = () => { while (mem.size > TRANSPILE_CACHE_LIMIT) mem.delete(mem.keys().next().value as string); };
  return {
    get size() { return mem.size; },
    get(key, hash) {
      if (!hash) return undefined;
      return mem.get(cacheKey(runtime, key, hash));
    },
    set(key, hash, value) {
      if (!hash) return;
      const k = cacheKey(runtime, key, hash);
      mem.delete(k);
      mem.set(k, value);
      trim();
      void open().then((d) => {
        if (!d) return;
        try { d.transaction(STORE, "readwrite").objectStore(STORE).put(value, k); } catch { /* Persist to store failed: re-transpile next time */ }
      });
    },
    async warm() {
      const d = await open();
      if (!d) return;
      await new Promise<void>((resolve) => {
        try {
          const tx = d.transaction(STORE, "readwrite");
          const store = tx.objectStore(STORE);
          const prefix = `${runtime}\n`;
          const req = store.openCursor();
          let kept = 0;
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return;
            const k = String(cur.key);
            // Other runtime versions, malformed entries, or those exceeding the limit: opportunistically delete
            if (!k.startsWith(prefix) || !validResult(cur.value) || kept >= TRANSPILE_CACHE_LIMIT) cur.delete();
            else { kept++; if (!mem.has(k)) mem.set(k, cur.value); }
            cur.continue();
          };
          tx.oncomplete = () => resolve();
          tx.onerror = () => resolve();
          tx.onabort = () => resolve();
        } catch { resolve(); }
      });
      trim();
    },
  };
}
