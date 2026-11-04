/**
 * HTTP client for asset service (contract `docs/plan/artifact-transfer-contract.md` section 2).
 *
 * Roles like render nodes and prerender processes that act "like external clients" push and pull
 * bytes through it by content hash (`docs/semantics/product/asset-service.md` "Responsibilities",
 * "Prerender outputs").
 * Server routes and rules are in `server/asset-service.ts` file header: `<base>/<ns>/<hash>…`,
 * `<ns>` ∈ `media` | `snap` | `px`.
 * Uses only Node built-in modules (global `fetch`, `node:crypto`).
 *
 * - `put`: calculates sha256 → queries `chunks`, skips upload if already `complete` → only uploads
 *   missing chunks in `received` → `complete`. Chunk size defaults to `chunkSize` returned by
 *   server `chunks` (`received` is numbered by it); uses `chunkSize` from options only if
 *   server omitted it.
 * - `get`: returns null on 404; verifies sha256 after download, throws on mismatch
 *   (`code: 'hash-mismatch'`).
 * - `has`: `complete` from `chunks`.
 * - `putFile` (C6.6): same as `put`, but reads from disk file chunk by chunk without reading the
 *   whole file into memory; can `await` a gate (`beforeChunk`) before each chunk is sent.
 * - `chunks`: returns the reconciliation result of `chunks` as is.
 * - `complete` returns 400 `incomplete` (`put` / `putFile`): waits briefly (100 ms, 200 ms) and
 *   re-queries `chunks`; succeeds if already `complete`; otherwise re-uploads missing chunks in
 *   `received` and calls `complete` again, retrying up to 2 rounds; throws as 4xx if still
 *   incomplete. This handles cases where two concurrent streams push the same content and the
 *   old asset service revoked chunks that another stream had already answered "received"
 *   (claude/push-incomplete); new asset service no longer does this, so this step is just a fallback.
 * - Timeout: each request (including draining response) is timed individually, default 30 s
 *   (`timeoutMs`), aborted with AbortController when expired; timeouts count as network errors
 *   and retry as usual; throws error with `code: 'timeout'` when retries are exhausted
 *   (contract section 10 item 5).
 * - Retries: network errors, timeouts, and 5xx are retried up to `retries` times, with intervals
 *   200 ms, 400 ms, 800 ms (doubling thereafter). Each request is counted individually, so chunked
 *   upload retries on a per-chunk basis. 4xx is not retried and throws directly, with error object
 *   containing `status` and response `body`.
 * - Ticket (M6a, `docs/plan/auth-contract.md` sections 8 and 11):
 *   `ticket: () => string | Promise<string>`, fetched once per request; included in
 *   `Authorization: Bearer <ticket>` if present, omitted if returning null / empty string
 *   (not required when connecting to local loopback). When receiving 401, calls
 *   `ticket({ refresh: true })` to get a new one and retries once; throws as 4xx if still 401.
 *   Cluster tokens are no longer used for asset service: passing legacy option `token` throws
 *   TypeError to avoid callers assuming it still works.
 * - Tickets are only placed in `Authorization` header; any raw ticket string appearing in error
 *   messages is replaced with `***`, without attaching the original error object.
 */
import crypto from 'node:crypto';

export const ASSET_CLIENT_NAMESPACES = Object.freeze(['media', 'snap', 'px']);

const HASH = /^[0-9a-f]{64}$/;
const EXT = /^[a-z0-9]{1,8}$/;
/** Maximum delay setTimeout can represent; values exceeding it (including Infinity) mean no timeout, otherwise Node treats it as 1 ms and fires immediately */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Maximum number of re-upload rounds after `complete` returns 400 `incomplete` */
export const INCOMPLETE_RESYNC_ROUNDS = 2;

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function checkNs(ns) {
  if (!ASSET_CLIENT_NAMESPACES.includes(ns)) throw new TypeError(`Asset service client: unknown namespace ${JSON.stringify(ns)}`);
}

function checkHash(hash) {
  const key = String(hash ?? '').toLowerCase();
  if (!HASH.test(key)) throw new TypeError('Asset service client: hash must be a 64-character hex sha256');
  return key;
}

/** Response: parses if JSON, otherwise returns text; returns null if empty */
function parseBody(buf, contentType) {
  if (!buf || buf.length === 0) return null;
  const text = buf.toString('utf8');
  if (/json/i.test(String(contentType || ''))) {
    try { return JSON.parse(text); } catch { /* Treat as text */ }
  }
  return text;
}

