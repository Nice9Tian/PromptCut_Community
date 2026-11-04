// D3: `see_frames` response attaches entity rectangles: renderFrames exit of
// server/vision/render.ts. Rendering and box measurement are both done by FramePipeline
// (tested in cards-layout.test.mjs); replaced with a mock here, only verifying the exit:
// measure only thumbnails shown to models, attach rects to each frame, text portion is
// one line per clipId, failure to measure does not compromise images.
//
// render.ts is .ts and sibling modules have no extensions; like asset-service.test, transpile
// to a temporary directory with typescript, replacing five dependencies with stubs.
// How to run: node --test server/test/see-frames-rects.test.mjs
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
// The single-card bitmap path (bitmapOnly): the real implementation takes screenshots via the
// prerender room; replaced with a mock here, only verifying that renderFrames dispatches it
// without touching FramePipeline
const bitmap = stub('card-bitmap.mjs', 'export const cardBitmapScratch = r => r; export const renderCardBitmaps = (...a) => globalThis.__seeRectsBitmaps(...a);');
let src = fs.readFileSync(path.join(ROOT, 'server', 'vision', 'render.ts'), 'utf8');
for (const [a, b] of [['"../vite-plugin-frames"', `"${frames}"`], ['"../png-post.mjs"', `"${post}"`], ['"./http"', `"${http}"`], ['"./card-bitmap"', `"${bitmap}"`], ['"./worker-pool"', `"${pool}"`]]) {
  assert.ok(src.includes(a), `render.ts has no import for ${a}`);
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

test('Thumbnails shown to the model (see_frames) carry rects on every frame, the text has one line per clipId, and coordinates are stage pixels', async () => {
  const calls = fakeService();
  const notes = [];
  const out = await renderFrames(OUT, '', project, [1, 2], notes, 1, { post: { shrink: true } });
  assert.deepEqual(calls.rects.map(c => c.times), [[1, 2]], 'All times are measured in one pass');
  assert.deepEqual(out.get(30).rects, RECTS);
  assert.deepEqual(out.get(60).rects, []);
  assert.equal(out.get(30).width, 960, 'Images unchanged (thumbnail)');
  assert.equal(notes.length, 1);
  const lines = notes[0].split('\n');
  assert.match(lines[0], /pixel coordinates \[x, y, w, h\] on the 1920×1080 stage, Image was scaled down to 960×540/);
  assert.match(lines[0], /solid null = this card has no solid pixels right now/);
  assert.deepEqual(lines.slice(1), [
    't=1s:',
    'title box=[0, 0, 1920, 1080] solid=[640, 400, 640, 120]',
    'blank box=[0, 0, 1920, 1080] solid=null',
    't=2s: no clips on screen.',
  ]);
});

test('Single frame goes the same way: renderOneFrame also carries rects', async () => {
  fakeService();
  const notes = [];
  const shot = await renderOneFrame(OUT, '', project, 1, notes, 1, { post: { shrink: true } });
  assert.deepEqual(shot.rects, RECTS);
  assert.match(notes.join(' '), /title box=\[0, 0, 1920, 1080\] solid=\[640, 400, 640, 120\]/);
});

test('Callers that do not downscale (prerender textures, animated images) do not measure; an explicit rects: false / true overrides the default', async () => {
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

test('Failing to measure does not affect the image: record one line, rects is null; a frame that was not measured is flagged separately', async () => {
  fakeService({ rects: () => { throw new Error('Chrome crashed'); } });
  const notes = [];
  const out = await renderFrames(OUT, '', project, [1], notes, 1, { post: { shrink: true } });
  assert.equal(out.get(30).buf.length > 0, true);
  assert.equal(out.get(30).rects, null);
  assert.match(notes[0], /Could not measure the entity rectangle \(Chrome crashed\); the image is not affected/);

  fakeService({ rects: () => new Map([[30, null]]) });
  const notes2 = [];
  const out2 = await renderFrames(OUT, '', project, [1], notes2, 1, { post: { shrink: true } });
  assert.equal(out2.get(30).rects, null);
  assert.match(notes2[0], /t=1s: could not be measured\./);
});

test('If the caller cancels, rethrow instead of swallowing it into a one-line note', async () => {
  const controller = new AbortController();
  fakeService({ rects: () => { controller.abort(); throw Object.assign(new Error('Frame request cancelled'), { cancelled: true }); } });
  await assert.rejects(renderFrames(OUT, '', project, [1], [], 1, { post: { shrink: true }, signal: controller.signal }), /cancelled/);
});

test('entityRectsNote: if the image was not scaled, say it matches the image pixels', () => {
  const note = entityRectsNote({ width: 1280, height: 720 }, 25, [[25, [{ clipId: 'a', box: [1, 2, 3, 4], solid: null }]]], { width: 1280, height: 720 });
  assert.match(note, /pixel coordinates \[x, y, w, h\] on the 1280×720 stage, Matches the image pixels/);
  assert.match(note, /\nt=1s:\na box=\[1, 2, 3, 4\] solid=null$/);
});

test('Single card bitmap (bitmapOnly, bake_card and 3D view textures): no frame store entry, no see_frames, no solid box measurement; compositing onto the background color and transparency stats unchanged', async () => {
  const calls = fakeService();
  let entries = 0;
  globalThis.__seeRectsService.entry = async () => { entries++; return { dir: OUT }; };
  const asked = [];
  globalThis.__seeRectsBitmaps = async (_root, _origin, _project, times, o) => { asked.push({ times, lane: o.lane }); return new Map(times.map(t => [Math.round(t * 30), Buffer.from('bitmap')])); };
  const plain = await renderFrames(OUT, '', project, [1, 2], [], 0, { bitmapOnly: true, lane: 'prerender' });
  assert.deepEqual(asked, [{ times: [1, 2], lane: 'prerender' }]);
  assert.equal(plain.get(30).buf.toString(), 'bitmap');
  assert.equal(plain.get(60).width, 1920, 'Without post-processing, width and height equal the project aspect ratio');
  const shot = await renderOneFrame(OUT, '', project, 1, [], 1, { bitmapOnly: true, post: { bg: '0b0f17', stats: true } });
  assert.equal(asked[1].lane, 'agent', 'The default is the Agent lane');
  assert.equal(shot.buf.toString(), 'bitmap');
  assert.equal(shot.width, 960, 'Post-processing results (width, height, transparency ratio) are returned as before');
  assert.equal(shot.rects, undefined);
  assert.equal(calls.see.length, 0, 'see_frames was not called');
  assert.equal(calls.rects.length, 0, 'Solid boxes were not measured');
  assert.equal(entries, 0, 'No frame store entry was created');
  assert.deepEqual(fs.readdirSync(OUT).filter(n => n.startsWith('post-')), [], 'Post-processing temp files are deleted after use');
});
