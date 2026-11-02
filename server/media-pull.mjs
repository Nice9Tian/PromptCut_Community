/**
 * On-demand pull and prefetch queue (`docs/plan/c66-design.md` Section 4; task brief
 * `docs/plan/cloud-task.md` A1 "On-demand pull" "Prefetch queue"; semantics
 * `docs/semantics/product/asset-service.md` "Pull" "Local content store").
 *
 * When the local asset service read route `/@media/<hash>` (`vite-plugin-media.ts`) cannot find
 * this hash in the local content store, it delegates here: streams a pull via
 * `GET <base>/media/<hash>` from the **currently connected remote asset service**, **serving Range
 * requests while writing to disk**, verifies via sha256 once pulled, and renames it into the local
 * content store (after which it is a normal local hit). Only returns 404 if the remote also does
 * not have it (404).
 * The page sets `src` as usual, receiving bytes in the same request with no "reattach" step;
 * `<video>` is simply buffering before the first byte arrives.
 *
 * # Currently connected remote asset service
 *
 * The page informs the editor process (`POST /api/media/remote { base, ticket }`,
 * `src/editor/media/assetTiers.ts`): when entering a shared project, it is that project's asset
 * service (API base URL, e.g. `http://<ip>:<port>/api/asset`), with the ticket being a read-only
 * asset ticket (M6a) obtained via the document service, which the page pushes again after renewing
 * on schedule. Cleared when leaving a shared project (returning to the local space): the local
 * asset service is the true source; if not found, it does not exist. Placed on `globalThis`:
 * configuration was bundled once, and the module may have two instances.
 * Tickets only go into the `Authorization` header, not into URLs, logs, or responses.
 *
 * # Serving while writing to disk
 *
 * Only one pull job (`jobs`) exists for the same hash at a time, with read requests attached to it:
 * - Response headers (length, type, Range) are returned immediately after the remote returns
 *   headers; bytes are read from the temporary file, waiting if reading reaches a position not yet
 *   written to disk;
 * - If the requested Range start is far beyond what has been written to disk (exceeding
 *   `AHEAD_LIMIT`, such as legacy files with moov at the tail), this segment is passed through
 *   directly from the remote (not cached), so the player does not wait idly for the entire file
 *   to finish downloading;
 * - Once pulled: if sha256 does not match, the temporary file is discarded and this pull is
 *   invalidated (disconnecting requests currently reading); if it matches, it is renamed into the
 *   local content store and the index is written.
 *
 * # Prefetch queue
 *
 * After the page opens a project, it provides an ordered manifest (`prefetchOrder`: all
 * small-size assets first, then all original-size assets, each in clip order along the timeline),
 * and here it pulls **one at a time**, yields when on-demand pulls are running (low priority),
 * and skips what is already present locally. The queue is invalidated when switching or clearing
 * the remote asset service.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';

const HASH = /^[0-9a-f]{64}$/;
/**
 * If the request start point is ahead of the written-to-disk position by this much,
 * pass through this segment directly from the remote
 */
export const AHEAD_LIMIT = 8 * 1024 * 1024;
/** Timeout for remote to return headers */
const HEADERS_TIMEOUT_MS = 30_000;
/** How often prefetch checks to yield while on-demand pull is running */
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
    onDemand: 0,           // Number of on-demand read requests currently being served
    queue: [],             // Prefetch: hashes waiting to be pulled (ordered)
    queueGen: 0,
    running: false,
    log: [],               // Recent events (used by probes and unit tests to check order); records only hashes and actions, not tickets
  };
  if (scope) holder.set(scope.root, value); else g[STATE_KEY] = value;
  return value;
}

/** Per-project independent remote/jobs/queue; async tasks inherit scope, local legacy defaults retained. */
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
 * Currently connected remote asset service
 * ------------------------------------------------------------------ */

/**
 * Sets the currently connected remote asset service; null clears it (reverting to using only the
 * local asset service).
 * Base URL changed: running pulls are aborted, prefetch queue is invalidated. Only renewing
 * tickets (base URL unchanged): nothing is interrupted.
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
  try { url = new URL(base); } catch { throw new TypeError('The base URL of the remote asset service could not be parsed'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new TypeError('The base URL of the remote asset service must be http(s)');
  if (url.username || url.password) throw new TypeError('The base URL of the remote asset service must not contain a username or password');
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

/** Base URL of the currently connected remote asset service (excluding tickets); null if none */
export function remoteAssetBase() {
  return state().remote?.base ?? null;
}

async function authHeaders(r = state().remote) {
  if (!r || !r.ticket) return {};
  const t = typeof r.ticket === 'function' ? await r.ticket() : r.ticket;
  return typeof t === 'string' && t ? { authorization: `Bearer ${t}` } : {};
}

/** Timeout for on-demand artifact pulls (a single PNG chunk, read as a whole file) */
export const ARTIFACT_PULL_TIMEOUT_MS = 30_000;
/**
 * Requests sent by on-demand pulls include this header; asset services receiving it
 * will not pull further down (`asset-service.ts`)
 */
