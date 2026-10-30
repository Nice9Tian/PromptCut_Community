/**
 * 页面内快照库 L2(C10 契约 `docs/plan/c10-contract.md` 第 4 节、第 18 节第 2 条;数字见 `docs/semantics/mechanism/platforms.md`
 * 「在线浏览器模式」)。
 *
 * 编辑器页的 IndexedDB,一个库、三张表,内容都能从文档服务与素材服务重新拉回、或重新测出(语义:浏览器本地只放能重新拉回的缓存,
 * `product/platforms.md`「在线浏览器模式」):
 *
 *   - `costs`:成本记录(按「卡片身份 + 本机环境」为键,`mode=build`);不参与淘汰;
 *   - `snapshots`:从素材服务取来的预渲染块(`snap/<hash>`、`px/<hash>`,内容哈希为键,值为字节与类型);
 *   - `ranges`:按层记就绪(这一层哪几段本地帧的块都已在库里)。**写入即就绪**:`putRange` 落定就通知订阅方。
 *
 * # 配额与淘汰
 *
 * - 软上限:按实测到的环境分配(`l2LimitOf`;不按身份或档位定固定数,2026-10-07 用户定),由这里自己的 LRU 守住:
 *   `navigator.storage.estimate()` 拿得到时取剩余额度的 10%,夹在 [`L2_SOFT_LIMIT_MIN`, `L2_SOFT_LIMIT_MAX`] 之间(不超过剩余额度);
 *   拿不到时按 `navigator.deviceMemory`(GiB)× 32 MiB,夹在 [64, 256] MiB;两样都没有(Safari、Firefox)取 128 MiB。
 *   按块的字节数做 LRU,`costs` 不参与淘汰。
 *   LRU 的次序:写入时刻落盘(`snapshots` 的 `at`);读命中只更新内存里的次序,不为改一个时间戳重写整块字节 ——
 *   重开页面之后退回按写入时刻排(近似 LRU,见报告)。
 * - 写入遇到 `QuotaExceededError`:在**一个删除事务里**按 LRU 删到腾出 `max(16 MiB, 这一块的字节数)` 为止(至多 64 MiB),
 *   再另开一个写事务把这一块重试一次;仍失败,这一块只放内存(页面关掉就没),不再写库。
 * - 事务的 `error` 与 `abort` 两个事件都接;一帧一个事务,不攒批。
 * - 不依赖 `persist()`:被浏览器清空只是要重新取,不影响正确性。
 *
 * 本模块属于 render 这一层(`src/online/`):不引 editor;不读 `import.meta.env`(Node 单测注入内存桩)。
 */

export const MiB = 1024 * 1024;
/**
 * 软上限按环境分配的几个数(三级数字,`mechanism/platforms.md`「页面内快照库」〔裁〕;依据见 `docs/reports/AGENT-claude-online-browser.md`
 * 「数字与依据」):额度拿得到时的上下界,拿不到额度时每 GiB 内存给多少、上下界,两样都没有时的缺省。
 */
export const L2_SOFT_LIMIT_MIN = 32 * MiB;
export const L2_SOFT_LIMIT_MAX = 1024 * MiB;
export const L2_PER_MEMORY_GIB = 32 * MiB;
export const L2_MEMORY_LIMIT_MIN = 64 * MiB;
export const L2_MEMORY_LIMIT_MAX = 256 * MiB;
export const L2_SOFT_LIMIT_DEFAULT = 128 * MiB;
/** 配额错误后一个删除事务回收的下限与上限(第 18 节第 2 条) */
export const L2_RECLAIM_MIN = 16 * MiB;
export const L2_RECLAIM_MAX = 64 * MiB;
/** `estimate()` 拿得到时,上限不超过剩余额度的这个比例 */
export const L2_QUOTA_SHARE = 0.1;
/** 只放内存的块(写库失败的)最多留这么多字节,超了按先进先出丢 */
export const L2_MEMORY_FALLBACK_MAX = 32 * MiB;

export const L2_DB_NAME = "promptcut-l2";
export const L2_DB_VERSION = 1;
export const L2_STORES = { costs: "costs", snapshots: "snapshots", ranges: "ranges" } as const;

export type Range = [number, number];

