/**
 * 本机素材服务 `px` 命名空间的容量淘汰(claude/bake-asset;报告 `docs/reports/AGENT-bake-asset.md`「px 的容量淘汰」)。
 *
 * `px` 里全是可再生的像素产物(卡片快照、轨道流的分段、PNG 缓存帧):没了可以重渲。卡片快照改走素材服务之后,
 * 3D 视图与空闲预渲染会不断往这里写新快照,所以它要有上限。素材原件(`media`)与 HTML 快照(`snap`)**不归这里管**:
 * 本模块只拿到 `px` 那一个数据层,碰不到别的命名空间。
 *
 * 规则照 `docs/semantics/mechanism/platforms.md`「帧库」的思路〔裁〕(数字是三级,集中在 `PX_EVICT_DEFAULTS`):
 *   - **上限**:缺省 10 GiB;所在磁盘总容量小于 500 GiB 时取总容量的 2%;环境变量 `PROMPTCUT_PX_CAP_BYTES` 可改(测试、排查用);
 *   - **最近使用**:素材服务每答一次这一块(取回、对账、收尾)就记一次使用时刻,记在 `<px 目录>/.usage.json`
 *     (攒 30 秒写一次,淘汰前也写);没记过的取文件的修改时刻。卡片快照的索引每次命中、页面每轮盘点都会问对账,
 *     所以「还在被索引用着」的快照自然一直是新的;
 *   - **淘汰**:总量超过上限时,按最近使用时刻从旧到新删,删到上限的 90%;30 分钟内用过的不删;
 *     删不掉的(文件被占用)跳过,下一轮再试;
 *   - **时机**:启动后等 2 分钟判第一次;之后每次 `px` 有新块入库时判,最多每 5 分钟一次;
 *   - **多进程**:同一个 `px` 目录可能被几个进程的素材服务同时管(编辑器、无头实例):判淘汰前先拿 `<px 目录>/.evict-lock`
 *     (独占创建),拿不到就跳过这一轮;锁文件超过 3 分钟没更新算死锁,删掉再拿。
 * 淘汰掉的块再被要时:卡片快照的索引问对账得到「没有」,删索引条目、重渲(`bake-store.mjs`);流与帧的拉取方照旧当没有。
 *
 * 只经数据层的 `list` / `stat` / `remove` 动字节(fs 实现的 `list` 是它独有的);目录里只另读写 `.usage.json` 与 `.evict-lock`。
 */
import fs from 'node:fs/promises';
import path from 'node:path';

const GiB = 1024 ** 3;
export const PX_EVICT_DEFAULTS = Object.freeze({
  capBytes: 10 * GiB,
  smallDiskBytes: 500 * GiB,
  smallDiskRatio: 0.02,
  targetRatio: 0.9,
  protectMs: 30 * 60_000,
  firstDelayMs: 2 * 60_000,
  minIntervalMs: 5 * 60_000,
  lockStaleMs: 3 * 60_000,
  usageFlushMs: 30_000,
});
export const PX_USAGE_FILE = '.usage.json';
export const PX_LOCK_FILE = '.evict-lock';
const HASH = /^[0-9a-f]{64}$/;

/**
 * `px` 的上限(字节):环境变量优先;否则磁盘小于 500 GiB 取 2%,不然 10 GiB。
 * @param {{ env?: NodeJS.ProcessEnv, diskTotal?: number | null }} [o]
 */
export function pxCapBytes({ env = process.env, diskTotal = null } = {}) {
  const raw = Number(env.PROMPTCUT_PX_CAP_BYTES);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  const d = PX_EVICT_DEFAULTS;
  if (Number.isFinite(diskTotal) && diskTotal > 0 && diskTotal < d.smallDiskBytes) return Math.floor(diskTotal * d.smallDiskRatio);
  return d.capBytes;
}

/** 所在磁盘的总容量;取不到给 null */
export async function diskTotalOf(dir) {
  try { const s = await fs.statfs(dir); return Number(s.blocks) * Number(s.bsize); } catch { return null; }
}

/**
 * 纯函数:按最近使用从旧到新挑要删的,删到上限的 `targetRatio`;`protectMs` 内用过的不挑。
 * @param {{ hash: string, size: number, lastUsed: number }[]} blobs
 * @returns {{ victims: typeof blobs, total: number, target: number }}
 */
export function planPxEviction(blobs, { capBytes, now, protectMs = PX_EVICT_DEFAULTS.protectMs, targetRatio = PX_EVICT_DEFAULTS.targetRatio }) {
  const total = blobs.reduce((s, b) => s + b.size, 0);
  const target = Math.floor(capBytes * targetRatio);
  const victims = [];
  if (total <= capBytes) return { victims, total, target };
  let left = total;
  for (const b of [...blobs].sort((a, b2) => a.lastUsed - b2.lastUsed || (a.hash < b2.hash ? -1 : 1))) {
    if (left <= target) break;
    if (now - b.lastUsed < protectMs) continue;
    victims.push(b);
    left -= b.size;
  }
  return { victims, total, target };
}

/**
 * @param {object} p
 * @param {string} p.dir  `px` 的目录(fs 实现的根)
 * @param {{ list(): Promise<{hash:string,size:number}[]>, stat(h:string): Promise<any>, remove(h:string): Promise<boolean> }} p.store
 * @param {number | (() => Promise<number> | number)} [p.capBytes]  缺省按 `pxCapBytes` 与磁盘容量算
 * @param {() => number} [p.now]
 * @param {(event: string, fields?: object) => void} [p.log]
 * @param {Partial<typeof PX_EVICT_DEFAULTS>} [p.options]
 */
