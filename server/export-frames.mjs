/**
 * Export-dedicated frame-by-frame bitmaps (visual source for cards not executed on this page
 * during "Full export" and "Quick export" in the online browser; semantics in
 * `docs/semantics/product/platforms.md` "Online browser" > "Export", user decision, 2026-10-13):
 * render node side.
 *
 * The export page of the online page does not execute synced user cards and media effect cards.
 * When export begins, the page sends an **export-only** manifest plan (`input.exportOnly: true`),
 * and the node that claims it calculates a plan for each clip in the manifest as a stream (using
 * the same algorithm, same isolated project, and same frame retrieval method as track streams),
 * but **without compressing into video**:
 * Each frame is saved as a transparent PNG (original size, lossless) and pushed to the asset service's
 * pixel category (`px/<hash>`), with the manifest written into the content store. The page fetches
 * frames according to the manifest.
 *
 * Differences from track streams:
 *   - Used only for this export, not entered into the layer table, not read by preview; not kept
 *     on the node locally (deleted once pushed);
 *   - No sparse version, no tight rectangle: each frame is retrieved using this stream's upper bounding rect;
 *   - Keys computed separately: `exportKey = sha256("export-frames:<version>\n<stream content key>")`,
 *     result key = `exportKey × environment fingerprint`. Different key from this card's track stream,
 *     not occupying the track stream's per-card fingerprint lock (task `input` lacks `contentKey`,
 *     so the queue creates no lock for it).
 *
 * Tasks reuse the queue's stream tasks (`kind: 'stream'`, range unit is segment number), identified
 * by `input.exportFrames: true`; queue and document service require no changes.
 *
 * # Manifest (content store `render-manifest`, key `<result key>:<start>-<end>`)
 *
 *   { v: 1, kind: 'export-frames', resultKey, range: { from, to },          // range is segment number (this stream's own, 15 frames per segment from its first frame)
 *     header: { kind: 'card' | 'below', plane: 'local' | 'stage', clipIds, fps, originFrame, lastFrame, rect, offset },
 *     frames: [[project frame number, PNG sha256, byte count], ...] }       // ascending frame numbers; `rect` is the rectangle covered by each image (plane coordinates)
 *
 * Local disk: `<store root>/export-frames/<result key>/<project frame number>.png`, deleted as a whole segment after successful push.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { isStreamOrigin, streamSegmentFirstFrame, streamSegmentLastFrame } from '../src/render/streamSegments.mjs';

export { EXPORT_FRAMES_PRIORITY, isExportFramesTask, isExportOnlyPlan, exportIndexOf } from './render-node/export-plan.mjs';

/** Version of this artifact: incremented when frame retrieval method or manifest shape changes; all old result keys are invalidated */
export const EXPORT_FRAMES_VERSION = 1;
/** Manifest `kind` */
export const EXPORT_FRAMES_KIND = 'export-frames';
/** Manifest version (same as `RESULT_VERSION` in `artifact-transfer.mjs`) */
export const EXPORT_RESULT_VERSION = 1;
/** Default retention period for export-dedicated bitmaps and manifests: 24 hours */
export const EXPORT_FRAMES_TTL_MS = 24 * 60 * 60 * 1000;
/** Concurrency for pushing chunks */
const PUSH_CONCURRENCY = 4;
const KEY_RE = /^[a-f0-9]{64}$/;
const sha256 = data => createHash('sha256').update(data).digest('hex');
const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

/**
 * Rerun identifier (`salt`): when the page clicks export again after a previous export failure,
 * the plan carries a new identifier (`input.exportSalt`), changing the export key accordingly,
 * so this task is treated as a new task: failed tasks in the queue are not reopened during the
 * retention period, and without changing the key, re-exporting would only retrieve the previous failure.
 * Only lowercase letters and numbers are recognized, up to 32 characters; others are treated as absent.
 * Normally omitted (when there are no failures), keeping the result key unchanged for the same content
 * so it can be reused directly upon re-export.
 */
