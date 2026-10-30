/**
 * 按需拉取与预取队列(`docs/plan/c66-design.md` 第 4 节;任务书 `docs/plan/cloud-task.md` A1「按需拉取」「预取队列」;
 * 语义 `docs/semantics/product/asset-service.md`「拉取」「本地内容库」)。
 *
 * 本地素材服务的读路由 `/@media/<hash>`(`vite-plugin-media.ts`)在本地内容库里找不到这个哈希时,
 * 交给这里:向**当前连接的远程素材服务** `GET <base>/media/<hash>` 流式拉取,**边落盘边按 Range 服务**,
 * 拉完按 sha256 校验、改名进本地内容库(之后就是普通的本地命中)。远程也没有(404)才回 404。
 * 页面照常挂 `src`,同一次请求就拿到字节,没有「重挂」这一步;首字节到达前 `<video>` 只是在缓冲。
 *
 * # 当前连接的远程素材服务
 *
 * 由页面告诉编辑器进程(`POST /api/media/remote { base, ticket }`,`src/editor/media/assetTiers.ts`):
 * 进入共享项目时是那个项目的素材服务(API 基址,形如 `http://<ip>:<port>/api/asset`),票据是经文档服务取的
 * 只读素材票据(M6a),页面按时续签后再推一次。离开共享项目(回到本机空间)时清掉 —— 本地素材服务就是真身,
 * 找不到就是没有。放在 `globalThis` 上:配置被打包过一次、模块可能有两份实例。
 * 票据只进 `Authorization` 头,不进地址、不进日志、不进回包。
 *
 * # 边落盘边服务
 *
 * 同一个哈希同时只有一个拉取任务(`jobs`),读请求挂在它上面:
 * - 回包头(长度、类型、Range)在远程回了头之后立刻给;字节从临时文件里读,读到还没落盘的位置就等;
 * - 请求的 Range 起点远在已落盘的位置之后(超过 `AHEAD_LIMIT`,比如 moov 在尾部的老文件),这一段直接从远程
 *   透传(不缓存),不让播放器干等整段下完;
 * - 拉完:sha256 不符就丢掉临时文件、这次拉取作废(已经在读的请求断开);相符就改名进本地内容库、写索引。
 *
 * # 预取队列
 *
 * 页面打开项目后给一份有序清单(`prefetchOrder`:先全部素材小尺寸、再全部素材原尺寸,各按片段在时间轴上的先后),
 * 这里**一次拉一个**、按需拉取在跑时让路(低优先级),本地已有的跳过。换了远程素材服务或清掉时队列作废。
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const HASH = /^[0-9a-f]{64}$/;
/** 请求的起点比已落盘的位置超前这么多,就直接从远程透传这一段 */
export const AHEAD_LIMIT = 8 * 1024 * 1024;
/** 远程回头的时限 */
const HEADERS_TIMEOUT_MS = 30_000;
/** 预取在按需拉取跑着时让路,多久看一次 */
const YIELD_POLL_MS = 250;

const STATE_KEY = Symbol.for('promptcut.media-pull.state');
const PROJECT_STATE_KEY = Symbol.for('promptcut.media-pull.projects.v2');
const CONTEXT_KEY = Symbol.for('promptcut.media-pull.context.v2');
const context = globalThis[CONTEXT_KEY] ??= new AsyncLocalStorage();
function state() {
  const g = /** @type {any} */ (globalThis);
  const scope = context.getStore();
  const holder = scope ? (g[PROJECT_STATE_KEY] ??= new Map()) : null;
  let value = scope ? holder.get(scope.root) : g[STATE_KEY];
  if (!value) value = {
    remote: null,          // { base, ticket: string | (() => Promise<string|null>) | null, gen }
    gen: 0,
    jobs: new Map(),       // hash → Job
    onDemand: 0,           // 正在服务的按需读请求数
    queue: [],             // 预取:待拉的哈希(有序)
    queueGen: 0,
    running: false,
    log: [],               // 最近的事件(探针和单测看顺序用),只记哈希与动作,不记票据
  };
  if (scope) holder.set(scope.root, value); else g[STATE_KEY] = value;
  return value;
}

/** 每项目独立remote/jobs/queue；异步任务继承范围，local旧默认保持。 */
export function projectMediaPull(scope) {
  if (!scope?.projectId || !scope.root) throw new TypeError('project pull scope required');
  const api = {};
  for (const [name, fn] of Object.entries({ setRemoteAssetService, remoteAssetBase, fetchRemoteArtifact, pullLog, pullStatus, pullThrough, prefetch, incompleteOnService, resetPullStateForTest })) api[name] = (...args) => context.run(scope, () => fn(...args));
  return api;
}

