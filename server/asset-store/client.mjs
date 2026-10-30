/**
 * 素材服务的 HTTP 客户端（契约 `docs/plan/artifact-transfer-contract.md` 第 2 节）。
 *
 * 渲染节点、预渲染进程这些「像外部客户端一样」的角色经它按内容哈希推拉字节
 * （`docs/semantics/product/asset-service.md`「职责」「预渲染的产物」）。
 * 服务端的路由与规则见 `server/asset-service.ts` 文件头：`<base>/<ns>/<hash>…`，`<ns>` ∈ `media` | `snap` | `px`。
 * 只用 Node 内置模块（全局 `fetch`、`node:crypto`）。
 *
 * - `put`：算 sha256 → 问 `chunks`，已 `complete` 就不传 → 只补 `received` 里缺的片 → `complete`。
 *   分片大小以服务端 `chunks` 回的 `chunkSize` 为准（`received` 是按它编号的），服务端没给才用选项里的 `chunkSize`。
 * - `get`：404 回 null；下载后校验 sha256，不符就抛（`code: 'hash-mismatch'`）。
 * - `has`：`chunks` 的 `complete`。
 * - `putFile`（C6.6）：同 `put`，但从磁盘文件逐片读，不整件进内存；每片发出前可 `await` 一个闸（`beforeChunk`）。
 * - `chunks`：原样回 `chunks` 的对账结果。
 * - `complete` 回 400 `incomplete`（`put` / `putFile`）：等一会儿（100 ms、200 ms）重问 `chunks`，已 `complete` 就算成；
 *   否则补传 `received` 里缺的片、再 `complete`，至多补 2 轮，仍不齐照 4xx 抛。为的是两路同时推同一内容时，
 *   老的素材服务会把另一路已答过「收到」的片撤掉（claude/push-incomplete）；新的素材服务不再这样，这一步只是兜底。
 * - 超时：每个请求（含读完回包）各自计时，缺省 30 s（`timeoutMs`），到点用 AbortController 中止；
 *   超时算网络错误，照常重试，重试用完抛出的错误带 `code: 'timeout'`（契约第 10 节第 5 条）。
 * - 重试：网络错误、超时和 5xx 重试，最多 `retries` 次，间隔 200 ms、400 ms、800 ms（再往后继续翻倍）。
 *   每个请求各自计数，所以分片上传就是「按片重试」。4xx 不重试，直接抛，错误对象带 `status` 和回包 `body`。
 * - 票据（M6a，`docs/plan/auth-contract.md` 第 8、11 节）：`ticket: () => string | Promise<string>`，每个请求取一次，
 *   有就放进 `Authorization: Bearer <票据>`，回 null / 空串就不带（连本机回环时不需要票据）。
 *   收到 401 时调一次 `ticket({ refresh: true })` 换一张再重试一次；仍 401 就照 4xx 抛。
 *   集群令牌不再用于素材服务：旧选项 `token` 给了就抛 TypeError，免得调用方以为它还有用。
 * - 票据只进 `Authorization` 头；异常信息里出现票据原文的地方一律换成 `***`，不挂原始错误对象。
 */
import crypto from 'node:crypto';

export const ASSET_CLIENT_NAMESPACES = Object.freeze(['media', 'snap', 'px']);

const HASH = /^[0-9a-f]{64}$/;
const EXT = /^[a-z0-9]{1,8}$/;
/** setTimeout 能表示的最长时限；超过它（含 Infinity）就当不限时，否则 Node 会把它当 1 ms 立刻触发 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** `complete` 回 400 `incomplete` 之后至多补传几轮 */
export const INCOMPLETE_RESYNC_ROUNDS = 2;

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function checkNs(ns) {
  if (!ASSET_CLIENT_NAMESPACES.includes(ns)) throw new TypeError(`素材服务客户端：不认识的命名空间 ${JSON.stringify(ns)}`);
}

function checkHash(hash) {
  const key = String(hash ?? '').toLowerCase();
  if (!HASH.test(key)) throw new TypeError('素材服务客户端：hash 必须是 64 位十六进制 sha256');
  return key;
}

/** 回包：JSON 就解析，否则给文本；空的给 null */
function parseBody(buf, contentType) {
  if (!buf || buf.length === 0) return null;
  const text = buf.toString('utf8');
  if (/json/i.test(String(contentType || ''))) {
    try { return JSON.parse(text); } catch { /* 当文本 */ }
  }
  return text;
}

/**
 * @param {object} options
 * @param {string} options.base  素材服务的 API 基址，形如 `http://192.168.50.96:5460/api/asset`
 * @param {(opts?: { refresh?: boolean }) => (string | null | Promise<string | null>)} [options.ticket]  取素材票据
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {number} [options.chunkSize]  服务端没回 `chunkSize` 时用，缺省 8 MiB
 * @param {number} [options.retries]  网络错误、超时与 5xx 的重试次数，缺省 3
 * @param {number} [options.timeoutMs]  单个请求（含读完回包）的时限，缺省 30000；`Infinity` 或超过 2^31-1 表示不限
 */
