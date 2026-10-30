/**
 * 帧库的使用索引、容量上限、按最近使用淘汰与「清理缓存」（存储占用计划 B 部分，`docs/plan/storage-plan.md` 第 3.2、3.3 节）。
 *
 * # 帧库里认得的键目录（淘汰和计量的单位）
 *
 *   <root>/<entryKey>                     整场景目录
 *   <root>/controls-local/<entryKey>      这个整场景的本地档快照（整个外层目录算一个）
 *   <root>/controls-html/<键>             共享档快照
 *   <root>/controls/<键>                  独立卡的 PNG / MOV
 *   <root>/streams/<键>                   轨道流
 *   <root>/tracks/<键>                    轨道前缀
 *
 * 键一律是 64 位小写十六进制。别的名字、别的目录（`controls-lock`、`push-queue.json`……）不认、不计、不删。
 * 整场景目录和它的 `controls-local/<entryKey>` 是一个淘汰单元：一起判、一起删。
 *
 * # 使用索引 `<root>/usage.json`
 *
 * 按键目录（上表的相对路径，斜杠分隔）记 `[最近使用时刻, 字节数, 其中遗留文件的字节数, 量的时刻]`。
 *   - **记使用**：预加载打开一个项目的某个版本时，这个版本用到的键一起记（`touchEntry`，由 `FramePipeline` 调）；
 *     项目开着时每 `TICK_MS` 再记一次（本模块的节拍，按就绪索引里还活着的会话判「开着」）。
 *   - **字节数增量维护**：记过使用的键在下一次检查时重量（它们正在被写）；检查时列一遍各族目录（只读目录名，不进去），
 *     新出现的键量一次、消失的键从索引删掉。全量重扫只在索引缺失、读不懂、或距上次全量超过 `CALIBRATE_MS` 时做，异步、不挡预加载。
 *   - 索引丢了（或第一次运行）按目录重扫，最近使用时刻取目录里最新文件的修改时刻。
 *
 * # 多进程
 *
 * 编辑器进程、预渲染进程、无头实例（Skill）的预渲染进程可能共用一个帧库。**同一时刻只有一个进程写索引、做淘汰**：
 * 它持有 `<root>/.storage/owner.json`（pid + 心跳，`LOCK_STALE_MS` 没心跳或 pid 不在了就可接管）。
 * 别的进程把自己记的使用写进 `<root>/.storage/touch/<pid>.json`（只有它自己写），主进程每次检查时并进索引，
 * pid 不在了的文件并完即删。编辑器进程不建本模块（它的管线 `interactive: false`，几乎不写帧库）；
 * 没人记过使用的目录按最新文件的修改时刻兜底。
 *
 * # 淘汰
 *
 * 总量超过上限时按最近使用时刻从旧到新删单元，删到上限的 `EVICT_TARGET_RATIO`；`PROTECT_MS` 内用过的不删，
 * 正在打开的项目的键不删。删法：先把目录**改名**进 `<root>/.storage/trash/`（Windows 上目录里有任何文件被打开时改名失败 ——
 * 失败就跳过、下一轮再试，不会删一半），再递归删垃圾目录（删不完的下一轮接着删）。键目录本身、它所在的族目录、
 * 目录里任何一处是符号链接或 junction 的，一律跳过。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { snapshotTier } from './snapshot-tier.mjs';
import { isDeadSpillDir, isExportDirName, leftoverFileKind, pidAlive as leftoverPidAlive, sweepFrameLibrary } from './storage-leftovers.mjs';
import { summarizeExports } from './exports-list.mjs';

/**
 * 容量的 GB 按 1024³ 字节算（与 Windows 资源管理器显示的「GB」、开始页草稿列表的大小同一口径）：
 * 缺省 50 GB、下限 5 GB、「磁盘小于 500 GB 取 10%」的 500 GB 都是这个 GB。
 */
export const GB = 1024 ** 3;
export const DEFAULT_CAP_BYTES = 50 * GB;
/** 所在磁盘总容量小于它时，缺省上限取总容量的 `SMALL_DISK_RATIO` */
export const SMALL_DISK_BYTES = 500 * GB;
export const SMALL_DISK_RATIO = 0.1;
/** 用户可设的下限；上限是磁盘总容量 */
export const MIN_CAP_BYTES = 5 * GB;
/** 超上限时删到上限的这个比例 */
export const EVICT_TARGET_RATIO = 0.9;
/** 这么久内用过的不删 */
export const PROTECT_MS = 30 * 60 * 1000;
/** 「清理缓存」留下这么久内用过的 */
export const CLEAR_KEEP_MS = 10 * 60 * 1000;
/** 开着的项目再记一次使用、检查一次要不要淘汰的节拍；检查最多这么频繁 */
export const TICK_MS = 5 * 60 * 1000;
/** 启动后第一次判淘汰前等这么久(页面重连、重发 preload,正在打开的项目先记上使用) */
export const STARTUP_GRACE_MS = 2 * 60 * 1000;
/** 全量重扫校正字节数的周期 */
export const CALIBRATE_MS = 24 * 60 * 60 * 1000;
/** 主进程心跳 */
export const HEARTBEAT_MS = 60 * 1000;
/** 这么久没心跳的主进程锁可以接管 */
export const LOCK_STALE_MS = 3 * 60 * 1000;
/** 使用记录落盘的防抖 */
export const FLUSH_MS = 60 * 1000;
/** 就绪索引里的会话这么久没动静、又没有订阅者，就不算「开着」 */
export const OPEN_SESSION_IDLE_MS = 10 * 60 * 1000;
/** `GET /api/storage` 时上一次检查（或量）早于这么久，就在后台量一次（不淘汰），回包带 `scanning: true` */
export const SUMMARY_STALE_MS = 60 * 1000;

export const INDEX_FILE = 'usage.json';
export const STORAGE_DIR = '.storage';
export const SETTINGS_FILE = 'storage.json';
const INDEX_VERSION = 1;

