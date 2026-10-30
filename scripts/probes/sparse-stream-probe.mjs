/**
 * 轨道流的稀疏版与满密度版(语义 `docs/semantics/mechanism/rendering.md`「重管线:预渲染」)—— 真 Chrome、真编码器的端到端探针,**比像素**。
 *
 *   node scripts/probes/sparse-stream-probe.mjs (--origin http://127.0.0.1:27860 | --port 27860) [--out <dir>] [--keep] [--json <file>]
 *
 * 给了 `--origin` 就用那台 dev server;给 `--port` 就自己在检出根起一台(另占 +1、+2 当舞台端口),用完按进程号收掉。
 * 本进程里直接起 `FramePipeline`(同预渲染进程的代码),库根放临时目录。三个项目各起一条管线:
 *
 *   甲  两张推帧卡 `r6-stateful`(一块字,每帧横移 10 像素):clip-b 第 40～219 帧、clip-a 第 100～149 帧(都不从 15 的倍数帧开始)
 *   乙  一张按时间直接求值的卡 `probe-slow`(remotion 式;一个橙块,每秒横移 10 像素):clip-c 第 20～110 帧
 *   丙  同乙,但不让自动生产动,照队列的流任务那条路产(`StreamProducer.produceRange`,执行器认领到流任务后调的就是它)
 *
 * 探针在管线上加一道闸:**稀疏版都齐了以后先卡住不补满密度**,核对完稀疏版再放行(闸只在生产者自己判「稀疏的都齐了」之后才起作用,
 * 不改变它挑活的次序)。逐条核对:
 *
 *   1. 次序(看盘):每个分段先落一版稀疏的;稀疏的全部落盘以后才有满密度的分段开工。
 *   2. 稀疏版(甲、乙):每个分段 `stride` 是一个分段的帧数,样本数 = 这一段盖住的帧数;把分段解出来,**每个样本都是同一张**,
 *      而且这一张最像的是这个分段的第一帧(甲:和前后各两帧比;乙:画面每帧只动三分之一像素,和前后各一个分段的第一帧比)。
 *      乙是 remotion 式:分段之间直接跳、不重灌工程(记重灌次数)。
 *   3. 位置矩形:清单里每个分段的 `box`(平面坐标)和「这个分段第一帧的参照画面里不透明像素的外接框」对得上(各边差不超过 1 像素);
 *      收紧矩形盖住所有分段的 `box`。
 *   4. 舞台贴稀疏版(甲):时间设到一个分段中间的帧,舞台上这张卡那一条画的是**分段第一帧**的画面(不是这一帧的)。
 *   5. 放行以后补满密度:每个分段换成 `stride` 1,`box` 原样留着;每个分段的头、中、尾各抽一个样本,最像的是它自己那一帧;
 *      **不裁内容**:这个分段里每一帧的参照画面的不透明区域都落在这个分段的矩形里(字每帧横移,稀疏那一趟量不到两张之间走到哪,
 *      补密时顶到收紧矩形的边要放大重来;记放大了几次)。
 *   6. 舞台换上满密度(甲):舞台停在一个分段中间、正贴着稀疏版时,满密度补齐了。不动播放头,等流播放器自己再问一次清单
 *      (它停在稀疏段上时按 `MANIFEST_REFRESH_MS` 定时重问):这一帧从「分段第一帧的画面」换成这一帧自己的画面。之后逐帧往后走
 *      (每一步就是播放的一拍,走过十来个分段边界):每一拍画的都是这一帧自己,没有一拍画错、没有一拍退回稀疏版。
 *      (被换掉的稀疏分段文件,生产者过 `REPLACED_DELETE_MS` 才删;探针把它们留一份、文件删了以后照样给,免得播放器重问清单之前
 *      去取一个刚删掉的文件。给过几次记在结果里。)
 *   7. 队列那条路(丙):稀疏流任务产出稀疏的分段(带 `box`);再做一次一帧都不截;满密度任务在同一条流上补成满密度;
 *      之后再来稀疏流任务不降级。
 *
 * 输出 JSON 结论,过程写 stderr;任何一条不过就以非零退出。耗时只记录。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { serve, flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { handleStreamRequest, SPARSE_STRIDE } from '../../server/frame-stream.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { findFfmpeg, dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';
import { decodePngRgba, rgbaAlphaBox } from '../../server/bakery/capture-canvas.mjs';
import { startDevServer, emptyUrlOf, decodeSegment, newError, tallyDecodedDirect, sleep, round2 } from './below-stream-common.mjs';
import { streamPlanesFor } from '../../src/render/streamPlayer.ts';
import { STREAM_SEGMENT_FRAMES, streamSegmentFirstFrame, streamSegmentFrameCount, streamSegmentOf } from '../../src/render/streamSegments.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-sparse-stream-probe-${Date.now().toString(36)}`));
process.env.PROMPTCUT_STREAM_POOL = '1';
if (!ORIGIN && !PORT) { console.error('要给 --origin <dev server> 或 --port <自己起一台>'); process.exit(2); }

const FPS = 30, WIDTH = 1280, HEIGHT = 720, DURATION = 9;
/** 入点、出点按秒写,落在两帧之间(帧号除以 30 多数不是有限小数,直接换成秒会差一帧) */
const ROWS = { 'clip-a': [40, 340], 'clip-b': [380, 680] };
const card = (id, cardId, start, end, frame, params = {}) => ({ id, kind: 'card', cardId, start, end, params, frame });
const projectOf = (id, tracks) => ({ id, name: id, width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {}, tracks });
const PROJECT = projectOf('sparse-stream-probe', [
  { id: 'tr-a', name: 'a', hidden: false, clips: [card('clip-a', 'r6-stateful', 3.32, 4.99, { x: 0, y: 40, w: WIDTH, h: 300 })] },
  { id: 'tr-b', name: 'b', hidden: false, clips: [card('clip-b', 'r6-stateful', 1.32, 7.32, { x: 0, y: 380, w: WIDTH, h: 300 })] },
]);
const DIRECT = (id) => projectOf(id, [
  { id: 'tr-c', name: 'c', hidden: false, clips: [card('clip-c', 'probe-slow', 0.65, 3.69, { x: 0, y: 0, w: WIDTH, h: HEIGHT }, { burnMs: 0, label: 'direct' })] },
]);
const WANT = { 'clip-a': [100, 149], 'clip-b': [40, 219], 'clip-c': [20, 110] };

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); say('FAIL', { label, extra }); } return cond; };
async function until(label, fn, timeoutMs, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await sleep(everyMs);
  }
}

