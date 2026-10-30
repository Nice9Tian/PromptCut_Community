/**
 * 单个文件的转译缓存(`docs/plan/online-card-exec-contract.md` 第 1、5 节):键 = 运行时版本 + 文件键 + 内容哈希。
 * 存在**编辑页面**的 IndexedDB 里(舞台是另一个源,看不到);内容哈希没变不重转,换了转译器(运行时版本变了)旧条目不再命中。
 *
 * 读是同步的(转译流程里逐个文件问):开页面时把库里这一版运行时的条目整批读进内存(`warm`),之后只查内存;
 * 写是先进内存、再异步落库,落库失败不管(下次重转)。没有 IndexedDB(单测、隐私模式)时就是一张内存表。
 * 失败的结果(不支持的写法)也存:同一份源码不必每 5 秒重判一次。
 */
import type { FileResult } from "./transpile.ts";

export const TRANSPILE_DB = "pc-card-transpile";
const STORE = "files";
/** 内存与库里各最多留多少条(按写入先后淘汰最旧的) */
export const TRANSPILE_CACHE_LIMIT = 600;

export interface TranspileCache {
  get(key: string, hash: string): FileResult | undefined;
  set(key: string, hash: string, value: FileResult): void;
  /** 把库里这一版运行时的条目读进内存;没有库、读失败都当空的 */
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
        try { d.transaction(STORE, "readwrite").objectStore(STORE).put(value, k); } catch { /* 落库失败:下次重转 */ }
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
            // 别的运行时版本的、形状不对的、超出上限的:顺手删掉
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
