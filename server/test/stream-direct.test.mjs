/**
 * Unit test for connecting canvas card track stream to producer without going through PNG
 * (render refactor "Ji-1", `docs/plan/prerender-products-contract.md` sections 6.1, 6.2, 9.3).
 * Run: `npm test -- server/test/stream-direct.test.mjs`
 *
 *   - `capture` of `bakeStream`: how to capture this frame is decided by the caller; no screenshot
 *     without calling `shoot()`; when `capture` is omitted, captures every frame as before;
 *   - `StreamProducer.runSegment` (real `bakeStream`, real ffmpeg, mock prerender room): single-card
 *     streams registered as canvas cards use direct capture; output segments are **byte-for-byte
 *     identical** to those produced with direct capture disabled (screenshot every frame); cards
 *     with extra elements outside canvas fall back to screenshots and have diagnostics; cards not
 *     registered as canvas cards and group streams do not query canvas; entity box measured in
 *     sparse pass is identical to that measured via screenshot route;
 *   - Keys: `STREAM_CODE_VERSION` is 2; `CardFrameCache.plan()` computes an additional content key
 *     `streamMemberKey` without the generate-snapshots code fingerprint, used by single-card
 *     streams in `planStreams`; two new pixel-fetching files enter screenshot code fingerprint,
 *     not generate-snapshots code fingerprint.
 * Cases requiring ffmpeg are skipped on machines without ffmpeg.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { bakeStream } from '../bakery/bake.mjs';
import { dropStreamEncoderSpares } from '../bakery/ffmpeg.mjs';
import { StreamProducer, planStreams, STREAM_CODE_VERSION, SEGMENT_FRAMES, SPARSE_STRIDE } from '../frame-stream.mjs';
import { CardFrameCache } from '../card-cache.mjs';
import { cardSnapshotIdentity, cardSampling } from '../card-identity.mjs';
import { captureCode, snapshotCode, invalidateFrameCode } from '../frame-code.mjs';
import { createReadyHub } from '../ready-index.mjs';
import { packTransparentRuns } from '../../src/render/gl/canvasGrab.ts';

const ffmpegOk = spawnSync('ffmpeg', ['-version'], { windowsHide: true }).status === 0;
after(() => dropStreamEncoderSpares());

const ENV_FP = '0123456789abcdef';
const STAGE = { width: 320, height: 180 };
const control = (clipId, start, end, caps, extra = {}) => ({
  clipId, key: `K-${clipId}`, snapshotKey: `S-${clipId}`, capabilities: caps, compositing: 'independent', frameMode: caps.frameMode,
  start, end, count: Math.ceil((end - start) * 30), sampling: { firstFrame: Math.ceil(start * 30), fps: { numerator: '30', denominator: '1' }, phase: { numerator: '0', denominator: '1' } },
  ...extra,
});
const CANVAS_CAPS = { compositing: 'independent', frameMode: 'stateful', canvasHeavy: true };
const DOM_CAPS = { compositing: 'independent', frameMode: 'stateful', canvasHeavy: false };
const projectOf = (clips) => ({ ...STAGE, fps: 30, duration: 2, media: [], tracks: clips.map((c, i) => ({ id: `t${i}`, clips: [c] })) });

/** Pixels in canvas at frame `frame` (stage-sized straight RGBA): moving color block, rest transparent */
function canvasPixels(frame) {
  const data = Buffer.alloc(STAGE.width * STAGE.height * 4);
  const x0 = 20 + frame * 3, y0 = 30 + (frame % 7);
  for (let y = y0; y < y0 + 40; y++) for (let x = x0; x < x0 + 60; x++) {
    const i = (y * STAGE.width + x) * 4;
    data[i] = (x * 5) & 255; data[i + 1] = (y * 3 + frame) & 255; data[i + 2] = 180; data[i + 3] = x % 9 === 0 ? 128 : 255;
  }
  return data;
}
/** An element outside canvas: opaque color block at bottom-left (captured only by screenshot) */
function withOutsideElement(data) {
  const out = Buffer.from(data);
  for (let y = 150; y < 170; y++) for (let x = 10; x < 60; x++) out.fill(255, (y * STAGE.width + x) * 4, (y * STAGE.width + x) * 4 + 4);
  return out;
}
const cropOf = (data, rect) => {
  const out = Buffer.alloc(rect.w * rect.h * 4);
  for (let y = 0; y < rect.h; y++) data.copy(out, y * rect.w * 4, ((rect.y + y) * STAGE.width + rect.x) * 4, ((rect.y + y) * STAGE.width + rect.x + rect.w) * 4);
  return out;
};
const pngOf = (data, width, height) => { const png = new PNG({ width, height }); data.copy(png.data); return PNG.sync.write(png); };

