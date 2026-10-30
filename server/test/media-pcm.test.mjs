// GET /@media/<hash>/pcm —— 音频素材效果卡的素材输入(ffmpeg 按采样区间裁)。跑法:
//   node --test server/test/media-pcm.test.mjs
//
// 和 media-hash.test.mjs 一个路数:插件是 .ts,转译到临时目录再 import,路由单独导出成
// mediaMiddleware,直接架在一个裸 http server 上。差别是 pcm 那支会惰性 import
// server/bakery 取 findFfmpeg,临时目录里解析不到相对路径,所以转译后把
// 那个说明符换成仓库里的绝对 file:// —— 真的 findFfmpeg 照跑,不给生产代码留测试后门。
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test, after, before } from 'node:test';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-media-pcm-'));

delete process.env.PROMPTCUT_EXPORT_DIR;
delete process.env.PROMPTCUT_MEDIA_DIR;

const BAKERY = pathToFileURL(path.join(ROOT, 'server', 'bakery', 'ffmpeg.mjs')).href;

function compile(srcRel, outName) {
  const src = fs.readFileSync(path.join(ROOT, srcRel), 'utf8');
  let js = ts.transpileModule(src, {
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  }).outputText;
  js = js.replace(/(["'])\.\/bakery\/ffmpeg\.mjs\1/g, JSON.stringify(BAKERY));
  const file = path.join(OUT, outName);
  fs.writeFileSync(file, js);
  return pathToFileURL(file).href;
}

const media = await import(compile('server/vite-plugin-media.ts', 'media.mjs'));
const { findFfmpeg } = await import(BAKERY);

const projectRoot = path.join(OUT, 'project');
fs.mkdirSync(media.mediaDir(projectRoot), { recursive: true });

const server = http.createServer((req, res) => {
  void media.mediaMiddleware(projectRoot)(req, res, () => { res.statusCode = 404; res.end('no route'); });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
after(() => { server.close(); fs.rmSync(OUT, { recursive: true, force: true }); });

const SR = 48000;
const SECONDS = 1;
let hash = null, ffmpegOk = false, truth = null;

before(async () => {
  // 1 秒 1000 Hz 正弦,48 kHz 立体声 —— 每个采样点都能按公式对出来
  const ffmpeg = await findFfmpeg();
  const wav = path.join(OUT, 'sine.wav');
  try {
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=${SR}:duration=${SECONDS}`,
      '-ac', '2', '-c:a', 'pcm_s16le', wav], { windowsHide: true, timeout: 60000 });
    ffmpegOk = true;
  } catch (err) {
    console.warn('[media-pcm] 本机没有可用的 ffmpeg,跳过:', err.message);
    return;
  }
  hash = (await media.storeMediaStream(projectRoot, 'sine.wav', Readable.from(fs.createReadStream(wav)))).hash;
  // 真值:整份素材一次解成 f32le 立体声。路由裁出来的每一块都要和它逐样本相同
  // (不去猜 ffmpeg 的 sine 相位,直接和 ffmpeg 自己的解码结果对)
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', wav, '-vn', '-ar', String(SR), '-ac', '2', '-f', 'f32le', 'pipe:1'],
    { windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  truth = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
});

const pcm = (query) => fetch(`${origin}/@media/${hash}/pcm?${query}`);
const floats = async (res) => new Float32Array(await res.arrayBuffer());

test('正常区间:回 count × 2 × 4 字节的 f32le 交错采样', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg');
  const res = await pcm(`start=0&count=4800&sampleRate=${SR}&ch=2`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  const data = await floats(res);
  assert.equal(data.length, 4800 * 2);
  assert.equal(Number(res.headers.get('content-length')), 4800 * 2 * 4);
  // 和整份素材的解码结果逐样本相同
  assert.deepEqual(Array.from(data), Array.from(truth.subarray(0, 4800 * 2)));
  assert.ok(data.some((v) => v !== 0), '不是一整块静音');
  for (let n = 0; n < 100; n++) assert.equal(data[n * 2], data[n * 2 + 1], '两个声道一样');
});

test('中间的区间:start 就是素材里的采样序号', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg');
  const data = await floats(await pcm(`start=12000&count=480&sampleRate=${SR}&ch=2`));
  assert.deepEqual(Array.from(data), Array.from(truth.subarray(12000 * 2, 12480 * 2)));
});

test('负的 start:前面补静音,后面接上素材第 0 个采样点', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg');
  const lead = 240;
  const data = await floats(await pcm(`start=${-lead}&count=480&sampleRate=${SR}&ch=2`));
  assert.equal(data.length, 480 * 2);
  for (let i = 0; i < lead * 2; i++) assert.equal(data[i], 0, `前 ${lead} 帧必须是静音`);
  // 静音之后接的是素材的第 0 个采样点起
  assert.deepEqual(Array.from(data.subarray(lead * 2)), Array.from(truth.subarray(0, (480 - lead) * 2)));
});

test('整块都在素材开始之前:全静音,不起 ffmpeg', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg');
  const data = await floats(await pcm(`start=-4800&count=480&sampleRate=${SR}&ch=2`));
  assert.equal(data.length, 960);
  assert.equal(data.every((v) => v === 0), true);
});

test('超过素材长度的尾部补零', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg');
  const total = SECONDS * SR;
  const data = await floats(await pcm(`start=${total - 240}&count=480&sampleRate=${SR}&ch=2`));
  assert.equal(data.length, 960);
  assert.equal(data.slice(240 * 2).every((v) => v === 0), true, '素材没那么长,尾部补零');
});

test('重采样按 sampleRate 走', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg');
  const data = await floats(await pcm(`start=0&count=2400&sampleRate=24000&ch=2`));
  assert.equal(data.length, 2400 * 2);
});

test('参数校验:count / sampleRate / ch 越界都是 400', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg');
  for (const query of [
    `start=0&count=0&sampleRate=${SR}&ch=2`,
    `start=0&count=1048577&sampleRate=${SR}&ch=2`,
    `start=0&count=48&sampleRate=7999&ch=2`,
    `start=0&count=48&sampleRate=192001&ch=2`,
    `start=0&count=48&sampleRate=${SR}&ch=1`,
    `start=0.5&count=48&sampleRate=${SR}&ch=2`,
    `count=48&sampleRate=${SR}&ch=2`,
  ]) {
    assert.equal((await pcm(query)).status, 400, query);
  }
});

test('库里没有的哈希是 404;pcm 不会被 /@media/<文件名> 那支吃掉', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg');
  const missing = await fetch(`${origin}/@media/${'f'.repeat(64)}/pcm?start=0&count=48&sampleRate=${SR}&ch=2`);
  assert.equal(missing.status, 404);
  assert.notEqual(missing.headers.get('content-type'), 'audio/wav', '走到文件名那支就会把 "pcm" 当文件名');
});
