// D3:`see_frames` 回包附实体矩形 —— server/vision/render.ts 的 renderFrames 出口。
// 渲染和量框都由 FramePipeline 做(cards-layout.test.mjs 测),这里把它换成假的,
// 只验出口:给模型看的缩图才量、每帧挂 rects、文字部分按 clipId 一行、量不出来不连累图片。
//
// render.ts 是 .ts、兄弟模块不带扩展名,和 asset-service.test 一样用 typescript 转译到临时目录,
// 五个依赖换成桩。跑法:node --test server/test/see-frames-rects.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ts = createRequire(import.meta.url)('typescript');
const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-see-rects-'));
after(() => fs.rmSync(OUT, { recursive: true, force: true }));

const stub = (name, code) => { const file = path.join(OUT, name); fs.writeFileSync(file, code); return pathToFileURL(file).href; };
const frames = stub('frames.mjs', 'export const frameService = () => globalThis.__seeRectsService; export const renderProject = p => p;');
const post = stub('post.mjs', `import fs from 'node:fs/promises';
export async function postFrame({ cards, out }) { await fs.copyFile(cards, out); return { width: 960, height: 540 }; }`);
const http = stub('http.mjs', 'export const outRoot = r => r;');
const pool = stub('pool.mjs', 'export const runExport = async () => null;');
// 单张卡片位图那条路(bitmapOnly):真身借预渲染间截图,这里换成假的,只验 renderFrames 把它分出去、不碰 FramePipeline
const bitmap = stub('card-bitmap.mjs', 'export const cardBitmapScratch = r => r; export const renderCardBitmaps = (...a) => globalThis.__seeRectsBitmaps(...a);');
let src = fs.readFileSync(path.join(ROOT, 'server', 'vision', 'render.ts'), 'utf8');
for (const [a, b] of [['"../vite-plugin-frames"', `"${frames}"`], ['"../png-post.mjs"', `"${post}"`], ['"./http"', `"${http}"`], ['"./card-bitmap"', `"${bitmap}"`], ['"./worker-pool"', `"${pool}"`]]) {
  assert.ok(src.includes(a), `render.ts 里没有 ${a} 这条 import`);
  src = src.split(a).join(b);
}
const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
const { renderFrames, renderOneFrame, entityRectsNote } = await import(stub('render.mjs', js));

const project = { width: 1920, height: 1080, fps: 30, duration: 4, tracks: [] };
const RECTS = [
  { clipId: 'title', box: [0, 0, 1920, 1080], solid: [640, 400, 640, 120] },
  { clipId: 'blank', box: [0, 0, 1920, 1080], solid: null },
];

function fakeService({ rects = () => new Map([[30, RECTS], [60, []]]) } = {}) {
  const calls = { see: [], rects: [] };
  globalThis.__seeRectsService = {
    entry: async () => ({ dir: OUT }),
    see_frames: async (_p, times) => {
      calls.see.push(times);
      return new Map(times.map(t => [Math.round(t * 30), { buf: Buffer.from('png') }]));
    },
    entityRects: async (_p, times, o) => { calls.rects.push({ times, signal: o?.signal }); return rects(); },
  };
  return calls;
}

test('给模型看的缩图(see_frames)每帧挂 rects,文字按 clipId 一行、坐标是舞台像素', async () => {
  const calls = fakeService();
  const notes = [];
  const out = await renderFrames(OUT, '', project, [1, 2], notes, 1, { post: { shrink: true } });
  assert.deepEqual(calls.rects.map(c => c.times), [[1, 2]], '一趟量完所有时刻');
  assert.deepEqual(out.get(30).rects, RECTS);
  assert.deepEqual(out.get(60).rects, []);
  assert.equal(out.get(30).width, 960, '图片照旧(缩图)');
  assert.equal(notes.length, 1);
  const lines = notes[0].split('\n');
  assert.match(lines[0], /舞台 1920×1080 像素坐标 \[x, y, w, h\],图片缩到了 960×540/);
  assert.match(lines[0], /solid 为 null = 这张卡此刻没有实体像素/);
  assert.deepEqual(lines.slice(1), [
    't=1s:',
    'title box=[0, 0, 1920, 1080] solid=[640, 400, 640, 120]',
    'blank box=[0, 0, 1920, 1080] solid=null',
    't=2s:画面上没有片段。',
  ]);
});

test('单帧同一条路:renderOneFrame 也带 rects', async () => {
  fakeService();
  const notes = [];
  const shot = await renderOneFrame(OUT, '', project, 1, notes, 1, { post: { shrink: true } });
  assert.deepEqual(shot.rects, RECTS);
  assert.match(notes.join(' '), /title box=\[0, 0, 1920, 1080\] solid=\[640, 400, 640, 120\]/);
});

