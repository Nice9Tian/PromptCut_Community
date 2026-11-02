/**
 * Generation of two asset tiers (C6.6, `docs/plan/c66-design.md` sections 2 and 8 research
 * conclusions; semantics `docs/semantics/product/asset-service.md` "two asset tiers").
 *
 * Done in the **importer's local editor process**, using `findFfmpeg`; the asset service never
 * transcodes. Only done for video; images and audio do not generate small-size assets.
 *
 * # Original-size asset: no transcoding, remux only when faststart is missing
 *
 * - Only checks regular MP4 / MOV (extensions `mp4` / `m4v` / `mov`): skip-reads top-level ISO BMFF
 *   boxes one by one (`scanTopLevelBoxes`), comparing the positions of the first `moov` and `mdat`;
 *   faststart is considered missing only when `mdat` comes first. Fragmented MP4s with `moof`,
 *   invalid box lengths, or missing `moov` / `mdat` are left untouched. MKV, WebM, and AVI have no
 *   `moov` and do not need this.
 * - Remux: `ffmpeg -i <source> -map 0 -c copy -movflags +faststart -f <mp4|mov> <temp-file>`, same
 *   container; after writing, verify first (box order is already faststart, stream types and codecs
 *   match one by one, duration difference does not exceed 0.05 s); only after passing, store into the
 *   library by the hash of the **output file**, treated as the new original-size asset; if any step
 *   fails, delete the temporary file, keep the source file as the original-size asset, and record the
 *   reason. No transcoding, no track deletion.
 * - If the file before remuxing was just written into the library during this import (not a
 *   deduplication hit), delete it from the library to avoid leaving an unreferenced copy; at the
 *   same time, record "source hash → remuxed hash" so importing the same file again directly
 *   reuses it without running ffmpeg again.
 *
 * # Small-size asset: local transcoding
 *
 * Following the command in section 8 (`smallVideoArgs`):
 *   - Retains VFR timestamps; `select` drops only frames with intervals less than 1/60 s (leaving a
 *     0.2 ms tolerance: converting timestamps to seconds has rounding, and an interval of exactly
 *     1/60 s would be mistakenly dropped under floating-point comparison: in testing, a 120 fps
 *     source without tolerance was reduced to only 44.7 fps);
 *   - `scale` does not upscale, preserves aspect ratio, limits to 800×600, even dimensions,
 *     `reset_sar=1`; `format=yuv420p`;
 *   - `-map 0:v:0 -map 0:a:0?`: tolerates missing audio track; `-autorotate` is ffmpeg's default,
 *     applying rotation into pixels;
 *   - H.264 `-preset veryfast -crf 26`, AAC 64k, `-movflags +faststart`;
 *   - HDR: runs the `zscale` + `tonemap` branch only for BT.2020 + PQ (`smpte2084`) sources with
 *     complete tags, outputting marked BT.709; the rest (including HLG and untagged) follow SDR
 *     [ruling]. When local ffmpeg lacks `zscale` / `tonemap`, PQ sources do not generate
 *     small-size assets (no standard 8-bit conversion pretending to be SDR small-size assets),
 *     leaving only the original-size asset tier.
 * - Transcoding runs in the background, one at a time, at below-normal process priority, blocking
 *   neither import responses nor editing.
 *
 * # Registration and upload
 *
 * - The mapping of "original-size asset → small-size asset" in the local content store is recorded
 *   in `<asset catalog>/tiers.json` (local cache, not saved into project); the record in the project
 *   `project.media[i].tiers = { small?, original }` is written by the page (the import response
 *   includes the original-size asset hash; once the small-size asset is ready, the page fetches
 *   the small-size asset hash via `GET /api/media/tiers` and writes it in). Sync status is not saved
 *   into the project.
 * - Once the small-size asset is ready (or confirmed to have no small-size asset), both tiers of this
 *   asset are handed to the upload queue (`upload-queue.mjs`): small first, then large.
 * - Process restart: entries still `pending` in `tiers.json` resume transcoding.
 */
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { publishProjectFile } from './asset-store/project-io.mjs';
const tierJobContext = new AsyncLocalStorage();

