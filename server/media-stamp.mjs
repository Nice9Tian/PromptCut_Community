import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 帧管线的素材戳(`_frameSourceStamp`):`FramePipeline.entry()` 把它塞进每条素材记录,
 * `frameIdentity` 按它算整场景键 —— 素材的字节变了,键就得变,旧的帧库条目才不会被当成新的命中。
 *
 * **预渲染进程不直接读素材服务的存储目录**(`docs/semantics/product/asset-service.md`「职责」
 * 第三条;`docs/semantics/product/rendering.md`「重管线:预渲染」)。以前这里按
 * `card-media-path.mjs` 把 URL 换成本地路径再 `fs.stat`,用 `${size}:${mtimeMs}` 当戳;现在:
 *
 *   - **有内容哈希的**(`m.hash`,或 `url` 是 `/@media/<hash>[.ext]`):戳就是哈希。按哈希寻址的内容
 *     写入后不可变,哈希相同字节就相同,不用问任何人。
 *   - **没有哈希的**(迁移期按文件名存的 `/@media/<文件名>`、老 `.proc` 的 `path` /
 *     `/api/media/file?path=`):向素材服务发 `HEAD`,戳 = `Content-Length:Last-Modified`。
 *     素材服务不可达、`HEAD` 失败 → `'missing'`(和以前 stat 失败一样)。结果按 URL 缓存
 *     `MEDIA_STAMP_TTL_MS`,每次 `entry()` 不会对 N 条素材各发一次请求。
 *   - **`/@export/<id>/media/…`**:这一趟导出**自己的产物目录**(导出开始时从暂存区挪进
 *     `export-<id>/media/`,`vite-plugin-export.ts`),不是素材库里的内容,不归素材服务管 ——
 *     和导出页、`mux-audio.mjs` 一样照旧在本地 `stat`。
 *   - 其余(`blob:`、`data:`、外部 http 地址):不打戳,和以前一样。
 *
 * 地址怎么拼(哈希 → `/@media/<hash>`、老路径 → `/api/media/file?path=`、文件名 → `/@media/<文件名>`)
 * 不在这里重写一遍:由调用方注入 `mediaUrl(m)`(`vite-plugin-frames.ts` 传的是
 * `server/vision/ffmpeg-frames.ts` 的 `mediaSourceOf`,基址按 `server/asset-client.ts` 定)。
 */

/** HEAD 结果缓存多久。拖动时间轴每拍都会进一次 `entry()`,5 秒内同一条素材只问一次 */
export const MEDIA_STAMP_TTL_MS = 5000;
/** 一次 HEAD 最多等多久;素材服务就在本机,正常几毫秒 */
export const MEDIA_STAMP_TIMEOUT_MS = 2000;

const HASH = /^[0-9a-f]{64}$/;
const HASH_NAME = /^([0-9a-f]{64})(?:\.[a-z0-9]+)?$/;

/**
 * 素材的内容哈希:`m.hash`,或 `url` 是 `/@media/<hash>[.ext]`。按哈希寻址的内容写入后不可变,
 * 所以它可以直接当缓存键;没有哈希的(迁移期按文件名存的、老 .proc 的绝对路径)返回 null。
 * (`server/vision/ffmpeg-frames.ts` 从这里转出同名函数。)
 */
export function mediaHashOf(m) {
  const hash = String(m?.hash || '').toLowerCase();
  if (HASH.test(hash)) return hash;
  const url = String(m?.url || '').split('?')[0];
  if (!url.startsWith('/@media/')) return null;
  const hit = HASH_NAME.exec(url.slice('/@media/'.length).toLowerCase());
  return hit ? hit[1] : null;
}

/**
 * `/@export/<id>/media/<文件>` → 本地文件(这一趟导出自己的产物目录),越界或不是这种地址回 null。
 * `exportRoot` = 导出根目录(`PROMPTCUT_EXPORT_DIR`,缺省帧库目录的上一级 `out/`)。
 */
export function exportMediaFile(url, exportRoot) {
  const raw = String(url || '');
  if (!raw.startsWith('/@export/')) return null;
  let relative;
  try { relative = decodeURIComponent(raw.slice('/@export/'.length).split('?')[0]); } catch { return null; }
  const match = /^([^/]+)\/media\/(.+)$/.exec(relative);
  if (!match || match[2].split('/').some(part => !part || part === '.' || part === '..')) return null;
  const base = path.resolve(exportRoot, `export-${match[1]}/media`);
  const file = path.resolve(base, match[2]);
  return file.startsWith(base + path.sep) ? file : null;
}

/** 以前靠本地路径打戳的那几种地址 —— 只有它们要问素材服务 */
function needsServiceStamp(m) {
  if (m?.path) return true;
  const url = String(m?.url || '');
  return url.startsWith('/api/media/file?') || url.startsWith('/@media/');
}

/**
 * 造一个打戳器。
 *
 *   `mediaUrl(m)`  → 素材服务上这条素材的绝对 HTTP 地址,取不到(素材服务不可达)回 null;
 *   `exportRoot()` → `/@export/` 地址落在哪个目录下;
 *   `fetch` / `now` / `ttlMs` 给单测替换。
 *
 * `stamp(m)` 回戳(字符串),不该打戳的回 undefined。
 */
export function createMediaStamper({ mediaUrl = () => null, exportRoot = () => null, fetch: doFetch = globalThis.fetch, now = Date.now, ttlMs = MEDIA_STAMP_TTL_MS, timeoutMs = MEDIA_STAMP_TIMEOUT_MS, ownership = null } = {}) {
  /** url → { at, value: Promise<string> } —— 存 Promise,同一时刻的并发请求共用一次 HEAD */
  const cache = new Map();
  const head = url => {
    const hit = cache.get(url);
    if (hit && now() - hit.at < ttlMs) return hit.value;
    const value = (async () => {
      try {
        const res = await doFetch(url, { method: 'HEAD', signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return 'missing';
        return `${res.headers.get('content-length') ?? ''}:${res.headers.get('last-modified') ?? ''}`;
      } catch { return 'missing'; }
    })();
    cache.set(url, { at: now(), value });
    // 过期的条目顺手清掉,别让一个长跑的预渲染进程把每个见过的地址都攒着
    if (cache.size > 256) for (const [key, entry] of cache) if (now() - entry.at >= ttlMs) cache.delete(key);
    return value;
  };
  return {
    async stamp(m) {
      await ownership?.assert();
      if (ownership && m?.projectId && m.projectId !== ownership.projectId) throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch' });
      const hash = mediaHashOf(m);
      if (hash) return hash;
      const exported = exportMediaFile(m?.url, exportRoot() || '.');
      if (exported && !ownership) {
        try { const stat = await fs.stat(exported); return `${stat.size}:${stat.mtimeMs}`; }
        catch { return 'missing'; }
      }
      if (!needsServiceStamp(m)) return undefined;
      const url = mediaUrl(m);
      if (!url) return 'missing';
      return head(url);
    },
    /** 诊断 / 单测:缓存里有几条 */
    get size() { return cache.size; },
  };
}
