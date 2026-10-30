/**
 * PNG 快照(`bake_card`、3D 视图与空闲预渲染的贴图)经素材服务存取。
 * 这里说的「PNG 快照」是一张 **PNG 位图**(单张卡片某一刻的画面,当场渲出来,见 `vision/card-bitmap.ts`),不是 HTML:
 * 本模块只收发 PNG,任何地方都不存这张卡的 HTML(`docs/semantics/glossary.md`「PNG 快照」、`mechanism/asset-service.md`
 * 「不经任务队列的单张卡片画面」)。注释与报错文字统一为「PNG 快照」(2026-10-14 用户定)。
 *
 * 语义:`docs/semantics/product/asset-service.md`「预渲染的产物」(渲染生成的所有预渲染产物生成后都无条件推送到素材服务,
 * 素材服务就在本机时也一样)、「职责」第三条与 `product/agent.md`「素材与产物」(Agent 进程和预渲染进程经素材服务的接口
 * 读写产物,哪怕同机也绝不直接读它的存储目录)、`mechanism/asset-service.md`「同步状态只问素材服务」。
 *
 * 原来 `server/vision/bake.ts` 把 PNG 原子写进素材目录 `out/media/bake-<clipId>-<输入哈希>.png`,
 * `bake-cache.ts` 直接列、删这个目录。现在:
 *
 * - **字节**进素材服务的 `px` 命名空间(`PUT/POST <源>/api/asset/px/<sha256>…`,客户端 `asset-store/client.mjs`),
 *   地址 `/api/asset/px/<sha256>`。按内容寻址,同样的图只存一份。
 * - **缓存键**仍是输入哈希(`bakeTarget` 算的 12 位),它不等于内容哈希,所以另记一张小索引:
 *   `<outRoot>/bake-index/<键>.json` = `{ key, hash, bytes, width, height, clipId, name, at, pushed? }`。
 *   索引只是本机的缓存记录,不放字节、不在素材服务的存储目录里;编辑器进程(热备渲染器那条 `ui-render/bake-batch`)
 *   和预渲染进程共用它,一个键一个文件、原子改名写,两边同时写同一个键也只会是完整的一份。
 * - **命中**要问素材服务:索引里有、且 `GET px/<hash>/chunks` 报 `complete` 才算(索引不作判决依据)。
 *   素材服务里已经没有的,索引条目当场删掉,当作没渲过。
 * - **老地址**:老项目的参数里存着 `/@media/bake-….png`。素材目录里的旧文件一个不删、一个不动,
 *   素材服务的老读路由 `/@media/<文件名>` 照旧答它,所以老地址照常能取。同一个键再被要时先经这条老路由
 *   (素材服务的接口,不是读目录)取一次旧文件,取到就推进 `px`、记进索引(读时迁移),不用重渲。
 * - **淘汰**只删索引条目:素材服务没有删除接口(按内容寻址、写入后不可变),字节留在素材服务里,
 *   回收交给素材服务那一侧(见 `docs/reports/AGENT-bake-asset.md`「需要主会话决定的事」)。
 * - **共享项目**:本进程登记了连着的远程素材服务客户端时(`setBakeRemote`),写进本机素材服务之后再推一份到远程,
 *   成功就在索引里记 `pushed: <基址>`;没推成的,下次命中时再推。其它成员的本机素材服务在本机没有这一块时,
 *   按 `/api/asset/px/<hash>` 向远程拉(`asset-service.ts` 的产物按需拉取)。
 *
 * 素材服务不可达(取不到地址、连不上、超时)或拒绝(4xx / 5xx)时抛 `BakeStoreError`,消息写明素材服务地址与原因,
 * 调用方原样回给 Agent / 页面。
 *
 * 本文件不 import vite、不认素材目录,`server/test/bake-store.test.mjs` 直接测它。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createAssetClient } from './asset-store/client.mjs';

export const BAKE_INDEX_DIR = 'bake-index';
export const BAKE_NS = 'px';
/** 老读路由取旧文件的时限;本机回环上的一张 PNG */
export const LEGACY_FETCH_TIMEOUT_MS = 15_000;
/** 素材服务一个请求的时限(写一张快照、问一次对账) */
export const BAKE_ASSET_TIMEOUT_MS = 30_000;
/** 盘点时同时问素材服务的请求数 */
const STATUS_CONCURRENCY = 8;
/** 旧文件最大多少(和贴图上限 2048² 的 RGBA PNG 同量级,留足余量) */
const LEGACY_MAX_BYTES = 64 * 1024 * 1024;

