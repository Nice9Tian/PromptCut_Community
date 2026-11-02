/**
 * fs implementation of `BlobStore`: local content store
 * (contract `docs/plan/asset-store-contract.md` section 2).
 *
 * Directory layout is byte-for-byte identical to step 5 (the version originally written in
 * `server/asset-service.ts`):
 * - Whole files: `<dir>/<hash>.<ext>`, or `<dir>/<hash>` if there is no extension;
 * - Staging: `<dir>/.chunks/<hash>/`, containing `meta.json` (size, ext), `data` (whole file
 *   written in place by offset), and `<n>.ok` (marker for this chunk fully flushed to disk).
 * Before writing a chunk, delete its marker first, and only add it back once writing completes and
 * length matches: power outage, disconnects, or failing halfway through will only cause this chunk
 * to count as "not received".
 * Retransmitting a chunk that already has a marker will not rewrite it or delete the marker, but only
 * read it through to verify the length (see header in `blob-store.mjs` for rules).
 * When finalizing, read `data` once to compute the hash, then rename directly to the whole file
 * without copying again.
 *
 * This module does not import `vite-plugin-media.ts`: finding stored files (for compatibility with
 * legacy whole-file imports), writing media indexes after storing, and mapping extensions to
 * Content-Type are all handled via `hooks` injected by the caller. Only Node built-in modules are
 * imported.
 *
 * **Sharded directory layout** (`shard: true`, used by hosted setups; contract
 * `docs/plan/shared-project-contract.md` section 1):
 * - Whole files are placed in subdirectories split by the first two characters of the hash:
 *   `<dir>/<first two hash characters>/<hash>.<ext>` (`<dir>/<hh>/<hash>` if there is no extension);
 *   at most 256 subdirectories per namespace, created on demand;
 * - Staging is still `<dir>/.chunks/<hash>/` on the same filesystem as whole files, renamed over
 *   during finalization (temporary file plus rename);
 * - When finalizing, `fsync` `data` first, and after renaming, `fsync` its parent subdirectory
 *   (best effort: skipped on Windows if the directory cannot be opened). Chunks are not `fsync`ed:
 *   lost chunks are reported as "not received" during reconciliation and can be resumed;
 * - The two layouts are mutually incompatible for reading, so the layout is recorded in a `.layout`
 *   file (`ensureLayoutSync`) inside the directory chosen by the caller and checked on startup.
 * The local editor does not pass `shard`, keeping layout and behavior byte-for-byte identical to
 * before (without `fsync`).
 *
 * **Tiers** (see "Tiers" in `blob-store.mjs` for rules): recorded in staging under the `tier` field
 * of `meta.json` (written only when `small`); recorded after storing as an empty file
 * `<dir>/.tiers/<hash>`: its presence indicates a small tier, absence indicates original size.
 * Both layouts place it under `<dir>/.tiers/`.
 * This file is only left behind when `small` is reported, so places where no one reports a tier
 * (local editor, desktop app) keep the same directory structure as before.
 * When finalizing, delete any old marker for this hash first, and write the new marker only after
 * renaming into storage: if something goes wrong halfway through, at most a marker is missing,
 * meaning an extra item is counted rather than undercounted.
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
 * The same directory may be managed by multiple store instances concurrently (for example, if
 * middleware is created twice); locks are kept at the module level by "directory + hash", ensuring
 * registration and finalization for the same hash are serialized across the entire process.
 */
const withLock = createKeyedLock();

const HASH_FILE = /^([0-9a-f]{64})(?:\.[a-z0-9]+)?$/i;

async function exists(file) {
  try { await fs.stat(file); return true; } catch { return false; }
}

const SHARD_DIR = /^[0-9a-f]{2}$/;

/** Performs fsync on a file (or directory); best effort when `dir: true` (skipped on Windows if the directory cannot be opened or fsync is unsupported) */
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
 * Layout marker `.layout`
 * ------------------------------------------------------------------ */

