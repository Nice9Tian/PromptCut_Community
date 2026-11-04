/**
 * Data layer egress for the asset service (contract `docs/plan/asset-store-contract.md` section 2).
 *
 * - `kind: 'fs'`     → Local content store (`fs-store.mjs`); `shard: true` is the subdirectory
 *   layout used for hosted composites; see `ensureLayoutSync` for layout markers
 * - `kind: 'memory'` → Memory (`memory-store.mjs`, for testing)
 * - `kind: 'oss'`    → Slot: throws Error, `code === 'not-implemented'`, does not install any SDK
 * - Other            → TypeError
 *
 * Interfaces are documented in JSDoc of `blob-store.mjs`. This directory only imports Node built-in
 * modules; the exception is `guest-quota.mjs`, which imports `../account/guest.mjs` to get guest
 * quota counts and checks (that side only imports `node:crypto` and `client.mjs` in the same
 * directory). `asset-service.ts` gets it through here; several unit tests transpile
 * `asset-service.ts` in isolation, only replacing existing static imports, so no additional import
 * is added there.
 *
 * Also re-exports the asset service HTTP client `createAssetClient` (`client.mjs`, contract
 * `docs/plan/artifact-transfer-contract.md` section 2), and the fs implementation hook
 * `candidateFileResolver` that finds files by candidate file names (same contract, section 10, item 6).
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
    const err = new Error('createBlobStore: the oss implementation does not exist yet (slot only)');
    /** @type {any} */ (err).code = 'not-implemented';
    throw err;
  }
  throw new TypeError(`createBlobStore: unknown kind ${JSON.stringify(kind)}`);
}

/**
 * The `hooks.resolveFile` for the fs implementation: does not scan directories, directly checks
 * `<dir>/<hash>.<ext>` in order (by `exts` sequence), and finally checks `<dir>/<hash>` without an
 * extension. Used for the `snap` / `px` namespaces of the asset service (contract
 * `docs/plan/artifact-transfer-contract.md` section 10, item 6); `asset-service.ts` does not touch
 * the file system, so checking whether the file exists is handled here in the data layer.
 *
 * @param {string} dir
 * @param {readonly string[]} exts  Candidate extensions, without leading dot
 * @returns {(hash: string) => Promise<string | null>}
 */
export function candidateFileResolver(dir, exts) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('candidateFileResolver: dir must be a non-empty string');
  const base = path.resolve(dir);
  const suffixes = [...exts.map((e) => '.' + String(e).toLowerCase().replace(/^\./, '')), ''];
  return async function resolveFile(hash) {
    const key = String(hash ?? '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(key)) return null;
    for (const suffix of suffixes) {
      const file = path.join(base, key + suffix);
      try { if ((await fs.stat(file)).isFile()) return file; } catch { /* No such candidate */ }
    }
    return null;
  };
}
