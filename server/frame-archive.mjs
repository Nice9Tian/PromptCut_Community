import { gzipSync, gunzipSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Version 2 stores independently compressed 60 second blocks. A complete
 * checkpoint is kept every 10 seconds; frames between checkpoints only carry
 * a prefix/suffix delta. The outer archive remains one gzip/base64 field.
 */
export const FRAME_ARCHIVE_VERSION = 2;
export const FRAME_CHECKPOINT_SECONDS = 10;
export const FRAME_BLOCK_SECONDS = 60;
const MAX_EXPANDED_FRAMES = 16;
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024;
// Frozen canvases can make a single HTML sample several megabytes. A time
// bound alone lets legitimate blocks exceed the decoder's safety limit.
const MAX_BLOCK_BYTES = 8 * 1024 * 1024;

const asEntries = value => value instanceof Map ? [...value.entries()] : [...(value || [])];
const b64 = value => Buffer.from(value).toString('base64');
const unb64 = value => Buffer.from(value, 'base64');

function delta(previous, html) {
  let prefix = 0, suffix = 0;
  while (prefix < previous.length && prefix < html.length && previous[prefix] === html[prefix]) prefix++;
  while (suffix < previous.length - prefix && suffix < html.length - prefix && previous[previous.length - suffix - 1] === html[html.length - suffix - 1]) suffix++;
  return [prefix, suffix, html.slice(prefix, html.length - suffix)];
}

function apply(previous, record) {
  if (record[1] === 1) {
    if (typeof record[4] !== 'string') throw new Error('Corrupt frame checkpoint');
    return record[4];
  }
  const [, , prefix, suffix, middle] = record;
  if (!Number.isSafeInteger(prefix) || !Number.isSafeInteger(suffix) || prefix < 0 || suffix < 0 || prefix + suffix > previous.length || typeof middle !== 'string') throw new Error('Corrupt frame delta');
  return previous.slice(0, prefix) + middle + (suffix ? previous.slice(-suffix) : '');
}

function encodeBlocks(frames, { fps = 30, checkpointSeconds = FRAME_CHECKPOINT_SECONDS, blockSeconds = FRAME_BLOCK_SECONDS } = {}) {
  // Loading an existing v2 archive and saving it again should not inflate all
  // blocks just to recompress the unchanged portion. New samples are kept in
  // `overlay`; only that uncommon case needs materialization.
  if (frames instanceof LazyFrameStore) {
    if (frames.overlay.size === 0 && frames.pendingSpill.size === 0) return frames.blocks;
    // Keep only frame numbers here. Loading every spilled HTML value at once
    // defeats spilling and can exhaust the heap during the first archive save.
    const pending = new Set([...frames.overlay.keys(), ...frames.pendingSpill]);
    const merged = [];
    const ranges = [...frames.blocks].sort((a, b) => a.start - b.start);
    for (const block of frames.blocks) {
      const affected = [...pending.keys()].filter(frame => frame >= block.start && frame <= block.end);
      if (!affected.length) { merged.push(block); continue; }
      const records = decodeBlock(block);
      const keys = [...new Set([...records.map(record => Number(record[0])), ...affected])].sort((a, b) => a - b);
      function* values() {
        let at = 0, previous = '';
        for (const frame of keys) {
          // Decode the old delta chain once, including records overwritten by
          // pending edits: later deltas still refer to the old predecessor.
          while (at < records.length && Number(records[at][0]) <= frame) previous = apply(previous, records[at++]);
          yield [frame, pending.has(frame) ? frames.pendingValue(frame) : previous];
          pending.delete(frame);
        }
      }
      merged.push(...encodeSortedFrames(values(), { fps, checkpointSeconds, blockSeconds }));
    }
    // Do not let a sparse pending range bridge across an existing block: that
    // would create overlapping blocks and make a later binary lookup choose
    // the wrong stream. Split at every old block boundary instead.
    let segment = [], previousFrame;
    for (const frame of [...pending.keys()].sort((a, b) => a - b)) {
      if (previousFrame !== undefined && ranges.some(range => previousFrame < range.start && range.start <= frame)) {
        merged.push(...encodeSortedFrames(segment.values().map(frame => [frame, frames.pendingValue(frame)]), { fps, checkpointSeconds, blockSeconds }));
        segment = [];
      }
      segment.push(frame);
      previousFrame = frame;
    }
    if (segment.length) merged.push(...encodeSortedFrames(segment.values().map(frame => [frame, frames.pendingValue(frame)]), { fps, checkpointSeconds, blockSeconds }));
    return merged.sort((a, b) => a.start - b.start);
  }
  const sorted = asEntries(frames).filter(([n, html]) => Number.isSafeInteger(Number(n)) && typeof html === 'string')
    .map(([n, html]) => [Number(n), html]).sort(([a], [b]) => a - b);
  return encodeSortedFrames(sorted, { fps, checkpointSeconds, blockSeconds });
}

function encodeSortedFrames(frames, { fps, checkpointSeconds, blockSeconds }) {
  const checkpointEvery = Math.max(1, Math.round(Number(fps) * Number(checkpointSeconds)) || 1);
  const blockEvery = Math.max(checkpointEvery, Math.round(Number(fps) * Number(blockSeconds)) || checkpointEvery);
  const blocks = [];
  let records = [], previous = '', checkpointFrame = -Infinity, endLimit = -Infinity, bytes = 2;
  const flush = () => {
    if (!records.length) return;
    blocks.push({ start: records[0][0], end: records[records.length - 1][0], index: records.map(record => record[0]), data: b64(gzipSync(Buffer.from(JSON.stringify(records), 'utf8'))) });
    records = []; previous = ''; checkpointFrame = -Infinity; bytes = 2;
  };
  for (const [frame, html] of frames) {
    if (frame >= endLimit) flush();
    let checkpoint = !records.length || frame - checkpointFrame >= checkpointEvery;
    let [prefix, suffix, middle] = checkpoint ? [0, 0, html] : delta(previous, html);
    // A substring can retain its multi-megabyte source through a V8 sliced
    // string. Own the small delta so a tiny change does not pin a whole frame.
    if (!checkpoint) middle = Buffer.from(middle, 'utf8').toString('utf8');
    let record = [frame, checkpoint ? 1 : 0, prefix, suffix, middle];
    let recordBytes = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (records.length && bytes + recordBytes > MAX_BLOCK_BYTES) {
      flush(); checkpoint = true; record = [frame, 1, 0, 0, html];
      recordBytes = Buffer.byteLength(JSON.stringify(record)) + 1;
    }
    if (!records.length) endLimit = frame + blockEvery;
    records.push(record); bytes += recordBytes; previous = html;
    if (checkpoint) checkpointFrame = frame;
  }
  flush();
  return blocks;
}

function decodeBlock(block) {
  let records;
  try { records = JSON.parse(gunzipSync(unb64(block.data), { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8')); }
  catch { throw new Error('Corrupt frame archive block'); }
  if (!Array.isArray(records)) throw new Error('Corrupt frame archive block');
  return records;
}

function findBlock(blocks, frame) {
  let selected = null;
  for (const block of blocks) {
    if (frame < block.start) break;
    selected = block;
    if (frame <= block.end) break;
  }
  return selected;
}

/** Lazy Map-like store. Only the block containing a requested frame is inflated. */
function controlDirectoryName(id) {
  // Control ids are project data. Keep them out of the filesystem path while
  // still making the directory stable across archive reopen/save cycles.
  return createHash('sha1').update(String(id)).digest('hex');
}

function prepareSpillDirectory(spillDir) {
  if (!spillDir) return null;
  const base = path.resolve(spillDir);
  // Every live store owns its spill files. Reopening a newer archive must not
  // erase unsaved overlays owned by another batch or the prerender process.
  try {
    fs.mkdirSync(base, { recursive: true });
    return fs.mkdtempSync(path.join(base, `live-${process.pid}-`));
  } catch { return null; }
}

/** Read errors that mean "try again shortly", not "the spill file is bad". */
const TRANSIENT_READ_ERRORS = new Set(['EBUSY', 'EPERM', 'EACCES', 'EMFILE']);
/** Retries after the first failed read, so at most 1 + 5 reads. */
export const SPILL_READ_RETRIES = 5;
/** 20, 40, 80, 160, 200 ms. */
export const spillBackoffMs = attempt => Math.min(200, 20 * 2 ** attempt);
const sleepCell = new Int32Array(new SharedArrayBuffer(4));
// readSpill is synchronous (LazyFrameStore.get is), so the backoff blocks.
// Worst case is about half a second, only while a file is actually held.
function sleepSync(ms) { Atomics.wait(sleepCell, 0, 0, ms); }

export class LazyFrameStore {
  constructor(blocks = [], { spillDir = null } = {}) {
    this.blocks = blocks;
    this.spillDir = spillDir ? path.resolve(spillDir) : null;
    this.cache = new Map();
    this.decoded = new Map();
    this.overlay = new Map();
    // A live sampler can produce more frames than the in-memory window before
    // the next archive flush. Keep those pending values on disk too, while
    // retaining their frame numbers so packFrames can fold them back in.
    this.pendingSpill = new Set();
    this.index = new Set(blocks.flatMap(block => block.index || []));
    for (const block of blocks) if (!block.index) for (let n = block.start; n <= block.end; n++) this.index.add(n);
  }
  get size() { return this.index.size + [...this.overlay.keys()].filter(n => !this.index.has(n)).length; }
  has(frame) { return this.overlay.has(Number(frame)) || this.index.has(Number(frame)); }
  spillPath(frame) {
    return this.spillDir ? path.join(this.spillDir, `${Number(frame)}.html.gz`) : null;
  }
  removeSpill(frame) {
    const file = this.spillPath(frame);
    if (!file) return;
    try { fs.rmSync(file, { force: true }); } catch { /* Disposable cache. */ }
  }
  writeSpill(frame, value) {
    const file = this.spillPath(frame);
    if (!file || typeof value !== 'string') return false;
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.mkdirSync(this.spillDir, { recursive: true });
      fs.writeFileSync(temp, gzipSync(Buffer.from(value, 'utf8')));
      fs.renameSync(temp, file);
      return true;
    } catch {
      try { fs.rmSync(temp, { force: true }); } catch { /* Best effort cleanup. */ }
      // Unsaved samples have no archive fallback: callers must retain them
      // in memory until a later spill or archive save succeeds.
      return false;
    }
  }
  /**
   * Read one spilled frame. Only a file that is gone (ENOENT) or whose content
   * fails to decode counts as lost: it is removed and `undefined` returned.
   * Transient errors (another process or an antivirus scanner holding the
   * file: EBUSY/EPERM/EACCES, or running out of handles: EMFILE) are retried
   * with a short backoff and never delete the file — it is still the only
   * copy of a pending sample. Any other read error also keeps the file.
   */
  readSpill(frame) {
    const file = this.spillPath(frame);
    if (!file) return undefined;
    let bytes;
    for (let attempt = 0; ; attempt++) {
      try {
        bytes = fs.readFileSync(file);
        break;
      } catch (err) {
        if (err?.code === 'ENOENT') return undefined;
        if (TRANSIENT_READ_ERRORS.has(err?.code) && attempt < SPILL_READ_RETRIES) {
          sleepSync(spillBackoffMs(attempt));
          continue;
        }
        return undefined;
      }
    }
    try {
      return gunzipSync(bytes, { maxOutputLength: 256 * 1024 * 1024 }).toString('utf8');
    } catch {
      try { fs.rmSync(file, { force: true }); } catch { /* Disposable cache. */ }
      return undefined;
    }
  }
  set(frame, value) {
    frame = Number(frame);
    this.overlay.set(frame, value);
    this.index.add(frame);
    // A newly sampled frame supersedes any previously spilled expansion.
    this.removeSpill(frame);
    this.pendingSpill.delete(frame);
    this.cache.delete(frame);
    while (this.overlay.size > MAX_EXPANDED_FRAMES || this.expandedBytes(this.overlay) > MAX_EXPANDED_BYTES) {
      const old = this.overlay.keys().next().value;
      const oldValue = this.overlay.get(old);
      if (!this.writeSpill(old, oldValue)) break;
      this.overlay.delete(old);
      this.pendingSpill.add(old);
    }
    return this;
  }
  expandedBytes(values) { let bytes = 0; for (const value of values.values()) bytes += value.length * 2; return bytes; }
  pendingValue(frame) {
    const value = this.overlay.has(frame) ? this.overlay.get(frame) : this.readSpill(frame);
    if (value === undefined) throw new Error(`HTML frame cache ${frame} is missing or unreadable; rebuild the frame cache before saving.`);
    return value;
  }
  pendingEntries() {
    const values = new Map(this.overlay);
    for (const frame of this.pendingSpill) {
      if (!values.has(frame)) {
        const value = this.readSpill(frame);
        if (value === undefined) throw new Error(`HTML frame cache ${frame} is missing or unreadable; rebuild the frame cache before saving.`);
        values.set(frame, value);
      }
    }
    return values;
  }
  get(frame) {
    frame = Number(frame);
    if (this.overlay.has(frame)) return this.overlay.get(frame);
    if (this.cache.has(frame)) return this.cache.get(frame);
    const spilled = this.readSpill(frame);
    if (spilled !== undefined) {
      this.cache.set(frame, spilled);
      while (this.cache.size > MAX_EXPANDED_FRAMES || this.expandedBytes(this.cache) > MAX_EXPANDED_BYTES) {
        const old = this.cache.keys().next().value;
        const value = this.cache.get(old);
        this.cache.delete(old);
        this.writeSpill(old, value);
      }
      return spilled;
    }
    const block = findBlock(this.blocks, frame);
    if (!block) return undefined;
    let records = this.decoded.get(block);
    if (!records) {
      records = decodeBlock(block);
      this.decoded.set(block, records);
      // Keep decompressed records bounded. HTML strings requested by callers
      // remain in `cache`, while the much larger delta array is short lived.
      while (this.decoded.size > 1) this.decoded.delete(this.decoded.keys().next().value);
    }
    let previous = '';
    for (const record of records) {
      const n = Number(record[0]);
      if (!Number.isSafeInteger(n) || n < 0) throw new Error('Corrupt frame archive');
      previous = apply(previous, record);
      if (n === frame) {
        this.cache.set(frame, previous);
        while (this.cache.size > MAX_EXPANDED_FRAMES || this.expandedBytes(this.cache) > MAX_EXPANDED_BYTES) {
          const old = this.cache.keys().next().value;
          const value = this.cache.get(old);
          this.cache.delete(old);
          this.writeSpill(old, value);
        }
        return previous;
      }
      if (n > frame) break;
    }
    return undefined;
  }
  *keys() { yield* [...this.index].sort((a, b) => a - b); }
  *entries() { for (const key of this.keys()) yield [key, this.get(key)]; }
  [Symbol.iterator]() { return this.entries(); }
  materialize() { return new Map(this.entries()); }
}

function decodeLegacy(deltas) {
  let previous = '', last = -Infinity;
  const frames = new Map();
  for (const [frame, prefix, suffix, middle] of deltas) {
    if (!Number.isSafeInteger(frame) || frame <= last || !Number.isSafeInteger(prefix) || !Number.isSafeInteger(suffix) || prefix < 0 || suffix < 0 || prefix + suffix > previous.length || typeof middle !== 'string') throw new Error('Corrupt frame delta');
    previous = previous.slice(0, prefix) + middle + (suffix ? previous.slice(-suffix) : '');
    frames.set(frame, previous); last = frame;
  }
  return frames;
}

export function packFrames(key, frames, controls = new Map(), options = {}) {
  const fps = Number(options.fps || 30);
  const doc = { version: FRAME_ARCHIVE_VERSION, key, fps,
    checkpointSeconds: Number(options.checkpointSeconds || FRAME_CHECKPOINT_SECONDS), blockSeconds: Number(options.blockSeconds || FRAME_BLOCK_SECONDS),
    blocks: encodeBlocks(frames, { fps, checkpointSeconds: options.checkpointSeconds, blockSeconds: options.blockSeconds }),
    controls: asEntries(controls).map(([id, values]) => [id, encodeBlocks(values, { fps, checkpointSeconds: options.checkpointSeconds, blockSeconds: options.blockSeconds })]) };
  // Large local caches remain complete on disk; embedding hundreds of MB in
  // a polling response or .proc would exhaust both Node and WebView heaps.
  const size = [...doc.blocks, ...doc.controls.flatMap(([, blocks]) => blocks)].reduce((sum, block) => sum + (block.encodedBytes ?? block.data.length), 0);
  if (size > (options.maxBytes ?? Infinity)) return null;
  const portable = blocks => blocks.map(({ start, end, index, data }) => ({ start, end, index, data }));
  doc.blocks = portable(doc.blocks); doc.controls = doc.controls.map(([id, blocks]) => [id, portable(blocks)]);
  return b64(gzipSync(Buffer.from(JSON.stringify(doc), 'utf8')));
}

/** Internal cache manifest: compressed blocks are immutable, content-addressed
 * files. Only a requested block is loaded; portable v2 .proc archives remain
 * readable and can still be exported when their size is reasonable. */
export function packFrameCache(dir, key, frames, controls = new Map(), options = {}) {
  const folder = path.join(dir, 'html-blocks');
  fs.mkdirSync(folder, { recursive: true });
  const persist = blocks => blocks.map(block => {
    if (block.file && block.folder === folder && fs.existsSync(path.join(folder, block.file))) {
      return { start: block.start, end: block.end, index: block.index, file: block.file, encodedBytes: block.encodedBytes };
    }
    const data = block.data;
    const file = createHash('sha256').update(data).digest('hex') + '.base64';
    const target = path.join(folder, file);
    if (!fs.existsSync(target)) {
      const temp = target + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      fs.writeFileSync(temp, data, 'utf8'); fs.renameSync(temp, target);
    }
    return { start: block.start, end: block.end, index: block.index, file, encodedBytes: data.length };
  });
  return JSON.stringify({ version: 1, key, fps: options.fps || 30,
    blocks: persist(encodeBlocks(frames, options)),
    controls: asEntries(controls).map(([id, values]) => [id, persist(encodeBlocks(values, options))]) });
}

export function unpackFrameCache(encoded, key, { dir, spillDir } = {}) {
  const doc = JSON.parse(encoded);
  if (doc.version !== 1 || doc.key !== key || !Array.isArray(doc.blocks) || !Array.isArray(doc.controls)) throw new Error('Incompatible frame cache');
  const folder = path.join(dir, 'html-blocks');
  const lazy = blocks => blocks.map(meta => {
    if (!/^[a-f0-9]{64}\.base64$/.test(meta.file) || !Array.isArray(meta.index)) throw new Error('Corrupt frame cache path');
    return { ...meta, folder, get data() { return fs.readFileSync(path.join(folder, meta.file), 'utf8'); } };
  });
  doc.blocks = lazy(doc.blocks); doc.controls = doc.controls.map(([id, blocks]) => [id, lazy(blocks)]);
  return createFrameArchive({ doc, spillDir });
}

export function unpackFrameArchive(encoded, key, { spillDir = null } = {}) {
  const doc = JSON.parse(gunzipSync(unb64(encoded), { maxOutputLength: 512 * 1024 * 1024 }).toString('utf8'));
  if (doc.key !== key || !Array.isArray(doc.blocks || doc.deltas)) throw new Error('Incompatible frame archive');
  if (doc.version === 1) return { version: 1, frames: decodeLegacy(doc.deltas), controls: new Map((doc.controls || []).map(([id, deltas]) => [id, decodeLegacy(deltas)])) };
  if (doc.version !== FRAME_ARCHIVE_VERSION || !Array.isArray(doc.blocks)) throw new Error('Incompatible frame archive');
  return createFrameArchive({ spillDir, doc });
}

/** Cold stores must have the same spill policy as reopened archives. */
export function createFrameArchive({ spillDir = null, doc = { blocks: [], controls: [] } } = {}) {
  const spillBase = spillDir ? path.resolve(spillDir) : null;
  spillDir = prepareSpillDirectory(spillDir);
  const stageDir = spillDir ? path.join(spillDir, 'stage') : null;
  return {
    version: FRAME_ARCHIVE_VERSION,
    dispose: () => {
      if (spillBase && spillDir && path.dirname(spillDir) === spillBase && path.basename(spillDir).startsWith(`live-${process.pid}-`)) {
        try { fs.rmSync(spillDir, { recursive: true, force: true }); } catch { /* Disposable cache. */ }
      }
    },
    frames: new LazyFrameStore(doc.blocks, { spillDir: stageDir }),
    createControl: id => new LazyFrameStore([], { spillDir: spillDir ? path.join(spillDir, 'controls', controlDirectoryName(id)) : null }),
    controls: new Map((doc.controls || []).map(([id, blocks]) => [id, new LazyFrameStore(blocks, { spillDir: spillDir ? path.join(spillDir, 'controls', controlDirectoryName(id)) : null })])),
    fps: doc.fps,
    checkpointSeconds: doc.checkpointSeconds,
    blockSeconds: doc.blockSeconds,
  };
}

export function unpackFrames(encoded, key) {
  const frames = unpackFrameArchive(encoded, key).frames;
  return frames instanceof LazyFrameStore ? frames.materialize() : frames;
}
