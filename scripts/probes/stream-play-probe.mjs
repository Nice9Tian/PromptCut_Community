/**
 * R8 轨道流**舞台侧**的端到端探针(任务书「验收」里解码与播放 / 舞台侧 / 组流平面那几条)。
 *
 *   node scripts/probes/stream-play-probe.mjs [--origin http://127.0.0.1:5230] [--group] [--out <dir>] [--json <file>]
 *
 * 1. 本进程里起一个 `FramePipeline` 把 `stream-probe-project.mjs` 的项目生产成轨道流(库根在临时目录);
 * 2. 本进程起一个 http 服务:发测试页(两个舞台 iframe,打 dev server 的两个舞台端口,带 `&preview=stage`),
 *    并用 `server/frame-stream.mjs` 的 `handleStreamRequest` 发流的字节(带 CORS)。舞台里的
 *    `streamPlayer` 经 `window.__pcStreamBase` 指到这里 —— 产品里这条路由挂在预渲染进程的
 *    `/api/frames/*` 上(见报告:那一处在 `server/vite-plugin-frames.ts`,不在本任务可改的文件里);
 * 3. 测试页**扮演父页**:只经 postMessage RPC 驱动舞台 —— `setSuppressed(H(t))` + `setStreamPlanes(...)`
 *    (平面由就绪索引里 `kind: 'stream'` 的层合成,`streamPlanesFor` 同一个口径)+ `play(0)`。
 *
 * 核对:
 *   - 流平面上真的画出了帧、解码器没报错;只在 `front` 有 decoder,`back` 一条都没有;
 *   - 单个解码器同时持有的帧 ≤ 8、解码帧总字节 ≤ 80 MB;
 *   - 播放节拍:`frame` 事件的 `sec` 差恒为 1/fps(不跳帧)、间隔中位数;
 *   - 被抑制的粒子卡:自己那块 `<canvas>` 的像素哈希在抑制期间不变,包裹层的 `data-pc-local-frame` 仍随 t 变;
 *   - 点画布能点中它(`hitTest`);组流(`--group`)时点组流平面命中的是背后组内被抑制的卡;
 *   - 冷 seek 到解出目标帧的耗时(≤ 60 ms);
 *   - 暂停在某一帧:舞台截图和导出页同一帧的整帧 PNG 逐像素比(有损编码的误差,记平均值);截图存盘;
 *   - 毛玻璃卡(里程表,活渲)叠在流画布上:那一块和导出同一帧逐像素比(模糊采样到了下面的流);
 *   - 缺分段:平面的就绪区间少给几段,那几段里流平面清成透明、播放头照走(`frame` 不停、不跳);
 *   - 对照:同一台舞台不挂流平面时的节拍(流的解码合成不拖慢节拍);
 *   - `setRole('back')` 之后 `streamPlayer` 停下、全部 `VideoFrame` 关掉。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { PNG } from 'pngjs';
import { serve, devOrigin, flagArg } from './probe-connect.mjs';
import { handleStreamRequest } from '../../server/frame-stream.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { PROJECT, produceStreams, latestLayers } from './stream-probe-project.mjs';

const args = process.argv.slice(2);
const origin = devOrigin(args);
const GROUP = args.includes('--group');
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-play-${Date.now().toString(36)}`));
const JSON_OUT = flagArg('json', null, args);
if (GROUP) process.env.PROMPTCUT_STREAM_DECODERS = '1';
const HOST_PATH = '/__stream-play-probe-host';

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); return cond; };

async function stageOrigins() {
  const r = await fetch(origin + '/api/stage/ports');
  const j = await r.json();
  if (!j.ok || !Array.isArray(j.ports) || j.ports.length < 2) throw new Error(`舞台端口没起来:${JSON.stringify(j)}`);
  const u = new URL(origin);
  return j.ports.slice(0, 2).map((p) => `${u.protocol}//${u.hostname}:${p}`);
}

const hostHtml = (oa, ob) => `<!doctype html><html><head><meta charset="utf-8"><title>stream play probe host</title></head>
<body style="margin:0;background:#202020">
<iframe id="a" src="${oa}/?stage=1&id=A&preview=stage&prerender=1" style="width:1920px;height:1080px;border:0;display:block"></iframe>
<iframe id="b" src="${ob}/?stage=1&id=B&preview=stage&prerender=1" style="width:1920px;height:1080px;border:0;display:block;opacity:0;pointer-events:none;position:absolute;left:0;top:0"></iframe>
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
  for (const m of ['setProject', 'setTime', 'render', 'hitTest', 'rectsWithBounds', 'size', 'setProxy', 'setRole', 'setPlan', 'play', 'pause', 'setSuppressed', 'setStreamPlanes', 'setScrubbing', 'setPlaying', 'setMediaT', 'setLocalHashes', 'setSnapshots']) c[m] = call(m);
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

/** RGBA PNG → 与 #202020 底色合成后的 RGB(导出页的整帧是透明底,舞台截图是叠在测试页底色上的) */
function rgbOver(pngBuf, bg = [0x20, 0x20, 0x20]) {
  const png = PNG.sync.read(pngBuf);
  const out = new Uint8Array(png.width * png.height * 3);
  for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
    const a = png.data[i + 3] / 255;
    for (let k = 0; k < 3; k++) out[j + k] = Math.round(png.data[i + k] * a + bg[k] * (1 - a));
  }
  return { width: png.width, height: png.height, rgb: out };
}

