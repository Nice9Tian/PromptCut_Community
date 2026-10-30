/**
 * 素材服务的数据层接口 `BlobStore`（契约 `docs/plan/asset-store-contract.md` 第 2 节）。
 *
 * HTTP 层（`server/asset-service.ts`）只经这个接口读写字节，不认识磁盘。现在有两种实现：
 * `fs`（本地内容库，目录布局与第 5 步一致）和 `memory`（测试用）；`oss` 只留插槽。
 * 本文件写明接口，并放两种实现共用的小工具。只引 Node 内置模块。
 *
 * @typedef {object} BlobStat
 * @property {number} size
 * @property {string} ext  不含点、小写；没有扩展名是空串
 * @property {string} contentType
 * @property {number | null} mtimeMs  拿不到修改时间的实现给 null
 *
 * @typedef {object} ChunkStatus
 * @property {number | null} size  从没见过的哈希是 null
 * @property {number} chunkSize
 * @property {number[]} received  升序
 * @property {boolean} complete
 *
 * @typedef {{ status: 'ok', bytes: number }
 *   | { status: 'complete' }
 *   | { status: 'size-mismatch', size: number }
 *   | { status: 'out-of-range', count: number }
 *   | { status: 'length', expected: number, got: number }
 *   | { status: 'discarded' }} PutResult
 *
 * @typedef {{ status: 'ok', size: number, ext: string }
 *   | { status: 'unknown' }
 *   | { status: 'incomplete', missing: number[] }
 *   | { status: 'hash-mismatch', actual: string }} CompleteResult
 *
 * @typedef {object} BlobStore
 * @property {'fs' | 'memory'} kind
 * @property {number} chunkSize
 * @property {(hash: string) => Promise<BlobStat | null>} stat
 *   只认已入库的全件。
 * @property {(hash: string, range?: { start?: number, end?: number }) => Promise<import('node:stream').Readable | null>} read
 *   闭区间，`end` 缺省到末尾；没入库返回 null。
 * @property {(hash: string) => Promise<ChunkStatus>} chunks
 *   从没见过：`size: null`、`received: []`；已入库：全部片号、`complete: true`。
 * @property {(hash: string, n: number, info: { size: number, ext?: string, tier?: string }, source: AsyncIterable<Buffer> | import('node:stream').Readable) => Promise<PutResult>} putChunk
 *   已入库时把 `source` 读完丢掉、不落盘；`size-mismatch`、`out-of-range` 不碰 `source`，由调用方处理请求体。
 *   `tier` 是上传方报的档位（见下「档位」），只认 `small`，别的一律按 `original` 记。
 * @property {(hash: string) => Promise<CompleteResult>} complete
 * @property {(hash: string) => Promise<boolean>} remove
 *   删掉已入库的全件和暂存；删到了返回 true。
 * @property {() => Promise<{ blobs: number, bytes: number, staging: number }>} usage
 *   `staging` 是有暂存的哈希个数。
 * @property {() => Promise<{ stored: InventoryEntry[], staging: InventoryEntry[] }>} inventory
 *   已入库的全件与暂存，各带扩展名和档位（游客视频条数用，`guest-quota.mjs`）。与 `usage` 数的是同一批东西：
 *   `stored` 与 `usage().blobs` 同数；`staging` 里还没登记（没有 meta）的那种不列。
 *
 * @typedef {{ hash: string, ext: string, tier: 'small' | 'original' }} InventoryEntry
 *
 * 共同规则：
 * - 哈希 64 位十六进制，大小写不敏感，一律按小写存取；格式不对抛 TypeError。
 * - 分片数 `max(1, ceil(size / chunkSize))`；除最后一片外每片恰好 `chunkSize` 字节。
 * - `ext` 以最先登记的非空值为准。
 * - 同一哈希的登记、收尾、删除串行执行；分片字节的写入不排队。
 * - 没收到的片：写完、长度核对无误才补上「收到」标记；中途失败、断流、长度不符都不补。
 *   登记时判过「没有标记」之后不再删标记：此后冒出来的标记只能是另一路刚写完补上的。
 * - 已收到的片再传（两路同时推同一内容、或重试与原传赛跑）：不重写、不撤标记，把 `source` 读完核对长度；
 *   长度对回 `ok`，长度不对才撤掉标记回 `length`，读的途中断流照原样抛、标记保留（存着的字节没被碰过）。
 *   原来一律先撤标记再写：另一路已经答过「收到」、正要收尾，就会被这里撤掉的标记弄成 `incomplete`
 *   （claude/push-incomplete〔裁〕）。
 * - 写完补标记时暂存已被收尾入库（另一路先收尾了）：回 `complete`，不回 `discarded`。
 * - 收尾按片号顺序算全件 sha256：不符丢弃全部暂存；相符入库。
 * - **档位**（2026-10-23，游客的视频条数按「原尺寸几个、小档几个取多的」数）：跟着哈希走，和 `ext` 一起登记在暂存里，收尾时随全件入库，
 *   `remove` 时一起删。只往「计数」那边退：登记时说 `small`，之后任何一片没说 `small`（缺了、拼错、说 `original`），
 *   这一条就改记 `original`，不会反过来；收尾时按暂存里最后记的那个落到全件上，原先这个哈希留下的 `small` 标记
 *   在收尾成 `original` 时清掉。标记丢了、读不出来，一律当 `original`。已入库的全件不因再传而改档位。
 */