/** File name of the layout marker: placed under the root directory chosen by the caller (`$PROMPTCUT_DATA_DIR/assets/.layout` for hosted setups) */
export const LAYOUT_FILE = '.layout';
/** Names of the two layouts (`.layout` content `{"v":1,"layout":"shard"|"flat"}`, contract section 11 [ruling]): `flat` is the original layout of the local editor, `shard` splits subdirectories by the first two hash characters */
export const LAYOUTS = Object.freeze({ flat: 'flat', shard: 'shard' });

/** Reads layout marker: returns null if missing; returns `{ layout: 'unreadable' }` if unreadable or format is invalid */
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
  } catch { /* Treated as unreadable below */ }
  return { layout: 'unreadable' };
}

/**
 * Checks layout on startup (contract section 1: "layout is recorded in `assets/.layout` and checked
 * on startup; startup is rejected on mismatch"):
 * - Marker exists: returns `{ ok: true, created: false }` if identical to `layout`, or
 *   `{ ok: false, found }` if different;
 * - No marker: if directory does not exist or is empty, creates directory and writes marker
 *   (temporary file plus rename, fsync), returning `{ ok: true, created: true }`;
 *   if directory already contains other items (data of unknown origin), returns
 *   `{ ok: false, found: 'unmarked' }` without writing a marker.
 * Errors creating or writing the directory are rethrown as-is (caller handles as unwritable data directory).
 * @param {string} dir
 * @param {string} layout  One of `LAYOUTS`
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
 * @param {string} options.dir  Local content store directory (`mediaDir(root)`)
 * @param {object} [options.hooks]
 * @param {(hash: string) => Promise<string | null>} [options.hooks.resolveFile]  Find stored files; defaults to matching filename in `dir` (`dir/<hh>` for sharded layout)
 * @param {(entry: { hash: string, file: string, ext: string, size: number, contentType: string }) => (void | Promise<void>)} [options.hooks.onStored]  Writes media index after storing
 * @param {(ext: string) => string} [options.hooks.contentTypeForExt]
 * @param {number} [options.chunkSize]  Defaults to 8 MiB
 * @param {boolean} [options.shard]  Sharded layout (see file header), defaults to false
 * @returns {import('./blob-store.mjs').BlobStore}
 */
