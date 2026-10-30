/**
 * 页面上传器:把纯浏览器节点生成的快照块推到素材服务(M7 契约第 4.5 节、D7「父页推」)。
 *
 * 分片接口照 `server/asset-service.ts` 文件头(`snap`、`px` 命名空间与 `media` 同规则):
 *
 *   `GET <ns>/<hash>/chunks` 对账 → 缺的分片 `PUT <ns>/<hash>/<n>`(每片带 `X-Media-Size`、`X-Media-Ext`)→ `POST <ns>/<hash>/complete`
 *
 * 分片 8 MiB;HTML 快照与小尺寸 WebP 都远小于它,一般一片。已经 `complete` 的哈希不再推(按内容寻址,天然去重)。
 * 同一哈希按单飞推(同时来的第二次等第一次的结果);收尾回 `400 incomplete` 时重查 chunks、补传一次再收尾(M7 探针 P4 的撞车)。
 * 写入凭写票据:`Authorization: Bearer <rw 票据>`(`auth.ticket { kind: 'asset', access: 'rw' }`,宿主按时限续签);
 * 回 401 就强制换一张新的、这一步重试一次。票据不进地址、不进日志与诊断。
 *
 * `sha256Hex` 用 WebCrypto(页面与 Node 22 都有 `crypto.subtle`)。
 *
 * 本模块属于 render 这一层(`src/online/`):不引 editor,不读编译期常量;网络经注入的 `fetch`。
 */

/** 分片大小(同 `asset-service.ts` 的 `chunkSize`) */
export const CHUNK_SIZE = 8 * 1024 * 1024;

export type Namespace = "snap" | "px" | "media";

export interface UploaderDeps {
  /** 素材服务基址(`…/api/asset`);没连上回 null */
  base: () => string | null;
  /** 写票据;`force` 为真时不用缓存、换一张新的。取不到回 null */
  ticket: (force?: boolean) => Promise<string | null>;
  fetch?: typeof fetch;
}

export interface UploaderStats {
  /** 真推上去的块数与字节数 */
  pushed: number;
  pushedBytes: number;
  /** 素材服务上已经有、跳过的块 */
  skipped: number;
  failed: number;
  /** 401 之后换票据重试的次数 */
  reauth: number;
  /** 收尾回 `incomplete` 之后重查 chunks 的次数 */
  recheck: number;
  lastError: string | null;
  /** 每次请求的时间构成(毫秒,累计):等票据、`fetch` 到响应头、读响应体;`requests` 是请求次数 */
  ms: { requests: number; ticket: number; fetch: number; body: number };
}

export interface SnapUploader {
  /** 这一块在素材服务上是不是已经收全(问不到算不在) */
  has(ns: Namespace, hash: string): Promise<boolean>;
  /** 推一块;回 `pushed` 或 `skipped`(已有),失败抛(`retryable` 为真) */
  put(ns: Namespace, hash: string, bytes: Uint8Array, ext: string): Promise<"pushed" | "skipped">;
  stats(): UploaderStats;
}