function compare(a, b, region = null) {
  if (a.width !== b.width || a.height !== b.height) return { sizeMismatch: [a.width, a.height, b.width, b.height] };
  const r = region ?? { x: 0, y: 0, w: a.width, h: a.height };
  let sum = 0, max = 0, over8 = 0, n = 0;
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) for (let k = 0; k < 3; k++) {
    const i = (y * a.width + x) * 3 + k;
    const d = Math.abs(a.rgb[i] - b.rgb[i]);
    sum += d; n++;
    if (d > max) max = d;
    if (d > 8) over8++;
  }
  return { meanAbs: +(sum / n).toFixed(4), max, over8Ratio: +(over8 / n).toFixed(6) };
}

/** 一段时间里 `frame` 事件的节拍(测试页记的) */
function beatsOf(frames, fps) {
  const steps = frames.slice(1).map((f, i) => +(f.sec - frames[i].sec).toFixed(6));
  const gaps = frames.slice(1).map((f, i) => f.at - frames[i].at).sort((a, b) => a - b);
  return { count: frames.length, first: frames[0]?.sec, last: frames.at(-1)?.sec, secStepsUnique: [...new Set(steps)],
    noSkip: steps.every(s => Math.abs(s - 1 / fps) < 1e-6),
    gapMedianMs: gaps.length ? +gaps[gaps.length >> 1].toFixed(2) : null, gapP90Ms: gaps.length ? +gaps[Math.floor(gaps.length * 0.9)].toFixed(2) : null };
}

