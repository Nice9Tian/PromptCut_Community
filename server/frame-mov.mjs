import fs from 'node:fs/promises';
import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { atomic } from './asset-store/atomic.mjs';
export { atomic } from './asset-store/atomic.mjs';
import { randomUUID } from 'node:crypto';
import { PNG } from 'pngjs';
import { isFullyTransparentPng } from './frame-validity.mjs';
import { readRenderRecord, withRenderRecord } from './png-record.mjs';

const pad = n => String(n).padStart(6, '0');
const exists = file => fs.access(file).then(() => true, () => false);

/** A fully transparent render is accepted only when a second render agrees. */
export const CLEAR_CONFIRMATIONS = 2;

/** What produced a cached frame: `capture` (capture code fingerprint),
 * `scale` (device scale factor) and `cards` (the visible card keys at that
 * frame). Fields absent from the expectation are not compared, and `cards`
 * is compared only when both sides know it: a lookup made before the card
 * plan exists must not throw away every frame. */
export function signatureMatches(recorded, expected) {
  if (!expected) return true;
  if (!recorded) return false;
  if (expected.capture !== undefined && recorded.capture !== expected.capture) return false;
  if (expected.scale !== undefined && recorded.scale !== expected.scale) return false;
  if (expected.cards != null && recorded.cards != null && recorded.cards !== expected.cards) return false;
  return true;
}

/**
 * Full-scene MOV cache.
 *
 * PNGs are the random-access side of the cache and the MOV is the sequential
 * side.  A small frame table is persisted separately so a missing frame can
 * be distinguished from a frame that has not been rendered yet.  The writer
 * consumes only a contiguous prefix (out-of-order see_frames requests stay on
 * disk until their gap is filled), which keeps the ffmpeg pipe bounded.
 *
 * Each PNG also carries a render record (png-record.mjs): what produced it and
 * whether it was an empty (fully transparent) image. It lives in the PNG, not
 * the table, because the editor server and the prerender worker share this
 * directory and each rewrites the table from its own view. Lookups verify the
 * record: a frame whose producer no longer matches is removed from the table,
 * the PNG and any published movie; an empty frame counts as "waiting to
 * render" until a second render confirms it really is empty.
 */
export class MovFrameStore {
  /**
   * `movie`(缺省 true):要不要把连续的 PNG 前缀编成 `mov/full.mov`。整场景那一份(`entry.mov`)传 false:
   * 那个文件只被判过存在、没有人读内容(legacy 整帧通道方案 B,AGENT-maint-3),PNG 表照旧是它的全部用途。
   * 传 false 时 `start()` 什么也不做,载入时把旧版本留下的 `full.mov` 删掉。独立卡的那一份(`card-cache.mjs`)不变。
   */
  constructor({ dir, fps = 30, movie = true } = {}) {
    this.dir = dir;
    this.fps = Number(fps) || 30;
    this.movie = movie !== false;
    this.movDir = path.join(dir, 'mov');
    this.frameDir = path.join(this.movDir, 'frames');
    this.tableFile = path.join(this.movDir, 'frames.json');
    this.movieFile = path.join(this.movDir, 'full.mov');
    this.tempMovie = path.join(this.movDir, `full-${process.pid}.tmp.mov`);
    this.frames = new Set();
    /** frame -> render record read from (or written into) its PNG */
    this.records = new Map();
    /** frames whose PNG was read and carries no record (written by older code) */
    this.unrecorded = new Set();
    this.pending = new Set();
    this.nextFrame = 0;
    this.writer = null;
    this.writerError = null;
    this.writeChain = Promise.resolve();
    this.tableDirty = false;
    /** Called with a frame number when its cached image is removed or replaced. */
    this.onEvict = null;
    this.ready = this.load();
  }