/** 分片大小：8 MiB（HTTP 契约写死） */
export const BLOB_CHUNK_SIZE = 8 * 1024 * 1024;

const HASH = /^[0-9a-f]{64}$/;

/** 哈希归一成小写；格式不对抛 TypeError */
export function normalizeHash(hash) {
  const key = typeof hash === 'string' ? hash.toLowerCase() : '';
  if (!HASH.test(key)) throw new TypeError('BlobStore：hash 必须是 64 位十六进制');
  return key;
}

/**
 * 扩展名归一：去掉开头的点、转小写。空值给空串；非空但不是 1～8 位字母数字的抛 TypeError
 * （扩展名会拼进 fs 实现的文件名，不收任何路径字符）。
 */
export function normalizeExt(ext) {
  if (ext === undefined || ext === null) return '';
  const raw = String(ext).trim().toLowerCase().replace(/^\./, '');
  if (raw === '') return '';
  if (!/^[a-z0-9]{1,8}$/.test(raw)) throw new TypeError('BlobStore：ext 必须是 1～8 位字母数字');
  return raw;
}

/**
 * 档位归一：只有 `small`（不分大小写、去掉两头空白）算小档，缺失、拼错、不认识的一律 `original`。
 * 失败要闭合：这个值决定游客的视频算不算数，认不出来就当算数（`guest-quota.mjs`）。
 * @returns {'small' | 'original'}
 */
export function normalizeTier(tier) {
  return typeof tier === 'string' && tier.trim().toLowerCase() === 'small' ? 'small' : 'original';
}

/** 分片号与全件大小的形状校验；不合法抛 TypeError */
export function checkChunkArgs(n, size) {
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('BlobStore：n 必须是非负整数');
  if (!Number.isSafeInteger(size) || size <= 0) throw new TypeError('BlobStore：size 必须是正整数');
}

/** 分片数：小于一片的也算 1 片 */
export function chunkCountOf(size, chunkSize) {
  return Math.max(1, Math.ceil(size / chunkSize));
}

/** 第 n 片应有的字节数 */
export function chunkLengthOf(size, n, chunkSize) {
  const count = chunkCountOf(size, chunkSize);
  return n < count - 1 ? chunkSize : size - chunkSize * (count - 1);
}

/** 文件名里的扩展名（不含点，小写），与 `vite-plugin-media.ts` 的 extOfName 同一写法 */
export function extOfName(name) {
  const base = String(name || '').split(/[/\\]/).pop() || '';
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return '';
  return base.slice(i + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * 按键串行的锁：同一个键上的任务排队，前一个失败也不挡后一个。
 * @returns {<T>(key: string, fn: () => Promise<T>) => Promise<T>}
 */
export function createKeyedLock() {
  const locks = new Map();
  return function withLock(key, fn) {
    const prev = locks.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    locks.set(key, tail);
    void tail.then(() => { if (locks.get(key) === tail) locks.delete(key); });
    return run;
  };
}

/**
 * 把 `source` 读完扔掉。可读流照 `asset-service.ts` 原来的 drain：resume，等 end / error / close；
 * 异步可迭代就迭代到底，出错也当读完。
 */
export function drainSource(source) {
  if (source && typeof source.resume === 'function' && typeof source.on === 'function') {
    if (source.readableEnded || source.destroyed) return Promise.resolve();
    return new Promise((resolve) => {
      source.on('end', resolve);
      source.on('error', () => resolve());
      source.on('close', () => resolve());
      source.resume();
    });
  }
  return (async () => {
    try { for await (const _ of source) { /* 丢掉 */ } } catch { /* 当读完 */ }
  })();
}

/**
 * 把 `source` 读完扔掉，回读到的字节数；读的途中出错照原样抛（与 `drainSource` 不同）。
 * 给「已收到的片再传」用：不落盘，只核对长度。
 */
export async function countSource(source) {
  let bytes = 0;
  for await (const chunk of source) bytes += toBuffer(chunk).length;
  return bytes;
}

/** 把一段数据变成 Buffer（字符串按 utf8） */
export function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk);
  throw new TypeError('BlobStore：source 只能产出 Buffer / Uint8Array / 字符串');
}

/**
 * 最小的扩展名 → Content-Type 表（契约第 2 节 memory 实现那张）。
 * fs 实现在调用方没注入 `contentTypeForExt` 时也用它。
 */
const MIN_CONTENT_TYPES = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  png: 'image/png',
  jpg: 'image/jpeg',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
};

export function minimalContentType(ext) {
  return MIN_CONTENT_TYPES[String(ext || '').toLowerCase().replace(/^\./, '')] || 'application/octet-stream';
}
