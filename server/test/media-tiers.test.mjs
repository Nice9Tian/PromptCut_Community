// C6.6 two-tier assets and upload queue (`docs/plan/c66-design.md` sections 2 and 3, acceptance checks T1-T3).
// Run: node --test server/test/media-tiers.test.mjs
//
// The asset plugin is .ts: like asset-service.test, transpiled with typescript to a temp dir before
// import, and sibling modules it lazy-imports (media-tiers, upload-queue, bandwidth-gate,
// bakery/ffmpeg, asset-store/client) are replaced with absolute paths in the repo.
// Test assets are always generated on the fly with ffmpeg (section 8 "Test assets").
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-media-tiers-'));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

delete process.env.PROMPTCUT_EXPORT_DIR;
delete process.env.PROMPTCUT_MEDIA_DIR;
delete process.env.PROMPTCUT_EDITOR_URL;
delete process.env.PROMPTCUT_ASSET_URL;
delete process.env.PROMPTCUT_HEADLESS;

/** Fake client in T3 does not read files; resolveFile only needs to return an existing path */
const HERE = fileURLToPath(import.meta.url);
const ffmpegOk = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
const serverUrl = (rel) => pathToFileURL(path.join(ROOT, 'server', rel)).href;

function compile(srcRel, outName, replaces = []) {
  let src = fs.readFileSync(path.join(ROOT, srcRel), 'utf8');
  for (const [a, b] of replaces) src = src.split(a).join(b);
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const file = path.join(OUT, outName);
  fs.writeFileSync(file, js);
  return pathToFileURL(file).href;
}

const media = await import(compile('server/vite-plugin-media.ts', 'media.mjs', [
  ['"./media-tiers.mjs"', `"${serverUrl('media-tiers.mjs')}"`],
  ['"./upload-queue.mjs"', `"${serverUrl('upload-queue.mjs')}"`],
  ['"./bandwidth-gate.mjs"', `"${serverUrl('bandwidth-gate.mjs')}"`],
  ['"./bakery/ffmpeg.mjs"', `"${serverUrl('bakery/ffmpeg.mjs')}"`],
  ['"./asset-store/client.mjs"', `"${serverUrl('asset-store/client.mjs')}"`],
]));
const asset = await import(compile('server/asset-service.ts', 'asset-service.mjs', [
  ['from "./http-guard.mjs"', `from "${serverUrl('http-guard.mjs')}"`],
  ['from "./vite-plugin-media"', 'from "./media.mjs"'],
  ['from "./asset-store/index.mjs"', `from "${serverUrl('asset-store/index.mjs')}"`],
]));
const tiers = await import(serverUrl('media-tiers.mjs'));
const uq = await import(serverUrl('upload-queue.mjs'));
const gateMod = await import(serverUrl('bandwidth-gate.mjs'));
const { createAssetClient } = await import(serverUrl('asset-store/client.mjs'));

/* ---------------- Environment ---------------- */

