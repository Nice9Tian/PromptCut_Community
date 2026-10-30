/**
 * 输出节点带上游的片段(挂了强调的卡片段)经真的预渲染管线跑一遍:两张不同的卡挂同样的强调,各是各的画面吗
 * (报告 `docs/archive/agent-reports/AGENT-rr-emphasis-key.md`;单测 `server/test/card-cache-upstream-key.test.mjs`)。
 *
 *   node scripts/probes/emphasis-key-probe.mjs [--port 27840] [--out <dir>] [--keep] [--json <file>]
 *
 * 自己在检出根起一个 dev server(`--port`,另占 +1、+2 当舞台端口、+5 给测试页;带 `PROMPTCUT_NO_PORT_FILE=1`,不碰 5190～5192),
 * 本进程里直接起一个 `FramePipeline`(同预渲染进程的代码,`interactive: true`),库根放 `--out`。灌一个项目,四个片段都挂同样的
 * 描边强调、框一样大、时长都是 3 秒、入点都落在整帧上(采样相位相同):
 *
 *   clip-l     金句药丸 `punch-pill`,文字 AAA          0～3 秒   画面左上
 *   clip-r     人物聚焦 `focus-card`,要点 ZZZ…         0～3 秒   画面右下     和 clip-l 是两张不同的卡
 *   clip-late  金句药丸,文字 LATE                       4～7 秒   画面左上     和 clip-l 同一张卡、参数不同
 *   clip-twin  金句药丸,文字 AAA(和 clip-l 一模一样)   4～7 秒   画面右下     和 clip-l 里外都相同
 *
 * 记下来的(结论 JSON 的 `plan`、`streams`、`layers`):每个片段的输出节点、档位、能不能单独预渲染、进不进预渲染集合、
 * 三个键;`planStreams` 给每个片段出的流;就绪索引发给页面的每一层用的是哪个键。
 *
 * 核对:
 *   1. 四个片段的输出节点都是强调节点,判成共享档、能单独预渲染、进了预渲染集合、各有单卡流(这是「会不会真的贴错」的前提);
 *   2. clip-l、clip-r、clip-late 两两之间:快照的内容键、流的成员键、结果键都不相同;clip-l 与 clip-r 的流键不相同;
 *   3. clip-l 与 clip-twin:快照的内容键、结果键相同(同一张卡两个片段共用一份);入点不同,所以流键不同;
 *   4. 快照:每个片段按自己的结果键(发给页面的 `html` 层用的就是它)去读这个键下面现有的头一帧快照 HTML,里面是这个片段自己的文字、
 *      没有别的片段的文字(文字在 DOM 里,与入场动画做到哪一步无关);
 *   5. 舞台:一个舞台 iframe 照父页的做法贴流(`setSuppressed` + `setStreamPlanes`,平面取自就绪索引的 `stream` 层),
 *      播到 1.7 秒、5.7 秒各停一次截图;再摘掉流让这几张卡活渲同一帧截一张。每个片段的框那一块,贴流与活渲相差很大的像素
 *      (三个分量里最大的差超过 64)不到 0.3%(判据的来历见 `regionDiff`)。截图存在 `--out` 下的 `shots/`。
 *
 * 输出 JSON 结论,过程写 stderr;任何一条不过就以非零退出。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { serve, flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { handleStreamRequest } from '../../server/frame-stream.mjs';
import { rangeCount } from '../../server/snapshot-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const PORT = Number(flagArg('port', '27840', args));
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-emphasis-key-probe-${Date.now().toString(36)}`));
if (!(PORT >= 20000)) throw new Error('端口要在 20000 以上');

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); say('FAIL', { label, extra }); } return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const EMPHASIS = { kind: 'outline', color: '#ffd400', size: 8, opacity: 1 };
const BOX_L = { x: 80, y: 60, w: 800, h: 450 };
const BOX_R = { x: 1040, y: 570, w: 800, h: 450 };
const TEXT = { 'clip-l': 'AAA', 'clip-r': 'ZZZ', 'clip-late': 'LATE', 'clip-twin': 'AAA' };
const PROJECT = {
  id: 'emphasis-key-probe', name: '强调键探针', width: 1920, height: 1080, fps: 30, duration: 8,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-l', name: 'l', hidden: false, clips: [
      { id: 'clip-l', kind: 'card', cardId: 'punch-pill', start: 0, end: 3, params: { text: 'AAA' }, frame: { ...BOX_L }, emphasis: { ...EMPHASIS } },
      { id: 'clip-late', kind: 'card', cardId: 'punch-pill', start: 4, end: 7, params: { text: 'LATE' }, frame: { ...BOX_L }, emphasis: { ...EMPHASIS } },
    ] },
    { id: 'tr-r', name: 'r', hidden: false, clips: [
      { id: 'clip-r', kind: 'card', cardId: 'focus-card', start: 0, end: 3, params: { items: 'ZZZ 一|ZZZ 二|ZZZ 三', bg: 'dark' }, frame: { ...BOX_R }, emphasis: { ...EMPHASIS } },
      { id: 'clip-twin', kind: 'card', cardId: 'punch-pill', start: 4, end: 7, params: { text: 'AAA' }, frame: { ...BOX_R }, emphasis: { ...EMPHASIS } },
    ] },
  ],
};
const CLIPS = ['clip-l', 'clip-r', 'clip-late', 'clip-twin'];
const BOX_OF = { 'clip-l': BOX_L, 'clip-r': BOX_R, 'clip-late': BOX_L, 'clip-twin': BOX_R };
const DISTINCT = [['clip-l', 'clip-r'], ['clip-l', 'clip-late'], ['clip-r', 'clip-late']];

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

/** 父页那一侧的最小替身:一个舞台 iframe,只经 postMessage RPC 驱动(同 `stream-play-probe.mjs`) */
const hostHtml = (stage) => `<!doctype html><html><head><meta charset="utf-8"><title>emphasis key probe host</title></head>
<body style="margin:0;background:#202020">
<iframe id="a" src="${stage}/?stage=1&id=A&preview=stage&prerender=1" style="width:1920px;height:1080px;border:0;display:block"></iframe>
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
window.__ready = new Promise((res) => {
  const frame = document.getElementById('a');
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    window.__rpc = createStageRpc(frame.contentWindow, '${stage}'); res(true);
  });
});
</script></body></html>`;