/** 一串 PNG(帧号 → 字节),按需解成 straight RGBA,只留最近用过的几十张 */
function frameStore() {
  const png = new Map(), cache = new Map();
  return {
    put: (frame, buf) => png.set(frame, Buffer.from(buf)),
    png: (frame) => png.get(frame),
    rgba(frame) {
      if (cache.has(frame)) return cache.get(frame);
      const data = decodePngRgba(png.get(frame))?.data;
      if (!data) throw new Error(`解不开第 ${frame} 帧的参照`);
      cache.set(frame, data);
      if (cache.size > 48) cache.delete(cache.keys().next().value);
      return data;
    },
  };
}
/** 导出页顺推、每帧截一张整幅(透明底):参照,与分段、与稀疏不稀疏都无关 */
async function exportFrames(bakery, project, emptyUrl, last, dir) {
  const store = frameStore();
  await bakery.reset(project, emptyUrl);
  bakery.streamLease = null;
  await bakeFrames(bakery, { out: dir, fps: FPS, frames: `0-${last}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
    onFrame: async (i, buf) => { store.put(i, buf); } });
  return store;
}
/** 解出来的一帧(编码画面)和一幅参照(整幅 straight RGBA)在 `rect` 里的差:预乘色和不透明度的平均差(满分 255) */
function decodedDiff(picture, rect, truth) {
  const e = newError();
  tallyDecodedDirect(e, picture, rect, truth, WIDTH);
  return e.count ? e.sum / e.count : 0;
}
/** 两个解出来的样本逐字节的平均差 */
function sampleDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}
function rgbOver(buf, bg = [0x20, 0x20, 0x20]) {
  const png = PNG.sync.read(buf);
  const out = new Uint8Array(png.width * png.height * 3);
  for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
    const a = png.data[i + 3] / 255;
    for (let k = 0; k < 3; k++) out[j + k] = Math.round(png.data[i + k] * a + bg[k] * (1 - a));
  }
  return { width: png.width, height: png.height, rgb: out };
}
/** 两幅 RGB 在第 y0～y1 行里的平均差 */
function rowsDiff(a, b, [y0, y1]) {
  let sum = 0;
  const from = y0 * a.width * 3, to = y1 * a.width * 3;
  for (let i = from; i < to; i++) sum += Math.abs(a.rgb[i] - b.rgb[i]);
  return sum / (to - from);
}
const toPng = (img) => { const png = new PNG({ width: img.width, height: img.height }); for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) { png.data[i] = img.rgb[j]; png.data[i + 1] = img.rgb[j + 1]; png.data[i + 2] = img.rgb[j + 2]; png.data[i + 3] = 255; } return PNG.sync.write(png); };
const inside = (inner, outer, slack = 0) => inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.w <= outer.x + outer.w + slack && inner.y + inner.h <= outer.y + outer.h + slack;
const near = (a, b, slack = 1) => !!a && !!b && Math.abs(a.x - b.x) <= slack && Math.abs(a.y - b.y) <= slack && Math.abs(a.x + a.w - b.x - b.w) <= slack && Math.abs(a.y + a.h - b.y - b.h) <= slack;
/** 参照画面(整幅)里不透明像素的外接框,裁到 `sceneRect` 以内,换成平面坐标;没有回 null */
function truthBox(data, sceneRect, offset) {
  const b = rgbaAlphaBox(data, WIDTH, HEIGHT);
  if (!b) return null;
  const x0 = Math.max(b.x, sceneRect.x), y0 = Math.max(b.y, sceneRect.y), x1 = Math.min(b.x + b.w, sceneRect.x + sceneRect.w), y1 = Math.min(b.y + b.h, sceneRect.y + sceneRect.h);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0 - offset.x, y: y0 - offset.y, w: x1 - x0, h: y1 - y0 };
}

const hostHtml = (oa, ob) => `<!doctype html><html><head><meta charset="utf-8"><title>sparse stream probe host</title></head>
<body style="margin:0;background:#202020">
<iframe id="a" src="${oa}/?stage=1&id=A&preview=stage&prerender=1" style="width:${WIDTH}px;height:${HEIGHT}px;border:0;display:block"></iframe>
<iframe id="b" src="${ob}/?stage=1&id=B&preview=stage&prerender=1" style="width:${WIDTH}px;height:${HEIGHT}px;border:0;display:block;opacity:0;pointer-events:none;position:absolute;left:0;top:0"></iframe>
<script type="module">
function createStageRpc(target, targetOrigin) {
  let nextId = 1; const pending = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== target) return; const d = e.data;
    if (d && d.type === 'pc-rpc-reply') { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.ok ? p.resolve(d.result) : p.reject(new Error(d.error)); }
  });
  const call = (method) => (...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); target.postMessage({ type: 'pc-rpc', id, method, args }, targetOrigin); });
  const c = {};
  for (const m of ['setProject', 'setTime', 'setRole', 'play', 'pause', 'setSuppressed', 'setStreamPlanes', 'setPlaying']) c[m] = call(m);
  return c;
}
const waitReady = (frame, targetOrigin) => new Promise((res) => {
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    res(createStageRpc(frame.contentWindow, targetOrigin));
  });
});
window.__ready = Promise.all([waitReady(document.getElementById('a'), '${oa}'), waitReady(document.getElementById('b'), '${ob}')])
  .then(([a, b]) => { window.__rpc = a; window.__rpcB = b; return true; });