/**
 * Mock prerender room paired with real `bakeStream`: records current frame (`__pcSetT`) and
 * screenshot rectangle (`viewport` in device measurements); screenshot returns PNG in this
 * rectangle at this frame, `__pcGrabCanvas` returns canvas pixels. When `outside` is true,
 * screenshot has one more element than canvas.
 */
function fakeBakery({ outside = false } = {}) {
  const log = { grabs: [], shots: [], primes: 0 };
  let frame = 0, clip = { x: 0, y: 0, w: STAGE.width, h: STAGE.height };
  const bakery = {
    log,
    page: {
      async evaluate(fn, ...args) {
        const src = String(fn);
        if (src.includes('__pcGrabCanvas')) {
          const [clipId, rect] = args;
          log.grabs.push({ frame, clipId, rect });
          const rgba = cropOf(canvasPixels(frame), rect);
          const packed = packTransparentRuns(new Uint8ClampedArray(rgba));
          const bytes = packed ? Buffer.from(packed) : rgba;
          return { ok: true, w: rect.w, h: rect.h, packed: !!packed, b64: bytes.toString('base64'), bytes: bytes.length, readMs: 0, packMs: 0 };
        }
        if (src.includes('__pcTimeline')) return { fps: 30, ...STAGE, duration: 2 };
        if (src.includes('__pcSetT')) { frame = Math.round(args[0].sec * 30); return { raf: 0, mut: 0 }; }
        return null;
      },
      async setViewport() {},
      viewport: () => ({ ...STAGE, deviceScaleFactor: 1 }),
    },
    client: { async send(method, params) { if (method === 'Emulation.setDeviceMetricsOverride' && params.viewport) clip = { x: params.viewport.x, y: params.viewport.y, w: params.viewport.width, h: params.viewport.height }; } },
    async beginFrame(extra = {}) {
      if (extra.screenshot?.format !== 'png') return {};
      log.shots.push(frame);
      const full = outside ? withOutsideElement(canvasPixels(frame)) : canvasPixels(frame);
      return { screenshotData: pngOf(cropOf(full, clip), clip.w, clip.h).toString('base64') };
    },
    async waitNet() {},
    async reset() { bakery.page = { ...bakery.page }; },
  };
  return bakery;
}

/* ------------------------------------------------------------ `capture` in `bakeStream` */