/**
 * @param {object} options
 * @param {string} options.base  API base URL of asset service, formatted like `http://192.168.50.96:5460/api/asset`
 * @param {(opts?: { refresh?: boolean }) => (string | null | Promise<string | null>)} [options.ticket]  Fetches asset ticket
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {number} [options.chunkSize]  Used when server does not return `chunkSize`, default 8 MiB
 * @param {number} [options.retries]  Retry count for network errors, timeouts, and 5xx, default 3
 * @param {number} [options.timeoutMs]  Timeout for a single request (including draining response), default 30000; `Infinity` or greater than 2^31-1 indicates no limit
 */
export function createAssetClient({
  base, ticket = null, token, fetch = globalThis.fetch, chunkSize = 8 * 1024 * 1024, retries = 3, timeoutMs = 30000,
} = /** @type {any} */ ({})) {
  if (token !== undefined && token !== null) throw new TypeError('createAssetClient: the cluster token is no longer used for the asset service, pass ticket() instead');
  if (ticket !== null && typeof ticket !== 'function') throw new TypeError('createAssetClient: ticket must be a function');
  if (typeof base !== 'string' || !/^https?:\/\//i.test(base)) throw new TypeError('createAssetClient: base must be an http(s) address');
  if (typeof fetch !== 'function') throw new TypeError('createAssetClient: no fetch available');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError('createAssetClient: chunkSize must be a positive integer');
  if (!Number.isSafeInteger(retries) || retries < 0) throw new TypeError('createAssetClient: retries must be a non-negative integer');
  if (typeof timeoutMs !== 'number' || !(timeoutMs > 0)) throw new TypeError('createAssetClient: timeoutMs must be a positive number');
  const root = base.replace(/\/+$/, '');
  /** Used tickets: redacted if appearing in error messages */
  const secrets = new Set();

  /** Redacts raw ticket text from string */
  const scrub = (text) => {
    let s = String(text ?? '');
    for (const secret of secrets) s = s.split(secret).join('***');
    return s;
  };

  /** Fetches a ticket; returns null if absent */
  async function currentTicket(refresh) {
    if (!ticket) return null;
    const t = await ticket(refresh ? { refresh: true } : undefined);
    if (typeof t !== 'string' || t === '') return null;
    secrets.add(t);
    return t;
  }

  function httpError(what, status, body) {
    const detail = body && typeof body === 'object' && 'error' in body ? String(body.error) : (typeof body === 'string' ? body.slice(0, 200) : '');
    const err = new Error(scrub(`Asset service ${what} returned ${status}${detail ? `: ${detail}` : ''}`));
    /** @type {any} */ (err).status = status;
    /** @type {any} */ (err).body = body;
    return err;
  }

  function networkError(what, cause) {
    const name = cause && typeof cause === 'object' && 'name' in cause ? String(cause.name) : 'Error';
    const code = cause && typeof cause === 'object' ? (cause.code ?? cause.cause?.code) : undefined;
    const msg = cause instanceof Error ? cause.message : String(cause);
    const inner = cause && typeof cause === 'object' && cause.cause instanceof Error ? ` (${cause.cause.message})` : '';
    const err = new Error(scrub(`Asset service ${what} network error: ${name}: ${msg}${inner}`));
    /** @type {any} */ (err).code = 'network';
    if (code !== undefined) /** @type {any} */ (err).cause = { name, code: scrub(code) };
    return err;
  }

  function timeoutError(what) {
    const err = new Error(scrub(`Asset service ${what} timed out (not completed within ${timeoutMs} ms)`));
    /** @type {any} */ (err).code = 'timeout';
    return err;
  }

  /**
   * Sends a request and drains response; retries on network errors and 5xx. Returns
   * `{ status, body, raw }` (4xx returned as is, caller decides whether to throw).
   * @param {string} method
   * @param {string} rel  Path relative to base URL
   * @param {{ headers?: Record<string, string>, body?: Buffer }} [init]
   */
  async function request(method, rel, init = {}) {
    const first = await attempt(method, rel, init, false);
    if (first.status !== 401 || !ticket) return first;
    // Ticket may have expired or been invalidated: fetch a new one and retry once
    return attempt(method, rel, init, true);
  }

  async function attempt(method, rel, { headers = {}, body } = {}, refresh) {
    const what = `${method} ${rel}`;
    const h = { ...headers };
    const t = await currentTicket(refresh);
    if (t) h.Authorization = `Bearer ${t}`;
    let lastError = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) await sleep(200 * 2 ** (attempt - 1));
      let res;
      let raw;
      let timedOut = false;
      const ac = new AbortController();
      // Abort on timeout; also relies on this promise to escape on time when a mock fetch ignores signal
      const expired = new Promise((_, reject) => {
        ac.signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
      });
      expired.catch(() => {});
      const timer = timeoutMs <= MAX_TIMER_MS ? setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs) : null;
      try {
        res = await Promise.race([fetch(`${root}/${rel}`, { method, headers: h, body, signal: ac.signal }), expired]);
        raw = Buffer.from(await Promise.race([res.arrayBuffer(), expired]));
      } catch (err) {
        lastError = timedOut ? timeoutError(what) : networkError(what, err);
        continue;
      } finally {
        if (timer) clearTimeout(timer);
      }
      const parsed = parseBody(raw, res.headers.get('content-type'));
      if (res.status >= 500) { lastError = httpError(what, res.status, parsed); continue; }
      return { status: res.status, body: parsed, raw };
    }
    throw lastError;
  }

  /** Throws on anything outside 2xx (404 is handled first by caller) */
  function ensureOk(what, r) {
    if (r.status < 200 || r.status >= 300) throw httpError(what, r.status, r.body);
    return r;
  }

  async function chunkState(ns, hash) {
    const rel = `${ns}/${hash}/chunks`;
    const r = ensureOk(`GET ${rel}`, await request('GET', rel));
    const st = r.body && typeof r.body === 'object' ? r.body : {};
    return {
      size: Number.isSafeInteger(st.size) ? st.size : null,
      chunkSize: Number.isSafeInteger(st.chunkSize) && st.chunkSize > 0 ? st.chunkSize : chunkSize,
      received: Array.isArray(st.received) ? st.received.filter((n) => Number.isSafeInteger(n)) : [],
      complete: st.complete === true,
    };
  }

  /**
   * `POST <ns>/<hash>/complete`; when returning 400 `incomplete`, re-queries `chunks`, re-uploads
   * missing chunks via `resend(have)`, and finalizes again (see file header).
   * @param {string} ns
   * @param {string} hash
   * @param {(have: Set<number>) => Promise<void>} resend
   */
  async function completeWithResync(ns, hash, resend) {
    const rel = `${ns}/${hash}/complete`;
    for (let round = 0; ; round++) {
      const r = await request('POST', rel);
      if (r.status >= 200 && r.status < 300) return;
      const incomplete = r.status === 400 && r.body && typeof r.body === 'object' && r.body.error === 'incomplete';
      if (!incomplete || round >= INCOMPLETE_RESYNC_ROUNDS) throw httpError(`POST ${rel}`, r.status, r.body);
      await sleep(100 * 2 ** round);
      const st = await chunkState(ns, hash);
      if (st.complete) return;
      await resend(new Set(st.received));
    }
  }

  return {
    base: root,

    /**
     * @param {'media' | 'snap' | 'px'} ns
     * @param {Buffer | Uint8Array} bytes
     * @param {{ ext?: string }} [options]
     * @returns {Promise<{ hash: string, size: number, uploaded: boolean }>}
     */
    async put(ns, bytes, { ext } = {}) {
      checkNs(ns);
      if (!(bytes instanceof Uint8Array)) throw new TypeError('Asset service client: bytes for put must be Buffer / Uint8Array');
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const size = buf.length;
      if (size === 0) throw new RangeError('Asset service client: cannot upload empty content (the server requires X-Media-Size to be a positive integer)');
      let extName = '';
      if (ext !== undefined && ext !== null && ext !== '') {
        extName = String(ext).trim().toLowerCase().replace(/^\./, '');
        if (!EXT.test(extName)) throw new TypeError(`Asset service client: invalid extension ${JSON.stringify(ext)}`);
      }
      const hash = sha256Hex(buf);

      const st = await chunkState(ns, hash);
      if (st.complete) return { hash, size, uploaded: false };

      const cs = st.chunkSize;
      const count = Math.max(1, Math.ceil(size / cs));
      const headers = { 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(size) };
      if (extName) headers['X-Media-Ext'] = extName;
      const sendMissing = async (have) => {
        for (let n = 0; n < count; n++) {
          if (have.has(n)) continue;
          const rel = `${ns}/${hash}/${n}`;
          const part = buf.subarray(n * cs, Math.min(size, (n + 1) * cs));
          ensureOk(`PUT ${rel}`, await request('PUT', rel, { headers, body: part }));
        }
      };
      await sendMissing(new Set(st.received));
      await completeWithResync(ns, hash, sendMissing);
      return { hash, size, uploaded: true };
    },

    /**
     * Chunked upload from file on disk (used by C6.6 asset upload queue): does not load whole file into
     * memory, reads only one chunk at a time. Rules are identical to `put`: queries `chunks` first,
     * skips upload if already `complete`; only uploads missing chunks in `received`; finally calls
     * `complete`. Chunk size follows `chunkSize` returned by server's `chunks`.
     *
     * `hash` is provided by caller (it is the key in local content store, avoiding recalculating 4 GB
     * files); server verifies whole file against sha256 upon `complete` as usual, returning 409 on
     * mismatch: errors thrown here have `status: 409`.
     * Before sending each chunk, `await` `beforeChunk(n)`, which may return a callback invoked after
     * the chunk finishes (success or failure): the bandwidth gate connects here.
     *
     * @param {'media' | 'snap' | 'px'} ns
     * @param {string} filePath
     * @param {{ hash: string, ext?: string, beforeChunk?: (n: number) => any }} options
     * @returns {Promise<{ hash: string, size: number, uploaded: boolean, sent: number[] }>}
     */
    async putFile(ns, filePath, { hash, ext, beforeChunk } = /** @type {any} */ ({})) {
      checkNs(ns);
      const key = checkHash(hash);
      const { open, stat } = await import('node:fs/promises');
      const size = (await stat(filePath)).size;
      if (size === 0) throw new RangeError('Asset service client: cannot upload empty content (the server requires X-Media-Size to be a positive integer)');
      let extName = '';
      if (ext !== undefined && ext !== null && ext !== '') {
        extName = String(ext).trim().toLowerCase().replace(/^\./, '');
        if (!EXT.test(extName)) throw new TypeError(`Asset service client: invalid extension ${JSON.stringify(ext)}`);
      }
      const st = await chunkState(ns, key);
      if (st.complete) return { hash: key, size, uploaded: false, sent: [] };
      if (st.size !== null && st.size !== size) {
        const err = new Error(`Asset service ${ns}/${key}: size registered on the server ${st.size} does not match local file ${size}`);
        /** @type {any} */ (err).code = 'size-mismatch';
        throw err;
      }
      const cs = st.chunkSize;
      const count = Math.max(1, Math.ceil(size / cs));
      const headers = { 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(size) };
      if (extName) headers['X-Media-Ext'] = extName;
      const sent = [];
      const fh = await open(filePath, 'r');
      const sendMissing = async (have) => {
        for (let n = 0; n < count; n++) {
          if (have.has(n)) continue;
          const start = n * cs;
          const length = Math.min(size, start + cs) - start;
          const part = Buffer.alloc(length);
          let read = 0;
          while (read < length) {
            const r = await fh.read(part, read, length - read, start + read);
            if (r.bytesRead === 0) throw new Error(`Asset service client: file became shorter while reading chunk ${n} of ${filePath}`);
            read += r.bytesRead;
          }
          const release = typeof beforeChunk === 'function' ? await beforeChunk(n) : null;
          try {
            const rel = `${ns}/${key}/${n}`;
            ensureOk(`PUT ${rel}`, await request('PUT', rel, { headers, body: part }));
          } finally {
            if (typeof release === 'function') release();
          }
          sent.push(n);
        }
      };
      try {
        await sendMissing(new Set(st.received));
        await completeWithResync(ns, key, sendMissing);
      } finally {
        await fh.close();
      }
      return { hash: key, size, uploaded: true, sent };
    },

    /**
     * Chunk status of this tier on asset service (`GET <ns>/<hash>/chunks`):
     * `{ size, chunkSize, received, complete }`.
     * @param {'media' | 'snap' | 'px'} ns
     * @param {string} hash
     */
    async chunks(ns, hash) {
      checkNs(ns);
      return chunkState(ns, checkHash(hash));
    },

    /**
     * @param {'media' | 'snap' | 'px'} ns
     * @param {string} hash
     * @returns {Promise<Buffer | null>}
     */
    async get(ns, hash) {
      checkNs(ns);
      const key = checkHash(hash);
      const rel = `${ns}/${key}`;
      const r = await request('GET', rel);
      if (r.status === 404) return null;
      ensureOk(`GET ${rel}`, r);
      const actual = sha256Hex(r.raw);
      if (actual !== key) {
        const err = new Error(`Asset service GET ${rel}: sha256 of fetched bytes does not match (actual ${actual})`);
        /** @type {any} */ (err).code = 'hash-mismatch';
        /** @type {any} */ (err).actual = actual;
        throw err;
      }
      return r.raw;
    },

    /**
     * @param {'media' | 'snap' | 'px'} ns
     * @param {string} hash
     * @returns {Promise<boolean>}
     */
    async has(ns, hash) {
      checkNs(ns);
      return (await chunkState(ns, checkHash(hash))).complete;
    },
  };
}