  async load() {
    if (!this.movie) await fs.rm(this.movieFile, { force: true }).catch(() => {});
    const movieExists = await exists(this.movieFile);
    try {
      const doc = JSON.parse(await fs.readFile(this.tableFile, 'utf8'));
      if (doc && Array.isArray(doc.frames)) for (const n of doc.frames) if (Number.isSafeInteger(n) && n >= 0) this.frames.add(n);
    } catch {}
    // MOV frames live in their own directory. The old `frames/` directory is
    // an HTML/track raster cache and must never be mistaken for full-scene
    // media frames.
    try {
      for (const name of await fs.readdir(this.frameDir)) {
        const m = /^(\d{6})\.png$/.exec(name);
        if (m) this.frames.add(Number(m[1]));
      }
    } catch {}
    while (this.frames.has(this.nextFrame)) this.nextFrame++;
    // If the PNG side predates the MOV side (or MOV was interrupted), replay
    // the contiguous PNG prefix into the new stream once a writer is started.
    if (!movieExists) {
      this.nextFrame = 0;
      for (const frame of this.frames) this.pending.add(frame);
    }
    return this;
  }

  has(frame) { return this.frames.has(Number(frame)); }

  /** Rendered, produced as expected, and not an unconfirmed empty image. */
  valid(frame, signature) {
    frame = Number(frame);
    if (!this.frames.has(frame)) return false;
    const record = this.records.get(frame);
    if (signature && !(record && signatureMatches(record.signature, signature))) return false;
    return !(record?.clear && record.renders < CLEAR_CONFIRMATIONS);
  }

  /** An empty image that still needs a confirming render. */
  unconfirmedClear(frame) {
    const record = this.records.get(Number(frame));
    return !!(record?.clear && record.renders < CLEAR_CONFIRMATIONS && this.frames.has(Number(frame)));
  }

  /** Cache what a PNG's embedded render record says, or that it has none. */
  noteRecord(frame, found) {
    if (found) {
      this.records.set(frame, { signature: found.signature ?? null, clear: !!found.clear, renders: Number(found.renders) || 1 });
      this.unrecorded.delete(frame);
    } else {
      this.records.delete(frame);
      this.unrecorded.add(frame);
    }
  }

  /** Read the render record from the start of a frame's PNG, which another
   * process may have written or replaced. Returns false when the frame has no
   * PNG; a PNG that is gone is forgotten. */
  async hydrateNow(frame) {
    let handle;
    try { handle = await fs.open(path.join(this.frameDir, `${pad(frame)}.png`), 'r'); }
    catch (error) {
      if (error?.code === 'ENOENT') {
        if (this.frames.delete(frame)) this.tableDirty = true;
        this.records.delete(frame); this.unrecorded.delete(frame); this.pending.delete(frame);
      }
      return false;
    }
    try {
      const head = Buffer.alloc(4096);
      const { bytesRead } = await handle.read(head, 0, head.length, 0);
      if (!this.frames.has(frame)) { this.frames.add(frame); if (frame >= this.nextFrame) this.pending.add(frame); this.tableDirty = true; }
      this.noteRecord(frame, readRenderRecord(head.subarray(0, bytesRead)));
      return true;
    } catch { return false; }
    finally { await handle.close().catch(() => {}); }
  }

  /** Make valid()/unconfirmedClear() see records of frames on disk. */
  async hydrate(frames) {
    await this.ready;
    for (const value of frames) {
      const frame = Number(value);
      if (!this.records.has(frame) && !this.unrecorded.has(frame)) await this.hydrateNow(frame);
    }
  }

  async get(frame) {
    await this.ready;
    frame = Number(frame);
    // The background service may have populated the shared cache since load.
    try {
      const buf = await fs.readFile(path.join(this.frameDir, `${pad(frame)}.png`));
      if (!this.frames.has(frame)) { this.frames.add(frame); if (frame >= this.nextFrame) this.pending.add(frame); this.tableDirty = true; }
      return buf;
    }
    catch { this.frames.delete(frame); this.records.delete(frame); this.unrecorded.delete(frame); this.tableDirty = true; return undefined; }
  }

