/**
 * 暂停和拖动时重卡贴轨道流 —— **舞台这一侧**的探针(任务书「己三」;语义 `mechanism/rendering.md`「兜底顺序」)。
 * 测试页扮演父页,照产品里父页的做法发消息(先发流平面、再发抑制、再设时间;流平面用产品的 `streamPlanesFor` 合成)。
 * 父页那一侧(哪些卡贴流、什么时候发)的端到端在 `scrub-stream-probe.mjs`(真的编辑器)。
 *
 *   node scripts/probes/stream-scrub-stage-probe.mjs (--origin http://127.0.0.1:26940 | --port 26940) [--host-port 26950]
 *        [--size 1280x720] [--out <dir>] [--json <file>] [--keep]
 *   node scripts/probes/stream-scrub-stage-probe.mjs --port 26940 --timing particles --size 1920x1080   # 只量随机跳帧的耗时
 *
 * `--timing <卡片 id>`:只做 C 里量耗时的那一半。项目换成一张铺满整幅的这种卡(画布卡的流是整幅的,解一帧比那两张小卡贵得多),
 * 不比像素、不做别的几条;用来量「随机跳到一帧最坏要多久」。
 *
 * 给 `--port` 就自己在检出根起一台 dev server(另占 +1、+2 当舞台端口),用完按进程号收掉。本进程里直接起 `FramePipeline`
 * (同预渲染进程的代码),库根放临时目录。项目同 `stream-origin-probe.mjs`:两张每帧横移 10 像素的卡,**都不从 15 的倍数帧开始**
 * (clip-b 第 40～129 帧,clip-a 第 100～149 帧)。
 *
 * 逐条核对(参照一律是导出页同一帧的整幅画面;每张卡各比各的那一条带子,最像的必须是该是的那一帧):
 *
 *   A. **只有稀疏版**(先只产稀疏那一趟):暂停着把时间设到每一帧,贴出来的是不晚于这一帧的最近一张(只往回找,不拿后面的)。
 *      稀疏版多密从清单读,不写死。
 *   B. **停在稀疏段上,满密度版产出来以后自己换上**:父页一条消息都不发。
 *   C. **满密度,随机跳帧**:暂停着打乱顺序跳,每一帧贴出来的就是这一帧;量从要这一帧到画出来的时间(头一次要取字节、再来一次不用),
 *      最坏的是跳到一个分段的最后一帧(从关键帧解 15 帧)。耗时只记录。
 *   D. **这一帧迟迟解不出来**(分段的字节压着不给):留着上一张,约一个分段的时长以后清空、占位符顶上;字节到了以后
 *      **帧自己画上、占位符自己撤**,父页一条消息都不发。
 *   E. **暂停着先解好**:停下、撤了抑制以后流平面藏着、活画面露着,这一帧已经解好;按下播放,头一拍就是流的画面(逐拍记录里没有空拍)。
 *      没有先解好的(流平面刚到):流的第一帧画出来之前不藏这张卡原来的画面;一直画不出来,到时才藏、占位符顶上。
 *   F. **拖得快**(每 16 毫秒一步、不等画出来):不是每一步都重置解码器,停住以后画的是最后那一帧。
 *   G. **播放中暂停**:停住的那一帧贴的是这一帧。
 *
 * 输出 JSON 结论,过程写 stderr;任何一条不过就以非零退出。耗时只记录。
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
import { handleStreamRequest } from '../../server/frame-stream.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';
import { startDevServer, emptyUrlOf, sleep, round2 } from './below-stream-common.mjs';
import { streamPlanesFor } from '../../src/render/streamPlayer.ts';
import { STREAM_SEGMENT_FRAMES, streamSegmentFirstFrame, streamSegmentOf } from '../../src/render/streamSegments.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const HOST_PORT = Number(flagArg('host-port', '0', args)) || 0;
const KEEP = args.includes('--keep');
const TIMING = flagArg('timing', null, args);
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-scrub-stage-${Date.now().toString(36)}`));
const [WIDTH, HEIGHT] = String(flagArg('size', '1280x720', args)).split('x').map(Number);
process.env.PROMPTCUT_STREAM_POOL = '1';
if (!ORIGIN && !PORT) { console.error('要给 --origin <dev server> 或 --port <自己起一台>'); process.exit(2); }
if (!(WIDTH > 0 && HEIGHT > 0)) { console.error('--size 写成 1280x720 这样'); process.exit(2); }

const FPS = 30, DURATION = 6, SEG = STREAM_SEGMENT_FRAMES;
const K = HEIGHT / 720;
const band = (y, h) => ({ x: 0, y: Math.round(y * K), w: WIDTH, h: Math.round(h * K) });
/** 两张卡在时间轴上的帧(闭区间)。入点、出点按秒写,落在两帧之间(帧号除以 30 多数不是有限小数,直接换成秒会差一帧) */
const CLIPS = {
  'clip-b': { frames: [40, 129], start: 1.32, end: 4.32, frame: band(380, 300) },
  'clip-a': { frames: [100, 149], start: 3.32, end: 4.99, frame: band(40, 300) },
};
if (TIMING) {
  delete CLIPS['clip-a'];
  CLIPS['clip-b'].frame = { x: 0, y: 0, w: WIDTH, h: HEIGHT };
}
const TIMING_PARAMS = { particles: { color: '#30ff60', quantity: 120, links: 'yes', seed: 5 } };
const PROJECT = TIMING ? {
  id: 'stream-scrub-stage-probe-timing', name: '随机跳帧耗时', width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [{ id: 'tr-b', name: 'b', hidden: false, clips: [{ id: 'clip-b', kind: 'card', cardId: TIMING, start: CLIPS['clip-b'].start, end: CLIPS['clip-b'].end, params: TIMING_PARAMS[TIMING] ?? {}, frame: CLIPS['clip-b'].frame }] }],
} : {
  id: 'stream-scrub-stage-probe', name: '暂停和拖动贴流探针', width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-a', name: 'a', hidden: false, clips: [{ id: 'clip-a', kind: 'card', cardId: 'r6-stateful', start: CLIPS['clip-a'].start, end: CLIPS['clip-a'].end, params: {}, frame: CLIPS['clip-a'].frame }] },
    { id: 'tr-b', name: 'b', hidden: false, clips: [{ id: 'clip-b', kind: 'card', cardId: 'r6-stateful', start: CLIPS['clip-b'].start, end: CLIPS['clip-b'].end, params: {}, frame: CLIPS['clip-b'].frame }] },
  ],
};
const FIRST = 40, LAST = TIMING ? 129 : 149;
const clipsAt = (f) => Object.keys(CLIPS).filter((id) => CLIPS[id].frames[0] <= f && f <= CLIPS[id].frames[1]);

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 900))); say('FAIL', { label, extra }); } return !!cond; };
async function until(label, fn, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); say('TIMEOUT', { label }); return null; }
    await sleep(everyMs);
  }
}
const median = (list) => (list.length ? [...list].sort((a, b) => a - b)[list.length >> 1] : null);
const stats = (list) => (list.length ? { n: list.length, median: median(list), max: Math.max(...list), min: Math.min(...list) } : { n: 0 });

