/**
 * 轨道流的分段从这条流自己的第一帧起数 —— 产流、播放、拖动的端到端探针,**逐帧比像素**
 * (`docs/plan/html-snapshot-removal-dryrun.md` 第 10.5 节;换算在 `src/render/streamSegments.mjs`)。
 *
 *   node scripts/probes/stream-origin-probe.mjs (--origin http://127.0.0.1:27860 | --port 27860) [--host-port <端口>] [--group] [--out <dir>] [--keep] [--json <file>]
 *
 * 给了 `--origin` 就用那台 dev server;给 `--port` 就自己在检出根起一台(另占 +1、+2 当舞台端口),用完按进程号收掉。
 * `--host-port`:扮演父页的测试页和流的字节从哪个端口发(不给就让系统挑一个)。
 * 本进程里直接起 `FramePipeline`(同预渲染进程的代码),库根放临时目录。项目里两张会动的卡,**都不从 15 的倍数帧开始**:
 *
 *   clip-b  探针卡 `r6-stateful`(一块字,每帧横移 10 像素),第 40～129 帧(90 帧)
 *   clip-a  同一张卡,第 100～149 帧(50 帧,时长也不是 15 的倍数:末段只有 5 帧)
 *
 * 不带 `--group`:各一条单卡流(第一帧分别是 40、100)。带 `--group`:解码器预算压到 1,两张并成一条组流
 * (第一帧是成员里最早的 40,到第 149 帧为止)。依赖下层的流由 `stream-below-probe.mjs` 核对(它的目标卡从第 6 帧入场)。
 *
 * 逐条核对:
 *
 *   1. 计划:每条流的 `originFrame` 是它自己的第一帧,`firstSegment` 是 0,清单、就绪消息带着这一帧;
 *      每个分段的样本数 = 这一段盖住的帧数(只有末段可以不满 15)。
 *   2. **产流,逐帧**:把每个分段解出来,第 n 段的第 k 个样本应当是项目的第 `originFrame + n × 15 + k` 帧。
 *      参照是这条流的隔离工程从头顺推、每帧截一张(与分段无关)。每一帧拿解出来的画面去比它自己、前后各两帧,
 *      **最像的必须是它自己**;累计的差不超过「同一幅画面原样过一遍同一个编码器」的差;
 *      对照:和下一帧比、和「按项目帧号数分段」(原来的做法)会对上的那一帧比,都明显更大。
 *   3. **舞台贴流,逐帧(拖动)**:测试页扮演父页,流平面用产品里的 `streamPlanesFor` 按就绪消息合成(带 `originFrame`)。
 *      对这两张卡在场的每一帧:把时间设到这一帧,等流平面画出这一帧,截舞台,和导出页同一帧比;同样拿它去比前后各一帧,
 *      最像的必须是它自己。流的帧是异步解出来的、暂停着没有下一拍:画出来的那一刻舞台上不许还挂着占位符
 *      (父页不补发任何消息;以前要补发一次流平面才撤)。
 *   4. **真的播放**:从卡入场之前起播一段,暂停;不跳帧;暂停的那一帧同样比。
 *   5. 早于这条流第一帧的帧:流平面什么都不画(没有分段)。
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
import { handleStreamRequest, splitFmp4 } from '../../server/frame-stream.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { findFfmpeg, openStreamSegmentEncoder, dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';
import { decodePngRgba } from '../../server/bakery/capture-canvas.mjs';
import { startDevServer, emptyUrlOf, decodeSegment, newError, errorSummary, tallyDecodedDirect, cropRgba, savePreview, sleep, round2 } from './below-stream-common.mjs';
import { streamPlanesFor } from '../../src/render/streamPlayer.ts';
import { STREAM_SEGMENT_FRAMES, streamSegmentFirstFrame, streamSegmentFrameCount, streamSegmentOf } from '../../src/render/streamSegments.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const GROUP = args.includes('--group');
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const HOST_PORT = Number(flagArg('host-port', '0', args)) || 0;
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-origin-probe-${Date.now().toString(36)}`));
if (GROUP) process.env.PROMPTCUT_STREAM_DECODERS = '1';
process.env.PROMPTCUT_STREAM_POOL = '1';
if (!ORIGIN && !PORT) { console.error('要给 --origin <dev server> 或 --port <自己起一台>'); process.exit(2); }

const FPS = 30, WIDTH = 1280, HEIGHT = 720, DURATION = 6;
/** 两张卡在时间轴上的帧(闭区间)。入点、出点按秒写,落在两帧之间(帧号除以 30 多数不是有限小数,直接换成秒会差一帧) */
const CLIPS = {
  'clip-b': { frames: [40, 129], start: 1.32, end: 4.32, frame: { x: 0, y: 380, w: WIDTH, h: 300 } },
  'clip-a': { frames: [100, 149], start: 3.32, end: 4.99, frame: { x: 0, y: 40, w: WIDTH, h: 300 } },
};
const PROJECT = {
  id: 'stream-origin-probe', name: '流的分段起点探针', width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  // 第一条序列在最上面;两条相邻,中间没有别的层(组流只合并相邻的)
  tracks: [
    { id: 'tr-a', name: 'a', hidden: false, clips: [{ id: 'clip-a', kind: 'card', cardId: 'r6-stateful', start: CLIPS['clip-a'].start, end: CLIPS['clip-a'].end, params: {}, frame: CLIPS['clip-a'].frame }] },
    { id: 'tr-b', name: 'b', hidden: false, clips: [{ id: 'clip-b', kind: 'card', cardId: 'r6-stateful', start: CLIPS['clip-b'].start, end: CLIPS['clip-b'].end, params: {}, frame: CLIPS['clip-b'].frame }] },
  ],
};
const FIRST = 40, LAST = 149;

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); say('FAIL', { label, extra }); } return cond; };
async function until(label, fn, timeoutMs, everyMs = 500) {
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
    has: (frame) => png.has(frame),
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

/** 导出页顺推、每帧截一张整幅(透明底):参照,与分段怎么分无关 */
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
/** 两幅 RGB 的差:平均差,和差超过 48 的像素数(「明显不是同一幅」的像素) */
function rgbDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { mean: Infinity, bad: Infinity };
  let sum = 0, bad = 0;
  for (let i = 0; i < a.rgb.length; i += 3) {
    const d0 = Math.abs(a.rgb[i] - b.rgb[i]), d1 = Math.abs(a.rgb[i + 1] - b.rgb[i + 1]), d2 = Math.abs(a.rgb[i + 2] - b.rgb[i + 2]);
    sum += d0 + d1 + d2;
    if (d0 > 48 || d1 > 48 || d2 > 48) bad++;
  }
  return { mean: sum / a.rgb.length, bad };
}