export const exportSaltOf = value => (typeof value === 'string' && /^[0-9a-z]{1,32}$/.test(value) ? value : '');

/** Stream content key → export bitmap content key */
export function exportFramesKey(streamContentKey, salt = '') {
  const tail = exportSaltOf(salt);
  return sha256(`export-frames:${EXPORT_FRAMES_VERSION}\n${streamContentKey ?? ''}${tail ? `\n${tail}` : ''}`);
}

/* ------------------------------------------------------------------ PNG */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}
/** Straight RGBA raw pixels → PNG (8-bit RGBA, filter 0 per row). Direct canvas extraction and differential layer extraction yield raw pixels, not PNG */
export function rgbaToPng(rgba, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) throw new Error('rgbaToPng requires a positive integer width and height');
  if (!rgba || rgba.length !== width * height * 4) throw new Error(`rgbaToPng pixel length is wrong: ${rgba?.length} ≠ ${width}×${height}×4`);
  const src = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) src.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw, { level: 6 })), pngChunk('IEND', Buffer.alloc(0))]);
}
/** Frame handed over by the frame retrieval hook (PNG Buffer, or `{ rgba, width, height }`) → PNG bytes */
export function shotToPng(shot) {
  if (shot && typeof shot === 'object' && shot.rgba) return rgbaToPng(shot.rgba, shot.width, shot.height);
  if (Buffer.isBuffer(shot) || shot instanceof Uint8Array) return Buffer.isBuffer(shot) ? shot : Buffer.from(shot);
  throw new Error('The captured frame is neither PNG nor raw pixels');
}

/* ------------------------------------------------------------------ Plan */

/**
 * Plan for a stream (an item from `planStreams` in `frame-stream.mjs`) → plan for export bitmap.
 * Only recognizes single-card streams (plane standalone cards, source-dependent cards, cards with 3D bounding box)
 * and below-dependent streams; group streams are not recognized (export bitmaps are one per card,
 * caller does not merge them when calculating streams). Returning null = this stream cannot produce an export bitmap.
 */
export function exportSpecOf(spec, envFingerprint, salt = '') {
  if (!spec || typeof spec !== 'object') return null;
  if (!(spec.kind === 'card' || spec.kind === 'below') || !Array.isArray(spec.clipIds) || spec.clipIds.length !== 1) return null;
  if (typeof spec.contentKey !== 'string' || !spec.contentKey || typeof envFingerprint !== 'string' || !envFingerprint) return null;
  if (!isStreamOrigin(spec.originFrame) || !Number.isInteger(spec.lastFrame) || !Number.isInteger(spec.lastSegment) || spec.lastSegment < 0) return null;
  const tail = exportSaltOf(salt);
  const exportKey = exportFramesKey(spec.contentKey, tail);
  return { ...spec, exportKey, exportResultKey: sha256(`${exportKey}\n${envFingerprint}`), ...(tail ? { exportSalt: tail } : {}) };
}

/** The portion handed to the splitter and returned to the page (without large objects like member card controls) */
export function exportStreamOf(spec) {
  return {
    clipId: spec.clipIds[0], kind: spec.kind, plane: spec.plane, ...(spec.solo ? { solo: spec.solo } : {}),
    exportKey: spec.exportKey, originFrame: spec.originFrame, lastFrame: spec.lastFrame, firstSegment: 0, lastSegment: spec.lastSegment,
    fps: spec.fps, rect: spec.bound ? { ...spec.bound } : null, offset: spec.offset ? { ...spec.offset } : null,
    ...(spec.kind === 'below' ? { belowClipIds: [...(spec.belowClipIds ?? [])] } : {}),
    ...(spec.inputSig ? { inputSig: spec.inputSig } : {}),
    ...(spec.exportSalt ? { salt: spec.exportSalt } : {}),
  };
}

