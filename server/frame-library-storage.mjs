/**
 * Usage index, capacity limit, eviction by least recent use, and "Clear cache" for the frame store
 * (storage footprint plan Part B, `docs/plan/storage-plan.md` Sections 3.2 and 3.3).
 *
 * # Recognized key directories in the frame store (units of eviction and measurement)
 *
 *   <root>/<entryKey>                     Whole-scene directory
 *   <root>/controls-local/<entryKey>      Local tier snapshots for this whole scene (entire outer directory counted as one)
 *   <root>/controls-html/<key>            Shared tier snapshots
 *   <root>/controls/<key>                 Standalone card PNG / MOV
 *   <root>/streams/<key>                  Track streams
 *   <root>/tracks/<key>                   Track prefixes
 *
 * Keys are always 64-bit lowercase hexadecimal. Other names and other directories (`controls-lock`,
 * `push-queue.json`...) are ignored, uncounted, and never deleted. A whole-scene directory and its
 * `controls-local/<entryKey>` form a single eviction unit: evaluated together and deleted together.
 *
 * # Usage index `<root>/usage.json`
 *
 * Records `[last used time, byte count, leftover file bytes, measured time]` keyed by key directory
 * (slash-separated relative paths from the table above).
 *   - **Record usage**: When preload opens a version of a project, keys used by this version are
 *     recorded together (`touchEntry`, called by `FramePipeline`); while the project remains open,
 *     they are recorded again every `TICK_MS` (this module's tick, determining "open" by active
 *     sessions still alive in the ready index).
 *   - **Incremental byte-count maintenance**: Keys with recorded usage are remeasured at the next
 *     check (they are actively being written); the check lists family directories once (reading
 *     directory names only, without entering), measuring newly appeared keys once and removing
 *     vanished keys from the index. A full rescan is only performed when the index is missing,
 *     unreadable, or when `CALIBRATE_MS` has elapsed since the last full scan; it runs
 *     asynchronously without blocking preload.
 *   - If the index is lost (or on first run), directories are rescanned, taking the modification
 *     time of the newest file in the directory as the last used time.
 *
 * # Multi-process
 *
 * The editor process, prerender process, and prerender processes of headless instances (Skill) may
 * share a single frame store. **Only one process writes the index and performs eviction at any given
 * time**: it holds `<root>/.storage/owner.json` (pid + heartbeat; can be taken over if there is no
 * heartbeat for `LOCK_STALE_MS` or if the pid is gone). Other processes write their recorded usage
 * into `<root>/.storage/touch/<pid>.json` (written exclusively by itself); the main process merges
 * them into the index on each check, deleting files whose pid no longer exists after merging. The
 * editor process does not instantiate this module (its pipeline has `interactive: false` and rarely
 * writes to the frame store); directories with no recorded usage fall back to the modification time of
 * their newest file.
 *
 * # Eviction
 *
 * When total usage exceeds the capacity limit, units are deleted from oldest to newest by last used
 * time down to `EVICT_TARGET_RATIO` of the limit; units used within `PROTECT_MS` are not deleted, and
 * keys of currently open projects are not deleted. Deletion procedure: the directory is first
 * **renamed** into `<root>/.storage/trash/` (on Windows, renaming fails if any file in the directory
 * is open: on failure it is skipped and retried in the next round, preventing partial deletion), then
 * the trash directory is recursively deleted (any remaining items will continue being deleted in the
 * next round). If the key directory itself, its parent family directory, or anything inside the
 * directory is a symbolic link or junction, it is skipped entirely.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { snapshotTier } from './snapshot-tier.mjs';
import { isDeadSpillDir, isExportDirName, leftoverFileKind, pidAlive as leftoverPidAlive, sweepFrameLibrary } from './storage-leftovers.mjs';
import { summarizeExports } from './exports-list.mjs';

/**
 * Capacity GB is calculated as 1024³ bytes (aligned with "GB" shown in Windows Explorer and sizes in
 * the start page draft list): the default 50 GB, lower limit 5 GB, and the 500 GB in "10% if disk is
 * under 500 GB" all use this GB.
 */