const hostHtml = (oa, ob) => `<!doctype html><html><head><meta charset="utf-8"><title>stream origin probe host</title></head>
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
  for (const m of ['setProject', 'setTime', 'setRole', 'play', 'pause', 'setSuppressed', 'setStreamPlanes', 'setPlaying']) c[m] = call(m);
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

const out = { group: GROUP, out: OUT, project: { width: WIDTH, height: HEIGHT, fps: FPS, clips: Object.fromEntries(Object.entries(CLIPS).map(([id, c]) => [id, c.frames])) } };
await fs.mkdir(OUT, { recursive: true });
let dev = null, bakery = null, pipeline = null, browser = null, hostServer = null;
const started = Date.now();
try {
  const ffmpeg = await findFfmpeg();
  let origin = ORIGIN;
  if (!origin) { dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'originprobe' }); origin = dev.origin; say('spawn', { pid: dev.pid, port: PORT }); }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;

  // ---------- 1. 产流
  pipeline = new FramePipeline({ root: path.join(OUT, 'library'), origin: () => origin, interactive: true, playhead: () => null });
  pipeline.streamPicked = () => true; // 钉成重卡
  const producer = pipeline.streamProducer();
  producer.attachRoute();
  const layerLog = [];
  pipeline.readyIndex.subscribe((message) => { if (message.type === 'layer' && message.kind === 'stream') layerLog.push(message); });
  const t0 = Date.now();
  await pipeline.preload(PROJECT);
  const status = await until('全部分段满密度', () => {
    const s = producer.status();
    if (!s.streams.length) return null;
    for (const row of s.streams) for (let n = row.firstSegment; n <= row.lastSegment; n++) if (row.segments[n]?.stride !== 1) return null;
    return !producer.workers.size && !producer.encoding.size ? s : null;
  }, 900_000, 500);
  if (!status) throw new Error(`生产没做完:${JSON.stringify(producer.status().log.slice(-8))}`);
  out.produceMs = Date.now() - t0;
  out.encoder = status.encoder;
  const states = [...producer.streams.values()];
  say('produced', { ms: out.produceMs, streams: states.map((s) => ({ kind: s.spec.kind, clipIds: s.spec.clipIds, originFrame: s.spec.originFrame, lastFrame: s.spec.lastFrame })) });

  // 计划:每条流的第一帧
  const expectStreams = GROUP
    ? [{ kind: 'group', clipIds: ['clip-b', 'clip-a'], origin: 40, last: 149 }]
    : [{ kind: 'card', clipIds: ['clip-a'], origin: 100, last: 149 }, { kind: 'card', clipIds: ['clip-b'], origin: 40, last: 129 }];
  check(states.length === expectStreams.length, `有 ${expectStreams.length} 条流`, states.map((s) => `${s.spec.kind}:${s.spec.clipIds.join('+')}`));
  const byClip = new Map();
  for (const m of layerLog) byClip.set(m.clipId, m);
  const layers = [...byClip.values()];
  out.layers = layers.map((l) => ({ clipId: l.clipId, key: l.key.slice(0, 12), ranges: l.ranges, originFrame: l.originFrame ?? null, groupClipIds: l.groupClipIds ?? null }));
  out.streams = [];

  // ---------- 2. 产流,逐帧
  const emptyUrl = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
  bakery = await openBakery({ url: emptyUrl });
  for (const want of expectStreams) {
    const state = states.find((s) => s.spec.kind === want.kind && [...s.spec.clipIds].sort().join() === [...want.clipIds].sort().join());
    const tag = `${want.kind}:${want.clipIds.join('+')}`;
    if (!check(!!state, `${tag}:有这条流`)) continue;
    const { spec, manifest } = state;
    const lastSegment = Math.floor((want.last - want.origin) / STREAM_SEGMENT_FRAMES);
    check(spec.originFrame === want.origin && spec.firstFrame === want.origin && spec.lastFrame === want.last && spec.firstSegment === 0 && spec.lastSegment === lastSegment,
      `${tag}:第一帧 ${want.origin}、最后一帧 ${want.last}、分段 0～${lastSegment}`, { originFrame: spec.originFrame, firstFrame: spec.firstFrame, lastFrame: spec.lastFrame, firstSegment: spec.firstSegment, lastSegment: spec.lastSegment });
    check(want.origin % STREAM_SEGMENT_FRAMES !== 0, `${tag}:第一帧不是 15 的倍数(这支探针要的就是这个)`, want.origin);
    check(manifest.originFrame === want.origin, `${tag}:清单记着这条流的第一帧`, manifest.originFrame);
    const layer = byClip.get(spec.topClipId);
    check(!!layer && layer.key === spec.streamKey && layer.originFrame === want.origin && JSON.stringify(layer.ranges) === JSON.stringify([[0, lastSegment]]),
      `${tag}:就绪消息带着第一帧,区间是全部分段`, layer && { originFrame: layer.originFrame, ranges: layer.ranges });

    const dir = path.join(OUT, `ref-${want.clipIds.join('+')}`);
    await fs.mkdir(dir, { recursive: true });
    const truth = await exportFrames(bakery, state.isolated, emptyUrl, want.last, dir);
    const record = { tag, streamKey: spec.streamKey, originFrame: spec.originFrame, lastFrame: spec.lastFrame, segments: lastSegment + 1, samples: [], tight: manifest.tight, bound: manifest.bound };
    const got = newError(), floor = newError(), next = newError(), old = newError();
    let frames = 0, wrong = [], minMargin = Infinity, oldCompared = 0;
    for (let n = 0; n <= lastSegment; n++) {
      const seg = manifest.segments[n];
      if (!check(seg?.stride === 1, `${tag}#${n}:满密度`, seg)) continue;
      const count = streamSegmentFrameCount(n, want.origin, want.last);
      record.samples.push(seg.samples);
      check(seg.samples === count && (n === lastSegment || count === STREAM_SEGMENT_FRAMES), `${tag}#${n}:样本数 = 这一段盖住的帧数(只有末段可以不满)`, { samples: seg.samples, count });
      const meta = manifest.inits[seg.init];
      const rect = { x: meta.rect.x + spec.offset.x, y: meta.rect.y + spec.offset.y, w: meta.rect.w, h: meta.rect.h };
      const init = await fs.readFile(producer.store.initFile(spec.streamKey, seg.init));
      const bytes = await fs.readFile(path.join(producer.store.dir(spec.streamKey), seg.file));
      const decoded = await decodeSegment(ffmpeg, init, bytes, dir, `seg-${n}`);
      const frameBytes = rect.w * 2 * (rect.h + 8) * 3;
      if (!check(decoded.length === seg.samples * frameBytes, `${tag}#${n}:解出 ${seg.samples} 帧`, decoded.length / frameBytes)) continue;
      // 参照的底:同一批真画面裁到同一个矩形,原样过一遍同一个编码器
      const first = streamSegmentFirstFrame(n, want.origin);
      const plain = openStreamSegmentEncoder(ffmpeg, { encoder: status.encoder, fps: FPS, raw: { width: rect.w, height: rect.h } });
      for (let k = 0; k < count; k++) await plain.write(cropRgba(truth.rgba(first + k), WIDTH, rect));
      const plainParts = splitFmp4((await plain.finish()).bytes);
      const plainDecoded = await decodeSegment(ffmpeg, plainParts.init, plainParts.segments[0], dir, `plain-${n}`);
      for (let k = 0; k < count; k++) {
        const f = first + k;
        const picture = decoded.subarray(k * frameBytes, (k + 1) * frameBytes);
        // 这一帧最像哪一帧:它自己、前后各两帧
        const scores = [];
        for (let c = f - 2; c <= f + 2; c++) if (c >= 0 && c <= want.last) scores.push([c, decodedDiff(picture, rect, truth.rgba(c))]);
        scores.sort((x, y) => x[1] - y[1]);
        if (scores[0][0] !== f) wrong.push({ frame: f, segment: n, sample: k, best: scores[0][0], scores: scores.map(([c, d]) => [c, round2(d)]) });
        else if (scores[1]) minMargin = Math.min(minMargin, scores[1][1] / Math.max(scores[0][1], 1e-6));
        tallyDecodedDirect(got, picture, rect, truth.rgba(f), WIDTH);
        tallyDecodedDirect(floor, plainDecoded.subarray(k * frameBytes, (k + 1) * frameBytes), rect, truth.rgba(f), WIDTH);
        tallyDecodedDirect(next, picture, rect, truth.rgba(f < want.last ? f + 1 : f - 1), WIDTH);
        // 原来的做法:第 n 段的第 k 个样本是项目的第 n × 15 + k 帧
        const legacy = n * STREAM_SEGMENT_FRAMES + k;
        if (legacy <= want.last) { tallyDecodedDirect(old, picture, rect, truth.rgba(legacy), WIDTH); oldCompared++; }
        frames++;
        if (f === want.origin + 7) {
          await savePreview(path.join(OUT, 'previews', `${want.clipIds.join('+')}-truth-${f}.png`), cropRgba(truth.rgba(f), WIDTH, rect), rect.w, rect.h);
        }
      }
    }
    record.frames = frames;
    record.error = { 对它自己那一帧: errorSummary(got), 参照_同一幅画面原样过一遍编码器: errorSummary(floor), 对照_下一帧: errorSummary(next), 对照_按项目帧号数的那一帧: { ...errorSummary(old), frames: oldCompared } };
    record.wrongFrames = wrong.slice(0, 6);
    record.minMargin = Number.isFinite(minMargin) ? round2(minMargin) : null;
    out.streams.push(record);
    say('produce-compare', { tag, frames, wrong: wrong.length, minMargin: record.minMargin, ...record.error });
    const g = record.error.对它自己那一帧, ref = record.error.参照_同一幅画面原样过一遍编码器, nx = record.error.对照_下一帧, od = record.error.对照_按项目帧号数的那一帧;
    check(frames === want.last - want.origin + 1, `${tag}:从第 ${want.origin} 帧到第 ${want.last} 帧每一帧都比过了`, frames);
    check(wrong.length === 0, `${tag}:产流逐帧 —— 每个样本最像的都是它该是的那一帧(第 originFrame + n × 15 + k 帧)`, { wrong: wrong.length, first: wrong.slice(0, 3) });
    check(g.mean <= ref.mean + 0.5 && g.bad <= ref.bad * 1.25 + g.pixels * 0.001, `${tag}:和它自己那一帧的差在编码误差以内`, { got: g, ref });
    // 这张卡的字边缘编码以后本来就有不少差超过 16 的像素(参照那一行也一样多),所以「明显更大」主要看平均差,坏像素数只要求翻倍
    check(nx.mean > 3 * g.mean && nx.bad > 2 * (g.bad + 1), `${tag}:对照(下一帧)明显更大`, { got: g, next: nx });
    check(oldCompared > 0 && od.mean > 3 * g.mean && od.bad > 2 * (g.bad + 1), `${tag}:对照(按项目帧号数分段会对上的那一帧)明显更大`, { got: g, old: od });
    if (!KEEP) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  // ---------- 3. 舞台贴流,逐帧
  const refDir = path.join(OUT, 'ref-project');
  await fs.mkdir(refDir, { recursive: true });
  const exported = await exportFrames(bakery, PROJECT, emptyUrl, LAST + 1, refDir);
  const exportRgb = new Map();
  const exportOf = (f) => { if (!exportRgb.has(f)) { exportRgb.set(f, rgbOver(exported.png(f))); if (exportRgb.size > 16) exportRgb.delete(exportRgb.keys().next().value); } return exportRgb.get(f); };

  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  if (!ports.ok || !Array.isArray(ports.ports) || ports.ports.length < 2) throw new Error(`舞台端口没起来:${JSON.stringify(ports)}`);
  const u = new URL(origin);
  const [originA, originB] = ports.ports.slice(0, 2).map((p) => `${u.protocol}//${u.hostname}:${p}`);
  const HOST_PATH = '/__stream-origin-probe-host';
  hostServer = await serve(HOST_PORT, (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === HOST_PATH) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(hostHtml(originA, originB)); return; }
    if (url.pathname.startsWith('/api/frames/') && handleStreamRequest(producer.store, req, res, url.pathname.slice('/api/frames'.length))) return;
    res.statusCode = 404; res.end();
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
  for (const f of [frameA(), frameB()]) await f.evaluate((b) => { window.__pcStreamBase = b; }, base);
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const rpcB = (method, ...a) => page.evaluate((m, a2) => window.__rpcB[m](...a2), method, a);
  const diagA = () => frameA().evaluate(() => window.__pcStageDiag());
  await rpc('setProject', PROJECT, { reset: true });
  await rpcB('setProject', PROJECT, { reset: true });
  await rpc('setRole', 'front');
  await rpcB('setRole', 'back', { job: 'probe' });

  // 父页那一侧:被抑制的是有流的那几张;流平面用产品里的 `streamPlanesFor` 按就绪消息合成(每一层按它自己的第一帧换算)
  const heavy = [...new Set(layers.flatMap((l) => (l.groupClipIds?.length ? l.groupClipIds : [l.clipId])))];
  const planesAt = (f) => streamPlanesFor(layers, new Set(heavy), f);
  await rpc('setTime', FIRST / FPS);
  await rpc('setPlaying', true);
  await rpc('setSuppressed', heavy);
  const iframeBox = await (await page.$('#a')).boundingBox();
  const shotStage = async () => {
    await frameA().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } });
    return page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } });
  };
  /** 把时间设到第 f 帧,等每条在场的流画出这一帧。照父页的做法:先发流平面,再抑制这一帧贴流的那几张,再设时间 */
  const seekTo = async (f) => {
    const planes = planesAt(f);
    await rpc('setStreamPlanes', planes);
    await rpc('setSuppressed', [...new Set(planes.flatMap((p) => p.clipIds))]);
    const got = await frameA().evaluate(async (frame, fps, want) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const t0 = now();
      await window.__pcStage.setTime(frame / fps + 1e-4);
      for (;;) {
        const d = window.__pcStageDiag();
        const tracks = d.streams.tracks;
        /*
         * 流的帧是异步解出来的,暂停着没有下一拍。它画上去的那一刻舞台自己重算占位符(`StreamPlayer` 的 `onShowingChange`),
         * 不用父页再发消息:这里**不补发**流平面,画出来的同时把「此刻显示着占位符的卡」一并带回去,下面断言它是空的。
         * (以前不补发的话 110 帧里有 7 帧截到的是占位符。)
         */
        if (tracks.length === want && tracks.every((t) => t.lastDrawn === frame)) {
          await wait(0);
          return { ms: +(now() - t0).toFixed(1), drawn: tracks.map((t) => t.lastDrawn), errors: tracks.map((t) => t.errors), placeholders: window.__pcStageDiag().placeholders };
        }
        if (now() - t0 > 8000) return { ms: null, drawn: tracks.map((t) => t.lastDrawn), errors: tracks.map((t) => t.lastError), tracks: tracks.length };
        await wait(2);
      }
    }, f, FPS, planes.length);
    return { planes, got };
  };
  const scrub = { frames: 0, wrong: [], notDrawn: [], retried: [], placeholders: [], minMargin: Infinity, seekMs: [], same: { mean: 0, bad: 0 }, next: { mean: 0, bad: 0 } };
  const toPng = (img) => { const png = new PNG({ width: img.width, height: img.height }); for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) { png.data[i] = img.rgb[j]; png.data[i + 1] = img.rgb[j + 1]; png.data[i + 2] = img.rgb[j + 2]; png.data[i + 3] = 255; } return PNG.sync.write(png); };
  const scoreStage = (stage, f) => { const scores = [f - 1, f, f + 1].map((c) => [c, rgbDiff(stage, exportOf(c))]); return { scores, best: [...scores].sort((x, y) => x[1].mean - y[1].mean)[0][0] }; };
  // 拖动的顺序:先顺着走一遍太「连续播放」,这里打乱着跳(每一步都跨帧、常常跨分段、有往回跳)
  const order = [];
  for (let f = FIRST; f <= LAST; f++) order.push(f);
  for (let i = 0; i < order.length; i++) { const j = (i * 37 + 11) % order.length; [order[i], order[j]] = [order[j], order[i]]; }
  for (const f of order) {
    const { planes, got } = await seekTo(f);
    const expectPlanes = (GROUP ? 1 : (f >= 100 ? 1 : 0) + (f <= 129 ? 1 : 0));
    if (planes.length !== expectPlanes) { scrub.wrong.push({ frame: f, planes: planes.length, expectPlanes }); continue; }
    if (got.ms === null) { scrub.notDrawn.push({ frame: f, ...got }); continue; }
    scrub.seekMs.push(got.ms);
    if (got.placeholders?.length) scrub.placeholders.push({ frame: f, placeholders: got.placeholders });
    let stage = rgbOver(await shotStage());
    let { scores, best } = scoreStage(stage, f);
    if (best !== f || scores[1][1].mean >= 3) {
      /*
       * 这一张没对上。先把它存下来,再分清是「截图那一刻舞台还没合成完」(流的状态已经说画了这一帧,等一会儿原样再截就对)
       * 还是「贴出来的就不是这一帧」(再截、重新设一次时间再截都不对)。前一种记进 `retried`、如实报数;后一种才算这一条不过。
       */
      await fs.writeFile(path.join(OUT, `stage-mismatch-${f}${GROUP ? '-group' : ''}.png`), toPng(stage));
      const first = { best, scores: scores.map(([c, d]) => [c, round2(d.mean), d.bad]), tracks: (await diagA()).streams.tracks.map((t) => ({ id: t.id.slice(0, 14), lastDrawn: t.lastDrawn, held: t.held })) };
      await sleep(400);
      stage = rgbOver(await shotStage());
      ({ scores, best } = scoreStage(stage, f));
      let how = 'reshoot';
      if (best !== f || scores[1][1].mean >= 3) { how = 'reseek'; await seekTo(f); await sleep(200); stage = rgbOver(await shotStage()); ({ scores, best } = scoreStage(stage, f)); }
      scrub.retried.push({ frame: f, first, fixedBy: best === f && scores[1][1].mean < 3 ? how : null });
    }
    const same = scores[1][1], other = scores[2][1];
    if (best !== f) scrub.wrong.push({ frame: f, best, scores: scores.map(([c, d]) => [c, round2(d.mean), d.bad]) });
    else scrub.minMargin = Math.min(scrub.minMargin, Math.min(scores[0][1].mean, scores[2][1].mean) / Math.max(same.mean, 1e-6));
    scrub.same.mean += same.mean; scrub.same.bad += same.bad; scrub.next.mean += other.mean; scrub.next.bad += other.bad;
    scrub.frames++;
    if (f === 105 || f === 47) {
      await fs.writeFile(path.join(OUT, `stage-scrub-${f}${GROUP ? '-group' : ''}.png`), toPng(stage));
      await fs.writeFile(path.join(OUT, `export-${f}.png`), toPng(exportOf(f)));
    }
  }
  const n = Math.max(1, scrub.frames);
  out.scrub = { frames: scrub.frames, wrong: scrub.wrong.slice(0, 6), wrongCount: scrub.wrong.length, notDrawn: scrub.notDrawn.slice(0, 6), notDrawnCount: scrub.notDrawn.length,
    retried: scrub.retried, retriedCount: scrub.retried.length,
    placeholdersLeft: scrub.placeholders.slice(0, 6), placeholdersLeftCount: scrub.placeholders.length,
    seekMsMax: scrub.seekMs.length ? Math.max(...scrub.seekMs) : null,
    minMargin: Number.isFinite(scrub.minMargin) ? round2(scrub.minMargin) : null,
    seekMsMedian: scrub.seekMs.length ? [...scrub.seekMs].sort((a, b) => a - b)[scrub.seekMs.length >> 1] : null,
    对导出同一帧: { mean: round2(scrub.same.mean / n), bad: Math.round(scrub.same.bad / n) }, 对照_导出下一帧: { mean: round2(scrub.next.mean / n), bad: Math.round(scrub.next.bad / n) } };
  say('scrub', out.scrub);
  check(scrub.notDrawn.length === 0, '拖动:每一帧流平面都画出了这一帧', out.scrub.notDrawn);
  check(scrub.placeholders.length === 0, '拖动:流的帧画出来的那一刻占位符已经自己撤了(父页没有补发任何消息)', out.scrub.placeholdersLeft);
  check(scrub.retried.length === 0, '拖动:没有哪一帧要重截才对得上', scrub.retried.slice(0, 3));
  check(scrub.frames === LAST - FIRST + 1, `拖动:第 ${FIRST}～${LAST} 帧每一帧都比过了`, scrub.frames);
  check(scrub.wrong.length === 0, '拖动逐帧 —— 舞台上贴出来的画面最像的都是导出页的同一帧(不是前一帧、后一帧)', { wrong: scrub.wrong.length, first: scrub.wrong.slice(0, 3) });
  check(out.scrub.对导出同一帧.mean < 3, '拖动:舞台(贴流)与导出同一帧的平均差 < 3/255', out.scrub.对导出同一帧);
  check(out.scrub.对照_导出下一帧.bad > 5 * (out.scrub.对导出同一帧.bad + 1), '拖动:对照(导出的下一帧)明显更大', out.scrub);

  // 早于流的第一帧:没有分段,流平面什么都不画
  {
    const early = [];
    for (const f of [0, 25, 39]) {
      const planes = planesAt(f);
      await rpc('setStreamPlanes', planes);
      await rpc('setTime', f / FPS + 1e-4);
      await sleep(150);
      const d = await diagA();
      early.push({ frame: f, planes: planes.length, drawn: d.streams.tracks.map((t) => t.lastDrawn) });
    }
    // 父页不发(这一段没有就绪的分段);就算硬发整条流的平面,舞台也画不出来
    const forced = layers.map((l) => ({ clipIds: l.groupClipIds?.length ? l.groupClipIds : [l.clipId], key: l.key, ranges: l.ranges, originFrame: l.originFrame }));
    await rpc('setStreamPlanes', forced);
    await rpc('setTime', 39 / FPS + 1e-4);
    await sleep(300);
    const d = await diagA();
    out.early = { byParent: early, forcedAt39: d.streams.tracks.map((t) => ({ id: t.id.slice(0, 14), lastDrawn: t.lastDrawn })) };
    check(early.every((e) => e.planes === 0), '早于第一帧:父页不出流平面', early);
    check(d.streams.tracks.every((t) => t.lastDrawn === null), '早于第一帧:硬给流平面,舞台也什么都不画(没有这一段)', out.early.forcedAt39);
  }

  // ---------- 4. 真的播放:从 clip-a 入场之前(第 95 帧)起播,播过它的头两个分段,暂停
  {
    const forced = layers.map((l) => ({ clipIds: l.groupClipIds?.length ? l.groupClipIds : [l.clipId], key: l.key, ranges: l.ranges, originFrame: l.originFrame }));
    await rpc('setTime', 95 / FPS + 1e-4);
    await rpc('setStreamPlanes', forced);
    await rpc('setSuppressed', heavy);
    await page.evaluate(() => { window.__frames = []; });
    await rpc('play', 95 / FPS + 1e-4);
    await sleep(900);
    const stop = await rpc('pause');
    const frames = await page.evaluate(() => window.__frames);
    const steps = frames.slice(1).map((f, i) => +(f.sec - frames[i].sec).toFixed(6));
    const stopped = Math.round(stop.stoppedAt * FPS);
    await sleep(120);
    const d = await diagA();
    const stage = rgbOver(await shotStage());
    const scores = [stopped - 1, stopped, stopped + 1].map((c) => [c, rgbDiff(stage, exportOf(Math.min(c, LAST + 1)))]);
    const best = [...scores].sort((x, y) => x[1].mean - y[1].mean)[0][0];
    out.play = { from: 95, stoppedAt: stopped, beats: frames.length, noSkip: steps.every((s) => Math.abs(s - 1 / FPS) < 1e-6),
      tracks: d.streams.tracks.map((t) => ({ id: t.id.slice(0, 14), lastDrawn: t.lastDrawn, drawn: t.drawn, errors: t.errors, seeks: t.seeks })),
      scores: scores.map(([c, x]) => [c, round2(x.mean), x.bad]), best };
    say('play', out.play);
    check(out.play.noSkip && frames.length > 5, '播放:不跳帧(frame 的 sec 差恒为 1/fps)', { beats: frames.length, steps: [...new Set(steps)] });
    check(stopped > 100 && stopped <= LAST, '播放:播进了 clip-a(第 100 帧以后)', stopped);
    check(d.streams.tracks.length > 0 && d.streams.tracks.every((t) => t.errors === 0 && t.drawn > 3), '播放:流平面一路画着,解码器没报错', out.play.tracks);
    check(d.streams.tracks.every((t) => t.lastDrawn === stopped || t.lastDrawn === null), '播放:暂停时流平面停在暂停的那一帧', out.play.tracks);
    check(best === stopped && scores[1][1].mean < 3, '播放:暂停的那一帧,舞台(贴流)最像导出页的同一帧', out.play.scores);
  }
  await rpc('setRole', 'back', { job: 'probe' });
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { hostServer?.close(); } catch { /* ignore */ }
  try { await pipeline?.close(); } catch { /* ignore */ }
  try { await bakery?.close(); } catch { /* ignore */ }
  dropStreamEncoderSpares();
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) {
    try {
      for (const name of await fs.readdir(OUT)) if (!/\.(json|png)$/.test(name) && name !== 'previews') await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
