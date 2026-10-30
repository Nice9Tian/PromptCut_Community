/**
 * `BlobStore` 的 fs 实现：本地内容库（契约 `docs/plan/asset-store-contract.md` 第 2 节）。
 *
 * 目录布局与第 5 步（原来写在 `server/asset-service.ts` 里的那一版）逐字节一致：
 * - 全件：`<dir>/<hash>.<ext>`，没有扩展名就是 `<dir>/<hash>`；
 * - 暂存：`<dir>/.chunks/<hash>/`，里面是 `meta.json`（size、ext）、`data`（按偏移原位写的全件）、
 *   `<n>.ok`（这一片完整落盘的标记）。
 * 写一片之前先删它的标记，写完、长度对了才补上 —— 断电、断线、写到一半失败都只会让这一片算「没收到」。
 * 已有标记的片再传不重写、不删标记，只读完核对长度（规则见 `blob-store.mjs` 文件头）。
 * 收尾时只读一遍 `data` 算哈希，再直接改名成全件，不再拷一遍。
 *
 * 本模块不引 `vite-plugin-media.ts`：找已入库文件（兼容老的整件导入）、入库后写媒体索引、
 * 扩展名到 Content-Type 都经调用方注入的 `hooks`。只引 Node 内置模块。
 *
 * **分目录布局**（`shard: true`，托管组合用；契约 `docs/plan/shared-project-contract.md` 第 1 节）：
 * - 全件放在按哈希前两位分的子目录里：`<dir>/<hash 前两位>/<hash>.<ext>`（没有扩展名就是 `<dir>/<hh>/<hash>`），
 *   一个命名空间下至多 256 个子目录，用到时才建；
 * - 暂存仍是 `<dir>/.chunks/<hash>/`，与全件同一个文件系统，收尾时改名过去（临时文件加改名）；
 * - 收尾时先对 `data` 做 `fsync`，改名后再对所在子目录做 `fsync`（尽力而为：Windows 上目录打不开就跳过）。
 *   分片不 `fsync`：丢了的分片对账时报「没收到」，续传即可；
 * - 两种布局读取互不兼容，所以布局记在调用方选定的目录里的 `.layout` 文件（`ensureLayoutSync`），启动时核对。
 * 本机编辑器不传 `shard`，布局与行为和原来逐字节一致（不做 `fsync`）。
 *
 * **档位**（规则见 `blob-store.mjs`「档位」）：暂存里记在 `meta.json` 的 `tier` 字段（只在是 `small` 时写）；
 * 入库后记成 `<dir>/.tiers/<hash>` 这个空文件，有它就是小档，没有就是原尺寸。两种布局都放在 `<dir>/.tiers/` 下。
 * 只有报了 `small` 的才会留下这个文件，所以没人报档位的地方（本机编辑器、桌面版）目录与原来一样。
 * 收尾时先删掉这个哈希的旧标记、改名入库之后才写新标记：中途出了事最多是少一个标记，也就是多算一条，不会少算。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync, { createReadStream, createWriteStream } from 'node:fs';
import crypto from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BLOB_CHUNK_SIZE, normalizeHash, normalizeExt, checkChunkArgs, chunkCountOf, chunkLengthOf,
  extOfName, createKeyedLock, drainSource, countSource, toBuffer, minimalContentType, normalizeTier,
} from './blob-store.mjs';

/**
 * 同一个目录可能被多个 store 实例同时管（比如中间件建了两次），锁按「目录 + 哈希」放在模块级，
 * 保证同一哈希的登记与收尾在整个进程里串行。
 */
const withLock = createKeyedLock();

const HASH_FILE = /^([0-9a-f]{64})(?:\.[a-z0-9]+)?$/i;

async function exists(file) {
  try { await fs.stat(file); return true; } catch { return false; }
}

const SHARD_DIR = /^[0-9a-f]{2}$/;