function serviceHandler(root) {
  const a = asset.assetServiceMiddleware(root);
  const m = media.mediaMiddleware(root);
  return (req, res) => { void a(req, res, () => { void m(req, res, () => { res.statusCode = 404; res.end('no route'); }); }); };
}
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => { server.closeAllConnections?.(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

/**
 * Disconnection injection: proxy between uploader and remote asset service. When `offline` is
 * true, sever connection directly (no forwarding); each request logs a line of
 * `{ method, path, auth, dropped }`. When `dropWhen(req)` returns true, disconnect starting from
 * this request.
 */
async function flakyProxy(target) {
  const t = new URL(target);
  const state = { offline: false, log: [], dropWhen: null };
  const origin = await listen((req, res) => {
    const entry = { method: req.method, path: req.url, auth: req.headers.authorization ?? null, dropped: false };
    state.log.push(entry);
    if (!state.offline && state.dropWhen?.(req)) state.offline = true;
    if (state.offline) { entry.dropped = true; req.socket.destroy(); return; }
    const up = http.request({ hostname: t.hostname, port: t.port, method: req.method, path: req.url, headers: { ...req.headers, host: t.host } }, (r) => {
      res.writeHead(r.statusCode || 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  return { origin, state };
}

const ff = (args) => {
  const r = spawnSync('ffmpeg', ['-y', '-hide_banner', '-v', 'error', ...args], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr}`);
};
const probe = (file) => {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { windowsHide: true, encoding: 'utf8' });
  return JSON.parse(r.stdout);
};
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const fixtures = path.join(OUT, 'fixtures');
fs.mkdirSync(fixtures, { recursive: true });
/** 1080p, with audio track, moov at the end (ffmpeg's default when writing MP4), ~17 MB (3 chunks) */
const LATE_1080 = path.join(fixtures, 'late-1080.mp4');
const PRORES = path.join(fixtures, 'prores.mov');
const FASTSTART = path.join(fixtures, 'fast.mp4');
const HDR = path.join(fixtures, 'hdr-pq.mp4');
if (ffmpegOk) {
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '4', '-pix_fmt', 'yuv420p', '-c:a', 'aac', LATE_1080]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '2', '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-an', PRORES]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '1', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', FASTSTART]);
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30', '-t', '1', '-vf', 'format=yuv420p10le,setparams=color_primaries=bt2020:color_trc=smpte2084:colorspace=bt2020nc:range=tv',
    '-c:v', 'libx264', '-x264-params', 'colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc', HDR]);
}

async function importFile(origin, file, name = path.basename(file), query = '?tiers=1') {
  const res = await fetch(`${origin}/api/media/upload/${encodeURIComponent(name)}${query}`, { method: 'POST', body: fs.readFileSync(file) });
  assert.equal(res.status, 200, await res.clone().text());
  return res.json();
}
const chunksOf = async (base, hash) => (await fetch(`${base}/media/${hash}/chunks`)).json();

/** Only these fields allowed in response: sync status (whether upload finished) not in response or project */
const RESPONSE_KEYS = new Set(['ok', 'hash', 'ext', 'name', 'path', 'url', 'bytes', 'deduped', 'tiers', 'small', 'remux']);
const SYNC_WORDS = /upload|sync|complete|received|progress|queued/i;

/* ======================================================================== *
 * T1: import 1080p video → small-size asset ≤ 800×600, H.264, faststart;
 * original-size asset encoding unchanged; tiers two hashes
 * ======================================================================== */

const rootA = path.join(OUT, 'importer');
fs.mkdirSync(media.mediaDir(rootA), { recursive: true });
const originA = await listen(serviceHandler(rootA));

test('T1-1 import a 1080p MP4 with a late moov: the asset original size is remuxed as faststart (codec unchanged, stored by output hash), the asset small size is 800×450 H.264 faststart; when connected to the local asset service the queue is a no-op', { skip: !ffmpegOk && 'No ffmpeg' }, async () => {
  const srcHash = sha256File(LATE_1080);
  assert.equal(await tiers.faststartState(LATE_1080), 'needs', 'The test asset itself should lack faststart');
  const body = await importFile(originA, LATE_1080);
  assert.equal(body.remux.state, 'remuxed');
  assert.equal(body.remux.from, srcHash);
  assert.notEqual(body.hash, srcHash, 'The remux result is a new asset original size, with a different hash');
  assert.equal(body.tiers.original, body.hash);
  assert.ok(['pending', 'ready'].includes(body.small));
  for (const key of Object.keys(body)) assert.ok(RESPONSE_KEYS.has(key), `The response has an extra field ${key}`);

  const service = await media.mediaTierService(rootA);
  await service.manager.idle();
  const st = await (await fetch(`${originA}/api/media/tiers?hashes=${body.hash}`)).json();
  const rec = st.items[body.hash];
  assert.equal(rec.state, 'ready');
  assert.match(rec.small, /^[0-9a-f]{64}$/);

  // Original-size asset: what is in library is remuxed, moov in front, stream codecs match source file
  // one by one
  const orig = path.join(media.mediaDir(rootA), `${body.hash}.mp4`);
  assert.equal(sha256File(orig), body.hash);
  assert.equal(await tiers.faststartState(orig), 'faststart');
  const a = probe(LATE_1080), b = probe(orig);
  assert.deepEqual(b.streams.map((s) => `${s.codec_type}:${s.codec_name}:${s.width ?? ''}x${s.height ?? ''}`), a.streams.map((s) => `${s.codec_type}:${s.codec_name}:${s.width ?? ''}x${s.height ?? ''}`));
  // Copy prior to remuxing is not kept in the library
  assert.equal((await fetch(`${originA}/@media/${srcHash}`)).status, 404);

  // Small-size asset: ≤ 800×600, H.264, faststart, AAC
  const small = path.join(media.mediaDir(rootA), `${rec.small}.mp4`);
  const sp = probe(small);
  const v = sp.streams.find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'h264');
  assert.ok(v.width <= 800 && v.height <= 600, `${v.width}x${v.height}`);
  assert.deepEqual([v.width, v.height], [800, 450]);
  assert.equal(sp.streams.find((s) => s.codec_type === 'audio')?.codec_name, 'aac');
  assert.equal(await tiers.faststartState(small), 'faststart');

  // Connect to local asset service: both tiers already complete on local asset service,
  // nothing entered upload queue
  assert.equal((await chunksOf(`${originA}/api/asset`, body.hash)).complete, true);
  assert.equal((await chunksOf(`${originA}/api/asset`, rec.small)).complete, true);
  const q = await (await fetch(`${originA}/api/media/upload-queue`)).json();
  assert.equal(q.target, null);
  assert.equal(q.queue.items.length, 0);
  assert.ok(q.queue.skippedLocal >= 1);

  // Import same file once more: reuse result of previous remux, hashes match
  const again = await importFile(originA, LATE_1080, 'again.mp4');
  assert.equal(again.hash, body.hash);
  assert.equal(again.remux.reused, true);
  assert.equal(again.tiers.small, rec.small);
});

test('T1-2 ProRes MOV: the asset original size is still ProRes (only a same-container remux is done), and the asset small size is H.264', { skip: !ffmpegOk && 'No ffmpeg' }, async () => {
  const body = await importFile(originA, PRORES);
  assert.equal(body.ext, 'mov');
  assert.ok(['remuxed', 'faststart'].includes(body.remux.state), JSON.stringify(body.remux));
  const service = await media.mediaTierService(rootA);
  await service.manager.idle();
  const rec = service.manager.status([body.hash])[body.hash];
  assert.equal(rec.state, 'ready');
  const orig = path.join(media.mediaDir(rootA), `${body.hash}.mov`);
  assert.equal(probe(orig).streams[0].codec_name, 'prores');
  assert.equal(await tiers.faststartState(orig), 'faststart');
  const v = probe(path.join(media.mediaDir(rootA), `${rec.small}.mp4`)).streams.find((s) => s.codec_type === 'video');
  assert.equal(v.codec_name, 'h264');
  assert.deepEqual([v.width, v.height], [640, 360], 'No upscaling');
  // Can still generate without audio tracks (-map 0:a:0?)
  assert.equal(probe(path.join(media.mediaDir(rootA), `${rec.small}.mp4`)).streams.some((s) => s.codec_type === 'audio'), false);
});

test('T1-3 an MP4 that is already faststart is not remuxed, and its hash is the sha256 of the source file', { skip: !ffmpegOk && 'No ffmpeg' }, async () => {
  const body = await importFile(originA, FASTSTART);
  assert.equal(body.remux.state, 'faststart');
  assert.equal(body.hash, sha256File(FASTSTART));
});

test('T1-4 applies to video only: importing images and audio carries no tiers and queues no asset small size', { skip: !ffmpegOk && 'No ffmpeg' }, async () => {
  const png = path.join(fixtures, 'still.png');
  const m4a = path.join(fixtures, 'tone.m4a');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240', '-frames:v', '1', png]);
  ff(['-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '1', '-c:a', 'aac', m4a]);
  for (const f of [png, m4a]) {
    const body = await importFile(originA, f);
    assert.equal('tiers' in body, false, path.basename(f));
    assert.equal(body.hash, sha256File(f));
    const service = await media.mediaTierService(rootA);
    assert.equal(service.manager.status([body.hash])[body.hash].state, 'unknown');
  }
  // Legacy calls without tiers=1 (.procp restore, voiceover) behavior unchanged: no remuxing
  const plain = await importFile(originA, LATE_1080, 'plain.mp4', '');
  assert.equal(plain.hash, sha256File(LATE_1080));
  assert.equal('tiers' in plain, false);
});

test('T1-5 HDR (BT.2020 + PQ tags complete) takes the zscale + tonemap branch, and the asset small size is tagged BT.709', { skip: !ffmpegOk && 'No ffmpeg' }, async () => {
  const info = await tiers.probeMedia('ffprobe', HDR);
  assert.equal(tiers.isHdrPq(info.video), true);
  assert.match(tiers.smallVideoFilter({ hdr: true, video: info.video }), /zscale=tin=smpte2084:pin=bt2020.*tonemap=tonemap=hable/);
  assert.doesNotMatch(tiers.smallVideoFilter({ hdr: false }), /tonemap/);
  const out = path.join(OUT, 'hdr-small.mp4');
  const r = await tiers.makeSmallVersion({ ffmpeg: 'ffmpeg', input: HDR, output: out });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.hdr, true);
  const v = probe(out).streams[0];
  assert.deepEqual([v.codec_name, v.pix_fmt, v.color_primaries, v.color_transfer, v.width, v.height], ['h264', 'yuv420p', 'bt709', 'bt709', 800, 450]);
  // SDR source does not take this branch
  assert.equal(tiers.isHdrPq((await tiers.probeMedia('ffprobe', FASTSTART)).video), false);
});

test('T1-6 asset small size command: VFR is preserved and only frames with an interval shorter than 1/60 s are dropped (120 fps → 60 fps, 30 fps loses no frames)', { skip: !ffmpegOk && 'No ffmpeg' }, async () => {
  const hi = path.join(fixtures, 'hi120.mp4');
  ff(['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=120', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', hi]);
  const out = path.join(OUT, 'hi-small.mp4');
  assert.equal((await tiers.makeSmallVersion({ ffmpeg: 'ffmpeg', input: hi, output: out })).ok, true);
  assert.equal(Number(probe(out).streams[0].nb_frames), 120);
  const args = tiers.smallVideoArgs('in', 'out');
  for (const want of ['-map', '0:a:0?', '-fps_mode:v', 'vfr', 'libx264', 'veryfast', '26', '64k', '+faststart']) assert.ok(args.includes(want), want);
  const out30 = path.join(OUT, 'fast-small.mp4');
  assert.equal((await tiers.makeSmallVersion({ ffmpeg: 'ffmpeg', input: FASTSTART, output: out30 })).ok, true);
  assert.equal(Number(probe(out30).streams[0].nb_frames), 30);
});

test('T1-7 ISO BMFF box scanning: 64-bit length, size=0, fragmented MP4, bad length', async () => {
  const box = (type, payload = 0, { large = false, zero = false } = {}) => {
    if (large) { const b = Buffer.alloc(16 + payload); b.writeUInt32BE(1, 0); b.write(type, 4, 'latin1'); b.writeBigUInt64BE(BigInt(16 + payload), 8); return b; }
    const b = Buffer.alloc(8 + payload); b.writeUInt32BE(zero ? 0 : 8 + payload, 0); b.write(type, 4, 'latin1'); return b;
  };
  const write = (name, parts) => { const f = path.join(OUT, name); fs.writeFileSync(f, Buffer.concat(parts)); return f; };
  assert.equal(await tiers.faststartState(write('a.mp4', [box('ftyp', 8), box('moov', 20), box('mdat', 100, { large: true })])), 'faststart');
  assert.equal(await tiers.faststartState(write('b.mp4', [box('ftyp', 8), box('mdat', 100, { large: true }), box('moov', 20)])), 'needs');
  assert.equal(await tiers.faststartState(write('c.mp4', [box('ftyp', 8), box('moov', 20), box('mdat', 50, { zero: true })])), 'faststart');
  assert.equal(await tiers.faststartState(write('d.mp4', [box('ftyp', 8), box('moov', 20), box('moof', 10), box('mdat', 30)])), 'fragmented');
  const bad = box('mdat', 10); bad.writeUInt32BE(4, 0);
  assert.equal(await tiers.faststartState(write('e.mp4', [box('ftyp', 8), bad])), 'unknown');
  assert.equal(await tiers.faststartState(write('f.mp4', [box('ftyp', 8), box('mdat', 10)])), 'unknown');
});

test('T1-8 when the remux fails, the source file is kept as the asset original size, with no transcoding', { skip: !ffmpegOk && 'No ffmpeg' }, async () => {
  const root = path.join(OUT, 'remux-fail');
  const dir = media.mediaDir(root);
  fs.mkdirSync(dir, { recursive: true });
  const manager = tiers.createTierManager({
    dir,
    lib: { hashFile: media.hashFile, writeIndex: (h, e) => media.writeMediaIndex(root, h, e), contentTypeForExt: media.contentTypeForExt },
    ffmpeg: async () => path.join(OUT, 'no-such-ffmpeg.exe'),
  });
  const stored = await media.storeMediaStream(root, 'x.mp4', fs.createReadStream(LATE_1080));
  const out = await manager.prepareImport(stored);
  assert.equal(out.remux.state, 'failed');
  assert.equal(out.stored.hash, stored.hash);
  assert.ok(fs.existsSync(stored.path), 'The source file is still there');
  assert.equal(sha256File(stored.path), stored.hash);
  assert.equal(fs.readdirSync(dir).some((n) => n.startsWith('.remux-')), false, 'The temporary file has been deleted');
  await manager.idle();
  assert.equal(manager.status([stored.hash])[stored.hash].state, 'failed');
});

/* ======================================================================== *
 * T2: offline import then reconnect: only fill missing chunks; chunks for both tiers
 * complete separately; response and project records have no sync fields
 * ======================================================================== */

test('T2-1 wired through the plugin: connected to the remote asset service, the network drops at chunk 2 of the asset original size, and after reconnecting only the missing chunks are filled in; the chunks of both tiers complete separately; with a ticket', { skip: !ffmpegOk && 'No ffmpeg', timeout: 60_000 }, async () => {
  const rootR = path.join(OUT, 'remote');
  fs.mkdirSync(media.mediaDir(rootR), { recursive: true });
  const remote = await listen(serviceHandler(rootR));
  const proxy = await flakyProxy(remote);
  const rootB = path.join(OUT, 'importer-b');
  fs.mkdirSync(media.mediaDir(rootB), { recursive: true });
  const originB = await listen(serviceHandler(rootB));
  const service = await media.mediaTierService(rootB);
  service.queue.start();
  after(() => service.queue.stop());
  const set = await fetch(`${originB}/api/media/upload-queue/target`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: `${proxy.origin}/api/asset`, ticket: 'test-ticket-1' }) });
  assert.equal(set.status, 200);

  const srcBytes = fs.statSync(LATE_1080).size;
  assert.ok(srcBytes > 2 * 8 * 1024 * 1024, `The test asset must exceed 2 chunks, actual ${srcBytes}`);
  // Disconnect as soon as chunk 1 (2nd chunk) of original-size asset arrives
  let original = null;
  proxy.state.dropWhen = (req) => original && req.method === 'PUT' && req.url === `/api/asset/media/${original}/1`;
  const body = await importFile(originB, LATE_1080, 'offline.mp4');
  original = body.hash;
  await service.manager.idle();
  const small = service.manager.status([original])[original].small;
  assert.match(small, /^[0-9a-f]{64}$/);

  // Wait until client retries fail after disconnect and queue enters backoff
  const t0 = Date.now();
  while (!(service.queue.stats().failures >= 1) && Date.now() - t0 < 20_000) await new Promise((r) => setTimeout(r, 50));
  assert.ok(service.queue.stats().failures >= 1, 'The network drop should make this asset fail once');
  const before = await chunksOf(`${remote}/api/asset`, original);
  assert.deepEqual(before.received, [0], 'Only chunk 0 was received before the network drop');
  assert.equal(before.complete, false);
  assert.equal((await chunksOf(`${remote}/api/asset`, small)).complete, true, 'The asset small size is uploaded first and was complete before the network drop');

  // Reconnect, wait for queue to drain (queue retries after 5 s backoff)
  proxy.state.offline = false;
  proxy.state.dropWhen = null;
  let guard;
  await Promise.race([service.queue.drain(), new Promise((_, rej) => { guard = setTimeout(() => rej(new Error('The queue did not drain within 30 s')), 30_000); })])
    .finally(() => clearTimeout(guard));

  const puts = proxy.state.log.filter((e) => e.method === 'PUT' && !e.dropped).map((e) => e.path.replace('/api/asset/media/', '').replace(small, 'S').replace(original, 'O'));
  assert.deepEqual(puts, ['S/0', 'O/0', 'O/1', 'O/2'], `Actual PUT order ${JSON.stringify(puts)}`);
  const dropped = proxy.state.log.filter((e) => e.dropped).length;
  assert.ok(dropped >= 1);
  // Both tiers complete separately
  const cs = await chunksOf(`${remote}/api/asset`, small);
  const co = await chunksOf(`${remote}/api/asset`, original);
  assert.equal(cs.complete, true);
  assert.equal(co.complete, true);
  assert.deepEqual(co.received, [0, 1, 2]);
  // Bytes retrieved from remote match the two copies on this machine
  const got = Buffer.from(await (await fetch(`${remote}/api/asset/media/${original}`)).arrayBuffer());
  assert.equal(crypto.createHash('sha256').update(got).digest('hex'), original);
  // Every request carries a ticket (only in Authorization header, not in URL)
  const sent = proxy.state.log.filter((e) => !e.dropped);
  assert.ok(sent.length > 0 && sent.every((e) => e.auth === 'Bearer test-ticket-1'), 'Every request carries a Bearer ticket');
  assert.ok(sent.every((e) => !/[?&]t=/.test(e.path)));
  // Neither response nor local registry has sync status
  for (const key of Object.keys(body)) assert.ok(RESPONSE_KEYS.has(key) && !SYNC_WORDS.test(key), `Response field ${key}`);
  const saved = JSON.parse(fs.readFileSync(path.join(media.mediaDir(rootB), 'tiers.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(saved.items[original]), SYNC_WORDS);
  // This asset has been dequeued in the queue file
  const qfile = JSON.parse(fs.readFileSync(path.join(rootB, 'out', 'upload-queue.json'), 'utf8'));
  assert.deepEqual(qfile.items, []);
});

test('T2-3 when connected to the remote asset service, newly imported images and audio also enter the upload queue (only the asset original size tier), complete on the remote side with identical bytes; the two-tier status is not registered', { timeout: 30_000 }, async () => {
  const rootR = path.join(OUT, 'remote-still');
  fs.mkdirSync(media.mediaDir(rootR), { recursive: true });
  const remote = await listen(serviceHandler(rootR));
  const rootC = path.join(OUT, 'importer-c');
  fs.mkdirSync(media.mediaDir(rootC), { recursive: true });
  const originC = await listen(serviceHandler(rootC));
  const service = await media.mediaTierService(rootC);
  service.queue.start();
  after(() => service.queue.stop());
  const set = await fetch(`${originC}/api/media/upload-queue/target`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: `${remote}/api/asset`, ticket: 'test-ticket-3' }) });
  assert.equal(set.status, 200);
  const files = [];
  for (const [name, size] of [['still.png', 40_000], ['voice.mp3', 9 * 1024 * 1024]]) {
    const f = path.join(OUT, `t23-${name}`);
    fs.writeFileSync(f, crypto.randomBytes(size));
    files.push({ name, f, hash: sha256File(f) });
  }
  for (const it of files) {
    const body = await importFile(originC, it.f, it.name);
    assert.equal(body.hash, it.hash);
    assert.equal('tiers' in body, false, 'Not a video: the response still carries no tiers');
    assert.equal(service.manager.status([it.hash])[it.hash].state, 'unknown', 'The two-tier status is not registered');
  }
  let guard;
  await Promise.race([service.queue.drain(), new Promise((_, rej) => { guard = setTimeout(() => rej(new Error('The queue did not drain within 20 s')), 20_000); })])
    .finally(() => clearTimeout(guard));
  for (const it of files) {
    const c = await chunksOf(`${remote}/api/asset`, it.hash);
    assert.equal(c.complete, true, `${it.name} is complete on the remote side`);
    const got = Buffer.from(await (await fetch(`${remote}/api/asset/media/${it.hash}`)).arrayBuffer());
    assert.equal(crypto.createHash('sha256').update(got).digest('hex'), it.hash, `${it.name} has identical bytes on the remote side`);
  }
  assert.ok(service.queue.stats().done >= 2);
});

test('T2-2 resume after restart: when the network drops the queue is stopped (left in upload-queue.json), and a newly created queue reads it back and continues uploading, filling in only the missing chunks', { timeout: 30_000 }, async () => {
  const rootR = path.join(OUT, 'remote-2');
  fs.mkdirSync(media.mediaDir(rootR), { recursive: true });
  const remote = await listen(serviceHandler(rootR));
  const proxy = await flakyProxy(remote);
  const lib = path.join(OUT, 'lib-2');
  fs.mkdirSync(lib, { recursive: true });
  const bytes = crypto.randomBytes(8 * 1024 * 1024 * 2 + 1234);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(lib, `${hash}.mp4`), bytes);
  const smallBytes = crypto.randomBytes(5000);
  const smallHash = crypto.createHash('sha256').update(smallBytes).digest('hex');
  fs.writeFileSync(path.join(lib, `${smallHash}.mp4`), smallBytes);
  const file = path.join(OUT, 'q2', 'upload-queue.json');
  const client = createAssetClient({ base: `${proxy.origin}/api/asset`, retries: 0 });
  const events = [];
  const make = () => uq.createUploadQueue({
    file, target: () => ({ client }), resolveFile: (h) => path.join(lib, `${h}.mp4`), backoff: [30],
    log: (e, f) => events.push({ e, ...f }),
  });
  proxy.state.dropWhen = (req) => req.method === 'PUT' && req.url === `/api/asset/media/${hash}/2`;
  const q1 = make();
  q1.start();
  await q1.enqueue({ name: 'r.mp4', tiers: [{ tier: 'original', hash, ext: 'mp4' }, { tier: 'small', hash: smallHash, ext: 'mp4' }] });
  const t0 = Date.now();
  while (!events.some((e) => e.e === 'upload.retry') && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 20));
  await q1.stop();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items.length, 1, 'When stopped, this asset stays in the file');
  assert.deepEqual((await chunksOf(`${remote}/api/asset`, hash)).received, [0, 1]);

  proxy.state.offline = false;
  proxy.state.dropWhen = null;
  const q2 = make();
  assert.equal(q2.stats().restored, 1);
  const logMark = proxy.state.log.length;
  const eventMark = events.length;
  q2.start();
  await q2.drain();
  await q2.stop();
  // "Only fill missing chunks after restart" checks all chunks sent by q2 across the entire process,
  // not just the last tier-done: client retries is 0; when the machine is busy, q2 might hit a
  // connection jitter (proxy just destroyed a socket) and retry the whole item; on the second pass,
  // original-size asset is complete, so tier-done sent is [].
  // Criterion is not relaxed: if q2 resends chunk 0 or 1 (or fails to send chunk 2), both checks fail.
  const tierDone = events.slice(eventMark).filter((e) => e.e === 'upload.tier-done' && e.hash === hash);
  assert.ok(tierDone.length >= 1, 'After the restart the asset original size finishes uploading');
  assert.deepEqual([...new Set(tierDone.flatMap((e) => e.sent))].sort(), [2], `After the restart only chunk 2 is filled in: ${JSON.stringify(tierDone.map((e) => e.sent))}`);
  const puts = proxy.state.log.slice(logMark)
    .filter((x) => x.method === 'PUT' && x.path.startsWith(`/api/asset/media/${hash}/`))
    .map((x) => Number(x.path.split('/').at(-1)));
  assert.deepEqual([...new Set(puts)].sort(), [2], `After the restart the only asset original size chunk sent to the asset service is chunk 2: ${JSON.stringify(puts)}`);
  assert.equal((await chunksOf(`${remote}/api/asset`, hash)).complete, true);
  assert.equal((await chunksOf(`${remote}/api/asset`, smallHash)).complete, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items, []);
});

/* ======================================================================== *
 * T3: queue order: asset by asset, small first then large; assets queued after artifacts
 * ======================================================================== */

/**
 * In-memory asset service client: records every chunk; hashes in `failOnce` throw a network error
 * on the first PUT
 */
function memoryClient({ failOnce = new Set(), delayMs = 5 } = {}) {
  const store = new Map();
  const calls = [];
  return {
    calls,
    async putFile(ns, file, { hash, beforeChunk }) {
      const st = store.get(hash) ?? { received: new Set(), complete: false };
      store.set(hash, st);
      if (st.complete) return { hash, size: 1, uploaded: false, sent: [] };
      const release = await beforeChunk?.(0);
      try {
        await new Promise((r) => setTimeout(r, delayMs));
        if (failOnce.has(hash)) { failOnce.delete(hash); throw Object.assign(new Error('network'), { code: 'network' }); }
        calls.push(hash);
        st.received.add(0);
      } finally { release?.(); }
      st.complete = true;
      return { hash, size: 1, uploaded: true, sent: [0] };
    },
    async chunks(ns, hash) { const st = store.get(hash); return { complete: !!st?.complete, received: [...(st?.received ?? [])] }; },
  };
}
const H = (c) => c.repeat(64);

test('T3-1 all asset small sizes are uploaded first, then the asset original sizes in queue order; when the tier whose turn it is fails, the ones behind wait (checked via log order)', async () => {
  const client = memoryClient({ failOnce: new Set([H('b')]) });
  const log = [];
  const q = uq.createUploadQueue({ file: null, target: () => ({ client }), resolveFile: () => HERE, backoff: [20], log: (e, f) => log.push(`${e}:${f.id?.[0] ?? ''}:${f.tier ?? ''}`) });
  // Enqueue order A, B, C; tiers intentionally lists original-size asset first,
  // queue must reorder small-size asset to the front
  await q.enqueue({ name: 'A', tiers: [{ tier: 'original', hash: H('b') }, { tier: 'small', hash: H('a') }] });
  await q.enqueue({ name: 'B', tiers: [{ tier: 'original', hash: H('d') }, { tier: 'small', hash: H('c') }] });
  await q.enqueue({ name: 'C', tiers: [{ tier: 'original', hash: H('e') }] });
  q.start();
  await q.drain();
  await q.stop();
  const order = log.filter((l) => /tier-start|tier-done|item-done|retry/.test(l));
  assert.deepEqual(order, [
    'upload.tier-start:b:small', 'upload.tier-done:b:small', 'upload.tier-start:d:small', 'upload.tier-done:d:small',
    'upload.tier-start:b:original', 'upload.retry:b:',
    'upload.tier-start:b:original', 'upload.tier-done:b:original', 'upload.item-done:b:',
    'upload.tier-start:d:original', 'upload.tier-done:d:original', 'upload.item-done:d:',
    'upload.tier-start:e:original', 'upload.tier-done:e:original', 'upload.item-done:e:',
  ]);
  // Actual order landing on asset service: small A, small B, original A, original B, original C
  assert.deepEqual(client.calls, [H('a'), H('c'), H('b'), H('d'), H('e')]);
});

test('T3-2 when connected to the local asset service (target returns null) enqueueing is a no-op; items already in the queue are paused, and switching back to the remote continues the upload', async () => {
  const client = memoryClient();
  let where = null;
  const q = uq.createUploadQueue({ file: null, target: () => where, resolveFile: () => HERE, backoff: [10] });
  assert.deepEqual(await q.enqueue({ tiers: [{ tier: 'original', hash: H('1') }] }), { queued: false, reason: 'local' });
  assert.equal(q.stats().items.length, 0);
  where = { client };
  await q.enqueue({ tiers: [{ tier: 'original', hash: H('2') }] });
  where = null;
  q.start();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(client.calls.length, 0, 'No uploads while switched back to local');
  where = { client };
  q.poke();
  await q.drain();
  await q.stop();
  assert.deepEqual(client.calls, [H('2')]);
});

test('T3-3 bandwidth gate: while output is being pushed or segments are still waiting to be pushed, the chunks of the asset wait; they are released only once the output has been fully pushed', async () => {
  const gate = gateMod.createBandwidthGate({ pollMs: 10 });
  let pendingArtifacts = 2;
  const unregister = gate.artifactDemand(() => pendingArtifacts);
  const order = [];
  const client = memoryClient({ delayMs: 1 });
  const q = uq.createUploadQueue({ file: null, target: () => ({ client }), resolveFile: () => HERE, gate, log: (e) => { if (e === 'upload.tier-done') order.push('media'); } });
  await q.enqueue({ tiers: [{ tier: 'small', hash: H('5') }, { tier: 'original', hash: H('6') }] });
  q.start();
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(client.calls.length, 0, '2 segments of the output are still unpushed, so not a single asset chunk is sent');
  const end = gate.beginArtifact();
  pendingArtifacts = 0;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(client.calls.length, 0, 'Output is being pushed, the asset waits');
  order.push('artifact');
  end();
  await q.drain();
  await q.stop();
  unregister();
  assert.deepEqual(order, ['artifact', 'media', 'media']);
  assert.deepEqual(client.calls, [H('5'), H('6')]);
});

test('T3-4 the push queue is attached to the bandwidth gate: it registers demand and holds the gate while pushing; a cross-process probe reads push-queue.json', async () => {
  const { createPushQueue } = await import(serverUrl('artifact-push.mjs'));
  const calls = [];
  let provider = null;
  const fakeGate = {
    beginArtifact() { calls.push('begin'); return () => calls.push('end'); },
    artifactDemand(fn) { provider = fn; calls.push('demand'); return () => { provider = null; calls.push('undemand'); }; },
  };
  const pipeline = { root: null, snapshots() { throw new Error('No frame store in the unit test'); } };
  const pq = createPushQueue({ pipeline, client: { put() {} }, gate: fakeGate, attach: false, backoff: [60_000] });
  await pq.enqueue({ kind: 'stream', resultKey: 'f'.repeat(64), range: { from: 0, to: 14 } });
  pq.start();
  assert.equal(provider(), 1, 'One segment is waiting to be pushed');
  const t0 = Date.now();
  while (!calls.includes('end') && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 10));
  assert.ok(calls.includes('begin') && calls.includes('end'));
  assert.equal(provider(), 0, 'A segment that failed and entered backoff does not block assets');
  await pq.stop();
  assert.ok(calls.includes('undemand'));

  // Cross-process probe
  const f = path.join(OUT, 'fl', 'push-queue.json');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ v: 1, items: [{ unit: {}, priority: 0, attempts: 0 }] }));
  assert.equal(gateMod.pushQueueFileProbe(f, { cacheMs: 0 })(), true);
  fs.writeFileSync(f, JSON.stringify({ v: 1, items: [{ unit: {}, priority: 0, attempts: 2 }] }));
  assert.equal(gateMod.pushQueueFileProbe(f, { cacheMs: 0 })(), false, 'All in backoff: not counted as busy');
  fs.writeFileSync(f, JSON.stringify({ v: 1, items: [{ unit: {}, priority: 0, attempts: 0 }] }));
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(f, old, old);
  assert.equal(gateMod.pushQueueFileProbe(f, { cacheMs: 0 })(), false, 'An old file not updated for a long time is not counted as busy');
  assert.equal(gateMod.pushQueueFileProbe(path.join(OUT, 'none.json'), { cacheMs: 0 })(), false);
});


/* ---- Upload all small-size assets first (user, 2026-10-13: "force upload small size first, then large size") ---- */

const three = async (q) => {
  await q.enqueue({ name: 'A', tiers: [{ tier: 'small', hash: H('a') }, { tier: 'original', hash: H('b') }] });
  await q.enqueue({ name: 'B', tiers: [{ tier: 'small', hash: H('c') }, { tier: 'original', hash: H('d') }] });
  await q.enqueue({ name: 'C', tiers: [{ tier: 'small', hash: H('7') }, { tier: 'original', hash: H('8') }] });
};

test('T3-5 three assets enter the queue together: all three asset small sizes reach the asset service before any asset original size', async () => {
  const client = memoryClient();
  const q = uq.createUploadQueue({ file: null, target: () => ({ client }), resolveFile: () => HERE, backoff: [10] });
  await three(q);
  q.start();
  await q.drain();
  await q.stop();
  assert.deepEqual(client.calls, [H('a'), H('c'), H('7'), H('b'), H('d'), H('8')]);
  assert.equal(q.stats().done, 3);
});

test('T3-6 when an asset small size fails to upload and is in backoff: no asset original size is uploaded until its retry succeeds', async () => {
  const client = memoryClient({ failOnce: new Set([H('c')]) });
  const log = [];
  const q = uq.createUploadQueue({ file: null, target: () => ({ client }), resolveFile: () => HERE, backoff: [40], log: (e, f) => log.push(`${e}:${f.tier ?? ''}`) });
  await three(q);
  q.start();
  await q.drain();
  await q.stop();
  assert.deepEqual(client.calls, [H('a'), H('c'), H('7'), H('b'), H('d'), H('8')]);
  const firstOriginal = log.indexOf('upload.tier-start:original');
  assert.ok(log.indexOf('upload.retry:') >= 0 && log.indexOf('upload.retry:') < firstOriginal, 'The retry happens before the first asset original size');
  assert.equal(log.slice(0, firstOriginal).filter((l) => l === 'upload.tier-done:small').length, 3, 'All three asset small sizes had finished uploading before the first asset original size started');
});

test('T3-7 an asset enqueued while an asset original size is uploading: its asset small size is placed ahead of the remaining asset original sizes; the same holds for an asset small size added later', async () => {
  const client = memoryClient({ delayMs: 20 });
  let q = null;
  let added = false;
  const log = (e, f) => {
    if (e !== 'upload.tier-start' || f.tier !== 'original' || added) return;
    added = true; // Moment the first original-size asset starts uploading: add small-size asset for C which only had original-size asset, then enqueue new asset D
    void q.enqueue({ name: 'C', tiers: [{ tier: 'small', hash: H('7') }, { tier: 'original', hash: H('8') }] });
    void q.enqueue({ name: 'D', tiers: [{ tier: 'small', hash: H('1') }, { tier: 'original', hash: H('2') }] });
  };
  q = uq.createUploadQueue({ file: null, target: () => ({ client }), resolveFile: () => HERE, backoff: [10], log });
  await q.enqueue({ name: 'A', tiers: [{ tier: 'small', hash: H('a') }, { tier: 'original', hash: H('b') }] });
  await q.enqueue({ name: 'B', tiers: [{ tier: 'small', hash: H('c') }, { tier: 'original', hash: H('d') }] });
  await q.enqueue({ name: 'C', tiers: [{ tier: 'original', hash: H('8') }] });
  q.start();
  await q.drain();
  await q.stop();
  // Small A, small B, original A (only yields after current tier completes), small C (enqueued first),
  // small D, original B, original C, original D
  assert.deepEqual(client.calls, [H('a'), H('c'), H('b'), H('7'), H('1'), H('d'), H('8'), H('2')]);
});

test('T3-8 queue recovery after an app restart: unfinished asset small sizes are uploaded first, then the asset original sizes; tiers already done are not uploaded again', async () => {
  const file = path.join(os.tmpdir(), `pc-upload-order-${process.pid}-${Date.now()}.json`);
  const client = memoryClient({ failOnce: new Set([H('c')]) });
  // First instance: small A finishes uploading, small B backs off for a long time after failure
  // (simulating application closed at this point)
  const q1 = uq.createUploadQueue({ file, target: () => ({ client }), resolveFile: () => HERE, backoff: [600_000] });
  await three(q1);
  q1.start();
  for (let i = 0; i < 200 && !q1.stats().failures; i++) await new Promise((r) => setTimeout(r, 10));
  await q1.stop();
  assert.deepEqual(client.calls, [H('a')], 'Before the restart only the asset small size of A had finished uploading');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).items.length, 3, 'All three assets are still in the queue file');
  // Second instance: same queue file
  const log = [];
  const q2 = uq.createUploadQueue({ file, target: () => ({ client }), resolveFile: () => HERE, backoff: [10], log: (e, f) => { if (e === 'upload.tier-start') log.push(f.tier); } });
  assert.equal(q2.stats().restored, 3);
  q2.start();
  await q2.drain();
  await q2.stop();
  assert.deepEqual(client.calls, [H('a'), H('c'), H('7'), H('b'), H('d'), H('8')], 'The asset small size of A was not re-uploaded; the remaining two asset small sizes come before any asset original size');
  assert.deepEqual(log, ['small', 'small', 'small', 'original', 'original', 'original'], 'Dispatch order after recovery');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).items, []);
  fs.rmSync(file, { force: true });
});