export const SMALL_MAX_WIDTH = 800;
export const SMALL_MAX_HEIGHT = 600;
export const SMALL_MAX_FPS = 60;
/** Tolerance for frame-drop criterion (seconds): see file header */
export const SMALL_FPS_EPSILON = 0.0002;
export const VIDEO_EXTS = Object.freeze(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'mpg', 'mpeg', 'ts', 'mts', 'm2ts', 'wmv', 'flv', '3gp']);
export const REMUX_EXTS = Object.freeze(['mp4', 'm4v', 'mov']);
export const TIERS_FILE = 'tiers.json';
const TIERS_VERSION = 1;
const HASH = /^[0-9a-f]{64}$/;

export const isVideoExt = (ext) => VIDEO_EXTS.includes(String(ext || '').toLowerCase());

/* ------------------------------------------------------------------ *
 * ISO BMFF top-level boxes
 * ------------------------------------------------------------------ */

/**
 * Skip-reads top-level box headers one by one (reads headers only, not `mdat` content). Handles 32-bit
 * length, 64-bit length with `size = 1`, and `size = 0` (extends to EOF, can only be the last box).
 * Stops if length is invalid, returning `ok: false`.
 * @param {string} file
 * @returns {Promise<{ ok: boolean, size: number, boxes: { type: string, offset: number, size: number }[] }>}
 */
export async function scanTopLevelBoxes(file, { maxBoxes = 100_000 } = {}) {
  const fh = await fs.open(file, 'r');
  try {
    const size = (await fh.stat()).size;
    const boxes = [];
    const head = Buffer.alloc(16);
    let offset = 0;
    while (offset < size && boxes.length < maxBoxes) {
      if (size - offset < 8) return { ok: false, size, boxes };
      const { bytesRead } = await fh.read(head, 0, 16, offset);
      if (bytesRead < 8) return { ok: false, size, boxes };
      let boxSize = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      let header = 8;
      if (boxSize === 1) {
        if (bytesRead < 16) return { ok: false, size, boxes };
        const big = head.readBigUInt64BE(8);
        if (big > BigInt(Number.MAX_SAFE_INTEGER)) return { ok: false, size, boxes };
        boxSize = Number(big);
        header = 16;
      } else if (boxSize === 0) {
        boxSize = size - offset;
      }
      if (boxSize < header || offset + boxSize > size) return { ok: false, size, boxes: [...boxes, { type, offset, size: boxSize }] };
      boxes.push({ type, offset, size: boxSize });
      offset += boxSize;
    }
    return { ok: offset === size, size, boxes };
  } finally {
    await fh.close();
  }
}

/**
 * Faststart determination: `'faststart'` (moov before mdat), `'needs'` (mdat before moov),
 * `'fragmented'` (has moof, left untouched), `'unknown'` (invalid box or missing moov / mdat, left untouched).
 */
export async function faststartState(file) {
  let scan;
  try { scan = await scanTopLevelBoxes(file); } catch { return 'unknown'; }
  const types = scan.boxes.map((b) => b.type);
  if (types.includes('moof')) return 'fragmented';
  const moov = types.indexOf('moov');
  const mdat = types.indexOf('mdat');
  if (moov < 0 || mdat < 0) return 'unknown';
  return moov < mdat ? 'faststart' : 'needs';
}

/* ------------------------------------------------------------------ *
 * ffmpeg / ffprobe
 * ------------------------------------------------------------------ */

export const ffprobeOf = (ffmpegCmd) => String(ffmpegCmd).replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase() === 'ffmpeg.exe' ? 'ffprobe.exe' : 'ffprobe'));

/** Runs a child process, collecting stdout / stderr; lowers it to below-normal priority when `low` */
function run(cmd, args, { low = false, max = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { return resolve({ code: -1, stdout: '', stderr: String(error?.message ?? error) }); }
    tierJobContext.getStore()?.trackProcess(child);
    if (low && child.pid) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* Ignore if adjustment fails */ }
    }
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { if (stdout.length < max) stdout += d; });
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-8000); });
    child.on('error', (error) => resolve({ code: -1, stdout, stderr: stderr + String(error?.message ?? error) }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** ffprobe a file: streams and format. Returns null if unreadable */
export async function probeMedia(ffprobe, file) {
  const r = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  if (r.code !== 0) return null;
  try {
    const data = JSON.parse(r.stdout);
    const streams = Array.isArray(data.streams) ? data.streams : [];
    // Cover art (attached_pic) does not count as a video stream
    const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition?.attached_pic)) ?? null;
    const audio = streams.find((s) => s.codec_type === 'audio') ?? null;
    const duration = Number(data.format?.duration);
    return { streams, format: data.format ?? {}, video, audio, duration: Number.isFinite(duration) ? duration : null };
  } catch { return null; }
}

