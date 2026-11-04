/**
 * Agent path for reading assets (`docs/plan/TODO.md` "Gap between semantics and code"; semantics
 * `docs/semantics/product/agent.md` "Assets and outputs"):
 * Loudness measurement `measure_audio` (`/api/audio/measure`) and custom measurement
 * `measure_audio_js` (`/api/audio/measure-js`) fetch bytes via the asset service HTTP interface,
 * not by looking up files in the asset catalog.
 *
 * Test cases AR-1 to AR-8:
 *   AR-1  Resolver: cannot get asset service address / cannot connect / read refused →
 *         AssetSourceError (states address and reason); 404 → null; 2xx → address;
 *   AR-2  Asset record → address (audioMediaUrl in vite-plugin-audio.ts): hash, filename, legacy
 *         absolute path, export directory; path in request body is not used to read from disk;
 *   -- Below starts real asset service (server/asset-service.ts + media middleware, fs content store)
 *      and real ffmpeg --
 *   AR-3  Loudness measurement: three tiers (asset / clip / timeline), responses fetched via asset
 *         service match reading file directly (pre-change behavior) verbatim; path in asset record
 *         points to a non-existent directory (asset catalog unreadable), still yields results as
 *         usual; asset service was indeed requested (Range);
 *   AR-4  Custom measurement: decoded PCM is byte-for-byte identical to direct file reading (single
 *         file, clip window, timeline mix, mono); results via sandbox measureJs are identical;
 *   AR-5  Large files and segmented fetching: ~35 MB wav (stored as 5 chunks), clip tier measures
 *         2 seconds at 150 seconds, bytes transmitted via asset service are far fewer than the
 *         entire file;
 *   AR-6  Asset service unreachable: loudness measurement returns 502 with error stating reason,
 *         custom measurement returns kind asset-service; timeline tier is not treated as "skipped";
 *   AR-7  Asset missing on asset service (404): still "asset file does not exist" / no-media,
 *         timeline tier skips that segment;
 *   AR-8  Single-process mode: asset service is in the same process, ffprobe runs asynchronously
 *         without blocking event loop (timers in this process continue ticking normally during
 *         measurement).
 *
 * Run: node --test server/test/audio-asset-path.test.mjs (requires ffmpeg; skips from AR-3 onward if
 * not found)
 */
import assert from 'node:assert/strict';
import { test, before, after } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createAssetHarness, ROOT } from './fake-asset-service.mjs';
import { AssetSourceError, createAssetSourceResolver, hasAudioStreamAsync, probeAudioChannelsAsync } from '../audio-source.mjs';
import { measureLoudness } from '../audio-loudness.mjs';
import { measureJs } from '../audio-measure-js.mjs';
import { filePcmArgs, timelinePcmArgs, decodePcm } from '../audio-pcm.mjs';
import { createAudioSandbox } from '../audio-sandbox.mjs';
import { findFfmpeg } from '../ai-visual.mjs';

const harness = createAssetHarness();
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-audio-asset-path-'));
after(async () => { await harness.cleanup(); fs.rmSync(TMP, { recursive: true, force: true }); });

const listen = (handler) => new Promise((resolve) => {
  const s = http.createServer(handler);
  s.listen(0, '127.0.0.1', () => resolve({ server: s, origin: `http://127.0.0.1:${s.address().port}` }));
});
const closeServer = (s) => new Promise((resolve) => { s.closeAllConnections?.(); s.close(() => resolve()); });

/* ------------------------------------------------------------------ AR-1 / AR-2 */