  /** Cache lookup with verification. A frame produced by something other than
   * `signature` is evicted. An unconfirmed empty frame, or a frame without any
   * record (written by an older version or not yet persisted by another
   * process), is reported missing so it is rendered again; the new render
   * replaces it, so no file is deleted merely for lacking a record. */
  async lookup(frame, signature) {
    await this.ready;
    frame = Number(frame);
    const buf = await this.get(frame);
    if (!buf) return undefined;
    // Judge the bytes about to be served by the record inside them: another
    // process sharing the cache may have replaced the file since this store
    // last looked, so a record remembered in memory can be stale.
    this.noteRecord(frame, readRenderRecord(buf));
    const record = this.records.get(frame);
    if (signature && record && !signatureMatches(record.signature, signature)) {
      await this.evict(frame);
      return undefined;
    }
    if (signature && !record) return undefined;
    if (record?.clear && record.renders < CLEAR_CONFIRMATIONS) return undefined;
    return buf;
  }

  async persist() {
    if (!this.tableDirty) return;
    // An index only; render records live in the PNGs.
    await atomic(this.tableFile, JSON.stringify({ version: 2, fps: this.fps, frames: [...this.frames].sort((a, b) => a - b),
      movie: this.movie ? path.basename(this.movieFile) : null }));
    this.tableDirty = false;
  }

  /** Remove one frame: table entry, PNG, any movie built from it, and let the
   * owner reset derived samples (the playback movie) to transparent. */
  async evict(frame) {
    frame = Number(frame);
    const work = this.writeChain.then(async () => {
      await fs.rm(path.join(this.frameDir, `${pad(frame)}.png`), { force: true });
      this.frames.delete(frame); this.records.delete(frame); this.unrecorded.delete(frame); this.pending.delete(frame);
      this.tableDirty = true;
      await this.resetMovie();
      await this.onEvict?.(frame);
      await this.persist();
    });
    this.writeChain = work.catch(() => {});
    return work;
  }

  /** Must run inside writeChain. A published or streaming movie no longer
   * matches the PNG table after a frame changed; rebuild it from the PNGs. */
  async resetMovie() {
    this.streamEpoch = (this.streamEpoch || 0) + 1;
    const writer = this.writer; this.writer = null;
    await writer?.abort().catch(() => {});
    await fs.rm(this.tempMovie, { force: true }).catch(() => {});
    await fs.rm(this.movieFile, { force: true }).catch(() => {});
    this.writerError = null;
    this.nextFrame = 0; this.pending = new Set(this.frames);
  }

  /**
   * `renders`(X7,缺省 1):这一帧已经被同一个产出方渲过几遍。只有从别的节点**原样取回**的帧会传它
   * (`artifact-transfer.mjs` 的 PNG 落地):对方已经二次确认过的全透明帧,落到本机不该又算「待确认」。
   */
  async put(frame, buffer, signature = null, { renders = 1 } = {}) {
    const first = Number.isSafeInteger(renders) && renders >= 1 ? renders : 1;
    await this.ready;
    frame = Number(frame);
    if (!Number.isSafeInteger(frame) || frame < 0) throw new Error('Invalid MOV frame');
    const work = this.writeChain.then(async () => {
      const clear = isFullyTransparentPng(buffer);
      const file = path.join(this.frameDir, `${pad(frame)}.png`);
      // Another process sharing this cache may have written or replaced the
      // frame since this store last looked: decide from what is on disk now.
      await this.hydrateNow(frame);
      const record = this.records.get(frame);
      const stamped = next => (signature ? withRenderRecord(buffer, next) : buffer);
      let replaced = false, wrote = false;
      if (!this.frames.has(frame)) {
        const next = { signature, clear, renders: first };
        await atomic(file, stamped(next));
        wrote = true;
        this.frames.add(frame);
        this.pending.add(frame);
        this.records.set(frame, next);
        this.unrecorded.delete(frame);
        this.tableDirty = true;
      } else if (record ? !signatureMatches(record.signature, signature) || (record.clear && !clear) : !!signature) {
        // Produced by something else, an unconfirmed empty image now painted,
        // or an unverifiable legacy image: the fresh render wins.
        const next = { signature, clear, renders: first };
        await atomic(file, stamped(next));
        this.records.set(frame, next);
        this.unrecorded.delete(frame);
        this.tableDirty = true;
        replaced = true;
      } else if (record?.clear && clear) {
        // The same producer rendered an empty image again: it really is empty.
        record.renders++;
        if (signature) await atomic(file, withRenderRecord(await fs.readFile(file), record));
        this.tableDirty = true;
      }
      if (replaced) {
        await this.resetMovie();
        await this.onEvict?.(frame);
      } else if (wrote && this.writer && frame === this.nextFrame && this.pending.has(frame)) {
        // The common forward case goes directly from the in-memory screenshot
        // buffer into ffmpeg. The PNG remains the durable random-access copy.
        // When the PNG on disk was kept instead, flush() streams that PNG.
        try {
          await this.writer.write(buffer);
          this.pending.delete(frame);
          this.nextFrame++;
        } catch (error) {
          this.writerError = error;
          await this.writer.abort().catch(() => {});
          this.writer = null;
        }
      }
      await this.flush();
      // Persist in small batches. A process crash can lose only the latest
      // batch; the PNGs are adopted automatically on the next load.
      if (this.tableDirty && (this.frames.size % 16 === 0 || !this.writer || replaced)) await this.persist();
    });
    // One failed write (e.g. a locked table file) must not reject every later put.
    this.writeChain = work.catch(() => {});
    return work;
  }