/** 截图的一块 → RGB(截图不透明,直接取) */
function regionRgb(pngBuf, box) {
  const png = PNG.sync.read(pngBuf);
  const x0 = Math.max(0, box.x), y0 = Math.max(0, box.y), x1 = Math.min(png.width, box.x + box.w), y1 = Math.min(png.height, box.y + box.h);
  const out = new Uint8Array((x1 - x0) * (y1 - y0) * 3);
  let j = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * png.width + x) * 4; out[j++] = png.data[i]; out[j++] = png.data[i + 1]; out[j++] = png.data[i + 2]; }
  return out;
}
/**
 * 两块画面差多少:`meanAbs` 是三个分量的平均绝对差;`bigRatio` 是「相差很大」的像素占多少(三个分量里最大的差超过 64)。
 * 有损编码的误差落在前一个数上(实测 0.2～0.8),几乎不产生相差很大的像素(实测 0.002%～0.02%);贴成别的画面时后一个数是百分之几到几十
 * (实测:同一张卡文字不同 2.4%,换了一张卡 77%)。所以按后一个数判。
 */
function regionDiff(a, b) {
  if (a.length !== b.length || !a.length) return { meanAbs: null, bigRatio: null };
  let sum = 0, big = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d0 = Math.abs(a[i] - b[i]), d1 = Math.abs(a[i + 1] - b[i + 1]), d2 = Math.abs(a[i + 2] - b[i + 2]);
    sum += d0 + d1 + d2;
    if (Math.max(d0, d1, d2) > 64) big++;
  }
  return { meanAbs: +(sum / a.length).toFixed(3), bigRatio: +(big / (a.length / 3)).toFixed(6) };
}
const BIG_RATIO_MAX = 0.003;
async function cropPng(pngBuf, box, file) {
  const png = PNG.sync.read(pngBuf);
  const out = new PNG({ width: box.w, height: box.h });
  PNG.bitblt(png, out, box.x, box.y, box.w, box.h, 0, 0);
  await fs.writeFile(file, PNG.sync.write(out));
}