export const ARTIFACT_PULL_HEADER = 'x-promptcut-pull';
/**
 * On-demand artifact pulls load the whole file into memory, accepting only sizes up to
 * this limit (card snapshots are at most 2048² PNGs, far smaller than this)
 */
export const ARTIFACT_PULL_MAX_BYTES = 64 * 1024 * 1024;

/**
 * On-demand pull for artifact namespace (`px`) (claude/bake-asset): when `GET px/<hash>` on the
 * local asset service does not have this chunk locally, fetches the whole file once from the
 * **currently connected remote asset service** via `GET <base>/<ns>/<hash>` (with a read-only ticket),
 * verifies sha256, and returns it to the caller to be stored (`pullArtifactInto` in
 * `asset-service.ts`). Card snapshots (`/api/asset/px/<hash>`) pushed by other members in a shared
 * project are thus also retrievable locally. Unlike assets: artifacts are tiny, so they are not
 * served while writing to disk and do not enter the prefetch queue.
 * Returns null if not connected to remote, remote returns 404, non-2xx status, oversized, or
 * checksum mismatch (caller returns 404 as usual); does not throw.
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
    // Include the "this is an on-demand pull" header: if the other side is also an asset service
    // from this repo, it will not pull further to its own connected remote for this request
    // (preventing circular references)
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

/** Recent events (copy); used by probes and unit tests to check pull order */
export function pullLog() {
  return state().log.map((e) => ({ ...e }));
}

/** Status summary (`GET /api/media/remote`) */
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
 * Pull jobs
 * ------------------------------------------------------------------ */

/**
 * @typedef {object} PullStore  Several local content store operations (provided by
 *   vite-plugin-media; this module is agnostic to directory layout)
 * @property {string} dir  Temporary files are placed here (same volume as local content store,
 *   rename does not cross disks)
 * @property {(hash: string) => Promise<string | null>} resolve  Returns path if already present locally
 * @property {(hash: string, tmp: string, ext: string, contentType: string) => Promise<string>} finalize
 *   Renames verified temporary file into the store, returns final path
 * @property {(contentType: string) => string} extForType  Content-Type → extension (empty string if
 *   unrecognized)
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
 * Starts a pull job (reuses existing if for the same hash). Returns Job; `job.head` resolves
 * when the remote returns headers (or fails).
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
      // Completed jobs are useless to keep (subsequent reads are local hits); failed jobs are kept
      // briefly so attached read requests can see the cause
      setTimeout(() => { if (s.jobs.get(hash) === job) s.jobs.delete(hash); }, job.error ? 2000 : 0).unref?.();
    }
  })();
  return job;
}

/**
 * Parses Range (same specification as parseRange in vite-plugin-media, single-range)
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

/**
 * Passes through this segment directly from remote (not cached): Range start point is far
 * beyond the written-to-disk position
 */
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
 * Called by the read route when this hash is not found in the local content store.
 * Returns `true`: already answered (served during pull, pass-through, or 404 returned when remote
 * also lacks it); returns `false`: not connected to a remote asset service, caller returns 404 itself.
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
      // Remote response without length: wait for the whole file to be written to disk before serving as a normal file
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
    // Uses its own handle to read temporary files: the handle remains valid after renaming upon
    // completion (libuv opens with FILE_SHARE_DELETE on Windows)
    let fh;
    try {
      fh = await fs.open(job.final ?? job.tmp, 'r');
    } catch {
      // Exactly at this moment pulling completed and the file was renamed
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
 * Prefetch queue
 * ------------------------------------------------------------------ */

/**
 * Replaces the prefetch manifest (ordered; sorted by page according to `prefetchOrder`). Only
 * effective when connected to a remote asset service; ignored otherwise.
 * Returns the number of hashes queued this time.
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
      // Low priority: yields when on-demand pull is serving
      if (s.onDemand > 0) { await new Promise((r) => setTimeout(r, YIELD_POLL_MS)); continue; }
      const gen = s.queueGen;
      const hash = s.queue.shift();
      if (await store.resolve(hash)) continue;
      const job = startJob(hash, store, 'prefetch');
      await job.finished;
      if (gen !== s.queueGen) continue; // Manifest was replaced: continue following the new manifest
    }
  } finally {
    s.running = false;
  }
}

/* ------------------------------------------------------------------ *
 * Whether everything has arrived on the current asset service (intercept before export)
 * ------------------------------------------------------------------ */

/**
 * Identifies which of these hashes are not yet `complete` on the **currently connected asset service**.
 * Queries its `chunks` when connected to a remote asset service (whether local cache has been written
 * to disk does not count, A1 "Tier switch criterion"); checks the local content store on the local
 * asset service when not connected to remote.
 * Those that cannot be queried (network errors) are also counted as not having fully arrived.
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

/** Unit tests only: clears all state */
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