/** RGBA PNG → 垫在测试页底色上的 RGB(导出页的整帧是透明底,舞台截图叠在测试页的底色上) */
function rgbOver(buf, bg = [0x20, 0x20, 0x20]) {
  const png = PNG.sync.read(buf);
  const out = new Uint8Array(png.width * png.height * 3);
  for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
    const a = png.data[i + 3] / 255;
    for (let k = 0; k < 3; k++) out[j + k] = Math.round(png.data[i + k] * a + bg[k] * (1 - a));
  }
  return { width: png.width, height: png.height, rgb: out };
}
/** 两幅 RGB 在一条横带(这张卡的框)里的差:平均差,和差超过 48 的像素数 */
function bandDiff(a, b, rect) {
  if (a.width !== b.width || a.height !== b.height) return { mean: Infinity, bad: Infinity };
  let sum = 0, bad = 0, n = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let i = (y * a.width + rect.x) * 3, end = i + rect.w * 3; i < end; i += 3) {
      const d0 = Math.abs(a.rgb[i] - b.rgb[i]), d1 = Math.abs(a.rgb[i + 1] - b.rgb[i + 1]), d2 = Math.abs(a.rgb[i + 2] - b.rgb[i + 2]);
      sum += d0 + d1 + d2; n += 3;
      if (d0 > 48 || d1 > 48 || d2 > 48) bad++;
    }
  }
  return { mean: sum / Math.max(1, n), bad };
}
const toPng = (img) => { const png = new PNG({ width: img.width, height: img.height }); for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) { png.data[i] = img.rgb[j]; png.data[i + 1] = img.rgb[j + 1]; png.data[i + 2] = img.rgb[j + 2]; png.data[i + 3] = 255; } return PNG.sync.write(png); };

const hostHtml = (oa, ob) => `<!doctype html><html><head><meta charset="utf-8"><title>stream scrub stage probe host</title></head>
<body style="margin:0;background:#202020">
<iframe id="a" src="${oa}/?stage=1&id=A&preview=stage&prerender=1" style="width:${WIDTH}px;height:${HEIGHT}px;border:0;display:block"></iframe>
<iframe id="b" src="${ob}/?stage=1&id=B&preview=stage&prerender=1" style="width:${WIDTH}px;height:${HEIGHT}px;border:0;display:block;opacity:0;pointer-events:none;position:absolute;left:0;top:0"></iframe>
<script type="module">
function createStageRpc(target, targetOrigin) {
  let nextId = 1; const pending = new Map(); const listeners = new Set();
  window.addEventListener('message', (e) => {
    if (e.source !== target) return; const d = e.data;
    if (d && d.type === 'pc-rpc-reply') { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.ok ? p.resolve(d.result) : p.reject(new Error(d.error)); return; }
    if (d && typeof d.type === 'string' && ['mediaReady', 'frame', 'ended', 'settled', 'probe', 'demote', 'probe-frame'].includes(d.type)) for (const l of listeners) l(d);
  });
  const call = (method) => (...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); target.postMessage({ type: 'pc-rpc', id, method, args }, targetOrigin); });
  const c = { onEvent: (l) => { listeners.add(l); return () => listeners.delete(l); } };
  for (const m of ['setProject', 'setTime', 'setRole', 'play', 'pause', 'setSuppressed', 'setStreamPlanes', 'setPlaying', 'setScrubbing']) c[m] = call(m);
  return c;
}
window.__frames = [];
const waitReady = (frame, targetOrigin) => new Promise((res) => {
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    res(createStageRpc(frame.contentWindow, targetOrigin));
  });
});
window.__ready = Promise.all([waitReady(document.getElementById('a'), '${oa}'), waitReady(document.getElementById('b'), '${ob}')])
  .then(([a, b]) => { window.__rpc = a; window.__rpcB = b; a.onEvent((ev) => { if (ev.type === 'frame') window.__frames.push({ sec: ev.sec, at: performance.now() }); }); return true; });
</script></body></html>`;