test('bakeStream\'s capture: whatever it returns is what onFrame receives; no screenshot is taken unless shoot is called; primed says whether the next screenshot first discards one', async () => {
  const bakery = fakeBakery();
  const seen = [], primed = [];
  const opts = { streamSignature: 'S', fromFrame: 0, toFrame: 5, stride: 1, fps: 30, mountFrame: 0, clip: { x: 0, y: 0, w: 64, h: 32 } };
  const stats = await bakeStream(bakery, { ...opts,
    capture: async (frame, shoot, info) => {
      primed.push(info.primed);
      if (frame === 0 || frame === 4) return shoot();
      return { rgba: Buffer.alloc(4), width: 1, height: 1, frame };
    },
    onFrame: async (frame, shot) => { seen.push(Buffer.isBuffer(shot) ? 'png' : `raw:${shot.frame}`); } });
  assert.deepEqual(seen, ['png', 'raw:1', 'raw:2', 'raw:3', 'png', 'raw:5']);
  assert.equal(stats.captured, 6);
  // Screenshots occur only on the two frames where shoot was called: frame 0 (no prior screenshot,
  // drop one first) and frame 4 (frame 3 not captured, also drop one first)
  assert.deepEqual([...new Set(bakery.log.shots)], [0, 4]);
  assert.equal(bakery.log.shots.length, 4, 'Each of the two frames takes two screenshots (the first one is discarded)');
  assert.deepEqual(primed, [true, false, true, true, true, false], 'The initial discard is skipped only when the immediately preceding frame took a screenshot');
  // When capture is omitted: captures every frame as before
  const plain = fakeBakery();
  const kinds = [];
  await bakeStream(plain, { ...opts, onFrame: async (_f, shot) => { kinds.push(Buffer.isBuffer(shot)); } });
  assert.deepEqual(kinds, [true, true, true, true, true, true]);
  assert.equal(plain.log.shots.length, 7, 'Discard one on the first frame first, then one per frame afterwards');
  assert.equal(plain.log.grabs.length, 0);
});

/* ------------------------------------------------------------ StreamProducer.runSegment */

async function produce({ mode, caps = CANVAS_CAPS, outside = false, stride = 1, segments = [0, 1] }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-stream-direct-'));
  const pipeline = { root, ready: createReadyHub(), prerenderPicked: () => true, captureCode: () => 'C', emptyUrl: () => 'about:blank' };
  const producer = new StreamProducer(pipeline, { env: { PROMPTCUT_STREAM_DIRECT: mode, PROMPTCUT_STREAM_PREWARM: '0' } });
  producer.attachRoute();
  producer.ffmpeg = 'ffmpeg';
  producer.encoderName = 'libx264';
  const project = projectOf([{ id: 'c', cardId: 'x', start: 0, end: 2 }]);
  const [spec] = planStreams({ key: 'E', project, cardPlan: [control('c', 0, 2, caps)] }, { envFingerprint: ENV_FP });
  const state = { spec, manifest: producer.freshManifest(spec), isolated: {}, generation: 0, entryKey: 'E', aliases: new Set(),
    reserved: new Set(), failures: new Map(), measured: null, measuredSegments: new Set() };
  producer.streams.set(spec.streamKey, state);
  const bakery = fakeBakery({ outside });
  const bytes = [];
  for (const segment of segments) {
    const task = { state, segment, stride };
    assert.equal(await producer.runSegment(bakery, task), true);
    await task.job;
    const seg = state.manifest.segments[segment];
    assert.ok(seg, `Segment ${segment} was written to disk (${producer.log.map(l => l.message).join(' | ')})`);
    bytes.push(await fs.readFile(path.join(producer.store.dir(spec.streamKey), seg.file)));
  }
  const status = producer.status().streams[0];
  await producer.close();
  await fs.rm(root, { recursive: true, force: true });
  return { bytes, bakery, state, status, producer, spec };
}