export function createAssetClient({
  base, ticket = null, token, fetch = globalThis.fetch, chunkSize = 8 * 1024 * 1024, retries = 3, timeoutMs = 30000,
} = /** @type {any} */ ({})) {
  if (token !== undefined && token !== null) throw new TypeError('createAssetClient：集群令牌不再用于素材服务，改给 ticket()');
  if (ticket !== null && typeof ticket !== 'function') throw new TypeError('createAssetClient：ticket 必须是函数');
  if (typeof base !== 'string' || !/^https?:\/\//i.test(base)) throw new TypeError('createAssetClient：base 必须是 http(s) 地址');
  if (typeof fetch !== 'function') throw new TypeError('createAssetClient：没有可用的 fetch');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError('createAssetClient：chunkSize 必须是正整数');
  if (!Number.isSafeInteger(retries) || retries < 0) throw new TypeError('createAssetClient：retries 必须是非负整数');
  if (typeof timeoutMs !== 'number' || !(timeoutMs > 0)) throw new TypeError('createAssetClient：timeoutMs 必须是正数');
  const root = base.replace(/\/+$/, '');
  /** 用过的票据：异常信息里出现就抹掉 */
  const secrets = new Set();

  /** 把票据原文从文字里抹掉 */
  const scrub = (text) => {
    let s = String(text ?? '');
    for (const secret of secrets) s = s.split(secret).join('***');
    return s;
  };

  /** 取一张票据；没有给 null */
  async function currentTicket(refresh) {
    if (!ticket) return null;
    const t = await ticket(refresh ? { refresh: true } : undefined);
    if (typeof t !== 'string' || t === '') return null;
    secrets.add(t);
    return t;
  }

  function httpError(what, status, body) {
    const detail = body && typeof body === 'object' && 'error' in body ? String(body.error) : (typeof body === 'string' ? body.slice(0, 200) : '');
    const err = new Error(scrub(`素材服务 ${what} 回 ${status}${detail ? `：${detail}` : ''}`));
    /** @type {any} */ (err).status = status;
    /** @type {any} */ (err).body = body;
    return err;
  }

  function networkError(what, cause) {
    const name = cause && typeof cause === 'object' && 'name' in cause ? String(cause.name) : 'Error';
    const code = cause && typeof cause === 'object' ? (cause.code ?? cause.cause?.code) : undefined;
    const msg = cause instanceof Error ? cause.message : String(cause);
    const inner = cause && typeof cause === 'object' && cause.cause instanceof Error ? `（${cause.cause.message}）` : '';
    const err = new Error(scrub(`素材服务 ${what} 网络错误：${name}: ${msg}${inner}`));
    /** @type {any} */ (err).code = 'network';
    if (code !== undefined) /** @type {any} */ (err).cause = { name, code: scrub(code) };
    return err;
  }

  function timeoutError(what) {
    const err = new Error(scrub(`素材服务 ${what} 超时（${timeoutMs} ms 没有完成）`));
    /** @type {any} */ (err).code = 'timeout';
    return err;
  }

  /**
   * 发一个请求并把回包读完；网络错误与 5xx 重试。回 `{ status, body, raw }`（4xx 原样回，由调用方决定抛不抛）。
   * @param {string} method
   * @param {string} rel  相对基址的路径
   * @param {{ headers?: Record<string, string>, body?: Buffer }} [init]
   */
  async function request(method, rel, init = {}) {
    const first = await attempt(method, rel, init, false);
    if (first.status !== 401 || !ticket) return first;
    // 票据可能过期或已作废：换一张再试一次
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
      // 到点中止；假 fetch 不认 signal 时也靠这个 promise 按时脱身
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

  /** 2xx 之外一律抛（404 由调用方先挑出去） */
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
   * `POST <ns>/<hash>/complete`；回 400 `incomplete` 时重问 `chunks`、经 `resend(have)` 补传缺的片再收尾（见文件头）。
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
      if (!(bytes instanceof Uint8Array)) throw new TypeError('素材服务客户端：put 的 bytes 必须是 Buffer / Uint8Array');
      const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const size = buf.length;
      if (size === 0) throw new RangeError('素材服务客户端：不能上传空内容（服务端要求 X-Media-Size 为正整数）');
      let extName = '';
      if (ext !== undefined && ext !== null && ext !== '') {
        extName = String(ext).trim().toLowerCase().replace(/^\./, '');
        if (!EXT.test(extName)) throw new TypeError(`素材服务客户端：扩展名不合法 ${JSON.stringify(ext)}`);
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
     * 从磁盘上的文件分片上传(C6.6 素材上传队列用):不把整件读进内存,每次只读一片。
     * 规则与 `put` 相同:先问 `chunks`,已 `complete` 就不传;只补 `received` 里缺的片;最后 `complete`。
     * 分片大小以服务端 `chunks` 回的 `chunkSize` 为准。
     *
     * `hash` 由调用方给(本地内容库的键就是它,4 GB 的文件不用再算一遍);服务端 `complete` 时照样按 sha256 校验全件,
     * 不符回 409 —— 这里抛出的错误带 `status: 409`。
     * `beforeChunk(n)` 在每一片发出前 `await`,可以回一个函数,这一片发完(成功或失败)后调它 —— 带宽闸就接在这里。
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
      if (size === 0) throw new RangeError('素材服务客户端：不能上传空内容（服务端要求 X-Media-Size 为正整数）');
      let extName = '';
      if (ext !== undefined && ext !== null && ext !== '') {
        extName = String(ext).trim().toLowerCase().replace(/^\./, '');
        if (!EXT.test(extName)) throw new TypeError(`素材服务客户端：扩展名不合法 ${JSON.stringify(ext)}`);
      }
      const st = await chunkState(ns, key);
      if (st.complete) return { hash: key, size, uploaded: false, sent: [] };
      if (st.size !== null && st.size !== size) {
        const err = new Error(`素材服务 ${ns}/${key}：服务端登记的大小 ${st.size} 与本地文件 ${size} 不符`);
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
            if (r.bytesRead === 0) throw new Error(`素材服务客户端：读 ${filePath} 第 ${n} 片时文件变短了`);
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
     * 这一档在素材服务上的分片状态(`GET <ns>/<hash>/chunks`):`{ size, chunkSize, received, complete }`。
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
        const err = new Error(`素材服务 GET ${rel}：取回的字节 sha256 不符（实际 ${actual}）`);
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