/** 对文件（或目录）做 fsync；`dir: true` 时是尽力而为（Windows 上目录打不开、不支持 fsync 就跳过） */
async function fsyncPath(file, { dir = false } = {}) {
  let fh;
  try {
    fh = await fs.open(file, dir ? 'r' : 'r+');
  } catch (err) {
    if (dir) return;
    throw err;
  }
  try {
    await fh.sync();
  } catch (err) {
    if (!dir) throw err;
  } finally {
    await fh.close();
  }
}

/* ------------------------------------------------------------------ *
 * 布局标记 `.layout`
 * ------------------------------------------------------------------ */

/** 布局标记的文件名：放在调用方选定的根目录下（托管组合是 `$PROMPTCUT_DATA_DIR/assets/.layout`） */
export const LAYOUT_FILE = '.layout';
/** 两种布局的名字（`.layout` 的内容 `{"v":1,"layout":"shard"|"flat"}`，契约第 11 节裁定）：`flat` 是本机编辑器的原布局，`shard` 是按哈希前两位分子目录 */
export const LAYOUTS = Object.freeze({ flat: 'flat', shard: 'shard' });

/** 读布局标记：没有回 null；读不了或格式不对回 `{ layout: 'unreadable' }` */
export function readLayoutSync(dir) {
  let text;
  try {
    text = fsSync.readFileSync(path.join(path.resolve(dir), LAYOUT_FILE), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    return { layout: 'unreadable' };
  }
  try {
    const raw = JSON.parse(text);
    if (raw && typeof raw.layout === 'string') return { v: raw.v ?? null, layout: raw.layout };
  } catch { /* 下面按读不了算 */ }
  return { layout: 'unreadable' };
}

/**
 * 启动时核对布局（契约第 1 节「布局记在 `assets/.layout` 里，启动时核对，对不上就拒绝启动」）：
 * - 有标记：与 `layout` 相同回 `{ ok: true, created: false }`，不同回 `{ ok: false, found }`；
 * - 没有标记：目录不存在或是空的，就建目录、写标记（临时文件加改名、fsync），回 `{ ok: true, created: true }`；
 *   目录里已经有别的东西（来历不明的数据），回 `{ ok: false, found: 'unmarked' }`，不写标记。
 * 目录建不了、写不了照原样抛错（调用方按数据目录不可写处理）。
 * @param {string} dir
 * @param {string} layout  `LAYOUTS` 里的一个
 */
export function ensureLayoutSync(dir, layout) {
  const root = path.resolve(dir);
  const found = readLayoutSync(root);
  if (found) return found.layout === layout ? { ok: true, created: false } : { ok: false, found: found.layout };
  fsSync.mkdirSync(root, { recursive: true });
  const others = fsSync.readdirSync(root).filter((n) => !n.startsWith(`${LAYOUT_FILE}.tmp-`));
  if (others.length > 0) return { ok: false, found: 'unmarked' };
  const file = path.join(root, LAYOUT_FILE);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  const fd = fsSync.openSync(tmp, 'w');
  try {
    fsSync.writeFileSync(fd, `${JSON.stringify({ v: 1, layout })}\n`, 'utf8');
    fsSync.fsyncSync(fd);
  } finally {
    fsSync.closeSync(fd);
  }
  fsSync.renameSync(tmp, file);
  return { ok: true, created: true };
}

/**
 * @param {object} options
 * @param {string} options.dir  本地内容库目录（`mediaDir(root)`）
 * @param {object} [options.hooks]
 * @param {(hash: string) => Promise<string | null>} [options.hooks.resolveFile]  找已入库的文件；缺省在 `dir`（分目录布局是 `dir/<hh>`）里按文件名找
 * @param {(entry: { hash: string, file: string, ext: string, size: number, contentType: string }) => (void | Promise<void>)} [options.hooks.onStored]  入库后写媒体索引
 * @param {(ext: string) => string} [options.hooks.contentTypeForExt]
 * @param {number} [options.chunkSize]  缺省 8 MiB
 * @param {boolean} [options.shard]  分目录布局（见文件头），缺省 false
 * @returns {import('./blob-store.mjs').BlobStore}
 */
export function createFsStore({ dir, hooks = {}, chunkSize = BLOB_CHUNK_SIZE, shard = false } = /** @type {any} */ ({})) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('createFsStore：dir 必须是非空字符串');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError('createFsStore：chunkSize 必须是正整数');
  const base = path.resolve(dir);
  const sharded = shard === true;
  const contentTypeForExt = typeof hooks.contentTypeForExt === 'function' ? hooks.contentTypeForExt : minimalContentType;
  const onStored = typeof hooks.onStored === 'function' ? hooks.onStored : () => {};
  const resolveFile = typeof hooks.resolveFile === 'function' ? hooks.resolveFile : scanFile;
  /** 全件所在的目录：原布局就是 `dir`，分目录布局是 `dir/<hash 前两位>` */
  const homeOf = (hash) => (sharded ? path.join(base, hash.slice(0, 2)) : base);

  /** 缺省的 resolveFile：`<hash>` 或 `<hash>.<ext>` */
  async function scanFile(hash) {
    const home = homeOf(hash);
    let names = [];
    try { names = await fs.readdir(home); } catch { return null; }
    const hit = names.find((n) => (n.toLowerCase() === hash || n.toLowerCase().startsWith(hash + '.')) && (!hooks.isPublished || /^[a-f0-9]{64}(?:\.[a-z0-9]+)?$/i.test(n)));
    return hit ? path.join(home, hit) : null;
  }

  const lockKey = (hash) => `${base}\0${hash}`;
  const stagingDir = (hash) => path.join(base, '.chunks', hash);
  const tierDir = path.join(base, '.tiers');
  const tierMark = (hash) => path.join(tierDir, hash);

  async function readMeta(hash) {
    try {
      const raw = JSON.parse(await fs.readFile(path.join(stagingDir(hash), 'meta.json'), 'utf8'));
      if (Number.isSafeInteger(raw?.size) && raw.size > 0) return { size: raw.size, ext: String(raw.ext || ''), tier: normalizeTier(raw.tier) };
    } catch { /* 没有暂存 */ }
    return null;
  }

  async function writeMeta(hash, meta) {
    const d = stagingDir(hash);
    await fs.mkdir(d, { recursive: true });
    const tmp = path.join(d, `meta.${crypto.randomBytes(4).toString('hex')}.tmp`);
    // tier 只在是小档时写：原尺寸（绝大多数）的 meta.json 与原来逐字节一致
    const { tier, ...rest } = meta;
    await fs.writeFile(tmp, JSON.stringify(tier === 'small' ? { ...rest, tier } : rest));
    await fs.rename(tmp, path.join(d, 'meta.json'));
  }

  async function receivedChunks(hash, meta) {
    const count = chunkCountOf(meta.size, chunkSize);
    let names = [];
    try { names = await fs.readdir(stagingDir(hash)); } catch { return []; }
    const out = [];
    for (const name of names) {
      const m = /^(\d+)\.ok$/.exec(name);
      if (m) { const n = Number(m[1]); if (n < count) out.push(n); }
    }
    return out.sort((a, b) => a - b);
  }

  /** 已入库的全件：{ file, size } 或 null */
  async function stored(hash) {
    const file = await resolveFile(hash);
    if (!file) return null;
    if (hooks.isPublished && !await hooks.isPublished(file)) return null;
    try {
      const st = await fs.stat(file);
      return { file, size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return null;
    }
  }

  /** 已入库的全件：哈希 → 字节数；传了 `exts` 就顺手记下哈希 → 扩展名 */
  async function scanStored(exts = null) {
    const sizes = new Map();
    async function countIn(home, prefix) {
      let entries = [];
      try { entries = await fs.readdir(home, { withFileTypes: true }); } catch { return; /* 目录还不存在 */ }
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const m = HASH_FILE.exec(ent.name);
        if (!m) continue;
        const key = m[1].toLowerCase();
        if (prefix !== null && !key.startsWith(prefix)) continue;
        if (sizes.has(key)) continue;
        try { sizes.set(key, (await fs.stat(path.join(home, ent.name))).size); exts?.set(key, extOfName(ent.name)); } catch { /* 刚被删 */ }
      }
    }
    if (sharded) {
      let subdirs = [];
      try { subdirs = await fs.readdir(base, { withFileTypes: true }); } catch { /* 目录还不存在 */ }
      for (const ent of subdirs) {
        const name = ent.name.toLowerCase();
        if (ent.isDirectory() && SHARD_DIR.test(name)) await countIn(path.join(base, ent.name), name);
      }
    } else {
      await countIn(base, null);
    }
    return sizes;
  }

  return {
    kind: 'fs',
    /** 布局：`flat`（原布局）或 `shard`（分目录） */
    layout: sharded ? LAYOUTS.shard : LAYOUTS.flat,
    chunkSize,

    async stat(hash) {
      const key = normalizeHash(hash);
      const done = await stored(key);
      if (!done) return null;
      const ext = extOfName(done.file);
      return { size: done.size, ext, contentType: contentTypeForExt(ext), mtimeMs: done.mtimeMs };
    },

    async read(hash, { start, end } = {}) {
      const key = normalizeHash(hash);
      const done = await stored(key);
      if (!done) return null;
      if (start === undefined && end === undefined) return createReadStream(done.file);
      return createReadStream(done.file, { start: start ?? 0, end: end ?? Math.max(0, done.size - 1) });
    },

    async chunks(hash) {
      const key = normalizeHash(hash);
      const done = await stored(key);
      if (done) {
        const count = chunkCountOf(done.size, chunkSize);
        return { size: done.size, chunkSize, received: Array.from({ length: count }, (_, i) => i), complete: true };
      }
      const meta = await readMeta(key);
      if (!meta) return { size: null, chunkSize, received: [], complete: false };
      return { size: meta.size, chunkSize, received: await receivedChunks(key, meta), complete: false };
    },

    async putChunk(hash, n, { size, ext, tier, beforeCommit, signal, track } = /** @type {any} */ ({}), source) {
      await beforeCommit?.();
      signal?.throwIfAborted();
      const key = normalizeHash(hash);
      checkChunkArgs(n, size);
      const wantExt = normalizeExt(ext);
      const wantTier = normalizeTier(tier);
      const count = chunkCountOf(size, chunkSize);
      if (n >= count) return { status: 'out-of-range', count };
      const expected = chunkLengthOf(size, n, chunkSize);

      // 登记（串行）：已入库就幂等放过；size 对不上拒掉；这一片已收到就不重写（见 blob-store.mjs 文件头）；
      // 否则写完再补标记。只在还没登记过（没有 meta.json）时删一次这一片的标记，清掉来历不明的残留；
      // 登记过的不删：上面刚判过「没有标记」，此时冒出来的标记只能是另一路刚写完补上的，删了它，
      // 那一路已经答过 200、正要收尾，就会收到 incomplete（claude/push-incomplete）
      const pre = await withLock(lockKey(key), async () => {
        if (await resolveFile(key)) return 'complete';
        const meta = await readMeta(key);
        if (meta && meta.size !== size) return { conflict: meta.size };
        const d = stagingDir(key);
        // ext 以最先登记的非空值为准；档位只往 original 退（见 blob-store.mjs「档位」）
        const next = meta
          ? { size, ext: meta.ext || wantExt, tier: meta.tier === 'small' && wantTier === 'small' ? 'small' : 'original' }
          : { size, ext: wantExt, tier: wantTier };
        const changed = !meta || next.ext !== meta.ext || next.tier !== meta.tier;
        if (meta && await exists(path.join(d, `${n}.ok`))) {
          if (changed) await writeMeta(key, next);
          return 'have';
        }
        if (!meta) await fs.rm(path.join(d, `${n}.ok`), { force: true });
        if (changed) await writeMeta(key, next);
        // data 不存在就建一个空的；已经存在的不截断（别的片可能已经写进去了）
        await (await fs.open(path.join(d, 'data'), 'a')).close();
        return 'ok';
      });
      if (pre === 'complete') { await drainSource(source); return { status: 'complete' }; }
      if (typeof pre === 'object') return { status: 'size-mismatch', size: pre.conflict };

      const d = stagingDir(key);
      if (pre === 'have') {
        // 已收到的片再传：存着的字节不碰，只读完核对长度；断流照原样抛，标记保留
        const got = await countSource(source);
        if (got === expected) return { status: 'ok', bytes: got };
        await withLock(lockKey(key), () => fs.rm(path.join(d, `${n}.ok`), { force: true }));
        return { status: 'length', expected, got };
      }
      let bytes = 0;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          // 超长的部分不写（免得写进下一片的位置），读完再按长度判
          const buf = toBuffer(chunk);
          const room = expected - bytes;
          bytes += buf.length;
          if (room <= 0) return cb();
          cb(null, buf.length > room ? buf.subarray(0, room) : buf);
        },
      });
      // r+：原位写，不截断别的片已经写进去的字节。pipeline 等到文件句柄关掉才返回；
      // 出错（断线等）原样抛给调用方，这一片的标记没补，对账时报「没收到」
      const output = createWriteStream(path.join(d, 'data'), { flags: 'r+', start: n * chunkSize });
      track?.(output);
      await pipeline(source, counter, output, ...(signal ? [{ signal }] : []));
      await beforeCommit?.();
      signal?.throwIfAborted();
      if (bytes !== expected) return { status: 'length', expected, got: bytes };
      // 标记落在暂存目录里；这期间要是被收尾丢弃了，目录不在，标记也就不写。
      // 目录不在是因为另一路先收尾入库了（两路同时推同一内容）：这一片的字节已在全件里，回 complete
      try { await fs.writeFile(path.join(d, `${n}.ok`), ''); }
      catch { return (await resolveFile(key)) ? { status: 'complete' } : { status: 'discarded' }; }
      return { status: 'ok', bytes };
    },

    async complete(hash, { beforeCommit, signal, track } = {}) {
      const key = normalizeHash(hash);
      return withLock(lockKey(key), async () => {
        await beforeCommit?.();
        signal?.throwIfAborted();
        const done = await stored(key);
        if (done) return { status: 'ok', size: done.size, ext: extOfName(done.file) };
        const meta = await readMeta(key);
        if (!meta) return { status: 'unknown' };
        const received = new Set(await receivedChunks(key, meta));
        const missing = [];
        for (let i = 0; i < chunkCountOf(meta.size, chunkSize); i++) if (!received.has(i)) missing.push(i);
        if (missing.length) return { status: 'incomplete', missing };

        const d = stagingDir(key);
        const data = path.join(d, 'data');
        const digest = crypto.createHash('sha256');
        // 句柄在 pipeline 返回前就关了，下面才能改名（Windows 上开着的文件改不了名）
        const input = createReadStream(data, { start: 0, end: meta.size - 1 });
        track?.(input);
        await pipeline(input, digest, ...(signal ? [{ signal }] : []));
        const actual = digest.digest('hex');
        if (actual !== key) {
          await fs.rm(d, { recursive: true, force: true });
          return { status: 'hash-mismatch', actual };
        }
        // 原位写的 data 不会比 size 长（每片长度都校验过），保险起见还是截一下
        await fs.truncate(data, meta.size);
        const file = meta.ext ? `${key}.${meta.ext}` : key;
        const home = homeOf(key);
        if (sharded) {
          // 分目录布局：先把全件字节刷盘再改名，改名后刷子目录（契约第 9 节〔裁〕：fsync 只对 complete 做）。
          // 中途出错（含 ENOSPC、EDQUOT）照原样抛：暂存不动，已收的分片保留，不算入库
          await fsyncPath(data);
          await fs.mkdir(home, { recursive: true });
        }
        await beforeCommit?.();
        signal?.throwIfAborted();
        // 这个哈希以前留下的小档标记先清掉（删不掉就照原样抛，不入库）：免得一条原尺寸顶着旧标记少算
        await fs.rm(tierMark(key), { force: true });
        const target = path.join(home, file);
        await fs.rename(data, target);
        // 撤销/关项目与 rename 在途竞态：未完成发布的此份新全件撤回暂存；不动任何已有全件。
        if (signal?.aborted) { await fs.rename(target, data); signal.throwIfAborted(); }
        // 小档的标记在入库之后才写；写不成就当原尺寸（多算一条，不少算）
        if (meta.tier === 'small') {
          try { await fs.mkdir(tierDir, { recursive: true }); await fs.writeFile(tierMark(key), ''); } catch { /* 当原尺寸 */ }
        }
        if (sharded) await fsyncPath(home, { dir: true });
        await fs.rm(d, { recursive: true, force: true });
        await onStored({ hash: key, file, ext: meta.ext, size: meta.size, contentType: contentTypeForExt(meta.ext) });
        return { status: 'ok', size: meta.size, ext: meta.ext };
      });
    },

    async remove(hash) {
      const key = normalizeHash(hash);
      return withLock(lockKey(key), async () => {
        let removed = false;
        const file = await resolveFile(key);
        if (file) {
          try { await fs.rm(file); removed = true; } catch { /* 已经不在 */ }
        }
        const d = stagingDir(key);
        if (await exists(d)) {
          await fs.rm(d, { recursive: true, force: true });
          removed = true;
        }
        await fs.rm(tierMark(key), { force: true });
        return removed;
      });
    },

    /**
     * 已入库的全件，按哈希升序：`[{ hash, size }]`（fs 实现独有，不在 BlobStore 接口里；托管组合的迁移盘点用）。
     * 只数 `<hash>` 与 `<hash>.<ext>` 形状的文件；分目录布局只认前两位对得上的。
     */
    async list() {
      const sizes = await scanStored();
      return [...sizes.keys()].sort().map((hash) => ({ hash, size: sizes.get(hash) }));
    },

    async usage() {
      const sizes = await scanStored();
      let staging = 0;
      let dirs = [];
      try { dirs = await fs.readdir(path.join(base, '.chunks'), { withFileTypes: true }); } catch { /* 没有暂存 */ }
      for (const ent of dirs) if (ent.isDirectory() && /^[0-9a-f]{64}$/.test(ent.name)) staging++;
      let bytes = 0;
      for (const v of sizes.values()) bytes += v;
      return { blobs: sizes.size, bytes, staging };
    },

    async inventory() {
      const exts = new Map();
      const sizes = await scanStored(exts);
      let marks = [];
      try { marks = await fs.readdir(tierDir); } catch { /* 没有小档标记 */ }
      const small = new Set(marks.map((n) => n.toLowerCase()).filter((n) => /^[0-9a-f]{64}$/.test(n)));
      const stored = [...sizes.keys()].sort().map((hash) => ({ hash, ext: exts.get(hash) ?? '', tier: small.has(hash) ? 'small' : 'original' }));
      const staging = [];
      let dirs = [];
      try { dirs = await fs.readdir(path.join(base, '.chunks'), { withFileTypes: true }); } catch { /* 没有暂存 */ }
      for (const ent of dirs) {
        if (!ent.isDirectory() || !/^[0-9a-f]{64}$/.test(ent.name)) continue;
        const meta = await readMeta(ent.name);
        if (meta) staging.push({ hash: ent.name, ext: meta.ext, tier: meta.tier });
      }
      return { stored, staging };
    },
  };
}
