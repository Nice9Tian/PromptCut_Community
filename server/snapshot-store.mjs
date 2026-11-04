import fs from 'node:fs/promises';
import path from 'node:path';
import { atomic } from './asset-store/atomic.mjs';
import { mergeRanges } from './asset-store/ranges.mjs';
export { mergeRanges } from './asset-store/ranges.mjs';

/**
 * HTML snapshot store for A3a. Two-tier archives; directory shape is the sole external contract:
 *
 *   Shared tier (cloud-eligible):    <root>/controls-html/<sharedKey>/<localFrame>.html
 *   Local-only tier (not for cloud): <root>/controls-local/<entry.key>/<sharedKey>/<localFrame>.html
 *
 * The local tier uses **two directory levels** instead of concatenating two keys into one name:
 * when switching projects (entry.key changes), the entire subtree can be discarded together, while
 * the shared key layer has the same name in both tiers, so promoting an entry from the local tier
 * to the shared tier in the future is just moving directories.
 *
 * File contents are **raw UTF-8 HTML**. The base64(deflate) from the legacy `html-manifest.json`
 * is not carried over: that encoding was designed to pack tens of thousands of frames into a single
 * JSON; here it is one file per frame, read from disk on demand, mmap-capable, and directly servable
 * via HTTP static hosting; wrapping it in another encoding layer would only add a decompression step
 * every time a snapshot is retrieved. The single-frame size limit is calculated based on A3c's 300 KB
 * (not enforced here, left to A3c).
 *
 * Each <sharedKey>/ directory has an index.json = { count, frames: [[from, to], …],
 * oversize?: [[from, to], …] }: `frames` are closed intervals of existing **and qualified** local
 * frames, merged and sorted; `oversize` are those frames classified as oversize by A3c and discarded
 * (R6-14: if not recorded, they always count as "missing", and every background prerender pass
 * would re-render the same batch of frames before discarding them). Why not rely on readdir: when a
 * key has thousands of frames, readdir + parse is much slower than reading a small JSON, and "which
 * frames already exist" is a question the playback scheduler asks every time. `fillCardControls`
 * updates once after writing each batch (not per frame), with a batch size of 4.
 */

export const SHARED_DIR = 'controls-html';
export const LOCAL_DIR = 'controls-local';

export const rangeCount = ranges => ranges.reduce((total, [from, to]) => total + (to - from + 1), 0);
export const rangeHas = (ranges, frame) => ranges.some(([from, to]) => frame >= from && frame <= to);

/**
 * Which tier each control takes (A3a). Implementation moved to `snapshot-tier.mjs` (imports no modules),
 * allowing `server/render-node/` to use it with only Node built-in modules; re-exported here so callers
 * need no changes.
 */
export { snapshotTier } from './snapshot-tier.mjs';

/**
 * Single-frame snapshot size limit for A3c. Frames exceeding it are **persisted to disk as usual**
 * (no need to re-render next time), but do not enter the ready index and are not delivered: that layer
 * is treated as missing data (pasting earlier qualified snapshots, or transparent if none exist),
 * and a diagnostic is recorded (card id, byte count).
 *
 * Two tiers: DOM card 300 KB; canvas card 1 MB: 84%-95% of its bytes are bitmaps from `toDataURL`
 * (`docs/archive/topics/snapshot-size-audit.md`), differential style inlining is ineffective for it,
 * so it is counted under the bitmap tier. The criterion is `canvasHeavy` in the review table
 * (`cardCapabilities` in `src/kernel/frameMode.mjs`).
 */
export const DOM_SNAPSHOT_LIMIT = 300 * 1024;
export const CANVAS_SNAPSHOT_LIMIT = 1024 * 1024;
export function snapshotLimit(capabilities) {
  return capabilities?.canvasHeavy === true ? CANVAS_SNAPSHOT_LIMIT : DOM_SNAPSHOT_LIMIT;
}
/** Byte count of this snapshot frame (UTF-8, exactly identical to what is written to disk). */
export const snapshotBytes = html => Buffer.byteLength(String(html ?? ''), 'utf8');
/** Returns `{ bytes, limit }` if oversize, or null if qualified. */
export function overSnapshotLimit(html, capabilities) {
  const bytes = snapshotBytes(html);
  const limit = snapshotLimit(capabilities);
  return bytes > limit ? { bytes, limit } : null;
}

/** The sole implementation of directory shape. `entryKey` is only required for the local tier. */
export function snapshotDir(root, { tier, entryKey, key }) {
  if (!key) throw new Error('Snapshot key is required');
  if (tier === 'shared') return path.join(root, SHARED_DIR, key);
  if (tier === 'local') {
    if (!entryKey) throw new Error('Local snapshots need an entry key');
    return path.join(root, LOCAL_DIR, entryKey, key);
  }
  throw new Error(`Unknown snapshot tier ${tier}`);
}