test('A single-card stream registered as a canvas card uses direct grab: the first frame of each segment grabs the canvas before taking a screenshot, and the remaining frames take no screenshot; the output is byte-identical to per-frame screenshots', { skip: !ffmpegOk }, async () => {
  const off = await produce({ mode: 'off' });
  assert.equal(off.bakery.log.grabs.length, 0, 'With it turned off, the canvas is not asked');
  assert.equal(off.status.direct, null);
  const on = await produce({ mode: 'always' });
  assert.deepEqual(on.bakery.log.grabs.map(g => g.frame), Array.from({ length: 30 }, (_, i) => i), 'The canvas was grabbed on every frame');
  assert.deepEqual([...new Set(on.bakery.log.shots)], [0, 15], 'Only the first frame of each of the two segments takes a screenshot (used for the runtime comparison)');
  assert.deepEqual(on.bakery.log.grabs[0].rect, { x: on.spec.bound.x + on.spec.offset.x, y: on.spec.bound.y + on.spec.offset.y, w: on.spec.bound.w, h: on.spec.bound.h }, 'It asks for the screenshot\'s rectangle');
  assert.equal(on.bakery.log.grabs[0].clipId, 'c');
  assert.equal(on.bytes.length, 2);
  for (const n of [0, 1]) assert.equal(Buffer.compare(on.bytes[n], off.bytes[n]), 0, `Segment ${n}: direct grab and screenshot output are byte-identical`);
  assert.deepEqual([on.status.direct.failed, on.status.direct.segments, on.status.direct.frames, on.status.direct.checks], [null, 2, 30, 2]);
  assert.deepEqual([on.status.direct.last.pass, on.status.direct.last.color, on.status.direct.last.alpha, on.status.direct.last.bad], [true, 0, 0, 0]);
  // Segment signature and manifest contents do not differ for using direct capture (encoder name and
  // rectangle are identical)
  assert.deepEqual(on.state.manifest.segments[0].sig, off.state.manifest.segments[0].sig);
  assert.deepEqual(Object.keys(on.state.manifest.inits), Object.keys(off.state.manifest.inits));
});

test('Default (always tier) and auto tier also produce the same segments: which path is taken only affects speed, never the picture', { skip: !ffmpegOk }, async () => {
  const off = await produce({ mode: 'off', segments: [0] });
  const def = await produce({ mode: undefined, segments: [0] });
  assert.equal(def.producer.direct, 'always');
  assert.equal(Buffer.compare(def.bytes[0], off.bytes[0]), 0);
  assert.equal(def.status.direct.failed, null);
  assert.equal(def.status.direct.checks, 1);
  const auto = await produce({ mode: 'auto', segments: [0] });
  assert.equal(auto.producer.direct, 'auto');
  assert.equal(Buffer.compare(auto.bytes[0], off.bytes[0]), 0);
  assert.equal(auto.status.direct.failed, null);
  assert.equal(auto.status.direct.checks, 1);
});

