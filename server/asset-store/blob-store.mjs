/**
 * Data layer interface `BlobStore` for asset service (contract `docs/plan/asset-store-contract.md` section 2).
 *
 * HTTP layer (`server/asset-service.ts`) only reads and writes bytes through this interface
 * and does not know about disk. Currently there are two implementations:
 * `fs` (local content store, directory layout matches step 5) and `memory` (for testing);
 * `oss` only reserves a slot.
 * This file defines the interface and provides shared utilities for both implementations.
 * Imports only Node built-in modules.
 *
 * @typedef {object} BlobStat
 * @property {number} size
 * @property {string} ext  Without dot, lowercase; empty string if no extension
 * @property {string} contentType
 * @property {number | null} mtimeMs  null for implementations unable to get modification time
 *
 * @typedef {object} ChunkStatus
 * @property {number | null} size  null for hashes never seen before
 * @property {number} chunkSize
 * @property {number[]} received  Ascending order
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
 *   Only recognizes stored whole files.
 * @property {(hash: string, range?: { start?: number, end?: number }) => Promise<import('node:stream').Readable | null>} read
 *   Closed interval, `end` defaults to the end; returns null if not stored.
 * @property {(hash: string) => Promise<ChunkStatus>} chunks
 *   Never seen: `size: null`, `received: []`; stored: all chunk numbers, `complete: true`.
 * @property {(hash: string, n: number, info: { size: number, ext?: string, tier?: string }, source: AsyncIterable<Buffer> | import('node:stream').Readable) => Promise<PutResult>} putChunk
 *   When already stored, drains and discards `source` without writing to disk; `size-mismatch`
 *   and `out-of-range` do not touch `source`, leaving request body handling to caller.
 *   `tier` is the tier reported by uploader (see "Tier" below); only recognizes `small`,
 *   records all others as `original`.
 * @property {(hash: string) => Promise<CompleteResult>} complete
 * @property {(hash: string) => Promise<boolean>} remove
 *   Deletes stored whole files and staging; returns true if deleted.
 * @property {() => Promise<{ blobs: number, bytes: number, staging: number }>} usage
 *   `staging` is the number of hashes with staging data.
 * @property {() => Promise<{ stored: InventoryEntry[], staging: InventoryEntry[] }>} inventory
 *   Stored whole files and staging, each with extension and tier (used for guest video count,
 *   `guest-quota.mjs`). Counts the same set of items as `usage`:
 *   `stored` matches `usage().blobs` count; entries in `staging` not yet registered (no meta)
 *   are omitted.
 *
 * @typedef {{ hash: string, ext: string, tier: 'small' | 'original' }} InventoryEntry
 *
 * Common rules:
 * - Hashes are 64-character hex, case-insensitive, always accessed and stored in lowercase;
 *   throws TypeError if format is invalid.
 * - Chunk count `max(1, ceil(size / chunkSize))`; each chunk except the last is exactly
 *   `chunkSize` bytes.
 * - `ext` takes the earliest registered non-empty value.
 * - Registration, finalization, and deletion for the same hash execute serially; writing chunk
 *   bytes is not queued.
 * - Unreceived chunks: marked as "received" only after writing completes and length verification
 *   succeeds; not marked on midway failure, stream break, or length mismatch.
 *   Once checked as "unmarked" during registration, marks are never removed: any mark appearing
 *   afterwards can only have been added by another stream that just finished writing.
 * - Re-upload of an already received chunk (two streams pushing same content concurrently, or
 *   retry racing with original upload): does not rewrite or revoke mark; drains `source` and
 *   verifies length; returns `ok` if length matches; only revokes mark and returns `length` if
 *   length mismatches; midway stream breaks are re-thrown as is while keeping the mark (stored
 *   bytes were untouched). Previously marks were always revoked before writing: if another
 *   stream had already answered "received" and was about to finalize, the revoked mark here
 *   would cause it to become `incomplete` (claude/push-incomplete [ruling]).
 * - When adding mark after writing, if staging has already been finalized and stored (another
 *   stream finalized first): returns `complete`, not `discarded`.
 * - Finalization computes whole-file sha256 in chunk order: discards all staging data if
 *   mismatched; stored into library if matched.
 * - **Tier** (2026-10-23, guest video counts take the greater of original-size count and
 *   small-tier count): tracked with the hash, registered in staging alongside `ext`, stored
 *   with the whole file upon finalization, and deleted together on `remove`. Only demotes
 *   towards "counting": if registered as `small`, but any subsequent chunk fails to specify
 *   `small` (missing, misspelled, or specifies `original`), this entry is updated to `original`
 *   and never reverts; upon finalization, the last recorded value in staging is applied to the
 *   whole file, and any prior `small` mark left for this hash is cleared when finalizing as
 *   `original`. If mark is lost or unreadable, treat as `original`. Stored whole files do not
 *   change tier due to re-uploads.
 */