  async start(ffmpeg, streamFactory) {
    if (this.starting) return this.starting;
    this.starting = this.startNow(ffmpeg, streamFactory).finally(() => { this.starting = null; });
    return this.starting;
  }
  async startNow(ffmpeg, streamFactory) {
    const epoch = this.streamEpoch;
    await this.ready;
    if (!this.movie) return;
    if (this.writer || this.writerError || await exists(this.movieFile)) return;
    try {
      const create = streamFactory || (await import('./bakery/index.mjs')).streamPngVideo;
      if (epoch !== this.streamEpoch) return;
      this.writer = create(ffmpeg, this.tempMovie, this.fps);
      await this.flush();
    } catch (error) {
      // MOV is an optimization. Random PNG access remains valid when ffmpeg
      // is unavailable, so do not make see_frames fail for the stream alone.
      // A stream already replaced by resetMovie is not this stream's failure.
      if (epoch === this.streamEpoch) {
        this.writerError = error;
        this.writer = null;
      }
    }
  }

  async flush() {
    const writer = this.writer, epoch = this.streamEpoch;
    if (!writer) return;
    // startNow runs this outside writeChain, so a replaced or evicted frame can
    // reset the movie meanwhile. Stop once the stream this loop began with is gone.
    const current = () => this.writer === writer && this.streamEpoch === epoch;
    while (current() && this.pending.has(this.nextFrame)) {
      const frame = this.nextFrame;
      let buffer;
      try { buffer = await fs.readFile(path.join(this.frameDir, `${pad(frame)}.png`)); }
      catch { return; }
      if (!current()) return;
      try { await writer.write(buffer); }
      catch (error) {
        if (current()) { this.writerError = error; this.writer = null; }
        await writer.abort().catch(() => {});
        return;
      }
      if (!current()) return;
      this.pending.delete(frame);
      this.nextFrame++;
    }
  }

  async finish() {
    await this.starting;
    await this.writeChain;
    await this.flush();
    if (this.writer) {
      try {
        if (this.pending.size) {
          // A sparse see_frames request may have no frame 0 yet. Never publish
          // a truncated movie; keep the PNG table and let a later request
          // start the stream once the gap is filled.
          await this.writer.abort();
          await fs.rm(this.tempMovie, { force: true });
          this.writer = null;
          await this.persist();
          return;
        }
        await this.writer.finish();
        await fs.rename(this.tempMovie, this.movieFile);
      } catch (error) {
        this.writerError = error;
        await fs.rm(this.tempMovie, { force: true }).catch(() => {});
      }
      this.writer = null;
    }
    await this.persist();
  }

  async close() { await this.finish(); }