export const GB = 1024 ** 3;
export const DEFAULT_CAP_BYTES = 50 * GB;
/** When total capacity of the disk is less than this, the default limit takes `SMALL_DISK_RATIO` of total capacity */
export const SMALL_DISK_BYTES = 500 * GB;
export const SMALL_DISK_RATIO = 0.1;
/** User-configurable lower limit; upper limit is total disk capacity */
export const MIN_CAP_BYTES = 5 * GB;
/** Ratio of the limit to delete down to when exceeding the limit */
export const EVICT_TARGET_RATIO = 0.9;
/** Items used within this window are not deleted */
export const PROTECT_MS = 30 * 60 * 1000;
/** "Clear cache" retains items used within this window */
export const CLEAR_KEEP_MS = 10 * 60 * 1000;
/** Tick interval to re-record usage for open projects and check whether to evict; checks are at most this frequent */
export const TICK_MS = 5 * 60 * 1000;
/** Waits this long after startup before evaluating eviction for the first time (page reconnects, resends preload, so opening projects record usage first) */
export const STARTUP_GRACE_MS = 2 * 60 * 1000;
/** Interval for full rescan to calibrate byte counts */
export const CALIBRATE_MS = 24 * 60 * 60 * 1000;
/** Main process heartbeat */
export const HEARTBEAT_MS = 60 * 1000;
/** Main process lock without a heartbeat for this long can be taken over */
export const LOCK_STALE_MS = 3 * 60 * 1000;
/** Debounce for persisting usage records to disk */
export const FLUSH_MS = 60 * 1000;
/** Sessions in the ready index without activity for this long and with no subscribers are no longer considered "open" */
export const OPEN_SESSION_IDLE_MS = 10 * 60 * 1000;
/** On `GET /api/storage`, if the last check (or measurement) was earlier than this duration, measure once in the background (no eviction) with `scanning: true` in the response */
export const SUMMARY_STALE_MS = 60 * 1000;

export const INDEX_FILE = 'usage.json';
export const STORAGE_DIR = '.storage';
export const SETTINGS_FILE = 'storage.json';
const INDEX_VERSION = 1;

const KEY = /^[0-9a-f]{64}$/;
/** Families shaped like "family-directory/key" under the frame store root */
export const FAMILIES = ['controls-html', 'controls', 'streams', 'tracks'];
const LOCAL = 'controls-local';

/* ======================================================================== *
 * Shape of key directories
 * ======================================================================== */

/**
 * Recognizes a relative path (slash-separated): returns `{ rel, family, key, unit }`, or null if
 * not recognized.
 * `family` is `entry` (whole-scene directory), `controls-local`, or one of the four families above;
 * `unit` is the eviction unit id.
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

/** Location of a relative path on disk (passes through `parseRel` first; throws if not recognized) */
export function relDir(root, rel) {
  const parsed = parseRel(rel);
  if (!parsed) throw new Error(`Unrecognized key directory: ${rel}`);
  return parsed.family === 'entry' ? path.join(root, parsed.key) : path.join(root, parsed.family, parsed.key);
}

/**
 * Key directory (relative path) of a file or directory in the frame store; returns null if not in
 * a recognized key directory
 */
export function relOfPath(root, file) {
  const parts = path.relative(path.resolve(root), path.resolve(file)).split(/[\\/]/);
  if (!parts.length || parts[0] === '..' || path.isAbsolute(parts[0])) return null;
  if (parseRel(parts[0])) return parts[0];
  return parts.length >= 2 ? (parseRel(`${parts[0]}/${parts[1]}`)?.rel ?? null) : null;
}

/**
 * Keys used by a whole-scene version (`FramePipeline` entry): whole scene, local tier, shared tier,
 * standalone card, track prefix, track stream
 */
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
  // Do not recompute for the same plan and group stream (track prefix hashes are computed per track)
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

/**
 * Currently "open" whole-scene versions: current versions with subscribers in ready index, or
 * sessions that sent preload within `OPEN_SESSION_IDLE_MS`
 */
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
 * Caps
 * ======================================================================== */