export function createPxEvictor({ dir, store, capBytes, now = Date.now, log = () => {}, options = {} }) {
  if (store?.projectId && (store.namespace !== 'px' || path.resolve(dir) !== path.resolve(store.projectDir))) throw new TypeError('project px eviction directory mismatch');
  const o = { ...PX_EVICT_DEFAULTS, ...options };
  if (typeof store?.list !== 'function') throw new TypeError('createPxEvictor:数据层没有 list(只有 fs 实现能做淘汰)');
  const usageFile = path.join(dir, PX_USAGE_FILE);
  const lockFile = path.join(dir, PX_LOCK_FILE);
  /** 内存里攒着的使用时刻:hash → ms */
  const touched = new Map();
  let flushTimer = null;
  let firstTimer = null;
  let lastRun = 0;
  let running = null;
  let stopped = false;

  const capOf = async () => {
    if (typeof capBytes === 'number') return capBytes;
    if (typeof capBytes === 'function') return Number(await capBytes());
    return pxCapBytes({ diskTotal: await diskTotalOf(dir) });
  };

  async function readUsage() {
    try {
      const obj = JSON.parse(await fs.readFile(usageFile, 'utf8'));
      return obj && typeof obj === 'object' && obj.v === 1 && obj.used && typeof obj.used === 'object' ? obj.used : {};
    } catch { return {}; }
  }

  /** 攒着的使用时刻并进 `.usage.json`(读—合并—原子改名写;并发写只会丢几条使用时刻,不会坏文件) */
  async function flush(keep) {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const pending = [...touched];
    touched.clear();
    const used = await readUsage();
    for (const [h, t] of pending) if (!(used[h] >= t)) used[h] = t;
    if (keep) for (const h of Object.keys(used)) if (!keep.has(h)) delete used[h];
    if (!pending.length && !keep) return used;
    try {
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${usageFile}.${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
      await fs.writeFile(tmp, JSON.stringify({ v: 1, used }));
      await fs.rename(tmp, usageFile).catch(async (e) => { await fs.rm(tmp, { force: true }).catch(() => {}); throw e; });
    } catch (e) { log('px.usage-write-failed', { message: String(e?.message || e) }); }
    return used;
  }

  async function takeLock() {
    try {
      await fs.mkdir(dir, { recursive: true });
      const fh = await fs.open(lockFile, 'wx');
      await fh.writeFile(JSON.stringify({ pid: process.pid, at: now() }));
      await fh.close();
      return true;
    } catch (e) {
      if (e?.code !== 'EEXIST') return false;
      try {
        const st = await fs.stat(lockFile);
        if (now() - st.mtimeMs > o.lockStaleMs) { await fs.rm(lockFile, { force: true }); return takeLock(); }
      } catch { /* 刚被放掉 */ }
      return false;
    }
  }

  /** 判一次淘汰。回 `{ ran, removed, freed, total, cap }`;拿不到锁回 `ran: false` */
  async function evictOnce() {
    const cap = await capOf();
    if (!(await takeLock())) { log('px.evict-skip', { reason: 'locked' }); return { ran: false, removed: [], freed: 0, total: null, cap }; }
    try {
      const listed = (await store.list()).filter((b) => HASH.test(b.hash));
      const used = await flush(new Set(listed.map((b) => b.hash)));
      const blobs = [];
      for (const b of listed) {
        let mtime = 0;
        try { mtime = Number((await store.stat(b.hash))?.mtimeMs) || 0; } catch { /* 刚被删 */ }
        blobs.push({ hash: b.hash, size: b.size, lastUsed: Math.max(Number(used[b.hash]) || 0, mtime) });
      }
      const t = now();
      const { victims, total, target } = planPxEviction(blobs, { capBytes: cap, now: t, protectMs: o.protectMs, targetRatio: o.targetRatio });
      const removed = [];
      let freed = 0;
      for (const v of victims) {
        let ok = false;
        try { ok = await store.remove(v.hash); } catch { ok = false; } // 被占用:跳过,下一轮再试
        if (ok) { removed.push(v.hash); freed += v.size; }
      }
      if (removed.length || total > cap) log('px.evicted', { total, cap, target, removed: removed.length, freed, skipped: victims.length - removed.length });
      return { ran: true, removed, freed, total, cap };
    } finally {
      lastRun = now();
      await fs.rm(lockFile, { force: true }).catch(() => {});
    }
  }

  const api = {
    /** 素材服务答了这一块(取回、对账、收尾):记一次使用 */
    touch(hash) {
      const h = String(hash || '').toLowerCase();
      if (!HASH.test(h) || stopped) return;
      touched.set(h, now());
      if (!flushTimer) {
        flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, o.usageFlushMs);
        flushTimer.unref?.();
      }
    },
    /** 现在就判一次(单测、排查用;同一时刻只跑一趟) */
    evictNow() {
      running ??= evictOnce().finally(() => { running = null; });
      return running;
    },
    /** 有新块入库:距上次判超过最小间隔就判一次 */
    onStored() {
      if (stopped || running || now() - lastRun < o.minIntervalMs || firstTimer) return null;
      return api.evictNow().catch((e) => { log('px.evict-failed', { message: String(e?.message || e) }); });
    },
    /** 启动:等 `firstDelayMs` 判第一次 */
    start() {
      if (firstTimer || stopped) return;
      firstTimer = setTimeout(() => { firstTimer = null; void api.evictNow().catch((e) => log('px.evict-failed', { message: String(e?.message || e) })); }, o.firstDelayMs);
      firstTimer.unref?.();
    },
    async stop() {
      stopped = true;
      if (firstTimer) { clearTimeout(firstTimer); firstTimer = null; }
      await running?.catch(() => {});
      await flush();
    },
    flush: () => flush(),
  };
  return api;
}