  async suspend() {
    this.streamEpoch = (this.streamEpoch || 0) + 1;
    const writer = this.writer; this.writer = null;
    await writer?.abort().catch(() => {});
    await this.starting;
    await this.writeChain.catch(() => {});
    // 中止的流不会再接着写(下一次 start 从第 0 帧重来),写了一半的临时 MOV 就地删掉
    await fs.rm(this.tempMovie, { force: true }).catch(() => {});
    this.nextFrame = 0; this.pending = new Set(this.frames);
    await this.persist();
  }
}

/**
 * 本进程还开着的播放 MOV。进程正常退出时同步删掉;强杀来不及,靠下次启动时
 * `storage-leftovers.mjs` 按文件名里的 pid 清。
 */
const livePlaybackFiles = new Set();
let exitHookInstalled = false;
function trackPlaybackFile(file) {
  livePlaybackFiles.add(file);
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.once('exit', () => { for (const f of livePlaybackFiles) { try { unlinkSync(f); } catch {} } });
}

const u32 = (...values) => { const b = Buffer.alloc(values.length * 4); values.forEach((v, i) => b.writeUInt32BE(v >>> 0, i * 4)); return b; };
const atom = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(body.length + 8), Buffer.from(type), body]); };
const matrix = () => u32(65536, 0, 0, 0, 65536, 0, 0, 0, 0x40000000);

/** A complete, sparse PNG MOV. Every unfilled sample references ONE transparent
 * PNG. Screenshots append to mdat, then their sample-table entries are patched.
 * No encoder, frame-sized holes, or second Chrome/render path is involved.
 * The live reader uses published immutable byte ranges, never a half-patched
 * table. Ordinary MOV readers can open the file at any completed write. */
