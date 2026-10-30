/**
 * Agent 读素材的路径(`docs/plan/TODO.md`「语义与代码的差距」;语义 `docs/semantics/product/agent.md`「素材与产物」):
 * 测响度 `measure_audio`(`/api/audio/measure`)与自定义测量 `measure_audio_js`(`/api/audio/measure-js`)
 * 经素材服务的 HTTP 接口取字节,不按素材目录找文件。
 *
 * 用例 AR-1～AR-8:
 *   AR-1  解析器:取不到素材服务地址 / 连不上 / 拒绝读取 → AssetSourceError(写明地址与原因);404 → null;2xx → 地址;
 *   AR-2  素材记录 → 地址(vite-plugin-audio.ts 的 audioMediaUrl):哈希、文件名、老绝对路径、导出目录;请求体里的 path 不用来读盘;
 *   ── 以下起真的素材服务(server/asset-service.ts + 媒体中间件,fs 内容库)与真的 ffmpeg ──
 *   AR-3  测响度:素材 / 片段 / 时间轴三档,经素材服务取的与直接读文件(改前的读法)回包逐字相同;
 *         素材记录里的 path 指向不存在的目录(素材目录不可读),照常出结果;素材服务确实被请求过(Range);
 *   AR-4  自定义测量:解出的 PCM 与直接读文件的逐字节相同(单文件、片段窗口、时间轴混音、mono);经沙箱的 measureJs 结果相同;
 *   AR-5  大文件与分段取:约 35 MB 的 wav(5 个分片入库),片段档测 150 秒处 2 秒,经素材服务传过来的字节远小于整个文件;
 *   AR-6  素材服务不可达:测响度回 502 与写明原因的错,自定义测量回 kind asset-service;时间轴档也不当成「跳过」;
 *   AR-7  素材服务上没有这份素材(404):仍是「素材文件不存在」/ no-media,时间轴档跳过那一段;
 *   AR-8  单进程形态:素材服务就在本进程里,ffprobe 走异步,不卡事件循环(测量期间本进程的定时器照常转)。
 *
 * 跑:node --test server/test/audio-asset-path.test.mjs(要 ffmpeg;找不到时 AR-3 起跳过)
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

test('AR-1 解析器:不可达、拒绝、404、2xx 分得清', async () => {
  const toUrl = (m, o) => (m?.hash ? `${o}/@media/${m.hash}` : null);
  // 取不到地址
  const noOrigin = createAssetSourceResolver({ origin: () => null, toUrl });
  await assert.rejects(noOrigin({ hash: 'a' }), (e) => e instanceof AssetSourceError && /取不到素材服务的地址/.test(e.message));
  // 连不上:起一个端口再关掉
  const gone = await listen(() => {});
  await closeServer(gone.server);
  const refused = createAssetSourceResolver({ origin: () => gone.origin, toUrl });
  await assert.rejects(refused({ hash: 'a' }), (e) => e instanceof AssetSourceError && e.message.includes(`素材服务不可达(${gone.origin})`));
  // 超时
  const hang = await listen(() => { /* 不答 */ });
  const slow = createAssetSourceResolver({ origin: () => hang.origin, toUrl, timeoutMs: 300 });
  await assert.rejects(slow({ hash: 'a' }), (e) => e instanceof AssetSourceError && /没有应答/.test(e.message));
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
  await assert.rejects(r({ hash: 'locked' }), (e) => e instanceof AssetSourceError && /拒绝了读取.*HTTP 401/.test(e.message));
  assert.equal(await r({ hash: 'ok' }), `${svc.origin}/@media/ok`);
  assert.equal(await r({}), null, '拼不出地址');
  assert.ok(seen.every((s) => s.range === 'bytes=0-0'), '只探 1 个字节');
  await closeServer(svc.server);
});

test('AR-2 素材记录 → 素材服务上的地址;请求体里的 path 不用来读盘', async () => {
  let mod;
  try {
    mod = await import(harness.compileTs(path.join(ROOT, 'server', 'vite-plugin-audio.ts')));
  } catch (e) {
    assert.fail('转译 vite-plugin-audio.ts 失败:' + (e?.message || e));
  }
  const o = 'http://127.0.0.1:9';
  const h = 'ab'.repeat(32);
  assert.equal(mod.audioMediaUrl({ hash: h, path: 'C:\\Windows\\win.ini' }, o), `${o}/@media/${h}`);
  assert.equal(mod.audioMediaUrl({ url: `/@media/${h}.wav` }, o), `${o}/@media/${h}.wav`);
  assert.equal(mod.audioMediaUrl({ url: '/@media/%E9%85%8D%E4%B9%90.mp3' }, o), `${o}/@media/${encodeURIComponent('配乐.mp3')}`);
  // 只剩一个绝对路径:只取文件名,指不到素材服务存储以外
  assert.equal(mod.audioMediaUrl({ path: 'D:\\secret\\x.wav' }, o), `${o}/@media/x.wav`);
  const legacy = '/api/media/file?path=C%3A%2FUsers%2Fu%2Fa.wav';
  assert.equal(mod.audioMediaUrl({ url: legacy }, o), `${o}${legacy}`);
  assert.equal(mod.audioMediaUrl({ url: '/@export/job1/media/a.wav' }, o), `${o}/@export/job1/media/a.wav`);
  assert.equal(mod.audioMediaUrl({ url: 'blob:http://x/1' }, o), null);
});

