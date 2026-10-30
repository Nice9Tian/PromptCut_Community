/**
 * 剪辑段里的卡逐张预渲染(语义 `docs/semantics/mechanism/rendering.md`「剪辑段」的「测量与预渲染:拆开逐卡」;用户 2026-10-21 定)——
 * 真 Chrome、真编码器的端到端探针,**比像素**。
 *
 *   node scripts/probes/cut-flatten-probe.mjs (--origin http://127.0.0.1:5440 | --port 5440) [--out <dir>] [--keep] [--json <file>]
 *
 * 给 `--port` 就自己在检出根起一台 dev server(另占 +1、+2 当舞台端口),用完按进程号收掉。本进程里直接起 `FramePipeline`
 * (同预渲染进程的代码),库根放临时目录。
 *
 * 项目(1280×720、30 fps):激活剪辑「主」只有一个剪辑段 S(第 1～5 秒,框 960×540 居中,`cutOffset` 1 秒)引用剪辑「重」;
 * 「重」里:推帧卡 `r6-stateful`(重,0～6 秒;偏移 1 秒落在它中间,要预卷)、轻卡 `punch-pill`(1～3 秒;舞台上不抑制它,活渲)、
 * 剪辑段引用剪辑「里」(两层嵌套),「里」里一张 `punch-pill`(重)。
 *
 * 逐条核对:
 *   1. 卡片计划:剪辑段里每张卡各有控件(id `seg-s~h-r6`、`seg-s~h-seg~i-pill`、`seg-s~h-light`),段本身没有;不走整帧 PNG。
 *   2. 流的计划:三张独立卡各一条 `solo: 'flat'` 的单卡流(预渲染集合本由页面的分派表定,探针全部放行),从第 30 帧起到各自露出窗口的末帧;
 *      `r6` 要回放、从嵌套场景挂上那一帧起。
 *   3. 隔离工程:顶层只留 S、被引用剪辑里只留链上的段与目标卡。
 *   4. 稀疏版每个分段一张;满密度每帧都有。
 *   5. 舞台贴流:真舞台(跨源两台)上把两张重卡抑制、发它们的流平面,轻卡照常活渲;停在几帧上截图,与整个项目的活渲导出同一帧比:
 *      最像的是它自己那一帧、框内平均差小;嵌套包裹层上重卡藏活子树、流平面露着,轻卡不抑制。
 *   6. 占位:只抑制、不给流平面时,那张卡的嵌套包裹层里的占位槽位露出来。
 *   7. 失效:改「里」里那张卡的文字,只有它的流键变,`r6` 的不变;激活剪辑里加一条隐藏序列,键都不变。
 *
 * 输出 JSON 结论,过程写 stderr;任何一条不过就以非零退出。耗时只记录。截图写到 `--out`。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { serve, flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { handleStreamRequest, planStreams, SPARSE_STRIDE } from '../../server/frame-stream.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { findFfmpeg, dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';
import { decodePngRgba } from '../../server/bakery/capture-canvas.mjs';
import { startDevServer, emptyUrlOf, decodeSegment, newError, tallyDecodedDirect, sleep, round2 } from './below-stream-common.mjs';
import { streamPlanesFor } from '../../src/render/streamPlayer.ts';
import { streamSegmentFirstFrame, streamSegmentFrameCount } from '../../src/render/streamSegments.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-cut-flatten-probe-${Date.now().toString(36)}`));
process.env.PROMPTCUT_STREAM_POOL = '1';
if (!ORIGIN && !PORT) { console.error('要给 --origin <dev server> 或 --port <自己起一台>'); process.exit(2); }

const FPS = 30, WIDTH = 1280, HEIGHT = 720, DURATION = 6;
const SEG = 'seg-s';
const R6 = `${SEG}~h-r6`, PILL = `${SEG}~h-seg~i-pill`, LIGHT = `${SEG}~h-light`;
const HEAVY = [R6, PILL];
const FRAME = { x: 160, y: 90, w: 960, h: 540 };
const WANT = [30, 149];

const card = (id, cardId, start, end, params = {}, extra = {}) => ({ id, cardId, start, end, params, ...extra });
const segOf = (id, cutId, start, end, extra = {}) => ({ id, cardId: '', cutId, start, end, params: {}, ...extra });
function projectOf(id, { innerLabel = '里面的药丸', extraTrack = false } = {}) {
  return {
    version: 1, id, name: id, width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION, themeId: 'dark',
    media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
    tracks: [
      ...(extraTrack ? [{ id: 'tr-extra', name: 'extra', hidden: true, clips: [card('extra-1', 'probe-slow', 0, 1, { burnMs: 0, label: 'x' })] }] : []),
      { id: 'tr-main', name: 'main', clips: [segOf(SEG, 'c-heavy', 1, 5, { cutOffset: 1, frame: { ...FRAME } })] },
    ],
    activeCutId: 'c-main',
    cuts: [
      { id: 'c-main', name: '主' },
      { id: 'c-heavy', name: '重', duration: 6, transitions: [], tracks: [
        { id: 'h-0', name: 'h0', clips: [card('h-light', 'punch-pill', 1, 3, { text: '轻卡活渲' }, { frame: { x: 80, y: 560, w: 600, h: 120 } })] },
        { id: 'h-1', name: 'h1', clips: [card('h-r6', 'r6-stateful', 0, 6)] },
        { id: 'h-2', name: 'h2', clips: [segOf('h-seg', 'c-inner', 0, 6)] },
      ] },
      { id: 'c-inner', name: '里', duration: 6, transitions: [], tracks: [
        { id: 'i-1', name: 'i1', clips: [card('i-pill', 'punch-pill', 0, 6, { text: innerLabel }, { frame: { x: 640, y: 80, w: 560, h: 140 } })] },
      ] },
    ],
  };
}
const PROJECT = projectOf('cut-flatten-probe');

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); say('FAIL', { label, extra }); } else say('ok', { label }); return cond; };
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
      if (cache.size > 64) cache.delete(cache.keys().next().value);
      return data;
    },
  };
}
async function exportFrames(bakery, project, emptyUrl, last, dir) {
  const store = frameStore();
  await bakery.reset(project, emptyUrl);
  bakery.streamLease = null;
  await bakeFrames(bakery, { out: dir, fps: FPS, frames: `0-${last}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
    onFrame: async (i, buf) => { store.put(i, buf); } });
  return store;
}
function decodedDiff(picture, rect, truth) {
  const e = newError();
  tallyDecodedDirect(e, picture, rect, truth, WIDTH);
  return e.count ? e.sum / e.count : 0;
}
function sampleDiff(a, b) { let sum = 0; for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]); return sum / a.length; }
/** 整幅 RGBA 两份逐字节不同的字节数 */
function bytesDiff(a, b) { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; }
function rgbOver(buf, bg = [0x20, 0x20, 0x20]) {
  const png = PNG.sync.read(buf);
  const out = new Uint8Array(png.width * png.height * 3);
  for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
    const a = png.data[i + 3] / 255;
    for (let k = 0; k < 3; k++) out[j + k] = Math.round(png.data[i + k] * a + bg[k] * (1 - a));
  }
  return { width: png.width, height: png.height, rgb: out };
}
/** 两幅 RGB 在框里的平均差 */
function rectDiff(a, b, r = FRAME) {
  let sum = 0, n = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) {
    const i = (y * a.width + x) * 3;
    for (let k = 0; k < 3; k++) { sum += Math.abs(a.rgb[i + k] - b.rgb[i + k]); n++; }
  }
  return sum / n;
}
const toPng = (img) => { const png = new PNG({ width: img.width, height: img.height }); for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) { png.data[i] = img.rgb[j]; png.data[i + 1] = img.rgb[j + 1]; png.data[i + 2] = img.rgb[j + 2]; png.data[i + 3] = 255; } return PNG.sync.write(png); };

