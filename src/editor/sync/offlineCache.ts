import { tr } from "../../i18n/index.ts";
/**
 * Local stash (browser local cache): offline edits made while disconnected, and the local copy of the pending merge table.
 *
 * Semantics `docs/semantics/workflow/project.md` "Temporarily offline projects and saving", `mechanism/document-service.md`
 * "Save baseline and modified-state check":
 * changes made while the online browser is offline are written to the browser's local cache (`IndexedDB`, falling back to
 * `localStorage` when unavailable); once connected to the document service and
 * stored in that user's pending merge table, the matching local stash is cleared.
 *
 * Keys are by "project × user": `<kind>|<project id>|<user>`, kind `journal` (DocSync's offline batches), `merge` (the local copy of the
 * pending merge table and the outbound queue).
 * Pure interface; storage is injected by the caller (unit tests use `src/testing/fakeIndexedDB.mjs` or an in-memory version).
 */

export interface KvStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

export type CacheKind = "journal" | "merge";

export const cacheKey = (kind: CacheKind, projectId: string, user: string): string => `${kind}|${projectId}|${user}`;

/** Level-3 numbers: database name, table name */
export const OFFLINE_DB = { name: "pc-offline", version: 1, store: "kv" } as const;

type IdbFactory = { open(name: string, version?: number): IDBOpenDBRequest };

/** IndexedDB version: one database with one table, `key` is the primary key */
export function idbStore(factory: IdbFactory): KvStore {
  let opening: Promise<IDBDatabase> | null = null;
  const db = () => opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(OFFLINE_DB.name, OFFLINE_DB.version);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames?.contains?.(OFFLINE_DB.store)) d.createObjectStore(OFFLINE_DB.store, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { opening = null; reject(req.error ?? new Error(tr("IndexedDB can't be opened"))); };
  });
  const run = async <T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T> => {
    const d = await db();
    return new Promise<T>((resolve, reject) => {
      const tx = d.transaction([OFFLINE_DB.store], mode);
      const req = fn(tx.objectStore(OFFLINE_DB.store));
      let result: T;
      if (req) req.onsuccess = () => { result = req.result as T; };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error(tr("IndexedDB write failed")));
      tx.onabort = () => reject(tx.error ?? new Error(tr("IndexedDB write aborted")));
    });
  };
  return {
    async get(key) {
      const row = await run<{ key: string; value: unknown } | undefined>("readonly", (s) => s.get(key));
      return row?.value;
    },
    async put(key, value) { await run("readwrite", (s) => s.put({ key, value })); },
    async delete(key) { await run("readwrite", (s) => s.delete(key)); },
  };
}

type StorageLike = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void };

/** localStorage version (when IndexedDB is unavailable) */
export function storageStore(storage: StorageLike, prefix = "pc.offline."): KvStore {
  return {
    async get(key) {
      const raw = storage.getItem(prefix + key);
      return raw == null ? undefined : JSON.parse(raw);
    },
    async put(key, value) { storage.setItem(prefix + key, JSON.stringify(value)); },
    async delete(key) { storage.removeItem(prefix + key); },
  };
}

/** In-memory version (when there is no browser storage at all; gone when the page closes) */
export function memoryStore(): KvStore & { readonly size: number } {
  const m = new Map<string, string>();
  return {
    async get(key) { const raw = m.get(key); return raw === undefined ? undefined : JSON.parse(raw); },
    async put(key, value) { m.set(key, JSON.stringify(value)); },
    async delete(key) { m.delete(key); },
    get size() { return m.size; },
  };
}

/** Which kind the page default is: the first two survive closing the page, `memory` does not */
export type StoreKind = "idb" | "local" | "memory";

/** The page default: IndexedDB → localStorage → memory */
let shared: KvStore | null = null;
let sharedKind: StoreKind = "memory";
export function defaultStore(): KvStore {
  if (shared) return shared;
  const g = globalThis as { indexedDB?: IdbFactory; localStorage?: StorageLike };
  try { if (g.indexedDB) { sharedKind = "idb"; return (shared = idbStore(g.indexedDB)); } } catch { /* Next */ }
  try { if (g.localStorage) { sharedKind = "local"; return (shared = storageStore(g.localStorage)); } } catch { /* Next */ }
  sharedKind = "memory";
  return (shared = memoryStore());
}

/**
 * Whether the default store can persist (whether it survives closing the page). The in-memory fallback
 * **cannot persist**: writes raise no error, but everything is gone once the page closes or the editor
 * is left.
 * The UI is honest about this (`offlineStoreOf` in `onlineStatus.ts`): if it cannot persist, it counts as
 * "only in this page" and must never say "saved on this machine".
 */
export function defaultStoreDurable(): boolean {
  defaultStore();
  return sharedKind !== "memory";
}

/** Which kind the default store currently is (for troubleshooting and unit tests) */
export function defaultStoreKind(): StoreKind {
  defaultStore();
  return sharedKind;
}

/** Swap the store in unit tests. If `kind` is omitted, it counts as "can persist" (the fake stores in unit tests are mostly in-memory, but what is wanted is the durable path) */
export function setDefaultStore(s: KvStore | null, kind: StoreKind = "idb"): void {
  shared = s;
  sharedKind = s ? kind : "memory";
}