function note(event, fields) {
  const s = state();
  s.log.push({ at: Date.now(), event, ...fields });
  if (s.log.length > 500) s.log.splice(0, s.log.length - 500);
}

/* ------------------------------------------------------------------ *
 * 当前连接的远程素材服务
 * ------------------------------------------------------------------ */

/**
 * 设当前连接的远程素材服务;null 清掉(回到只用本地素材服务)。
 * 基址换了:在跑的拉取中止、预取队列作废。只是续签票据(基址不变):什么都不打断。
 * @param {{ base: string, ticket?: string | null | (() => (string | null | Promise<string | null>)) } | null} remote
 */
export function setRemoteAssetService(remote) {
  const s = state();
  if (!remote) {
    if (s.remote) note('remote.clear', {});
    s.remote = null;
    s.gen++;
    abortAll();
    s.queue = [];
    s.queueGen++;
    return null;
  }
  const base = String(remote.base || '').trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(base); } catch { throw new TypeError('远程素材服务的基址解析不了'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('远程素材服务的基址只能是 http(s)');
  if (url.username || url.password) throw new TypeError('远程素材服务的基址不能带用户名或密码');
  const ticket = remote.ticket ?? null;
  const scope = context.getStore();
  if (scope && remote.projectId !== scope.projectId) throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch' });
  if (s.remote && s.remote.base === base) {
    s.remote.ticket = ticket;
    return { base };
  }
  s.gen++;
  abortAll();
  s.queue = [];
  s.queueGen++;
  s.remote = { base, ticket, gen: s.gen };
  note('remote.set', { base });
  return { base };
}

/** 当前连接的远程素材服务的基址(不含票据);没有给 null */
export function remoteAssetBase() {
  return state().remote?.base ?? null;
}

async function authHeaders(r = state().remote) {
  if (!r || !r.ticket) return {};
  const t = typeof r.ticket === 'function' ? await r.ticket() : r.ticket;
  return typeof t === 'string' && t ? { authorization: `Bearer ${t}` } : {};
}

/** 产物按需拉取的时限(一块 PNG,整件读完) */
export const ARTIFACT_PULL_TIMEOUT_MS = 30_000;
/** 按需拉取发出的请求带这个头;收到它的素材服务不再往下拉(`asset-service.ts`) */
export const ARTIFACT_PULL_HEADER = 'x-promptcut-pull';
/** 产物按需拉取整件进内存,只收这么大以内的(卡片快照最大 2048² 的 PNG,远小于它) */
export const ARTIFACT_PULL_MAX_BYTES = 64 * 1024 * 1024;

/**
 * 产物命名空间(`px`)的按需拉取(claude/bake-asset):本机素材服务的 `GET px/<hash>` 在本机没有这一块时,
 * 向**当前连接的远程素材服务**整件取一次 `GET <base>/<ns>/<hash>`(带只读票据),校验 sha256 后交回调用方入库
 * (`asset-service.ts` 的 `pullArtifactInto`)。共享项目里别的成员推上去的卡片快照(`/api/asset/px/<hash>`)
 * 因此在本机也取得到。与素材不同:产物很小,不做边落盘边服务,不进预取队列。
 * 没连远程、远程 404、不是 2xx、超大、校验不符都回 null(调用方照旧回 404);不抛。
 * @param {'px' | 'snap'} ns
 * @param {string} hash
 * @returns {Promise<{ bytes: Buffer, contentType: string } | null>}
 */
export async function fetchRemoteArtifact(ns, hash, { timeoutMs = ARTIFACT_PULL_TIMEOUT_MS, maxBytes = ARTIFACT_PULL_MAX_BYTES } = {}) {
  const key = String(hash || '').toLowerCase();
  if ((ns !== 'px' && ns !== 'snap') || !HASH.test(key)) return null;
  const remote = state().remote;
  if (!remote) return null;
  note('artifact.pull', { ns, hash: key });
  try {
    // 带上「这是按需拉取」的头:对面若也是本仓库的素材服务,不再替这个请求往它自己连的远程拉(防互指成环)
    const res = await fetch(`${remote.base}/${ns}/${key}`, { headers: { ...(await authHeaders(remote)), [ARTIFACT_PULL_HEADER]: '1' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) { await res.body?.cancel().catch(() => {}); note('artifact.miss', { ns, hash: key, status: res.status }); return null; }
    const len = Number(res.headers.get('content-length'));
    if (Number.isSafeInteger(len) && len > maxBytes) { await res.body?.cancel().catch(() => {}); return null; }
    const bytes = Buffer.from(await res.arrayBuffer());
    if (bytes.length === 0 || bytes.length > maxBytes) return null;
    if (crypto.createHash('sha256').update(bytes).digest('hex') !== key) { note('artifact.mismatch', { ns, hash: key }); return null; }
    if (state().remote !== remote) return null;
    note('artifact.done', { ns, hash: key, bytes: bytes.length });
    return { bytes, contentType: res.headers.get('content-type') || 'application/octet-stream' };
  } catch (err) {
    note('artifact.fail', { ns, hash: key, error: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** 最近的事件(拷贝);探针与单测看拉取顺序用 */
export function pullLog() {
  return state().log.map((e) => ({ ...e }));
}

/** 状态摘要(`GET /api/media/remote`) */
export function pullStatus() {
  const s = state();
  return {
    base: s.remote?.base ?? null,
    jobs: [...s.jobs.values()].map((j) => ({ hash: j.hash, size: j.size, written: j.written, done: j.done, error: j.error ?? null, by: j.by })),
    queue: [...s.queue],
    onDemand: s.onDemand,
  };
}

/* ------------------------------------------------------------------ *
 * 拉取任务
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} PullStore  本地内容库的几样操作(由 vite-plugin-media 给,本模块不认目录布局)
 * @property {string} dir  临时文件放在这里(和本地内容库同一个卷,改名不跨盘)
 * @property {(hash: string) => Promise<string | null>} resolve  本地已有就给路径
 * @property {(hash: string, tmp: string, ext: string, contentType: string) => Promise<string>} finalize  校验过的临时文件改名入库,回最终路径
 * @property {(contentType: string) => string} extForType  Content-Type → 扩展名(认不出给空串)
 */

function abortAll() {
  const s = state();
  for (const job of s.jobs.values()) job.abort('remote-changed');
}

function waitChange(job) {
  return new Promise((resolve) => job.waiters.add(resolve));
}

function wake(job) {
  const ws = [...job.waiters];
  job.waiters.clear();
  for (const w of ws) w();
}

/**
 * 开一个拉取任务(同一个哈希已有就复用)。回 Job;`job.head` 在远程回了头(或失败)时 resolve。
 * @param {string} hash
 * @param {PullStore} store
 * @param {'demand' | 'prefetch'} by
 */
function startJob(hash, store, by) {
  const s = state();
  const had = s.jobs.get(hash);
  if (had && !had.error) return had;
  const remote = s.remote;
  const ac = new AbortController();
  /** @type {any} */
  const job = {
    hash, by, size: null, written: 0, done: false, error: null, tmp: null, final: null,
    contentType: 'application/octet-stream', ext: '', waiters: new Set(), gen: remote?.gen ?? -1,
    abort: (why) => { if (!job.done && !job.error) { job.error = why; ac.abort(); wake(job); } },
  };
  s.jobs.set(hash, job);
  let headResolve;
  job.head = new Promise((r) => { headResolve = r; });
  job.finished = (async () => {
    if (!remote) { job.error = 'no-remote'; headResolve(); return; }
    note('pull.start', { hash, by });
    let fh = null;
    try {
      await store.assert?.();
      const headers = await authHeaders(remote);
      const timer = setTimeout(() => ac.abort(), HEADERS_TIMEOUT_MS);
      let res;
      try {
        res = await fetch(`${remote.base}/media/${hash}`, { headers, signal: ac.signal });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 404) { job.error = 'not-found'; await res.body?.cancel().catch(() => {}); return; }
      if (!res.ok) { job.error = `remote-${res.status}`; await res.body?.cancel().catch(() => {}); return; }
      const len = Number(res.headers.get('content-length'));
      job.size = Number.isSafeInteger(len) && len >= 0 ? len : null;
      job.contentType = res.headers.get('content-type') || 'application/octet-stream';
      job.ext = store.extForType(job.contentType);
      await fs.mkdir(store.dir, { recursive: true });
      job.tmp = path.join(store.dir, `.pull-${hash}-${crypto.randomBytes(6).toString('hex')}.part`);
      fh = await fs.open(job.tmp, 'w');
      headResolve();
      const digest = crypto.createHash('sha256');
      for await (const chunk of res.body) {
        if (job.error) break;
        const buf = Buffer.from(chunk);
        let off = 0;
        while (off < buf.length) {
          const { bytesWritten } = await fh.write(buf, off, buf.length - off, job.written + off);
          off += bytesWritten;
        }
        digest.update(buf);
        job.written += buf.length;
        wake(job);
      }
      await fh.close();
      fh = null;
      if (job.error) return;
      if (job.size !== null && job.written !== job.size) { job.error = 'short-read'; return; }
      if (job.size === null) job.size = job.written;
      const actual = digest.digest('hex');
      if (actual !== hash) { job.error = 'hash-mismatch'; note('pull.mismatch', { hash }); return; }
      if (job.gen !== s.remote?.gen || job.error) throw new Error('remote-changed');
      await store.assert?.();
      job.final = await store.finalize(hash, job.tmp, job.ext, job.contentType);
      job.done = true;
      note('pull.done', { hash, by, bytes: job.written });
    } catch (err) {
      if (!job.error) job.error = ac.signal.aborted ? 'aborted' : `network: ${err instanceof Error ? err.message : String(err)}`;
    } finally {
      if (fh) await fh.close().catch(() => {});
      headResolve();
      if (job.error) {
        note('pull.fail', { hash, by, error: job.error });
        if (job.tmp) await fs.rm(job.tmp, { force: true }).catch(() => {});
      }
      wake(job);
      // 完成的任务留着没用(之后就是本地命中);失败的留一小会儿,让挂着的读请求看到原因
      setTimeout(() => { if (s.jobs.get(hash) === job) s.jobs.delete(hash); }, job.error ? 2000 : 0).unref?.();
    }
  })();
  return job;
}

/**
 * 解析 Range(与 vite-plugin-media 的 parseRange 同口径,单段)
 * @returns {{ start: number, end: number } | null | 'unsatisfiable'}
 */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start, end;
  if (m[1] === '') {
    const n = parseInt(m[2], 10);
    if (n === 0) return 'unsatisfiable';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] === '' ? size - 1 : Math.min(parseInt(m[2], 10), size - 1);
  }
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}

/** 这一段直接从远程透传(不缓存):Range 起点远在已落盘位置之后 */
async function passThrough(hash, req, res) {
  const remote = state().remote;
  if (!remote) { res.statusCode = 404; return res.end('Not found'); }
  const headers = { ...(await authHeaders()) };
  if (req.headers.range) headers.range = req.headers.range;
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  try {
    const up = await fetch(`${remote.base}/media/${hash}`, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers, signal: ac.signal });
    const out = { 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    for (const name of ['content-type', 'content-length', 'content-range']) {
      const v = up.headers.get(name);
      if (v) out[name] = v;
    }
    res.writeHead(up.status === 404 ? 404 : up.status, out);
    if (req.method === 'HEAD' || !up.body) return res.end();
    for await (const chunk of up.body) {
      if (!res.write(Buffer.from(chunk))) await new Promise((r) => res.once('drain', r));
    }
    res.end();
  } catch {
    if (!res.headersSent) { res.statusCode = 502; res.end('Remote asset service unreachable'); } else res.destroy();
  }
}

/**
 * 读路由在本地内容库里没找到这个哈希时调它。
 * 回 `true`:已经答了(拉取中服务、透传、或远程也没有回的 404);回 `false`:没有连远程素材服务,调用方自己回 404。
 * @param {{ hash: string, req: import('http').IncomingMessage, res: import('http').ServerResponse, store: PullStore, serveFile: (file: string) => unknown }} o
 */
export async function pullThrough({ hash, req, res, store, serveFile }) {
  const key = String(hash || '').toLowerCase();
  if (!HASH.test(key)) return false;
  const s = state();
  if (!s.remote) return false;
  s.onDemand++;
  try {
    const job = startJob(key, store, 'demand');
    await job.head;
    if (job.done && job.final) { await serveFile(job.final); return true; }
    if (job.error || job.size === null) {
      if (job.error === 'not-found' || job.error === 'no-remote') { res.statusCode = 404; res.end('Not found'); return true; }
      // 没有长度的远程回包:等整件落盘再按普通文件答
      if (!job.error) { await job.finished; if (job.done && job.final) { await serveFile(job.final); return true; } }
      res.statusCode = 502;
      res.end('Remote asset service failed');
      return true;
    }
    const size = job.size;
    const range = req.headers.range ? parseRange(req.headers.range, size) : null;
    if (range === 'unsatisfiable') {
      res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' });
      res.end();
      return true;
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : size - 1;
    if (!job.done && start > job.written + AHEAD_LIMIT) {
      await passThrough(key, req, res);
      return true;
    }
    const head = {
      'Content-Type': job.contentType,
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    };
    if (range) res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}` });
    else res.writeHead(200, head);
    if (req.method === 'HEAD') { res.end(); return true; }
    let closed = false;
    res.on('close', () => { closed = true; wake(job); });
    // 读临时文件用自己的句柄:拉完改名之后句柄照样有效(Windows 上 libuv 带 FILE_SHARE_DELETE 打开)
    let fh;
    try {
      fh = await fs.open(job.final ?? job.tmp, 'r');
    } catch {
      // 恰好在这一刻拉完改了名
      await job.finished;
      if (!job.final) { res.destroy(); return true; }
      fh = await fs.open(job.final, 'r');
    }
    try {
      let pos = start;
      const buf = Buffer.alloc(256 * 1024);
      while (pos <= end && !closed) {
        const avail = job.done ? size : job.written;
        if (pos >= avail) {
          if (job.error) break;
          await waitChange(job);
          continue;
        }
        const n = Math.min(buf.length, end - pos + 1, avail - pos);
        const { bytesRead } = await fh.read(buf, 0, n, pos);
        if (bytesRead <= 0) { await waitChange(job); continue; }
        pos += bytesRead;
        if (!res.write(Buffer.from(buf.subarray(0, bytesRead)))) await new Promise((r) => res.once('drain', r).once('close', r));
      }
      if (pos > end) res.end();
      else if (!closed) res.destroy();
    } finally {
      await fh.close().catch(() => {});
    }
    return true;
  } finally {
    s.onDemand--;
  }
}

/* ------------------------------------------------------------------ *
 * 预取队列
 * ------------------------------------------------------------------ */

/**
 * 换一份预取清单(有序;页面按 `prefetchOrder` 排好)。只在连着远程素材服务时有效,否则忽略。
 * 回这次排进队列的哈希数。
 * @param {{ hash: string }[] | string[]} items
 * @param {PullStore} store
 */
export function prefetch(items, store) {
  const s = state();
  if (!s.remote) return 0;
  const seen = new Set();
  const list = [];
  for (const it of Array.isArray(items) ? items : []) {
    const h = String(typeof it === 'string' ? it : it?.hash ?? '').toLowerCase();
    if (HASH.test(h) && !seen.has(h)) { seen.add(h); list.push(h); }
  }
  s.queue = [...list];
  s.queueGen++;
  note('prefetch.queue', { hashes: list });
  if (!s.running) void runQueue(store);
  return list.length;
}

async function runQueue(store) {
  const s = state();
  s.running = true;
  try {
    while (s.queue.length && s.remote) {
      // 低优先级:按需拉取在服务时让路
      if (s.onDemand > 0) { await new Promise((r) => setTimeout(r, YIELD_POLL_MS)); continue; }
      const gen = s.queueGen;
      const hash = s.queue.shift();
      if (await store.resolve(hash)) continue;
      const job = startJob(hash, store, 'prefetch');
      await job.finished;
      if (gen !== s.queueGen) continue; // 清单换过了:接着按新清单走
    }
  } finally {
    s.running = false;
  }
}

/* ------------------------------------------------------------------ *
 * 当前素材服务上到齐没有(导出前的拦截)
 * ------------------------------------------------------------------ */

/**
 * 这些哈希里哪些在**当前连接的素材服务**上还没 `complete`。连远程素材服务时问它的 `chunks`
 * (本机缓存落没落盘不算数,A1「换档判据」);没连远程时就是本地素材服务,看本地内容库。
 * 问不到(网络错)的也算没到齐。
 * @param {string[]} hashes
 * @param {PullStore} store
 * @returns {Promise<string[]>}
 */
export async function incompleteOnService(hashes, store) {
  const list = [...new Set((hashes || []).map((h) => String(h).toLowerCase()).filter((h) => HASH.test(h)))];
  const remote = state().remote;
  const out = [];
  for (const h of list) {
    if (!remote) {
      if (!(await store.resolve(h))) out.push(h);
      continue;
    }
    try {
      const res = await fetch(`${remote.base}/media/${h}/chunks`, { headers: await authHeaders() });
      const body = res.ok ? await res.json() : null;
      if (body?.complete !== true) out.push(h);
    } catch {
      out.push(h);
    }
  }
  return out;
}

/** 单测用:清掉全部状态 */
export function resetPullStateForTest() {
  const s = state();
  abortAll();
  s.remote = null;
  s.jobs.clear();
  s.queue = [];
  s.queueGen++;
  s.log = [];
  s.onDemand = 0;
}