const out = { out: OUT, project: { width: WIDTH, height: HEIGHT, fps: FPS, clips: Object.fromEntries(Object.entries(CLIPS).map(([id, c]) => [id, c.frames])) } };
await fs.mkdir(OUT, { recursive: true });
let dev = null, bakery = null, pipeline = null, browser = null, hostServer = null;
const started = Date.now();
try {
  let origin = ORIGIN;
  if (!origin) { dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'scrubstage' }); origin = dev.origin; say('spawn', { pid: dev.pid, port: PORT }); }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;

  /* ------------------------------------------------------------ 产流:先只产稀疏那一趟 */
  pipeline = new FramePipeline({ root: path.join(OUT, 'library'), origin: () => origin, interactive: true, playhead: () => null });
  pipeline.streamPicked = () => true; // 钉成重卡
  const producer = pipeline.streamProducer();
  producer.attachRoute();
  let holdDense = !TIMING;
  const nextTask = producer.nextTask.bind(producer);
  producer.nextTask = (b) => { const task = nextTask(b); return task && task.stride === 1 && holdDense ? null : task; };
  const layerByClip = new Map();
  pipeline.readyIndex.subscribe((message) => { if (message.type === 'layer' && message.kind === 'stream') layerByClip.set(message.clipId, message); });
  const t0 = Date.now();
  await pipeline.preload(PROJECT);
  const idle = () => !producer.workers.size && !producer.encoding.size;
  const stateOf = (clipId) => [...producer.streams.values()].find((s) => s.spec.clipIds.length === 1 && s.spec.clipIds[0] === clipId) ?? null;
  const segmentsOf = (clipId) => { const s = stateOf(clipId); return s ? Array.from({ length: s.spec.lastSegment + 1 }, (_, n) => s.manifest.segments[n]?.stride ?? 0) : []; };
  await until(TIMING ? '流全部分段满密度' : '两条流的稀疏版铺满全段', () => {
    if (producer.streams.size < Object.keys(CLIPS).length || !idle()) return null;
    if (TIMING) return Object.keys(CLIPS).every((id) => { const st = segmentsOf(id); return st.length && st.every((s) => s === 1); }) ? true : null;
    return Object.keys(CLIPS).every((id) => { const st = segmentsOf(id); return st.length && st.every((s) => s >= 1); }) ? true : null;
  }, 600_000, 300);
  out.sparseMs = Date.now() - t0;
  out.sparse = Object.fromEntries(Object.keys(CLIPS).map((id) => [id, { originFrame: stateOf(id)?.spec.originFrame, strides: segmentsOf(id) }]));
  say('sparse-ready', { ms: out.sparseMs, ...out.sparse });
  const sparseStrides = Object.values(out.sparse).flatMap((s) => s.strides);
  if (!TIMING && !check(sparseStrides.length > 0 && sparseStrides.every((s) => s > 1), '先只有稀疏版(每个分段的间隔都大于 1)', out.sparse)) throw new Error('没有得到只有稀疏版的状态');
  if (TIMING) { const st = stateOf('clip-b'); out.timingStream = { card: TIMING, bound: st?.manifest.bound, tight: st?.manifest.tight, inits: Object.values(st?.manifest.inits ?? {}).map((i) => ({ width: i.width, height: i.height })) }; say('timing-stream', out.timingStream); }
  const layers = () => [...layerByClip.values()];
  /** 这张卡在第 f 帧贴的是哪一张画面:满密度是它自己;稀疏是不晚于它的最近一张(间隔从清单读) */
  const pictureOf = (clipId, f) => {
    const state = stateOf(clipId);
    const o = state.spec.originFrame;
    const n = streamSegmentOf(f, o);
    const stride = state.manifest.segments[n]?.stride ?? 1;
    const start = streamSegmentFirstFrame(n, o);
    return stride > 1 && SEG % stride === 0 ? start + Math.floor((f - start) / stride) * stride : f;
  };

  /* ------------------------------------------------------------ 参照:导出页逐帧 */
  const emptyUrl = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
  const exported = new Map();
  if (!TIMING) {
    bakery = await openBakery({ url: emptyUrl });
    await bakery.reset(PROJECT, emptyUrl);
    bakery.streamLease = null;
    const refDir = path.join(OUT, 'ref-project');
    await fs.mkdir(refDir, { recursive: true });
    await bakeFrames(bakery, { out: refDir, fps: FPS, frames: `0-${LAST + 1}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
      onFrame: async (i, buf) => { exported.set(i, Buffer.from(buf)); } });
  }
  const exportRgb = new Map();
  const exportOf = (f) => { if (!exportRgb.has(f)) { exportRgb.set(f, rgbOver(exported.get(f))); if (exportRgb.size > 24) exportRgb.delete(exportRgb.keys().next().value); } return exportRgb.get(f); };
  say('exported', { frames: exported.size });

  /* ------------------------------------------------------------ 舞台 */
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  if (!ports.ok || !Array.isArray(ports.ports) || ports.ports.length < 2) throw new Error(`舞台端口没起来:${JSON.stringify(ports)}`);
  const u = new URL(origin);
  const [originA, originB] = ports.ports.slice(0, 2).map((p) => `${u.protocol}//${u.hostname}:${p}`);
  const HOST_PATH = '/__stream-scrub-stage-probe-host';
  /** 压着不给的分段请求:地址以 `/slow<n>/` 开头的分段字节在 `slow.hold` 时挂着,`slow.release()` 一起放;`slow.delayMs` 是固定多等一会儿 */
  const slow = { hold: false, delayMs: 0, waiting: [], asked: 0, release() { const w = this.waiting; this.waiting = []; this.hold = false; for (const go of w) go(); } };
  hostServer = await serve(HOST_PORT, (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === HOST_PATH) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(hostHtml(originA, originB)); return; }
    const m = /^\/(?:(slow|cold)\d*\/)?api\/frames(\/.*)$/.exec(url.pathname);
    if (!m) { res.statusCode = 404; res.end(); return; }
    const go = () => { if (!handleStreamRequest(producer.store, req, res, m[2])) { res.statusCode = 404; res.end(); } };
    if (m[1] === 'slow' && /\/seg\//.test(m[2])) {
      slow.asked++;
      if (slow.hold) { slow.waiting.push(go); return; }
      if (slow.delayMs > 0) { setTimeout(go, slow.delayMs); return; }
    }
    go();
  }, '127.0.0.1');
  const base = `http://127.0.0.1:${hostServer.address().port}`;
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  await page.goto(base + HOST_PATH);
  await page.waitForFunction(() => window.__ready, { timeout: 120000 });
  await page.evaluate(() => window.__ready);
  const frameA = () => page.frames().find((f) => f.url().startsWith(originA));
  const frameB = () => page.frames().find((f) => f.url().startsWith(originB));
  const setBase = async (prefix = '') => { for (const f of [frameA(), frameB()]) await f.evaluate((b) => { window.__pcStreamBase = b; }, base + prefix); };
  await setBase();
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const rpcB = (method, ...a) => page.evaluate((m, a2) => window.__rpcB[m](...a2), method, a);
  const diagA = () => frameA().evaluate(() => {
    const d = window.__pcStageDiag();
    return { t: d.t, suppressed: d.suppressed, parentSuppressed: d.parentSuppressed, streamWaiting: d.streamWaiting, settling: d.settling, placeholders: d.placeholders, snapshots: d.snapshots,
      planes: d.streamPlanes.map((p) => p.clipIds.join(',')),
      tracks: d.streams.tracks.map((t) => ({ id: t.id.split('#')[0], lastDrawn: t.lastDrawn, picture: t.picture, want: t.want, level: t.level, stale: t.stale, seeks: t.seeks, deferred: t.deferred, decoded: t.decoded,
        standIns: t.standIns, errors: t.errors, lastError: t.lastError, lastSeek: t.lastSeek, seekMaxMs: t.seekMaxMs, held: t.held })) };
  });
  /** 每张卡包裹层此刻的样子:类名、流平面的画布露没露 */
  const domA = () => frameA().evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-pc-clip]:not([data-pc-media])')].map((el) => {
    const canvas = el.querySelector(':scope > canvas[data-pc-stream-plane]');
    return [el.getAttribute('data-pc-clip'), { cls: el.className, canvas: canvas ? getComputedStyle(canvas).display : null }];
  })));
  await rpc('setProject', PROJECT, { reset: true });
  await rpcB('setProject', PROJECT, { reset: true });
  await rpc('setRole', 'front');
  await rpcB('setRole', 'back', { job: 'probe' });
  await rpc('setTime', FIRST / FPS);
  const iframeBox = await (await page.$('#a')).boundingBox();
  const shotStage = async () => {
    await frameA().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } });
    return rgbOver(await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } }));
  };
  const planesAt = (f) => streamPlanesFor(layers(), new Set(Object.keys(CLIPS)), f);
  const membersOf = (planes) => [...new Set(planes.flatMap((p) => p.clipIds))].sort();
  /**
   * 照父页的做法把时间设到第 f 帧:先发流平面、再发抑制、再设时间。然后**不再发任何消息**,在舞台里等每条流画出它该画的那一张
   * (`want`:clipId → 帧号),回从设时间到画出来的毫秒、那一刻显示着的占位符。
   */
  const seekTo = async (f, { settle = false } = {}) => {
    const planes = planesAt(f);
    const want = Object.fromEntries(membersOf(planes).map((id) => [id, pictureOf(id, f)]));
    await rpc('setStreamPlanes', planes);
    await rpc('setSuppressed', membersOf(planes));
    const got = await frameA().evaluate(async (frame, fps, want, settle) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const t0 = now();
      await window.__pcStage.setTime(frame / fps + 1e-4, settle ? { settle: true } : {});
      const ids = Object.keys(want);
      for (;;) {
        const d = window.__pcStageDiag();
        const tracks = d.streams.tracks;
        const of = (id) => tracks.find((t) => t.id.split('#')[0] === id);
        if (ids.every((id) => of(id) && of(id).picture === want[id] && !of(id).stale)) {
          const ms = +(now() - t0).toFixed(1);
          await wait(0);
          const after = window.__pcStageDiag();
          return { ms, placeholders: after.placeholders, levels: Object.fromEntries(ids.map((id) => [id, of(id).level])), waiting: after.streamWaiting,
            standIns: Object.fromEntries(ids.map((id) => [id, of(id).standIns])) };
        }
        if (now() - t0 > 8000) return { ms: null, tracks: tracks.map((t) => ({ id: t.id.split('#')[0], lastDrawn: t.lastDrawn, picture: t.picture, stale: t.stale, err: t.lastError })) };
        await wait(2);
      }
    }, f, FPS, want, settle);
    return { planes, want, got };
  };
  /** 舞台截图里每张卡那一条带子最像导出页的哪一帧(`candidates`:clipId → 候选帧) */
  const scoreBands = (stage, candidates) => Object.fromEntries(Object.entries(candidates).map(([id, list]) => {
    const scores = [...new Set(list)].filter((c) => c >= 0 && c <= LAST + 1).map((c) => [c, bandDiff(stage, exportOf(c), CLIPS[id].frame)]);
    const sorted = [...scores].sort((x, y) => x[1].mean - y[1].mean);
    return [id, { best: sorted[0][0], mean: round2(sorted[0][1].mean), bad: sorted[0][1].bad, runnerUp: sorted[1] ? round2(sorted[1][1].mean) : null, scores: scores.map(([c, d]) => [c, round2(d.mean)]) }];
  }));
  const shuffled = (from, to) => { const order = []; for (let f = from; f <= to; f++) order.push(f); for (let i = 0; i < order.length; i++) { const j = (i * 37 + 11) % order.length; [order[i], order[j]] = [order[j], order[i]]; } return order; };

  /* ------------------------------------------------------------ A. 只有稀疏版 */
  if (!TIMING) {
    const rec = { frames: 0, wrong: [], notDrawn: [], later: [], placeholders: [], levels: new Set(), seekMs: [], sameMean: 0, n: 0, standIns: {} };
    for (const f of shuffled(FIRST, LAST)) {
      const { want, got } = await seekTo(f);
      if (got.ms === null) { rec.notDrawn.push({ frame: f, ...got }); continue; }
      rec.seekMs.push(got.ms);
      for (const [id, n] of Object.entries(got.standIns)) rec.standIns[id] = Math.max(rec.standIns[id] ?? 0, n);
      if (got.placeholders.length) rec.placeholders.push({ frame: f, placeholders: got.placeholders });
      for (const level of Object.values(got.levels)) rec.levels.add(level);
      const stage = await shotStage();
      const stride = (id) => { const s = stateOf(id); return s.manifest.segments[streamSegmentOf(f, s.spec.originFrame)].stride; };
      const result = scoreBands(stage, Object.fromEntries(Object.entries(want).map(([id, p]) => [id, [p - stride(id), p - 1, p, p + 1, p + stride(id), f]])));
      for (const [id, r] of Object.entries(result)) {
        if (want[id] > f) rec.later.push({ frame: f, clip: id, picture: want[id] });
        if (r.best !== want[id]) rec.wrong.push({ frame: f, clip: id, want: want[id], ...r });
        rec.sameMean += r.mean; rec.n++;
      }
      rec.frames++;
      if (f === 107 || f === 52) await fs.writeFile(path.join(OUT, `sparse-stage-${f}.png`), toPng(stage));
    }
    out.sparseScrub = { frames: rec.frames, wrongCount: rec.wrong.length, wrong: rec.wrong.slice(0, 5), notDrawn: rec.notDrawn.slice(0, 5), later: rec.later.slice(0, 5), placeholdersLeft: rec.placeholders.slice(0, 5),
      levels: [...rec.levels], seekMs: stats(rec.seekMs), 对该贴的那一张的平均差: round2(rec.sameMean / Math.max(1, rec.n)), 没解到目标帧就先画上的次数: rec.standIns };
    say('A-sparse', out.sparseScrub);
    check(rec.notDrawn.length === 0 && rec.frames === LAST - FIRST + 1, `只有稀疏版:第 ${FIRST}～${LAST} 帧每一帧都贴出了画面`, { frames: rec.frames, notDrawn: rec.notDrawn.slice(0, 3) });
    check(rec.wrong.length === 0, '只有稀疏版:每一帧贴的都是不晚于它的最近一张(和导出页那一帧最像)', { wrong: rec.wrong.length, first: rec.wrong.slice(0, 3) });
    check(rec.later.length === 0, '只有稀疏版:只往回找,不拿后面的', rec.later.slice(0, 3));
    check([...rec.levels].every((l) => l === 'sparse'), '只有稀疏版:舞台报的是稀疏这一级', [...rec.levels]);
    check(rec.placeholders.length === 0, '只有稀疏版:画出来的那一刻没有占位符挂着', rec.placeholders.slice(0, 3));
  }

  /* ------------------------------------------------------------ B. 停在稀疏段上,满密度版产出来以后自己换上 */
  if (!TIMING) {
    // 找一帧:两张卡都在场,而且它在稀疏版里不是「自己那一张」
    let park = null;
    for (let f = 104; f <= 128 && park === null; f++) if (clipsAt(f).every((id) => pictureOf(id, f) !== f)) park = f;
    if (check(park !== null, '有这样一帧:稀疏版里贴的不是它自己(用来看换成满密度以后变没变)')) {
      const { want } = await seekTo(park);
      const before = scoreBands(await shotStage(), Object.fromEntries(clipsAt(park).map((id) => [id, [want[id], park]])));
      holdDense = false;
      producer.kick();
      const t1 = Date.now();
      await until('全部分段满密度', () => (idle() && Object.keys(CLIPS).every((id) => segmentsOf(id).every((s) => s === 1)) ? true : null), 900_000, 500);
      out.denseMs = Date.now() - t1;
      // 父页一条消息都不发:舞台自己隔一会儿问一次清单,换上这一帧自己的画面
      const swapped = await until('停在稀疏段上的那一帧自己换成了满密度', async () => {
        const d = await diagA();
        return d.tracks.length === clipsAt(park).length && d.tracks.every((t) => t.level === 'dense' && t.picture === park && !t.stale) ? d : null;
      }, 30_000, 250);
      const after = scoreBands(await shotStage(), Object.fromEntries(clipsAt(park).map((id) => [id, [want[id], park, park - 1, park + 1]])));
      out.upgrade = { frame: park, sparsePicture: want, before: Object.fromEntries(Object.entries(before).map(([id, r]) => [id, r.best])), after: Object.fromEntries(Object.entries(after).map(([id, r]) => [id, r.best])),
        waitedMs: Date.now() - t1 - out.denseMs, ok: !!swapped };
      say('B-upgrade', out.upgrade);
      check(Object.entries(before).every(([id, r]) => r.best === want[id]), '换之前贴的是稀疏的那一张', before);
      check(!!swapped && Object.values(after).every((r) => r.best === park), '满密度版产出来以后,不等任何消息,自己换成了这一帧自己的画面', after);
    } else {
      holdDense = false;
      producer.kick();
      await until('全部分段满密度', () => (idle() && Object.keys(CLIPS).every((id) => segmentsOf(id).every((s) => s === 1)) ? true : null), 900_000, 500);
    }
  }

  /* ------------------------------------------------------------ C. 满密度:打乱顺序跳,逐帧比;量从要这一帧到画出来的时间 */
  {
    await setBase('/cold1');   // 换一个地址前缀:浏览器的缓存里没有,头一遍每个分段都要真的取一次
    await rpc('setStreamPlanes', []);
    await rpc('setSuppressed', []);
    const rec = { frames: 0, wrong: [], notDrawn: [], placeholders: [], sameMean: 0, nextMean: 0, n: 0, coldMs: [], warmMs: [], bySample: {} };
    const pass = async (label, order, shoot) => {
      for (const f of order) {
        const { want, got } = await seekTo(f);
        if (got.ms === null) { rec.notDrawn.push({ frame: f, pass: label, ...got }); continue; }
        (label === 'cold' ? rec.coldMs : rec.warmMs).push(got.ms);
        // 按「这一帧是它那个分段里的第几个样本」分开记(两张卡都在场时取要解得多的那一张)
        const sample = Math.max(...Object.keys(want).map((id) => (f - stateOf(id).spec.originFrame) % SEG));
        ((rec.bySample[label] ||= {})[sample] ||= []).push(got.ms);
        if (got.placeholders.length) rec.placeholders.push({ frame: f, pass: label, placeholders: got.placeholders });
        if (!shoot) continue;
        const stage = await shotStage();
        const result = scoreBands(stage, Object.fromEntries(Object.keys(want).map((id) => [id, [f - 1, f, f + 1]])));
        for (const [id, r] of Object.entries(result)) {
          if (r.best !== f) rec.wrong.push({ frame: f, clip: id, ...r });
          rec.sameMean += r.mean; rec.nextMean += r.runnerUp ?? 0; rec.n++;
        }
        rec.frames++;
        if (f === 105 || f === 47) { await fs.writeFile(path.join(OUT, `dense-stage-${f}.png`), toPng(stage)); await fs.writeFile(path.join(OUT, `export-${f}.png`), toPng(exportOf(f))); }
      }
    };
    await pass('cold', shuffled(FIRST, LAST), !TIMING);
    await pass('warm', shuffled(FIRST, LAST).reverse(), false);
    if (TIMING) { await pass('warm', shuffled(FIRST, LAST), false); rec.frames = LAST - FIRST + 1; rec.sameMean = 0; rec.nextMean = 1; rec.n = 1; }
    const worst = (label) => stats((rec.bySample[label] ?? {})[SEG - 1] ?? []);
    const tracks = (await diagA()).tracks;
    out.denseScrub = { frames: rec.frames, wrongCount: rec.wrong.length, wrong: rec.wrong.slice(0, 5), notDrawn: rec.notDrawn.slice(0, 5), placeholdersLeft: rec.placeholders.slice(0, 5),
      对导出同一帧: round2(rec.sameMean / Math.max(1, rec.n)), 对照_第二像的那一帧: round2(rec.nextMean / Math.max(1, rec.n)),
      随机跳帧_毫秒: { 头一遍_要取字节: stats(rec.coldMs), 再来一遍_字节在手: stats(rec.warmMs),
        跳到分段最后一帧_头一遍: worst('cold'), 跳到分段最后一帧_再来一遍: worst('warm'),
        跳到分段第一帧_再来一遍: stats((rec.bySample.warm ?? {})[0] ?? []) },
      播放器自己记的最坏一次: tracks.map((t) => ({ id: t.id, seekMaxMs: t.seekMaxMs, seeks: t.seeks })) };
    say('C-dense', out.denseScrub);
    check(rec.notDrawn.length === 0 && rec.frames === LAST - FIRST + 1, `满密度:第 ${FIRST}～${LAST} 帧每一帧都贴出了这一帧`, { frames: rec.frames, notDrawn: rec.notDrawn.slice(0, 3) });
    check(rec.wrong.length === 0, '满密度:暂停着跳到任意一帧,贴出来的画面最像的都是导出页的同一帧', { wrong: rec.wrong.length, first: rec.wrong.slice(0, 3) });
    if (!TIMING) check(out.denseScrub.对导出同一帧 < 3 && out.denseScrub.对照_第二像的那一帧 > 3 * out.denseScrub.对导出同一帧, '满密度:和同一帧的差小,和第二像的那一帧差得明显更大', out.denseScrub);
    check(rec.placeholders.length === 0, '满密度:画出来的那一刻没有占位符挂着(帧是异步到的,父页没有补发消息)', rec.placeholders.slice(0, 3));
  }

  /* ------------------------------------------------------------ D. 迟迟解不出来:留着上一张 → 到时占位符 → 帧到了自己换上、占位符自己撤 */
  if (!TIMING) {
    await setBase('/slow1');
    await rpc('setStreamPlanes', []);
    await rpc('setSuppressed', []);
    await seekTo(47);                 // 第 0 段(只 clip-b 在场),从 /slow1 取,不压
    slow.hold = true;
    const target = 92;                // 第 3 段:字节压着
    const planes = planesAt(target);
    await rpc('setStreamPlanes', planes);
    await rpc('setSuppressed', membersOf(planes));
    // 设时间以后一条消息都不发,在舞台里逐毫秒记:画着哪一帧、是不是留着的旧画面、占位符
    const watch = frameA().evaluate(async (frame, fps) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const t0 = now();
      await window.__pcStage.setTime(frame / fps + 1e-4);
      const log = [];
      let last = '';
      for (;;) {
        const d = window.__pcStageDiag();
        const t = d.streams.tracks.find((x) => x.id.split('#')[0] === 'clip-b');
        const slot = document.querySelector('[data-pc-clip="clip-b"] > [data-pc-placeholder-slot]');
        const key = `${t ? t.lastDrawn : '-'}|${t && t.stale ? 1 : 0}|${d.placeholders.includes('clip-b') ? 1 : 0}|${slot && !slot.hidden ? 1 : 0}`;
        const at = Math.round(now() - t0);
        if (key !== last) { last = key; log.push({ at, drawn: t ? t.lastDrawn : null, stale: !!(t && t.stale), placeholder: d.placeholders.includes('clip-b'), slotShown: !!(slot && !slot.hidden) }); }
        if (t && t.lastDrawn === frame) return { log, doneAt: at };
        if (at > 20000) return { log, doneAt: null };
        await wait(3);
      }
    }, target, FPS);
    await sleep(1500);
    const held = slow.waiting.length;
    const mid = await diagA();
    slow.release();
    const seen = await watch;
    const blankAt = seen.log.find((e) => e.drawn === null)?.at ?? null;
    const placeholderAt = seen.log.find((e) => e.placeholder)?.at ?? null;
    const end = seen.log.at(-1);
    const stage = await shotStage();
    const result = scoreBands(stage, { 'clip-b': [target - 1, target, target + 1, 47] });
    out.hold = { from: 47, target, heldRequests: held, log: seen.log, blankAtMs: blankAt, placeholderAtMs: placeholderAt, releasedAtMs: 1500, drawnAtMs: seen.doneAt, midway: { placeholders: mid.placeholders, tracks: mid.tracks.map((t) => [t.lastDrawn, t.stale]) }, best: result['clip-b'].best };
    say('D-hold', out.hold);
    const holdMs = (SEG * 1000) / FPS;
    check(held > 0, '这一段的字节确实被压住了', slow.asked);
    check(seen.log[0]?.drawn === 47 && seen.log[0].stale && !seen.log[0].placeholder, '这一帧解不出来:先留着上一张,不显示占位符', seen.log.slice(0, 3));
    check(blankAt !== null && blankAt >= holdMs - 60 && blankAt <= holdMs + 400, `留着的旧画面约一个分段的时长(${holdMs} 毫秒)以后清空`, { blankAt });
    check(placeholderAt !== null && placeholderAt >= blankAt - 5, '清空以后占位符顶上', { blankAt, placeholderAt });
    check(seen.doneAt !== null && end.drawn === target && !end.placeholder && !end.slotShown, '字节到了:这一帧自己画上、占位符自己撤(父页一条消息都没发)', end);
    check(result['clip-b'].best === target, '到了以后贴的是这一帧', result);
    await setBase('/cold1');
  }

  /* ------------------------------------------------------------ E. 暂停着先解好;起播头一拍;流没画出来之前不藏原来的画面 */
  if (!TIMING) {
    const f0 = 110;
    const both = ['clip-a', 'clip-b'];
    await seekTo(f0);
    // 停下、追到精确活渲以后父页撤抑制,流平面照发
    await rpc('setSuppressed', []);
    await sleep(120);
    const idleDom = await domA();
    const idleDiag = await diagA();
    // (这里的活画面不拿去比像素:测试页只是撤了抑制,没有走「停下追到精确活渲」那一步 —— 那一步连同停下以后的像素在 scrub-stream-probe 里核)
    out.prewarm = { frame: f0, dom: idleDom, tracks: idleDiag.tracks.map((t) => ({ id: t.id, lastDrawn: t.lastDrawn })) };
    check(both.every((id) => idleDom[id] && idleDom[id].canvas === 'none' && !/pc-suppressed/.test(idleDom[id].cls)), '不抑制的时候流平面藏着(不占框)、活画面露着', idleDom);
    check(idleDiag.tracks.length === 2 && idleDiag.tracks.every((t) => t.lastDrawn === f0), '暂停着:播放头下这一帧已经解好、画在藏着的流平面上', out.prewarm.tracks);
    // 起播:流平面(没变)→ 抑制 → play;逐拍记录每张卡落在哪一级
    await frameA().evaluate(() => { window.__pcFallbackTrace = []; });
    await page.evaluate(() => { window.__frames = []; });
    await rpc('setStreamPlanes', planesAt(f0));
    await rpc('setSuppressed', both);
    const atStart = await diagA();
    const startDom = await domA();
    await rpc('play', f0 / FPS + 1e-4);
    await sleep(500);
    const stop = await rpc('pause');
    const trace = await frameA().evaluate(() => { const t = window.__pcFallbackTrace.splice(0); delete window.__pcFallbackTrace; return t; });
    const beats = trace.map((b) => ({ frame: Math.round(b.sec * 30), levels: b.levels }));
    const bad = beats.filter((b) => both.some((id) => CLIPS[id].frames[1] >= b.frame && b.levels[id] !== 'dense'));
    out.playStart = { frame: f0, waitingAtStart: atStart.streamWaiting, suppressedAtStart: atStart.suppressed, dom: startDom, beats: beats.length, firstBeat: beats[0] ?? null, notDense: bad.slice(0, 5), stoppedAt: Math.round(stop.stoppedAt * FPS) };
    say('E-play-start', out.playStart);
    check(atStart.streamWaiting.length === 0 && both.every((id) => atStart.suppressed.includes(id)), '起播:这一帧先解好了,一抑制就换成流,不用等', { waiting: atStart.streamWaiting, suppressed: atStart.suppressed });
    check(both.every((id) => startDom[id]?.canvas !== 'none' && /pc-suppressed/.test(startDom[id]?.cls ?? '')), '起播:流平面露出来、活子树藏起来,同一次提交', startDom);
    check(beats.length >= 5 && bad.length === 0, '起播:头一拍起每一拍都是流的画面(没有空拍、没有占位符)', { beats: beats.length, first: beats[0], bad: bad.slice(0, 3) });

    // 没有先解好:流平面刚到、字节慢 180 毫秒。流的第一帧画出来之前不藏原来的画面
    await rpc('setSuppressed', []);
    await rpc('setStreamPlanes', []);
    await rpc('setTime', f0 / FPS + 1e-4);
    await setBase('/slow2');
    slow.delayMs = 180;
    const sampler = frameA().evaluate(async (ids) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const t0 = now();
      const log = [];
      let last = '';
      for (;;) {
        const d = window.__pcStageDiag();
        const showing = ids.filter((id) => d.streams.tracks.some((t) => t.id.split('#')[0] === id && t.lastDrawn !== null));
        const hidden = ids.filter((id) => document.querySelector(`[data-pc-clip="${id}"]`)?.classList.contains('pc-suppressed'));
        // 「什么都不画」:活子树藏着、流没有画面
        const empty = hidden.filter((id) => !showing.includes(id));
        const key = `${d.parentSuppressed.join()}|${d.streamWaiting.join()}|${hidden.join()}|${showing.join()}|${d.placeholders.join()}`;
        const at = Math.round(now() - t0);
        if (key !== last) { last = key; log.push({ at, named: d.parentSuppressed, waiting: d.streamWaiting, hidden, showing, empty, placeholders: d.placeholders }); }
        if (at > 1500) return log;
        await wait(3);
      }
    }, both);
    await sleep(30);
    await rpc('setStreamPlanes', planesAt(f0));
    await rpc('setSuppressed', both);
    const coldLog = await sampler;
    slow.delayMs = 0;
    const named = coldLog.filter((e) => e.named.length === 2);
    const waitingSpan = named.filter((e) => e.waiting.length);
    const firstHidden = named.find((e) => e.hidden.length === 2);
    out.coldStart = { log: coldLog, waitedMs: waitingSpan.length && firstHidden ? firstHidden.at - waitingSpan[0].at : null };
    say('E-cold-start', out.coldStart);
    check(waitingSpan.length > 0 && named.every((e) => e.waiting.every((id) => !e.hidden.includes(id))), '流还没画出第一帧的卡:点名抑制了也先不藏原来的画面', coldLog.slice(0, 4));
    check(!!firstHidden && firstHidden.showing.length === 2 && named.every((e) => e.hidden.every((id) => e.showing.includes(id))), '流画出来的那一刻才藏活子树(藏着的卡流都已经有画面)', firstHidden);
    check(coldLog.every((e) => e.empty.length === 0 && e.placeholders.length === 0), '全程没有「活子树藏着、流又没画面」的时刻,也没有占位符', coldLog.filter((e) => e.empty.length || e.placeholders.length).slice(0, 3));

    // 一直画不出来:到时才藏,占位符顶上
    await rpc('setSuppressed', []);
    await rpc('setStreamPlanes', []);
    await setBase('/slow3');
    slow.hold = true;
    await rpc('setStreamPlanes', planesAt(f0));
    await rpc('setSuppressed', both);
    const early = await diagA();
    await sleep(900);
    const late = await diagA();
    const lateDom = await domA();
    slow.release();
    await until('字节放了以后流画出来、占位符撤掉', async () => { const d = await diagA(); return d.tracks.length === 2 && d.tracks.every((t) => t.lastDrawn === f0) && !d.placeholders.length ? d : null; }, 10_000, 100);
    out.waitTimeout = { early: { waiting: early.streamWaiting, suppressed: early.suppressed }, late: { waiting: late.streamWaiting, suppressed: late.suppressed, placeholders: late.placeholders }, dom: lateDom };
    say('E-wait-timeout', out.waitTimeout);
    check(early.streamWaiting.length === 2 && early.suppressed.length === 0, '流画不出来:先等着,不藏', out.waitTimeout.early);
    check(late.streamWaiting.length === 0 && late.suppressed.length === 2 && late.placeholders.length === 2, '等到时限还没有:藏起来,占位符顶上', out.waitTimeout.late);
    await setBase('/cold1');
  }

  /* ------------------------------------------------------------ F. 拖得快 */
  if (!TIMING) {
    const path16 = [...Array.from({ length: 20 }, (_, i) => 41 + i * 3), ...Array.from({ length: 16 }, (_, i) => 98 - i * 3), 77, 45, 96, 52, 88, 63];
    await seekTo(41);
    const before = (await diagA()).tracks.find((t) => t.id === 'clip-b');
    const fast = await frameA().evaluate(async (steps, fps) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const track = () => window.__pcStageDiag().streams.tracks.find((t) => t.id.split('#')[0] === 'clip-b');
      const seen = new Set();
      let empty = 0;
      const t0 = now();
      for (const f of steps) {
        void window.__pcStage.setTime(f / fps + 1e-4);
        await wait(16);
        const t = track();
        if (t && t.lastDrawn !== null) seen.add(t.lastDrawn); else empty++;
      }
      const last = steps[steps.length - 1];
      const dragMs = now() - t0;
      let settleMs = null;
      for (;;) {
        const t = track();
        if (t && t.lastDrawn === last && !t.stale) { settleMs = +(now() - t0 - dragMs).toFixed(1); break; }
        if (now() - t0 > 8000) break;
        await wait(2);
      }
      return { steps: steps.length, dragMs: Math.round(dragMs), distinctDrawn: seen.size, emptySamples: empty, settleMs, placeholders: window.__pcStageDiag().placeholders };
    }, path16, FPS);
    const after = (await diagA()).tracks.find((t) => t.id === 'clip-b');
    const stage = await shotStage();
    const last = path16.at(-1);
    const result = scoreBands(stage, { 'clip-b': [last - 1, last, last + 1] });
    out.fastDrag = { ...fast, seeks: after.seeks - before.seeks, deferred: after.deferred - before.deferred, decoded: after.decoded - before.decoded, best: result['clip-b'].best, last };
    say('F-fast-drag', out.fastDrag);
    check(fast.settleMs !== null && result['clip-b'].best === last, '拖得快:停住以后画的是最后那一帧', out.fastDrag);
    check(out.fastDrag.seeks < path16.length, '拖得快:不是每一步都重置解码器(在途的那一次让它解完,只解最新要的)', out.fastDrag);
    check(fast.distinctDrawn >= 5 && fast.emptySamples === 0, '拖得快:画面一路跟着走,没有空着的时刻', out.fastDrag);
    check(fast.placeholders.length === 0, '拖得快:没有占位符', fast.placeholders);
  }

  /* ------------------------------------------------------------ G. 播放中暂停 */
  if (!TIMING) {
    await rpc('setStreamPlanes', planesAt(100));
    await rpc('setSuppressed', ['clip-a', 'clip-b']);
    await rpc('setTime', 95 / FPS + 1e-4);
    await page.evaluate(() => { window.__frames = []; });
    await rpc('play', 95 / FPS + 1e-4);
    await sleep(700);
    const stop = await rpc('pause');
    const stopped = Math.round(stop.stoppedAt * FPS);
    await until('暂停的那一帧画出来', async () => { const d = await diagA(); return d.tracks.every((t) => t.lastDrawn === stopped || t.lastDrawn === null) ? d : null; }, 5000, 50);
    const frames = await page.evaluate(() => window.__frames);
    const steps = frames.slice(1).map((f, i) => +(f.sec - frames[i].sec).toFixed(6));
    const stage = await shotStage();
    const result = scoreBands(stage, Object.fromEntries(clipsAt(stopped).map((id) => [id, [stopped - 1, stopped, stopped + 1]])));
    out.playPause = { from: 95, stoppedAt: stopped, beats: frames.length, noSkip: steps.every((s) => Math.abs(s - 1 / FPS) < 1e-6), best: Object.fromEntries(Object.entries(result).map(([id, r]) => [id, r.best])) };
    say('G-play-pause', out.playPause);
    check(out.playPause.noSkip && frames.length > 5 && stopped > 100, '播放:不跳帧,播进了两张卡都在场的一段', out.playPause);
    check(Object.values(result).every((r) => r.best === stopped), '播放中暂停:停住的那一帧贴的是这一帧', result);
  }
  await rpc('setRole', 'back', { job: 'probe' });
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { hostServer?.close(); hostServer?.closeAllConnections?.(); } catch { /* ignore */ }
  try { await pipeline?.close(); } catch { /* ignore */ }
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