test('AR-1 resolver: unreachable, refused, 404 and 2xx are told apart', async () => {
  const toUrl = (m, o) => (m?.hash ? `${o}/@media/${m.hash}` : null);
  // Cannot resolve address
  const noOrigin = createAssetSourceResolver({ origin: () => null, toUrl });
  await assert.rejects(noOrigin({ hash: 'a' }), (e) => e instanceof AssetSourceError && /cannot get the asset service address/.test(e.message));
  // Cannot connect: open a port then close it
  const gone = await listen(() => {});
  await closeServer(gone.server);
  const refused = createAssetSourceResolver({ origin: () => gone.origin, toUrl });
  await assert.rejects(refused({ hash: 'a' }), (e) => e instanceof AssetSourceError && e.message.includes(`Asset service unreachable (${gone.origin})`));
  // Timeout
  const hang = await listen(() => { /* Does not respond */ });
  const slow = createAssetSourceResolver({ origin: () => hang.origin, toUrl, timeoutMs: 300 });
  await assert.rejects(slow({ hash: 'a' }), (e) => e instanceof AssetSourceError && /No response/.test(e.message));
  await closeServer(hang.server);
  // 404 / 401 / 206
  const seen = [];
  const svc = await listen((req, res) => {
    seen.push({ url: req.url, range: req.headers.range });
    if (req.url.endsWith('/missing')) { res.statusCode = 404; return res.end('Not found'); }
    if (req.url.endsWith('/locked')) { res.statusCode = 401; return res.end('ticket'); }
    res.writeHead(206, { 'Content-Range': 'bytes 0-0/10', 'Content-Length': 1 }); res.end('x');
  });
  const r = createAssetSourceResolver({ origin: () => svc.origin, toUrl });
  assert.equal(await r({ hash: 'missing' }), null);
  await assert.rejects(r({ hash: 'locked' }), (e) => e instanceof AssetSourceError && /refused the read.*HTTP 401/.test(e.message));
  assert.equal(await r({ hash: 'ok' }), `${svc.origin}/@media/ok`);
  assert.equal(await r({}), null, 'cannot build the URL');
  assert.ok(seen.every((s) => s.range === 'bytes=0-0'), 'probes only 1 byte');
  await closeServer(svc.server);
});

test('AR-2 media record → URL on the asset service; the path in the request body is not used to read from disk', async () => {
  let mod;
  try {
    mod = await import(harness.compileTs(path.join(ROOT, 'server', 'vite-plugin-audio.ts')));
  } catch (e) {
    assert.fail('failed to transpile vite-plugin-audio.ts:' + (e?.message || e));
  }
  const o = 'http://127.0.0.1:9';
  const h = 'ab'.repeat(32);
  assert.equal(mod.audioMediaUrl({ hash: h, path: 'C:\\Windows\\win.ini' }, o), `${o}/@media/${h}`);
  assert.equal(mod.audioMediaUrl({ url: `/@media/${h}.wav` }, o), `${o}/@media/${h}.wav`);
  assert.equal(mod.audioMediaUrl({ url: '/@media/%E9%85%8D%E4%B9%90.mp3' }, o), `${o}/@media/${encodeURIComponent('配乐.mp3')}`);
  // Only an absolute path remains: takes only filename, cannot point outside asset service storage
  assert.equal(mod.audioMediaUrl({ path: 'D:\\secret\\x.wav' }, o), `${o}/@media/x.wav`);
  const legacy = '/api/media/file?path=C%3A%2FUsers%2Fu%2Fa.wav';
  assert.equal(mod.audioMediaUrl({ url: legacy }, o), `${o}${legacy}`);
  assert.equal(mod.audioMediaUrl({ url: '/@export/job1/media/a.wav' }, o), `${o}/@export/job1/media/a.wav`);
  assert.equal(mod.audioMediaUrl({ url: 'blob:http://x/1' }, o), null);
});

/* ------------------------------------------------------------------ Real asset service + ffmpeg */

const FFMPEG = findFfmpeg();
const FFPROBE = FFMPEG ? path.join(path.dirname(FFMPEG), 'ffprobe' + path.extname(FFMPEG)) : null;
const skip = FFMPEG ? false : 'ffmpeg not found';

const gen = (out, lavfiArgs, codecArgs) => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...lavfiArgs, ...codecArgs, out], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  return out;
};

