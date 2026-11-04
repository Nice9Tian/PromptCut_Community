// GET /@media/<hash>/pcm: asset input for audio media effect cards (ffmpeg trims by sample interval). How to run:
//   node --test server/test/media-pcm.test.mjs
//
// Same approach as media-hash.test.mjs: plugin is .ts, transpiled to a temp directory before import,
// and route is exported separately as mediaMiddleware, mounted directly on a bare http server.
// The difference is that the pcm branch lazy-imports findFfmpeg from server/bakery; relative paths
// cannot be resolved in the temp directory, so after transpilation that specifier is replaced with
// an absolute file:// in the repository: real findFfmpeg still runs, leaving no test backdoor in
// production code.
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
  // 1 s 1000 Hz sine, 48 kHz stereo: every sample point can be verified against the formula
  const ffmpeg = await findFfmpeg();
  const wav = path.join(OUT, 'sine.wav');
  try {
    execFileSync(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=${SR}:duration=${SECONDS}`,
      '-ac', '2', '-c:a', 'pcm_s16le', wav], { windowsHide: true, timeout: 60000 });
    ffmpegOk = true;
  } catch (err) {
    console.warn('[media-pcm] no usable ffmpeg on this machine, skipping:', err.message);
    return;
  }
  hash = (await media.storeMediaStream(projectRoot, 'sine.wav', Readable.from(fs.createReadStream(wav)))).hash;
  // Ground truth: entire asset decoded at once to f32le stereo. Every block cut by the route must
  // match it sample by sample (without guessing ffmpeg's sine phase, directly check against ffmpeg's
  // decoded result)
  const raw = execFileSync(ffmpeg, ['-v', 'error', '-i', wav, '-vn', '-ar', String(SR), '-ac', '2', '-f', 'f32le', 'pipe:1'],
    { windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  truth = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4);
});

const pcm = (query) => fetch(`${origin}/@media/${hash}/pcm?${query}`);
const floats = async (res) => new Float32Array(await res.arrayBuffer());

test('Normal range: returns count × 2 × 4 bytes of f32le interleaved samples', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg');
  const res = await pcm(`start=0&count=4800&sampleRate=${SR}&ch=2`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/octet-stream');
  const data = await floats(res);
  assert.equal(data.length, 4800 * 2);
  assert.equal(Number(res.headers.get('content-length')), 4800 * 2 * 4);
  // Matches the decoded result of the entire asset sample by sample
  assert.deepEqual(Array.from(data), Array.from(truth.subarray(0, 4800 * 2)));
  assert.ok(data.some((v) => v !== 0), 'Not one block of pure silence');
  for (let n = 0; n < 100; n++) assert.equal(data[n * 2], data[n * 2 + 1], 'Both channels are the same');
});

test('Middle range: start is the sample index within the asset', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg');
  const data = await floats(await pcm(`start=12000&count=480&sampleRate=${SR}&ch=2`));
  assert.deepEqual(Array.from(data), Array.from(truth.subarray(12000 * 2, 12480 * 2)));
});

test('Negative start: silence is padded in front, followed by sample 0 of the asset', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg');
  const lead = 240;
  const data = await floats(await pcm(`start=${-lead}&count=480&sampleRate=${SR}&ch=2`));
  assert.equal(data.length, 480 * 2);
  for (let i = 0; i < lead * 2; i++) assert.equal(data[i], 0, `The first ${lead} frames must be silent`);
  // After the silence, it starts from sample 0 of the asset
  assert.deepEqual(Array.from(data.subarray(lead * 2)), Array.from(truth.subarray(0, (480 - lead) * 2)));
});

test('The whole block is before the asset starts: all silence, no ffmpeg started', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg');
  const data = await floats(await pcm(`start=-4800&count=480&sampleRate=${SR}&ch=2`));
  assert.equal(data.length, 960);
  assert.equal(data.every((v) => v === 0), true);
});

test('The tail beyond the asset length is zero-padded', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg');
  const total = SECONDS * SR;
  const data = await floats(await pcm(`start=${total - 240}&count=480&sampleRate=${SR}&ch=2`));
  assert.equal(data.length, 960);
  assert.equal(data.slice(240 * 2).every((v) => v === 0), true, 'The asset is not that long, so the tail is zero-padded');
});

test('Resampling follows sampleRate', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg');
  const data = await floats(await pcm(`start=0&count=2400&sampleRate=24000&ch=2`));
  assert.equal(data.length, 2400 * 2);
});

test('Parameter validation: count / sampleRate / ch out of range all give 400', async (t) => {
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

test('A hash not in the store is 404; pcm is not swallowed by the /@media/<filename> branch', async (t) => {
  if (!ffmpegOk) return t.skip('no ffmpeg');
  const missing = await fetch(`${origin}/@media/${'f'.repeat(64)}/pcm?start=0&count=48&sampleRate=${SR}&ch=2`);
  assert.equal(missing.status, 404);
  assert.notEqual(missing.headers.get('content-type'), 'audio/wav', 'If it reached the file-name branch, "pcm" would be treated as a file name');
});