const KEY_RE = /^[0-9a-f]{12}$/;
/** 老格式的键(文件名当键)不会进索引;索引只收当前格式 */
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

/** px 命名空间里一块的地址(页面、卡片参数里存的就是它) */
export const bakeUrlOf = (hash) => `/api/asset/${BAKE_NS}/${hash}`;

/* ------------------------------------------------------------------ *
 * 连着的远程素材服务(共享项目)
 * ------------------------------------------------------------------ */

const REMOTE_KEY = Symbol.for('promptcut.bake-store.remote');

/**
 * 登记本进程连着的远程素材服务客户端(`createAssetClient` 的实例,带写票据),null 清掉。
 * 预渲染进程由推送队列登记(`vite-plugin-frames.ts`),编辑器进程由上传队列的目标登记(`vite-plugin-media.ts`)。
 * 放在 globalThis 上:配置被打包过一次、模块可能有两份实例。
 * @param {null | (() => any)} getClient
 */
export function setBakeRemote(getClient) {
  /** @type {any} */ (globalThis)[REMOTE_KEY] = typeof getClient === 'function' ? getClient : null;
}

/** 当前登记的远程素材服务客户端;没有给 null */
export function bakeRemote() {
  const fn = /** @type {any} */ (globalThis)[REMOTE_KEY];
  try { return typeof fn === 'function' ? fn() ?? null : null; } catch { return null; }
}