/** Start asset service (fs content store) with a counting forwarder in front: counts requests and transmitted bytes; stop() simulates unreachable */
async function startService() {
  const asset = await harness.asset();
  const svc = await harness.serve({ stores: 'default' });
  const stats = { requests: [], bytes: 0 };
  const front = await listen((req, res) => {
    const up = http.request(new URL(req.url, svc.origin), { method: req.method, headers: req.headers }, (r) => {
      stats.requests.push({ method: req.method, url: req.url, range: req.headers.range || null, status: r.statusCode });
      res.writeHead(r.statusCode, r.headers);
      // Count bytes actually delivered to client; when client (ffmpeg) disconnects after reading enough,
      // upstream connection also closes
      r.on('data', (d) => { if (!res.destroyed) stats.bytes += d.length; });
      res.on('close', () => r.destroy());
      r.pipe(res);
    });
    up.on('error', () => { res.statusCode = 502; res.end(); });
    req.pipe(up);
  });
  const upload = async (file) => {
    const buf = fs.readFileSync(file);
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const size = buf.length;
    const cs = asset.ASSET_CHUNK_SIZE;
    const count = Math.max(1, Math.ceil(size / cs));
    for (let n = 0; n < count; n++) {
      const r = await fetch(`${svc.base}/media/${hash}/${n}`, { method: 'PUT', body: buf.subarray(n * cs, Math.min(size, (n + 1) * cs)), headers: asset.chunkHeaders(size, path.basename(file)) });
      assert.equal(r.status, 200, `chunk ${n}`);
    }
    assert.equal((await fetch(`${svc.base}/media/${hash}/complete`, { method: 'POST' })).status, 200);
    return { hash, count };
  };
  return {
    origin: front.origin, stats, upload, contentRoot: svc.root,
    reset() { stats.requests.length = 0; stats.bytes = 0; },
    async stop() { await closeServer(front.server); await svc.close(); },
  };
}

