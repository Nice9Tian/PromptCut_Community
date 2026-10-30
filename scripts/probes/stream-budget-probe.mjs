/**
 * 同屏轨道流的预算(数像素)、流平面共用一个 WebGL 上下文、超出预算的层的占位符 —— 探针(任务书「己三乙」;
 * 口径与数字在 `src/render/streamBudget.mjs`,依据是 `docs/archive/agent-reports/AGENT-rr-merged-eval.md`)。
 *
 *   node scripts/probes/stream-budget-probe.mjs --port 27340 [--host-port 27345] [--seconds 4] [--no-before] [--only-play] [--out <dir>] [--json <file>]
 *
 * 自己在检出根起一台 dev server(另占 +1、+2 当舞台端口),用完按进程号收掉。流是 ffmpeg 用产品的编码参数造的测试图样
 * (上下拼合的 H.264、15 帧一段),清单和字节由本探针的本机服务给;不起预渲染进程。
 *
 * 甲、舞台(真的 `StageView`,测试页扮演父页,流平面照父页的办法用产品的 `planesWithinBudget` 截):
 *   1. 同屏 30 张小卡(640×360,30 帧每秒):30 条都在预算里,每一帧每条流都画出这一帧,没有占位符,全页只建了一个 WebGL 上下文;
 *   2. 同屏 8 张满屏卡(60 帧每秒):6 条在预算里照画;超出的 2 层不建解码器、显示占位符,位置是清单里这一帧所在分段的位置矩形,
 *      播放头进了下一个分段位置跟着换。
 * 乙、播放器(页面里直接起 `StreamPlayer`,rAF 照真实时间播):同屏 1、6、16、30 条小卡流,每拍 `present` 花多少毫秒、
 *   按时画上的帧数;`--no-before` 不给时再拿 main 上的 `streamPlayer.ts`(每块平面一个上下文;条数预算临时放开)跑同样的,对着看。
 *   两种画法各停在同一帧,比平面上的像素(应逐像素相同)。
 *
 * 输出 JSON 结论,过程写 stderr;甲里任何一条不过就以非零退出。耗时只记录。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { serve, flagArg } from './probe-connect.mjs';
import { startDevServer, sleep } from './below-stream-common.mjs';
import { makeStream } from './merged-stream-common.mjs';
import { localPlacement } from '../../server/frame-stream.mjs';
import { planesWithinBudget } from '../../src/render/streamPlayer.ts';
import { localStreamPixels, streamCodedPixels, STREAM_PIXEL_RATE_BUDGET, STREAM_COUNT_BUDGET } from '../../src/render/streamBudget.mjs';

const args = process.argv.slice(2);
const PORT = Number(flagArg('port', '0', args));
const HOST_PORT = Number(flagArg('host-port', '0', args)) || 0;
const SECONDS = Number(flagArg('seconds', '4', args)) || 4;
const BEFORE = !args.includes('--no-before');
const ONLY_PLAY = args.includes('--only-play');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-budget-${Date.now().toString(36)}`));
if (!PORT) { console.error('要给 --port <自己起一台 dev server 的端口>'); process.exit(2); }

const ROOT = path.resolve(fileURLToPath(import.meta.url), '../../..');
const WIDTH = 1920, HEIGHT = 1080, SEG = 15, DURATION = 4;
const STAGE = { width: WIDTH, height: HEIGHT };
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 900))); say('FAIL', { label, extra }); } return !!cond; };
const round2 = (n) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ 造流:同一种尺寸、帧率的卡共用一份字节,各有各的清单 */

const streams = new Map();   // 流键 → { manifest, init, segments }
const made = new Map();
async function bytesFor(bound, fps) {
  const id = `${bound.w}x${bound.h}@${fps}`;
  if (!made.has(id)) {
    const packed = { width: bound.w, height: 2 * bound.h + 16 };
    const t0 = Date.now();
    const s = await makeStream({ width: packed.width, height: packed.height, frames: DURATION * fps, fps });
    if (!s.ok) throw new Error(`造流失败 ${id}:${s.error}`);
    say('stream-made', { id, packed, segments: s.segments.length, bytes: s.bytes, ms: Date.now() - t0 });
    made.set(id, { ...s, packed });
  }
  return made.get(id);
}
/** 给一张卡登记一条流。`boxOf(n)`:第 n 个分段的位置矩形(平面坐标) */
async function addStream(key, clip, fps, boxOf) {
  const bound = localPlacement(clip, STAGE).bound;
  const bytes = await bytesFor(bound, fps);
  const segments = {};
  bytes.segments.forEach((_, n) => { segments[n] = { init: 'v0', file: `${n}.m4s`, stride: 1, samples: SEG, box: boxOf(n) }; });
  streams.set(key, { init: bytes.init, segments: bytes.segments,
    manifest: { streamKey: key, kind: 'card', plane: 'local', clipIds: [clip.id], fps, segmentFrames: SEG, originFrame: 0, bound, tight: null,
      offset: localPlacement(clip, STAGE).offset, inits: { v0: { codec: bytes.codec, width: bytes.packed.width, height: bytes.packed.height, rect: bound } }, segments } });
  return { key, lastSegment: bytes.segments.length - 1, bound };
}