/* ------------------------------------------------------------------ Local disk persistence */

export const exportFramesDir = (root, resultKey) => path.join(root, 'export-frames', resultKey);
const frameFile = (dir, frame) => path.join(dir, `${frame}.png`);

/** Save one frame (write to a temporary name first then rename, so the reading side never reads a partial frame) */
export async function storeExportFrame(root, resultKey, frame, png) {
  if (!KEY_RE.test(String(resultKey))) throw fail(`Wrong result key for bitmap export: ${resultKey}`, { retryable: false });
  const dir = exportFramesDir(root, resultKey);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${frame}.${process.pid}.tmp`);
  await fs.writeFile(tmp, png);
  await fs.rename(tmp, frameFile(dir, frame));
}

/** Task range (segment number) → project frames it covers `[from, to]`; `header` includes the fields from task `input.stream` */
export function exportTaskFrames(task) {
  const s = task?.input?.stream;
  const from = task?.range?.from, to = task?.range?.to;
  if (!s || !isStreamOrigin(s.originFrame) || !Number.isInteger(s.lastFrame) || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from) return null;
  const first = streamSegmentFirstFrame(from, s.originFrame);
  const last = streamSegmentLastFrame(to, s.originFrame, s.lastFrame);
  return last >= first ? [first, last] : null;
}

const headerOf = task => {
  const s = task.input.stream;
  return { kind: s.kind, plane: s.plane, clipIds: [s.clipId], fps: s.fps, originFrame: s.originFrame, lastFrame: s.lastFrame, rect: s.rect, offset: s.offset ?? null };
};

/** Existing frames for this segment locally → manifest (missing frames omitted). Returns `{ result, readBlob }` */
export async function collectExportResult(root, task) {
  const key = task?.resultKey;
  if (!KEY_RE.test(String(key))) throw fail(`Wrong resultKey for bitmap export task: ${key}`, { retryable: false });
  const span = exportTaskFrames(task);
  if (!span) throw fail('Bitmap export task is missing the stream shape', { retryable: false });
  const dir = exportFramesDir(root, key);
  const files = new Map();
  const frames = [];
  for (let f = span[0]; f <= span[1]; f++) {
    let buf;
    try { buf = await fs.readFile(frameFile(dir, f)); } catch { continue; }
    const hash = sha256(buf);
    files.set(hash, frameFile(dir, f));
    frames.push([f, hash, buf.length]);
  }
  const result = {
    v: EXPORT_RESULT_VERSION, kind: EXPORT_FRAMES_KIND, resultKey: key, range: { from: task.range.from, to: task.range.to },
    header: headerOf(task), frames, createdAt: Date.now(), exportOnly: true, ttlSec: Math.floor(EXPORT_FRAMES_TTL_MS / 1000),
  };
  return { result, readBlob: async hash => (files.has(hash) ? fs.readFile(files.get(hash)) : null) };
}

/** Whether the manifest belongs to this segment and lists every frame */
export function exportResultComplete(body, task) {
  if (!body || typeof body !== 'object' || body.v !== EXPORT_RESULT_VERSION || body.kind !== EXPORT_FRAMES_KIND) return false;
  if (body.resultKey !== task?.resultKey || body.range?.from !== task?.range?.from || body.range?.to !== task?.range?.to) return false;
  const span = exportTaskFrames(task);
  if (!span || !Array.isArray(body.frames)) return false;
  const have = new Set();
  for (const item of body.frames) {
    if (!Array.isArray(item) || !Number.isInteger(item[0]) || !KEY_RE.test(String(item[1]))) return false;
    have.add(item[0]);
  }
  for (let f = span[0]; f <= span[1]; f++) if (!have.has(f)) return false;
  return true;
}

/** Delete frames for this segment locally after successful push (used only for this export, not kept); delete directory if empty */
export async function dropExportFrames(root, task) {
  const span = exportTaskFrames(task);
  if (!span || !KEY_RE.test(String(task?.resultKey))) return;
  const dir = exportFramesDir(root, task.resultKey);
  for (let f = span[0]; f <= span[1]; f++) { try { await fs.rm(frameFile(dir, f), { force: true }); } catch { /* Already gone */ } }
  try { await fs.rmdir(dir); } catch { /* There are frames from other segments */ }
}

/**
 * Clean up expired export bitmaps (clean on-disk frame directories and content store manifests
 * based on retention period TTL 24 hours; chunks on asset service are also released if supported).
 * Triggered incidentally when writing new export bitmaps, or called in scheduled tasks or maintenance.
 */
export async function sweepExpiredExportFrames(root, { maxAgeMs = EXPORT_FRAMES_TTL_MS, now = Date.now(), content = null, client = null, log = () => {} } = {}) {
  let cleanedDirs = 0, cleanedFrames = 0, cleanedManifests = 0;
  const baseDir = path.join(root, 'export-frames');
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dirPath = path.join(baseDir, entry.name);
      try {
        const stat = await fs.stat(dirPath);
        if (now - stat.mtimeMs > maxAgeMs) {
          const files = await fs.readdir(dirPath).catch(() => []);
          cleanedFrames += files.length;
          await fs.rm(dirPath, { recursive: true, force: true });
          cleanedDirs++;
        }
      } catch { /* Ignore errors for individual directories */ }
    }
  } catch { /* Directory might not exist */ }

  if (content && typeof content.list === 'function' && typeof content.del === 'function') {
    try {
      const listing = await content.list('render-manifest', '');
      for (const item of listing?.items ?? []) {
        if (!item?.key) continue;
        try {
          const manifest = await content.get('render-manifest', item.key);
          const body = manifest?.body;
          if (body && body.kind === EXPORT_FRAMES_KIND && body.createdAt && (now - body.createdAt > maxAgeMs)) {
            await content.del('render-manifest', item.key);
            cleanedManifests++;
            if (client && typeof client.drop === 'function' && Array.isArray(body.frames)) {
              for (const f of body.frames) {
                if (f && f[1]) await client.drop('px', f[1]).catch(() => {});
              }
            }
          }
        } catch { /* Single item failure does not interrupt */ }
      }
    } catch { /* Do not process when list is not supported */ }
  }

  log?.('export-frames.sweep', { cleanedDirs, cleanedFrames, cleanedManifests });
  return { cleanedDirs, cleanedFrames, cleanedManifests };
}

/** Explicitly release local temporary frames and manifests for a specific result key upon export completion or release */
export async function releaseExportFrames(root, resultKey, { content = null, client = null } = {}) {
  if (!KEY_RE.test(String(resultKey))) return;
  const dir = exportFramesDir(root, resultKey);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch { /* ignore */ }
  if (content && typeof content.list === 'function' && typeof content.del === 'function') {
    try {
      const listing = await content.list('render-manifest', `${resultKey}:`);
      for (const item of listing?.items ?? []) {
        if (item?.key) await content.del('render-manifest', item.key).catch(() => {});
      }
    } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ sink (push to asset service, write to content store) */

const manifestKey = task => `${task.resultKey}:${task.range.from}-${task.range.to}`;

async function settleLimited(items, limit, work) {
  let next = 0, failed = null;
  const lane = async () => {
    while (next < items.length && !failed) {
      const item = items[next++];
      try { await work(item); } catch (error) { failed ||= error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  if (failed) throw failed;
}

/**
 * Three things on the artifact store side for export bitmap tasks (same shape as `createAssetSink`
 * in `artifact-transfer.mjs`, adapted from it):
 *   - `has`: The content store has the manifest for this segment, every frame is listed, and all
 *     chunks are on the asset service → true (re-sent plans are not rerendered);
 *   - `put`: Builds a manifest from locally persisted frames, pushes `px` chunk by chunk, writes
 *     the manifest to the content store, and deletes local frames after pushing; returns
 *     `{ complete: false }` if frames are missing or push fails;
 *   - `resultFor`: The manifest accepted by `has`.
 */
export function createExportFramesSink({ root, client, content = null, log = () => {} }) {
  const remembered = new Map();
  const say = (event, fields) => { try { log?.(event, fields); } catch { /* Logging errors do not affect pushing */ } };
  let lastSweep = 0;
  const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
  return {
    async has(ref) {
      if (!content || typeof content.get !== 'function') return false;
      let item;
      try { item = await content.get('render-manifest', manifestKey(ref)); } catch { return false; }
      const body = item?.body;
      if (!exportResultComplete(body, ref)) return false;
      const hashes = [...new Set(body.frames.map(f => f[1]))];
      try {
        for (const hash of hashes) if (!(await client.has('px', hash))) return false;
      } catch { return false; }
      remembered.set(manifestKey(ref), body);
      return true;
    },
    async resultFor(ref) {
      return remembered.get(manifestKey(ref)) ?? null;
    },
    async put(ref, { report } = {}) {
      const started = Date.now();
      if (started - lastSweep > SWEEP_INTERVAL_MS) {
        lastSweep = started;
        sweepExpiredExportFrames(root, { maxAgeMs: EXPORT_FRAMES_TTL_MS, now: started, content, client, log }).catch(() => {});
      }
      const tell = fields => { try { report?.(fields); } catch { /* Errors in diagnostic callbacks do not affect push */ } };
      let pushed = 0, bytes = 0, blocks = null;
      const incomplete = (reason, extra = {}) => {
        const out = { complete: false, reason, stats: { blocks, pushed, bytes, ms: Date.now() - started } };
        say('sink.incomplete', { resultKey: String(ref?.resultKey ?? '').slice(0, 16), range: ref?.range ?? null, reason, exportFrames: true, ...out.stats, ...extra });
        return out;
      };
      let stage = 'collect';
      try {
        tell({ stage });
        const { result, readBlob } = await collectExportResult(root, ref);
        if (!exportResultComplete(result, ref)) return incomplete('range-missing', { listed: result.frames.length });
        const unique = [...new Map(result.frames.map(f => [f[1], f])).values()];
        blocks = unique.length;
        stage = 'push';
        tell({ stage, blocks, pushed, bytes });
        await settleLimited(unique, PUSH_CONCURRENCY, async ([, hash]) => {
          const buf = await readBlob(hash);
          if (!buf || sha256(buf) !== hash) throw fail(`Content of chunk ${hash} does not match the manifest`);
          const put = await client.put('px', buf, { ext: 'png' });
          if (put?.hash && put.hash !== hash) throw fail(`The hash ${put.hash} returned by the asset service differs from ${hash} in the manifest`);
          pushed++; bytes += buf.length;
          tell({ stage, blocks, pushed, bytes });
        });
        if (content && typeof content.put === 'function') {
          try { await content.put('render-manifest', manifestKey(ref), result); }
          catch (error) { return incomplete('manifest-put-failed', { message: String(error?.message ?? error).slice(0, 200) }); }
        }
        await dropExportFrames(root, ref);
        return { complete: true, result, stats: { blocks, pushed, bytes, ms: Date.now() - started } };
      } catch (error) {
        // The asset service reports that host render service artifacts hit the capacity limit:
        // retrying won't help (same as `createAssetSink`)
        if (error?.status === 507 && error?.body?.error === 'service-quota') throw Object.assign(new Error('service-quota'), { code: 'service-quota', status: 507, retryable: false });
        const code = error?.code ?? error?.status ?? null;
        return incomplete(`${stage}-failed${code !== null ? `:${String(code).slice(0, 40)}` : ''}`, { message: String(error?.message ?? error).slice(0, 200) });
      }
    },
  };
}
