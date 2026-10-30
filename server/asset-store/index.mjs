/**
 * 素材服务的数据层出口（契约 `docs/plan/asset-store-contract.md` 第 2 节）。
 *
 * - `kind: 'fs'`     → 本地内容库（`fs-store.mjs`）；`shard: true` 是托管组合用的分目录布局，布局标记见 `ensureLayoutSync`
 * - `kind: 'memory'` → 内存（`memory-store.mjs`，测试用）
 * - `kind: 'oss'`    → 插槽：抛 Error，`code === 'not-implemented'`，不装任何 SDK
 * - 其它             → TypeError
 *
 * 接口写在 `blob-store.mjs` 的 JSDoc 里。本目录只引 Node 内置模块；例外是 `guest-quota.mjs`，它引 `../account/guest.mjs`
 * 取游客限额的数和判断（那边只引 `node:crypto` 与同目录的 `client.mjs`）。`asset-service.ts` 经这里拿它，
 * 好几个单测把 `asset-service.ts` 单独转译、只替换已有的几条静态 import，所以不在那边另加一条。
 *
 * 另外转出素材服务的 HTTP 客户端 `createAssetClient`（`client.mjs`，契约 `docs/plan/artifact-transfer-contract.md` 第 2 节），
 * 以及 fs 实现按候选文件名找文件的钩子 `candidateFileResolver`（同一契约第 10 节第 6 条）。
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import { createFsStore, ensureLayoutSync, readLayoutSync, LAYOUT_FILE, LAYOUTS } from './fs-store.mjs';
import { createMemoryStore } from './memory-store.mjs';
import { BLOB_CHUNK_SIZE } from './blob-store.mjs';
import { createAssetClient } from './client.mjs';
export { createProjectAssetStores, projectScopeOfRoot, projectStorageKey, PROJECT_ASSET_LAYOUT_VERSION } from './project-stores.mjs';
export { createAssetRevocationConsumer } from './project-revocations.mjs';
export { authorizeAsset, openProjectStream, createProjectAssetAccess } from './project-access.mjs';
export { assetContextOf, setAssetContext, authorizedAssetStore } from './project-access.mjs';
export { createGuestAssetQuota, guestQuotaApplies, guestIdOfUserId } from './guest-quota.mjs';
export { SNIFF_BYTES, sniffMediaKind, countsAsVideoFile } from './media-sniff.mjs';

export { BLOB_CHUNK_SIZE, createFsStore, createMemoryStore, createAssetClient, ensureLayoutSync, readLayoutSync, LAYOUT_FILE, LAYOUTS };

/**
 * @param {{ kind: 'fs' | 'memory' | 'oss' } & Record<string, any>} options
 * @returns {import('./blob-store.mjs').BlobStore}
 */
export function createBlobStore(options) {
  const kind = options?.kind;
  if (kind === 'fs') return createFsStore(options);
  if (kind === 'memory') return createMemoryStore(options);
  if (kind === 'oss') {
    const err = new Error('createBlobStore：oss 实现还没有（只留插槽）');
    /** @type {any} */ (err).code = 'not-implemented';
    throw err;
  }
  throw new TypeError(`createBlobStore：不认识的 kind ${JSON.stringify(kind)}`);
}

/**
 * fs 实现的 `hooks.resolveFile`：不扫目录，依次直接查 `<dir>/<hash>.<ext>`（按 `exts` 的顺序），最后查没有扩展名的 `<dir>/<hash>`。
 * 给素材服务的 `snap` / `px` 命名空间用（契约 `docs/plan/artifact-transfer-contract.md` 第 10 节第 6 条）；
 * `asset-service.ts` 不碰文件系统，所以「文件在不在」放在数据层这里判。
 *
 * @param {string} dir
 * @param {readonly string[]} exts  候选扩展名，不带点
 * @returns {(hash: string) => Promise<string | null>}
 */
export function candidateFileResolver(dir, exts) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('candidateFileResolver：dir 必须是非空字符串');
  const base = path.resolve(dir);
  const suffixes = [...exts.map((e) => '.' + String(e).toLowerCase().replace(/^\./, '')), ''];
  return async function resolveFile(hash) {
    const key = String(hash ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) return null;
    for (const suffix of suffixes) {
      const file = path.join(base, key + suffix);
      try { if ((await fs.stat(file)).isFile()) return file; } catch { /* 没有这个候选 */ }
    }
    return null;
  };
}