const KEY = /^[0-9a-f]{64}$/;
/** 帧库根下「族目录/键」形状的族 */
export const FAMILIES = ['controls-html', 'controls', 'streams', 'tracks'];
const LOCAL = 'controls-local';

/* ======================================================================== *
 * 键目录的形状
 * ======================================================================== */

/**
 * 认一个相对路径（斜杠分隔）：回 `{ rel, family, key, unit }`，认不出回 null。
 * `family` 为 `entry`（整场景目录）、`controls-local` 或上面四个族之一；`unit` 是淘汰单元的 id。
 */
export function parseRel(rel) {
  if (typeof rel !== 'string') return null;
  const parts = rel.split('/');
  if (parts.length === 1 && KEY.test(parts[0])) return { rel, family: 'entry', key: parts[0], unit: `entry:${parts[0]}` };
  if (parts.length !== 2 || !KEY.test(parts[1])) return null;
  if (parts[0] === LOCAL) return { rel, family: LOCAL, key: parts[1], unit: `entry:${parts[1]}` };
  if (FAMILIES.includes(parts[0])) return { rel, family: parts[0], key: parts[1], unit: rel };
  return null;
}

/** 相对路径在盘上的位置（先过 `parseRel`，认不出抛） */
export function relDir(root, rel) {
  const parsed = parseRel(rel);
  if (!parsed) throw new Error(`不认得的键目录:${rel}`);
  return parsed.family === 'entry' ? path.join(root, parsed.key) : path.join(root, parsed.family, parsed.key);
}

/** 帧库里一个文件或目录所属的键目录（相对路径）；不在认得的键目录里回 null */
export function relOfPath(root, file) {
  const parts = path.relative(path.resolve(root), path.resolve(file)).split(/[\\/]/);
  if (!parts.length || parts[0] === '..' || path.isAbsolute(parts[0])) return null;
  if (parseRel(parts[0])) return parts[0];
  return parts.length >= 2 ? (parseRel(`${parts[0]}/${parts[1]}`)?.rel ?? null) : null;
}

/** 一个整场景版本用到的键（`FramePipeline` 的 entry）：整场景、本地档、共享档、独立卡、轨道前缀、轨道流 */
export function entryUsageRels(pipeline, entry) {
  if (!entry?.key || !KEY.test(entry.key)) return [];
  const plan = Array.isArray(entry.cardPlan) ? entry.cardPlan : null;
  const producerStreams = pipeline?._streams?.streams;
  const streams = [];
  if (producerStreams instanceof Map) {
    for (const state of producerStreams.values()) {
      if (state?.entryKey === entry.key && typeof state?.spec?.streamKey === 'string') streams.push(state.spec.streamKey);
    }
  }
  // 同一个计划、同一组流不重算（轨道前缀要按轨道各算一次哈希）
  const cached = entry.__usageRels;
  const streamSig = streams.join(',');
  if (cached && cached.plan === plan && cached.streams === streamSig) return cached.rels;
  const rels = new Set([entry.key, `${LOCAL}/${entry.key}`]);
  for (const control of plan ?? []) {
    if (typeof control?.key === 'string') rels.add(`controls/${control.key}`);
    const tier = control?.tier || snapshotTier(control?.capabilities);
    if (tier === 'shared' && typeof control?.snapshotKey === 'string') rels.add(`controls-html/${control.snapshotKey}`);
  }
  let prefixes = entry.__usagePrefixes;
  if (!prefixes) {
    try { prefixes = (pipeline?.prefixes?.(entry) ?? []).map(prefix => prefix.key); } catch { prefixes = []; }
    entry.__usagePrefixes = prefixes;
  }
  for (const key of prefixes) rels.add(`tracks/${key}`);
  for (const key of streams) rels.add(`streams/${key}`);
  const out = [...rels].filter(rel => parseRel(rel));
  entry.__usageRels = { plan, streams: streamSig, rels: out };
  return out;
}

/** 此刻「开着」的整场景版本：就绪索引里有订阅者、或 `OPEN_SESSION_IDLE_MS` 内发过 preload 的会话的当前版本 */
export function openEntryKeys(pipeline, now = Date.now()) {
  const keys = new Set();
  let sessions = [];
  try { sessions = pipeline?.ready?.describe?.() ?? []; } catch { sessions = []; }
  for (const s of sessions) {
    if (!s?.entryKey) continue;
    if ((s.subscribers ?? 0) > 0 || now - (s.seenAt ?? 0) <= OPEN_SESSION_IDLE_MS) keys.add(s.entryKey);
  }
  for (const generation of pipeline?.generations?.values?.() ?? []) {
    if (generation?.key && !generation.controller?.signal?.aborted && now - (generation.seenAt ?? 0) <= OPEN_SESSION_IDLE_MS) keys.add(generation.key);
  }
  return keys;
}

/* ======================================================================== *
 * 上限
 * ======================================================================== */

/** 缺省上限：50 GB；磁盘总容量小于 500 GB 时取总容量的 10% */
export function defaultCapBytes(diskBytes) {
  return Number.isFinite(diskBytes) && diskBytes > 0 && diskBytes < SMALL_DISK_BYTES ? Math.floor(diskBytes * SMALL_DISK_RATIO) : DEFAULT_CAP_BYTES;
}

/** 用户可设的范围：`[minCap, 磁盘总容量]`（磁盘总容量量不到时上界不限） */
export function capRange(diskBytes, minCapBytes = MIN_CAP_BYTES) {
  return { min: minCapBytes, max: Number.isFinite(diskBytes) && diskBytes > 0 ? Math.max(minCapBytes, diskBytes) : Number.MAX_SAFE_INTEGER };
}

/** 用户设的值合法吗（整数字节，落在 `capRange` 里） */
export function validCap(bytes, diskBytes, minCapBytes = MIN_CAP_BYTES) {
  const { min, max } = capRange(diskBytes, minCapBytes);
  return Number.isSafeInteger(bytes) && bytes >= min && bytes <= max;
}