/** Default cap: 50 GB; uses 10% of total disk capacity when total capacity is under 500 GB */
export function defaultCapBytes(diskBytes) {
  return Number.isFinite(diskBytes) && diskBytes > 0 && diskBytes < SMALL_DISK_BYTES ? Math.floor(diskBytes * SMALL_DISK_RATIO) : DEFAULT_CAP_BYTES;
}

/**
 * User-configurable range: `[minCap, total disk capacity]` (no upper bound when total disk capacity
 * cannot be measured)
 */
export function capRange(diskBytes, minCapBytes = MIN_CAP_BYTES) {
  return { min: minCapBytes, max: Number.isFinite(diskBytes) && diskBytes > 0 ? Math.max(minCapBytes, diskBytes) : Number.MAX_SAFE_INTEGER };
}

/** Whether the user-configured value is valid (integer bytes, falling within `capRange`) */
export function validCap(bytes, diskBytes, minCapBytes = MIN_CAP_BYTES) {
  const { min, max } = capRange(diskBytes, minCapBytes);
  return Number.isSafeInteger(bytes) && bytes >= min && bytes <= max;
}

/**
 * Currently effective cap: uses valid user value from `storage.json` (clamped if out of bounds),
 * otherwise default
 */
export function resolveCap(settings, diskBytes, minCapBytes = MIN_CAP_BYTES) {
  const user = settings?.frameLibraryCapBytes;
  if (Number.isFinite(user) && user > 0) {
    const { min, max } = capRange(diskBytes, minCapBytes);
    return { capBytes: Math.floor(Math.min(max, Math.max(min, user))), capSource: 'user' };
  }
  return { capBytes: defaultCapBytes(diskBytes), capSource: 'default' };
}

/**
 * Total disk capacity where path resides (bytes); searches upward to an existing ancestor if path
 * does not exist yet; returns null if unmeasurable
 */
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

/**
 * Data directory (where `storage.json` resides): `PROMPTCUT_DATA_DIR`, default `<viteRoot>/out`,
 * aligned with `costs-store.mjs`
 */
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
 * Disk utilities
 * ======================================================================== */

/**
 * Writes temporary file first then renames; retries with backoff a few times if target is being
 * read by another process (Windows EPERM / EBUSY)
 */
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

/** Whether this pid is still alive (on the same machine) */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

/**
 * Measures a directory: total bytes, latest mtime, whether it contains links, and bytes of leftover
 * files (the kinds in Section 3.3 "Leftover files" of the plan).
 * Leftovers are recognized by name, using the same rules as startup cleanup (`leftoverFileKind`,
 * `isDeadSpillDir` in `storage-leftovers.mjs`), and process liveness also uses the more conservative
 * check from there (assumed alive if unsure). Does not enter links. Returns `{ missing: true }` if
 * directory does not exist.
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
        // Other workers may still be pushing to the queue: wait a tick and check again
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

/**
 * Lists all recognized key directories under frame store root (reads directory names only, does not
 * enter). Skips whole family if family directory itself is a link.
 */
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
 * Manager
 * ======================================================================== */

/**
 * @param {object} options
 * @param {string} options.root        Frame store directory
 * @param {string} options.dataDir     Data directory where `storage.json` resides
 * @param {() => number} [options.now]
 * @param {number} [options.minCapBytes]   User-configurable lower limit (reduced for tests and
 *   probes, see `PROMPTCUT_TEST_STORAGE_MIN_CAP` in `vite-plugin-frames.ts`)
 * @param {boolean} [options.evict]    false = record and measure only, do not evict
 *   (`PROMPTCUT_STORAGE_EVICT=0`)
 * @param {boolean} [options.timers]   false = do not start ticks (invoked manually in unit tests)
 */