const frameFile = (dir, localFrame) => {
  if (!Number.isInteger(localFrame) || localFrame < 0) throw new Error(`Invalid local frame ${localFrame}`);
  return path.join(dir, `${localFrame}.html`);
};

const EMPTY = { count: 0, frames: [], oversize: [] };

/** Capacity of the diagnostic ring buffer: oversize frames are rare; keeping this many recent entries is enough to see which card it is */
const OVERSIZE_LOG = 64;

export class SnapshotStore {
  constructor(root) {
    this.root = root;
    // Serializes read-modify-write of index.json on the same key directory: multiple batches for a key
    // may persist to disk concurrently, and another batch interleaving between read-modify-write would
    // lose an interval.
    this.chains = new Map();
    /** Diagnostics for A3c oversize frames (recent OVERSIZE_LOG entries): { clipId, key, localFrame, bytes, limit } */
    this.oversize = [];
  }
  dir(target) { return snapshotDir(this.root, target); }

  /**
   * General fallback for A3c. Returns true = this frame passed and can enter the ready index;
   * false = oversized, written to disk but does not enter the index and is not delivered, and logs
   * a diagnostic.
   */
  noteSnapshotSize({ clipId, key, localFrame, html, capabilities }) {
    const over = overSnapshotLimit(html, capabilities);
    if (!over) return true;
    const record = { clipId: clipId ?? null, key: key ?? null, localFrame, ...over, at: Date.now() };
    this.oversize.push(record);
    while (this.oversize.length > OVERSIZE_LOG) this.oversize.shift();
    console.warn(`[snapshot] Snapshot over the limit, not added to the ready index: card ${record.clipId ?? key} local frame ${localFrame} ${record.bytes} bytes > ${record.limit}`);
    return false;
  }

  /**
   * **Sole entry point for writing snapshots** (T1a review #9): finishes a batch of frames in one
   * step: "write files → check size (A3c) → merge into index.json". Returns the merged index,
   * plus the valid `written` and oversized `oversized` in this batch.
   *
   * Why combine into one step: `writeSnapshot` only writes files, while `updateIndex` is a separate
   * step; if the caller misses the second step, frames exist on disk but not in the index: C3
   * considers them missing, and the ready index never dispatches this segment; writing to disk on
   * the download side in A3b is the same pitfall (cloud-task.md A3b "writing to disk uses the same
   * write function in snapshot-store.mjs"). Production code only calls here and `batch` below;
   * `writeSnapshot` / `updateIndex` are reserved for both of them and unit tests.
   *
   * `items`: `[{ localFrame, html }]`. An empty batch does not write to the index and returns
   * the current index directly.
   */
  async commitSnapshots({ tier, entryKey, key, clipId, capabilities, items }) {
    const target = { tier, entryKey, key };
    const written = [], oversized = [];
    for (const { localFrame, html } of items ?? []) {
      await this.writeSnapshot({ ...target, localFrame, html });
      // A3c: The oversized frame is written to disk as usual (no need to rerender next time), but does
      // not enter `frames` and is recorded in `oversize` (R6-14)
      if (this.noteSnapshotSize({ clipId, key, localFrame, html, capabilities })) written.push(localFrame);
      else oversized.push(localFrame);
    }
    const index = written.length || oversized.length
      ? await this.updateIndex({ ...target, frames: written, oversize: oversized })
      : await this.snapshotIndex(target);
    return { ...index, written, oversized };
  }

  /**
   * Batched writes: `add(localFrame, html)` buffers first, calling `commitSnapshots` once whenever
   * `size` frames are accumulated; `close()` commits the rest and returns the last index (null if
   * no frames were ever committed). Frames are either still in memory (not written to disk), or
   * already written to disk **and** entered into the index: there is no intermediate state of "exists
   * on disk, missing in index". Forgetting `close()` will only drop the last few frames that did not
   * fill a batch (the next prerender pass will make them up), and will not cause disk and index to
   * mismatch.
   *
   * Batching keeps the existing behavior of "writing index.json once per batch, not per frame"
   * (batch size 4, same as `fillCardControls`), while avoiding keeping HTML for an entire pass
   * in memory (a single frame can reach 300 KB).
   */
  batch({ tier, entryKey, key, clipId, capabilities }, { size = 4 } = {}) {
    const store = this;
    let pending = [];
    let last = null;
    let written = 0;
    let chain = Promise.resolve();
    const flush = () => {
      if (!pending.length) return chain;
      const items = pending; pending = [];
      // Failure of the previous commit does not affect this one (that batch's error was already
      // passed to the caller waiting for it)
      chain = chain.catch(() => {}).then(async () => {
        last = await store.commitSnapshots({ tier, entryKey, key, clipId, capabilities, items });
        written += last.written.length;
        return last;
      });
      return chain;
    };
    return {
      tier, entryKey, key, clipId,
      /** Number of frames not yet committed (for diagnostics) */
      get pending() { return pending.length; },
      /**
       * Number of valid frames already committed (excluding oversized frames); callers decide whether
       * to send C3's `layer` based on this.
       */
      get written() { return written; },
      add(localFrame, html) {
        pending.push({ localFrame, html });
        return pending.length >= size ? flush() : chain;
      },
      async close() { await flush(); await chain; return last; },
    };
  }