/** Only sources with complete BT.2020 + PQ tags follow the HDR branch [ruling] */
export function isHdrPq(video) {
  return !!video && video.color_transfer === 'smpte2084' && video.color_primaries === 'bt2020';
}

/** Video filter string for small-size assets (passed as a single spawn argument, not through shell) */
export function smallVideoFilter({ hdr = false, video = null } = {}) {
  const select = `select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,1/${SMALL_MAX_FPS}-${SMALL_FPS_EPSILON})'`;
  const scale = `scale=w='min(iw\\,${SMALL_MAX_WIDTH})':h='min(ih\\,${SMALL_MAX_HEIGHT})':force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1`;
  if (!hdr) return `${select},${scale},format=yuv420p`;
  const matrix = video?.color_space === 'bt2020c' ? 'bt2020c' : 'bt2020nc';
  const range = video?.color_range === 'pc' ? 'full' : 'limited';
  return `${select},zscale=tin=smpte2084:pin=bt2020:min=${matrix}:rin=${range}:t=linear:npl=100,format=gbrpf32le,`
    + `tonemap=tonemap=hable:desat=0,zscale=p=bt709:t=bt709:m=bt709:r=tv,${scale},format=yuv420p`;
}

/** Full ffmpeg arguments for small-size assets */
export function smallVideoArgs(input, output, { hdr = false, video = null } = {}) {
  const args = ['-y', '-hide_banner', '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', smallVideoFilter({ hdr, video }), '-fps_mode:v', 'vfr',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p'];
  if (hdr) args.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
  args.push('-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', '-f', 'mp4', output);
  return args;
}

/** ffmpeg arguments for remuxing: same container, all streams, copy only */
export function remuxArgs(input, output, ext) {
  const format = String(ext).toLowerCase() === 'mov' ? 'mov' : 'mp4';
  return ['-y', '-hide_banner', '-v', 'error', '-i', input, '-map', '0', '-c', 'copy', '-movflags', '+faststart', '-f', format, output];
}

const streamSignature = (probe) => (probe?.streams ?? []).map((s) => `${s.codec_type}:${s.codec_name ?? '?'}`).join(',');

/** Whether local ffmpeg has these filters (HDR branch requires zscale and tonemap) */
const filterCache = new Map();
export async function hasFilters(ffmpeg, names) {
  let set = filterCache.get(ffmpeg);
  if (!set) {
    const r = await run(ffmpeg, ['-hide_banner', '-filters']);
    set = new Set();
    for (const line of String(r.stdout).split(/\r?\n/)) {
      const m = /^\s*[A-Z.|]{2,4}\s+(\S+)\s/.exec(line);
      if (m) set.add(m[1]);
    }
    filterCache.set(ffmpeg, set);
  }
  return names.every((n) => set.has(n));
}

/**
 * Remuxes regular MP4 / MOV lacking faststart within the same container, writing to `output`
 * (temporary path provided by caller). Returns `{ state: 'faststart' | 'skipped' | 'remuxed' | 'failed', reason? }`;
 * on `remuxed`, `output` is written and verified, in all other cases `output` does not exist.
 */
export async function remuxIfNeeded({ ffmpeg, ffprobe = ffprobeOf(ffmpeg), input, ext, output }) {
  const e = String(ext || '').toLowerCase();
  if (!REMUX_EXTS.includes(e)) return { state: 'skipped', reason: 'container' };
  const before = await faststartState(input);
  if (before === 'faststart') return { state: 'faststart' };
  if (before !== 'needs') return { state: 'skipped', reason: before };
  const fail = async (reason) => { await fs.rm(output, { force: true }); return { state: 'failed', reason }; };
  const r = await run(ffmpeg, remuxArgs(input, output, e), { low: true });
  if (r.code !== 0) return fail(`ffmpeg ${r.code}: ${r.stderr.trim().slice(-400)}`);
  if (await faststartState(output) !== 'faststart') return fail('output-not-faststart');
  const [a, b] = await Promise.all([probeMedia(ffprobe, input), probeMedia(ffprobe, output)]);
  if (!a || !b) return fail('probe-failed');
  if (streamSignature(a) !== streamSignature(b)) return fail(`streams-differ: ${streamSignature(a)} vs ${streamSignature(b)}`);
  if (a.duration !== null && b.duration !== null && Math.abs(a.duration - b.duration) > 0.05) return fail(`duration-differ: ${a.duration} vs ${b.duration}`);
  return { state: 'remuxed' };
}

/**
 * Generates small-size asset to `output`. Returns `{ ok: true, hdr, width, height }` or `{ ok: false, reason }`
 * (`reason: 'no-video'` indicates no video stream).
 */
export async function makeSmallVersion({ ffmpeg, ffprobe = ffprobeOf(ffmpeg), input, output, probe = null }) {
  const info = probe ?? await probeMedia(ffprobe, input);
  if (!info) return { ok: false, reason: 'probe-failed' };
  if (!info.video) return { ok: false, reason: 'no-video' };
  const hdr = isHdrPq(info.video);
  if (hdr && !(await hasFilters(ffmpeg, ['zscale', 'tonemap']))) return { ok: false, reason: 'no-zscale' };
  const r = await run(ffmpeg, smallVideoArgs(input, output, { hdr, video: info.video }), { low: true });
  if (r.code !== 0) { await fs.rm(output, { force: true }); return { ok: false, reason: `ffmpeg ${r.code}: ${r.stderr.trim().slice(-400)}` }; }
  const out = await probeMedia(ffprobe, output);
  if (!out?.video) { await fs.rm(output, { force: true }); return { ok: false, reason: 'output-probe-failed' }; }
  return { ok: true, hdr, width: out.video.width, height: out.video.height, codec: out.video.codec_name };
}

/* ------------------------------------------------------------------ *
 * Manager: import handling, background transcoding, registration, handoff to upload queue
 * ------------------------------------------------------------------ */

async function atomicWrite(file, text) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(tmp, text);
  try { await fs.rename(tmp, file); }
  catch (error) { await fs.rm(tmp, { force: true }); throw error; }
}