export function createFrameLibraryStorage({ root, dataDir, now = () => Date.now(), minCapBytes = MIN_CAP_BYTES, evict = true, timers = true,
  tickMs = TICK_MS, protectMs = PROTECT_MS, clearKeepMs = CLEAR_KEEP_MS, calibrateMs = CALIBRATE_MS, flushMs = FLUSH_MS,
  heartbeatMs = HEARTBEAT_MS, lockStaleMs = LOCK_STALE_MS, startupGraceMs = STARTUP_GRACE_MS, pid = process.pid, alive: aliveOpt, log = () => {},
  sweepLeftovers } = {}) {
  root = path.resolve(root);
  // Lead process lock takes over assuming dead if unsure (`pidAlive` in this module); leftover files
  // are kept assuming alive if unsure (`storage-leftovers.mjs`). A single test-injected setting
  // controls both places.
  const alive = aliveOpt ?? pidAlive;
  const leftoverAlive = aliveOpt ?? leftoverPidAlive;
  // Like startup cleanup, leftover cleanup only operates on the real frame store root
  // (`<exportDir>/frame-library`); still cleans up when `PROMPTCUT_STORAGE_EVICT=0`
  const sweeping = sweepLeftovers ?? path.basename(root) === 'frame-library';
  const storageDir = path.join(root, STORAGE_DIR);
  const indexFile = path.join(root, INDEX_FILE);
  const ownerFile = path.join(storageDir, 'owner.json');
  const touchDir = path.join(storageDir, 'touch');
  const trashDir = path.join(storageDir, 'trash');
  const ownTouchFile = path.join(touchDir, `${pid}.json`);

  /** rel -> { at, bytes, leftover, measuredAt } */
  let keys = new Map();
  /** Keys that recorded usage and have not been remeasured yet */
  const dirty = new Set();
  /** Usage recorded by this process (written to its own touch file when not the lead process) */
  const ownTouches = new Map();
  let owner = false;
  let loaded = false;
  let indexDirty = false, touchDirty = false;
  let scannedAt = null, calibratedAt = null, lastEvict = null, lastEvictDetail = null, lastCheckAt = 0;
  /** Last leftover cleanup (for diagnostics, included in ?detail=1) */
  let lastLeftoverSweep = null;
  let scanning = null;
  /**
   * Background measurement initiated by `refreshIfStale` (measure only, no eviction); timestamp when
   * last completed
   */
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

  /* ---------------- Lead process lock ---------------- */

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
    // Two processes take over simultaneously: each writes its own, waits briefly, remaining one wins
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
    // Resumes from index written by previous lead process; merges in usage recorded by this process
    await loadIndex();
    for (const [rel, at] of ownTouches) noteUse(rel, at);
    await fs.rm(ownTouchFile, { force: true }).catch(() => {});
    return true;
  }

  /* ---------------- Index ---------------- */

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

  /** Merges in usage recorded by other processes; deletes files whose pid is gone after merging */
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

  /**
   * Measures a key and writes back to index; for keys without usage records, last used timestamp falls
   * back to latest file mtime
   */
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

  /**
   * Full rescan (index missing, unparseable, or periodic correction); `keep` = preserve existing
   * last-used timestamps
   */
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
        for (let rel = next(); rel; rel = next()) { if (closed) return; try { await measureRel(rel, { concurrency: 4 }); } catch { /* Measure in the next round */ } }
      }));
      scannedAt = calibratedAt = now();
      loaded = true;
      indexDirty = true;
      log('storage.rescan-done', { reason, keys: keys.size, ms: now() - started_ });
      await saveIndex().catch(() => {});
    })().finally(() => { scanning = null; });
    return scanning;
  }

  /**
   * Delta: lists directory names, measures newly appeared ones, deletes vanished ones, and remeasures
   * keys with recorded usage
   */
  async function refresh() {
    const rels = await listRels(root);
    const seen = new Set(rels);
    for (const rel of [...keys.keys()]) if (!seen.has(rel)) { keys.delete(rel); dirty.delete(rel); indexDirty = true; }
    for (const rel of rels) {
      const row = keys.get(rel);
      if (!row || row.bytes === null || dirty.has(rel)) { try { await measureRel(rel); } catch { /* Next round */ } }
    }
  }

  /* ---------------- Units, protection, eviction ---------------- */

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

  /** Summarizes by eviction unit: `[{ unit, rels, at, bytes, leftover, linked, protected }]` */
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
      // Delete the whole-scene directory first (it is largest and most likely to be open)
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
   * Cleans up leftover files (Section 3.3 of the plan: "clean up together at startup and on each
   * eviction"; see `sweepFrameLibrary` in `storage-leftovers.mjs` for what is deleted).
   * Key directories where files were deleted are marked for remeasuring; after the subsequent
   * `refresh()` finishes measuring, `leftovers.bytes` reflects the count after cleanup.
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

  /** Cleans up trash directory (renamed in previous round but deletion not completed) */
  async function sweepTrash() {
    let names = [];
    try { names = await fs.readdir(trashDir); } catch { return; }
    for (const name of names) await fs.rm(path.join(trashDir, name), { recursive: true, force: true, maxRetries: 2 }).catch(() => {});
  }

  /**
   * Deletes a unit: renames into trash directory first (fails and skips if any file is open), then
   * deletes
   */
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
        // EBUSY / EPERM / EACCES: a file in the directory is held open by another process (or this process)
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

  /**
   * Removes in-memory items in this process still pointing to deleted directories (whole-scene entry,
   * keys attached to ready index, stream manifest cache)
   */
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
          if (entry) { pipeline.entries.delete(parsed.key); try { entry.disposeArchive?.(); } catch { /* Directory already gone */ } }
        } else if (parsed.family === LOCAL) {
          pipeline.ready?.unstage?.({ kind: 'local', prefix: `${parsed.key}/` });
        } else if (parsed.family === 'controls-html') {
          pipeline.ready?.unstage?.({ kind: 'html', key: parsed.key });
        } else if (parsed.family === 'streams') {
          pipeline.ready?.unstage?.({ kind: 'stream', key: parsed.key });
          pipeline._streams?.store?.manifests?.delete?.(parsed.key);
        }
      } catch { /* Best effort */ }
    }
  }

  /**
   * Deletes units until total bytes do not exceed `targetBytes` (`targetBytes === null` = delete all
   * candidates).
   * Candidates: unprotected, no links; ordered by last used timestamp from oldest to newest.
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

  /**
   * Measure only without eviction (`refreshIfStale`): merges usage from other processes, cleans
   * leftovers, and measures deltas
   */
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

  /**
   * A single check: merges usage from other processes, measures deltas, and evicts when exceeding cap;
   * `force` is not constrained by ticks
   */
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

  /* ---------------- Ticks ---------------- */

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
    /**
     * Connects the pipeline: pipeline calls `usage.touchEntry` during preload, and this module determines
     * "open" status by its session
     */
    attachPipeline(p) { pipeline = p; if (p) p.usage = api; return api; },
    start() {
      if (started) return started;
      started = serial(() => becomeOwner()).then(() => {
        // Missing index: starts rescan immediately (measure only, do not delete); first eviction check waits
        // `startupGraceMs` to let pages reconnect and resend preload, recording usage for opening projects
        // first: otherwise a project open yesterday might be judged least recently used before its preload
        // arrives
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
    /** Records usage (relative path). In-memory only, flushed to disk on tick or check */
    touch(rels, at = now()) {
      for (const rel of rels ?? []) {
        if (!parseRel(rel)) continue;
        ownTouches.set(rel, Math.max(ownTouches.get(rel) ?? 0, at));
        touchDirty = true;
        if (owner) noteUse(rel, at);
      }
    },
    /** Records all keys used by a whole-scene version (`FramePipeline` entry) as used together */
    touchEntry(entry, at = now()) {
      try { api.touch(entryUsageRels(pipeline, entry), at); } catch { /* Failure to record does not block prerender */ }
    },
    /** After a batch of preloads or prerenders finishes: checks once when a tick arrives */
    afterBatch() {
      if (now() - lastCheckAt < tickMs) return;
      void api.check().catch(() => {});
    },
    check(options) { return serial(() => checkNow(options)); },
    /**
     * Measures once in background when usage numbers expire: when the last check or measurement is older
     * than `maxAgeMs`, merges usage from other processes, cleans leftovers, and performs delta
     * measurement (same as a check), but **does not evict** and does not touch eviction check ticks
     * (startup grace and at most once every 5 minutes remain as before).
     * Returns without waiting for measurement to finish: returns true if a pass is currently measuring
     * (`summary().scanning` is true).
     */
    refreshIfStale({ maxAgeMs = SUMMARY_STALE_MS } = {}) {
      if (closed) return false;
      if (measuring) return true;
      if (now() - Math.max(lastCheckAt, lastMeasureAt) <= maxAgeMs) return false;
      lastMeasureAt = now();
      measuring = serial(() => measureNow()).catch(() => {}).finally(() => { measuring = null; lastMeasureAt = now(); });
      return true;
    },
    /** Full rescan (diagnostics, testing) */
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
    /**
     * Sets cap (`bytes` must pass `validCap`); evaluates immediately after setting without waiting for
     * eviction
     */
    async setCap(bytes) {
      const diskBytes = await diskBytesOf(root);
      if (!validCap(bytes, diskBytes, minCapBytes)) {
        const range = capRange(diskBytes, minCapBytes);
        throw Object.assign(new Error(`The limit must be between ${range.min} and ${range.max} bytes`), { code: 'CAP_OUT_OF_RANGE', status: 400, min: range.min, max: range.max });
      }
      if (!owner && !(await serial(() => becomeOwner()))) throw Object.assign(new Error('Another PromptCut process is managing this frame store'), { code: 'STORAGE_NOT_OWNER', status: 409 });
      await writeStorageSettings(dataDir, { frameLibraryCapBytes: bytes });
      const pending = api.check({ force: true });
      pending.catch(() => {});
      return { capBytes: bytes, pending };
    },
    /**
     * Clears cache: deletes all units not used within `clearKeepMs` (projects currently being opened
     * are kept)
     */
    clearCache() {
      return serial(async () => {
        if (!(await becomeOwner())) throw Object.assign(new Error('Another PromptCut process is managing this frame store'), { code: 'STORAGE_NOT_OWNER', status: 409 });
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
    /** For testing: current index */
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
 * One per frame store (by directory)
 * ======================================================================== */

const managers = new Map();

/** Manager for this frame store (creates one and starts ticks if none exists) */
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

/** Closes and forgets the manager for this frame store (when dev server shuts down) */
export async function closeStorage(root) {
  const key = path.resolve(root);
  const manager = managers.get(key);
  managers.delete(key);
  await manager?.close();
}

/* ======================================================================== *
 * Summary of export artifacts (`exports` in `GET /api/storage`)
 * ======================================================================== */

/**
 * Cached export summary: reused within `maxAgeMs`; on expiry returns stale value first and refreshes
 * in background (waits on first run).
 * Recognizing directories and computing intermediate files directly uses `summarizeExports` from
 * the export list (`exports-list.mjs`, rules defined in `storage-leftovers.mjs`), same rules as the
 * `GET /api/exports` list: only recognizes real directories matching `export-YYYYMMDD-HHMMSS[-n]`,
 * excludes `export-vision-*`, and does not follow links.
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
      // When the export list side (editor process) deletes an export, deletes intermediate files only,
      // or exports a new one: top-level directory name or mtime changed, recomputes immediately instead
      // of returning stale numbers from 60 seconds ago (checks top level only, very cheap)
      if ((await exportDirSignature(exportDir)) !== valueSig) return refresh();
      if (now() - at > maxAgeMs) void refresh().catch(() => {});
      return value;
    },
  };
}

/**
 * Concatenates names and mtimes of each export (recognized real directory) under export directory
 * into a signature
 */
async function exportDirSignature(exportDir) {
  let items = [];
  try { items = await fs.readdir(exportDir, { withFileTypes: true }); } catch { return ''; }
  const parts = [];
  for (const item of items) {
    if (!item.isDirectory() || !isExportDirName(item.name)) continue;
    try { parts.push(`${item.name}:${(await fs.lstat(path.join(exportDir, item.name))).mtimeMs}`); } catch { /* Just gone */ }
  }
  return parts.sort().join('|');
}
