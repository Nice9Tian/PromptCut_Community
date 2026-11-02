/**
 * For testing only, must not be imported by production code.
 *
 * Shared harness for C6.6 contract tests (`c66-*.test.mjs`). Based solely on `docs/plan/c66-design.md`
 * sections 2-5, section 6 T1-T8, section 8, and `docs/plan/cloud-task.md` A1 acceptance check; the
 * test author did not look at implementations (`claude/c66-tiers`, `c66-fetch`, `c66-cards`).
 *
 * Module paths, function names, parameters, and response shapes not finalized by the design draft are
 * all consolidated in this file; during integration reconciliation, only modify here. Each assumption
 * is marked as "Assumption K<n>", and report `docs/archive/agent-reports/AGENT-c66-tests.md` lists them
 * using the same numbering.
 *
 *   K1  Two-tier generation: new module `server/media-tiers.mjs` (not explicitly named in section 2
 *       of design draft) exports
 *       - `makeSmallTier({ ffmpeg, input, output })`: transcode `input` into small-size asset and
 *         write to `output` (mp4), resolve upon completion;
 *       - `hasFaststart(file)`: for ISO BMFF (mp4 / mov / m4v), determine by top-level box order:
 *         `moov` before first `mdat` → true, otherwise false; not ISO BMFF (MKV, AVI, etc.) →
 *         null ("not applicable"). Can be synchronous or asynchronous;
 *       - `ensureFaststart({ ffmpeg, input, workDir })` → `{ path, remuxed }`: if needed, remux to a
 *         new file under `workDir` with `-c copy -movflags +faststart`; if not needed or not
 *         applicable → `{ path: input, remuxed: false }`; **do not throw on remux failure**, also
 *         return `{ path: input, remuxed: false }`, leaving source file untouched;
 *       - `prepareTiers({ ffmpeg, input, kind, workDir })` →
 *         `{ original: { path, hash }, small?: { path, hash } }`, `kind` ∈
 *         `'video' | 'audio' | 'image'`; `hash` = sha256 of the file (64-character lowercase hex).
 *       Function names permit aliases listed in `pick` below.
 *   K2  Upload queue: new module `server/upload-queue.mjs` exports
 *       `createUploadQueue({ file, base, fetch, ticket, chunkSize })`:
 *       - `file`: path to persisted `upload-queue.json` (test provides one in temporary directory);
 *       - `base`: asset service API base URL (like `http://127.0.0.1:<port>/api/asset`), all requests
 *         via injected `fetch`;
 *       - `enqueue({ id, tiers: { small?: { hash, path, ext }, original: { hash, path, ext } } })`;
 *       - `drain()`: resolve after draining the queue; if network is disconnected, can reject or wait
 *         indefinitely (test uses timeout as fallback);
 *       - `close()` (or `stop()`): stop, keep pending items written into `file`; after creating a
 *         new instance with the same `file`, call `drain()` to resume.
 *       Chunked upload follows the asset service's existing protocol (`GET <ns>/<hash>/chunks`,
 *       `PUT <ns>/<hash>/<n>`, `POST <ns>/<hash>/complete`).
 *   K3  Export interception: new module `server/export-gate.mjs` exports
 *       `checkExportOriginals({ project, has })`:
 *       `has(hash) → Promise<boolean>` checks "whether this hash is complete on the current asset service";
 *       returns `{ ok: true }` or `{ ok: false, message, missing: [{ mediaId, hash, name? }] }`
 *       (including `code` is also fine, test ignores it), with "waiting for uploader" in `message`.
 *       Only inspects **original-size asset** (`tiers.original`, or `hash` if without tiers) of assets
 *       referenced by clips.
 *   K4  Playability: still `src/render/playability.ts`, exported names unchanged
 *       (`probePlayable(hash, url, ext, kind)`, `playableOnThisHost`, `rememberPlayable`,
 *       `forgetPlayable`); browser major version taken from `navigator.userAgent` (`Chrome/<n>`,
 *       `Firefox/<n>`, `Version/<n> Safari`), key storing conclusion in `localStorage` contains hash
 *       and major version number; timeout timed via `window.__pcRealSetTimeout` (existing hook);
 *       "remote" = absolute http(s) address (local is `/@media/...`).
 *   K5  Card sync: new module `server/card-sync.mjs` exports `createCardSync(deps)`, deps:
 *       - `content`: content store client, shape same as `server/render-node/content-client.mjs`
 *         (`put(kind, key, body) → { hash, rev }`, `get(kind, key) → { body, hash, rev } | null`,
 *         `list(kind, prefix?) → { items: [{ key, hash, rev }] }`), plus `watch(kind, onChanged)`,
 *         `onChanged({ kind, key, hash, rev, previousActor })`, returns a cancel function;
 *       - `readLocal(key) → Promise<string | null>`: local copy of source code (null if none);
 *       - `install({ key, body, rev }) → Promise`: install card (represents calling `/api/cards/install`);
 *       - `backup({ key, body }) → Promise`: back up local copy;
 *       - `notify({ type: 'card-overwritten', key, rev })`: overwrite notice;
 *       - `scopeOf(key) → 'user' | 'builtin-modified' | 'builtin'`;
 *       - `stateFile`: disk persistence location for "cardRev and content hash from last sync".
 *       Instance methods: `saved({ key, body })` (after save), `open()` (open shared project: list,
 *       pull, subscribe), `close()`.
 *       Card source code `body` is source string; `key` is repository-relative path.
 *
 * # Integration reconciliation (`claude/c66-integ`, report `docs/archive/agent-reports/AGENT-c66-integ.md` section 2)
 *
 * K1-K5 above are assumptions made when tests were written; where actual module names and shapes
 * differ, adapted into assumed shapes by each `load*` below, leaving test cases themselves untouched:
 *   K1  `server/media-tiers.mjs`: `makeSmallVersion` (returns `{ ok }`, does not throw),
 *       `faststartState` (four-state string), `remuxIfNeeded` (writes to caller-provided `output`),
 *       `createTierManager` (performs import in local content store: remux, queue small-size asset,
 *       register). `prepareTiers` assembled using temporary content store + real
 *       `createTierManager().prepareImport()` + `idle()`.
 *   K2  `createUploadQueue({ file, target, resolveFile })` in `server/upload-queue.mjs`: asset
 *       service client constructed by `createAssetClient({ base, fetch, chunkSize })` in
 *       `server/asset-store/client.mjs`; tiers as array `[{ tier, hash, ext }]`; requires `start()`
 *       to run; local files resolved via `resolveFile(hash)` (this file records path given at enqueue).
 *   K3  No `server/export-gate.mjs`: interception logic is in `checkExportOriginals` of
 *       `src/render/mediaTier.ts` (added during integration, shared between page and prerender
 *       process `/api/export`).
 *   K4  `playability.ts` sets `style` on offscreen `<video>` during probing, appends to document
 *       then calls `remove()`, checks `videoWidth`: fake DOM added these items. MOV queries
 *       `canPlayType` as `video/mp4` (design draft section 9 approved c66-fetch approach),
 *       C66-T6-02 MIME assertion updated accordingly.
 *   K5  `createCardSync({ stateDir, files: { read, changed, install, backup }, connect, notify })`
 *       in `server/card-sync.mjs`, reads/writes content store via a document service connection
 *       (`content.*` messages): this file uses a fake endpoint to forward messages to
 *       `fakeContentService`. "Whether it is a user card or modified built-in card" is determined by
 *       caller (`vite-plugin-cards.ts`) in real system, determined here via `scopeOf`; overwrite
 *       notice is `overwritten` event, mapped to `notify({ type: 'card-overwritten' })`.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
export const sha256File = (file) => sha256(fs.readFileSync(file));
export const HEX64 = /^[0-9a-f]{64}$/;

export function tempDir(prefix = 'pc-c66-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Get function from module by name (including aliases); fail assertion and list actual exports if none found */
function pick(mod, names, file) {
  for (const n of names) if (typeof mod[n] === 'function') return mod[n];
  assert.fail(`${file} must export one of ${names.join(' / ')}; actual exports: ${Object.keys(mod).join(', ') || '(none)'}`);
}

