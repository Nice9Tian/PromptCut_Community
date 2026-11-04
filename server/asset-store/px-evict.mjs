/**
 * Capacity eviction for the local asset service `px` namespace (claude/bake-asset; report
 * `docs/reports/AGENT-bake-asset.md` "Capacity eviction of px").
 *
 * `px` contains entirely regenerable pixel outputs (card snapshots, track stream segments, PNG
 * cache frames): they can be rerendered if lost. After card snapshots switched to the asset
 * service, 3D view and idle prerendering continuously write new snapshots here, so it needs a cap.
 * Original assets (`media`) and HTML snapshots (`snap`) **are not managed here**: this module
 * only accesses that single data layer `px` and cannot touch other namespaces.
 *
 * Rules follow the approach in `docs/semantics/mechanism/platforms.md` "Frame store" [ruling]
 * (numbers are tertiary, centralized in `PX_EVICT_DEFAULTS`):
 *   - **Cap**: default 10 GiB; 2% of total capacity when disk capacity is under 500 GiB;
 *     configurable via environment variable `PROMPTCUT_PX_CAP_BYTES` (for testing, troubleshooting);
 *   - **Most recently used**: each time asset service responds for this chunk (retrieve, reconcile,
 *     finalize), records a usage timestamp in `<px directory>/.usage.json` (batched every 30
 *     seconds, also written before eviction); unrecorded chunks take the file's modification time.
 *     Every card snapshot index hit and page inventory round queries reconcile, so snapshots
 *     "still in use by indices" naturally remain fresh;
 *   - **Eviction**: when total exceeds cap, delete from oldest to newest by last used down to 90%
 *     of cap; chunks used within 30 minutes are not deleted; unremovable chunks (file in use) are
 *     skipped and retried next round;
 *   - **Timing**: evaluate for the first time 2 minutes after startup; thereafter evaluate when a
 *     new chunk is stored in `px`, at most once every 5 minutes;
 *   - **Multi-process**: the same `px` directory may be managed by asset services in multiple
 *     processes (editor, headless instance): acquire `<px directory>/.evict-lock` (exclusive
 *     creation) before evaluating eviction; skip this round if unavailable; lock files not updated
 *     for over 3 minutes are considered deadlocks and deleted before reacquiring.
 * When an evicted chunk is requested again: card snapshot index queries reconcile and receives
 * "missing", deletes the index entry, and rerenders (`bake-store.mjs`); stream and frame pullers
 * treat it as missing as before.
 *
 * Only modifies bytes via the data layer's `list` / `stat` / `remove` (the fs implementation's
 * `list` is unique to it); only reads and writes `.usage.json` and `.evict-lock` additionally in
 * the directory.
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
 * Cap for `px` (bytes): environment variable takes precedence; otherwise 2% if disk is under
 * 500 GiB, else 10 GiB.
 * @param {{ env?: NodeJS.ProcessEnv, diskTotal?: number | null }} [o]
 */
export function pxCapBytes({ env = process.env, diskTotal = null } = {}) {
  const raw = Number(env.PROMPTCUT_PX_CAP_BYTES);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  const d = PX_EVICT_DEFAULTS;
  if (Number.isFinite(diskTotal) && diskTotal > 0 && diskTotal < d.smallDiskBytes) return Math.floor(diskTotal * d.smallDiskRatio);
  return d.capBytes;
}

/** Total capacity of containing disk; null if unavailable */
export async function diskTotalOf(dir) {
  try { const s = await fs.statfs(dir); return Number(s.blocks) * Number(s.bsize); } catch { return null; }
}

/**
 * Pure function: picks items to delete from oldest to newest by last used, down to `targetRatio`
 * of the cap; items used within `protectMs` are not picked.
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
 * @param {string} p.dir  Directory for `px` (root for fs implementation)
 * @param {{ list(): Promise<{hash:string,size:number}[]>, stat(h:string): Promise<any>, remove(h:string): Promise<boolean> }} p.store
 * @param {number | (() => Promise<number> | number)} [p.capBytes]  Default calculated from `pxCapBytes` and disk capacity
 * @param {() => number} [p.now]
 * @param {(event: string, fields?: object) => void} [p.log]
 * @param {Partial<typeof PX_EVICT_DEFAULTS>} [p.options]
 */
export function createPxEvictor({ dir, store, capBytes, now = Date.now, log = () => {}, options = {} }) {
  if (store?.projectId && (store.namespace !== 'px' || path.resolve(dir) !== path.resolve(store.projectDir))) throw new TypeError('project px eviction directory mismatch');
  const o = { ...PX_EVICT_DEFAULTS, ...options };
  if (typeof store?.list !== 'function') throw new TypeError('createPxEvictor: the data layer has no list (only the fs implementation can evict)');
  const usageFile = path.join(dir, PX_USAGE_FILE);
  const lockFile = path.join(dir, PX_LOCK_FILE);
  /** Accumulated usage timestamps in memory: hash → ms */
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

  /**
   * Merge accumulated usage timestamps into `.usage.json` (read-merge-atomic rename write;
   * concurrent writes only lose a few timestamps, won't corrupt the file)
   */
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
      } catch { /* Just released */ }
      return false;
    }
  }

  /**
   * Run one eviction evaluation. Returns `{ ran, removed, freed, total, cap }`; returns `ran: false`
   * if lock cannot be acquired
   */
  async function evictOnce() {
    const cap = await capOf();
    if (!(await takeLock())) { log('px.evict-skip', { reason: 'locked' }); return { ran: false, removed: [], freed: 0, total: null, cap }; }
    try {
      const listed = (await store.list()).filter((b) => HASH.test(b.hash));
      const used = await flush(new Set(listed.map((b) => b.hash)));
      const blobs = [];
      for (const b of listed) {
        let mtime = 0;
        try { mtime = Number((await store.stat(b.hash))?.mtimeMs) || 0; } catch { /* Just deleted */ }
        blobs.push({ hash: b.hash, size: b.size, lastUsed: Math.max(Number(used[b.hash]) || 0, mtime) });
      }
      const t = now();
      const { victims, total, target } = planPxEviction(blobs, { capBytes: cap, now: t, protectMs: o.protectMs, targetRatio: o.targetRatio });
      const removed = [];
      let freed = 0;
      for (const v of victims) {
        let ok = false;
        try { ok = await store.remove(v.hash); } catch { ok = false; } // In use: skip and retry next round
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
    /** Asset service responded for this chunk (retrieve, reconcile, finalize): record one usage */
    touch(hash) {
      const h = String(hash || '').toLowerCase();
      if (!HASH.test(h) || stopped) return;
      touched.set(h, now());
      if (!flushTimer) {
        flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, o.usageFlushMs);
        flushTimer.unref?.();
      }
    },
    /** Evaluate once now (for unit tests, troubleshooting; only runs one pass at a time) */
    evictNow() {
      running ??= evictOnce().finally(() => { running = null; });
      return running;
    },
    /** New chunk stored: evaluate once if interval since last evaluation exceeds minimum interval */
    onStored() {
      if (stopped || running || now() - lastRun < o.minIntervalMs || firstTimer) return null;
      return api.evictNow().catch((e) => { log('px.evict-failed', { message: String(e?.message || e) }); });
    },
    /** Startup: wait `firstDelayMs` before evaluating for the first time */
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
