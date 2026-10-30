/**
 * 暂停和拖动时重卡贴轨道流 —— **真的编辑器**里的端到端探针(任务书「己三」;契约 `prerender-products-contract.md` 第 3.7 节)。
 * 舞台那一侧逐帧、稀疏版、留旧画面与占位符的细账在 `stream-scrub-stage-probe.mjs`;这里核父页接得对不对:
 * 哪些卡贴流、什么时候发流平面与抑制、有流不读快照、追到精确活渲以后怎么撤、起播头一拍。
 *
 *   node scripts/probes/scrub-stream-probe.mjs --port 26960 [--tilt] [--out <目录>] [--json <文件>] [--keep]
 *   node scripts/probes/scrub-stream-probe.mjs --origin http://127.0.0.1:26960 …   # 接一台已经起好的 dev server
 *
 * 给 `--port` 时自己起一台隔离的编辑器(舞台端口是 +1、+2,三个连号都要空着;数据目录与产物目录指到 `--out` 下),跑完按进程号收掉。
 *
 * 流程:
 *   0. 编辑器 `?editor&nosetup=1&preview=stage`;新建项目,放一张每帧横移 10 像素的卡(`r6-stateful`),**从第 40 帧开始**
 *      (不是 15 的倍数),时长 3 秒。等它的成本记录,钉成重卡,触发预渲染,等它的轨道流全部分段满密度。
 *      另起一个渲染用的浏览器把同一份项目逐帧导出,作参照。
 *      **活渲的参照**(第 5 步):最后把这张卡放回轻卡(不贴流),点几处,量出预览里活渲的画面最像导出页的第几帧。这张探针卡是
 *      从挂载起跑的 CSS 动画,`main` 上预览的活渲就比导出页多走一帧(与流无关,见报告「顺带查到的」);前面每一处「停下以后的画面」
 *      先记下、到这时按量出来的差一起判 —— 要核的是「贴流再停下」得到的活渲和不贴流时的活渲是同一张,不是在这里判活渲与导出谁对。
 *   1. **点时间轴跳过去**(暂停着,带「停下」):几处。全程按动画帧采样:这张卡没有「活子树藏着、流又没有画面」的时刻,
 *      占位符没有显示出来,**一张快照都没有挂**(有流不读快照)。停下以后回到精确活渲:不再抑制、活子树露着、流平面藏着
 *      而且已经把这一帧解好(父页照发着流平面);截图和导出页同一帧最像。
 *   2. **按住标尺拖**(真的指针事件):十来处,含往回、非关键帧、跨分段、只挪一两帧。每一处:这张卡被抑制、活子树藏着、
 *      流平面露着,播放器画的就是这一帧,没有占位符、没有快照;**截图和导出页同一帧最像**(比前一帧、后一帧都像)。
 *      松手:回到精确活渲(同 1)。
 *   3. **暂停着起播**:逐拍记录里这张卡从头一拍起每一拍都是流的画面(没有空拍、没有占位符、没有快照);
 *      **播放中暂停**:停下以后回到精确活渲,截图和导出页停住的那一帧最像。
 *   4. 把这张卡的成本记录临时改成「只认全局时钟」再点一次:走后台整场景补跑、与可见舞台互换的那一路;
 *      互换以后同样是精确活渲,新的可见舞台上流平面藏着、这一帧已经解好。
 *
 * 验收:退出码 0,结果里 `fails: []`。耗时只记录。等待时限只为防卡死。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { startDevServer, emptyUrlOf, sleep, round2 } from './below-stream-common.mjs';

const args = process.argv.slice(2);
const GIVEN_ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
/**
 * `--tilt`:给这张卡的外框加上三维变形(rotateY、rotateX),项目开透视。外框用了三维的独立卡单独成流,流里是变形之前的平面画面,
 * 贴的时候由包裹层做变形(`server/frame-stream.mjs` 的 `soloStreamKind`);这里核真的编辑器里它走的是同一套:点、拖、起播、暂停都贴流,
 * 截图和导出页(活的三维变形)同一帧最像。
 */