const exists = async (file) => { try { await fs.stat(file); return true; } catch { return false; } };

/**
 * @param {object} options
 * @param {string} options.dir  Local content store (asset catalog)
 * @param {{ hashFile(file: string): Promise<string>, writeIndex(hash: string, entry: object): Promise<void>, contentTypeForExt(ext: string): string, forget?: (hash: string) => Promise<void> }} options.lib
 * @param {() => Promise<string>} options.ffmpeg  Gets ffmpeg command (lazy, `findFfmpeg`)
 * @param {any} [options.queue]  Upload queue (`createUploadQueue`); if omitted, generates only without uploading
 * @param {(event: string, fields: object) => void} [options.log]
 */
export function createTierManager({ dir, lib, ffmpeg, queue = null, log = () => {}, ownership = null }) {
  const file = path.join(dir, TIERS_FILE);
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging errors do not affect execution */ } };
  /** Original-size asset hash → { state: 'pending' | 'ready' | 'failed' | 'none', small?, name?, ext?, reason? } */
  let items = {};
  /** Pre-remux hash → post-remux hash */
  let remuxed = {};
  try {
    const saved = JSON.parse(fsSync.readFileSync(file, 'utf8'));
    if (saved?.v === TIERS_VERSION && (!ownership || saved.projectId === ownership.projectId)) {
      if (saved.items && typeof saved.items === 'object') items = saved.items;
      if (saved.remuxed && typeof saved.remuxed === 'object') remuxed = saved.remuxed;
    }
  } catch { /* Empty if none */ }

  let chain = Promise.resolve();
  const persist = () => {
    chain = chain.then(async () => { await ownership?.assert(); return atomicWrite(file, JSON.stringify({ v: TIERS_VERSION, items, remuxed, ...(ownership ? { projectId: ownership.projectId } : {}) }, null, 1)); })
      .catch((error) => say('tiers.persist-failed', { message: String(error?.message ?? error) }));
    return chain;
  };

  let cmd = null;
  const ffmpegCmd = async () => (cmd ??= await ffmpeg());

  /** Moves a temporary file outside the store (on the same volume) into the store by content hash; deletes the temporary file if already in the store */
  async function adoptTemp(tmp, { ext, name }) {
    try {
    const hash = await lib.hashFile(tmp);
    const fileName = ext ? `${hash}.${ext}` : hash;
    const dest = path.join(dir, fileName);
    const had = await exists(dest);
    await ownership?.assert();
    tierJobContext.getStore()?.signal.throwIfAborted();
    let size;
    if (ownership) {
      const existing = await lib.entry?.(hash), lease = tierJobContext.getStore();
      await publishProjectFile({ temp: tmp, target: dest, lease, assert: async () => { await ownership.assert(); await lease?.assert(); }, afterCommit: async () => { size = (await fs.stat(dest)).size; await lib.writeIndex(hash, { file: fileName, name, ext, size, contentType: lib.contentTypeForExt(ext) }); }, rollback: async () => { if (existing) await lib.writeIndex(hash, existing); else await lib.forget?.(hash); } });
    } else { if (had) await fs.rm(tmp, { force: true }); else await fs.rename(tmp, dest); size = (await fs.stat(dest)).size; await lib.writeIndex(hash, { file: fileName, name, ext, size, contentType: lib.contentTypeForExt(ext) }); }
    return { hash, ext, name, bytes: size, path: dest, url: `/@media/${hash}`, contentType: lib.contentTypeForExt(ext), deduped: had, ...(ownership ? { projectId: ownership.projectId } : {}) };
    } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
  }

  /* ---------- Background transcoding: one at a time ---------- */
  const jobs = [];
  let busy = false;
  const idle = [];
  async function worker() {
    if (busy) return;
    busy = true;
    try {
      while (jobs.length) {
        const hash = jobs.shift();
        let lease;
        try {
          lease = await ownership?.acquire?.();
          await ownership?.assert();
          if (lease) await lease.run(() => tierJobContext.run(lease, () => buildSmall(hash)));
          else await tierJobContext.run(null, () => buildSmall(hash));
        } catch (error) { say('tiers.ownership-rejected', { hash, projectId: ownership?.projectId, code: error?.code ?? 'access-revoked' }); }
        finally { lease?.release(); }
      }
    } finally {
      busy = false;
      for (const resolve of idle.splice(0)) resolve();
    }
  }
  function schedule(hash) {
    if (!jobs.includes(hash)) jobs.push(hash);
    void worker();
  }

  async function buildSmall(hash) {
    const rec = items[hash];
    if (!rec || rec.state !== 'pending') return;
    const source = path.join(dir, rec.ext ? `${hash}.${rec.ext}` : hash);
    if (!(await exists(source))) {
      rec.state = 'failed';
      rec.reason = 'source-missing';
      await persist();
      return;
    }
    const tmp = path.join(dir, `.small-${crypto.randomBytes(8).toString('hex')}.mp4`);
    const started = Date.now();
    say('tiers.small-start', { hash });
    let result;
    try { result = await makeSmallVersion({ ffmpeg: await ffmpegCmd(), input: source, output: tmp }); }
    catch (error) { result = { ok: false, reason: String(error?.message ?? error) }; }
    if (result.ok) {
      const baseName = String(rec.name || hash).replace(/\.[^.]*$/, '');
      const stored = await adoptTemp(tmp, { ext: 'mp4', name: `${baseName}.small.mp4` });
      rec.state = 'ready';
      rec.small = stored.hash;
      rec.smallExt = 'mp4';
      rec.width = result.width;
      rec.height = result.height;
      if (result.hdr) rec.hdr = true;
      delete rec.reason;
      say('tiers.small-done', { hash, small: stored.hash, width: result.width, height: result.height, hdr: !!result.hdr, ms: Date.now() - started });
    } else {
      await fs.rm(tmp, { force: true });
      rec.state = result.reason === 'no-video' ? 'none' : 'failed';
      rec.reason = result.reason;
      say('tiers.small-failed', { hash, reason: result.reason });
    }
    await persist();
    await handToQueue(hash);
  }

  async function handToQueue(hash) {
    const rec = items[hash];
    if (!queue || !rec) return;
    const tiers = [];
    if (rec.state === 'ready' && rec.small) tiers.push({ tier: 'small', hash: rec.small, ext: rec.smallExt || 'mp4' });
    tiers.push({ tier: 'original', hash, ext: rec.ext || '' });
    try { await ownership?.assert(); await queue.enqueue({ name: rec.name || '', tiers, ...(ownership ? { projectId: ownership.projectId } : {}) }); }
    catch (error) { say('tiers.enqueue-failed', { hash, message: String(error?.message ?? error) }); }
  }

  /** Non-video assets (images, audio): no small-size asset, hands only original-size asset to upload queue; not registered into items (which tracks transcoding status of the two tiers) */
  async function handOriginalToQueue(stored) {
    if (!queue) return;
    const hash = String(stored.hash).toLowerCase();
    const ext = String(stored.ext || '').toLowerCase().replace(/^\./, '');
    try { await ownership?.assert(); await queue.enqueue({ name: stored.name || '', tiers: [{ tier: 'original', hash, ext }], ...(ownership ? { projectId: ownership.projectId } : {}) }); }
    catch (error) { say('tiers.enqueue-failed', { hash, message: String(error?.message ?? error) }); }
  }

  return {
    get file() { return file; },
    /**
     * Called after import (`stored` is the result of `storeMediaStream` / `adoptMediaFile`). Video: remuxes
     * if faststart is missing (waits in place for completion, and the hash in the response is the remuxed one),
     * then schedules small-size asset; non-video (images, audio) returns as is, handing only original-size
     * asset to upload queue (transferred when connected to remote asset service so other members in shared
     * projects can retrieve it).
     * Returns `{ stored, tiers: { original, small } | null, small: 'pending' | 'ready' | 'failed' | 'none' | null, remux }`.
     */
    async prepareImport(stored, { remux = true } = {}) {
      const lease = await ownership?.acquire?.();
      try { return lease ? await lease.run(() => tierJobContext.run(lease, prepare)) : await prepare(); }
      finally { await lease?.release(); }
      async function prepare() {
      await ownership?.assert();
      if (ownership && ((stored?.projectId && stored.projectId !== ownership.projectId) || !String(path.resolve(stored?.path ?? '')).startsWith(path.resolve(dir) + path.sep))) throw Object.assign(new Error('project-mismatch'), { code: 'project-mismatch', status: 403 });
      const ext = String(stored?.ext || '').toLowerCase();
      if (!stored || !HASH.test(String(stored.hash))) return { stored, tiers: null, small: null, remux: null };
      if (!isVideoExt(ext)) {
        // Images and audio have only the original-size asset tier: still handed to the upload queue
        // (transferred when connected to remote asset service so other members can retrieve them;
        // queue is a no-op when connected locally)
        await handOriginalToQueue(stored);
        return { stored, tiers: null, small: null, remux: null };
      }
      let current = stored;
      let remuxInfo = { state: 'skipped', reason: 'disabled' };
      if (remux && REMUX_EXTS.includes(ext)) {
        const known = remuxed[stored.hash];
        const knownFile = known ? path.join(dir, `${known}.${ext}`) : null;
        if (known && knownFile && await exists(knownFile)) {
          // The same source file was previously remuxed: reuse that copy directly
          if (!stored.deduped) { await fs.rm(stored.path, { force: true }); await lib.forget?.(stored.hash); }
          current = { ...stored, hash: known, path: knownFile, url: `/@media/${known}`, bytes: (await fs.stat(knownFile)).size, deduped: true };
          remuxInfo = { state: 'remuxed', from: stored.hash, reused: true };
        } else {
          const tmp = path.join(dir, `.remux-${crypto.randomBytes(8).toString('hex')}.${ext}`);
          let r;
          try { r = await remuxIfNeeded({ ffmpeg: await ffmpegCmd(), input: stored.path, ext, output: tmp }); }
          catch (error) { await fs.rm(tmp, { force: true }); r = { state: 'failed', reason: String(error?.message ?? error) }; }
          if (r.state === 'remuxed') {
            const out = await adoptTemp(tmp, { ext, name: stored.name });
            if (!stored.deduped && out.hash !== stored.hash) { await fs.rm(stored.path, { force: true }); await lib.forget?.(stored.hash); }
            remuxed[stored.hash] = out.hash;
            await persist();
            current = out;
            remuxInfo = { state: 'remuxed', from: stored.hash };
            say('tiers.remuxed', { from: stored.hash, to: out.hash });
          } else {
            remuxInfo = r;
            if (r.state === 'failed') say('tiers.remux-failed', { hash: stored.hash, reason: r.reason });
          }
        }
      } else if (!REMUX_EXTS.includes(ext)) {
        remuxInfo = { state: 'skipped', reason: 'container' };
      }
      const hash = current.hash;
      let rec = items[hash];
      if (rec && rec.state === 'ready' && !(await exists(path.join(dir, `${rec.small}.${rec.smallExt || 'mp4'}`)))) rec = null;
      if (!rec || rec.state === 'failed') {
        rec = items[hash] = { state: 'pending', name: current.name || stored.name || '', ext };
        await persist();
        schedule(hash);
      } else if (rec.state === 'pending') {
        schedule(hash);
      } else {
        // Small-size asset already exists (or confirmed absent): still handed to the upload queue;
        // it will skip what the remote already has
        await handToQueue(hash);
      }
      return {
        stored: current,
        tiers: { original: hash, small: rec.state === 'ready' ? rec.small : null },
        small: rec.state,
        remux: remuxInfo,
      };
      }
    },
    /**
     * Catch-up transcoding for small-size assets when opening a project (design doc section 9 item 2):
     * videos that lack `tiers.small` in the project but have their original-size asset in the local
     * content store are scheduled for background transcoding (no remux: the hash is the one referenced
     * by the project, same for assets restored from `.procp`).
     * Leaves those with existing small-size assets (file still present) or confirmed to have no video
     * stream untouched; retries previously failed ones. Once transcoded, hands off to the upload queue
     * as usual.
     * `ext` is the extension of the file in the store. Returns `{ state, small? }`, same as `status`.
     */
    async backfill({ hash, ext, name = '' }) {
      await ownership?.assert();
      const h = String(hash || '').toLowerCase();
      const e = String(ext || '').toLowerCase();
      if (!HASH.test(h) || !isVideoExt(e)) return { state: 'skipped' };
      let rec = items[h];
      if (rec && rec.state === 'ready' && !(await exists(path.join(dir, `${rec.small}.${rec.smallExt || 'mp4'}`)))) rec = null;
      if (rec && (rec.state === 'ready' || rec.state === 'none')) return this.status([h])[h];
      if (!rec || rec.state === 'failed') {
        rec = items[h] = { state: 'pending', name: String(name || ''), ext: e, backfill: true };
        await persist();
        say('tiers.backfill', { hash: h });
      }
      schedule(h);
      return { state: 'pending' };
    },
    /** Small-size asset status for these original-size asset hashes: `{ [hash]: { state, small? } }`; unregistered ones have `state: 'unknown'` */
    status(hashes) {
      const out = {};
      for (const raw of hashes ?? []) {
        const h = String(raw || '').toLowerCase();
        if (!HASH.test(h)) continue;
        const rec = items[h];
        out[h] = rec ? { state: rec.state, ...(rec.small ? { small: rec.small } : {}), ...(rec.reason ? { reason: rec.reason } : {}) } : { state: 'unknown' };
      }
      return out;
    },
    /** After process restart: resume transcoding those still pending */
    resume() {
      for (const [hash, rec] of Object.entries(items)) if (rec?.state === 'pending') schedule(hash);
    },
    /** Waits for transcode queue to be empty (used by tests and probes) */
    idle() {
      if (!busy && !jobs.length) return Promise.resolve();
      return new Promise((resolve) => idle.push(resolve));
    },
  };
}