/** Chunk size: 8 MiB (hardcoded in HTTP contract) */
export const BLOB_CHUNK_SIZE = 8 * 1024 * 1024;

const HASH = /^[0-9a-f]{64}$/;

/** Normalizes hash to lowercase; throws TypeError if format is invalid */
export function normalizeHash(hash) {
  const key = typeof hash === 'string' ? hash.toLowerCase() : '';
  if (!HASH.test(key)) throw new TypeError('BlobStore: hash must be 64 hex characters');
  return key;
}

/**
 * Normalizes extension: removes leading dot, converts to lowercase. Returns empty string for empty
 * values; throws TypeError if non-empty but not 1-8 alphanumeric characters
 * (extension is concatenated into filenames in fs implementation, does not accept path characters).
 */
export function normalizeExt(ext) {
  if (ext === undefined || ext === null) return '';
  const raw = String(ext).trim().toLowerCase().replace(/^\./, '');
  if (raw === '') return '';
  if (!/^[a-z0-9]{1,8}$/.test(raw)) throw new TypeError('BlobStore: ext must be 1-8 alphanumeric characters');
  return raw;
}

/**
 * Normalizes tier: only `small` (case-insensitive, trimmed of surrounding whitespace) counts as
 * small tier; missing, misspelled, or unrecognized values always default to `original`.
 * Fail closed: this value determines whether a guest's video counts; if unrecognized, treat as
 * counting (`guest-quota.mjs`).
 * @returns {'small' | 'original'}
 */
export function normalizeTier(tier) {
  return typeof tier === 'string' && tier.trim().toLowerCase() === 'small' ? 'small' : 'original';
}

/** Shape validation for chunk number and whole-file size; throws TypeError if invalid */
export function checkChunkArgs(n, size) {
  if (!Number.isSafeInteger(n) || n < 0) throw new TypeError('BlobStore: n must be a non-negative integer');
  if (!Number.isSafeInteger(size) || size <= 0) throw new TypeError('BlobStore: size must be a positive integer');
}

/** Chunk count: counts as 1 chunk even if smaller than one chunk */
export function chunkCountOf(size, chunkSize) {
  return Math.max(1, Math.ceil(size / chunkSize));
}

/** Expected number of bytes for chunk n */
export function chunkLengthOf(size, n, chunkSize) {
  const count = chunkCountOf(size, chunkSize);
  return n < count - 1 ? chunkSize : size - chunkSize * (count - 1);
}

/** Extension in filename (without dot, lowercase), matching implementation of extOfName in `vite-plugin-media.ts` */
export function extOfName(name) {
  const base = String(name || '').split(/[/\\]/).pop() || '';
  const i = base.lastIndexOf('.');
  if (i <= 0 || i === base.length - 1) return '';
  return base.slice(i + 1).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Lock serialized by key: tasks on the same key are queued, and failure of a previous task does
 * not block subsequent ones.
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
 * Drains and discards `source`. Readable streams follow original drain in `asset-service.ts`:
 * resumes and waits for end / error / close; async iterables iterate to the end, treating errors
 * as completed.
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
    try { for await (const _ of source) { /* Discard */ } } catch { /* Treat as completed */ }
  })();
}

/**
 * Drains and discards `source`, returning bytes read; errors during reading are re-thrown as is
 * (unlike `drainSource`).
 * Used for "re-upload of already received chunk": does not write to disk, only verifies length.
 */
export async function countSource(source) {
  let bytes = 0;
  for await (const chunk of source) bytes += toBuffer(chunk).length;
  return bytes;
}

/** Converts a chunk of data to Buffer (strings as utf8) */
export function toBuffer(chunk) {
  if (Buffer.isBuffer(chunk)) return chunk;
  if (chunk instanceof Uint8Array) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  if (typeof chunk === 'string') return Buffer.from(chunk);
  throw new TypeError('BlobStore: source can only yield Buffer / Uint8Array / string');
}

/**
 * Minimal extension → Content-Type table (the one from contract section 2 memory implementation).
 * Also used by fs implementation when caller does not inject `contentTypeForExt`.
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