/** 此刻生效的上限：`storage.json` 里有合法的用户值就用它（越界的收进范围），否则缺省 */
export function resolveCap(settings, diskBytes, minCapBytes = MIN_CAP_BYTES) {
  const user = settings?.frameLibraryCapBytes;
  if (Number.isFinite(user) && user > 0) {
    const { min, max } = capRange(diskBytes, minCapBytes);
    return { capBytes: Math.floor(Math.min(max, Math.max(min, user))), capSource: 'user' };
  }
  return { capBytes: defaultCapBytes(diskBytes), capSource: 'default' };
}

/** 路径所在磁盘的总容量（字节）；路径还不存在就往上找到存在的那一级；量不到回 null */
export async function diskBytesOf(dir) {
  let current = path.resolve(dir);
  for (;;) {
    try {
      const stat = await fs.statfs(current);
      const total = Number(stat.blocks) * Number(stat.bsize);
      return Number.isFinite(total) && total > 0 ? total : null;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  }
}

/** 数据目录（`storage.json` 所在）：`PROMPTCUT_DATA_DIR`，缺省 `<viteRoot>/out`，和 `costs-store.mjs` 同一口径 */
export function storageDataDir(viteRoot, env = process.env) {
  return env.PROMPTCUT_DATA_DIR || path.join(viteRoot, 'out');
}

export async function readStorageSettings(dataDir) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(dataDir, SETTINGS_FILE), 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export async function writeStorageSettings(dataDir, patch) {
  const next = { ...(await readStorageSettings(dataDir)), ...patch };
  await fs.mkdir(dataDir, { recursive: true });
  await atomicWrite(path.join(dataDir, SETTINGS_FILE), JSON.stringify(next, null, 2));
  return next;
}

/* ======================================================================== *
 * 盘上的小工具
 * ======================================================================== */

/** 先写临时文件再改名；目标正被别人读着（Windows 的 EPERM / EBUSY）时退避重试几次 */
export async function atomicWrite(file, text) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(temp, text);
  for (let attempt = 0; ; attempt++) {
    try { await fs.rename(temp, file); return; }
    catch (error) {
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)) {
        await fs.rm(temp, { force: true }).catch(() => {});
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}

/** 这个 pid 还活着吗（同一台机器上） */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

/**
 * 量一个目录：总字节、最新修改时刻、里面有没有链接、其中遗留文件（计划第 3.3 节「遗留文件」那几种）的字节。
 * 遗留按名字认，规则与启动清理同一套（`storage-leftovers.mjs` 的 `leftoverFileKind`、`isDeadSpillDir`），
 * 进程死活也用那边偏保守的判法（拿不准按活）。碰到链接不进去。目录不存在回 `{ missing: true }`。
 */
export async function measureDir(dir, { now = Date.now(), alive = leftoverPidAlive, concurrency = 8 } = {}) {
  let bytes = 0, newest = 0, leftover = 0, linked = false, files = 0;
  let top;
  try { top = await fs.lstat(dir); } catch { return { missing: true, bytes: 0, newest: 0, leftover: 0, linked: false, files: 0 }; }
  if (top.isSymbolicLink()) return { missing: false, bytes: 0, newest: top.mtimeMs, leftover: 0, linked: true, files: 0 };
  if (!top.isDirectory()) return { missing: false, bytes: top.size, newest: top.mtimeMs, leftover: 0, linked: false, files: 1 };
  newest = top.mtimeMs;
  const queue = [{ dir, stale: false }];
  const pidCache = new Map();
  const dead = pid => { if (!pidCache.has(pid)) pidCache.set(pid, !alive(pid)); return pidCache.get(pid); };
  const visit = async ({ dir: current, stale }) => {
    let names;
    try { names = await fs.readdir(current); } catch { return; }
    for (const name of names) {
      const full = path.join(current, name);
      let stat;
      try { stat = await fs.lstat(full); } catch { continue; }
      if (stat.isSymbolicLink()) { linked = true; continue; }
      newest = Math.max(newest, stat.mtimeMs);
      if (stat.isDirectory()) {
        queue.push({ dir: full, stale: stale || (path.basename(current) === 'html-cache' && isDeadSpillDir(name, dead)) });
        continue;
      }
      files++;
      bytes += stat.size;
      if (stale || leftoverFileKind(name, { dead, ageMs: now - stat.mtimeMs })) leftover += stat.size;
    }
  };
  let active = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    for (;;) {
      const next = queue.shift();
      if (!next) {
        // 别的 worker 可能还在往队列里放：等一拍再看
        if (active === 0) return;
        await new Promise(resolve => setImmediate(resolve));
        continue;
      }
      active++;
      try { await visit(next); } finally { active--; }
    }
  });
  await Promise.all(workers);
  return { missing: false, bytes, newest, leftover, linked, files };
}

async function listDirNames(dir) {
  try { return (await fs.readdir(dir, { withFileTypes: true })).filter(item => item.isDirectory() && !item.isSymbolicLink()).map(item => item.name); }
  catch { return []; }
}

/** 列出帧库根下全部认得的键目录（只读目录名，不进去）。族目录本身是链接的整族跳过。 */
export async function listRels(root) {
  const rels = [];
  for (const name of await listDirNames(root)) if (KEY.test(name)) rels.push(name);
  for (const family of [LOCAL, ...FAMILIES]) {
    const dir = path.join(root, family);
    try { if ((await fs.lstat(dir)).isSymbolicLink()) continue; } catch { continue; }
    for (const name of await listDirNames(dir)) if (KEY.test(name)) rels.push(`${family}/${name}`);
  }
  return rels;
}

/* ======================================================================== *
 * 管理器
 * ======================================================================== */