export interface L2OpenOptions {
  /** IndexedDB 工厂;缺省 `globalThis.indexedDB` */
  indexedDB?: IDBFactory;
  /** 缺省 `navigator.deviceMemory`(GiB;Chromium 系才有) */
  deviceMemory?: number;
  /** 缺省 `navigator.storage.estimate` */
  estimate?: () => Promise<{ quota?: number; usage?: number }>;
  now?: () => number;
  /** 库名(单测、探针可以换) */
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
  /** 此刻的软上限(字节) */
  limit(): number;
  putBlock(key: string, bytes: Uint8Array | ArrayBuffer, type?: string): Promise<"db" | "memory">;
  getBlock(key: string): Promise<L2Block | null>;
  hasBlock(key: string): boolean;
  putCost(key: string, record: unknown): Promise<void>;
  getCost(key: string): Promise<unknown | null>;
  listCosts(): Promise<unknown[]>;
  /** 把 `[from, to]`(本地帧,闭区间)并进这一层的就绪区间;落定后通知订阅方 */
  putRange(layerKey: string, from: number, to: number): Promise<Range[]>;
  getRanges(layerKey: string): Promise<Range[]>;
  /** 订阅「写入即就绪」;回退订 */
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

/** 两份闭区间表合并(输入不必有序) */
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

/** 一个请求 → Promise(请求自己的 error 也接) */
function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error("IndexedDB 请求失败"));
  });
}

/**
 * 跑一个事务:`body` 里发请求;事务 `complete` 才算成,`error` / `abort` 都算失败(带出错误,配额错误保持 `name`)。
 * `body` 抛了就 abort 这个事务。
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
      reject(e ?? new Error("IndexedDB 事务失败"));
    };
    tx.oncomplete = () => { if (!settled) { settled = true; resolve(out); } };
    tx.onerror = (ev) => {
      // 请求的错误会冒到事务上;记下第一条(配额错误多在这里),等 abort 或直接失败
      const err = (ev?.target as IDBRequest | null)?.error ?? tx.error;
      failure ??= err;
      fail(failure);
    };
    tx.onabort = () => fail(failure ?? tx.error ?? Object.assign(new Error("IndexedDB 事务被中止"), { name: "AbortError" }));
    const abortWith = (e: unknown) => {
      failure ??= e;
      try { tx.abort(); } catch { fail(e); }
    };
    // 同步发请求:事务只在创建它的那个任务里是活的
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
    r.onerror = () => reject(r.error ?? new Error("打不开页面内快照库"));
    r.onblocked = () => { /* 别的标签页握着旧版本:等它关 */ };
  });
}

/** 拿不到额度时按内存给的那一份(`deviceMemory` 读不到回 `L2_SOFT_LIMIT_DEFAULT`) */
export function l2LimitByMemory(deviceMemory: number | undefined): number {
  const gib = Number(deviceMemory);
  if (!Number.isFinite(gib) || gib <= 0) return L2_SOFT_LIMIT_DEFAULT;
  return Math.max(L2_MEMORY_LIMIT_MIN, Math.min(L2_MEMORY_LIMIT_MAX, Math.floor(gib * L2_PER_MEMORY_GIB)));
}

/**
 * 软上限按实测到的环境分配:`estimate()` 拿得到额度时取剩余额度的 10%,夹在 [`L2_SOFT_LIMIT_MIN`, `L2_SOFT_LIMIT_MAX`]
 * (下界也不超过剩余额度本身);拿不到时按内存(`l2LimitByMemory`)。
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
 * 打开 L2。IndexedDB 不可用(没有工厂、打不开)时回一个只放内存的实现(同一套接口),页面照常工作,只是关掉就没了。
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

  /** 库里块的次序与大小(Map 的插入序 = 最久没用的在前) */
  const lru = new Map<string, Meta>();
  let total = 0;
  const memory = new Map<string, L2Block>();
  let memoryBytes = 0;
  const readyListeners = new Set<(e: L2ReadyEvent) => void>();
  /** 写库失败的成本记录(只放内存) */
  const memoryCosts = new Map<string, unknown>();
  const rangeCache = new Map<string, Range[]>();
  const st = { writes: 0, hits: 0, misses: 0, evicted: 0, quotaErrors: 0, reclaimed: 0, memoryOnly: 0, txErrors: 0 };

  if (db) {
    // 载入块的大小与写入时刻(游标读值;只在打开时读一遍)。按写入时刻排好次序
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
    } catch { /* 读不了:当空库 */ }
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

  /** 按 LRU 挑出要删的块,直到腾出 `need` 字节(不含 `except`) */
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
      // 软上限:同一个事务里先删最久没用的,再写这一块
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
        // 配额错误:一个删除事务按 LRU 腾出 max(16 MiB, 这一块) —— 至多 64 MiB;再另开写事务重试一次
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
        } catch { /* 读不了:只给内存里的 */ }
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
      // 写入即就绪(契约第 4 节):落定就通知
      for (const l of [...readyListeners]) { try { l({ layerKey, ranges: next }); } catch { /* 订阅方坏了不影响别人 */ } }
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
      try { db?.close(); } catch { /* 已关 */ }
      db = null;
    },
  };
  return store;
}

/* ------------------------------------------------------------------ 本页的那一个库 */

let shared: Promise<L2Store> | null = null;

/**
 * 本页的 L2(编辑器页只开一个;成本记录与预渲染块共用)。
 */
export function pageL2(): Promise<L2Store> {
  shared ??= openL2();
  return shared;
}