  /**
   * Low-level: only writes frame files without touching the index. Production code uses
   * `commitSnapshots` / `batch` and does not call it directly.
   */
  async writeSnapshot({ tier, entryKey, key, localFrame, html }) {
    const dir = this.dir({ tier, entryKey, key });
    const file = frameFile(dir, localFrame);
    await fs.mkdir(dir, { recursive: true });
    await atomic(file, Buffer.from(String(html ?? ''), 'utf8'));
    return file;
  }

  /**
   * Missing frame returns null (does not throw): the layer missing assets is transparent,
   * and the playhead does not stop (render 7).
   */
  async readSnapshot({ tier, entryKey, key, localFrame }) {
    const file = frameFile(this.dir({ tier, entryKey, key }), localFrame);
    try { return await fs.readFile(file, 'utf8'); } catch { return null; }
  }

  async snapshotIndex({ tier, entryKey, key }) {
    const file = path.join(this.dir({ tier, entryKey, key }), 'index.json');
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      const frames = mergeRanges(value?.frames ?? []);
      const oversize = mergeRanges(value?.oversize ?? []);
      return { count: rangeCount(frames), frames, oversize };
    } catch { return { count: 0, frames: [], oversize: [] }; }
  }

  /**
   * Merges this batch of new frames into index.json. Returns the merged index.
   *
   * `oversize` contains those local frames **dropped due to exceeding the limit** in A3c (R6-14).
   * They do not enter `frames` (not ready, not delivered), but are recorded here: missing frames
   * are calculated based on `frames`; if not recorded, they are permanently considered "missing",
   * and every background prerender pass will rerender the same batch of frames, classify them as
   * oversized again, and drop them again. Once recorded, the next pass skips them directly: two large
   * lottie cards do not need to rerender the entire segment every pass. Frame files remain on disk
   * as usual (`writeSnapshot` writes first, size check comes after), so this is merely "do not render
   * for nothing again".
   */
  async updateIndex({ tier, entryKey, key, frames, oversize }) {
    const dir = this.dir({ tier, entryKey, key });
    const chain = (this.chains.get(dir) || Promise.resolve()).catch(() => {}).then(async () => {
      const current = await this.snapshotIndex({ tier, entryKey, key });
      const merged = mergeRanges([...current.frames, ...(frames ?? [])]);
      const over = mergeRanges([...current.oversize, ...(oversize ?? [])]);
      const index = { count: rangeCount(merged), frames: merged, ...(over.length ? { oversize: over } : {}) };
      await fs.mkdir(dir, { recursive: true });
      await atomic(path.join(dir, 'index.json'), Buffer.from(JSON.stringify(index), 'utf8'));
      return { ...index, oversize: over };
    });
    this.chains.set(dir, chain);
    return chain;
  }

  /** Rebuilds index from actual <localFrame>.html on disk: for repair, not on the hot path. */
  async rebuildIndex({ tier, entryKey, key }) {
    const dir = this.dir({ tier, entryKey, key });
    let names = [];
    try { names = await fs.readdir(dir); } catch { return { ...EMPTY }; }
    const frames = names.map(name => /^(\d+)\.html$/.exec(name)).filter(Boolean).map(match => Number(match[1]));
    const merged = mergeRanges(frames);
    // The oversized list is retained from the old index: having frame files on disk does not mean
    // they passed (A3c writes files first before size checking); losing this list causes the next
    // pass to rerender those frames again, classify them as oversized again, and drop them again (R6-14).
    const { oversize } = await this.snapshotIndex({ tier, entryKey, key });
    const index = { count: rangeCount(merged), frames: merged, ...(oversize.length ? { oversize } : {}) };
    await atomic(path.join(dir, 'index.json'), Buffer.from(JSON.stringify(index), 'utf8'));
    return { ...index, oversize };
  }
}