/* ------------------------------------------------------------------ */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 素材服务客户端抛的错 → 写明地址与原因的 BakeStoreError */
function wrap(err, base, what) {
  if (err instanceof BakeStoreError) return err;
  const status = err && typeof err === 'object' ? err.status : undefined;
  const msg = String(err?.message || err);
  if (typeof status === 'number') {
    return new BakeStoreError(`素材服务拒绝了${what}(${base},HTTP ${status}):${msg}`, { status });
  }
  return new BakeStoreError(`素材服务不可达(${base}),PNG 快照没能${what}:${msg}`);
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

/** 限并发地映射 */
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
 * @param {string} p.indexDir  索引目录(`<outRoot>/bake-index`)
 * @param {() => (string | null)} p.origin  素材服务的源(不带尾斜杠);每次用时现取;null = 不可达
 * @param {typeof fetch} [p.fetchImpl]
 * @param {() => any} [p.remote]  连着的远程素材服务客户端;缺省读 `setBakeRemote` 登记的
 * @param {(event: string, fields?: object) => void} [p.log]
 * @param {number} [p.timeoutMs]
 * @param {number} [p.retries]  素材服务客户端的重试次数(缺省 2)
 */
export function createBakeStore({ indexDir, origin, fetchImpl = globalThis.fetch, remote = bakeRemote, log = () => {}, timeoutMs = BAKE_ASSET_TIMEOUT_MS, retries = 2 }) {
  if (typeof indexDir !== 'string' || !indexDir) throw new TypeError('createBakeStore:indexDir 必填');
  if (typeof origin !== 'function') throw new TypeError('createBakeStore:origin 必须是函数');
  let cached = null; // { base, client }

  /** 当前素材服务的客户端;取不到地址抛 */
  function current(what) {
    const src = String(origin() || '').trim().replace(/\/+$/, '');
    if (!src) throw new BakeStoreError(`素材服务不可达:取不到素材服务的地址,PNG 快照没能${what}`);
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
   * 推一份到连着的远程素材服务(共享项目)。后台跑,不挡调用方;成功在索引里记 `pushed`。
   * 远程就是本机素材服务时(推送队列还没等到登记,`asset-select.mjs` 回本机)不推。
   */
  function pushRemote(entry, bytes) {
    let client;
    try { client = remote(); } catch { client = null; }
    if (!client || typeof client.put !== 'function') return null;
    const base = String(client.base || '').replace(/\/+$/, '');
    if (base && entry.pushed === base) return null;
    // 选定的就是本机素材服务(推送队列还没等到别的登记时会回落本机):已经写在那儿了,不推
    try { if (base && base === current('读取').base) return null; } catch { /* 取不到本机地址就照推 */ }
    return (async () => {
      try {
        const buf = bytes ?? await current('读取').client.get(BAKE_NS, entry.hash);
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
     * 这个键渲过没有:索引里有、且素材服务上这一块 `complete`。没有回 null;素材服务不可达抛 `BakeStoreError`。
     * @param {string} key
     */
    async lookup(key) {
      const e = await readEntry(key);
      if (!e) return null;
      const { base, client } = current('读取');
      let complete;
      try { complete = await client.has(BAKE_NS, e.hash); } catch (err) { throw wrap(err, base, '读取'); }
      if (!complete) {
        // 素材服务里已经没有这一块:索引不作判决依据,条目删掉,当作没渲过
        await dropEntry(key);
        log('bake.stale', { key, hash: e.hash });
        return null;
      }
      void pushRemote(e, null);
      return withUrl(e);
    },

    /**
     * 渲好的 PNG 经素材服务写进 `px`,记进索引。回索引条目加 `url`。
     * @param {string} key
     * @param {Buffer} buf
     * @param {{ width?: number, height?: number, clipId?: string, name?: string }} [meta]
     */
    async put(key, buf, meta = {}) {
      if (!KEY_RE.test(String(key))) throw new TypeError(`PNG 快照的键不合法:${key}`);
      const { base, client } = current('写入');
      let r;
      try { r = await client.put(BAKE_NS, buf, { ext: 'png' }); } catch (err) { throw wrap(err, base, '写入'); }
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
     * 读时迁移:这个键在老格式下的文件(`/@media/<name>`)经素材服务的老读路由取一次,取到就推进 `px`、记进索引。
     * 没有(404)回 null;素材服务不可达抛 `BakeStoreError`。旧文件不动。
     * @param {string} key
     * @param {string} name  老文件名 `bake-<clipId>-<键>.png`
     * @param {{ width?: number, height?: number, clipId?: string }} [meta]
     */
    async migrateLegacy(key, name, meta = {}) {
      if (!KEY_RE.test(String(key)) || !/^bake-[\w.-]*\.png$/.test(String(name))) return null;
      const { src, base } = current('读取');
      const url = `${src}/@media/${encodeURIComponent(name)}`;
      let res;
      try {
        res = await fetchImpl(url, { signal: AbortSignal.timeout(LEGACY_FETCH_TIMEOUT_MS) });
      } catch (err) {
        throw new BakeStoreError(`素材服务不可达(${base}),PNG 快照没能读取:${err?.cause?.code || err?.message || err}`);
      }
      if (res.status === 404) { await res.arrayBuffer().catch(() => {}); return null; }
      if (!res.ok) {
        await res.arrayBuffer().catch(() => {});
        throw new BakeStoreError(`素材服务拒绝了读取(${base},HTTP ${res.status}):/@media/${name}`, { status: res.status });
      }
      const buf = Buffer.from(await res.arrayBuffer());
      // 不是 PNG(比如迁移期同名的别的东西、或空文件)就当没有,重渲
      if (buf.length < PNG_MAGIC.length || buf.length > LEGACY_MAX_BYTES || !buf.subarray(0, 8).equals(PNG_MAGIC)) return null;
      const e = await api.put(key, buf, { ...meta, name });
      log('bake.migrated', { key, name, hash: e.hash });
      return { ...e, migrated: true };
    },

    /** 索引里全部条目(不问素材服务) */
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
     * 盘点:这些键哪些渲好了(索引里有、素材服务上 `complete`)。回 `Map<键, 条目>`,只含渲好的。
     * 素材服务不可达抛 `BakeStoreError`。
     * @param {string[]} keys
     */
    async status(keys) {
      const uniq = [...new Set((keys || []).filter((k) => KEY_RE.test(String(k))))];
      const entries = (await Promise.all(uniq.map(readEntry))).filter(Boolean);
      const found = new Map();
      if (!entries.length) return found;
      const { base, client } = current('读取');
      const done = await mapLimit(entries, STATUS_CONCURRENCY, async (e) => {
        try { return await client.has(BAKE_NS, e.hash); } catch (err) { throw wrap(err, base, '读取'); }
      });
      for (let i = 0; i < entries.length; i++) {
        if (done[i]) found.set(entries[i].key, withUrl(entries[i]));
        else { await dropEntry(entries[i].key); log('bake.stale', { key: entries[i].key, hash: entries[i].hash }); }
      }
      return found;
    },

    /**
     * 淘汰:删掉这些键的索引条目。**只认键**:和自己列出来的索引逐个比对,对得上的才删,碰不到索引以外的文件。
     * 字节留在素材服务里(没有删除接口);`freedBytes` 是这些条目记的字节数(页面按它算占用)。
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

    /** 单测用:当前素材服务的 API 基址 */
    baseForTest() { return current('读取').base; },
  };
  return api;
}

/** 字节的 sha256(单测、探针对账用) */
export const bakeHashOf = sha256;