export class PlaybackMovStore {
  constructor({ dir, width, height, fps = 30, count }) {
    this.fps = fps; this.count = count;
    this.width = width; this.height = height;
    // 名字带 pid:属主进程被强杀时,下次启动据此认出它是遗留(storage-leftovers.mjs)
    this.name = `playback-${process.pid}-${randomUUID()}.mov`;
    this.movieFile = path.join(dir, 'mov', this.name);
    this.samples = new Map();
    this.writeChain = Promise.resolve();
    this.ready = this.initialize();
  }
  async initialize() {
    const { width, height, count, fps } = this;
    if (![width, height, count].every(n => Number.isSafeInteger(n) && n > 0) || width > 65535 || height > 65535 || count > 10000000 || !Number.isFinite(fps) || fps <= 0) throw new Error('Invalid playback movie dimensions');
    const transparent = PNG.sync.write(new PNG({ width, height }));
    const timescale = Math.round(fps * 1000), duration = count * 1000;
    if (duration > 0xffffffff || timescale > 0xffffffff) throw new Error('Playback movie duration is too large');
    const mvhd = atom('mvhd', u32(0, 0, 0, timescale, duration, 65536, 0x01000000), Buffer.alloc(8), matrix(), Buffer.alloc(24), u32(2));
    const tkhd = atom('tkhd', u32(7, 0, 0, 1, 0, duration), Buffer.alloc(16), matrix(), u32(width * 65536, height * 65536));
    const mdhd = atom('mdhd', u32(0, 0, 0, timescale, duration, 0));
    const hdlr = atom('hdlr', u32(0, 0), Buffer.from('vide'), Buffer.alloc(12), Buffer.from('PromptCut playback\0'));
    const sample = Buffer.alloc(78);
    sample.writeUInt16BE(1, 6); sample.writeUInt16BE(width, 24); sample.writeUInt16BE(height, 26);
    sample.writeUInt32BE(72 * 65536, 28); sample.writeUInt32BE(72 * 65536, 32);
    sample.writeUInt16BE(1, 40); sample.writeUInt16BE(32, 74); sample.writeInt16BE(-1, 76);
    const stsz = atom('stsz', u32(0, 0, count), Buffer.alloc(count * 4));
    const co64 = atom('co64', u32(0, count), Buffer.alloc(count * 8));
    const stbl = atom('stbl', atom('stsd', u32(0, 1), atom('png ', sample)), atom('stts', u32(0, 1, count, 1000)),
      atom('stsc', u32(0, 1, 1, 1, 1)), stsz, co64);
    const minf = atom('minf', atom('vmhd', u32(1, 0, 0)), atom('dinf', atom('dref', u32(0, 1), atom('url ', u32(1)))), stbl);
    const moov = atom('moov', mvhd, atom('trak', tkhd, atom('mdia', mdhd, hdlr, minf)));
    const header = Buffer.concat([atom('ftyp', Buffer.from('qt  '), u32(0), Buffer.from('qt  ')), moov, u32(0), Buffer.from('mdat')]);
    // The uniquely constructed table atoms are located before any PNG bytes.
    this.sizeTable = header.indexOf(Buffer.from('stsz')) + 16;
    this.offsetTable = header.indexOf(Buffer.from('co64')) + 12;
    this.placeholder = { offset: header.length, size: transparent.length };
    for (let n = 0; n < count; n++) {
      header.writeUInt32BE(transparent.length, this.sizeTable + n * 4);
      header.writeBigUInt64BE(BigInt(header.length), this.offsetTable + n * 8);
    }
    await fs.mkdir(path.dirname(this.movieFile), { recursive: true });
    this.file = await fs.open(this.movieFile, 'wx+');
    trackPlaybackFile(this.movieFile);
    await this.writeAt(header, 0); await this.writeAt(transparent, header.length);
    this.end = header.length + transparent.length;
  }
  async writeAt(buffer, position) {
    let written = 0;
    while (written < buffer.length) {
      const { bytesWritten } = await this.file.write(buffer, written, buffer.length - written, position + written);
      if (!bytesWritten) throw new Error('Playback MOV write made no progress');
      written += bytesWritten;
    }
  }
  has(frame) { return this.samples.has(frame); }
  async patch(frame, offset, size) {
    const encodedOffset = Buffer.alloc(8); encodedOffset.writeBigUInt64BE(BigInt(offset));
    await this.writeAt(u32(size), this.sizeTable + frame * 4);
    await this.writeAt(encodedOffset, this.offsetTable + frame * 8);
  }
  /** `replace`: overwrite a published sample (its source frame was re-rendered). */
  async put(frame, buffer, { replace = false } = {}) {
    await this.ready;
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= this.count) throw new Error('Invalid playback frame');
    const work = this.writeChain.then(async () => {
      if ((this.samples.has(frame) && !replace) || this.closed) return;
      const offset = this.end;
      await this.writeAt(buffer, offset);
      this.end += buffer.length;
      await this.patch(frame, offset, buffer.length);
      this.samples.set(frame, { offset, size: buffer.length });
    });
    this.writeChain = work.catch(() => {});
    return work;
  }
  /** Point a sample back at the transparent placeholder and unpublish it. */
  async evict(frame) {
    await this.ready;
    if (!Number.isSafeInteger(frame) || frame < 0 || frame >= this.count) return;
    const work = this.writeChain.then(async () => {
      if (!this.samples.has(frame) || this.closed) return;
      await this.patch(frame, this.placeholder.offset, this.placeholder.size);
      this.samples.delete(frame);
    });
    this.writeChain = work.catch(() => {});
    return work;
  }
  index(start, end) {
    const frames = [];
    for (let frame = Math.max(0, start); frame <= Math.min(this.count - 1, end); frame++) {
      const sample = this.samples.get(frame);
      if (sample) frames.push({ frame, ...sample });
    }
    return { fps: this.fps, count: this.count, width: this.width, height: this.height, placeholder: this.placeholder, frames };
  }
  async close() { await this.ready; await this.writeChain; this.closed = true; await this.file?.close(); }
  /** 播放会话用完:关掉并删掉文件。它只是播放时的中转,不是缓存(帧在 MovFrameStore 的 PNG 里)。 */
  async dispose() {
    this.closed = true;
    await this.ready.catch(() => {});
    await this.writeChain.catch(() => {});
    await this.file?.close().catch(() => {});
    this.file = null;
    livePlaybackFiles.delete(this.movieFile);
    await fs.rm(this.movieFile, { force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {});
  }
}