test('不缩图的调用方(预渲染贴图、动图)不量;显式 rects: false / true 压过缺省', async () => {
  let calls = fakeService();
  const plain = await renderFrames(OUT, '', project, [1], [], 0, { post: { bg: 'ffffff', stats: true } });
  assert.equal(calls.rects.length, 0);
  assert.equal(plain.get(30).rects, undefined);
  await renderFrames(OUT, '', project, [1], [], 0, {});
  assert.equal(calls.rects.length, 0);
  await renderFrames(OUT, '', project, [1], [], 1, { post: { shrink: true }, rects: false });
  assert.equal(calls.rects.length, 0);
  calls = fakeService();
  const forced = await renderFrames(OUT, '', project, [1], [], 0, { rects: true });
  assert.equal(calls.rects.length, 1);
  assert.deepEqual(forced.get(30).rects, RECTS);
});

test('量不出来不连累图片:记一句话,rects 为 null;某一帧没量到单独标', async () => {
  fakeService({ rects: () => { throw new Error('Chrome 挂了'); } });
  const notes = [];
  const out = await renderFrames(OUT, '', project, [1], notes, 1, { post: { shrink: true } });
  assert.equal(out.get(30).buf.length > 0, true);
  assert.equal(out.get(30).rects, null);
  assert.match(notes[0], /实体矩形没量出来\(Chrome 挂了\),图片不受影响/);

  fakeService({ rects: () => new Map([[30, null]]) });
  const notes2 = [];
  const out2 = await renderFrames(OUT, '', project, [1], notes2, 1, { post: { shrink: true } });
  assert.equal(out2.get(30).rects, null);
  assert.match(notes2[0], /t=1s:没量出来。/);
});

test('调用方撤了就往上抛,不吞成一句话', async () => {
  const controller = new AbortController();
  fakeService({ rects: () => { controller.abort(); throw Object.assign(new Error('Frame request cancelled'), { cancelled: true }); } });
  await assert.rejects(renderFrames(OUT, '', project, [1], [], 1, { post: { shrink: true }, signal: controller.signal }), /cancelled/);
});

test('entityRectsNote:图片没缩就说和图片像素一致', () => {
  const note = entityRectsNote({ width: 1280, height: 720 }, 25, [[25, [{ clipId: 'a', box: [1, 2, 3, 4], solid: null }]]], { width: 1280, height: 720 });
  assert.match(note, /舞台 1280×720 像素坐标 \[x, y, w, h\],和图片像素一致/);
  assert.match(note, /\nt=1s:\na box=\[1, 2, 3, 4\] solid=null$/);
});

test('单张卡片位图(bitmapOnly,bake_card 与 3D 视图贴图):不建帧库条目、不走 see_frames、不量实体框;压底色与透明统计照旧', async () => {
  const calls = fakeService();
  let entries = 0;
  globalThis.__seeRectsService.entry = async () => { entries++; return { dir: OUT }; };
  const asked = [];
  globalThis.__seeRectsBitmaps = async (_root, _origin, _project, times, o) => { asked.push({ times, lane: o.lane }); return new Map(times.map(t => [Math.round(t * 30), Buffer.from('bitmap')])); };
  const plain = await renderFrames(OUT, '', project, [1, 2], [], 0, { bitmapOnly: true, lane: 'prerender' });
  assert.deepEqual(asked, [{ times: [1, 2], lane: 'prerender' }]);
  assert.equal(plain.get(30).buf.toString(), 'bitmap');
  assert.equal(plain.get(60).width, 1920, '不做后处理时宽高就是项目画幅');
  const shot = await renderOneFrame(OUT, '', project, 1, [], 1, { bitmapOnly: true, post: { bg: '0b0f17', stats: true } });
  assert.equal(asked[1].lane, 'agent', '缺省是 Agent 那条队');
  assert.equal(shot.buf.toString(), 'bitmap');
  assert.equal(shot.width, 960, '后处理的结果(宽高、透明占比)照旧带回');
  assert.equal(shot.rects, undefined);
  assert.equal(calls.see.length, 0, '没有调 see_frames');
  assert.equal(calls.rects.length, 0, '没有量实体框');
  assert.equal(entries, 0, '没有建帧库条目');
  assert.deepEqual(fs.readdirSync(OUT).filter(n => n.startsWith('post-')), [], '后处理的临时文件用完就删');
});