const hostHtml = (oa, ob) => `<!doctype html><html><head><meta charset="utf-8"><title>cut flatten probe host</title></head>
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

function openPipeline(root, origin, { frozen = false } = {}) {
  const pipeline = new FramePipeline({ root, origin: () => origin, interactive: true, playhead: () => null });
  // 预渲染集合由页面的分派表定;这里全部放行,轻卡活渲由舞台这一步(不抑制它)来验
  pipeline.streamPicked = () => true;
  const producer = pipeline.streamProducer();
  producer.attachRoute();
  const gate = { hold: true, frozen };
  const busy = pipeline.streamBusy.bind(pipeline);
  pipeline.streamBusy = (now) => busy(now) || gate.frozen || (gate.hold && producer.streams.size > 0 && !producer.encoding.size && !producer.needsSparseAnywhere());
  const layers = new Map();
  pipeline.readyIndex.subscribe((message) => { if (message.type === 'layer' && message.kind === 'stream') layers.set(message.clipId, message); });
  return { pipeline, producer, gate, layers };
}
const allAt = (producer, want) => {
  const s = producer.status();
  if (!s.streams.length) return null;
  for (const row of s.streams) for (let n = row.firstSegment; n <= row.lastSegment; n++) if (!want(row.segments[n])) return null;
  return !producer.encoding.size ? s : null;
};
const segmentsOf = (state) => { const out = []; for (let n = state.spec.firstSegment; n <= state.spec.lastSegment; n++) out.push(n); return out; };
const controlOf = (entry, id = R6) => (entry?.cardPlan ?? []).find((c) => c.clipId === id) ?? null;

const out = { out: OUT, project: { width: WIDTH, height: HEIGHT, fps: FPS, segment: SEG, frame: FRAME, want: WANT } };
await fs.mkdir(OUT, { recursive: true });
let dev = null, bakery = null, browser = null, hostServer = null;
const pipelines = [];
const started = Date.now();
try {
  const ffmpeg = await findFfmpeg();
  let origin = ORIGIN;
  if (!origin) { dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'cutprerender' }); origin = dev.origin; say('spawn', { pid: dev.pid, port: PORT }); }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;
  const emptyUrl = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
  bakery = await openBakery({ url: emptyUrl });

  // ================================================================ 1、2、3:卡片计划、流的计划、隔离工程
  const A = openPipeline(path.join(OUT, 'library-a'), origin);
  pipelines.push(A.pipeline);
  let t0 = Date.now();
  const entry = await A.pipeline.preload(PROJECT);
  const control = await until('卡片计划里有剪辑段里的卡', () => controlOf(entry), 120_000);
  const planIds = (entry.cardPlan ?? []).map((c) => c.clipId);
  out.controls = (entry.cardPlan ?? []).map((c) => ({ clipId: c.clipId, cacheable: c.cacheable, frameMode: c.frameMode, compositing: c.compositing, firstFrame: c.sampling?.firstFrame, count: c.count }));
  check(!!control, '1:卡片计划里有剪辑段里的卡的控件');
  check([R6, PILL, LIGHT].every((id) => planIds.includes(id)) && !planIds.includes(SEG), '1:剪辑段里每张卡各有控件(含两层嵌套),段本身没有', planIds);
  check(HEAVY.every((id) => controlOf(entry, id)?.cacheable === false), '1:剪辑段里的卡不走整帧 PNG 那一支(cacheable 为假)');

  if (!(await until('稀疏版齐了', () => allAt(A.producer, (s) => !!s), 600_000))) throw new Error(`稀疏版没产完:${JSON.stringify(A.producer.status().log.slice(-8))}`);
  await sleep(600);
  out.sparseMs = Date.now() - t0;
  const states = [...A.producer.streams.values()];
  out.specs = states.map(({ spec }) => ({ top: spec.topClipId, kind: spec.kind, plane: spec.plane, solo: spec.solo, originFrame: spec.originFrame, lastFrame: spec.lastFrame, mountFrame: spec.mountFrame, replay: spec.replay, offset: spec.offset, streamKey: spec.streamKey }));
  check(states.length === 3 && [...HEAVY, LIGHT].every((id) => states.some((s) => s.spec.topClipId === id)), '2:剪辑段里三张独立卡各一条流(含两层嵌套)', out.specs.map((s) => s.top));
  check(states.every((s) => s.spec.kind === 'card' && s.spec.plane === 'local' && s.spec.solo === 'flat'), '2:都是 solo flat 的单卡流(包裹层坐标)', out.specs);
  check(states.every((s) => s.spec.originFrame === WANT[0] && s.spec.lastFrame === (s.spec.topClipId === LIGHT ? 89 : WANT[1])), '2:都从第 30 帧起,到露出窗口的末帧(重卡 149、轻卡 89)', out.specs);
  const r6State = states.find((s) => s.spec.topClipId === R6);
  check(r6State?.spec.replay === true && r6State.spec.mountFrame === 0, '2:r6 要回放,从嵌套场景挂上那一帧(第 0 帧)起', r6State?.spec);
  {
    const iso = r6State?.isolated;
    const shown = (tracks) => (tracks ?? []).filter((t) => !t.hidden).flatMap((t) => t.clips.map((c) => c.id));
    out.isolated = iso && { top: shown(iso.tracks), heavy: shown(iso.cuts.find((c) => c.id === 'c-heavy')?.tracks) };
    check(JSON.stringify(out.isolated) === JSON.stringify({ top: [SEG], heavy: ['h-r6'] }), '3:隔离工程顶层只留 S、剪辑「重」里只留 r6', out.isolated);
  }
  const refDir = path.join(OUT, 'ref-project'); await fs.mkdir(refDir, { recursive: true });
  const truth = await exportFrames(bakery, PROJECT, emptyUrl, WANT[1], refDir);
  for (const f of [31, 75, 149]) await fs.writeFile(path.join(OUT, `export-${f}.png`), toPng(rgbOver(truth.png(f))));

  // ================================================================ 4:稀疏与满密度
  const decodeOf = async (state, n, name) => {
    const { spec } = state;
    const { manifest } = state;
    const seg = manifest.segments[n];
    const meta = manifest.inits[seg.init];
    const rect = { x: meta.rect.x + spec.offset.x, y: meta.rect.y + spec.offset.y, w: meta.rect.w, h: meta.rect.h };
    const init = await fs.readFile(A.producer.store.initFile(spec.streamKey, seg.init));
    const bytes = await fs.readFile(path.join(A.producer.store.dir(spec.streamKey), seg.file));
    const decoded = await decodeSegment(ffmpeg, init, bytes, OUT, name);
    const frameBytes = rect.w * 2 * (rect.h + 8) * 3;
    const samples = [];
    for (let k = 0; (k + 1) * frameBytes <= decoded.length; k++) samples.push(decoded.subarray(k * frameBytes, (k + 1) * frameBytes));
    return { seg, rect, samples, exact: decoded.length === seg.samples * frameBytes };
  };
  {
    const wrong = [];
    for (const state of states) for (const n of segmentsOf(state)) {
      const count = streamSegmentFrameCount(n, state.spec.originFrame, state.spec.lastFrame);
      const d = await decodeOf(state, n, `sparse-${state.spec.topClipId.length}-${n}`);
      const same = Math.max(0, ...d.samples.slice(1).map((x) => sampleDiff(x, d.samples[0])));
      if (d.seg.stride !== SPARSE_STRIDE || d.seg.samples !== count || !d.exact || same > 1.5) wrong.push({ top: state.spec.topClipId, n, stride: d.seg.stride, samples: d.seg.samples, count });
    }
    check(wrong.length === 0, '4:稀疏版每个分段一张', wrong.slice(0, 4));
  }
  t0 = Date.now();
  A.gate.hold = false;
  A.producer.kick();
  if (!(await until('满密度齐了', () => (allAt(A.producer, (s) => s?.stride === 1) && !A.producer.workers.size ? true : null), 900_000))) throw new Error(`满密度没产完:${JSON.stringify(A.producer.status().log.slice(-8))}`);
  out.denseMs = Date.now() - t0;
  {
    const wrong = [];
    let frames = 0;
    for (const state of states) for (const n of segmentsOf(state)) {
      const count = streamSegmentFrameCount(n, state.spec.originFrame, state.spec.lastFrame);
      const d = await decodeOf(state, n, `dense-${state.spec.topClipId.length}-${n}`);
      if (d.seg.stride !== 1 || d.seg.samples !== count || !d.exact) wrong.push({ top: state.spec.topClipId, n, stride: d.seg.stride, samples: d.seg.samples, count });
      frames += d.samples.length;
    }
    out.dense = { frames, wrong: wrong.slice(0, 6) };
    check(wrong.length === 0 && frames === 2 * (WANT[1] - WANT[0] + 1) + 60, '4:满密度每帧都有', out.dense);
  }

  // ================================================================ 5:舞台贴流
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  if (!ports.ok || !Array.isArray(ports.ports) || ports.ports.length < 2) throw new Error(`舞台端口没起来:${JSON.stringify(ports)}`);
  const u = new URL(origin);
  const [originA, originB] = ports.ports.slice(0, 2).map((p) => `${u.protocol}//${u.hostname}:${p}`);
  const HOST_PATH = '/__cut-prerender-probe-host';
  hostServer = await serve(0, (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === HOST_PATH) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(hostHtml(originA, originB)); return; }
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
  const planesAt = (f) => streamPlanesFor([...A.layers.values()], new Set(HEAVY), f);
  await page.goto(base + HOST_PATH);
  await page.waitForFunction(() => window.__ready, { timeout: 120000 });
  await page.evaluate(() => window.__ready);
  for (const f of [frameA(), frameB()]) await f.evaluate((b) => { window.__pcStreamBase = b; }, base);
  await rpc('setProject', PROJECT, { reset: true });
  await rpcB('setProject', PROJECT, { reset: true });
  await rpc('setRole', 'front');
  await rpcB('setRole', 'back', { job: 'probe' });
  await rpc('setTime', WANT[0] / FPS);
  await rpc('setPlaying', true);
  await rpc('setSuppressed', HEAVY);
  const iframeBox = await (await page.$('#a')).boundingBox();
  const shotStage = async () => {
    await frameA().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    return rgbOver(await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } }));
  };
  const seekTo = async (f) => {
    const planes = planesAt(f);
    await rpc('setStreamPlanes', planes);
    const got = await frameA().evaluate(async (frame, fps) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const start = now();
      await window.__pcStage.setTime(frame / fps + 1e-4);
      for (;;) {
        const tracks = window.__pcStageDiag().streams.tracks;
        if (tracks.length === 2 && tracks.every((t) => t.lastDrawn === frame)) return { ms: +(now() - start).toFixed(1) };
        if (now() - start > 8000) return { ms: null, drawn: tracks.map((t) => t.lastDrawn), errors: tracks.map((t) => t.lastError), tracks: tracks.length };
        await wait(2);
      }
    }, f, FPS);
    await rpc('setStreamPlanes', planes);
    await sleep(60);
    return { planes, got };
  };
  // 舞台上真贴的是流:嵌套包裹层上重卡藏活子树(`.pc-suppressed`)、流平面露着;轻卡(第 1～3 秒露出)不抑制、活渲;剪辑段自己不抑制
  const domNow = () => frameA().evaluate((seg, heavy, light) => {
    const at = (id) => document.querySelector(`[data-pc-flat-clip="${id}"]`);
    const shown = (el) => !!el && getComputedStyle(el).display !== 'none';
    return {
      heavy: heavy.map((id) => ({ id, suppressed: !!at(id)?.classList.contains('pc-suppressed'), plane: shown(at(id)?.querySelector(':scope > [data-pc-stream-plane]')) })),
      light: { mounted: !!at(light), suppressed: !!at(light)?.classList.contains('pc-suppressed') },
      segSuppressed: !!document.querySelector(`[data-pc-clip="${seg}"]`)?.classList.contains('pc-suppressed'),
    };
  }, SEG, HEAVY, LIGHT);
  {
    const rows = [];
    for (const f of [31, 47, 75, 100, 133, 149]) {
      const { planes, got } = await seekTo(f);
      if (!check(planes.length === 2 && got.ms !== null, `5:第 ${f} 帧两条流平面都画出来了`, { planes: planes.length, got })) continue;
      const stage = await shotStage();
      const scores = [f - 2, f - 1, f, f + 1, f + 2].filter((c) => c >= 0 && c <= WANT[1]).map((c) => [c, rectDiff(stage, rgbOver(truth.png(c)))]).sort((a, b) => a[1] - b[1]);
      rows.push({ frame: f, best: scores[0][0], err: round2(scores.find(([c]) => c === f)[1]), scores: scores.map(([c, v]) => [c, round2(v)]) });
      if (f === 75) {
        await fs.writeFile(path.join(OUT, 'stage-stream-75.png'), toPng(stage));
      }
      if (f === 47) {
        await fs.writeFile(path.join(OUT, 'stage-stream-47.png'), toPng(stage));
        out.stageDom = await domNow();
      }
    }
    out.stageDom ??= await domNow();
    out.stage = rows;
    check(rows.length === 6 && rows.every((r) => r.best === r.frame), '5:舞台贴流:每一帧最像的是整个项目导出的它自己那一帧', rows.map((r) => [r.frame, r.best, r.err]));
    check(rows.every((r) => r.err < 4), '5:舞台贴流与活渲导出的平均差 < 4/255(框内)', rows.map((r) => [r.frame, r.err]));
    check(out.stageDom.heavy.every((h) => h.suppressed && h.plane) && !out.stageDom.segSuppressed, '5:嵌套包裹层上重卡藏活子树、流平面露着,剪辑段本身不抑制', out.stageDom);
    check(out.stageDom.light.mounted && !out.stageDom.light.suppressed, '5:轻卡在嵌套场景里活渲(不抑制)', out.stageDom.light);
  }

  // ================================================================ 6:没流时显示占位
  {
    await rpc('setPlaying', false);
    await rpc('setStreamPlanes', []);
    await rpc('setSuppressed', [PILL]);
    await frameA().evaluate((t) => window.__pcStage.setTime(t), 75 / FPS);
    await sleep(600);
    out.placeholder = await frameA().evaluate((id) => {
      const slot = document.querySelector(`[data-pc-flat-clip="${id}"] > [data-pc-placeholder-slot]`);
      return { slot: !!slot, hidden: slot ? slot.hidden : null };
    }, PILL);
    check(out.placeholder.slot && out.placeholder.hidden === false, '6:只抑制、没有流平面:那张卡的嵌套包裹层里显示占位', out.placeholder);
    await fs.writeFile(path.join(OUT, 'stage-placeholder-75.png'), toPng(await shotStage()));
  }

  // ================================================================ 7:失效
  {
    const fpOf = async (project) => {
      const p = new FramePipeline({ root: path.join(OUT, `library-x-${Math.random().toString(36).slice(2, 7)}`), origin: () => origin, interactive: true, playhead: () => null });
      pipelines.push(p);
      p.streamPicked = () => true;
      p.streamBusy = () => true; // 只要计划,不产
      const e = await p.preload(project);
      await until('卡片计划(失效用例)', () => controlOf(e), 120_000);
      const specs = planStreams(e, { picked: () => true, envFingerprint: 'probe-fp', below: false });
      return Object.fromEntries(HEAVY.map((id) => [id, specs.find((s) => s.topClipId === id)?.streamKey ?? null]));
    };
    const base0 = await fpOf(projectOf('cut-flatten-probe'));
    const changed = await fpOf(projectOf('cut-flatten-probe', { innerLabel: '改过的药丸' }));
    const unrelated = await fpOf(projectOf('cut-flatten-probe', { extraTrack: true }));
    out.invalidation = { base: base0, changedInner: changed, unrelated };
    check(HEAVY.every((id) => !!base0[id]), '7:两张重卡都有流键', base0);
    check(changed[PILL] && changed[PILL] !== base0[PILL] && changed[R6] === base0[R6], '7:改「里」里那张卡:只有它的流键变,r6 的不变', out.invalidation);
    check(HEAVY.every((id) => unrelated[id] === base0[id]), '7:激活剪辑里加一条隐藏序列,键都不变', out.invalidation);
  }
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
