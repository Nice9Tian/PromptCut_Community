/**
 * The memory implementation of `BlobStore` (contract `docs/plan/asset-store-contract.md` section 2).
 *
 * Kept entirely in memory, for testing: `chunkSize` can be dialed down. Behavioral rules are
 * identical to the fs implementation (see header of `blob-store.mjs`); `mtimeMs` takes the stored
 * timestamp, `contentType` is provided from a minimal extension table; returns `size-mismatch` when
 * `size` exceeds 256 MiB. Only imports Node built-in modules.
 */
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import {
  BLOB_CHUNK_SIZE, normalizeHash, normalizeExt, checkChunkArgs, chunkCountOf, chunkLengthOf,
  createKeyedLock, drainSource, countSource, toBuffer, minimalContentType, normalizeTier,
} from './blob-store.mjs';

/** Single-file cap: memory implementation is for testing only, returns `size-mismatch` when size exceeds it (contract section 8, item 7) */
export const MEMORY_MAX_SIZE = 256 * 1024 * 1024;

/** Byte slice → readable stream in non-object mode */
function streamOf(buf) {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) { sent = true; if (buf.length) this.push(buf); }
      this.push(null);
    },
  });
}

/**
 * @param {object} [options]
 * @param {number} [options.chunkSize]  Default 8 MiB
 * @param {() => number} [options.now]  Timestamp when stored, defaults to `Date.now`
 * @returns {import('./blob-store.mjs').BlobStore}
 */
export function createMemoryStore({ chunkSize = BLOB_CHUNK_SIZE, now = Date.now } = {}) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError('createMemoryStore: chunkSize must be a positive integer');
  const withLock = createKeyedLock();
  /** @type {Map<string, { data: Buffer, ext: string, tier: 'small' | 'original', mtimeMs: number }>} */
  const blobs = new Map();
  /** @type {Map<string, { size: number, ext: string, tier: 'small' | 'original', parts: Map<number, Buffer>, received: Set<number> }>} */
  const staging = new Map();

  return {
    kind: 'memory',
    chunkSize,

    async stat(hash) {
      const blob = blobs.get(normalizeHash(hash));
      if (!blob) return null;
      return { size: blob.data.length, ext: blob.ext, contentType: minimalContentType(blob.ext), mtimeMs: blob.mtimeMs };
    },

    async read(hash, { start, end } = {}) {
      const blob = blobs.get(normalizeHash(hash));
      if (!blob) return null;
      const s = start ?? 0;
      const e = end ?? blob.data.length - 1;
      return streamOf(blob.data.subarray(s, e + 1));
    },

    async chunks(hash) {
      const key = normalizeHash(hash);
      const blob = blobs.get(key);
      if (blob) {
        const count = chunkCountOf(blob.data.length, chunkSize);
        return { size: blob.data.length, chunkSize, received: Array.from({ length: count }, (_, i) => i), complete: true };
      }
      const st = staging.get(key);
      if (!st) return { size: null, chunkSize, received: [], complete: false };
      return { size: st.size, chunkSize, received: [...st.received].sort((a, b) => a - b), complete: false };
    },

    async putChunk(hash, n, { size, ext, tier } = /** @type {any} */ ({}), source) {
      const key = normalizeHash(hash);
      checkChunkArgs(n, size);
      const wantExt = normalizeExt(ext);
      const wantTier = normalizeTier(tier);
      const count = chunkCountOf(size, chunkSize);
      if (n >= count) return { status: 'out-of-range', count };
      const expected = chunkLengthOf(size, n, chunkSize);

      const pre = await withLock(key, async () => {
        if (blobs.has(key)) return 'complete';
        let st = staging.get(key);
        if (st && st.size !== size) return { conflict: st.size };
        // For testing only: reporting an astronomical size must not crash the process (contract section 8, item 7)
        if (size > MEMORY_MAX_SIZE) return { conflict: st ? st.size : MEMORY_MAX_SIZE };
        if (!st) {
          st = { size, ext: wantExt, tier: wantTier, parts: new Map(), received: new Set() };
          staging.set(key, st);
        } else {
          if (!st.ext && wantExt) st.ext = wantExt;
          // Tiers only fall back to original (see blob-store.mjs "Tiers")
          if (wantTier !== 'small') st.tier = 'original';
        }
        // Retransmitting already received chunks: do not rewrite, do not clear markers (see blob-store.mjs header)
        if (st.received.has(n)) return { have: st };
        return st;
      });
      if (pre === 'complete') { await drainSource(source); return { status: 'complete' }; }
      if ('have' in pre) {
        const got = await countSource(source);
        if (got === expected) return { status: 'ok', bytes: got };
        await withLock(key, async () => { pre.have.received.delete(n); });
        return { status: 'length', expected, got };
      }
      if (!('parts' in pre)) return { status: 'size-mismatch', size: pre.conflict };

      const st = pre;
      const buf = Buffer.alloc(expected);
      let bytes = 0;
      for await (const chunk of source) {
        const part = toBuffer(chunk);
        const room = expected - bytes;
        if (room > 0) part.copy(buf, bytes, 0, Math.min(part.length, room));
        bytes += part.length;
      }
      if (bytes !== expected) return { status: 'length', expected, got: bytes };
      // Another path finalized and stored mid-write: bytes for this chunk are already in the whole file, return complete
      if (staging.get(key) !== st) return blobs.has(key) ? { status: 'complete' } : { status: 'discarded' };
      st.parts.set(n, buf);
      st.received.add(n);
      return { status: 'ok', bytes };
    },

    async complete(hash) {
      const key = normalizeHash(hash);
      return withLock(key, async () => {
        const blob = blobs.get(key);
        if (blob) return { status: 'ok', size: blob.data.length, ext: blob.ext };
        const st = staging.get(key);
        if (!st) return { status: 'unknown' };
        const count = chunkCountOf(st.size, chunkSize);
        const missing = [];
        for (let i = 0; i < count; i++) if (!st.received.has(i)) missing.push(i);
        if (missing.length) return { status: 'incomplete', missing };
        const digest = crypto.createHash('sha256');
        const parts = [];
        for (let i = 0; i < count; i++) { const p = /** @type {Buffer} */ (st.parts.get(i)); digest.update(p); parts.push(p); }
        const actual = digest.digest('hex');
        staging.delete(key);
        if (actual !== key) return { status: 'hash-mismatch', actual };
        blobs.set(key, { data: Buffer.concat(parts, st.size), ext: st.ext, tier: st.tier, mtimeMs: now() });
        return { status: 'ok', size: st.size, ext: st.ext };
      });
    },

    async remove(hash) {
      const key = normalizeHash(hash);
      return withLock(key, async () => {
        const a = blobs.delete(key);
        const b = staging.delete(key);
        return a || b;
      });
    },

    async usage() {
      let bytes = 0;
      for (const blob of blobs.values()) bytes += blob.data.length;
      return { blobs: blobs.size, bytes, staging: staging.size };
    },

    async inventory() {
      return {
        stored: [...blobs].map(([hash, b]) => ({ hash, ext: b.ext, tier: b.tier === 'small' ? 'small' : 'original' })),
        staging: [...staging].map(([hash, st]) => ({ hash, ext: st.ext, tier: st.tier === 'small' ? 'small' : 'original' })),
      };
    },
  };
}