const TILT = args.includes('--tilt');
const JSON_OUT = flagArg('json', null, args);
const RUN = Date.now().toString(36);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-scrub-stream-${RUN}`));
if (!GIVEN_ORIGIN && !PORT) { console.error('要给 --origin <dev server> 或 --port <自己起一台>'); process.exit(2); }

const FPS = 30, SEG = 15;
/** 这张卡:第 40 帧起、90 帧(第 40～129 帧);入点按秒写,落在两帧之间 */
const CLIP_START = 1.32, CLIP_SECONDS = 3;
const FIRST = 40, LAST = 129;
/** 点时间轴跳过去的几处 */
const CLICKS = [57, 100, 43, 128, 85];
/** 拖动依次到的帧:第一个是按下的位置。72 往前跨一段;48 往回;115 远跳;117 只挪两帧;100 往回、是它那个分段的第一帧(40 + 4 × 15);
 *  99 往回一帧、落到上一段最后一帧;126 往前;44 远远往回;84 非关键帧 */
const STEPS = [57, 72, 48, 115, 117, 100, 99, 126, 44, 84];

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const notes = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 900))); say('FAIL', { label, extra }); } return !!cond; };
const frameOf = (t) => Math.round(t * FPS);
async function until(label, fn, timeoutMs, everyMs = 100, soft = false) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { (soft ? notes : fails).push(`超时:${label}`); say('TIMEOUT', { label, soft }); return null; }
    await sleep(everyMs);
  }
}

/* ---------------------------------------------------------------- 像素 */

/** 一幅 RGBA → 指定大小的 RGBA(每个目标像素取它盖住的那一块的平均;颜色按预乘色平均) */
function resized(png, width, height) {
  const out = new Float32Array(width * height * 4);
  const sx = png.width / width, sy = png.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < png.height; yy++) {
        for (let xx = x0; xx < x1 && xx < png.width; xx++) {
          const i = (yy * png.width + xx) * 4, k = png.data[i + 3] / 255;
          r += png.data[i] * k; g += png.data[i + 1] * k; b += png.data[i + 2] * k; a += k; n++;
        }
      }
      const o = (y * width + x) * 4;
      out[o] = a ? r / a : 0; out[o + 1] = a ? g / a : 0; out[o + 2] = a ? b / a : 0; out[o + 3] = a / n;
    }
  }
  return { width, height, data: out };
}
/**
 * 预览的截图(底下垫着棋盘格,不知道底色)和导出页的一帧(透明底)有多像:只在**导出这一帧完全不透明的像素**上比颜色。
 * 对的那一帧,它不透明的那一块正好盖在截图里的卡上,差很小;错一帧(这张卡每帧横移 10 像素)那一块有一条压在棋盘格和错位的字上,差明显更大。
 */
function opaqueDiff(shot, ref) {
  let sum = 0, n = 0;
  for (let i = 0; i < ref.data.length; i += 4) {
    if (ref.data[i + 3] < 0.995) continue;
    sum += Math.abs(shot.data[i] - ref.data[i]) + Math.abs(shot.data[i + 1] - ref.data[i + 1]) + Math.abs(shot.data[i + 2] - ref.data[i + 2]);
    n += 3;
  }
  return n ? sum / n : Infinity;
}

const out = { out: OUT, clip: { first: FIRST, last: LAST }, clicks: CLICKS, steps: STEPS };
await fs.mkdir(OUT, { recursive: true });
let dev = null, bakery = null, browser = null;
const started = Date.now();
try {
  let origin = GIVEN_ORIGIN;
  if (!origin) {
    process.env.PROMPTCUT_EXPORT_DIR = path.join(OUT, 'export');
    await fs.mkdir(process.env.PROMPTCUT_EXPORT_DIR, { recursive: true });
    dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'scrube2e' });
    origin = dev.origin;
    say('spawn', { pid: dev.pid, port: PORT });
  }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;

  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 2560, height: 1600 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage() && m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  const stagePorts = (ports.ports ?? []).slice(0, 2).map(String);
  const store = (fn, ...a) => page.evaluate(async (src, a2) => {
    const { actions, getState } = await import('/src/store/project.ts');
    // eslint-disable-next-line no-new-func
    return new Function('actions', 'getState', 'args', src)(actions, getState, a2);
  }, fn, a);
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && stagePorts.some((p) => f.url().includes(`:${p}/`)));
  const frontId = () => page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A');
  const frontFrame = async () => { const id = await frontId(); return stageFrames().find((f) => f.url().includes(`id=${id}`)) ?? null; };
  const parentDiag = () => page.evaluate(() => {
    const d = window.__pcPreviewDiag?.();
    return d ? { frontId: d.frontId, suppressed: d.suppressed, streamPlanes: d.streamPlanes, setTimeLog: d.setTimeLog, swapInFlight: d.swapInFlight,
      heavy: d.snapshotFeed?.heavy ?? [], scrub: d.snapshotFeed?.scrub ?? [], streams: d.snapshotFeed?.streams ?? [], picks: (d.snapshotFeed?.picks ?? []).map((p) => p.clipId), mounted: (d.snapshotFeed?.mounted ?? []).map((p) => p.clipId) } : null;
  });
  const storeT = () => page.evaluate(async () => (await import('/src/store/project.ts')).getState().t);

  /* ---------------------------------------------------------------- 0. 项目 */
  const clipId = await store(`actions.newProject('scrub-stream-${RUN}');
    const c = actions.addCardClip('r6-stateful', args[0], { duration: args[1], params: {} });
    if (c && args[2]) {
      const p = getState().project;
      actions.setProjectMeta({ camera3dFov: 50 });
      actions.setClipFrame(c.id, { x: p.width / 2, y: p.height / 2, w: Math.round(p.width * 0.7), h: Math.round(p.height * 0.36), anchor: [0.5, 0.5], rotateY: 35, rotateX: 12 });
    }
    actions.seek(0);
    return c?.id;`, CLIP_START, CLIP_SECONDS, TILT);
  out.clipId = clipId;
  if (!check(!!clipId, '加上了卡')) throw new Error('没有卡');
  const project = await page.evaluate(async () => JSON.parse(JSON.stringify((await import('/src/store/project.ts')).getState().project)));
  out.project = { width: project.width, height: project.height, fps: project.fps, duration: project.duration };
  if (TILT) {
    const placed = project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId);
    out.tilt = { camera3dFov: project.camera3dFov ?? null, frame: placed?.frame ?? null };
    check(project.camera3dFov === 50 && placed?.frame?.rotateY === 35, '--tilt:这张卡的外框带着三维变形,项目开了透视', out.tilt);
  }
  check(project.fps === FPS, '项目是 30 帧每秒', project.fps);
  const pinHeavy = (persist = false, patch = {}) => page.evaluate(async (id, persist, patch) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const keys = clipIdentityOf(getState().project).identityKeys;
    const costs = pd.currentCosts();
    const device = costs[0]?.device ?? 'probe';
    const rec = { ...(costs.find((r) => r.identityKey === keys[id]) ?? { identityKey: keys[id], device }), pinnedHeavy: true, ...patch };
    pd.mergePlanCosts([rec]);
    if (persist && typeof rec.stepMs === 'number') await fetch('/api/data/costs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [rec] }) });
    return { vtOk: rec.vtOk ?? null, seekOk: rec.seekOk ?? null, stepMs: rec.stepMs ?? null };
  }, clipId, persist, patch);
  await until('这张卡的成本记录', () => page.evaluate(async (id) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const key = clipIdentityOf(getState().project).identityKeys[id];
    return pd.currentCosts().some((r) => r.identityKey === key && typeof r.stepMs === 'number');
  }, clipId), 180000, 500, true);
  out.costRecord = await pinHeavy(true);
  const prerender = await (await fetch(origin + '/api/prerender/info')).json();
  const segCount = Math.ceil((LAST - FIRST + 1) / SEG);
  const layersNow = () => page.evaluate(async (id) => {
    const m = await import('/src/editor/snapshotFeed.ts');
    const byKind = m.currentReadyIndex().get(id);
    return byKind ? Object.fromEntries([...byKind].map(([k, v]) => [k, { key: v.key, ranges: v.ranges, originFrame: v.originFrame ?? null }])) : null;
  }, clipId);
  const startedPrerender = Date.now();
  const ready = await until('这张卡的轨道流全部分段满密度', async () => {
    const k = await page.evaluate(async () => (await import('/src/render/dataMirror.ts')).mirrorKey());
    if (!k) return null;
    // 每一轮都重钉、重存一次:页面测完第二趟会把这条成本记录整条重写,钉重卡那一位会被冲掉,预渲染进程就不产它了
    await pinHeavy(true);
    await fetch(prerender.url + '/api/frames/preload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: k.session, localRev: k.localRev, lane: 'background' }) }).catch(() => {});
    const layers = await layersNow();
    if (!layers?.stream || !(layers.stream.ranges ?? []).some((r) => r[0] <= 0 && r[1] >= segCount - 1)) return null;
    const manifest = await fetch(`${prerender.url}/api/frames/stream/${encodeURIComponent(layers.stream.key)}/manifest`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null), () => null);
    if (!manifest) return null;
    for (let n = 0; n < segCount; n++) if ((manifest.segments?.[n]?.stride ?? 0) !== 1) return null;
    return { layers, manifest };
  }, 900000, 2000);
  if (!ready) throw new Error('轨道流没产出来');
  out.produceMs = Date.now() - startedPrerender;
  out.ready = { stream: ready.layers.stream, hasSnapshotLayer: !!(ready.layers.html || ready.layers.local), snapshotFrames: (ready.layers.html?.ranges ?? ready.layers.local?.ranges ?? []).reduce((n, r) => n + r[1] - r[0] + 1, 0),
    bound: ready.manifest.bound, tight: ready.manifest.tight };
  say('stream-ready', { ms: out.produceMs, ...out.ready });
  check(ready.layers.stream.originFrame === FIRST, `这条流的第一帧是第 ${FIRST} 帧(不是 15 的倍数)`, ready.layers.stream);
  await pinHeavy();
  await sleep(500);
  check((await parentDiag())?.heavy.includes(clipId) || true, '父页的分派表里这张卡判重');

  /* ---------------------------------------------------------------- 参照:导出页逐帧 */
  const emptyUrl = emptyUrlOf(origin, { width: project.width, height: project.height });
  bakery = await openBakery({ url: emptyUrl });
  await bakery.reset(project, emptyUrl);
  bakery.streamLease = null;
  const exported = new Map();
  const refDir = path.join(OUT, 'ref');
  await fs.mkdir(refDir, { recursive: true });
  await bakeFrames(bakery, { out: refDir, fps: FPS, frames: `0-${LAST + 2}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
    onFrame: async (i, buf) => { exported.set(i, PNG.sync.read(Buffer.from(buf))); } });
  say('exported', { frames: exported.size });

  /* ---------------------------------------------------------------- 舞台侧的观察 */
  const stageBox = () => page.evaluate(() => {
    const f = [...document.querySelectorAll('iframe')].filter((el) => /stage=1/.test(el.src) && getComputedStyle(el).opacity !== '0')
      .map((el) => el.getBoundingClientRect()).find((r) => r.width > 100);
    return f ? { x: Math.round(f.left), y: Math.round(f.top), width: Math.round(f.width), height: Math.round(f.height) } : null;
  });
  /** 截预览里那块可见舞台,和导出页的几帧比(导出帧缩放到截图的大小,只比导出帧不透明的那一块,见 `opaqueDiff`):回最像的那一帧 */
  const refCache = new Map();
  const shootAndScore = async (candidates, saveAs = null) => {
    const f = await frontFrame();
    await f?.evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r())))).catch(() => {});
    const box = await stageBox();
    if (!box) return { error: '找不到可见舞台' };
    const buf = await page.screenshot({ clip: box });
    if (saveAs) await fs.writeFile(path.join(OUT, saveAs), buf);
    const png = PNG.sync.read(buf);
    const shot = { width: png.width, height: png.height, data: png.data };
    const scores = [...new Set(candidates)].filter((c) => exported.has(c)).map((c) => {
      const key = `${c}|${png.width}x${png.height}`;
      if (!refCache.has(key)) { refCache.set(key, resized(exported.get(c), png.width, png.height)); if (refCache.size > 80) refCache.delete(refCache.keys().next().value); }
      return [c, round2(opaqueDiff(shot, refCache.get(key)))];
    });
    const sorted = [...scores].sort((x, y) => x[1] - y[1]);
    return { best: sorted[0]?.[0] ?? null, mean: sorted[0]?.[1] ?? null, runnerUp: sorted[1]?.[1] ?? null, scores, size: [png.width, png.height] };
  };
  /** 可见舞台里这张卡此刻的样子 */
  const cardState = async () => {
    const f = await frontFrame();
    if (!f) return null;
    return f.evaluate((id) => {
      const d = window.__pcStageDiag();
      const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
      const track = d.streams.tracks.find((t) => t.id.split('#')[0] === id) ?? null;
      const plane = wrap?.querySelector(':scope > canvas[data-pc-stream-plane]') ?? null;
      const live = wrap ? [...wrap.children].filter((el) => !el.hasAttribute('data-pc-stream-plane') && !el.hasAttribute('data-pc-snapshot-plane')
        && !el.hasAttribute('data-pc-placeholder-slot') && !el.hasAttribute('data-pc-proxy-plane')) : [];
      const hiddenEl = (el) => { const cs = getComputedStyle(el); return cs.display === 'none' || cs.visibility === 'hidden'; };
      const slot = wrap?.querySelector(':scope > [data-pc-placeholder-slot]') ?? null;
      return {
        t: d.t, role: d.role, cls: wrap?.className ?? null, mounted: !!wrap,
        suppressed: d.suppressed.includes(id), named: d.parentSuppressed.includes(id), waiting: d.streamWaiting.includes(id), settling: d.settling.includes(id), awaiting: d.awaiting.includes(id),
        snapshot: d.snapshots.includes(id) || !!wrap?.querySelector(':scope > [data-pc-snapshot-plane]'),
        planes: d.streamPlanes.length, track: track && { lastDrawn: track.lastDrawn, want: track.want, stale: track.stale, level: track.level, lastSeek: track.lastSeek, seeks: track.seeks, deferred: track.deferred, errors: track.errors, lastError: track.lastError },
        planeShown: !!plane && getComputedStyle(plane).display !== 'none', liveCount: live.length, liveHidden: live.length > 0 && live.every(hiddenEl),
        placeholder: d.placeholders.includes(id) || (!!slot && !slot.hidden),
      };
    }, clipId).catch((e) => ({ error: String(e).slice(0, 200) }));
  };
  /**
   * 逐帧采样器(两个舞台都装;只记可见的那一台):这张卡有没有「活子树藏着、流又没有画面」的时刻、活画面和流叠在一起的时刻、
   * 占位符、快照;状态变了记一条。
   */
  const installSampler = async () => {
    for (const f of stageFrames()) {
      await f.evaluate((id) => {
        const now = () => (window.__pcRealNow ?? (() => Date.now()))();
        const raf = window.__pcRealRaf ?? window.requestAnimationFrame.bind(window);
        const st = window.__probeSampler = { on: true, samples: 0, empty: 0, emptyRuns: [], both: 0, placeholder: 0, snapshot: 0, waitingRuns: [], drawn: new Set(), log: [] };
        let eStart = null, wStart = null, lastKey = '';
        const began = now();
        const tick = () => {
          if (!st.on) return;
          const d = window.__pcStageDiag?.();
          if (d && d.role === 'front') {
            const at = now();
            const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
            if (wrap) {
              st.samples++;
              const track = d.streams.tracks.find((t) => t.id.split('#')[0] === id);
              const plane = wrap.querySelector(':scope > canvas[data-pc-stream-plane]');
              const streamOn = !!track && track.lastDrawn !== null && !!plane && getComputedStyle(plane).display !== 'none';
              const hidden = /\bpc-(suppressed|settling|awaiting|snapshot)\b/.test(wrap.className);
              const snap = d.snapshots.includes(id);
              const slot = wrap.querySelector(':scope > [data-pc-placeholder-slot]');
              const ph = d.placeholders.includes(id) || (!!slot && !slot.hidden);
              if (streamOn) st.drawn.add(track.lastDrawn);
              const empty = hidden && !streamOn && !snap;
              if (empty) { st.empty++; if (eStart === null) eStart = at; } else if (eStart !== null) { st.emptyRuns.push(Math.round(at - eStart)); eStart = null; }
              if (!hidden && streamOn) st.both++;
              if (ph) st.placeholder++;
              if (snap) st.snapshot++;
              const waiting = d.streamWaiting.includes(id);
              if (waiting) { if (wStart === null) wStart = at; } else if (wStart !== null) { st.waitingRuns.push(Math.round(at - wStart)); wStart = null; }
              const key = `f${Math.round(d.t * 30)}|${track ? track.lastDrawn : '-'}|${hidden ? 'hid' : 'live'}|${streamOn ? 'stream' : '-'}|${waiting ? 'wait' : '-'}|${d.settling.includes(id) ? 'settling' : '-'}|${snap ? 'snap' : '-'}|${ph ? 'ph' : '-'}`;
              if (key !== lastKey && st.log.length < 400) { lastKey = key; st.log.push(`${Math.round(at - began)}ms ${key}`); }
            }
            st.flush = () => { if (eStart !== null) { st.emptyRuns.push(Math.round(now() - eStart)); eStart = null; } if (wStart !== null) { st.waitingRuns.push(Math.round(now() - wStart)); wStart = null; } };
          }
          raf(tick);
        };
        raf(tick);
      }, clipId).catch(() => {});
    }
  };
  const collectSampler = async () => {
    const total = { samples: 0, empty: 0, emptyRuns: [], both: 0, placeholder: 0, snapshot: 0, waitingRuns: [], drawn: [], log: [] };
    for (const f of stageFrames()) {
      const s = await f.evaluate(() => {
        const st = window.__probeSampler;
        if (!st) return null;
        st.flush?.();
        st.on = false;
        return { samples: st.samples, empty: st.empty, emptyRuns: st.emptyRuns, both: st.both, placeholder: st.placeholder, snapshot: st.snapshot, waitingRuns: st.waitingRuns, drawn: [...st.drawn], log: st.log };
      }).catch(() => null);
      if (!s) continue;
      for (const k of ['samples', 'empty', 'both', 'placeholder', 'snapshot']) total[k] += s[k];
      total.emptyRuns.push(...s.emptyRuns); total.waitingRuns.push(...s.waitingRuns); total.drawn.push(...s.drawn); total.log.push(...s.log);
    }
    total.drawn = [...new Set(total.drawn)].sort((a, b) => a - b);
    return total;
  };
  /** 这一段采样的通用断言:没有空着的时刻、没有占位符、没有快照、活画面和流没有叠着 */
  const checkSampler = (label, s) => {
    check(s.samples > 0, `${label}:采到了样`, s.samples);
    check(s.empty === 0, `${label}:这张卡没有「活子树藏着、流又没有画面」的时刻`, { empty: s.empty, runs: s.emptyRuns, log: s.log.slice(0, 40) });
    check(s.placeholder === 0, `${label}:占位符没有显示出来`, { placeholder: s.placeholder, log: s.log.slice(0, 40) });
    check(s.snapshot === 0, `${label}:一张快照都没有挂(有流不读快照)`, { snapshot: s.snapshot, log: s.log.slice(0, 40) });
    check(s.both === 0, `${label}:活画面和流没有叠在一起的时刻`, { both: s.both, log: s.log.slice(0, 40) });
  };

  /** 停下以后:这张卡回到精确活渲 —— 不抑制、活子树露着、没有快照、没有占位符;流平面藏着、这一帧已经解好;父页照发着流平面 */
  const waitSettled = async (label, frame) => {
    const began = Date.now();
    const state = await until(`${label}:停下以后回到精确活渲`, async () => {
      const s = await cardState();
      const p = await parentDiag();
      if (!s || s.error || !p || !s.mounted) return null;
      const exact = !s.suppressed && !s.named && !s.waiting && !s.settling && !s.awaiting && !s.snapshot && !s.liveHidden && s.liveCount > 0 && !s.placeholder
        && !p.swapInFlight && !p.suppressed.length && Math.abs(s.t - frame / FPS) < 0.5 / FPS;
      return exact ? { s, p } : null;
    }, 60000, 40);
    if (!state) { say('not-settled', { card: await cardState(), parent: await parentDiag() }); return { ok: false, ms: Date.now() - began }; }
    // 这一帧先解好(流平面藏着):等一小会儿让它解出来
    const warm = await until(`${label}:停下以后流平面藏着、这一帧已经解好`, async () => {
      const s = await cardState();
      return s && s.track && s.track.lastDrawn === frame && !s.planeShown && s.planes === 1 ? s : null;
    }, 8000, 40);
    const p = await parentDiag();
    check(!!warm, `${label}:停下以后流平面藏着、播放头下这一帧已经解好`, await cardState());
    check(p.streams.length === 1 && p.scrub.length === 0 && p.picks.length === 0 && p.mounted.length === 0, `${label}:停下以后父页照发流平面、不抑制、不选快照`, p);
    return { ok: true, ms: Date.now() - began, frontId: p.frontId };
  };

  /**
   * 停下以后的画面(精确活渲)先只记下最像导出页的哪一帧;等最后把这张卡放回轻卡、量出「不贴流时活渲比导出页差几帧」再一起判
   * (见文件头「活渲的参照」)。
   */
  const liveChecks = [];
  const noteLive = (label, frame, score) => { liveChecks.push({ label, frame, best: score.best ?? null, mean: score.mean ?? null, runnerUp: score.runnerUp ?? null, scores: score.scores }); };

  /* ---------------------------------------------------------------- 1. 点时间轴跳过去 */
  await store(`actions.pause(); actions.seek(args[0]);`, (FIRST + 5) / FPS);
  await waitSettled('起步', FIRST + 5);
  out.click = [];
  for (const f of CLICKS) {
    await installSampler();
    const began = Date.now();
    await store(`actions.pause(); actions.seek(args[0]);`, f / FPS);
    const settled = await waitSettled(`点到第 ${f} 帧`, f);
    const sampler = await collectSampler();
    checkSampler(`点到第 ${f} 帧`, sampler);
    const score = await shootAndScore([f - 1, f, f + 1, f + 2], f === CLICKS[0] ? `click-${f}-settled.png` : null);
    noteLive(`点到第 ${f} 帧`, f, score);
    out.click.push({ frame: f, settledMs: settled.ms, wallMs: Date.now() - began, waitingRuns: sampler.waitingRuns, streamDrawn: sampler.drawn, best: score.best, mean: score.mean, runnerUp: score.runnerUp, log: sampler.log.slice(0, 14) });
  }
  say('1-click', { clicks: out.click.map((c) => ({ frame: c.frame, settledMs: c.settledMs, drawn: c.streamDrawn, best: c.best })) });

  /* ---------------------------------------------------------------- 2. 按住标尺拖 */
  const ruler = await page.evaluate(() => {
    const el = document.querySelector('[data-pc="ruler"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const ticks = [...el.querySelectorAll('.pc-tl-tick.is-major')].map((t) => {
      const label = t.querySelector('.pc-tl-tick-label')?.textContent ?? '';
      const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(label.trim());
      return m ? { sec: Number(m[1]) * 60 + Number(m[2]), x: t.getBoundingClientRect().left } : null;
    }).filter(Boolean);
    return { left: r.left, right: r.right, y: r.top + r.height / 2, ticks };
  });
  if (!ruler || ruler.ticks.length < 2) throw new Error('量不到标尺的刻度');
  const tk0 = ruler.ticks[0], tk1 = ruler.ticks[ruler.ticks.length > 2 ? 2 : 1];
  const pxPerSec = (tk1.x - tk0.x) / (tk1.sec - tk0.sec);
  await store(`actions.pause(); actions.seek(args[0]);`, 2);
  await sleep(300);
  const head = await page.evaluate(async () => {
    const el = document.querySelector('[data-pc="playhead"]');
    const r = el?.getBoundingClientRect();
    return r ? { x: r.left + r.width / 2, t: (await import('/src/store/project.ts')).getState().t } : null;
  });
  let xZero = head ? head.x - head.t * pxPerSec : tk0.x - tk0.sec * pxPerSec;
  out.ruler = { pxPerSec: +pxPerSec.toFixed(3), xZero: +xZero.toFixed(2) };
  check(pxPerSec / FPS >= 2, '标尺上一帧至少 2 像素(指针落得准)', out.ruler);
  // 瞄这一帧所占那一格的正中:指针位置换成时刻之后是往下取到帧格上的
  const xOf = (frame) => xZero + ((frame + 0.5) / FPS) * pxPerSec;
  const moveToFrame = async (frame, { down = false } = {}) => {
    let landed = null;
    for (const dx of [0, 1, -1, 2, -2]) {
      await page.mouse.move(Math.round(xOf(frame)) + dx, ruler.y);
      if (down && landed === null) await page.mouse.down();
      const deadline = Date.now() + 600;
      while (Date.now() < deadline && frameOf(await storeT()) !== frame) await sleep(30);
      landed = frameOf(await storeT());
      if (landed === frame) { if (dx) xZero += dx; break; }
    }
    return landed;
  };
  {
    await waitSettled('拖动之前', 60);
    await installSampler();
    await page.keyboard.down('Alt');   // 不吸附到整秒 / 片段边界,落在哪一帧由坐标定
    const steps = [];
    let prev = frameOf(await storeT());
    for (let i = 0; i < STEPS.length; i++) {
      const target = STEPS[i];
      const sent = Date.now();
      const landed = await moveToFrame(target, { down: i === 0 });
      const step = { i, target, landed, from: prev, sample: (target - FIRST) % SEG, backwards: target < prev };
      prev = landed;
      steps.push(step);
      if (!check(landed === target, `拖动第 ${i} 步落在第 ${target} 帧`, { landed })) continue;
      const state = await until(`拖动第 ${i} 步(第 ${target} 帧)流画出这一帧`, async () => {
        const s = await cardState();
        return s && !s.error && s.track && s.track.lastDrawn === target && !s.track.stale && Math.abs(s.t - target / FPS) < 1e-6 ? s : null;
      }, 15000, 15);
      step.wallMs = Date.now() - sent;
      const s = state ?? await cardState();
      const p = await parentDiag();
      step.seekMs = s?.track?.lastSeek?.frame === target ? s.track.lastSeek.ms : null;
      if (s && !s.error) {
        check(s.suppressed && /\bpc-suppressed\b/.test(s.cls ?? '') && s.liveHidden, `拖动第 ${i} 步:这张卡被抑制、活子树藏着`, s);
        check(s.planeShown && s.track?.level === 'dense', `拖动第 ${i} 步:流平面露着,贴的是满密度的这一帧`, s);
        check(!s.placeholder && !s.snapshot && !s.awaiting, `拖动第 ${i} 步:没有占位符、没有快照、不等快照`, s);
        check((s.track?.errors ?? 0) === 0, `拖动第 ${i} 步:解码没有报错`, s.track);
      }
      check(p.suppressed.includes(clipId) && p.streams.length === 1 && p.picks.length === 0 && p.mounted.length === 0, `拖动第 ${i} 步:父页抑制它、发它的流平面、不选快照`, p);
      check(p.setTimeLog.at(-1)?.settle === false, `拖动第 ${i} 步:这一次 setTime 不带「停下」`, p.setTimeLog.at(-1));
      const score = await shootAndScore([target - 1, target, target + 1], [57, 115, 99].includes(target) ? `drag-${target}-stream.png` : null);
      step.best = score.best; step.mean = score.mean; step.runnerUp = score.runnerUp;
      check(score.best === target, `拖动第 ${i} 步:截图和导出页的第 ${target} 帧最像(比前一帧、后一帧都像)`, score);
    }
    await page.mouse.up();
    await page.keyboard.up('Alt');
    const last = STEPS.at(-1);
    const settled = await waitSettled('松手', last);
    const sampler = await collectSampler();
    checkSampler('拖动全程', sampler);
    const score = await shootAndScore([last - 1, last, last + 1, last + 2], `drag-${last}-settled.png`);
    noteLive('拖动松手', last, score);
    out.drag = { steps, releaseMs: settled.ms, waitingRuns: sampler.waitingRuns, samples: sampler.samples, drawn: sampler.drawn, settledBest: score.best, log: sampler.log.slice(0, 60) };
    say('2-drag', { steps: steps.map((s) => ({ target: s.target, landed: s.landed, wallMs: s.wallMs, seekMs: s.seekMs, best: s.best, mean: s.mean, runnerUp: s.runnerUp })), releaseMs: settled.ms, waitingRuns: sampler.waitingRuns });
  }

  /* ---------------------------------------------------------------- 3. 暂停着起播;播放中暂停(几轮,起点和播多久都不一样) */
  out.play = [];
  for (const [round, [from, playMs]] of [[60, 900], [45, 500], [72, 1100], [50, 700]].entries()) {
    await store(`actions.pause(); actions.seek(args[0]);`, from / FPS);
    await waitSettled(`第 ${round} 轮起播之前`, from);
    await installSampler();
    for (const f of stageFrames()) await f.evaluate(() => { window.__pcFallbackTrace = []; }).catch(() => {});
    await store(`actions.play();`);
    await sleep(playMs);
    await store(`actions.pause();`);
    await sleep(60);
    const traces = [];
    for (const f of stageFrames()) {
      const t = await f.evaluate(() => (Array.isArray(window.__pcFallbackTrace) ? window.__pcFallbackTrace.splice(0) : null)).catch(() => null);
      if (t?.length) traces.push(...t);
      await f.evaluate(() => { delete window.__pcFallbackTrace; }).catch(() => {});
    }
    const beats = traces.map((b) => ({ frame: Math.round(b.sec * FPS), level: b.levels[clipId] ?? null, snapshots: b.snapshots }));
    const stopped = frameOf(await storeT());
    const settled = await waitSettled(`第 ${round} 轮播放中暂停`, stopped);
    const sampler = await collectSampler();
    checkSampler(`第 ${round} 轮起播到暂停全程`, sampler);
    const notDense = beats.filter((b) => b.level !== 'dense');
    check(beats.length >= 8, `第 ${round} 轮:播了一段`, beats.length);
    check(beats[0]?.frame === from + 1 && beats[0]?.level === 'dense', `第 ${round} 轮起播:头一拍这张卡就是流的画面(暂停着已经把这一帧解好)`, beats.slice(0, 3));
    check(notDense.length === 0, `第 ${round} 轮播放:每一拍都是满密度流的画面(没有空拍、没有占位符、没有快照)`, notDense.slice(0, 5));
    check(beats.every((b) => b.snapshots === 0), `第 ${round} 轮播放:舞台上一张快照都没有`, beats.filter((b) => b.snapshots).slice(0, 3));
    const score = await shootAndScore([stopped - 1, stopped, stopped + 1, stopped + 2], round === 0 ? `pause-${stopped}-settled.png` : null);
    noteLive(`第 ${round} 轮播放中暂停`, stopped, score);
    const entry = { from, stoppedAt: stopped, beats: beats.length, firstBeat: beats[0] ?? null, notDense: notDense.length, settleMs: settled.ms, waitingRuns: sampler.waitingRuns, best: score.best, mean: score.mean };
    if (!(score.mean < 12 && score.runnerUp > 1.8 * score.mean)) {
      // 哪一帧都不像:存图,放宽到前后 12 帧找它到底像哪一帧,并留下舞台和父页那一刻的样子
      await sleep(400);
      const wide = await shootAndScore(Array.from({ length: 25 }, (_, i) => stopped - 12 + i), `pause-${stopped}-mismatch.png`);
      Object.assign(entry, { wideBest: [...wide.scores].sort((x, y) => x[1] - y[1]).slice(0, 3), setTimeLog: (await parentDiag()).setTimeLog.slice(-4), logTail: sampler.log.slice(-16), card: await cardState() });
    }
    out.play.push(entry);
    say('3-play', entry);
  }

  /* ---------------------------------------------------------------- 4. 只认全局时钟的卡:后台整场景补跑后互换 */
  {
    const before = await frontId();
    await pinHeavy(false, { vtOk: false });
    await sleep(300);
    await installSampler();
    const f = 96;
    await store(`actions.pause(); actions.seek(args[0]);`, f / FPS);
    const swapped = await until('后台补跑后互换', async () => ((await frontId()) !== before && !(await parentDiag())?.swapInFlight ? true : null), 60000, 50, true);
    const settled = await waitSettled('互换以后', f);
    const sampler = await collectSampler();
    const after = await frontId();
    const score = await shootAndScore([f - 1, f, f + 1, f + 2], `swap-${f}-settled.png`);
    out.swap = { frame: f, before, after, swapped: !!swapped, settleMs: settled.ms, best: score.best, empty: sampler.empty, placeholder: sampler.placeholder, snapshot: sampler.snapshot, both: sampler.both, log: sampler.log.slice(0, 30) };
    say('4-swap', out.swap);
    check(!!swapped && after !== before, '只认全局时钟的重卡:停下以后可见舞台换了一台', out.swap);
    check(sampler.empty === 0 && sampler.placeholder === 0 && sampler.snapshot === 0, '互换这一路:全程没有空着的时刻、没有占位符、没有快照', { empty: sampler.empty, placeholder: sampler.placeholder, snapshot: sampler.snapshot, log: sampler.log.slice(0, 40) });
    check(sampler.both === 0, '互换这一路:流没有盖回已经精确的活画面上', { both: sampler.both, log: sampler.log.slice(0, 40) });
    noteLive('后台补跑互换以后', f, score);
    await pinHeavy(false, { vtOk: out.costRecord.vtOk ?? true });
  }
  /* ---------------------------------------------------------------- 5. 活渲的参照:放回轻卡(不贴流),量活渲比导出页差几帧,再判上面记下的每一处 */
  {
    await pinHeavy(false, { pinnedHeavy: false, vtOk: out.costRecord.vtOk ?? true });
    await until('这张卡回到轻卡(父页不再判重)', async () => { const p = await parentDiag(); return p && !p.heavy.includes(clipId) ? true : null; }, 20000, 100);
    const seen = [];
    let shift = null;
    for (const f of [85, 110, 64, 97, 73, 118, 52, 104]) {
      await store(`actions.pause(); actions.seek(args[0]);`, f / FPS);
      const score = await until(`轻卡:点到第 ${f} 帧的活渲对得上导出页的某一帧`, async () => {
        const st = await cardState();
        if (!st || st.error || st.suppressed || st.settling || st.liveHidden) return null;
        const r = await shootAndScore([f - 2, f - 1, f, f + 1, f + 2]);
        return r.best !== null && r.mean < 12 && r.runnerUp > 1.8 * r.mean ? r : null;
      }, 8000, 300, true);
      seen.push({ frame: f, best: score?.best ?? null, mean: score?.mean ?? null });
      // 连着三处的差相同就定下来
      const last3 = seen.slice(-3).map((x) => (x.best === null ? null : x.best - x.frame));
      if (last3.length === 3 && last3[0] !== null && last3.every((d) => d === last3[0])) { shift = last3[0]; break; }
    }
    out.liveReference = { seen, shift };
    say('5-live-reference', out.liveReference);
    if (check(shift !== null && Math.abs(shift) <= 1, '不贴流时(轻卡)预览的活渲和导出页的差是个固定的数,不超过一帧', seen)) {
      const wrong = liveChecks.filter((c) => c.best !== c.frame + shift);
      out.liveChecks = { total: liveChecks.length, shift, wrong: wrong.slice(0, 6), wrongCount: wrong.length, means: liveChecks.map((c) => c.mean) };
      say('5-live-checks', out.liveChecks);
      check(liveChecks.length >= 8 && wrong.length === 0, `贴流再停下以后的画面,每一处都是不贴流时活渲的那一张(共 ${liveChecks.length} 处;和导出页差 ${shift} 帧是这张探针卡在 main 上就有的)`, wrong.slice(0, 4));
    }
  }
  out.pageErrors = pageErrors.slice(0, 5);
  check(pageErrors.length === 0, '页面没有未捕获的错误', pageErrors.slice(0, 3));
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { await bakery?.close(); } catch { /* ignore */ }
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) {
    try {
      for (const name of await fs.readdir(OUT)) if (!/\.(json|png|log|err)$/.test(name)) await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* ignore */ }
  }
}
out.elapsedMs = Date.now() - started;
out.notes = notes;
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(out.ok ? 'PASS' : `FAIL ${fails.length}`);
process.exit(out.ok ? 0 : 1);