let service;
const files = {};
const hashes = {};
if (FFMPEG) {
  const noise = (d) => ['-f', 'lavfi', '-i', `anoisesrc=color=pink:amplitude=0.3:duration=${d}:sample_rate=48000:seed=7`, '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${d}`];
  const mixStereo = ['-filter_complex', '[0:a][1:a]amix=inputs=2:normalize=0,volume=0.8,aformat=channel_layouts=stereo[a]', '-map', '[a]'];
  files.wav = gen(path.join(TMP, 'voice.wav'), noise(6), [...mixStereo, '-c:a', 'pcm_s16le']);
  files.mp3 = gen(path.join(TMP, 'music.mp3'), noise(6), [...mixStereo, '-c:a', 'libmp3lame', '-b:a', '160k']);
  files.m4a = gen(path.join(TMP, 'amb.m4a'), noise(6), [...mixStereo, '-c:a', 'aac', '-b:a', '128k']);
  files.mono = gen(path.join(TMP, 'mono.wav'), ['-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=44100:duration=5'], ['-c:a', 'pcm_s16le']);
  files.mp4 = gen(path.join(TMP, 'clip.mp4'), ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=5', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=5'], ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest']);
  files.silent = gen(path.join(TMP, 'silent.mp4'), ['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=25:d=2'], ['-c:v', 'libx264', '-pix_fmt', 'yuv420p']);
  // Large file: 3 minutes 48 kHz stereo s16 ~ 34.6 MB, stored in 5 chunks
  files.big = gen(path.join(TMP, 'long.wav'), noise(180), [...mixStereo, '-c:a', 'pcm_s16le']);
}
before(async () => {
  if (!FFMPEG) return;
  service = await startService();
  for (const [k, f] of Object.entries(files)) hashes[k] = (await service.upload(f)).hash;
});
after(() => service?.stop());

/** Asset record in project: path points to a non-existent directory (asset catalog unreadable), only hash / url are usable */
const GONE = path.join(TMP, 'nonexistent-asset-dir');
const mediaOf = (k) => ({ id: `m-${k}`, name: path.basename(files[k]), url: `/@media/${hashes[k]}${path.extname(files[k])}`, hash: hashes[k], path: path.join(GONE, path.basename(files[k])) });
const viaService = () => createAssetSourceResolver({ origin: () => service.origin, toUrl: (m, o) => `${o}/@media/${m.hash}` });
/** Pre-change read method: pass local file path directly (what mediaFileOf originally returned) */
const direct = (m) => files[Object.keys(files).find((k) => hashes[k] === m?.hash)] ?? null;

test('AR-3 loudness measurement: for all three tiers the response body through the asset service is identical character for character to the one read from the file directly; results still come out when the asset catalog is unreadable', { skip, timeout: 180_000 }, async () => {
  assert.equal(fs.existsSync(GONE), false);
  const bodies = [
    ...['wav', 'mp3', 'm4a', 'mono', 'mp4'].map((k) => ({ scope: 'media', media: mediaOf(k), series: true })),
    { scope: 'media', media: mediaOf('mp3'), series: false },
    { scope: 'clip', media: mediaOf('m4a'), offset: 1.25, duration: 3.5, series: true },
    { scope: 'clip', media: mediaOf('mp4'), offset: 0.5, duration: 2 },
    // All clips in the timeline tier are placed at the end of the timeline: when one clip ends first,
    // ffmpeg 9 amix occasionally gives subsequent frames NOPTS timestamps (ebur128 outputs
    // t: -192153584101141.06, i.e. INT64_MIN / 48000), and the per-second curve misses points after that.
    // This is an occasional issue present before the change, unrelated to the read method, see report.
    {
      scope: 'timeline', duration: 7, entries: [
        { clipId: 'c1', media: mediaOf('wav'), start: 2, dur: 5, offset: 1, volume: 1, fadeIn: 0.5, fadeOut: 0 },
        { clipId: 'c2', media: mediaOf('mp3'), start: 1.5, dur: 5.5, offset: 0.2, volume: 0.6, fadeIn: 0, fadeOut: 1 },
        { clipId: 'c3', media: mediaOf('mono'), start: 2, dur: 5, offset: 0, volume: 1.2, fadeIn: 0, fadeOut: 0 },
        { clipId: 'c4', media: mediaOf('silent'), start: 0, dur: 2, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
      ],
    },
  ];
  for (const body of bodies) {
    const before = await measureLoudness({ body, resolveSource: direct, ffmpeg: FFMPEG, ffprobe: FFPROBE });
    service.reset();
    const now = await measureLoudness({ body, resolveSource: viaService(), ffmpeg: FFMPEG, ffprobe: FFPROBE });
    const label = `${body.scope} ${body.media?.name ?? 'timeline'}`;
    assert.equal(before.status, 200, JSON.stringify(before.body));
    assert.equal(JSON.stringify(now), JSON.stringify(before), `${label}: response body identical character for character`);
    assert.ok(typeof now.body.integrated === 'number', `${label}: has a loudness value`);
    const got = service.stats.requests.filter((r) => r.url.startsWith('/@media/') && r.method === 'GET');
    assert.ok(got.length >= 2, `${label}: bytes were fetched through the asset service (${got.length} times)`);
  }
});

test('AR-4 custom measurement: the decoded PCM is byte-for-byte identical to reading the file directly; the result through the sandbox is the same', { skip, timeout: 180_000 }, async () => {
  const resolve = viaService();
  const same = async (label, argsOf, fmt) => {
    const a = await decodePcm(FFMPEG, argsOf((k) => files[k]), fmt);
    const b = await decodePcm(FFMPEG, argsOf((k) => `${service.origin}/@media/${hashes[k]}`), fmt);
    assert.ok(a[0].length > 0, `${label}: has samples`);
    assert.equal(a.length, b.length, `${label}: channel count`);
    for (let c = 0; c < a.length; c++) assert.ok(Buffer.from(a[c].buffer).equals(Buffer.from(b[c].buffer)), `${label}: channel ${c} is byte-for-byte identical`);
  };
  await same('media wav', (src) => filePcmArgs({ file: src('wav'), sampleRate: 16000, channels: 2 }), { channels: 2, sampleRate: 16000 });
  await same('clip mp3 window', (src) => filePcmArgs({ file: src('mp3'), offset: 1.7, duration: 2.2, sampleRate: 48000, channels: 2 }), { channels: 2, sampleRate: 48000 });
  await same('clip m4a mono', (src) => filePcmArgs({ file: src('m4a'), offset: 0.3, duration: 4, sampleRate: 22050, channels: 1, sourceChannels: 2 }), { channels: 1, sampleRate: 22050 });
  await same('mp4 audio track', (src) => filePcmArgs({ file: src('mp4'), sampleRate: 16000, channels: 2 }), { channels: 2, sampleRate: 16000 });
  const entries = (src) => [
    { file: src('wav'), start: 0, dur: 4, offset: 1, volume: 1, fadeIn: 0.5, fadeOut: 0 },
    { file: src('mono'), start: 1.5, dur: 3, offset: 0.5, volume: 0.7, fadeIn: 0, fadeOut: 0.8 },
  ];
  await same('timeline mix window', (src) => timelinePcmArgs(entries(src), { total: 5, offset: 0.5, duration: 3, sampleRate: 16000, channels: 2 }), { channels: 2, sampleRate: 16000 });
  await same('timeline mix mono', (src) => timelinePcmArgs(entries(src), { total: 5, sampleRate: 8000, channels: 1 }), { channels: 1, sampleRate: 8000 });

  // Full measureJs (calculating PCM fingerprint in sandbox): via asset service yields identical
  // results to reading the file directly
  const sandbox = createAudioSandbox();
  try {
    const FNV = `
      let h = 2166136261 >>> 0;
      for (const x of input.channels) { const u = new Uint8Array(x.buffer, x.byteOffset, x.byteLength); for (let i = 0; i < u.length; i++) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; } }
      return { h, frames: input.frames, ch: input.channels.length };
    `;
    const cases = [
      { scope: 'media', media: mediaOf('wav'), code: FNV },
      { scope: 'clip', media: mediaOf('mp3'), offset: 1, duration: 3, start: 0.5, length: 1.5, sampleRate: 44100, code: FNV },
      { scope: 'timeline', total: 5, entries: [
        { clipId: 'c1', media: mediaOf('m4a'), start: 0, dur: 3, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
        { clipId: 'c2', media: mediaOf('mono'), start: 2, dur: 3, offset: 1, volume: 0.5, fadeIn: 0.2, fadeOut: 0 },
      ], mono: true, code: FNV },
    ];
    for (const body of cases) {
      const a = await measureJs({ body, resolveSource: direct, ffmpeg: FFMPEG, ffprobe: FFPROBE, sandbox });
      service.reset();
      const b = await measureJs({ body, resolveSource: resolve, ffmpeg: FFMPEG, ffprobe: FFPROBE, sandbox });
      assert.equal(a.body.ok, true, JSON.stringify(a.body));
      const strip = (r) => { const { elapsedMs, ...rest } = r.body; return rest; };
      assert.deepEqual(strip(b), strip(a), `${body.scope}: result is the same`);
      assert.ok(service.stats.requests.some((r) => r.url.startsWith('/@media/') && r.method === 'GET' && r.range !== 'bytes=0-0'), `${body.scope}: ffmpeg fetched bytes through the asset service`);
    }
  } finally {
    await sandbox.close();
  }
});

test('AR-5 large files and fetching in parts: the clip tier fetches only the parts it needs', { skip, timeout: 180_000 }, async (t) => {
  const size = fs.statSync(files.big).size;
  assert.ok(size > 4 * 8 * 1024 * 1024, `large file of ${size} bytes, more than 4 chunks`);
  const body = { scope: 'clip', media: mediaOf('big'), offset: 150, duration: 2, series: true };
  const before = await measureLoudness({ body, resolveSource: direct, ffmpeg: FFMPEG, ffprobe: FFPROBE });
  service.reset();
  const now = await measureLoudness({ body, resolveSource: viaService(), ffmpeg: FFMPEG, ffprobe: FFPROBE });
  assert.equal(JSON.stringify(now), JSON.stringify(before));
  const ranged = service.stats.requests.filter((r) => r.range && r.range !== 'bytes=0-0');
  assert.ok(ranged.length >= 1, 'ffmpeg seeks using Range:' + JSON.stringify(service.stats.requests));
  // Requests may be open ranges (bytes=N-), and ffmpeg disconnects once it has read enough; the
  // actual transferred bytes are far fewer than the entire file
  t.diagnostic(`file ${size} bytes; ${service.stats.bytes} bytes transferred through the asset service; requests ${JSON.stringify(service.stats.requests.map((r) => r.range))}`);
  assert.ok(service.stats.bytes < size / 4, `${service.stats.bytes} bytes transferred through the asset service, file ${size} bytes`);

  // Custom measurement of the same clip: PCM is byte-for-byte identical
  const args = (src) => filePcmArgs({ file: src, offset: 150, duration: 2, sampleRate: 48000, channels: 2 });
  const a = await decodePcm(FFMPEG, args(files.big), { channels: 2, sampleRate: 48000 });
  const b = await decodePcm(FFMPEG, args(`${service.origin}/@media/${hashes.big}`), { channels: 2, sampleRate: 48000 });
  assert.ok(Buffer.from(a[0].buffer).equals(Buffer.from(b[0].buffer)) && Buffer.from(a[1].buffer).equals(Buffer.from(b[1].buffer)));
});

test('AR-6 asset service unreachable: respond with an error that states the cause, and do not treat it as file not found or skipped', { skip, timeout: 60_000 }, async () => {
  const gone = await listen(() => {});
  await closeServer(gone.server);
  const resolve = createAssetSourceResolver({ origin: () => gone.origin, toUrl: (m, o) => `${o}/@media/${m.hash}` });
  const m = await measureLoudness({ body: { scope: 'media', media: mediaOf('wav') }, resolveSource: resolve, ffmpeg: FFMPEG, ffprobe: FFPROBE });
  assert.equal(m.status, 502);
  assert.equal(m.body.ok, false);
  assert.ok(m.body.error.includes(`Asset service unreachable (${gone.origin})`), m.body.error);
  const t = await measureLoudness({ body: { scope: 'timeline', duration: 3, entries: [{ clipId: 'c1', media: mediaOf('wav'), start: 0, dur: 3, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 }] }, resolveSource: resolve, ffmpeg: FFMPEG, ffprobe: FFPROBE });
  assert.equal(t.status, 502, 'the timeline tier is not treated as "skipped"');
  let ran = 0;
  const sandbox = { run: async () => { ran += 1; return { ok: true, value: 1 }; } };
  const j = await measureJs({ body: { scope: 'media', media: mediaOf('wav'), code: 'return 1' }, resolveSource: resolve, ffmpeg: FFMPEG, ffprobe: FFPROBE, sandbox });
  assert.equal(j.body.ok, false);
  assert.equal(j.body.kind, 'asset-service');
  assert.match(j.body.error, /Asset service unreachable/);
  const noOrigin = createAssetSourceResolver({ origin: () => null, toUrl: () => 'x' });
  const k = await measureJs({ body: { scope: 'timeline', entries: [{ media: mediaOf('wav') }], code: 'return 1' }, resolveSource: noOrigin, ffmpeg: FFMPEG, ffprobe: FFPROBE, sandbox });
  assert.equal(k.body.kind, 'asset-service');
  assert.equal(ran, 0);
});

test('AR-7 the asset service does not have this media: still "media file does not exist", and the timeline tier skips that segment', { skip, timeout: 60_000 }, async () => {
  const ghost = { id: 'g', name: '没入库.wav', hash: 'ee'.repeat(32), path: files.wav };
  const r = await measureLoudness({ body: { scope: 'media', media: ghost }, resolveSource: viaService(), ffmpeg: FFMPEG, ffprobe: FFPROBE });
  assert.deepEqual(r, { status: 400, body: { ok: false, error: 'Media file does not exist' } }, 'does not read the file even if path points to a real existing file');
  const s = await measureLoudness({ body: { scope: 'media', media: mediaOf('silent') }, resolveSource: viaService(), ffmpeg: FFMPEG, ffprobe: FFPROBE });
  assert.deepEqual(s, { status: 400, body: { ok: false, error: 'This file has no audio stream' } });
  const t = await measureLoudness({ body: { scope: 'timeline', duration: 3, entries: [
    { clipId: 'c1', media: ghost, start: 0, dur: 3, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
    { clipId: 'c2', media: mediaOf('wav'), start: 0, dur: 3, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
  ] }, resolveSource: viaService(), ffmpeg: FFMPEG, ffprobe: FFPROBE });
  assert.equal(t.status, 200);
  assert.ok(t.body.notes.some((n) => n.includes('没入库.wav')), JSON.stringify(t.body.notes));
  const j = await measureJs({ body: { scope: 'media', media: ghost, code: 'return 1' }, resolveSource: viaService(), ffmpeg: FFMPEG, ffprobe: FFPROBE, sandbox: { run: async () => ({ ok: true }) } });
  assert.equal(j.body.kind, 'no-media');
});

test('AR-8 single-process setup: the asset service runs in this process, ffprobe is async, and the event loop keeps turning as usual', { skip, timeout: 60_000 }, async () => {
  const url = `${service.origin}/@media/${hashes.mp3}`;
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  const t0 = Date.now();
  try {
    assert.equal(await hasAudioStreamAsync(url, FFPROBE), true);
    assert.equal(await probeAudioChannelsAsync(url, FFPROBE), 2);
    assert.equal(await hasAudioStreamAsync(`${service.origin}/@media/${hashes.silent}`, FFPROBE), false);
  } finally {
    clearInterval(timer);
  }
  const ms = Date.now() - t0;
  assert.ok(ms < 10_000, `three probes took ${ms} ms (a synchronous call would wait for the 15 s timeout)`);
  assert.ok(ticks >= 1, 'timer ticked');
});