const out = { port: PORT, library: OUT, project: PROJECT.id };
await fs.mkdir(OUT, { recursive: true });
const SHOTS = path.join(OUT, 'shots');
await fs.mkdir(SHOTS, { recursive: true });
const RUN = Date.now().toString(36);
const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pc-emphasis-key-dev-'));
let child = null, pipeline = null, browser = null, hostServer = null;
try {
  // ---------- 0. dev server(本检出根,临时数据目录,不写公共的端口文件)
  const log = [];
  child = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: {
      ...process.env, BROWSER: 'none', PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_DATA_DIR: path.join(TMP, 'data'), PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0',
      PROMPTCUT_LAN_HOST: '', PROMPTCUT_DEVICE_ID: `emphkey-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'emphasis-key-probe',
    },
  });
  const keep = (c) => { log.push(c.toString()); if (log.length > 400) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  say('spawn', { pid: child.pid, port: PORT });
  const origin = `http://127.0.0.1:${PORT}`;
  const up = await until('dev server 起来', async () => {
    if (child.exitCode !== null) throw new Error(`dev server 退出了:${log.join('').slice(-600)}`);
    return fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 180_000, 300);
  if (!up) throw new Error(`dev server 没起来:${log.join('').slice(-600)}`);
  out.origin = origin;

  // ---------- 1. 管线:灌项目,等流全部满密度、共享档快照产齐。不钉预渲染集合:进不进集合照产品自己判
  pipeline = new FramePipeline({ root: path.join(OUT, 'library'), origin: () => origin, interactive: true, playhead: () => null });
  const producer = pipeline.streamProducer();
  producer.attachRoute();
  const layerLog = [];
  pipeline.readyIndex.subscribe((message) => { if (message.type === 'layer') layerLog.push(message); });
  const t0 = Date.now();
  const entry = await pipeline.preload(PROJECT);
  const dense = () => {
    const status = producer.status();
    if (!status.streams.length) return null;
    for (const s of status.streams) for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
    return !producer.workers.size && !producer.encoding.size ? status : null;
  };
  await until('card plan 算出来', () => (Array.isArray(entry.cardPlan) && entry.cardPlan.length ? entry.cardPlan : null), 180_000);
  const status = await until('全部分段满密度', dense, 900_000, 1000);
  if (!status) throw new Error('流没产完');
  const plan = entry.cardPlan ?? [];
  const controlOf = Object.fromEntries(plan.map((control) => [control.clipId, control]));
  // 快照是后台一张卡一张卡、每批 4 帧慢慢产的(实测一批十几秒),每张卡的头一帧先产:等到每个片段的键下面至少有一帧(不要求整张产齐),进度记进结论
  out.snapshotProgress = [];
  const snapshotsDone = async () => {
    const row = { ms: Date.now() - t0 };
    let done = true;
    for (const clipId of CLIPS) {
      const control = controlOf[clipId];
      if (!control?.snapshotKey || control.tier !== 'shared') continue;
      const index = await pipeline.snapshots().snapshotIndex({ tier: 'shared', key: control.snapshotKey });
      row[clipId] = `${index.count}+${rangeCount(index.oversize)}/${control.count}`;
      if (!index.count) done = false;
    }
    const last = out.snapshotProgress.at(-1);
    if (!last || CLIPS.some((clipId) => last[clipId] !== row[clipId])) out.snapshotProgress.push(row);
    return done ? true : null;
  };
  await until('每个片段的键下面都有快照', snapshotsDone, 1_200_000, 2000);
  out.produceMs = Date.now() - t0;

  // ---------- 2. 记下计划、流、层
  const short = (key) => (typeof key === 'string' ? key.slice(0, 12) : key ?? null);
  out.plan = {};
  for (const clipId of CLIPS) {
    const c = controlOf[clipId];
    out.plan[clipId] = c ? {
      nodeId: c.nodeId, tier: c.tier, compositing: c.compositing, cacheable: c.cacheable, needPrerendering: c.needPrerendering, frameMode: c.frameMode ?? null,
      picked: pipeline.prerenderPicked(entry, clipId), streamPicked: pipeline.streamPicked(entry, clipId),
      contentKey: short(c.contentKey), streamMemberKey: short(c.streamMemberKey), snapshotKey: short(c.snapshotKey), cacheContentKey: short(c.cacheContentKey),
      firstFrame: c.sampling?.firstFrame, count: c.count,
    } : null;
  }
  const states = [...producer.streams.values()];
  const stateOf = (clipId) => states.find((s) => s.spec.clipIds.includes(clipId) || s.aliases?.has(clipId)) ?? null;
  out.streams = states.map((s) => ({ streamKey: short(s.spec.streamKey), contentKey: short(s.spec.contentKey), kind: s.spec.kind, clipIds: s.spec.clipIds, aliases: [...(s.aliases ?? [])], replay: s.spec.replay }));
  const lastLayer = (clipId, kind) => layerLog.filter((m) => m.clipId === clipId && m.kind === kind).at(-1) ?? null;
  out.layers = {};
  for (const clipId of CLIPS) {
    const stream = lastLayer(clipId, 'stream'), html = lastLayer(clipId, 'html');
    out.layers[clipId] = { stream: stream ? { key: short(stream.key), ranges: stream.ranges } : null, html: html ? { key: short(html.key), ranges: html.ranges } : null };
  }
  say('plan', out.plan);
  say('streams', { streams: out.streams, layers: out.layers });

  // ---------- 3. 前提与键
  for (const clipId of CLIPS) {
    const c = controlOf[clipId];
    if (!check(!!c, `${clipId}:card plan 里有它`)) continue;
    check(/\/emphasis$/.test(c.nodeId), `${clipId}:输出节点是强调节点`, c.nodeId);
    check(c.tier === 'shared' && c.cacheable === true, `${clipId}:共享档、能单独预渲染`, { tier: c.tier, cacheable: c.cacheable });
    check(pipeline.prerenderPicked(entry, clipId), `${clipId}:进了预渲染集合`);
    check(!!stateOf(clipId), `${clipId}:有单卡流(自己的,或与别的片段共用的)`);
  }
  for (const [a, b] of DISTINCT) {
    const ca = controlOf[a], cb = controlOf[b];
    if (!ca || !cb) continue;
    for (const name of ['contentKey', 'streamMemberKey', 'snapshotKey']) check(ca[name] !== cb[name], `${a} 与 ${b}:${name} 不能相同`, short(ca[name]));
  }
  {
    const sl = stateOf('clip-l'), sr = stateOf('clip-r');
    check(!!sl && !!sr && sl !== sr && sl.spec.streamKey !== sr.spec.streamKey, 'clip-l 与 clip-r:各有各的流(流键不同)', { l: short(sl?.spec.streamKey), r: short(sr?.spec.streamKey) });
    const l = controlOf['clip-l'], twin = controlOf['clip-twin'];
    if (l && twin) {
      check(l.contentKey === twin.contentKey && l.snapshotKey === twin.snapshotKey && l.streamMemberKey === twin.streamMemberKey, 'clip-l 与 clip-twin:里外都相同,快照的键相同(共用一份)',
        { l: short(l.contentKey), twin: short(twin.contentKey) });
      check(stateOf('clip-l')?.spec.streamKey !== stateOf('clip-twin')?.spec.streamKey, 'clip-l 与 clip-twin:入点不同,流键不同');
    }
  }

  // ---------- 4. 快照:按发给页面的键读一帧,里面是谁的文字
  out.snapshots = {};
  for (const clipId of CLIPS) {
    const c = controlOf[clipId];
    if (!c?.snapshotKey) continue;
    const index = await pipeline.snapshots().snapshotIndex({ tier: 'shared', key: c.snapshotKey });
    const localFrame = index.frames[0]?.[0] ?? 0; // 这个键下面现有的头一帧
    const html = await pipeline.snapshots().readSnapshot({ tier: 'shared', key: c.snapshotKey, localFrame });
    const has = Object.fromEntries(['AAA', 'ZZZ', 'LATE'].map((text) => [text, typeof html === 'string' && html.includes(text)]));
    out.snapshots[clipId] = { key: short(c.snapshotKey), localFrame, frames: index.frames, bytes: typeof html === 'string' ? html.length : null, has };
    if (typeof html === 'string') await fs.writeFile(path.join(SHOTS, `snapshot-${clipId}.html`), html);
    if (!check(typeof html === 'string', `${clipId}:它的键下面有快照`)) continue;
    const own = TEXT[clipId];
    check(has[own] && Object.entries(has).every(([text, hit]) => text === own || !hit), `${clipId}:快照里是自己的文字 ${own}`, has);
  }
  say('snapshots', out.snapshots);

  // ---------- 5. 舞台:贴流截图 vs 活渲截图
  const ports = await (await fetch(`${origin}/api/stage/ports`)).json();
  if (!ports.ok || !Array.isArray(ports.ports) || !ports.ports.length) throw new Error(`舞台端口没起来:${JSON.stringify(ports)}`);
  const stageOrigin = `http://127.0.0.1:${ports.ports[0]}`;
  out.stageOrigin = stageOrigin;
  hostServer = await serve(PORT + 5, (req, res) => {
    const u = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (u.pathname === '/__emphasis-key-probe-host') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(hostHtml(stageOrigin));
      return;
    }
    if (u.pathname.startsWith('/api/frames/') && handleStreamRequest(producer.store, req, res, u.pathname.slice('/api/frames'.length))) return;
    res.statusCode = 404; res.end();
  }, '127.0.0.1');
  const base = `http://127.0.0.1:${hostServer.address().port}`;
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });
  await page.goto(`${base}/__emphasis-key-probe-host`);
  await page.waitForFunction(() => window.__ready, { timeout: 120000 });
  await page.evaluate(() => window.__ready);
  const stageFrame = () => page.frames().find((f) => f.url().startsWith(stageOrigin));
  await stageFrame().evaluate((b) => { window.__pcStreamBase = b; }, base);
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const settleShot = async () => {
    await stageFrame().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    await page.screenshot({ clip: { x: 0, y: 0, width: 1920, height: 1080 } });
    return page.screenshot({ clip: { x: 0, y: 0, width: 1920, height: 1080 } });
  };
  // 平面:就绪索引里每个片段最后一条 `stream` 层(父页 `streamPlanesFor` 的口径:一层一个平面)
  const planes = CLIPS.map((clipId) => lastLayer(clipId, 'stream')).filter(Boolean)
    .map((l) => ({ clipIds: l.groupClipIds?.length ? l.groupClipIds : [l.clipId], key: l.key, ranges: l.ranges }));
  const heavy = [...new Set(planes.flatMap((p) => p.clipIds))];
  out.planes = planes.map((p) => ({ clipIds: p.clipIds, key: short(p.key), ranges: p.ranges }));
  await rpc('setProject', PROJECT, { reset: true });
  await rpc('setRole', 'front');
  out.stage = [];
  for (const { label, from, clips } of [{ label: 'first', from: 0, clips: ['clip-l', 'clip-r'] }, { label: 'second', from: 4, clips: ['clip-late', 'clip-twin'] }]) {
    await rpc('setTime', from);
    await rpc('setPlaying', true);
    await rpc('setSuppressed', heavy);
    await rpc('setStreamPlanes', planes);
    await rpc('play', from);
    await sleep(1700);
    const stop = await rpc('pause');
    const at = Number(stop?.stoppedAt ?? from + 1.7);
    const streamShot = await settleShot();
    const diag = await stageFrame().evaluate(() => window.__pcStageDiag?.().streams?.tracks?.map((t) => ({ id: String(t.id).slice(0, 12), drawn: t.drawn, errors: t.errors, lastError: t.lastError })) ?? null);
    await rpc('setPlaying', false);
    await rpc('setSuppressed', []);
    await rpc('setStreamPlanes', []);
    await rpc('setTime', at);
    await sleep(1000);
    const liveShot = await settleShot();
    const name = at.toFixed(3);
    await fs.writeFile(path.join(SHOTS, `stage-${label}-streams-${name}.png`), streamShot);
    await fs.writeFile(path.join(SHOTS, `stage-${label}-live-${name}.png`), liveShot);
    const rec = { label, stoppedAt: at, tracks: diag, regions: {} };
    for (const clipId of clips) {
      const box = BOX_OF[clipId];
      const diff = regionDiff(regionRgb(streamShot, box), regionRgb(liveShot, box));
      rec.regions[clipId] = { box, ...diff };
      await cropPng(streamShot, box, path.join(SHOTS, `crop-${label}-${clipId}-streams.png`));
      await cropPng(liveShot, box, path.join(SHOTS, `crop-${label}-${clipId}-live.png`));
      check(diff.bigRatio !== null && diff.bigRatio < BIG_RATIO_MAX, `${clipId}:贴流的画面和它自己活渲的画面相符(相差很大的像素 < ${BIG_RATIO_MAX * 100}%)`, diff);
    }
    out.stage.push(rec);
    say('stage', rec);
  }
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { hostServer?.close(); } catch { /* ignore */ }
  try { await pipeline?.close(); } catch { /* ignore */ }
  if (child && child.exitCode === null) {
    // 只结束自己起的进程树
    if (process.platform === 'win32') {
      await new Promise((resolve) => { const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); k.on('close', resolve); k.on('error', resolve); });
    } else child.kill('SIGKILL');
  }
  try { fsSync.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
  if (!KEEP) {
    // 留下 shots 和结论 JSON,别的(库)删掉
    try {
      for (const name of await fs.readdir(OUT)) if (name !== 'shots' && name !== 'result.json') await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* ignore */ }
  }
}
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