const out = { origin, group: GROUP, out: OUT };
await fs.mkdir(OUT, { recursive: true });
let browser = null, hostServer = null, pipeline = null;
try {
  const produced = await produceStreams({ origin, root: path.join(OUT, 'library'), fails });
  pipeline = produced.pipeline;
  const producer = produced.producer;
  out.produceMs = produced.produceMs;
  if (!producer) throw new Error('轨道流没生产完');
  const layers = latestLayers(produced.layers);
  out.layers = layers.map(l => ({ clipId: l.clipId, key: l.key.slice(0, 12), ranges: l.ranges, originFrame: l.originFrame ?? null, groupClipIds: l.groupClipIds ?? null }));
  // 播放中被抑制的:有流的那几张(毛玻璃的里程表不进流,照常活渲 —— 它要模糊的正是下面的流画布)
  const heavy = [...new Set(layers.flatMap(l => l.groupClipIds?.length ? l.groupClipIds : [l.clipId]))];
  // 父页那一侧的合成:就绪索引里 `stream` 层 → 平面(有 groupClipIds 的一条组流)
  // 每条平面带着这条流自己的第一帧(舞台按它把帧号换成分段号;不带的平面舞台不解码)
  const planes = layers.map(l => ({ clipIds: l.groupClipIds?.length ? l.groupClipIds : [l.clipId], key: l.key, ranges: l.ranges, originFrame: l.originFrame }));
  out.planes = planes.map(p => ({ clipIds: p.clipIds, ranges: p.ranges }));

  const [originA, originB] = await stageOrigins();
  hostServer = await serve(0, (req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (u.pathname === HOST_PATH) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(hostHtml(originA, originB));
      return;
    }
    if (u.pathname.startsWith('/api/frames/') && handleStreamRequest(producer.store, req, res, u.pathname.slice('/api/frames'.length))) return;
    res.statusCode = 404; res.end();
  }, '127.0.0.1');
  const base = `http://127.0.0.1:${hostServer.address().port}`;
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(base + HOST_PATH);
  await page.waitForFunction(() => window.__ready, { timeout: 60000 });
  await page.evaluate(() => window.__ready);
  const frameA = () => page.frames().find(f => f.url().startsWith(originA));
  const frameB = () => page.frames().find(f => f.url().startsWith(originB));
  for (const f of [frameA(), frameB()]) await f.evaluate((b) => { window.__pcStreamBase = b; }, base);
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const rpcB = (method, ...a) => page.evaluate((m, a2) => window.__rpcB[m](...a2), method, a);
  const diagA = () => frameA().evaluate(() => window.__pcStageDiag());
  const diagB = () => frameB().evaluate(() => window.__pcStageDiag());

  await rpc('setProject', PROJECT, { reset: true });
  await rpcB('setProject', PROJECT, { reset: true });
  await rpc('setRole', 'front');
  await rpcB('setRole', 'back', { job: 'probe' });
  // 对照:不挂流平面、也不抑制,同一段播放的节拍
  await rpc('setTime', 0);
  await page.evaluate(() => { window.__frames = []; });
  await rpc('play', 0);
  await new Promise(r => setTimeout(r, 1500));
  await rpc('pause');
  out.beatsNoStreams = beatsOf(await page.evaluate(() => window.__frames), PROJECT.fps);
  // B 是 back:就算发了平面也不能建 decoder
  await rpcB('setStreamPlanes', planes);
  // 父页的 C5:播放中发 setSuppressed(H(t)) + setStreamPlanes(...)
  await rpc('setTime', 0);
  await rpc('setPlaying', true);
  await rpc('setSuppressed', heavy);
  await rpc('setStreamPlanes', planes);
  // 被抑制的粒子卡自己那块画布的像素哈希(抑制期间不该变)
  const bgHash = () => frameA().evaluate(() => {
    const wraps = document.querySelectorAll('[data-pc-clip="clip-bg"]');
    const cv = document.querySelector('[data-pc-clip="clip-bg"] canvas:not([data-pc-stream-plane])');
    if (!cv) return { missing: true, wraps: wraps.length, canvases: [...wraps].map((w) => w.querySelectorAll('canvas').length), html: wraps[0]?.innerHTML.slice(0, 300) };
    const url = cv.toDataURL();
    let h = 0; for (let i = 0; i < url.length; i++) h = (h * 31 + url.charCodeAt(i)) | 0;
    return { h, len: url.length, localFrame: document.querySelector('[data-pc-clip="clip-bg"]')?.getAttribute('data-pc-local-frame') };
  });
  const hash0 = await bgHash();
  await page.evaluate(() => { window.__frames = []; });
  await rpc('play', 0);
  await new Promise(r => setTimeout(r, 1300));
  const hash1 = await bgHash();
  const mid = await diagA();
  await new Promise(r => setTimeout(r, 400));
  const stop = await rpc('pause');
  out.pause = stop;
  const hash2 = await bgHash();
  out.bgCanvas = { hash0, hash1, hash2 };
  check(!!hash1 && hash1.h === hash2?.h, '被抑制的粒子卡:自己那块画布的像素哈希在抑制期间不变', out.bgCanvas);
  check(!!hash1 && hash1.localFrame !== hash2?.localFrame, '被抑制的粒子卡:包裹层的 data-pc-local-frame 仍随 t 变', out.bgCanvas);
  // 节拍
  out.beats = beatsOf(await page.evaluate(() => window.__frames), PROJECT.fps);
  check(out.beats.noSkip, '播放中 frame 的 sec 差恒为 1/fps(不跳帧)', out.beats.secStepsUnique);
  check(out.beats.gapMedianMs !== null && out.beatsNoStreams.gapMedianMs !== null,
    '贴流前后都量到了 frame 间隔中位数(两者之差只记录,不当闸门;原先要求 ≤ 3 ms —— 耗时只记录,不当闸门(verification.md,2026-10-07 用户改定);2026-10-23 探针总审第二遍扫描补改)', { streams: out.beats, none: out.beatsNoStreams, deltaMs: out.beats.gapMedianMs - out.beatsNoStreams.gapMedianMs });
  // 解码器状态
  const d = await diagA();
  out.diagMid = mid.streams;
  out.diagPaused = d.streams;
  const tracks = mid.streams.tracks;
  check(tracks.length === planes.length, 'front 上每个平面一条流', { tracks: tracks.length, planes: planes.length });
  for (const t of tracks) {
    check(t.drawn > 10, `${t.id}: 播放中流平面画出了帧`, { drawn: t.drawn, errors: t.errors, lastError: t.lastError });
    check(t.errors === 0, `${t.id}: 解码器没报错`, t.lastError);
    check(t.maxHeld <= 8, `${t.id}: 单个解码器同时持有 ≤ 8 帧`, t.maxHeld);
  }
  check(mid.streams.heldBytes <= 80 * 1024 * 1024, '解码帧总字节 ≤ 80 MB', mid.streams.heldBytes);
  const b = await diagB();
  check(b.streams.tracks.length === 0 && b.streamPlanes.length === 0, 'back 舞台不建 decoder、不收流平面', b.streams);
  // 暂停在这一帧:舞台截图 vs 导出页同一帧
  const iframeBox = await (await page.$('#a')).boundingBox();
  /*
   * 截图之前等舞台真画两帧,再截两张取后一张:实测 headless Chrome 截跨源 iframe 偶尔拿到一张没合成完的画面
   * (一次复跑里只剩最底下那层流画布,活渲的里程表都不在;DOM 和流的状态同时是对的,再截一次就好)。
   */
  const settleShot = async () => {
    await frameA().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: 1920, height: 1080 } });
    return page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: 1920, height: 1080 } });
  };
  const shot = await settleShot();
  // 截图那一刻舞台上都挂着什么(排查用)
  out.domAtShot = await frameA().evaluate(() => [...document.querySelectorAll('[data-pc-clip]')].map((w) => ({
    clipId: w.getAttribute('data-pc-clip'), cls: w.className, localFrame: w.getAttribute('data-pc-local-frame'),
    planes: [...w.querySelectorAll(':scope > canvas[data-pc-stream-plane], :scope > [data-pc-snapshot-plane]')].map((c) => ({ tag: c.tagName, w: c.width, style: c.getAttribute('style') })),
  })));
  out.diagAtShot = (await diagA()).streams.tracks.map((t) => ({ id: t.id.slice(0, 12), lastDrawn: t.lastDrawn, held: t.held, decoder: t.decoder }));
  out.tAtShot = (await diagA()).t;
  const shotFile = path.join(OUT, `stage-paused-${stop.stoppedAt?.toFixed(3)}.png`);
  await fs.writeFile(shotFile, shot);
  out.stageShot = shotFile;
  /*
   * 参照帧:导出页**从第 0 帧顺推、每帧都截**到这一帧(整片导出走的就是这条路:`bakeFrames` 的
   * `frames: '0-N'`)。不用随机访问(`targetFrames`):回放的那些帧不截图,Motion 的 JS 帧循环推不动
   * (`bake.mjs` 里那段注释),金句药丸的入场在目标帧上才刚开始 —— 那一张不是导出成片的样子。
   * 也不走 `see_frames`:那一条会把卡换成本进程库根里的 control PNG,而页面去 dev server 的源上取。
   */
  const refBakery = await pipeline.bakery(PROJECT, 'agent');
  let exportBuf = null;
  try {
    const frame = Math.round(stop.stoppedAt * PROJECT.fps);
    await bakeFrames(refBakery, { out: path.join(OUT, 'ref'), frames: `0-${frame}`, fullFrame: true, writeFrames: false, quiet: true,
      onFrame: async (f, buf) => { if (f === frame) exportBuf = buf; } });
  } finally { await refBakery.close().catch(() => {}); }
  if (exportBuf) {
    const exportFile = path.join(OUT, `export-${stop.stoppedAt?.toFixed(3)}.png`);
    await fs.writeFile(exportFile, exportBuf);
    out.exportShot = exportFile;
    const stageRgb = rgbOver(shot), exportRgb = rgbOver(exportBuf);
    out.compare = compare(stageRgb, exportRgb);
    check(!out.compare.sizeMismatch && out.compare.meanAbs < 3, '暂停帧:舞台(贴流)与导出同一帧的平均误差 < 3/255', out.compare);
    // 毛玻璃(里程表)那一块:它活渲,背后是流画布 —— 模糊采样对了,这一块和导出就对得上
    const glass = PROJECT.tracks.flatMap(t => t.clips).find(c => c.id === 'clip-glass')?.frame;
    if (glass) {
      out.compareGlass = compare(stageRgb, exportRgb, { x: glass.x, y: glass.y, w: glass.w, h: Math.min(glass.h, 1080 - glass.y) });
      check(out.compareGlass.meanAbs < 3, '毛玻璃卡叠在流画布上:那一块和导出同一帧的平均误差 < 3/255', out.compareGlass);
    }
  }
  /*
   * 同一个浏览器里的对照:摘掉抑制和流平面,这几张卡在舞台上活渲同一帧,再截一张。
   * 贴流 vs 活渲(同一台舞台、同一个 Chrome)——毛玻璃那一块尤其要对得上:它采样的是下面那块流画布。
   * (舞台 vs 导出页那一组里,毛玻璃本身在两种 Chrome 配置下的模糊就有差别,和流无关。)
   */
  if (!GROUP) {
    await rpc('setSuppressed', []);
    await rpc('setStreamPlanes', []);
    await rpc('setTime', stop.stoppedAt);
    await new Promise(r => setTimeout(r, 800));
    const live = await settleShot();
    const liveFile = path.join(OUT, `stage-live-${stop.stoppedAt?.toFixed(3)}.png`);
    await fs.writeFile(liveFile, live);
    out.liveShot = liveFile;
    const a = rgbOver(shot), b2 = rgbOver(live);
    out.compareLive = compare(a, b2);
    const glass = PROJECT.tracks.flatMap(t => t.clips).find(c => c.id === 'clip-glass')?.frame;
    if (glass) out.compareLiveGlass = compare(a, b2, { x: glass.x, y: glass.y, w: glass.w, h: Math.min(glass.h, 1080 - glass.y) });
    check(out.compareLive.meanAbs < 3, '贴流 vs 同一舞台活渲同一帧:平均误差 < 3/255', out.compareLive);
    if (out.compareLiveGlass) check(out.compareLiveGlass.meanAbs < 3, '毛玻璃叠在流画布上 vs 叠在活渲的卡上:平均误差 < 3/255', out.compareLiveGlass);
    // 还原成贴流的状态,后面的命中测试照旧
    await rpc('setSuppressed', heavy);
    await rpc('setStreamPlanes', planes);
    await rpc('setTime', stop.stoppedAt);
  }
  // 命中测试:药丸的中心 → 药丸;没有药丸的地方 → 粒子背景(它的流平面铺满画面)
  out.hit = { pill: await rpc('hitTest', 960, 540), corner: await rpc('hitTest', 60, 1000) };
  if (!GROUP) {
    check(out.hit.pill?.clipId === 'clip-pill', '点药丸的流画布命中药丸', out.hit.pill);
    check(out.hit.corner?.clipId === 'clip-bg', '点粒子背景的流画布命中粒子背景', out.hit.corner);
  } else {
    const group = planes.find(p => p.clipIds.length > 1);
    check(!!group, '组流模式下有一条组流平面', planes);
    const cv = await frameA().evaluate(() => {
      const c = document.querySelector('canvas[data-pc-group-plane]');
      return c ? { pe: getComputedStyle(c).pointerEvents, w: c.width, h: c.height } : null;
    });
    out.groupPlane = cv;
    check(cv?.pe === 'none', '组流平面带 pointer-events: none', cv);
    check(!!out.hit.pill && group?.clipIds.includes(out.hit.pill.clipId), '点组流平面命中的是背后组内被抑制的卡', out.hit.pill);
    const rects = await rpc('rectsWithBounds', { pixels: 'none' });
    check(rects.every(r => !String(r.clipId).includes(',')), 'rects 不把组流平面算进去', rects.map(r => r.clipId));
  }
  // 冷 seek:从当前位置跳到别的分段(没缓存过),量到解出并画上目标帧
  out.seek = await frameA().evaluate(async (target, fps) => {
    const now = window.__pcRealNow ?? (() => performance.now());
    const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
    const f = Math.round(target * fps);
    const t0 = now();
    await window.__pcStage.setTime(target);
    for (;;) {
      const tracks = window.__pcStageDiag().streams.tracks;
      if (tracks.length && tracks.every((t) => t.lastDrawn === f || !t.bound)) return { ms: +(now() - t0).toFixed(2), frame: f, drawn: tracks.map((t) => t.lastDrawn) };
      if (now() - t0 > 3000) return { ms: null, frame: f, drawn: tracks.map((t) => t.lastDrawn) };
      await wait(1);
    }
  }, 3.9, PROJECT.fps);
  check(out.seek.ms !== null, '冷 seek 解出了目标帧(用时只记录;原先要求 ≤ 60 ms —— 耗时只记录,不当闸门(verification.md,2026-10-07 用户改定);2026-10-23 探针总审第二遍扫描补改)', out.seek);
  // 缺分段:粒子背景只给前两段(0～29 帧)就绪,从第 1 秒起播 —— 第 30 帧起那一层透明、播放头照走
  if (!GROUP) {
    const bgPlane = planes.find(p => p.clipIds.length === 1 && p.clipIds[0] === 'clip-bg');
    if (bgPlane) {
      await rpc('setTime', 1);
      await rpc('setStreamPlanes', planes.map(p => p === bgPlane ? { ...p, ranges: [[0, 1]] } : p));
      await page.evaluate(() => { window.__frames = []; });
      await rpc('play', 1);
      await new Promise(r => setTimeout(r, 900));
      const missing = await diagA();
      await rpc('pause');
      const beats = beatsOf(await page.evaluate(() => window.__frames), PROJECT.fps);
      const bg = missing.streams.tracks.find(t => t.id.startsWith('clip-bg#'));
      out.missing = { beats, bg };
      check(beats.noSkip && beats.last > 1.5, '缺分段时播放头不停、不跳帧', beats);
      check(!!bg && bg.lastDrawn === null, '缺分段的那一层清成透明(这一拍没有画任何一帧)', bg);
      await rpc('setStreamPlanes', planes);
    }
  }
  // 退回后台:streamPlayer 停下、帧全部关掉
  await rpc('setRole', 'back', { job: 'probe' });
  const after = await diagA();
  check(after.streams.stopped === true && after.streams.tracks.length === 0 && after.streams.heldBytes === 0, 'setRole(back) 之后 streamPlayer 停下、VideoFrame 全部关掉', after.streams);
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
} finally {
  out.fails = fails;
  await browser?.close().catch(() => {});
  hostServer?.close();
  await pipeline?.close().catch(() => {});
  const text = JSON.stringify(out, null, 2);
  if (JSON_OUT) await fs.writeFile(JSON_OUT, text);
  console.log(text);
  console.log(fails.length ? `FAIL ${fails.length}` : 'PASS');
  process.exit(fails.length ? 1 : 0);
}