/* ------------------------------------------------------------------ 真的素材服务 + ffmpeg */

const FFMPEG = findFfmpeg();
const FFPROBE = FFMPEG ? path.join(path.dirname(FFMPEG), 'ffprobe' + path.extname(FFMPEG)) : null;
const skip = FFMPEG ? false : '没找到 ffmpeg';

const gen = (out, lavfiArgs, codecArgs) => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', ...lavfiArgs, ...codecArgs, out], { windowsHide: true });
  assert.equal(r.status, 0, String(r.stderr));
  return out;
};

/** 起素材服务(fs 内容库),前面挂一个计数的转发:数请求、数经它传出去的字节;stop() 模拟不可达 */
async function startService() {
  const asset = await harness.asset();
  const svc = await harness.serve({ stores: 'default' });
  const stats = { requests: [], bytes: 0 };
  const front = await listen((req, res) => {
    const up = http.request(new URL(req.url, svc.origin), { method: req.method, headers: req.headers }, (r) => {
      stats.requests.push({ method: req.method, url: req.url, range: req.headers.range || null, status: r.statusCode });
      res.writeHead(r.statusCode, r.headers);
      // 数真正交给客户端的字节;客户端(ffmpeg)读够了断开,上游这条也跟着断
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
      assert.equal(r.status, 200, `分片 ${n}`);
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
  // 大文件:3 分钟 48 kHz 立体声 s16 ≈ 34.6 MB,入库 5 个分片
  files.big = gen(path.join(TMP, 'long.wav'), noise(180), [...mixStereo, '-c:a', 'pcm_s16le']);
}
before(async () => {
  if (!FFMPEG) return;
  service = await startService();
  for (const [k, f] of Object.entries(files)) hashes[k] = (await service.upload(f)).hash;
});
after(() => service?.stop());

/** 项目里的素材记录:path 指向一个不存在的目录(素材目录不可读),只有 hash / url 可用 */
const GONE = path.join(TMP, '不存在的素材目录');
const mediaOf = (k) => ({ id: `m-${k}`, name: path.basename(files[k]), url: `/@media/${hashes[k]}${path.extname(files[k])}`, hash: hashes[k], path: path.join(GONE, path.basename(files[k])) });
const viaService = () => createAssetSourceResolver({ origin: () => service.origin, toUrl: (m, o) => `${o}/@media/${m.hash}` });
/** 改前的读法:直接交本地文件路径(原来 mediaFileOf 返回的就是这个) */
const direct = (m) => files[Object.keys(files).find((k) => hashes[k] === m?.hash)] ?? null;

test('AR-3 测响度:三档经素材服务的回包与直接读文件的逐字相同;素材目录不可读照常出结果', { skip, timeout: 180_000 }, async () => {
  assert.equal(fs.existsSync(GONE), false);
  const bodies = [
    ...['wav', 'mp3', 'm4a', 'mono', 'mp4'].map((k) => ({ scope: 'media', media: mediaOf(k), series: true })),
    { scope: 'media', media: mediaOf('mp3'), series: false },
    { scope: 'clip', media: mediaOf('m4a'), offset: 1.25, duration: 3.5, series: true },
    { scope: 'clip', media: mediaOf('mp4'), offset: 0.5, duration: 2 },
    // 时间轴档的几段都放到时间轴结尾:有一段先结束时,ffmpeg 9 的 amix 偶发给之后的帧 NOPTS 时间戳(ebur128 打出
    // t: -192153584101141.06,即 INT64_MIN / 48000),逐秒曲线在那之后缺点。这是改前就有的偶发,与读法无关,见报告
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
    assert.equal(JSON.stringify(now), JSON.stringify(before), `${label}:回包逐字相同`);
    assert.ok(typeof now.body.integrated === 'number', `${label}:有响度数值`);
    const got = service.stats.requests.filter((r) => r.url.startsWith('/@media/') && r.method === 'GET');
    assert.ok(got.length >= 2, `${label}:经素材服务取了字节(${got.length} 次)`);
  }
});

test('AR-4 自定义测量:解出的 PCM 与直接读文件的逐字节相同;经沙箱的结果相同', { skip, timeout: 180_000 }, async () => {
  const resolve = viaService();
  const same = async (label, argsOf, fmt) => {
    const a = await decodePcm(FFMPEG, argsOf((k) => files[k]), fmt);
    const b = await decodePcm(FFMPEG, argsOf((k) => `${service.origin}/@media/${hashes[k]}`), fmt);
    assert.ok(a[0].length > 0, `${label}:有样本`);
    assert.equal(a.length, b.length, `${label}:声道数`);
    for (let c = 0; c < a.length; c++) assert.ok(Buffer.from(a[c].buffer).equals(Buffer.from(b[c].buffer)), `${label}:声道 ${c} 逐字节相同`);
  };
  await same('素材 wav', (src) => filePcmArgs({ file: src('wav'), sampleRate: 16000, channels: 2 }), { channels: 2, sampleRate: 16000 });
  await same('片段 mp3 窗口', (src) => filePcmArgs({ file: src('mp3'), offset: 1.7, duration: 2.2, sampleRate: 48000, channels: 2 }), { channels: 2, sampleRate: 48000 });
  await same('片段 m4a mono', (src) => filePcmArgs({ file: src('m4a'), offset: 0.3, duration: 4, sampleRate: 22050, channels: 1, sourceChannels: 2 }), { channels: 1, sampleRate: 22050 });
  await same('mp4 的音轨', (src) => filePcmArgs({ file: src('mp4'), sampleRate: 16000, channels: 2 }), { channels: 2, sampleRate: 16000 });
  const entries = (src) => [
    { file: src('wav'), start: 0, dur: 4, offset: 1, volume: 1, fadeIn: 0.5, fadeOut: 0 },
    { file: src('mono'), start: 1.5, dur: 3, offset: 0.5, volume: 0.7, fadeIn: 0, fadeOut: 0.8 },
  ];
  await same('时间轴混音窗口', (src) => timelinePcmArgs(entries(src), { total: 5, offset: 0.5, duration: 3, sampleRate: 16000, channels: 2 }), { channels: 2, sampleRate: 16000 });
  await same('时间轴混音 mono', (src) => timelinePcmArgs(entries(src), { total: 5, sampleRate: 8000, channels: 1 }), { channels: 1, sampleRate: 8000 });

  // 整条 measureJs(沙箱里算 PCM 的指纹):经素材服务与直接读文件结果相同
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
      assert.deepEqual(strip(b), strip(a), `${body.scope}:结果相同`);
      assert.ok(service.stats.requests.some((r) => r.url.startsWith('/@media/') && r.method === 'GET' && r.range !== 'bytes=0-0'), `${body.scope}:ffmpeg 经素材服务取了字节`);
    }
  } finally {
    await sandbox.close();
  }
});

test('AR-5 大文件与分段取:片段档只取需要的那几段', { skip, timeout: 180_000 }, async (t) => {
  const size = fs.statSync(files.big).size;
  assert.ok(size > 4 * 8 * 1024 * 1024, `大文件 ${size} 字节,多于 4 个分片`);
  const body = { scope: 'clip', media: mediaOf('big'), offset: 150, duration: 2, series: true };
  const before = await measureLoudness({ body, resolveSource: direct, ffmpeg: FFMPEG, ffprobe: FFPROBE });
  service.reset();
  const now = await measureLoudness({ body, resolveSource: viaService(), ffmpeg: FFMPEG, ffprobe: FFPROBE });
  assert.equal(JSON.stringify(now), JSON.stringify(before));
  const ranged = service.stats.requests.filter((r) => r.range && r.range !== 'bytes=0-0');
  assert.ok(ranged.length >= 1, 'ffmpeg 按 Range 定位:' + JSON.stringify(service.stats.requests));
  // 请求可能是开放区间(bytes=N-),ffmpeg 读够就断开;真正传过来的字节远小于整个文件
  t.diagnostic(`文件 ${size} 字节;经素材服务传过来 ${service.stats.bytes} 字节;请求 ${JSON.stringify(service.stats.requests.map((r) => r.range))}`);
  assert.ok(service.stats.bytes < size / 4, `经素材服务传过来 ${service.stats.bytes} 字节,文件 ${size} 字节`);

  // 自定义测量同一段:PCM 逐字节相同
  const args = (src) => filePcmArgs({ file: src, offset: 150, duration: 2, sampleRate: 48000, channels: 2 });
  const a = await decodePcm(FFMPEG, args(files.big), { channels: 2, sampleRate: 48000 });
  const b = await decodePcm(FFMPEG, args(`${service.origin}/@media/${hashes.big}`), { channels: 2, sampleRate: 48000 });
  assert.ok(Buffer.from(a[0].buffer).equals(Buffer.from(b[0].buffer)) && Buffer.from(a[1].buffer).equals(Buffer.from(b[1].buffer)));
});

test('AR-6 素材服务不可达:回写明原因的错,不当成文件不存在或跳过', { skip, timeout: 60_000 }, async () => {
  const gone = await listen(() => {});
  await closeServer(gone.server);
  const resolve = createAssetSourceResolver({ origin: () => gone.origin, toUrl: (m, o) => `${o}/@media/${m.hash}` });
  const m = await measureLoudness({ body: { scope: 'media', media: mediaOf('wav') }, resolveSource: resolve, ffmpeg: FFMPEG, ffprobe: FFPROBE });
  assert.equal(m.status, 502);
  assert.equal(m.body.ok, false);
  assert.ok(m.body.error.includes(`素材服务不可达(${gone.origin})`), m.body.error);
  const t = await measureLoudness({ body: { scope: 'timeline', duration: 3, entries: [{ clipId: 'c1', media: mediaOf('wav'), start: 0, dur: 3, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 }] }, resolveSource: resolve, ffmpeg: FFMPEG, ffprobe: FFPROBE });
  assert.equal(t.status, 502, '时间轴档不当成「跳过」');
  let ran = 0;
  const sandbox = { run: async () => { ran += 1; return { ok: true, value: 1 }; } };
  const j = await measureJs({ body: { scope: 'media', media: mediaOf('wav'), code: 'return 1' }, resolveSource: resolve, ffmpeg: FFMPEG, ffprobe: FFPROBE, sandbox });
  assert.equal(j.body.ok, false);
  assert.equal(j.body.kind, 'asset-service');
  assert.match(j.body.error, /素材服务不可达/);
  const noOrigin = createAssetSourceResolver({ origin: () => null, toUrl: () => 'x' });
  const k = await measureJs({ body: { scope: 'timeline', entries: [{ media: mediaOf('wav') }], code: 'return 1' }, resolveSource: noOrigin, ffmpeg: FFMPEG, ffprobe: FFPROBE, sandbox });
  assert.equal(k.body.kind, 'asset-service');
  assert.equal(ran, 0);
});

test('AR-7 素材服务上没有这份素材:仍是「素材文件不存在」,时间轴档跳过那一段', { skip, timeout: 60_000 }, async () => {
  const ghost = { id: 'g', name: '没入库.wav', hash: 'ee'.repeat(32), path: files.wav };
  const r = await measureLoudness({ body: { scope: 'media', media: ghost }, resolveSource: viaService(), ffmpeg: FFMPEG, ffprobe: FFPROBE });
  assert.deepEqual(r, { status: 400, body: { ok: false, error: '素材文件不存在' } }, '就算 path 指着一个真实存在的文件也不读它');
  const s = await measureLoudness({ body: { scope: 'media', media: mediaOf('silent') }, resolveSource: viaService(), ffmpeg: FFMPEG, ffprobe: FFPROBE });
  assert.deepEqual(s, { status: 400, body: { ok: false, error: '该文件没有音频流' } });
  const t = await measureLoudness({ body: { scope: 'timeline', duration: 3, entries: [
    { clipId: 'c1', media: ghost, start: 0, dur: 3, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
    { clipId: 'c2', media: mediaOf('wav'), start: 0, dur: 3, offset: 0, volume: 1, fadeIn: 0, fadeOut: 0 },
  ] }, resolveSource: viaService(), ffmpeg: FFMPEG, ffprobe: FFPROBE });
  assert.equal(t.status, 200);
  assert.ok(t.body.notes.some((n) => n.includes('没入库.wav')), JSON.stringify(t.body.notes));
  const j = await measureJs({ body: { scope: 'media', media: ghost, code: 'return 1' }, resolveSource: viaService(), ffmpeg: FFMPEG, ffprobe: FFPROBE, sandbox: { run: async () => ({ ok: true }) } });
  assert.equal(j.body.kind, 'no-media');
});

test('AR-8 单进程形态:素材服务在本进程里,ffprobe 走异步,事件循环照常转', { skip, timeout: 60_000 }, async () => {
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
  assert.ok(ms < 10_000, `三次探测 ${ms} ms(同步的话要等到 15 秒超时)`);
  assert.ok(ticks >= 1, '定时器转过');
});