</script></body></html>`;

/** 起一条管线:钉成重卡;加「稀疏的都齐了以后先卡住」的闸;记每个分段开工、落盘的先后 */
function openPipeline(root, origin, { frozen = false } = {}) {
  const pipeline = new FramePipeline({ root, origin: () => origin, interactive: true, playhead: () => null });
  pipeline.streamPicked = () => true;
  const producer = pipeline.streamProducer();
  producer.attachRoute();
  const gate = { hold: true, frozen };
  const busy = pipeline.streamBusy.bind(pipeline);
  pipeline.streamBusy = (now) => busy(now) || gate.frozen || (gate.hold && producer.streams.size > 0 && !producer.encoding.size && !producer.needsSparseAnywhere());
  const events = [];
  const run = producer.runSegment.bind(producer);
  producer.runSegment = (bakery, task) => { events.push({ ev: 'start', key: task.state.spec.streamKey, n: task.segment, stride: task.stride, at: Date.now(), seq: events.length }); return run(bakery, task); };
  const store = producer.storeSegment.bind(producer);
  producer.storeSegment = async (state, generation, o) => { const r = await store(state, generation, o); events.push({ ev: 'stored', key: state.spec.streamKey, n: o.segment, stride: o.stride, at: Date.now(), seq: events.length }); return r; };
  const layers = new Map();
  pipeline.readyIndex.subscribe((message) => { if (message.type === 'layer' && message.kind === 'stream') layers.set(message.clipId, message); });
  return { pipeline, producer, gate, events, layers };
}
const allAt = (producer, want) => {
  const s = producer.status();
  if (!s.streams.length) return null;
  for (const row of s.streams) for (let n = row.firstSegment; n <= row.lastSegment; n++) if (!want(row.segments[n])) return null;
  return !producer.encoding.size ? s : null;
};
const segmentsOf = (state) => { const out = []; for (let n = state.spec.firstSegment; n <= state.spec.lastSegment; n++) out.push(n); return out; };

const out = { out: OUT, project: { width: WIDTH, height: HEIGHT, fps: FPS, clips: WANT }, sparseStride: SPARSE_STRIDE };
await fs.mkdir(OUT, { recursive: true });
let dev = null, bakery = null, browser = null, hostServer = null;
const pipelines = [];
const started = Date.now();
try {
  check(SPARSE_STRIDE === STREAM_SEGMENT_FRAMES, '稀疏版只有一档:每个分段一张');
  const ffmpeg = await findFfmpeg();
  let origin = ORIGIN;
  if (!origin) { dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'sparseprobe' }); origin = dev.origin; say('spawn', { pid: dev.pid, port: PORT }); }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;
  const emptyUrl = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
  bakery = await openBakery({ url: emptyUrl });

  /** 把一个分段解出来:回每个样本的画面、矩形(场景坐标) */
  const decodeOf = async (producer, state, n, dir, name) => {
    const { spec, manifest } = state;
    const seg = manifest.segments[n];
    const meta = manifest.inits[seg.init];
    const rect = { x: meta.rect.x + spec.offset.x, y: meta.rect.y + spec.offset.y, w: meta.rect.w, h: meta.rect.h };
    const init = await fs.readFile(producer.store.initFile(spec.streamKey, seg.init));
    const bytes = await fs.readFile(path.join(producer.store.dir(spec.streamKey), seg.file));
    const decoded = await decodeSegment(ffmpeg, init, bytes, dir, name);
    const frameBytes = rect.w * 2 * (rect.h + 8) * 3;
    const samples = [];
    for (let k = 0; (k + 1) * frameBytes <= decoded.length; k++) samples.push(decoded.subarray(k * frameBytes, (k + 1) * frameBytes));
    return { seg, rect, samples, exact: decoded.length === seg.samples * frameBytes };
  };

  /** 稀疏版逐段核对(第 2、3 条)。`direct`:画面每帧只动一点,候选换成前后各一个分段的第一帧 */
  const checkSparse = async (tag, producer, state, truth, dir, { direct }) => {
    const { spec, manifest } = state;
    const [originFrame, lastFrame] = [spec.originFrame, spec.lastFrame];
    const boundScene = { x: manifest.bound.x + spec.offset.x, y: manifest.bound.y + spec.offset.y, w: manifest.bound.w, h: manifest.bound.h };
    const record = { tag, segments: [], wrong: [], notSame: [], boxOff: [] };
    let union = null;
    for (const n of segmentsOf(state)) {
      const first = streamSegmentFirstFrame(n, originFrame);
      const count = streamSegmentFrameCount(n, originFrame, lastFrame);
      const d = await decodeOf(producer, state, n, dir, `sparse-${n}`);
      if (!check(d.seg.stride === SPARSE_STRIDE && d.seg.samples === count && d.exact, `${tag}#${n}:稀疏版,样本数 = 这一段盖住的帧数`, { stride: d.seg.stride, samples: d.seg.samples, count, decoded: d.samples.length })) continue;
      // 每个样本都是同一张
      const worst = Math.max(0, ...d.samples.slice(1).map((s) => sampleDiff(s, d.samples[0])));
      if (worst > 1.5) record.notSame.push({ n, worst: round2(worst) });
      // 这一张最像分段的第一帧
      const candidates = direct
        ? [n - 1, n, n + 1].filter((m) => m >= 0 && m <= spec.lastSegment).map((m) => streamSegmentFirstFrame(m, originFrame))
        : [first - 2, first - 1, first, first + 1, first + 2].filter((c) => c >= originFrame && c <= lastFrame);
      for (const k of [0, d.samples.length - 1]) {
        const scores = candidates.map((c) => [c, decodedDiff(d.samples[k], d.rect, truth.rgba(c))]).sort((x, y) => x[1] - y[1]);
        if (scores[0][0] !== first) record.wrong.push({ n, sample: k, first, best: scores[0][0], scores: scores.map(([c, v]) => [c, round2(v)]) });
      }
      // 位置矩形
      const want = truthBox(truth.rgba(first), boundScene, spec.offset);
      const got = d.seg.box;
      const ok = want === null ? got === null : near(got, want, 1);
      if (!ok) record.boxOff.push({ n, first, got, want });
      if (got) union = union ? { x: Math.min(union.x, got.x), y: Math.min(union.y, got.y), w: Math.max(union.x + union.w, got.x + got.w) - Math.min(union.x, got.x), h: Math.max(union.y + union.h, got.y + got.h) - Math.min(union.y, got.y) } : { ...got };
      record.segments.push({ n, first, samples: d.seg.samples, box: got, sameWorst: round2(worst) });
    }
    record.bound = manifest.bound; record.tight = manifest.tight ?? null; record.union = union;
    check(record.segments.length === spec.lastSegment + 1, `${tag}:每个分段都有一版稀疏的`, record.segments.length);
    check(record.notSame.length === 0, `${tag}:稀疏版每个分段里的样本都是同一张`, record.notSame);
    check(record.wrong.length === 0, `${tag}:稀疏版那一张最像的是分段的第一帧`, record.wrong.slice(0, 4));
    check(record.boxOff.length === 0, `${tag}:位置矩形和分段第一帧的不透明区域对得上(各边差 ≤ 1 像素)`, record.boxOff.slice(0, 4));
    check(!!manifest.tight && (!union || inside(union, manifest.tight)), `${tag}:稀疏版齐了以后定了收紧矩形,盖住所有分段的位置矩形`, { tight: manifest.tight, union });
    const rows = producer.status().streams.find((r) => r.streamKey === spec.streamKey || r.key === spec.streamKey);
    if (rows) check(Object.values(rows.segments).every((s) => 'box' in s), `${tag}:状态里每个分段带着位置矩形`);
    return record;
  };

  /** 满密度逐段核对(第 5 条) */
  const checkDense = async (tag, producer, state, truth, dir, sparseRecord, { direct }) => {
    const { spec, manifest } = state;
    const [originFrame, lastFrame] = [spec.originFrame, spec.lastFrame];
    const record = { tag, wrong: [], clipped: [], boxChanged: [], rects: new Set() };
    for (const n of segmentsOf(state)) {
      const first = streamSegmentFirstFrame(n, originFrame);
      const count = streamSegmentFrameCount(n, originFrame, lastFrame);
      const d = await decodeOf(producer, state, n, dir, `dense-${n}`);
      if (!check(d.seg.stride === 1 && d.seg.samples === count && d.exact, `${tag}#${n}:满密度`, { stride: d.seg.stride, samples: d.seg.samples, count })) continue;
      record.rects.add(JSON.stringify(d.rect));
      const before = sparseRecord.segments.find((s) => s.n === n)?.box;
      if (JSON.stringify(d.seg.box ?? null) !== JSON.stringify(before ?? null)) record.boxChanged.push({ n, before, after: d.seg.box });
      if (!direct) {
        for (const k of [...new Set([0, Math.floor(count / 2), count - 1])]) {
          const f = first + k;
          const scores = [f - 2, f - 1, f, f + 1, f + 2].filter((c) => c >= originFrame && c <= lastFrame).map((c) => [c, decodedDiff(d.samples[k], d.rect, truth.rgba(c))]).sort((x, y) => x[1] - y[1]);
          if (scores[0][0] !== f) record.wrong.push({ n, sample: k, frame: f, best: scores[0][0] });
        }
      }
      // 不裁内容:这一段每一帧的不透明区域都在这一段的矩形里
      const boundScene = { x: manifest.bound.x + spec.offset.x, y: manifest.bound.y + spec.offset.y, w: manifest.bound.w, h: manifest.bound.h };
      for (let k = 0; k < count; k++) {
        const box = truthBox(truth.rgba(first + k), boundScene, spec.offset);
        const rectPlane = { x: d.rect.x - spec.offset.x, y: d.rect.y - spec.offset.y, w: d.rect.w, h: d.rect.h };
        if (box && !inside(box, rectPlane)) record.clipped.push({ n, frame: first + k, box, rect: rectPlane });
      }
    }
    record.rects = [...record.rects].map((r) => JSON.parse(r));
    record.widened = state.widened ?? 0;
    record.tight = manifest.tight ?? null;
    check(record.wrong.length === 0, `${tag}:满密度的样本最像的是它自己那一帧`, record.wrong.slice(0, 4));
    check(record.boxChanged.length === 0, `${tag}:补成满密度以后位置矩形原样留着`, record.boxChanged.slice(0, 4));
    check(record.clipped.length === 0, `${tag}:满密度的分段没有裁掉内容(每一帧的不透明区域都在这一段的矩形里)`, record.clipped.slice(0, 4));
    return record;
  };

  /** 次序(第 1 条):稀疏的全部落盘以后才有满密度的开工 */
  const checkOrder = (tag, events, total) => {
    const sparseStored = events.filter((e) => e.ev === 'stored' && e.stride > 1);
    const denseStart = events.filter((e) => e.ev === 'start' && e.stride === 1);
    const lastSparse = Math.max(-1, ...sparseStored.map((e) => e.seq));
    const firstDense = Math.min(Infinity, ...denseStart.map((e) => e.seq));
    const summary = { sparseStored: sparseStored.length, denseStarted: denseStart.length, lastSparseSeq: lastSparse, firstDenseSeq: Number.isFinite(firstDense) ? firstDense : null,
      strides: [...new Set(events.filter((e) => e.ev === 'start').map((e) => e.stride))] };
    check(new Set(sparseStored.map((e) => `${e.key}#${e.n}`)).size === total, `${tag}:每个分段都先落了一版稀疏的`, summary);
    check(denseStart.length >= total && firstDense > lastSparse, `${tag}:稀疏的全部落盘以后满密度的才开工`, summary);
    check(summary.strides.every((s) => s === 1 || s === SPARSE_STRIDE), `${tag}:只有两种密度(每段一张、每帧一张)`, summary.strides);
    return summary;
  };

  // ================================================================ 甲:两张推帧卡
  const A = openPipeline(path.join(OUT, 'library-a'), origin);
  pipelines.push(A.pipeline);
  let t0 = Date.now();
  await A.pipeline.preload(PROJECT);
  if (!(await until('甲:稀疏版齐了', () => allAt(A.producer, (s) => !!s), 600_000))) throw new Error(`甲的稀疏版没产完:${JSON.stringify(A.producer.status().log.slice(-8))}`);
  await sleep(600);
  out.a = { sparseMs: Date.now() - t0 };
  const statesA = [...A.producer.streams.values()];
  check(statesA.length === 2 && statesA.every((s) => s.spec.kind === 'card'), '甲:两条单卡流', statesA.map((s) => s.spec.kind));
  check(statesA.every((s) => segmentsOf(s).every((n) => s.manifest.segments[n]?.stride === SPARSE_STRIDE)), '甲:闸卡住时每个分段都是稀疏版(没有满密度的)');
  const truthA = new Map(), sparseA = new Map();
  for (const state of statesA) {
    const clip = state.spec.topClipId, [o, l] = WANT[clip];
    check(state.spec.originFrame === o && state.spec.lastFrame === l, `甲 ${clip}:第 ${o}～${l} 帧`, { originFrame: state.spec.originFrame, lastFrame: state.spec.lastFrame });
    const dir = path.join(OUT, `ref-${clip}`);
    await fs.mkdir(dir, { recursive: true });
    truthA.set(clip, await exportFrames(bakery, state.isolated, emptyUrl, l, dir));
    sparseA.set(clip, await checkSparse(`甲 ${clip}`, A.producer, state, truthA.get(clip), dir, { direct: false }));
  }
  out.a.sparse = [...sparseA.values()].map((r) => ({ tag: r.tag, bound: r.bound, tight: r.tight, union: r.union, segments: r.segments }));
  say('a-sparse', { ms: out.a.sparseMs, streams: out.a.sparse.map((r) => ({ tag: r.tag, tight: r.tight, boxes: r.segments.map((s) => s.box && [s.box.x, s.box.y, s.box.w, s.box.h]) })) });

  // ---------- 舞台贴稀疏版(第 4 条)
  const refDir = path.join(OUT, 'ref-project');
  await fs.mkdir(refDir, { recursive: true });
  const exported = await exportFrames(bakery, PROJECT, emptyUrl, 221, refDir);
  const exportRgb = new Map();
  const exportOf = (f) => { if (!exportRgb.has(f)) { exportRgb.set(f, rgbOver(exported.png(f))); if (exportRgb.size > 24) exportRgb.delete(exportRgb.keys().next().value); } return exportRgb.get(f); };
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  if (!ports.ok || !Array.isArray(ports.ports) || ports.ports.length < 2) throw new Error(`舞台端口没起来:${JSON.stringify(ports)}`);
  const u = new URL(origin);
  const [originA, originB] = ports.ports.slice(0, 2).map((p) => `${u.protocol}//${u.hostname}:${p}`);
  const HOST_PATH = '/__sparse-stream-probe-host';
  /** 放行之前留下的稀疏分段(`<流键>/<文件名>` → 字节):文件被换掉、删了以后照样给(理由见文件头第 6 条) */
  const sparseKept = new Map();
  let servedKept = 0;
  hostServer = await serve(0, (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === HOST_PATH) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(hostHtml(originA, originB)); return; }
    const parts = url.pathname.split('/');
    const keptId = `${parts.find((p) => /^[0-9a-f]{64}$/.test(p)) ?? ''}/${decodeURIComponent(parts.at(-1) ?? '')}`;
    if (sparseKept.has(keptId) && !existsSync(A.producer.store.segFile(...keptId.split('/')))) {
      servedKept++;
      const buf = sparseKept.get(keptId);
      res.setHeader('Content-Type', 'video/mp4'); res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Length', buf.length); res.end(req.method === 'HEAD' ? undefined : buf);
      return;
    }
    if (url.pathname.startsWith('/api/frames/') && handleStreamRequest(A.producer.store, req, res, url.pathname.slice('/api/frames'.length))) return;
    res.statusCode = 404; res.end();
  }, '127.0.0.1');
  const base = `http://127.0.0.1:${hostServer.address().port}`;
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  const frameA = () => page.frames().find((f) => f.url().startsWith(originA));
  const frameB = () => page.frames().find((f) => f.url().startsWith(originB));
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const rpcB = (method, ...a) => page.evaluate((m, a2) => window.__rpcB[m](...a2), method, a);
  const heavy = ['clip-a', 'clip-b'];
  const planesAt = (f) => streamPlanesFor([...A.layers.values()], new Set(heavy), f);
  /** (重新)打开父页和两个舞台:流播放器从头建(它问清单的节流按舞台的虚拟时钟算,往回拖以后要等很久才再问,换一页最干净) */
  const openStage = async () => {
    await page.goto(base + HOST_PATH);
    await page.waitForFunction(() => window.__ready, { timeout: 120000 });
    await page.evaluate(() => window.__ready);
    for (const f of [frameA(), frameB()]) await f.evaluate((b) => { window.__pcStreamBase = b; }, base);
    await rpc('setProject', PROJECT, { reset: true });
    await rpcB('setProject', PROJECT, { reset: true });
    await rpc('setRole', 'front');
    await rpcB('setRole', 'back', { job: 'probe' });
    await rpc('setTime', 40 / FPS);
    await rpc('setPlaying', true);
    await rpc('setSuppressed', heavy);
  };
  await openStage();
  const iframeBox = await (await page.$('#a')).boundingBox();
  const shotStage = async () => {
    await frameA().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } });
    return rgbOver(await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } }));
  };
  /** 把时间设到第 f 帧(流平面照这一帧给),等每条在场的流画出这一帧;画出来以后照父页每拍都发的那样再发一次流平面(让舞台重算占位符) */
  const seekTo = async (f) => {
    const planes = planesAt(f);
    await rpc('setStreamPlanes', planes);
    const got = await frameA().evaluate(async (frame, fps, want) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const start = now();
      await window.__pcStage.setTime(frame / fps + 1e-4);
      for (;;) {
        const tracks = window.__pcStageDiag().streams.tracks;
        if (tracks.length === want && tracks.every((t) => t.lastDrawn === frame)) return { ms: +(now() - start).toFixed(1) };
        if (now() - start > 8000) return { ms: null, drawn: tracks.map((t) => t.lastDrawn), errors: tracks.map((t) => t.lastError), tracks: tracks.length };
        await wait(2);
      }
    }, f, FPS, onStage(f).length);
    await rpc('setStreamPlanes', planes);
    await sleep(60);
    return { planes, got };
  };
  /** 舞台上这张卡那一条(几行)最像导出页的哪一帧 */
  const bestOf = (stage, clip, candidates) => {
    const scores = [...new Set(candidates)].map((c) => [c, rowsDiff(stage, exportOf(c), ROWS[clip])]).sort((x, y) => x[1] - y[1]);
    return { best: scores[0][0], scores: scores.map(([c, v]) => [c, round2(v)]) };
  };
  const segFirst = (clip, f) => streamSegmentFirstFrame(streamSegmentOf(f, WANT[clip][0]), WANT[clip][0]);
  const onStage = (f) => Object.keys(ROWS).filter((clip) => f >= WANT[clip][0] && f <= WANT[clip][1]);
  {
    const rows = [];
    for (const f of [47, 62, 96, 107, 112, 127]) {
      const { got } = await seekTo(f);
      if (!check(got.ms !== null, `舞台贴稀疏版:第 ${f} 帧流平面画出来了`, got)) continue;
      const stage = await shotStage();
      for (const clip of onStage(f)) {
        const first = segFirst(clip, f);
        const r = bestOf(stage, clip, [first, f, f - 1]);
        rows.push({ frame: f, clip, segmentFirst: first, ...r });
        if (f === 47) await fs.writeFile(path.join(OUT, 'stage-sparse-47.png'), toPng(stage));
      }
    }
    out.a.stageSparse = rows;
    say('a-stage-sparse', { rows: rows.map((r) => [r.frame, r.clip, r.segmentFirst, r.best]) });
    check(rows.length >= 8, '舞台贴稀疏版:几帧都比过了', rows.length);
    check(rows.every((r) => r.best === r.segmentFirst), '舞台贴稀疏版:分段中间的帧,画的是分段第一帧的画面', rows.filter((r) => r.best !== r.segmentFirst));
    await fs.writeFile(path.join(OUT, 'export-40.png'), toPng(exportOf(40)));
    await fs.writeFile(path.join(OUT, 'export-47.png'), toPng(exportOf(47)));
  }
  // 换一页(流播放器从头建),停在第 47 帧(clip-b 的第 0 段中间,贴着稀疏版),然后放行补满密度
  await openStage();
  await seekTo(41);
  {
    const { got } = await seekTo(47);
    const r = got.ms === null ? null : bestOf(await shotStage(), 'clip-b', [40, 46, 47]);
    check(r?.best === 40, '舞台:放行之前停在第 47 帧,贴的是稀疏版(第 40 帧的画面)', r ?? got);
  }

  for (const state of statesA) for (const n of segmentsOf(state)) {
    const file = state.manifest.segments[n].file;
    sparseKept.set(`${state.spec.streamKey}/${file}`, await fs.readFile(A.producer.store.segFile(state.spec.streamKey, file)));
  }

  // ---------- 放行:补满密度(第 5 条)
  t0 = Date.now();
  A.gate.hold = false;
  A.producer.kick();
  if (!(await until('甲:满密度齐了', () => (allAt(A.producer, (s) => s?.stride === 1) && !A.producer.workers.size ? true : null), 900_000))) throw new Error(`甲的满密度没产完:${JSON.stringify(A.producer.status().log.slice(-8))}`);
  out.a.denseMs = Date.now() - t0;
  out.a.order = checkOrder('甲', A.events, statesA.reduce((sum, s) => sum + s.spec.lastSegment + 1, 0));
  out.a.dense = [];
  for (const state of statesA) {
    const clip = state.spec.topClipId;
    const dir = path.join(OUT, `ref-${clip}`);
    const r = await checkDense(`甲 ${clip}`, A.producer, state, truthA.get(clip), dir, sparseA.get(clip), { direct: false });
    out.a.dense.push({ tag: r.tag, widened: r.widened, tight: r.tight, rects: r.rects, clipped: r.clipped.length, wrong: r.wrong.length });
  }
  out.a.widenLog = A.producer.status().log.filter((line) => /放大/.test(String(line?.message ?? line))).length;
  say('a-dense', { ms: out.a.denseMs, order: out.a.order, dense: out.a.dense });

  // ---------- 舞台换上满密度(第 6 条):先不动播放头,等停着的那一帧自己换上;再从第 48 帧起逐帧往后走(每一步一拍)
  {
    // 停在第 47 帧不动:流播放器停在稀疏段上会定时重问清单,问到满密度就把这一帧换成它自己的画面
    const tWait = Date.now();
    let upgraded = null, lastSeen = null;
    while (Date.now() - tWait < 20_000) {
      await rpc('setStreamPlanes', planesAt(47));
      lastSeen = bestOf(await shotStage(), 'clip-b', [40, 46, 47, 48]);
      if (lastSeen.best === 47) { upgraded = Date.now() - tWait; break; }
      await sleep(400);
    }
    check(upgraded !== null, '舞台换满密度:停着的那一帧(第 47 帧)不用动播放头,自己从稀疏版换成了这一帧的画面', lastSeen);
    if (upgraded !== null) { await fs.writeFile(path.join(OUT, 'stage-upgraded-47.png'), toPng(await shotStage())); }

    const rows = [];
    const LAST_STEP = 212;
    for (let f = 48; f <= LAST_STEP; f++) {
      const { got } = await seekTo(f);
      if (got.ms === null) { check(false, `舞台换满密度:第 ${f} 帧流平面画出来了`, got); break; }
      const stage = await shotStage();
      const first = segFirst('clip-b', f);
      const r = bestOf(stage, 'clip-b', [first, f - 1, f, f + 1]);
      // 分段的第一帧上稀疏版和满密度是同一幅画面,分不出来(记 either)
      rows.push({ frame: f, segmentFirst: first, best: r.best, shows: f === first ? 'either' : r.best === f ? 'dense' : r.best === first ? 'sparse' : `frame-${r.best}`, scores: r.scores });
      if (f === 116) { await fs.writeFile(path.join(OUT, 'stage-dense-116.png'), toPng(stage)); await fs.writeFile(path.join(OUT, 'export-116.png'), toPng(exportOf(116))); }
      if (onStage(f).includes('clip-a')) {
        const a = bestOf(stage, 'clip-a', [segFirst('clip-a', f), f - 1, f, f + 1]);
        rows[rows.length - 1].clipA = a.best;
      }
    }
    const wrong = rows.filter((r) => r.shows !== 'either' && r.shows !== 'dense');
    out.a.stageSwap = { upgradedAt47Ms: upgraded, from: 48, to: rows.at(-1)?.frame ?? null, boundaries: rows.filter((r) => r.shows === 'either').length,
      denseBeats: rows.filter((r) => r.shows === 'dense').length, sparseBeats: rows.filter((r) => r.shows === 'sparse').length,
      wrong: wrong.slice(0, 6).map((r) => ({ frame: r.frame, shows: r.shows, scores: r.scores })),
      clipA: rows.filter((r) => r.clipA !== undefined).map((r) => [r.frame, r.clipA]).filter(([f, b]) => f !== b), servedKeptSparse: servedKept };
    say('a-stage-swap', out.a.stageSwap);
    check(rows.length === LAST_STEP - 47, '舞台换满密度:每一拍都比过了', rows.length);
    check(wrong.length === 0 && out.a.stageSwap.denseBeats >= 140, '舞台换满密度:换上以后逐帧往后走,每一拍画的都是这一帧自己(没有画错的、没有退回稀疏版的)', out.a.stageSwap);
    check(out.a.stageSwap.boundaries >= 10, '舞台换满密度:走过了十来个分段边界', out.a.stageSwap.boundaries);
    check(out.a.stageSwap.clipA.length === 0, '舞台换满密度:clip-a 入场时满密度已经齐了,一入场每一帧就是它自己', out.a.stageSwap.clipA);
  }
  await rpc('setRole', 'back', { job: 'probe' });
  await browser.close(); browser = null;
  hostServer.close(); hostServer = null;

  // ================================================================ 乙:按时间直接求值的卡(remotion 式)
  const B = openPipeline(path.join(OUT, 'library-b'), origin);
  pipelines.push(B.pipeline);
  t0 = Date.now();
  await B.pipeline.preload(DIRECT('sparse-stream-probe-direct'));
  if (!(await until('乙:稀疏版齐了', () => allAt(B.producer, (s) => !!s), 600_000))) throw new Error(`乙的稀疏版没产完:${JSON.stringify(B.producer.status().log.slice(-8))}`);
  await sleep(600);
  const stateB = [...B.producer.streams.values()][0];
  out.b = { sparseMs: Date.now() - t0, replay: stateB.spec.replay !== false, resetsAfterSparse: B.producer.stats.resets, segments: stateB.spec.lastSegment + 1 };
  check(B.producer.streams.size === 1 && stateB.spec.replay === false, '乙:一条不回放的流(remotion 式)', { replay: stateB.spec.replay });
  check(stateB.spec.originFrame === WANT['clip-c'][0] && stateB.spec.lastFrame === WANT['clip-c'][1], '乙:第 20～110 帧', { originFrame: stateB.spec.originFrame, lastFrame: stateB.spec.lastFrame });
  check(out.b.resetsAfterSparse <= 2, '乙:稀疏那一趟分段之间直接跳,不逐段重灌工程', { resets: out.b.resetsAfterSparse, segments: out.b.segments });
  const dirB = path.join(OUT, 'ref-clip-c');
  await fs.mkdir(dirB, { recursive: true });
  const truthB = await exportFrames(bakery, stateB.isolated, emptyUrl, WANT['clip-c'][1], dirB);
  const sparseB = await checkSparse('乙 clip-c', B.producer, stateB, truthB, dirB, { direct: true });
  out.b.sparse = { bound: sparseB.bound, tight: sparseB.tight, union: sparseB.union, segments: sparseB.segments };
  t0 = Date.now();
  B.gate.hold = false;
  B.producer.kick();
  if (!(await until('乙:满密度齐了', () => (allAt(B.producer, (s) => s?.stride === 1) && !B.producer.workers.size ? true : null), 900_000))) throw new Error(`乙的满密度没产完:${JSON.stringify(B.producer.status().log.slice(-8))}`);
  out.b.denseMs = Date.now() - t0;
  out.b.order = checkOrder('乙', B.events, stateB.spec.lastSegment + 1);
  const denseB = await checkDense('乙 clip-c', B.producer, stateB, truthB, dirB, sparseB, { direct: true });
  out.b.dense = { widened: denseB.widened, tight: denseB.tight, rects: denseB.rects, clipped: denseB.clipped.length };
  say('b', out.b);

  // ================================================================ 丙:队列的流任务那条路(执行器调的 produceRange)
  const C = openPipeline(path.join(OUT, 'library-c'), origin, { frozen: true });
  pipelines.push(C.pipeline);
  const entryC = await C.pipeline.preload(DIRECT('sparse-stream-probe-queue'));
  const stateC = await until('丙:流的计划到了生产者手里', () => [...C.producer.streams.values()][0] ?? null, 120_000);
  if (!stateC) throw new Error('丙:生产者没有拿到流');
  await sleep(500);
  check(Object.keys(stateC.manifest.segments ?? {}).length === 0, '丙:自动生产没动(一段都没产)');
  const specC = stateC.spec, range = { from: 1, to: 3 };
  const runQueue = async (density) => { const mark = C.events.length; const r = await C.producer.produceRange(entryC, specC, range, { density }); return { ...r, strides: C.events.slice(mark).filter((e) => e.ev === 'start').map((e) => e.stride) }; };
  const q1 = await runQueue('sparse');
  const afterSparse = [1, 2, 3].map((n) => ({ n, stride: stateC.manifest.segments[n]?.stride, box: stateC.manifest.segments[n]?.box }));
  check(q1.produced === 3 && q1.strides.every((s) => s === SPARSE_STRIDE), '丙:稀疏流任务产出这一段的三个分段,每段一张', q1);
  check(afterSparse.every((s) => s.stride === SPARSE_STRIDE && s.box && typeof s.box.w === 'number'), '丙:稀疏流任务产的分段记着稀疏、带位置矩形', afterSparse);
  check(stateC.manifest.segments[0] === undefined && stateC.manifest.segments[4] === undefined, '丙:只产了任务范围里的分段');
  const q2 = await runQueue('sparse');
  check(q2.produced === 0 && q2.skipped === 3 && q2.strides.length === 0, '丙:同一个稀疏流任务再做一次,一帧都不截', q2);
  const q3 = await runQueue(null);
  const afterDense = [1, 2, 3].map((n) => ({ n, stride: stateC.manifest.segments[n]?.stride, box: stateC.manifest.segments[n]?.box }));
  check(q3.produced === 3 && q3.strides.every((s) => s === 1) && afterDense.every((s) => s.stride === 1), '丙:满密度任务在同一条流上补成满密度', { q3, afterDense });
  check(JSON.stringify(afterDense.map((s) => s.box)) === JSON.stringify(afterSparse.map((s) => s.box)), '丙:补成满密度以后位置矩形原样留着');
  const q4 = await runQueue('sparse');
  check(q4.produced === 0 && q4.strides.length === 0 && [1, 2, 3].every((n) => stateC.manifest.segments[n]?.stride === 1), '丙:满密度之后再来稀疏流任务,不截、不降级', q4);
  out.c = { sparse: q1, again: q2, dense: q3, late: q4, boxes: afterSparse.map((s) => s.box) };
  say('c', out.c);
} catch (error) {
  fails.push(`探针出错:${error?.message || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { hostServer?.close(); } catch { /* ignore */ }
  for (const p of pipelines) { try { await p.close(); } catch { /* ignore */ } }
  try { await bakery?.close(); } catch { /* ignore */ }
  dropStreamEncoderSpares();
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) {
    try {
      for (const name of await fs.readdir(OUT)) if (!/\.(json|png)$/.test(name)) await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* ignore */ }
  }
}
out.elapsedMs = Date.now() - started;
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(out.ok ? 'PASS' : `FAIL ${fails.length}`);
process.exit(out.ok ? 0 : 1);