export function createFsStore({ dir, hooks = {}, chunkSize = BLOB_CHUNK_SIZE, shard = false } = /** @type {any} */ ({})) {
  if (typeof dir !== 'string' || dir === '') throw new TypeError('createFsStore: dir must be a non-empty string');
  if (!Number.isSafeInteger(chunkSize) || chunkSize <= 0) throw new TypeError('createFsStore: chunkSize must be a positive integer');
  const base = path.resolve(dir);
  const sharded = shard === true;
  const contentTypeForExt = typeof hooks.contentTypeForExt === 'function' ? hooks.contentTypeForExt : minimalContentType;
  const onStored = typeof hooks.onStored === 'function' ? hooks.onStored : () => {};
  const resolveFile = typeof hooks.resolveFile === 'function' ? hooks.resolveFile : scanFile;
  /** Directory where whole files reside: `dir` in original layout, `dir/<first two hash characters>` in sharded layout */
  const homeOf = (hash) => (sharded ? path.join(base, hash.slice(0, 2)) : base);

  /** Default resolveFile: `<hash>` or `<hash>.<ext>` */
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
    } catch { /* No staging */ }
    return null;
  }

  async function writeMeta(hash, meta) {
    const d = stagingDir(hash);
    await fs.mkdir(d, { recursive: true });
    const tmp = path.join(d, `meta.${crypto.randomBytes(4).toString('hex')}.tmp`);
    // tier is written only for the small tier: meta.json for original size (vast majority) is byte-for-byte identical to before
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

  /** Stored whole file: { file, size } or null */
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

  /** Stored whole files: hash → byte count; also records hash → extension if `exts` is passed */
  async function scanStored(exts = null) {
    const sizes = new Map();
    async function countIn(home, prefix) {
      let entries = [];
      try { entries = await fs.readdir(home, { withFileTypes: true }); } catch { return; /* Directory does not exist yet */ }
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const m = HASH_FILE.exec(ent.name);
        if (!m) continue;
        const key = m[1].toLowerCase();
        if (prefix !== null && !key.startsWith(prefix)) continue;
        if (sizes.has(key)) continue;
        try { sizes.set(key, (await fs.stat(path.join(home, ent.name))).size); exts?.set(key, extOfName(ent.name)); } catch { /* Just deleted */ }
      }
    }
    if (sharded) {
      let subdirs = [];
      try { subdirs = await fs.readdir(base, { withFileTypes: true }); } catch { /* Directory does not exist yet */ }
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
    /** Layout: `flat` (original layout) or `shard` (sharded) */
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

      // Register (serial): pass idempotently if already stored; reject on size mismatch; do not rewrite
      // if this chunk was already received (see `blob-store.mjs` header); otherwise add marker back after
      // writing. Delete this chunk's marker only once when not yet registered (no `meta.json`) to clear
      // leftovers of unknown origin; do not delete if already registered: "no marker" was just evaluated
      // above, so any marker appearing now can only have been added by another concurrent path that just
      // finished writing; deleting it would cause that path, which already answered 200 and is about to
      // finalize, to receive incomplete (claude/push-incomplete)
      const pre = await withLock(lockKey(key), async () => {
        if (await resolveFile(key)) return 'complete';
        const meta = await readMeta(key);
        if (meta && meta.size !== size) return { conflict: meta.size };
        const d = stagingDir(key);
        // ext uses the first registered non-empty value; tier only falls back to original (see "Tiers" in `blob-store.mjs`)
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
        // Create an empty data if it does not exist; do not truncate if it already exists (other chunks may have already been written)
        await (await fs.open(path.join(d, 'data'), 'a')).close();
        return 'ok';
      });
      if (pre === 'complete') { await drainSource(source); return { status: 'complete' }; }
      if (typeof pre === 'object') return { status: 'size-mismatch', size: pre.conflict };

      const d = stagingDir(key);
      if (pre === 'have') {
        // Retransmitting an already-received chunk: leave stored bytes untouched, read through only to verify length; rethrow aborted stream as-is, keep marker
        const got = await countSource(source);
        if (got === expected) return { status: 'ok', bytes: got };
        await withLock(lockKey(key), () => fs.rm(path.join(d, `${n}.ok`), { force: true }));
        return { status: 'length', expected, got };
      }
      let bytes = 0;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          // Do not write excess bytes (to avoid writing into the next chunk's position); check length after reading through
          const buf = toBuffer(chunk);
          const room = expected - bytes;
          bytes += buf.length;
          if (room <= 0) return cb();
          cb(null, buf.length > room ? buf.subarray(0, room) : buf);
        },
      });
      // r+: write in place without truncating bytes already written by other chunks. pipeline returns only
      // after file handle is closed; errors (disconnects, etc.) are rethrown to caller as-is; without
      // this chunk's marker added, it is reported as "not received" during reconciliation
      const output = createWriteStream(path.join(d, 'data'), { flags: 'r+', start: n * chunkSize });
      track?.(output);
      await pipeline(source, counter, output, ...(signal ? [{ signal }] : []));
      await beforeCommit?.();
      signal?.throwIfAborted();
      if (bytes !== expected) return { status: 'length', expected, got: bytes };
      // Markers land in the staging directory; if discarded by finalization during this time, the directory
      // is gone, so the marker is not written. The directory is missing because another path finalized and
      // stored first (both paths pushing the same content simultaneously): this chunk's bytes are already
      // in the whole file, return complete
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
        // Handle is closed before pipeline returns, allowing rename below (open files cannot be renamed on Windows)
        const input = createReadStream(data, { start: 0, end: meta.size - 1 });
        track?.(input);
        await pipeline(input, digest, ...(signal ? [{ signal }] : []));
        const actual = digest.digest('hex');
        if (actual !== key) {
          await fs.rm(d, { recursive: true, force: true });
          return { status: 'hash-mismatch', actual };
        }
        // In-place written data will not exceed size (every chunk length is validated); truncate anyway to be safe
        await fs.truncate(data, meta.size);
        const file = meta.ext ? `${key}.${meta.ext}` : key;
        const home = homeOf(key);
        if (sharded) {
          // Sharded layout: flush whole-file bytes to disk before renaming, then flush subdirectory after
          // renaming (contract section 9 [ruling]: fsync is performed only on complete). Errors occurring
          // halfway through (including ENOSPC, EDQUOT) are rethrown as-is: staging is untouched, received
          // chunks are preserved, not counted as stored
          await fsyncPath(data);
          await fs.mkdir(home, { recursive: true });
        }
        await beforeCommit?.();
        signal?.throwIfAborted();
        // Clear any previous small-tier marker for this hash first (rethrow as-is if deletion fails, do not store): prevents an original-size item bearing an old marker from being undercounted
        await fs.rm(tierMark(key), { force: true });
        const target = path.join(home, file);
        await fs.rename(data, target);
        // Race between undo/project close and in-flight rename: roll this unpublished new whole file back to staging; do not touch any existing whole files.
        if (signal?.aborted) { await fs.rename(target, data); signal.throwIfAborted(); }
        // Small-tier marker is written only after storing; if writing fails, treat as original size (count one extra, never undercount)
        if (meta.tier === 'small') {
          try { await fs.mkdir(tierDir, { recursive: true }); await fs.writeFile(tierMark(key), ''); } catch { /* Treated as original size */ }
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
          try { await fs.rm(file); removed = true; } catch { /* Already gone */ }
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
     * Stored whole files in ascending hash order: `[{ hash, size }]` (unique to fs implementation, not
     * in BlobStore interface; used for migration inventory in hosted setups). Only counts files matching
     * `<hash>` or `<hash>.<ext>`; sharded layout only recognizes matching first two characters.
     */
    async list() {
      const sizes = await scanStored();
      return [...sizes.keys()].sort().map((hash) => ({ hash, size: sizes.get(hash) }));
    },

    async usage() {
      const sizes = await scanStored();
      let staging = 0;
      let dirs = [];
      try { dirs = await fs.readdir(path.join(base, '.chunks'), { withFileTypes: true }); } catch { /* No staging */ }
      for (const ent of dirs) if (ent.isDirectory() && /^[0-9a-f]{64}$/.test(ent.name)) staging++;
      let bytes = 0;
      for (const v of sizes.values()) bytes += v;
      return { blobs: sizes.size, bytes, staging };
    },

    async inventory() {
      const exts = new Map();
      const sizes = await scanStored(exts);
      let marks = [];
      try { marks = await fs.readdir(tierDir); } catch { /* No small-tier marker */ }
      const small = new Set(marks.map((n) => n.toLowerCase()).filter((n) => /^[0-9a-f]{64}$/.test(n)));
      const stored = [...sizes.keys()].sort().map((hash) => ({ hash, ext: exts.get(hash) ?? '', tier: small.has(hash) ? 'small' : 'original' }));
      const staging = [];
      let dirs = [];
      try { dirs = await fs.readdir(path.join(base, '.chunks'), { withFileTypes: true }); } catch { /* No staging */ }
      for (const ent of dirs) {
        if (!ent.isDirectory() || !/^[0-9a-f]{64}$/.test(ent.name)) continue;
        const meta = await readMeta(ent.name);
        if (meta) staging.push({ hash: ent.name, ext: meta.ext, tier: meta.tier });
      }
      return { stored, staging };
    },
  };
}