test('A card with other elements outside the canvas: the runtime comparison finds a difference, this stream falls back to screenshots with a diagnostic; the output is byte-identical to per-frame screenshots', { skip: !ffmpegOk }, async () => {
  const off = await produce({ mode: 'off', outside: true });
  const on = await produce({ mode: 'always', outside: true });
  assert.deepEqual(on.bakery.log.grabs.map(g => g.frame), [0], 'The canvas was asked only on the first frame of the first segment, never again after that');
  assert.equal(on.status.direct.failed, 'differs');
  assert.deepEqual([on.status.direct.segments, on.status.direct.frames], [0, 0]);
  assert.ok(on.status.direct.last.bad > on.status.direct.last.badLimit);
  assert.ok(on.producer.log.some(l => /Direct canvas capture failed \(differs/.test(l.message)), 'One entry was recorded in the diagnostics');
  for (const n of [0, 1]) assert.equal(Buffer.compare(on.bytes[n], off.bytes[n]), 0, `Segment ${n}: after falling back to screenshots, the output is the same as before`);
});

test('A card not registered as a canvas card does not ask the canvas; the content box measured by direct grab in the sparse pass equals the one measured by screenshot', { skip: !ffmpegOk }, async () => {
  const dom = await produce({ mode: 'always', caps: DOM_CAPS, segments: [0] });
  assert.equal(dom.bakery.log.grabs.length, 0);
  assert.equal(dom.status.direct, null);
  const all = [0, 1, 2, 3];
  const off = await produce({ mode: 'off', stride: SPARSE_STRIDE, segments: all });
  const on = await produce({ mode: 'always', stride: SPARSE_STRIDE, segments: all });
  assert.equal(on.bakery.log.grabs.length, all.length * (SEGMENT_FRAMES / SPARSE_STRIDE), 'Sparse segments grab only the first frame of each segment');
  assert.equal(SPARSE_STRIDE, SEGMENT_FRAMES);
  assert.ok(on.state.measured, 'The content box was measured');
  assert.deepEqual(on.state.measured, off.state.measured);
  assert.deepEqual(on.state.manifest.tight, off.state.manifest.tight, 'Tightening yields the same rectangle');
  assert.ok(on.state.manifest.tight && on.state.manifest.tight.w < on.spec.bound.w, 'It was indeed tightened');
  for (const n of all) assert.equal(Buffer.compare(on.bytes[n], off.bytes[n]), 0, `Sparse segment ${n} is byte-identical`);
});

test('directOf: only single-card streams whose member is registered as a canvas card take the direct path; group streams, those that failed the runtime comparison, and segments on cooldown do not; the default always tier never goes on cooldown', () => {
  const pipeline = { root: os.tmpdir(), ready: createReadyHub() };
  const producer = new StreamProducer(pipeline, { env: {} });
  assert.equal(producer.direct, 'always');
  const card = { spec: { kind: 'card', members: [{ capabilities: CANVAS_CAPS }] } };
  assert.ok(producer.directOf(card));
  assert.equal(producer.directOf({ spec: { kind: 'card', members: [{ capabilities: DOM_CAPS }] } }), null);
  assert.equal(producer.directOf({ spec: { kind: 'group', members: [{ capabilities: CANVAS_CAPS }, { capabilities: CANVAS_CAPS }] } }), null);
  assert.equal(producer.directOf({ spec: { kind: 'below', members: [{ capabilities: CANVAS_CAPS }] } }), null, 'Other kinds of streams do not take it');
  assert.equal(producer.directOf({ spec: { kind: 'card' } }), null, 'A stream pulled in from elsewhere has no member information');
  // Default always tier: does not pause for cooldown
  card.direct.cooldown = 2;
  assert.ok(producer.directOf(card));
  card.direct.failed = 'differs';
  assert.equal(producer.directOf(card), null);
  const off = new StreamProducer(pipeline, { env: { PROMPTCUT_STREAM_DIRECT: '0' } });
  assert.equal(off.directOf({ spec: { kind: 'card', members: [{ capabilities: CANVAS_CAPS }] } }), null);
  // Retain cooldown backoff when explicitly passing PROMPTCUT_STREAM_DIRECT: 'auto'
  const auto = new StreamProducer(pipeline, { env: { PROMPTCUT_STREAM_DIRECT: 'auto' } });
  assert.equal(auto.direct, 'auto');
  const autoCard = { spec: { kind: 'card', members: [{ capabilities: CANVAS_CAPS }] } };
  assert.ok(auto.directOf(autoCard));
  // Pause for two segments: skip these two times, retry on the third
  autoCard.direct.cooldown = 2;
  assert.equal(auto.directOf(autoCard), null);
  assert.equal(auto.directOf(autoCard), null);
  assert.ok(auto.directOf(autoCard));
  autoCard.direct.failed = 'differs';
  assert.equal(auto.directOf(autoCard), null);
  // Does not pause even when explicitly passing always tier
  const always = new StreamProducer(pipeline, { env: { PROMPTCUT_STREAM_DIRECT: 'always' } });
  const hot = { spec: { kind: 'card', members: [{ capabilities: CANVAS_CAPS }] } };
  always.directOf(hot);
  hot.direct.cooldown = 5;
  assert.ok(always.directOf(hot));
});

/* ------------------------------------------------------------ Keys (contract section 9.3) */

test('STREAM_CODE_VERSION is 4 (2: canvas direct grab and member key; 3: segments count from the stream\'s own first frame; 4: the sparse version captures only the first frame per segment, and the manifest carries the position rectangle); a single-card stream\'s member key uses streamMemberKey and no longer follows the snapshot\'s content key', () => {
  assert.equal(STREAM_CODE_VERSION, 4);
  const project = projectOf([{ id: 'a', cardId: 'x', start: 0, end: 2 }]);
  const key = (ctl, budget = 6) => planStreams({ key: 'E', project, cardPlan: [ctl] }, { budget, envFingerprint: ENV_FP })[0]?.streamKey;
  const base = control('a', 0, 2, DOM_CAPS, { contentKey: 'C-with-snapshot-code', streamMemberKey: 'M-content-only' });
  assert.equal(key(base), key({ ...base, contentKey: 'C-snapshot-code-changed', snapshotKey: 'S-changed' }), 'The snapshot-generating code changed (the snapshot\'s content key changed), the stream key is unchanged');
  assert.notEqual(key(base), key({ ...base, streamMemberKey: 'M-other-params' }), 'The stream key changes only when the content changes');
  // Old-shape input without streamMemberKey: falls back to content key as usual
  const legacy = control('a', 0, 2, DOM_CAPS, { contentKey: 'C1' });
  assert.notEqual(key(legacy), key({ ...legacy, contentKey: 'C2' }));
  // Code version is included in key
  const spec = (codeVersion) => planStreams({ key: 'E', project, cardPlan: [base] }, { envFingerprint: ENV_FP, codeVersion })[0].streamKey;
  assert.notEqual(spec('1:C'), spec('2:C'));
});

test('CardFrameCache.plan: streamMemberKey is the same content identity without the snapshot-generating code fingerprint; it differs from contentKey', () => {
  const project = { fps: 30, width: 320, height: 180, style: {}, themeId: 'dark' };
  const node = { id: 'card', adapter: 'chrome', cardId: 'demo', params: { n: 1 }, capabilities: { compositing: 'independent', need_prerendering: true, frameMode: 'stateful' }, inputs: {} };
  const graph = { definitions: [], nodes: [node], outputs: [{ nodeId: 'card', clipId: 'clip', start: 0, end: 1, opacity: 1, frame: { x: 0 } }] };
  const cache = new CardFrameCache({ root: os.tmpdir(), project, envFingerprint: ENV_FP });
  const [ctl] = cache.plan(graph);
  assert.match(ctl.streamMemberKey, /^[a-f0-9]{64}$/);
  assert.notEqual(ctl.streamMemberKey, ctl.contentKey, 'The content key carries the snapshot-generating code fingerprint, the member key does not');
  const identity = (code) => cardSnapshotIdentity(node, { definition: undefined, style: {}, environment: {}, sourceVersions: {}, inputKeys: {},
    fps: 30, sampling: cardSampling(0, 30), duration: 1, stage: { width: 320, height: 180, camera3dFov: undefined }, frame: { x: 0 }, themeId: 'dark', fontFingerprint: '', snapshotCode: code });
  assert.equal(ctl.streamMemberKey, identity(''));
  assert.equal(ctl.contentKey, identity(snapshotCode()));
  // When parameters change, member key changes accordingly
  const [other] = cache.plan({ ...graph, nodes: [{ ...node, params: { n: 2 } }] });
  assert.notEqual(other.streamMemberKey, ctl.streamMemberKey);
});

test('The two new pixel-grabbing files go into the screenshot code\'s fingerprint (the stream\'s codeVersion), not into the snapshot-generating code fingerprint', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pc-frame-code-'));
  try {
    const files = ['server/bakery/capture-canvas.mjs', 'src/render/gl/canvasGrab.ts'];
    for (const file of files) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), 'a'); }
    const capture0 = captureCode(root), snapshot0 = snapshotCode(root);
    for (const file of files) {
      fsSync.writeFileSync(path.join(root, file), 'b');
      invalidateFrameCode(root);
      assert.notEqual(captureCode(root), capture0, `${file} changed, the stream's code fingerprint changes with it`);
      assert.equal(snapshotCode(root), snapshot0, `${file} changed, the snapshot-generating code fingerprint stays the same`);
      fsSync.writeFileSync(path.join(root, file), 'a');
      invalidateFrameCode(root);
      assert.equal(captureCode(root), capture0);
    }
  } finally { invalidateFrameCode(root); await fs.rm(root, { recursive: true, force: true }); }
});