const cardClip = (id, frame) => ({ id, kind: 'card', cardId: 'r6-stateful', start: 0, end: DURATION, params: {}, ...(frame ? { frame } : {}) });
const projectOf = (id, fps, clips) => ({ id, name: id, width: WIDTH, height: HEIGHT, fps, duration: DURATION, themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: clips.map((c) => ({ id: `tr-${c.id}`, name: c.id, hidden: false, clips: [c] })) });

/** 小卡:640×360,6 列错开摆(互相压着一点,不影响解码的量) */
const smallClips = (n) => Array.from({ length: n }, (_, i) => cardClip(`s${i}`, { x: 20 + (i % 6) * 250, y: 20 + Math.floor(i / 6) * 170, w: 640, h: 360 }));
const fullClips = (n) => Array.from({ length: n }, (_, i) => cardClip(`f${i}`, null));
/** 满屏卡第 n 个分段的位置矩形:每张卡各占一条横带,每段往右挪 60 像素 */
const fullBox = (i) => (n) => ({ x: 200 + 60 * n, y: 100 + i * 110, w: 600, h: 90 });

const hostHtml = (oa, ob) => `<!doctype html><html><head><meta charset="utf-8"><title>stream budget probe host</title></head>
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
  for (const m of ['setProject', 'setTime', 'setRole', 'setSuppressed', 'setStreamPlanes']) c[m] = call(m);
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
const playerHtml = '<!doctype html><html><head><meta charset="utf-8"><title>stream budget probe player</title></head><body style="margin:0;background:#202020"></body></html>';

/** 乙:页面里直接起播放器。在页面里跑(`page.evaluate`) */
async function runPlayerInPage({ moduleUrl, base, keys, fps, seconds, bounds, stillFrame, lastFrame }) {
  const mod = await import(moduleUrl);
  document.body.innerHTML = '';
  const root = document.createElement('div');
  root.style.cssText = 'position:relative;width:1920px;height:1080px;overflow:hidden';
  document.body.appendChild(root);
  const lostEvents = { n: 0 };
  document.addEventListener('webglcontextlost', () => { lostEvents.n++; }, true);
  keys.forEach((key, i) => {
    const wrap = document.createElement('div');
    wrap.setAttribute('data-pc-clip', `c${i}`);
    wrap.style.cssText = `position:absolute;left:${20 + (i % 6) * 250}px;top:${20 + Math.floor(i / 6) * 170}px;width:${bounds.w - 64}px;height:${bounds.h - 64}px`;
    const canvas = document.createElement('canvas');
    canvas.setAttribute('data-pc-stream-plane', '');
    canvas.width = 0; canvas.height = 0;
    canvas.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%';
    wrap.appendChild(canvas);
    root.appendChild(wrap);
  });
  const player = new mod.StreamPlayer({ root: () => root, source: new mod.HttpStreamSource(async () => base) });
  const segments = Math.floor(lastFrame / 15);
  const planes = keys.map((key, i) => ({ clipIds: [`c${i}`], key, ranges: [[0, segments]], originFrame: 0 }));
  player.setPlanes(planes, fps);
  const raf = () => new Promise((r) => requestAnimationFrame(r));
  const tracksOf = () => player.diag().tracks;
  // 起步:等每条流画出第 0 帧(取清单、取字节、建解码器都在这里,不算进播放的那一段)
  const warm0 = performance.now();
  for (;;) {
    player.present(0);
    const tracks = tracksOf();
    if (tracks.length === keys.length && tracks.every((t) => t.lastDrawn === 0)) break;
    if (performance.now() - warm0 > 15000) break;
    await raf();
  }
  const warmMs = performance.now() - warm0;
  const started = tracksOf().length;
  const cost = [];
  let beats = 0, onTime = 0, last = 0;
  const t0 = performance.now();
  for (;;) {
    await raf();
    const sec = (performance.now() - t0) / 1000;
    if (sec >= seconds) break;
    const f = Math.round(sec * fps + 1e-6);
    if (f > lastFrame) break;
    if (f === last) continue;
    last = f;
    const a = performance.now();
    player.present(sec);
    cost.push(performance.now() - a);
    beats++;
    for (const t of tracksOf()) if (t.lastDrawn === f) onTime++;
  }
  const sorted = [...cost].sort((x, y) => x - y);
  const mean = cost.reduce((s, v) => s + v, 0) / Math.max(1, cost.length);
  // 停在同一帧,读平面上的像素(每块平面取中间 64×64,连成一个校验和)
  let hash = null, painted = 0, blank = 0;
  if (stillFrame != null) {
    const until = performance.now() + 6000;
    for (;;) {
      player.present(stillFrame / fps + 1e-4);
      if (tracksOf().every((t) => t.lastDrawn === stillFrame) || performance.now() > until) break;
      await raf();
    }
    await raf();
    const scratch = document.createElement('canvas');
    scratch.width = 64; scratch.height = 64;
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    let h = 2166136261;
    for (const canvas of root.querySelectorAll('canvas[data-pc-stream-plane]')) {
      ctx.clearRect(0, 0, 64, 64);
      if (canvas.width > 64 && canvas.height > 64) ctx.drawImage(canvas, (canvas.width >> 1) - 32, (canvas.height >> 1) - 32, 64, 64, 0, 0, 64, 64);
      const data = ctx.getImageData(0, 0, 64, 64).data;
      let any = false;
      for (let i = 0; i < data.length; i++) { h = Math.imul(h ^ data[i], 16777619) >>> 0; if (data[i]) any = true; }
      if (any) painted++; else blank++;
    }
    hash = h;
  }
  const diag = player.diag();
  const out = { tracks: started, warmMs: Math.round(warmMs), beats, expected: beats * keys.length, onTime, presentMs: { mean, p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0, max: sorted.at(-1) ?? 0 },
    contextLostEvents: lostEvents.n, gl: diag.gl ?? null, errors: diag.tracks.reduce((s, t) => s + t.errors, 0), hash, painted, blank };
  player.stop();
  return out;
}

const out = { out: OUT, budget: { pixelRate: STREAM_PIXEL_RATE_BUDGET, count: STREAM_COUNT_BUDGET } };
await fs.mkdir(OUT, { recursive: true });
let dev = null, browser = null, hostServer = null;
const BEFORE_FILE = path.join(ROOT, 'src', 'render', '__streamPlayerBefore.probe.ts');
try {
  dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'budget' });
  const origin = dev.origin.replace(/\/+$/, '');
  say('spawn', { pid: dev.pid, port: PORT });
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  if (!ports.ok || !Array.isArray(ports.ports) || ports.ports.length < 2) throw new Error(`舞台端口没起来:${JSON.stringify(ports)}`);
  const u = new URL(origin);
  const [originA, originB] = ports.ports.slice(0, 2).map((p) => `${u.protocol}//${u.hostname}:${p}`);

  hostServer = await serve(HOST_PORT, (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-store');
    if (url.pathname === '/host') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(hostHtml(originA, originB)); return; }
    if (url.pathname === '/player') { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(playerHtml); return; }
    const m = /^\/api\/frames\/stream\/([^/]+)\/(manifest|init|seg)(?:\/([^/]+))?$/.exec(url.pathname);
    const s = m ? streams.get(decodeURIComponent(m[1])) : null;
    if (!s) { res.statusCode = 404; res.end(); return; }
    if (m[2] === 'manifest') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(s.manifest)); return; }
    const body = m[2] === 'init' ? s.init : s.segments[parseInt(m[3], 10)];
    if (!body) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', 'video/mp4');
    res.end(body);
  }, '127.0.0.1');
  const base = `http://127.0.0.1:${hostServer.address().port}`;

  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });

  /* ================================================================ 甲:舞台 */
  if (!ONLY_PLAY) {
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  await page.goto(base + '/host');
  await page.waitForFunction(() => window.__ready, { timeout: 180000 });
  await page.evaluate(() => window.__ready);
  const frameA = () => page.frames().find((f) => f.url().startsWith(originA));
  const frameB = () => page.frames().find((f) => f.url().startsWith(originB));
  for (const f of [frameA(), frameB()]) await f.evaluate((b) => { window.__pcStreamBase = b; }, base);
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const rpcB = (method, ...a) => page.evaluate((m, a2) => window.__rpcB[m](...a2), method, a);
  const stageState = () => frameA().evaluate(() => {
    const d = window.__pcStageDiag();
    const placeholders = [...document.querySelectorAll('[data-pc-placeholder-plane]')].filter((el) => el.closest('[data-pc-placeholder-slot]')?.hidden === false).map((el) => {
      const r = el.getBoundingClientRect();
      return { clip: el.getAttribute('data-pc-placeholder-clip'), kind: el.getAttribute('data-pc-placeholder-kind'), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    });
    // 流平面上有没有画面:每块取中间 16×16
    const scratch = document.createElement('canvas'); scratch.width = 16; scratch.height = 16;
    const ctx = scratch.getContext('2d', { willReadFrequently: true });
    let painted = 0, planes = 0;
    for (const canvas of document.querySelectorAll('[data-pc-clip] > canvas[data-pc-stream-plane]')) {
      if (getComputedStyle(canvas).display === 'none') continue;
      planes++;
      ctx.clearRect(0, 0, 16, 16);
      if (canvas.width > 16 && canvas.height > 16) ctx.drawImage(canvas, (canvas.width >> 1) - 8, (canvas.height >> 1) - 8, 16, 16, 0, 0, 16, 16);
      if (ctx.getImageData(0, 0, 16, 16).data.some((v) => v)) painted++;
    }
    return { placeholders, planes, painted, suppressed: d.suppressed, gl: d.streams.gl, over: d.streams.over, heldBytes: d.streams.heldBytes,
      tracks: d.streams.tracks.map((t) => ({ id: t.id.split('#')[0], lastDrawn: t.lastDrawn, decoder: t.decoder, errors: t.errors, lastError: t.lastError, cap: t.cap })) };
  });
  /** 照父页的办法发流平面(产品的 `planesWithinBudget`,每条流的编码画幅按项目里这张卡的框算),再发抑制 */
  async function mountScenario(name, fps, clips, boxOf) {
    const project = projectOf(`stream-budget-${name}`, fps, clips);
    const byKey = new Map();
    const planes = [];
    for (const [i, clip] of clips.entries()) {
      const s = await addStream(`${name}-${clip.id}`, clip, fps, boxOf(i));
      byKey.set(s.key, clip);
      planes.push({ clipIds: [clip.id], key: s.key, ranges: [[0, s.lastSegment]], originFrame: 0 });
    }
    const within = planesWithinBudget(planes, fps, (p) => localStreamPixels(byKey.get(p.key).frame, STAGE));
    const over = planes.filter((p) => !within.includes(p)).map((p) => ({ ...p, over: true }));
    await rpc('setProject', project, { reset: true });
    await rpcB('setProject', project, { reset: true });
    await rpc('setRole', 'front');
    await rpcB('setRole', 'back', { job: 'probe' });
    await rpc('setTime', 0);
    await rpc('setStreamPlanes', [...within, ...over]);
    await rpc('setSuppressed', clips.map((c) => c.id));
    return { within, over };
  }
  /** 暂停着把时间设到第 f 帧,等预算里的每条流画出这一帧;回那时的状态与耗时 */
  async function seekAndWait(f, fps, count) {
    const t0 = Date.now();
    await frameA().evaluate((sec) => window.__pcStage.setTime(sec), f / fps + 1e-4);
    let state = null;
    for (;;) {
      state = await stageState();
      if (state.tracks.length === count && state.tracks.every((t) => t.lastDrawn === f)) break;
      if (Date.now() - t0 > 20000) break;
      await sleep(40);
    }
    return { state, ms: Date.now() - t0 };
  }

  // ---- 1. 同屏 30 张小卡,30 帧每秒
  {
    const fps = 30, clips = smallClips(30);
    const { within, over } = await mountScenario('small30', fps, clips, () => () => ({ x: 0, y: 0, w: 640, h: 360 }));
    const row = { fps, cards: clips.length, coded: '704x864', within: within.length, over: over.length, frames: [] };
    check(within.length === 30 && over.length === 0, '小卡 30 张:30 条都在预算里', { within: within.length, over: over.length });
    for (const f of [0, 7, 22, 44, 59, 100]) {
      const { state, ms } = await seekAndWait(f, fps, 30);
      const drawn = state.tracks.filter((t) => t.lastDrawn === f).length;
      row.frames.push({ frame: f, tracks: state.tracks.length, drawn, painted: state.painted, planes: state.planes, ms });
      check(state.tracks.length === 30 && drawn === 30, `小卡 30 张:第 ${f} 帧 30 条流都画出了这一帧`, { tracks: state.tracks.length, drawn, late: state.tracks.filter((t) => t.lastDrawn !== f).slice(0, 4) });
      check(state.painted === 30, `小卡 30 张:第 ${f} 帧 30 块流平面上都有画面`, { planes: state.planes, painted: state.painted });
    }
    await sleep(400);   // 占位符要满 120 毫秒才显示:等过了再看
    const state = await stageState();
    row.placeholders = state.placeholders.length;
    row.gl = state.gl;
    row.heldMB = round2(state.heldBytes / 1048576);
    row.decoders = state.tracks.filter((t) => t.decoder === 'configured').length;
    row.errors = state.tracks.reduce((s, t) => s + t.errors, 0);
    check(state.placeholders.length === 0, '小卡 30 张:没有占位符', state.placeholders.slice(0, 4));
    check(state.gl?.creates === 1 && state.gl?.state === 'ready' && state.gl?.losses === 0, '小卡 30 张:流平面只建了一个 WebGL 上下文,没丢', state.gl);
    check(row.errors === 0, '小卡 30 张:没有解码错误', state.tracks.filter((t) => t.errors).slice(0, 3));
    await page.screenshot({ path: path.join(OUT, 'small30.png') });
    out.small30 = row;
    say('small30', row);
  }

  // ---- 2. 同屏 8 张满屏卡,60 帧每秒:6 条在预算里,2 层超出、显示占位符
  {
    const fps = 60, clips = fullClips(8);
    const { within, over } = await mountScenario('full8', fps, clips, fullBox);
    const overIds = over.map((p) => p.clipIds[0]);
    const row = { fps, cards: clips.length, coded: '1920x2176', within: within.length, over: overIds, frames: [] };
    check(within.length === 6 && over.length === 2, '满屏卡 8 张(60 帧每秒):6 条在预算里、2 条超出', { within: within.length, over: overIds });
    // 第 7 帧在第 0 段,第 37 帧在第 2 段,第 100 帧在第 6 段
    for (const f of [7, 37, 100]) {
      const { state, ms } = await seekAndWait(f, fps, 6);
      await sleep(400);
      const s2 = await stageState();
      const n = Math.floor(f / SEG);
      const want = overIds.map((id) => ({ clip: id, ...fullBox(Number(id.slice(1)))(n) })).sort((a, b) => a.clip.localeCompare(b.clip));
      const got = s2.placeholders.map((p) => ({ clip: p.clip, x: p.x, y: p.y, w: p.w, h: p.h })).sort((a, b) => a.clip.localeCompare(b.clip));
      const drawn = state.tracks.filter((t) => t.lastDrawn === f).length;
      row.frames.push({ frame: f, segment: n, tracks: s2.tracks.length, drawn, painted: s2.painted, placeholders: s2.placeholders, want, ms });
      check(s2.tracks.length === 6 && drawn === 6, `满屏卡 8 张:第 ${f} 帧预算里的 6 条都画出了这一帧,超出的 2 层没有建解码器`, { tracks: s2.tracks.length, drawn });
      check(JSON.stringify(got) === JSON.stringify(want), `满屏卡 8 张:第 ${f} 帧(第 ${n} 段)超出的 2 层显示占位符,位置是清单里这一段的位置矩形`, { got, want });
      check(s2.placeholders.every((p) => p.kind === 'solid'), `满屏卡 8 张:第 ${f} 帧占位符是按矩形铺的那一种`, s2.placeholders.map((p) => p.kind));
      check(s2.over.length === 2, `满屏卡 8 张:第 ${f} 帧播放器记着 2 条超出预算的流`, s2.over);
      if (f === 37) await page.screenshot({ path: path.join(OUT, 'full8.png') });
    }
    const state = await stageState();
    row.gl = state.gl;
    row.heldMB = round2(state.heldBytes / 1048576);
    row.errors = state.tracks.reduce((s, t) => s + t.errors, 0);
    check(state.gl?.losses === 0, '满屏卡 8 张:共用的上下文没丢', state.gl);
    // 父页不再标 over(少了两张卡同屏):占位符撤掉
    await rpc('setStreamPlanes', within);
    await rpc('setSuppressed', within.map((p) => p.clipIds[0]));
    await sleep(300);
    const after = await stageState();
    row.afterUnmark = { placeholders: after.placeholders.length, over: after.over.length };
    check(after.over.length === 0 && after.placeholders.length === 0, '满屏卡 8 张:不再超预算以后占位符撤掉', row.afterUnmark);
    out.full8 = row;
    say('full8', { ...row, frames: row.frames.map((r) => ({ frame: r.frame, drawn: r.drawn, placeholders: r.placeholders.length, ms: r.ms })) });
  }
  await rpc('setStreamPlanes', []);
  await rpc('setSuppressed', []);
  await page.close();
  }

  /* ================================================================ 乙:播放器,换画法前后每拍的毫秒 */
  const variants = [{ name: 'shared', moduleUrl: `${origin}/src/render/streamPlayer.ts` }];
  if (BEFORE) {
    const show = spawnSync('git', ['show', 'main:src/render/streamPlayer.ts'], { cwd: ROOT, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    if (show.status === 0 && /export const DECODER_BUDGET = 6;/.test(show.stdout)) {
      // main 上的版本(每块平面一个 WebGL 上下文);条数预算临时放开到 64,否则只会建 6 条
      fsSync.writeFileSync(BEFORE_FILE, show.stdout.replace('export const DECODER_BUDGET = 6;', 'export const DECODER_BUDGET = 64;'));
      variants.unshift({ name: 'per-plane', moduleUrl: `${origin}/src/render/${path.basename(BEFORE_FILE)}` });
    } else say('before-skipped', { status: show.status, why: 'main 上的 streamPlayer.ts 取不到或不是每块平面一个上下文的那一版' });
  }
  const fps = 30;
  const smallBound = localPlacement(cardClip('x', { x: 0, y: 0, w: 640, h: 360 }), STAGE).bound;
  for (let i = 0; i < 30; i++) await addStream(`play-${i}`, cardClip(`c${i}`, { x: 0, y: 0, w: 640, h: 360 }), fps, () => null);
  out.play = { fps, seconds: SECONDS, coded: `${smallBound.w}x${2 * smallBound.h + 16}`, codedPixels: streamCodedPixels(smallBound.w, smallBound.h), rows: [] };
  for (const n of [1, 6, 16, 30]) {
    const row = { streams: n };
    for (const v of variants) {
      const p = await browser.newPage();   // 每个情形一页:上下文、解码器都从头来
      await p.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
      await p.goto(base + '/player');
      try {
        const r = await p.evaluate(runPlayerInPage, { moduleUrl: v.moduleUrl, base, keys: Array.from({ length: n }, (_, i) => `play-${i}`), fps, seconds: SECONDS, bounds: smallBound, stillFrame: 20, lastFrame: DURATION * fps - 1 });
        row[v.name] = { ...r, presentMs: { mean: round2(r.presentMs.mean), p95: round2(r.presentMs.p95), max: round2(r.presentMs.max) } };
      } catch (e) { row[v.name] = { error: String(e?.message || e).slice(0, 300) }; }
      await p.close();
    }
    if (row.shared && row['per-plane'] && row.shared.hash != null && row['per-plane'].hash != null && !row['per-plane'].blank) row.samePixels = row.shared.hash === row['per-plane'].hash;
    out.play.rows.push(row);
    say('play', row);
    check(row.shared && !row.shared.error && row.shared.tracks === n && row.shared.blank === 0 && row.shared.gl?.creates === 1, `播放器:同屏 ${n} 条小卡流都在画,只建一个上下文`, row.shared);
    if (row.samePixels === false) check(false, `播放器:同屏 ${n} 条,共用上下文画出来的和每块平面一个上下文的逐像素相同`, { shared: row.shared.hash, before: row['per-plane'].hash });
  }
} catch (e) {
  fails.push(`探针异常:${e?.stack || e}`);
  say('ERROR', { error: String(e?.stack || e).slice(0, 1200) });
} finally {
  try { await browser?.close(); } catch { /* 已经关了 */ }
  try { hostServer?.close(); hostServer?.closeAllConnections?.(); } catch { /* 已经关了 */ }
  try { await dev?.stop(); } catch { /* 已经停了 */ }
  try { fsSync.rmSync(BEFORE_FILE, { force: true }); } catch { /* 没建过 */ }
}
out.fails = fails;
out.ok = fails.length === 0;
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(fails.length ? 1 : 0);