/**
 * @param {object} options
 * @param {string} options.root        帧库目录
 * @param {string} options.dataDir     `storage.json` 所在的数据目录
 * @param {() => number} [options.now]
 * @param {number} [options.minCapBytes]   用户可设的下限（测试与探针调小，见 `vite-plugin-frames.ts` 的 `PROMPTCUT_TEST_STORAGE_MIN_CAP`）
 * @param {boolean} [options.evict]    false = 只记、只量，不淘汰（`PROMPTCUT_STORAGE_EVICT=0`）
 * @param {boolean} [options.timers]   false = 不起节拍（单测手动调）
 */
export function createFrameLibraryStorage({ root, dataDir, now = () => Date.now(), minCapBytes = MIN_CAP_BYTES, evict = true, timers = true,
  tickMs = TICK_MS, protectMs = PROTECT_MS, clearKeepMs = CLEAR_KEEP_MS, calibrateMs = CALIBRATE_MS, flushMs = FLUSH_MS,
  heartbeatMs = HEARTBEAT_MS, lockStaleMs = LOCK_STALE_MS, startupGraceMs = STARTUP_GRACE_MS, pid = process.pid, alive: aliveOpt, log = () => {},
  sweepLeftovers } = {}) {
  root = path.resolve(root);
  // 主进程锁按「拿不准算死」接管（本模块的 `pidAlive`）；遗留文件按「拿不准算活」不删（`storage-leftovers.mjs`）。测试注入的一个管两处
  const alive = aliveOpt ?? pidAlive;
  const leftoverAlive = aliveOpt ?? leftoverPidAlive;
  // 遗留清理与启动清理一样只对真正的帧库根（`<导出目录>/frame-library`）动手；`PROMPTCUT_STORAGE_EVICT=0` 时照清
  const sweeping = sweepLeftovers ?? path.basename(root) === 'frame-library';
  const storageDir = path.join(root, STORAGE_DIR);
  const indexFile = path.join(root, INDEX_FILE);
  const ownerFile = path.join(storageDir, 'owner.json');
  const touchDir = path.join(storageDir, 'touch');
  const trashDir = path.join(storageDir, 'trash');
  const ownTouchFile = path.join(touchDir, `${pid}.json`);

  /** rel -> { at, bytes, leftover, measuredAt } */
  let keys = new Map();
  /** 记过使用、还没重量的键 */
  const dirty = new Set();
  /** 本进程记的使用（不是主进程时写进自己的 touch 文件） */
  const ownTouches = new Map();
  let owner = false;
  let loaded = false;
  let indexDirty = false, touchDirty = false;
  let scannedAt = null, calibratedAt = null, lastEvict = null, lastEvictDetail = null, lastCheckAt = 0;
  /** 上一次清遗留（诊断用，?detail=1 里带） */
  let lastLeftoverSweep = null;
  let scanning = null;
  /** `refreshIfStale` 发起的后台量（只量不淘汰）；上一次量完的时刻 */
  let measuring = null, lastMeasureAt = 0;
  let chain = Promise.resolve();
  let pipeline = null;
  let closed = false;
  const handles = [];
  let started = null;

  const serial = work => {
    const run = chain.then(work, work);
    chain = run.catch(() => {});
    return run;
  };

  /* ---------------- 主进程锁 ---------------- */

  async function readOwner() {
    try { return JSON.parse(await fs.readFile(ownerFile, 'utf8')); } catch { return null; }
  }
  async function tryOwn() {
    if (closed) return false;
    await fs.mkdir(storageDir, { recursive: true });
    const mine = JSON.stringify({ pid, at: now() });
    try {
      await fs.writeFile(ownerFile, mine, { flag: 'wx' });
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
    }
    const current = await readOwner();
    if (current?.pid === pid) { await atomicWrite(ownerFile, mine).catch(() => {}); return true; }
    const stale = !current || !alive(current.pid) || !(now() - Number(current.at) <= lockStaleMs);
    if (!stale) return false;
    await atomicWrite(ownerFile, mine).catch(() => {});
    // 两个进程同时接管：各写各的，稍等再读，留下的那个赢
    await new Promise(resolve => setTimeout(resolve, 30));
    return (await readOwner())?.pid === pid;
  }
  async function heartbeat() {
    if (!owner || closed) return;
    const current = await readOwner();
    if (current && current.pid !== pid) { owner = false; log('storage.owner-lost', { by: current.pid }); return; }
    await atomicWrite(ownerFile, JSON.stringify({ pid, at: now() })).catch(() => {});
  }
  async function becomeOwner() {
    if (owner) return true;
    if (!(await tryOwn())) return false;
    owner = true;
    log('storage.owner', { pid });
    // 从前一个主进程写下的索引接着来；本进程此前记的使用并进去
    await loadIndex();
    for (const [rel, at] of ownTouches) noteUse(rel, at);
    await fs.rm(ownTouchFile, { force: true }).catch(() => {});
    return true;
  }

  /* ---------------- 索引 ---------------- */

  async function loadIndex() {
    let doc = null;
    try { doc = JSON.parse(await fs.readFile(indexFile, 'utf8')); } catch { doc = null; }
    if (!doc || doc.version !== INDEX_VERSION || !doc.keys || typeof doc.keys !== 'object') { loaded = false; keys = new Map(); return false; }
    const next = new Map();
    for (const [rel, row] of Object.entries(doc.keys)) {
      if (!parseRel(rel) || !Array.isArray(row)) continue;
      const [at, bytes, leftover, measuredAt] = row.map(Number);
      next.set(rel, { at: Number.isFinite(at) ? at : 0, bytes: Number.isFinite(bytes) ? bytes : null, leftover: Number.isFinite(leftover) ? leftover : 0, measuredAt: Number.isFinite(measuredAt) ? measuredAt : 0 });
    }
    keys = next;
    scannedAt = Number.isFinite(doc.scannedAt) ? doc.scannedAt : null;
    calibratedAt = Number.isFinite(doc.calibratedAt) ? doc.calibratedAt : scannedAt;
    lastEvict = doc.lastEvict && typeof doc.lastEvict === 'object' ? doc.lastEvict : null;
    loaded = true;
    return true;
  }
  async function saveIndex() {
    if (!owner || closed && !indexDirty) return;
    const doc = { version: INDEX_VERSION, savedAt: now(), scannedAt, calibratedAt, lastEvict,
      keys: Object.fromEntries([...keys].map(([rel, row]) => [rel, [Math.round(row.at), row.bytes ?? -1, row.leftover ?? 0, Math.round(row.measuredAt ?? 0)]])) };
    indexDirty = false;
    await fs.mkdir(root, { recursive: true });
    await atomicWrite(indexFile, JSON.stringify(doc));
  }
  async function saveTouches() {
    if (owner) return;
    touchDirty = false;
    const cutoff = now() - Math.max(calibrateMs, protectMs * 2);
    for (const [rel, at] of ownTouches) if (at < cutoff) ownTouches.delete(rel);
    await fs.mkdir(touchDir, { recursive: true });
    await atomicWrite(ownTouchFile, JSON.stringify({ pid, at: now(), keys: Object.fromEntries(ownTouches) }));
  }
  async function flush() {
    if (owner) { if (indexDirty) await saveIndex(); }
    else if (touchDirty) await saveTouches();
  }

  function noteUse(rel, at) {
    let row = keys.get(rel);
    if (!row) { row = { at: 0, bytes: null, leftover: 0, measuredAt: 0 }; keys.set(rel, row); }
    if (at > row.at) row.at = at;
    dirty.add(rel);
    indexDirty = true;
  }

  /** 并进别的进程记的使用；pid 不在了的文件并完就删 */
  async function mergePeerTouches() {
    let names = [];
    try { names = await fs.readdir(touchDir); } catch { return 0; }
    let merged = 0;
    for (const name of names) {
      const match = /^(\d+)\.json$/.exec(name);
      if (!match) continue;
      const file = path.join(touchDir, name);
      const peer = Number(match[1]);
      let doc = null;
      try { doc = JSON.parse(await fs.readFile(file, 'utf8')); } catch { doc = null; }
      for (const [rel, at] of Object.entries(doc?.keys ?? {})) {
        if (!parseRel(rel) || !Number.isFinite(at)) continue;
        const row = keys.get(rel);
        if (!row || at > row.at) { noteUse(rel, at); merged++; }
      }
      if (peer !== pid && !alive(peer)) await fs.rm(file, { force: true }).catch(() => {});
    }
    return merged;
  }

  /** 量一个键，写回索引；没有使用记录的最近使用时刻按最新文件的修改时刻兜底 */
  async function measureRel(rel, { concurrency = 8 } = {}) {
    const result = await measureDir(relDir(root, rel), { now: now(), alive: leftoverAlive, concurrency });
    if (result.missing) { keys.delete(rel); dirty.delete(rel); indexDirty = true; return null; }
    let row = keys.get(rel);
    if (!row) { row = { at: 0, bytes: null, leftover: 0, measuredAt: 0 }; keys.set(rel, row); }
    row.bytes = result.bytes;
    row.leftover = result.leftover;
    row.linked = result.linked;
    row.measuredAt = now();
    if (!(row.at > 0)) row.at = result.newest;
    dirty.delete(rel);
    indexDirty = true;
    return row;
  }

  /** 全量重扫（索引缺失、读不懂，或周期性校正）。`keep` = 保留已有的最近使用时刻 */
  function rescan(reason) {
    if (scanning) return scanning;
    const started_ = now();
    log('storage.rescan', { reason });
    scanning = (async () => {
      const rels = await listRels(root);
      const seen = new Set(rels);
      for (const rel of [...keys.keys()]) if (!seen.has(rel)) keys.delete(rel);
      let i = 0;
      const next = () => rels[i++];
      await Promise.all(Array.from({ length: 4 }, async () => {
        for (let rel = next(); rel; rel = next()) { if (closed) return; try { await measureRel(rel, { concurrency: 4 }); } catch { /* 下一轮再量 */ } }
      }));
      scannedAt = calibratedAt = now();
      loaded = true;
      indexDirty = true;
      log('storage.rescan-done', { reason, keys: keys.size, ms: now() - started_ });
      await saveIndex().catch(() => {});
    })().finally(() => { scanning = null; });
    return scanning;
  }

  /** 增量：列一遍目录名，新出现的量一次、消失的删掉；记过使用的重量 */
  async function refresh() {
    const rels = await listRels(root);
    const seen = new Set(rels);
    for (const rel of [...keys.keys()]) if (!seen.has(rel)) { keys.delete(rel); dirty.delete(rel); indexDirty = true; }
    for (const rel of rels) {
      const row = keys.get(rel);
      if (!row || row.bytes === null || dirty.has(rel)) { try { await measureRel(rel); } catch { /* 下一轮 */ } }
    }
  }

  /* ---------------- 单元、保护、淘汰 ---------------- */

  function pinnedRels(at = now()) {
    const pinned = new Set();
    if (!pipeline) return pinned;
    for (const entryKey of openEntryKeys(pipeline, at)) {
      pinned.add(entryKey); pinned.add(`${LOCAL}/${entryKey}`);
      const entry = pipeline.entries?.get?.(entryKey);
      if (entry) for (const rel of entryUsageRels(pipeline, entry)) pinned.add(rel);
    }
    return pinned;
  }

  /** 按淘汰单元汇总：`[{ unit, rels, at, bytes, leftover, linked, protected }]` */
  function units(at = now(), keepMs = protectMs) {
    const pinned = pinnedRels(at);
    const byUnit = new Map();
    for (const [rel, row] of keys) {
      const parsed = parseRel(rel);
      if (!parsed) continue;
      let unit = byUnit.get(parsed.unit);
      if (!unit) { unit = { unit: parsed.unit, rels: [], at: 0, bytes: 0, leftover: 0, linked: false, pinned: false }; byUnit.set(parsed.unit, unit); }
      unit.rels.push(rel);
      unit.at = Math.max(unit.at, row.at || 0);
      unit.bytes += row.bytes ?? 0;
      unit.leftover += row.leftover ?? 0;
      if (row.linked) unit.linked = true;
      if (pinned.has(rel)) unit.pinned = true;
    }
    for (const unit of byUnit.values()) {
      unit.protected = unit.pinned || at - unit.at < keepMs;
      // 整场景目录先删（它最大，也最可能被打开）
      unit.rels.sort((a, b) => parseRel(a).family === 'entry' ? -1 : parseRel(b).family === 'entry' ? 1 : 0);
    }
    return [...byUnit.values()];
  }

  const totals = () => {
    let bytes = 0, leftover = 0;
    for (const row of keys.values()) { bytes += row.bytes ?? 0; leftover += row.leftover ?? 0; }
    return { bytes, leftover };
  };

  /**
   * 清遗留文件（计划第 3.3 节「启动时与每次淘汰时一并清掉」；删哪些见 `storage-leftovers.mjs` 的 `sweepFrameLibrary`）。
   * 删过东西的键目录记为要重量，接着的 `refresh()` 量完，`leftovers.bytes` 就是清完之后的数。
   */
  async function sweepLeftoverFiles() {
    if (!sweeping) return null;
    let report;
    try { report = await sweepFrameLibrary(root, { alive: leftoverAlive, now: now() }); }
    catch (error) { log('storage.leftovers-failed', { message: String(error?.message ?? error) }); return null; }
    for (const item of report.removed) {
      const rel = relOfPath(root, item.path);
      if (rel && keys.has(rel)) { dirty.add(rel); indexDirty = true; }
    }
    lastLeftoverSweep = { at: now(), removed: report.removed.length, bytes: report.bytes, skipped: report.skipped.length };
    if (report.removed.length || report.skipped.length) {
      log('storage.leftovers', { removed: report.removed.length, bytes: report.bytes, skipped: report.skipped.length });
    }
    return report;
  }

  /** 清掉垃圾目录（上一轮改了名没删完的） */
  async function sweepTrash() {
    let names = [];
    try { names = await fs.readdir(trashDir); } catch { return; }
    for (const name of names) await fs.rm(path.join(trashDir, name), { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }

  /** 删一个单元：先改名进垃圾目录（有文件被打开就失败 = 跳过），再删 */
  async function removeUnit(unit) {
    const moved = [];
    let skipped = null;
    for (const rel of unit.rels) {
      const parsed = parseRel(rel);
      const dir = relDir(root, rel);
      try {
        if (parsed.family !== 'entry') {
          const familyStat = await fs.lstat(path.join(root, parsed.family));
          if (familyStat.isSymbolicLink() || !familyStat.isDirectory()) { skipped = 'link'; break; }
        }
        const stat = await fs.lstat(dir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) { skipped = 'link'; break; }
      } catch (error) {
        if (error?.code === 'ENOENT') { keys.delete(rel); indexDirty = true; continue; }
        skipped = 'error'; break;
      }
      await fs.mkdir(trashDir, { recursive: true });
      const target = path.join(trashDir, `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`);
      try {
        await fs.rename(dir, target);
        moved.push({ rel, target });
      } catch (error) {
        if (error?.code === 'ENOENT') { keys.delete(rel); indexDirty = true; continue; }
        // EBUSY / EPERM / EACCES:目录里有文件被别的进程（或本进程）打开着
        skipped = ['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'].includes(error?.code) ? 'busy' : 'error';
        break;
      }
    }
    let freed = 0;
    for (const { rel, target } of moved) {
      freed += keys.get(rel)?.bytes ?? 0;
      keys.delete(rel); dirty.delete(rel); indexDirty = true;
      await fs.rm(target, { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
    }
    return { freed, moved: moved.map(item => item.rel), skipped };
  }

  /** 删掉本进程内存里还指着被删目录的东西（整场景 entry、就绪索引挂着的键、流清单缓存） */
  function forget(rels) {
    if (!pipeline || !rels.length) return;
    for (const rel of rels) {
      const parsed = parseRel(rel);
      if (!parsed) continue;
      try {
        if (parsed.family === 'entry') {
          for (const [ownerId, generation] of pipeline.generations ?? []) {
            if (generation?.key === parsed.key) { generation.controller?.abort?.(); pipeline.generations.delete(ownerId); }
          }
          const entry = pipeline.entries?.get?.(parsed.key);
          if (entry) { pipeline.entries.delete(parsed.key); try { entry.disposeArchive?.(); } catch { /* 目录已经没了 */ } }
        } else if (parsed.family === LOCAL) {
          pipeline.ready?.unstage?.({ kind: 'local', prefix: `${parsed.key}/` });
        } else if (parsed.family === 'controls-html') {
          pipeline.ready?.unstage?.({ kind: 'html', key: parsed.key });
        } else if (parsed.family === 'streams') {
          pipeline.ready?.unstage?.({ kind: 'stream', key: parsed.key });
          pipeline._streams?.store?.manifests?.delete?.(parsed.key);
        }
      } catch { /* 尽力而为 */ }
    }
  }

  /**
   * 删单元直到总量不超过 `targetBytes`（`targetBytes === null` = 删光全部候选）。
   * 候选：不受保护、没有链接；按最近使用时刻从旧到新。
   */
  async function evictTo(targetBytes, { keepMs = protectMs, reason = 'cap' } = {}) {
    const at = now();
    const candidates = units(at, keepMs).filter(unit => !unit.protected).sort((a, b) => a.at - b.at);
    let total = totals().bytes;
    const before = total;
    let freedBytes = 0, removed = 0, skipped = 0;
    const removedUnits = [], skippedUnits = [];
    for (const unit of candidates) {
      if (targetBytes !== null && total <= targetBytes) break;
      if (closed) break;
      if (unit.linked) { skipped++; skippedUnits.push({ unit: unit.unit, reason: 'link' }); continue; }
      const result = await removeUnit(unit);
      if (result.moved.length) {
        forget(result.moved);
        freedBytes += result.freed; total -= result.freed;
      }
      if (result.skipped) { skipped++; skippedUnits.push({ unit: unit.unit, reason: result.skipped, moved: result.moved }); }
      else { removed++; removedUnits.push({ unit: unit.unit, at: unit.at, bytes: result.freed }); }
    }
    lastEvict = { at, freedBytes, removed, skipped, reason };
    lastEvictDetail = { ...lastEvict, before, after: total, targetBytes, removedUnits, skippedUnits };
    indexDirty = true;
    if (removed || skipped) log('storage.evict', { reason, freedBytes, removed, skipped, total });
    await saveIndex().catch(() => {});
    return { freedBytes, removed, skipped, removedUnits, skippedUnits };
  }

  async function cap() {
    const diskBytes = await diskBytesOf(root);
    const settings = await readStorageSettings(dataDir);
    return { diskBytes, ...resolveCap(settings, diskBytes, minCapBytes) };
  }

  /** 只量不淘汰（`refreshIfStale`）：并进别的进程的使用、清遗留、增量量 */
  async function measureNow() {
    if (closed) return null;
    if (!(await becomeOwner())) { await saveTouches().catch(() => {}); return { owner: false }; }
    if (!loaded) await rescan('missing-index');
    await sweepLeftoverFiles();
    await mergePeerTouches();
    await refresh();
    await flush().catch(() => {});
    return { bytes: totals().bytes };
  }

  /** 一次检查：并进别的进程的使用、增量量、超上限就淘汰。`force` 不受节拍限制 */
  async function checkNow({ force = false } = {}) {
    if (closed) return null;
    if (!force && now() - lastCheckAt < tickMs) return { skipped: 'rate' };
    lastCheckAt = now();
    if (!(await becomeOwner())) { await saveTouches().catch(() => {}); return { owner: false }; }
    if (!loaded) await rescan('missing-index');
    else if (!Number.isFinite(calibratedAt) || now() - calibratedAt > calibrateMs) await rescan('calibrate');
    await sweepTrash();
    await sweepLeftoverFiles();
    await mergePeerTouches();
    await refresh();
    const { capBytes } = await cap();
    const { bytes } = totals();
    let result = { bytes, capBytes, evicted: null };
    if (evict && bytes > capBytes) result.evicted = await evictTo(Math.floor(capBytes * EVICT_TARGET_RATIO), { reason: 'cap' });
    await flush().catch(() => {});
    return result;
  }

  /* ---------------- 节拍 ---------------- */

  function touchOpen() {
    if (!pipeline) return;
    const at = now();
    for (const entryKey of openEntryKeys(pipeline, at)) {
      const entry = pipeline.entries?.get?.(entryKey);
      api.touch(entry ? entryUsageRels(pipeline, entry) : [entryKey, `${LOCAL}/${entryKey}`], at);
    }
  }

  const api = {
    root, dataDir,
    get owner() { return owner; },
    get scanning() { return !!scanning; },
    /** 把管线接上：管线在预加载时调 `usage.touchEntry`，本模块按它的会话判「开着」 */
    attachPipeline(p) { pipeline = p; if (p) p.usage = api; return api; },
    start() {
      if (started) return started;
      started = serial(() => becomeOwner()).then(() => {
        // 索引缺失:马上开始重扫(只量不删);第一次判淘汰等 `startupGraceMs`,让页面重连、重发 preload,
        // 正在打开的项目先记上使用 —— 不然用户昨天开着的项目可能在它的 preload 到达之前就被判成最久没用的
        if (owner && !loaded) void api.rescan('missing-index').catch(() => {});
        if (!timers) { void api.check({ force: true }).catch(() => {}); return; }
        const first = setTimeout(() => { void api.check({ force: true }).catch(() => {}); }, startupGraceMs);
        first.unref?.();
        handles.push(first);
      });
      if (timers) {
        const tick = setInterval(() => { touchOpen(); void api.check().catch(() => {}); }, tickMs);
        const beat = setInterval(() => { void heartbeat().catch(() => {}); }, heartbeatMs);
        const save = setInterval(() => { void flush().catch(() => {}); }, flushMs);
        for (const handle of [tick, beat, save]) { handle.unref?.(); handles.push(handle); }
      }
      return started;
    },
    /** 记使用（相对路径）。不落盘，由节拍或检查落 */
    touch(rels, at = now()) {
      for (const rel of rels ?? []) {
        if (!parseRel(rel)) continue;
        ownTouches.set(rel, Math.max(ownTouches.get(rel) ?? 0, at));
        touchDirty = true;
        if (owner) noteUse(rel, at);
      }
    },
    /** 一个整场景版本（`FramePipeline` 的 entry）用到的键一起记为使用 */
    touchEntry(entry, at = now()) {
      try { api.touch(entryUsageRels(pipeline, entry), at); } catch { /* 记不上不挡预渲染 */ }
    },
    /** 预加载或预渲染一批做完后：到节拍了就检查一次 */
    afterBatch() {
      if (now() - lastCheckAt < tickMs) return;
      void api.check().catch(() => {});
    },
    check(options) { return serial(() => checkNow(options)); },
    /**
     * 占用数字过期了就在后台量一次：上一次检查或量早于 `maxAgeMs` 时，并进别的进程的使用、清遗留、
     * 增量量（与检查相同），但**不淘汰**、也不动淘汰检查的节拍（启动宽限、每 5 分钟最多一次照旧）。
     * 不等量完就返回：回 true 表示此刻有一趟在量（`summary().scanning` 为 true）。
     */
    refreshIfStale({ maxAgeMs = SUMMARY_STALE_MS } = {}) {
      if (closed) return false;
      if (measuring) return true;
      if (now() - Math.max(lastCheckAt, lastMeasureAt) <= maxAgeMs) return false;
      lastMeasureAt = now();
      measuring = serial(() => measureNow()).catch(() => {}).finally(() => { measuring = null; lastMeasureAt = now(); });
      return true;
    },
    /** 全量重扫（诊断、测试） */
    rescan(reason = 'manual') { return serial(() => rescan(reason)); },
    async summary({ detail = false } = {}) {
      const at = now();
      const { diskBytes, capBytes, capSource } = await cap();
      const all = units(at);
      const { bytes, leftover } = totals();
      const out = {
        bytes, capBytes, capSource, diskBytes, minCapBytes,
        pinnedBytes: all.filter(unit => unit.protected).reduce((sum, unit) => sum + unit.bytes, 0),
        scannedAt, lastEvict, scanning: !!scanning || !!measuring, owner, leftoverBytes: leftover,
      };
      if (detail) {
        out.lastEvictDetail = lastEvictDetail;
        out.lastLeftoverSweep = lastLeftoverSweep;
        out.units = all.sort((a, b) => a.at - b.at).map(unit => ({ unit: unit.unit, rels: unit.rels, at: unit.at, bytes: unit.bytes, leftover: unit.leftover, pinned: unit.pinned, protected: unit.protected, linked: unit.linked }));
      }
      return out;
    },
    /** 设上限（`bytes` 须过 `validCap`），设完立即判一次（不等淘汰做完） */
    async setCap(bytes) {
      const diskBytes = await diskBytesOf(root);
      if (!validCap(bytes, diskBytes, minCapBytes)) {
        const range = capRange(diskBytes, minCapBytes);
        throw Object.assign(new Error(`上限要在 ${range.min} 到 ${range.max} 字节之间`), { code: 'CAP_OUT_OF_RANGE', status: 400, min: range.min, max: range.max });
      }
      if (!owner && !(await serial(() => becomeOwner()))) throw Object.assign(new Error('另一个 PromptCut 进程正在管理这个帧库'), { code: 'STORAGE_NOT_OWNER', status: 409 });
      await writeStorageSettings(dataDir, { frameLibraryCapBytes: bytes });
      const pending = api.check({ force: true });
      pending.catch(() => {});
      return { capBytes: bytes, pending };
    },
    /** 清理缓存：删 `clearKeepMs` 内没用过的全部单元（正在打开的项目不删） */
    clearCache() {
      return serial(async () => {
        if (!(await becomeOwner())) throw Object.assign(new Error('另一个 PromptCut 进程正在管理这个帧库'), { code: 'STORAGE_NOT_OWNER', status: 409 });
        if (!loaded) await rescan('missing-index');
        await sweepTrash();
        await sweepLeftoverFiles();
        await mergePeerTouches();
        await refresh();
        const result = await evictTo(null, { keepMs: clearKeepMs, reason: 'clear' });
        await flush().catch(() => {});
        return result;
      });
    },
    /** 测试用：此刻的索引 */
    snapshot: () => Object.fromEntries([...keys].map(([rel, row]) => [rel, { ...row }])),
    flush: () => serial(() => flush()),
    async close() {
      if (closed) return;
      for (const handle of handles.splice(0)) clearInterval(handle);
      await serial(async () => {
        await flush().catch(() => {});
        closed = true;
        if (owner && (await readOwner())?.pid === pid) await fs.rm(ownerFile, { force: true }).catch(() => {});
      });
      await scanning?.catch(() => {});
    },
  };
  return api;
}

/* ======================================================================== *
 * 每个帧库一个（按目录）
 * ======================================================================== */

const managers = new Map();

/** 这个帧库的管理器（没有就建、起节拍） */
export function storageFor({ root, dataDir, ...options }) {
  const key = path.resolve(root);
  let manager = managers.get(key);
  if (!manager) {
    manager = createFrameLibraryStorage({ root: key, dataDir, ...options });
    managers.set(key, manager);
    void manager.start();
  }
  return manager;
}

/** 关掉并忘掉这个帧库的管理器（dev server 关闭时） */
export async function closeStorage(root) {
  const key = path.resolve(root);
  const manager = managers.get(key);
  managers.delete(key);
  await manager?.close();
}

/* ======================================================================== *
 * 导出产物的汇总（`GET /api/storage` 的 `exports`）
 * ======================================================================== */

/**
 * 带缓存的导出汇总：`maxAgeMs` 内复用；过期先回旧值、后台刷新（第一次要等）。
 * 认目录、算中间文件直接用导出列表那一支的 `summarizeExports`（`exports-list.mjs`，规则定义在 `storage-leftovers.mjs`），
 * 与 `GET /api/exports` 的列表同一套：只认 `export-YYYYMMDD-HHMMSS[-n]` 的真目录、不含 `export-vision-*`、不跟链接。
 */
export function createExportSummary(exportDir, { maxAgeMs = 60_000, now = () => Date.now(), summarize = summarizeExports } = {}) {
  let value = null, valueSig = null, at = 0, pending = null;
  const refresh = () => (pending ||= (async () => {
    const sig = await exportDirSignature(exportDir);
    const result = await summarize(exportDir);
    value = result; valueSig = sig; at = now();
    return result;
  })().finally(() => { pending = null; }));
  return {
    async get({ fresh = false } = {}) {
      if (!value || fresh) return refresh();
      // 导出列表那边(编辑器进程)删了一份、只删了中间文件、或新导出了一份:顶层目录的名字或修改时刻变了,马上重算,
      // 不回 60 秒前的旧数(只看顶层,很便宜)
      if ((await exportDirSignature(exportDir)) !== valueSig) return refresh();
      if (now() - at > maxAgeMs) void refresh().catch(() => {});
      return value;
    },
  };
}

/** 导出目录下各份导出(名字认得的真目录)的名字与修改时刻,串成一个签名 */
async function exportDirSignature(exportDir) {
  let items = [];
  try { items = await fs.readdir(exportDir, { withFileTypes: true }); } catch { return ''; }
  const parts = [];
  for (const item of items) {
    if (!item.isDirectory() || !isExportDirName(item.name)) continue;
    try { parts.push(`${item.name}:${(await fs.lstat(path.join(exportDir, item.name))).mtimeMs}`); } catch { /* 刚没了 */ }
  }
  return parts.sort().join('|');
}