async function importRepo(rel) {
  try {
    return await import(pathToFileURL(path.join(ROOT, rel)).href);
  } catch (err) {
    assert.fail(`cannot load ${rel}: ${err?.message ?? err}`);
  }
}

// ================================================================== ffmpeg and samples

let ffmpegCmd = null;
/** Use repository's existing `findFfmpeg` (design draft section 2: "use findFfmpeg") */
export async function ffmpeg() {
  if (ffmpegCmd) return ffmpegCmd;
  const { findFfmpeg } = await import(pathToFileURL(path.join(ROOT, 'server', 'bakery', 'ffmpeg.mjs')).href);
  ffmpegCmd = await findFfmpeg();
  return ffmpegCmd;
}
export async function ffprobe() {
  const f = await ffmpeg();
  return f.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));
}

export function run(cmd, args, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(`${path.basename(cmd)} ${args.join(' ')} exit code ${code}: ${err.slice(-800)}`));
    });
  });
}

/** ffprobe streams + format */
export async function probe(file) {
  const { out } = await run(await ffprobe(), ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const j = JSON.parse(out);
  const video = j.streams.find((s) => s.codec_type === 'video');
  const audio = j.streams.find((s) => s.codec_type === 'audio');
  return { video, audio, format: j.format, streams: j.streams };
}

/** Compute md5 of packet data per stream: encoding unchanged <=> packet data consistent per stream (remux only moves boxes, does not touch packets) */
export async function streamHashes(file) {
  const { out } = await run(await ffmpeg(), ['-v', 'error', '-i', file, '-map', '0', '-c', 'copy', '-f', 'streamhash', '-hash', 'md5', '-']);
  return out.trim().split(/\r?\n/).filter(Boolean);
}

/** Frame count decoded from video stream (by packet count, `-count_packets`) */
export async function videoPackets(file) {
  const { out } = await run(await ffprobe(), ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', file]);
  return Number(out.trim());
}

/**
 * Type sequence of ISO BMFF top-level boxes (test's own parser, not using module under test).
 * size == 1 → 64-bit largesize; size == 0 → to end of file. Stop if parsing cannot continue.
 */
export function topLevelBoxes(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const total = fs.fstatSync(fd).size;
    const types = [];
    let off = 0;
    const head = Buffer.alloc(16);
    while (off + 8 <= total) {
      fs.readSync(fd, head, 0, 16, off);
      let size = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (!/^[\x20-\x7e]{4}$/.test(type)) break;
      if (size === 1) size = Number(head.readBigUInt64BE(8));
      else if (size === 0) size = total - off;
      if (size < 8) break;
      types.push(type);
      off += size;
    }
    return types;
  } finally {
    fs.closeSync(fd);
  }
}
export function boxFaststart(file) {
  const t = topLevelBoxes(file);
  const moov = t.indexOf('moov');
  const mdat = t.indexOf('mdat');
  if (moov < 0 || mdat < 0) return null;
  return moov < mdat;
}

/**
 * Small samples generated on the fly (design draft section 8 "Test media: generated on the fly").
 * Generated only once per test file.
 *   hd        1920×1080, 30 fps, 2 s, H.264 yuv420p + AAC, faststart
 *   lateMoov  same as above, moov after mdat
 *   prores    1280×720 ProRes MOV + PCM (ffmpeg mov defaults to late moov)
 *   mkv       640×360 H.264 MKV
 *   fps120    640×360, 120 fps, 1 s, no audio track
 *   odd       1001×777, yuv444p (small-size asset must be converted to yuv420p, even dimensions)
 *   portrait  1920×1080 frame + 90° display rotation (small-size asset is vertical after -autorotate)
 *   noAudio   640×360, no audio track (no upscaling)
 *   png       320×240 single-frame image
 *   m4a       2 s sine wave AAC
 */
export async function makeSamples(dir) {
  const f = await ffmpeg();
  const lav = (spec) => ['-f', 'lavfi', '-i', spec];
  const x264 = ['-c:v', 'libx264', '-preset', 'ultrafast'];
  const out = (name) => path.join(dir, name);
  const s = {
    hd: out('hd.mp4'), lateMoov: out('late.mp4'), prores: out('prores.mov'), mkv: out('clip.mkv'),
    fps120: out('fps120.mp4'), odd: out('odd.mp4'), portrait: out('portrait.mp4'), noAudio: out('noaudio.mp4'),
    png: out('still.png'), m4a: out('tone.m4a'),
  };
  const jobs = [
    [...lav('testsrc2=size=1920x1080:rate=30:duration=2'), ...lav('sine=frequency=440:duration=2'), ...x264, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', s.hd],
    [...lav('testsrc2=size=1920x1080:rate=30:duration=2'), ...lav('sine=frequency=440:duration=2'), ...x264, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', '-shortest', s.lateMoov],
    [...lav('testsrc2=size=1280x720:rate=25:duration=1'), ...lav('sine=frequency=330:duration=1'), '-c:v', 'prores_ks', '-profile:v', '0', '-c:a', 'pcm_s16le', '-shortest', s.prores],
    [...lav('testsrc2=size=640x360:rate=30:duration=1'), ...x264, '-pix_fmt', 'yuv420p', s.mkv],
    [...lav('testsrc2=size=640x360:rate=120:duration=1'), ...x264, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', s.fps120],
    [...lav('testsrc2=size=1001x777:rate=30:duration=1'), ...x264, '-pix_fmt', 'yuv444p', '-movflags', '+faststart', s.odd],
    [...lav('testsrc2=size=640x360:rate=30:duration=1'), ...x264, '-pix_fmt', 'yuv420p', '-movflags', '+faststart', s.noAudio],
    [...lav('testsrc2=size=320x240:rate=1'), '-frames:v', '1', s.png],
    [...lav('sine=frequency=440:duration=2'), '-c:a', 'aac', '-b:a', '96k', s.m4a],
  ];
  await Promise.all(jobs.map((args) => run(f, ['-y', '-hide_banner', '-loglevel', 'error', ...args])));
  // 90° display rotation: copy hd directly, only add display matrix
  await run(f, ['-y', '-hide_banner', '-loglevel', 'error', '-display_rotation', '90', '-i', s.hd, '-c', 'copy', '-movflags', '+faststart', s.portrait]);
  return s;
}

// ================================================================== K1 Two-tier generation

export async function loadTiers() {
  const file = 'server/media-tiers.mjs';
  const mod = await importRepo(file);
  // Integration reconciliation (K1): actual exports makeSmallVersion / faststartState / remuxIfNeeded / createTierManager
  const makeSmallVersion = pick(mod, ['makeSmallVersion'], file);
  const faststartState = pick(mod, ['faststartState'], file);
  const remuxIfNeeded = pick(mod, ['remuxIfNeeded'], file);
  const createTierManager = pick(mod, ['createTierManager'], file);
  const makeSmall = async ({ ffmpeg: f, input, output }) => {
    const r = await makeSmallVersion({ ffmpeg: f, input, output });
    if (!r?.ok) throw new Error(`makeSmallVersion did not produce a small-size asset: ${r?.reason}`);
    return r;
  };
  const hasFaststartFn = async (f) => {
    const s = await faststartState(f);
    return s === 'faststart' ? true : s === 'needs' ? false : null;
  };
  const ensureFaststartFn = async ({ ffmpeg: f, input, workDir }) => {
    const ext = path.extname(input).slice(1).toLowerCase();
    const output = path.join(workDir, `remux-${crypto.randomBytes(4).toString('hex')}.${ext}`);
    const r = await remuxIfNeeded({ ffmpeg: f, input, ext, output });
    return r.state === 'remuxed' ? { path: output, remuxed: true } : { path: input, remuxed: false };
  };
  const prepareFn = async ({ ffmpeg: f, input, workDir }) => {
    // Temporary local content store: put source file in by hash (same as import), then run real
    // prepareImport + background small-size asset
    const dir = path.join(workDir, 'lib');
    fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(input).slice(1).toLowerCase();
    const hash = sha256File(input);
    const stored = path.join(dir, `${hash}.${ext}`);
    fs.copyFileSync(input, stored);
    const manager = createTierManager({
      dir,
      lib: {
        hashFile: async (p) => sha256File(p),
        writeIndex: async () => {},
        forget: async () => {},
        contentTypeForExt: (e) => (e === 'mp4' ? 'video/mp4' : 'application/octet-stream'),
      },
      ffmpeg: async () => f,
    });
    const out = await manager.prepareImport({ hash, ext, name: path.basename(input), path: stored, url: `/@media/${hash}`, deduped: false });
    const original = { path: out.stored.path, hash: out.stored.hash };
    if (!out.tiers) return { original };
    await manager.idle();
    const st = manager.status([original.hash])[original.hash];
    return st?.small ? { original, small: { path: path.join(dir, `${st.small}.mp4`), hash: st.small } } : { original };
  };
  return {
    mod,
    makeSmall: (opts) => makeSmall(opts),
    hasFaststart: async (f) => hasFaststartFn(f),
    ensureFaststart: async (opts) => {
      const r = await ensureFaststartFn(opts);
      assert.ok(r && typeof r.path === 'string', `ensureFaststart must return { path, remuxed }: ${JSON.stringify(r)}`);
      return { path: r.path, remuxed: !!r.remuxed };
    },
    prepare: async (opts) => {
      const r = await prepareFn(opts);
      assert.ok(r && r.original && typeof r.original.path === 'string', `prepareTiers must return { original: { path, hash }, small? }: ${JSON.stringify(r)}`);
      return r;
    },
  };
}

// ================================================================== K2 upload queue

export async function loadUploadQueue() {
  const file = 'server/upload-queue.mjs';
  const mod = await importRepo(file);
  const create = pick(mod, ['createUploadQueue', 'uploadQueue'], file);
  // Integration reconciliation (K2): the real queue requires target() (asset service client) and
  // resolveFile(hash), tiers is an array, and requires start()
  const { createAssetClient } = await importRepo('server/asset-store/client.mjs');
  return ({ file: qfile, base, fetch: f, ticket, chunkSize }) => {
    const client = createAssetClient({
      base, fetch: f, ...(chunkSize ? { chunkSize } : {}), ...(ticket ? { ticket: () => ticket } : {}), retries: 1, timeoutMs: 10_000,
    });
    const q = create({
      file: qfile,
      target: () => ({ client, base }),
      resolveFile: (hash) => UPLOAD_FILES.get(String(hash).toLowerCase()) ?? null,
    });
    assert.equal(typeof q?.enqueue, 'function', 'an instance of createUploadQueue must have enqueue');
    assert.equal(typeof q?.drain, 'function', 'an instance of createUploadQueue must have drain');
    q.start();
    return {
      raw: q,
      enqueue: (item) => {
        const tiers = [];
        for (const tier of ['small', 'original']) {
          const t = item?.tiers?.[tier];
          if (!t) continue;
          UPLOAD_FILES.set(String(t.hash).toLowerCase(), t.path);
          tiers.push({ tier, hash: t.hash, ext: t.ext });
        }
        return q.enqueue({ name: item?.id ?? '', tiers });
      },
      drain: () => q.drain(),
      close: async () => { await (q.close ?? q.stop)?.call(q); },
    };
  };
}
/**
 * Used by the upload queue to find local files: records hash → path on enqueue (even new
 * instances restarted within the same test process must be able to find them)
 */
const UPLOAD_FILES = new Map();

/**
 * Records fetch for each request (same style as `asset-client.test.mjs`). Always throws a network
 * error when `state.offline` is true; `hook(info, log)` returning a Response or throwing an error
 * can replace real requests. Each entry in `log` is `{ method, url, path, ns, hash, action, n }`,
 * with `action` ∈ `chunks` | `put` | `complete` | `other`.
 */
export function recordingFetch(hook = () => undefined) {
  const log = [];
  const state = { offline: false };
  const fn = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const method = String(init.method || (typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const p = new URL(url).pathname;
    const m = /\/(media|snap|px)\/([0-9a-f]{64})(?:\/(chunks|complete|\d+))?$/i.exec(p);
    const info = { method, url, path: p, ns: m?.[1] ?? null, hash: m?.[2]?.toLowerCase() ?? null, action: 'other', n: null, ok: null };
    if (m?.[3] === 'chunks') info.action = 'chunks';
    else if (m?.[3] === 'complete') info.action = 'complete';
    else if (m?.[3] && method === 'PUT') { info.action = 'put'; info.n = Number(m[3]); }
    log.push(info);
    if (state.offline) { info.ok = false; throw new TypeError('fetch failed (test network outage)'); }
    const replaced = await hook(info, log, state);
    if (replaced !== undefined) return replaced;
    const res = await globalThis.fetch(input, init);
    info.ok = res.ok;
    return res;
  };
  return { fetch: fn, log, state };
}

/** Directly query asset service `GET media/<hash>/chunks` */
export async function chunksOf(base, hash, ns = 'media') {
  const res = await fetch(`${base}/${ns}/${hash}/chunks`);
  assert.equal(res.status, 200, `GET ${ns}/${hash}/chunks should return 200`);
  return res.json();
}

/** Reproducible pseudorandom bytes */
export function bytesOf(size, seed) {
  const out = Buffer.alloc(size);
  let x = seed >>> 0 || 1;
  for (let i = 0; i < size; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; out[i] = x & 0xff; }
  return out;
}

// ================================================================== K3 export intercept

export async function loadExportGate() {
  // Integration reconciliation (K3): interception logic is in src/render/mediaTier.ts
  // (shared between page and prerender process); no separate server/export-gate.mjs is created
  await import(pathToFileURL(path.join(ROOT, 'src', 'testing', 'registerTs.mjs')).href);
  const file = 'src/render/mediaTier.ts';
  const mod = await importRepo(file);
  const check = pick(mod, ['checkExportOriginals', 'checkOriginals', 'exportGate'], file);
  return async ({ project, has }) => {
    const r = await check({ project, has });
    assert.ok(r && typeof r.ok === 'boolean', `checkExportOriginals must return { ok, ... }: ${JSON.stringify(r)}`);
    const missing = (r.missing ?? []).map((m) => (typeof m === 'string' ? { hash: m } : m));
    return { ...r, missing, missingHashes: missing.map((m) => String(m.hash).toLowerCase()).sort() };
  };
}

// ================================================================== K4 playability (fake DOM)

/**
 * Installs a minimal fake DOM on globalThis (`document.createElement('video')`,
 * `navigator.userAgent`, `localStorage`, `window.__pcRealSetTimeout`) for `playability.ts`
 * to run in Node.
 *   behavior(el) determines how this fake video responds: 'playable' | 'error' | 'hang';
 * canPlay determines what canPlayType returns.
 * Returns `{ storage, created, timers, setUA, restore }`: `created` is a record of each
 * createElement call, and `timers` contains timeout milliseconds.
 */
export function installFakeDom({ ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36' } = {}) {
  const saved = {};
  for (const k of ['document', 'navigator', 'localStorage', 'window']) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
  const map = new Map();
  const storage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() { return map.size; },
    _map: map,
  };
  const ctl = { canPlay: 'maybe', behavior: 'playable', created: [], timers: [], fireTimers: true };
  const nav = { userAgent: ua };
  class FakeVideo extends EventTarget {
    // Integration reconciliation (K4): playability.ts sets style, appends to document then calls
    // remove(), and checks videoWidth; the fake element provides these
    constructor(tag) { super(); this.tagName = tag.toUpperCase(); this._src = ''; this.muted = false; this.preload = ''; this.readyState = 0; this.style = {}; this.videoWidth = 0; ctl.created.push(this); }
    remove() {}
    canPlayType(mime) { this.askedMime = mime; return ctl.canPlay; }
    set src(v) {
      this._src = v;
      if (!v) return;
      const b = ctl.behavior;
      setTimeout(() => {
        if (b === 'playable') {
          this.readyState = 2;
          this.videoWidth = 640;
          this.dispatchEvent(new Event('loadedmetadata'));
          this.dispatchEvent(new Event('loadeddata'));
          this.dispatchEvent(new Event('canplay'));
        } else if (b === 'error') {
          this.dispatchEvent(new Event('error'));
        }
      }, 5);
    }
    get src() { return this._src; }
    setAttribute(k, v) { if (k === 'src') this.src = v; }
    removeAttribute(k) { if (k === 'src') this._src = ''; }
    load() {}
    play() { return Promise.resolve(); }
    pause() {}
    requestVideoFrameCallback(cb) {
      if (ctl.behavior === 'playable') setTimeout(() => cb(performance.now(), { mediaTime: 0, presentedFrames: 1 }), 5);
      return 1;
    }
    cancelVideoFrameCallback() {}
  }
  const doc = { createElement: (tag) => new FakeVideo(tag), body: { appendChild() {}, removeChild() {} }, documentElement: { appendChild() {} } };
  const win = {
    __pcRealSetTimeout: (fn, ms) => { ctl.timers.push(ms); return setTimeout(fn, ctl.fireTimers ? 200 : 2 ** 31 - 1); }, // Integration reconciliation: 20 → 200 ms. Windows timer granularity is about 15 ms, so the two-step 5 ms timers of trial playback race with the 20 ms timeout
    location: { origin: 'http://127.0.0.1:5199', href: 'http://127.0.0.1:5199/' },
    navigator: nav,
    localStorage: storage,
    document: doc,
  };
  const def = (k, v) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
  def('document', doc);
  def('navigator', nav);
  def('localStorage', storage);
  def('window', win);
  return {
    storage, ctl,
    setUA: (next) => { nav.userAgent = next; },
    restore: () => {
      for (const [k, d] of Object.entries(saved)) {
        if (d) Object.defineProperty(globalThis, k, d);
        else delete globalThis[k];
      }
    },
  };
}

export async function loadPlayability() {
  await import(pathToFileURL(path.join(ROOT, 'src', 'testing', 'registerTs.mjs')).href);
  const file = 'src/render/playability.ts';
  const mod = await importRepo(file);
  for (const n of ['probePlayable', 'playableOnThisHost', 'rememberPlayable', 'forgetPlayable']) pick(mod, [n], file);
  return mod;
}

export async function loadMediaTier() {
  await import(pathToFileURL(path.join(ROOT, 'src', 'testing', 'registerTs.mjs')).href);
  return importRepo('src/render/mediaTier.ts');
}

// ================================================================== K5 card sync

/**
 * Fake content store client: behaves according to `server/docservice/modules/content.mjs`
 * (`card-source` issues rev per key, increments by one on each put, last-write-wins;
 * `hash = sha256(JSON.stringify(body))`), plus `watch`. `as(actor)` gets a view written
 * under that identity; the two views share the same storage to simulate endpoints A and B.
 */
export function fakeContentService() {
  const items = new Map();
  const watchers = new Set();
  const puts = [];
  const hashOf = (body) => sha256(JSON.stringify(body));
  function as(actor) {
    return {
      actor,
      async put(kind, key, body) {
        const prev = items.get(`${kind}\n${key}`);
        const rev = (prev?.rev ?? 0) + 1;
        const hash = hashOf(body);
        items.set(`${kind}\n${key}`, { kind, key, body: structuredClone(body), hash, rev, actor });
        puts.push({ actor, kind, key, body, rev });
        const evt = { kind, key, hash, rev, previousActor: prev?.actor ?? null };
        for (const w of [...watchers]) if (w.kind === kind && w.actor !== actor) queueMicrotask(() => w.cb(structuredClone(evt)));
        return { hash, rev };
      },
      async get(kind, key) {
        const it = items.get(`${kind}\n${key}`);
        return it ? { body: structuredClone(it.body), hash: it.hash, rev: it.rev } : null;
      },
      async list(kind, prefix = '') {
        const out = [...items.values()].filter((it) => it.kind === kind && it.key.startsWith(prefix))
          .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
          .map(({ key, hash, rev }) => ({ key, hash, rev }));
        return { items: out, truncated: false };
      },
      watch(kind, cb) {
        const w = { kind, cb, actor };
        watchers.add(w);
        return () => watchers.delete(w);
      },
    };
  }
  return { as, items, puts };
}

/** Local environment for one side: records files, installed cards, backups, and notices */
export function fakeCardHost({ files = {}, scopes = {}, stateFile } = {}) {
  const local = new Map(Object.entries(files));
  const events = [];
  return {
    local, events, stateFile,
    readLocal: async (key) => (local.has(key) ? local.get(key) : null),
    install: async ({ key, body, rev }) => { events.push({ type: 'install', key, body, rev }); local.set(key, body); },
    backup: async ({ key, body }) => { events.push({ type: 'backup', key, body }); },
    notify: (msg) => { events.push({ ...msg, type: 'notify', notifyType: msg?.type }); },
    scopeOf: (key) => scopes[key] ?? 'user',
  };
}

export async function loadCardSync() {
  const file = 'server/card-sync.mjs';
  const mod = await importRepo(file);
  const create = pick(mod, ['createCardSync', 'cardSync'], file);
  // Integration reconciliation (K5): real module sends and receives content.* messages via the
  // document service connection, and reads/writes local files via files.*; here it connects to the
  // fake content store and fake local environment
  return ({ content, host }) => {
    let backups = 0;
    const s = create({
      stateDir: host.stateFile ? `${host.stateFile}.d` : null,
      files: {
        read: (rel) => host.readLocal(rel),
        changed: (rel) => host.scopeOf(rel) !== 'builtin',
        install: async (rel, body, meta) => { await host.install({ key: rel, body, rev: meta?.rev }); return { ok: true }; },
        backup: async (rel, body) => { await host.backup({ key: rel, body }); return `backup/${++backups}/${rel}`; },
      },
      connect: () => fakeContentEndpoint(content),
      // Cards modified during network disconnection and also modified in the cloud (enters "conflict
      // merge" as of 2026-10-22) trigger a `conflict` event, mapped to `card-conflict`
      notify: (e) => {
        if (e?.type === 'overwritten') host.notify({ type: 'card-overwritten', key: e.key, rev: e.rev });
        else if (e?.type === 'conflict') host.notify({ type: 'card-conflict', key: e.key, rev: e.rev, mine: e.mine, cloud: e.cloud });
      },
    });
    for (const n of ['saved', 'bind', 'idle']) assert.equal(typeof s?.[n], 'function', `an instance of createCardSync must have ${n}`);
    return {
      raw: s,
      /**
       * Local save: modifies local file first, then notifies sync (unmodified built-in cards
       * do not count; caller does not report them)
       */
      save: async (key, body) => {
        host.local.set(key, body);
        if (host.scopeOf(key) !== 'builtin') s.saved(key);
        await s.idle();
      },
      /** Open shared project: bind, wait to connect, and wait for reconciliation to complete */
      open: async () => {
        s.bind({ projectId: 'p-c66', url: 'ws://fake-docservice.invalid/', protocols: () => [], local: false, keys: [] });
        await waitFor(() => s.status().connected, { what: 'the fake connection to connect' });
        await s.idle();
      },
      close: async () => { s.close(); },
    };
  };
}

/**
 * Fake document service endpoint (`createWsEndpoint` shape from `render-node/ws-transport.mjs`),
 * forwarding content.* messages to a view of `fakeContentService`. Message and response fields
 * follow `server/docservice/modules/content.mjs`.
 */
function fakeContentEndpoint(view) {
  const on = { message: [], open: [], close: [] };
  let unwatch = null;
  let closed = false;
  const deliver = (msg) => { if (!closed) for (const cb of on.message) cb(structuredClone(msg)); };
  setTimeout(() => { if (!closed) for (const cb of on.open) cb(); }, 0);
  return {
    onMessage: (cb) => { on.message.push(cb); },
    onOpen: (cb) => { on.open.push(cb); },
    onClose: (cb) => { on.close.push(cb); },
    send(msg) {
      if (closed) return false;
      const { type, reqId, kind, key } = msg;
      void (async () => {
        if (type === 'content.watch') {
          unwatch?.();
          unwatch = view.watch('card-source', (evt) => deliver({
            type: 'content.changed', kind: evt.kind, key: evt.key, hash: evt.hash, rev: evt.rev,
            actor: null, previousActor: evt.previousActor ? { userId: evt.previousActor } : null,
          }));
          deliver({ type: 'content.watching', kinds: msg.kinds, reqId });
        } else if (type === 'content.list') {
          const r = await view.list(kind, msg.prefix ?? '');
          deliver({ type: 'content.listing', kind, items: r.items, truncated: !!r.truncated, reqId });
        } else if (type === 'content.get') {
          const it = await view.get(kind, key);
          deliver(it ? { type: 'content.item', kind, key, body: it.body, hash: it.hash, rev: it.rev, reqId } : { type: 'content.item', kind, key, missing: true, reqId });
        } else if (type === 'content.put') {
          const r = await view.put(kind, key, msg.body);
          deliver({ type: 'content.stored', kind, key, hash: r.hash, rev: r.rev, reqId });
        }
      })();
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      unwatch?.();
      for (const cb of on.close) cb({ code: 1000 });
    },
  };
}

/** Wait until pred() is true; times out and fails assertion */
export async function waitFor(pred, { timeoutMs = 3000, stepMs = 10, what = 'condition' } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > end) assert.fail(`timed out waiting for ${what} (${timeoutMs} ms)`);
    await sleep(stepMs);
  }
}