/** 字节的 sha256(小写十六进制) */
export async function sha256Hex(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buf as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const HEX64 = /^[a-f0-9]{64}$/;
const fail = (message: string, extra: Record<string, unknown> = {}) => Object.assign(new Error(message), { retryable: true, ...extra });

export function createSnapUploader(deps: UploaderDeps): SnapUploader {
  const f = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const stats: UploaderStats = { pushed: 0, pushedBytes: 0, skipped: 0, failed: 0, reauth: 0, recheck: 0, lastError: null, ms: { requests: 0, ticket: 0, fetch: 0, body: 0 } };
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const urlOf = (ns: Namespace, hash: string, tail: string) => {
    const base = deps.base();
    if (!base) throw fail("还没有远程素材服务");
    return `${base.replace(/\/+$/, "")}/${ns}/${hash}${tail}`;
  };

  /** 带写票据发一次;401 换一张新票据重试一次 */
  const authed = async (url: string, init: RequestInit): Promise<Response> => {
    const go = async (force: boolean) => {
      const t0 = now();
      const ticket = await deps.ticket(force);
      const t1 = now();
      const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
      if (ticket) headers.Authorization = `Bearer ${ticket}`;
      const res = await f(url, { ...init, headers });
      stats.ms.requests++;
      stats.ms.ticket += t1 - t0;
      stats.ms.fetch += now() - t1;
      return res;
    };
    const res = await go(false);
    if (res.status !== 401) return res;
    stats.reauth++;
    return go(true);
  };

  /** 在飞的推送:`<ns>/<hash>` → 结果 */
  const inflight = new Map<string, Promise<"pushed" | "skipped">>();

  /** 缺的片 PUT 上去 */
  const putMissing = async (ns: Namespace, hash: string, bytes: Uint8Array, ext: string, received: Set<number>) => {
    const size = bytes.length;
    const count = Math.max(1, Math.ceil(size / CHUNK_SIZE));
    for (let n = 0; n < count; n++) {
      if (received.has(n)) continue;
      const body = bytes.subarray(n * CHUNK_SIZE, Math.min(size, (n + 1) * CHUNK_SIZE));
      const res = await authed(urlOf(ns, hash, `/${n}`), {
        method: "PUT",
        headers: { "Content-Type": "application/octet-stream", "X-Media-Size": String(size), "X-Media-Ext": ext },
        body: body as BodyInit,
      });
      if (!res.ok) throw fail(`推 ${ns} 第 ${n} 片回 ${res.status}`, { status: res.status });
    }
  };

  /** 推一块:对账 → 缺的片 → 收尾;收尾回 `incomplete`(别人的请求与这一次交错)就重查 chunks、补传一次再收尾 */
  const pushOnce = async (ns: Namespace, hash: string, bytes: Uint8Array, ext: string): Promise<"pushed" | "skipped"> => {
    try {
      if (!HEX64.test(hash)) throw fail(`哈希不对:${hash.slice(0, 16)}`, { retryable: false });
      if (!bytes.length) throw fail("不能推空块", { retryable: false });
      let state = await chunksOf(ns, hash);
      if (state.complete) { stats.skipped++; return "skipped"; }
      for (let attempt = 0; ; attempt++) {
        await putMissing(ns, hash, bytes, ext, state.received);
        const done = await authed(urlOf(ns, hash, "/complete"), { method: "POST" });
        if (done.ok) break;
        const body = await done.json().catch(() => null) as { error?: string } | null;
        if (done.status === 400 && body?.error === "incomplete" && attempt === 0) {
          stats.recheck++;
          state = await chunksOf(ns, hash);
          if (state.complete) break;
          continue;
        }
        throw fail(`收尾 ${ns} 回 ${done.status}${body?.error ? ` ${body.error}` : ""}`, { status: done.status });
      }
      stats.pushed++;
      stats.pushedBytes += bytes.length;
      return "pushed";
    } catch (e) {
      stats.failed++;
      stats.lastError = String((e as Error)?.message ?? e);
      throw e;
    }
  };

  const chunksOf = async (ns: Namespace, hash: string) => {
    const res = await authed(urlOf(ns, hash, "/chunks"), { method: "GET", cache: "no-store" });
    if (!res.ok) throw fail(`对账 ${ns} 回 ${res.status}`, { status: res.status });
    const tb = now();
    const j = (await res.json()) as { size?: number | null; received?: number[]; complete?: boolean };
    stats.ms.body += now() - tb;
    return { complete: j?.complete === true, received: new Set(Array.isArray(j?.received) ? j.received : []) };
  };

  return {
    async has(ns, hash) {
      if (!HEX64.test(hash)) return false;
      try { return (await chunksOf(ns, hash)).complete; } catch { return false; }
    },
    put(ns, hash, bytes, ext) {
      // 按哈希单飞:同一块已经在推,等它的结果(M7 探针 P4:相邻帧内容相同的块并发推会撞成 `incomplete`)
      const key = `${ns}/${hash}`;
      const flying = inflight.get(key);
      if (flying) return flying.then(() => { stats.skipped++; return "skipped" as const; });
      const work = pushOnce(ns, hash, bytes, ext).finally(() => { inflight.delete(key); });
      inflight.set(key, work);
      return work;
    },
    stats: () => ({ ...stats, ms: { ...stats.ms } }),
  };
}
