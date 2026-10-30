/**
 * 依赖下层的卡贴它的轨道流 —— **真的编辑器**里的端到端探针(任务书 `docs/plan/render-refactor-task.md`「戊二」的第三块)。
 * 舞台那一侧逐帧比像素、三个场景、互换后摆平面的顺序在 `stream-below-stage-probe.mjs`;这里核父页接得对不对:
 * 真的预渲染进程发来的那一层带不带种类和输入签名、父页按自己手里的项目算的签名对不对得上(对不上这张卡就永远贴不上流)、
 * 播放 / 暂停 / 拖动时发不发流平面与抑制、下层改了以后旧流还贴不贴、重产以后再贴。
 *
 *   node scripts/probes/below-paste-editor-probe.mjs --port 27000 [--out <目录>] [--json <文件>] [--keep]
 *   node scripts/probes/below-paste-editor-probe.mjs --origin http://127.0.0.1:27000 …   # 接一台已经起好的 dev server
 *   node scripts/probes/below-paste-editor-probe.mjs --port 27000 --settle-control        # 对照:不产这种流时,重卡停下以后的活渲
 *
 * `--settle-control`(只能配 `--port`):自己起的那台编辑器带 `PROMPTCUT_TEST_BELOW_STREAMS=0`(扮没有这种流的旧行为),
 * 只做「活渲的参照」和「钉成重卡以后点到同样几帧、停下以后截图」两件事,报两边差多少、各最像导出页的哪一帧,然后收工。
 * 用来分清「重卡停下以后的活渲和轻卡时不一样」是不是贴流带来的。
 *
 * 给 `--port` 时自己起一台隔离的编辑器(舞台端口是 +1、+2,三个连号都要空着;数据目录、卡片改动层、产物目录都在 `--out` 下),
 * 跑完按进程号收掉。
 *
 * 项目(960×540,30 帧每秒):上面一条序列是毛玻璃卡(里程表 `odometer`,审阅表里依赖下层),**第 6 帧入场**(不是 15 的倍数);
 * 下面一条序列是一张 remotion 式的用户卡(经真的 `POST /api/cards/create` 建):铺满的底色上一条亮带从左往右扫过毛玻璃卡的后面。
 * 下面这张卡是轻卡、画面只由 t 决定,所以预览里它一直是**活渲**的、任何时刻都精确 —— 毛玻璃卡贴流时,它后面是舞台上此刻真实的下层。
 * 毛玻璃卡钉成重卡。
 *
 * 流程:
 *   0. 等毛玻璃卡的成本记录,钉成重卡,等它的依赖下层的流全部分段满密度。核:就绪索引里那一层带 `streamKind: "below"` 和输入签名;
 *      父页没有把它判成过期(预渲染进程按它认下的项目算的签名,和页面按 store 里的项目算的是同一个)。
 *      另起一个渲染用的浏览器把同一份项目逐帧导出,作参照。
 *   1. **点时间轴跳过去**(暂停着,带「停下」):全程按动画帧采样,这张卡没有「活子树藏着、流又没有画面」的时刻,没有占位符、没有快照;
 *      停下以后回到活渲(不抑制、活子树露着),流平面藏着、这一帧已经解好。
 *   2. **按住标尺拖**(真的指针事件):每一处这张卡被抑制、活子树藏着,舞台根下的那块流平面露着,播放器画的是这一帧(满密度、
 *      `kind: below`);父页发的流平面带 `plane: "stage"`,不选快照;**截图和导出页同一帧最像**(比前一帧、后一帧都像)——
 *      这时毛玻璃后面是活渲的下层,毛玻璃自己是流。
 *   3. **暂停着起播、播放中暂停**:逐拍记录里这张卡每一拍都是满密度流的画面;停下以后回到精确活渲。
 *   4. **下层改一处**(按着标尺不放,把下面那张卡的一个参数改掉):父页当场认出旧流过期,不再发它的流平面(舞台上旧流的轨道随之关掉),
 *      此后旧键再也没有被贴回去;预渲染进程重产以后新键到货,父页重新发流平面,舞台贴上新流 —— 截图和**改过以后**的项目的导出页同一帧
 *      最像,而且比拿改之前的导出页比更像。
 *
 * **活渲的参照**(第 0 步里,这张卡还是轻卡、流还没产出来的时候先做):暂停着点到第 1 步要用的那几帧,各截一张。
 * 第 1 步「贴流再停下」得到的画面和它比,**只记录**:重卡停下以后回到活渲走的是另一条路(子树虚拟时间追帧),入场动画还没放完的帧上
 * 两条路的结果会差一帧 —— `--settle-control`(不产这种流)里钉成重卡以后同样如此,所以这不是贴流带来的,不在这里判。
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
const SETTLE_CONTROL = args.includes('--settle-control');
const JSON_OUT = flagArg('json', null, args);
const RUN = Date.now().toString(36);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-below-paste-editor-${RUN}`));
if (!GIVEN_ORIGIN && !PORT) { console.error('要给 --origin <dev server> 或 --port <自己起一台>'); process.exit(2); }
if (SETTLE_CONTROL && GIVEN_ORIGIN) { console.error('--settle-control 要自己起编辑器(给 --port)'); process.exit(2); }
// 对照档:这台编辑器和它的预渲染进程不产依赖下层的流
if (SETTLE_CONTROL) process.env.PROMPTCUT_TEST_BELOW_STREAMS = '0';

const FPS = 30, SEG = 15, WIDTH = 960, HEIGHT = 540, SECONDS = 3.4;
const GLASS = 'clip-glass', MOVER = 'clip-mover';
/** 毛玻璃卡:0.2 秒入场(第 6 帧),3.0 秒出场(最后一帧是第 89 帧) */
const FIRST = 6, LAST = 89;
const MOVER_CARD = `bp-mover-${RUN}`;
const CLICKS = [57, 20, 83, 41];
/** 拖动依次到的帧:第一个是按下的位置。含往回、跨分段、只挪两帧、它那个分段的第一帧(6 + 3 × 15 = 51)和上一段的最后一帧 */
const STEPS = [33, 48, 24, 70, 72, 51, 50, 86, 11];
/** 改下层的那一步停在哪一帧(这一帧下面那条亮带正在毛玻璃后面看得见的那一半里) */
const EDIT_AT = 28;

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

/** 下面那张卡:remotion 式(画面只由 t 决定)、引用框架。铺满的底色,一条亮带从左往右扫,带一行跟着走的字 */
const MOVER_SOURCE = `import type { CardDef, CardProps } from "../../kernel/types";
import { interpolate } from "../../kernel/remotionStyle";

interface Params { accent: string; label: string }

function BpMover({ params, t = 0 }: CardProps<Params>) {
  const x = interpolate(t, [0, 3.4], [-60, 620]);
  const y = interpolate(t, [0, 3.4], [120, 330]);
  return (
    <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg, #16213e 0%, #0f3460 55%, #1a1a2e 100%)", fontFamily: "sans-serif", overflow: "hidden" }}>
      <div style={{ position: "absolute", left: x, top: 0, width: 90, height: "100%", background: params.accent }} />
      <div style={{ position: "absolute", left: 0, top: y, width: "100%", height: 26, background: "rgba(255,255,255,0.75)" }} />
      <div style={{ position: "absolute", left: x + 110, top: 60, color: params.accent, fontSize: 34, fontWeight: 800 }}>{params.label}</div>
    </div>
  );
}

export const bpMover: CardDef<Params> = {
  id: "${MOVER_CARD}",
  name: "贴流探针：扫过去的亮带",
  description: "探针用的 remotion 式 DOM 卡：铺满的底色上一条亮带从左往右扫",
  source: "user",
  useWhen: "探针用，不用于真实项目。",
  tags: ["探针"],
  frameMode: "direct",
  defaults: { accent: "#ffd166", label: "下层" },
  controls: [
    { key: "accent", label: "主色", type: "color" },
    { key: "label", label: "文字", type: "text" },
  ],
  Component: BpMover,
  lifecycle: { settleMs: 500, after: "hold", exit: ["fade"] },
};
`;

const PROJECT = {
  id: `below-paste-${RUN}`, name: '依赖下层的卡贴流', width: WIDTH, height: HEIGHT, fps: FPS, duration: SECONDS,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-glass', name: 'glass', hidden: false, clips: [
      { id: GLASS, kind: 'card', cardId: 'odometer', start: 0.2, end: 3.0, params: { position: 'left', value: 86420, label: '贴流探针' },
        frame: { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: WIDTH / 1920 } },
    ] },
    { id: 'tr-mover', name: 'mover', hidden: false, clips: [
      { id: MOVER, kind: 'card', cardId: MOVER_CARD, start: 0, end: SECONDS, params: { accent: '#ffd166', label: '下层' } },
    ] },
  ],
};

/* ---------------------------------------------------------------- 像素 */

/** 一幅 RGBA → 指定大小的 RGB(每个目标像素取它盖住的那一块的平均)。参照帧整幅不透明(下面那张卡铺满了底色) */
function resized(png, width, height) {
  const out = new Float32Array(width * height * 3);
  const sx = png.width / width, sy = png.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < width; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1 && yy < png.height; yy++) {
        for (let xx = x0; xx < x1 && xx < png.width; xx++) { const i = (yy * png.width + xx) * 4; r += png.data[i]; g += png.data[i + 1]; b += png.data[i + 2]; n++; }
      }
      const o = (y * width + x) * 3;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n;
    }
  }
  return { width, height, data: out };
}
/** 两幅 RGB(同样大小)在一块矩形里的平均差(满分 255)。矩形按比例给(0～1) */
function rectMean(a, b, rect) {
  const x0 = Math.floor(rect.x * a.width), x1 = Math.ceil((rect.x + rect.w) * a.width), y0 = Math.floor(rect.y * a.height), y1 = Math.ceil((rect.y + rect.h) * a.height);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * a.width + x) * 3; sum += Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2]); n += 3; }
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
    dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'belowe2e' });
    origin = dev.origin;
    say('spawn', { pid: dev.pid, port: PORT });
  }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;

  // 先建下面那张用户卡(编辑器、舞台、导出页载入之前)
  {
    const r = await fetch(origin + '/api/cards/create', { method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ id: MOVER_CARD, source: MOVER_SOURCE, projectId: PROJECT.id }), signal: AbortSignal.timeout(60_000) });
    const body = await r.json().catch(() => null);
    out.moverCard = { id: MOVER_CARD, status: r.status, ok: body?.ok ?? null, errors: r.status === 200 ? undefined : (body?.errors ?? [body?.error]).slice?.(0, 6) };
    if (!check(r.status === 200 && body?.ok === true, '下面那张用户卡建出来了(POST /api/cards/create 回 200)', out.moverCard)) throw new Error('用户卡没建出来');
  }

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
    return d ? { frontId: d.frontId, suppressed: d.suppressed, setTimeLog: d.setTimeLog, swapInFlight: d.swapInFlight,
      heavy: d.snapshotFeed?.heavy ?? [], scrub: d.snapshotFeed?.scrub ?? [], streams: d.snapshotFeed?.streams ?? [], staleBelow: d.snapshotFeed?.staleBelow ?? [],
      picks: (d.snapshotFeed?.picks ?? []).map((p) => p.clipId), mounted: (d.snapshotFeed?.mounted ?? []).map((p) => p.clipId) } : null;
  });
  const storeT = () => page.evaluate(async () => (await import('/src/store/project.ts')).getState().t);
  const storeProject = () => page.evaluate(async () => JSON.parse(JSON.stringify((await import('/src/store/project.ts')).getState().project)));

  /* ---------------------------------------------------------------- 0. 项目、钉重卡、等流 */
  const loaded = await store(`actions.loadProject(args[0]); actions.select([]); actions.pause(); actions.seek(0); return getState().project.tracks.map(t => t.clips.map(c => c.id))`, PROJECT);
  out.loaded = loaded;
  if (!check(JSON.stringify(loaded) === JSON.stringify([[GLASS], [MOVER]]), '项目载入了:上面毛玻璃卡、下面那张用户卡', loaded)) throw new Error('项目没载入');
  const project = await storeProject();
  /*
   * 活渲的参照:流还没产出来(毛玻璃卡在舞台上没有流平面、没有快照)的时候,暂停着点到第 1 步要用的那几帧,各截一张。
   * 这是「不贴流」时预览的活渲;第 1 步「贴流再停下」的画面要和它是同一张。等不到干净的状态(流已经来了)就不留这一帧的参照。
   */
  const stageBox = () => page.evaluate(() => {
    const f = [...document.querySelectorAll('iframe')].filter((el) => /stage=1/.test(el.src) && getComputedStyle(el).opacity !== '0')
      .map((el) => el.getBoundingClientRect()).find((r) => r.width > 100);
    return f ? { x: Math.round(f.left), y: Math.round(f.top), width: Math.round(f.width), height: Math.round(f.height) } : null;
  });
  /** 截预览里那块可见舞台(先等两个动画帧);`saveAs` 给了就另存一份 PNG */
  const shootStage = async (saveAs = null) => {
    const f = await frontFrame();
    await f?.evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r())))).catch(() => {});
    const box = await stageBox();
    if (!box) return null;
    const buf = await page.screenshot({ clip: box });
    if (saveAs) await fs.writeFile(path.join(OUT, saveAs), buf);
    const png = PNG.sync.read(buf);
    return resized(png, png.width, png.height);
  };
  const WHOLE = { x: 0, y: 0, w: 1, h: 1 };
  /** 毛玻璃卡(连阴影)在画面里占的那一块,按比例。对照档没有流的清单可读,用这个写死的(和这个项目的流的收紧矩形同一块) */
  const GLASS_REGION = { x: 19 / 960, y: 158 / 540, w: 328 / 960, h: 248 / 540 };
  const liveRef = new Map();
  {
    /** 毛玻璃卡此刻是纯活渲:停在这一帧、不抑制、不在追帧、没有快照、舞台上一条流平面都没有 */
    const plain = async (frame) => {
      const f = await frontFrame();
      return f?.evaluate((id, sec) => {
        const d = window.__pcStageDiag();
        const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
        return !!wrap && Math.abs(d.t - sec) < 1 / 60 && !d.suppressed.includes(id) && !d.settling.includes(id) && !d.awaiting.includes(id) && !d.snapshots.includes(id)
          && d.streamPlanes.length === 0 && d.streams.tracks.length === 0 && !/\bpc-(suppressed|settling|awaiting|snapshot)\b/.test(wrap.className);
      }, GLASS, frame / FPS).catch(() => false) ?? false;
    };
    for (const f of CLICKS) {
      await store(`actions.pause(); actions.seek(args[0]);`, (f > 40 ? f - 30 : f + 30) / FPS);
      await sleep(150);
      await store(`actions.pause(); actions.seek(args[0]);`, f / FPS);
      let last = null, kept = null;
      await until(`活渲的参照:第 ${f} 帧稳定下来`, async () => {
        if (!(await plain(f))) { last = null; return null; }
        const shot = await shootStage();
        if (!shot) return null;
        const stable = !!last && last.width === shot.width && rectMean(last, shot, WHOLE) < 0.05;
        last = shot;
        if (stable && (await plain(f))) { kept = shot; return true; }
        return null;
      }, 12000, 120, true);
      if (kept) liveRef.set(f, { frame: f, shot: kept, best: null });
    }
    say('live-reference', { frames: [...liveRef.keys()] });
  }
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
  }, GLASS, persist, patch);
  await until('毛玻璃卡的成本记录', () => page.evaluate(async (id) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const key = clipIdentityOf(getState().project).identityKeys[id];
    return pd.currentCosts().some((r) => r.identityKey === key && typeof r.stepMs === 'number');
  }, GLASS), 180000, 500, true);
  out.costRecord = await pinHeavy(true);
  const prerender = await (await fetch(origin + '/api/prerender/info')).json();
  const segCount = Math.ceil((LAST - FIRST + 1) / SEG);
  const layersNow = () => page.evaluate(async (id) => {
    const m = await import('/src/editor/snapshotFeed.ts');
    const byKind = m.currentReadyIndex().get(id);
    return byKind ? Object.fromEntries([...byKind].map(([k, v]) => [k, { key: v.key, ranges: v.ranges, originFrame: v.originFrame ?? null, streamKind: v.streamKind ?? null, inputSig: v.inputSig ?? null }])) : null;
  }, GLASS);
  const poke = async () => {
    const k = await page.evaluate(async () => (await import('/src/render/dataMirror.ts')).mirrorKey());
    if (!k) return null;
    // 每一轮都重钉、重存一次:页面测完第二趟会把这条成本记录整条重写,钉重卡那一位会被冲掉,预渲染进程就不产它了
    await pinHeavy(true);
    await fetch(prerender.url + '/api/frames/preload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: k.session, localRev: k.localRev, lane: 'background' }) }).catch(() => {});
    return k;
  };
  /** 等这张卡的流全部分段满密度;`notKey` 给了就要等到换成别的键 */
  const waitStream = (label, notKey = null) => until(label, async () => {
    if (!(await poke())) return null;
    const layers = await layersNow();
    if (!layers?.stream || layers.stream.key === notKey || !(layers.stream.ranges ?? []).some((r) => r[0] <= 0 && r[1] >= segCount - 1)) return null;
    const manifest = await fetch(`${prerender.url}/api/frames/stream/${encodeURIComponent(layers.stream.key)}/manifest`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null), () => null);
    if (!manifest) return null;
    for (let n = 0; n < segCount; n++) if ((manifest.segments?.[n]?.stride ?? 0) !== 1) return null;
    return { layers, manifest };
  }, 900000, 2000);
  if (SETTLE_CONTROL) {
    // 对照:没有这种流。钉成重卡以后点到同样几帧,等它停下追到精确活渲(不抑制、不在追帧、没有快照、没有等快照),截图
    const emptyUrl0 = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
    bakery = await openBakery({ url: emptyUrl0 });
    await bakery.reset(project, emptyUrl0);
    bakery.streamLease = null;
    const frames = new Map();
    await fs.mkdir(path.join(OUT, 'ref-control'), { recursive: true });
    await bakeFrames(bakery, { out: path.join(OUT, 'ref-control'), fps: FPS, frames: `0-${LAST + 2}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
      onFrame: async (i, buf) => { frames.set(i, PNG.sync.read(Buffer.from(buf))); } });
    const bestOf = (shot, f) => {
      const scores = [f - 2, f - 1, f, f + 1, f + 2].filter((c) => frames.has(c)).map((c) => [c, round2(rectMean(shot, resized(frames.get(c), shot.width, shot.height), GLASS_REGION))]);
      return [...scores].sort((x, y) => x[1] - y[1])[0]?.[0] ?? null;
    };
    await store(`actions.pause(); actions.seek(args[0]);`, (FIRST + 5) / FPS);
    await until('对照:父页的分派表里毛玻璃卡判重', async () => { await pinHeavy(); const p = await parentDiag(); return p?.heavy.includes(GLASS) ? true : null; }, 30000, 200);
    const rows = [];
    for (const f of CLICKS) {
      const ref = liveRef.get(f);
      await store(`actions.pause(); actions.seek(args[0]);`, (f > 40 ? f - 30 : f + 30) / FPS);
      await sleep(400);
      await store(`actions.pause(); actions.seek(args[0]);`, f / FPS);
      let last = null, kept = null;
      await until(`对照:第 ${f} 帧停下以后稳定下来`, async () => {
        const fr = await frontFrame();
        const ok = await fr?.evaluate((id, sec) => {
          const d = window.__pcStageDiag();
          const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
          return !!wrap && Math.abs(d.t - sec) < 1 / 60 && !d.suppressed.includes(id) && !d.settling.includes(id) && !d.awaiting.includes(id) && !d.snapshots.includes(id)
            && d.streams.tracks.length === 0 && !/\bpc-(suppressed|settling|awaiting|snapshot)\b/.test(wrap.className);
        }, GLASS, f / FPS).catch(() => false);
        if (!ok || (await parentDiag())?.swapInFlight) { last = null; return null; }
        const shot = await shootStage();
        if (!shot) return null;
        const stable = !!last && rectMean(last, shot, WHOLE) < 0.05;
        last = shot;
        if (stable) { kept = shot; return true; }
        return null;
      }, 15000, 200, true);
      rows.push({ frame: f, 重卡停下以后对轻卡时的活渲: ref && kept ? round2(rectMean(kept, ref.shot, GLASS_REGION)) : null, 轻卡时最像导出页的: ref ? bestOf(ref.shot, f) : null, 重卡停下以后最像导出页的: kept ? bestOf(kept, f) : null });
    }
    out.settleControl = rows;
    say('settle-control', { rows, setTimeLog: (await parentDiag())?.setTimeLog.slice(-4) });
    throw Object.assign(new Error('settle-control-done'), { done: true });
  }
  const startedPrerender = Date.now();
  const ready = await waitStream('毛玻璃卡的依赖下层的流全部分段满密度');
  if (!ready) throw new Error('依赖下层的流没产出来');
  out.produceMs = Date.now() - startedPrerender;
  const key0 = ready.layers.stream.key;
  out.ready = { stream: { ...ready.layers.stream, key: key0.slice(0, 12) }, manifest: { kind: ready.manifest.kind, plane: ready.manifest.plane, bound: ready.manifest.bound, tight: ready.manifest.tight },
    hasSnapshotLayer: !!(ready.layers.html || ready.layers.local) };
  say('stream-ready', { ms: out.produceMs, ...out.ready });
  check(ready.manifest.kind === 'below' && ready.manifest.plane === 'stage', '预渲染进程产的是依赖下层的流(清单:kind below、plane stage)', out.ready.manifest);
  check(ready.layers.stream.originFrame === FIRST, `这条流的第一帧是第 ${FIRST} 帧(不是 15 的倍数)`, ready.layers.stream);
  check(ready.layers.stream.streamKind === 'below' && /^s1-/.test(ready.layers.stream.inputSig ?? ''), '就绪索引里那一层带着种类和输入签名', out.ready.stream);
  await pinHeavy();
  await store(`actions.pause(); actions.seek(args[0]);`, (FIRST + 5) / FPS);
  await sleep(500);
  {
    const p = await parentDiag();
    const pageSig = await page.evaluate(async (id) => {
      const { getState } = await import('/src/store/project.ts');
      const { streamInputSig } = await import('/src/render/streamInputSig.mjs');
      return streamInputSig(getState().project, { clipIds: [id], kind: 'below' });
    }, GLASS);
    out.signature = { layer: ready.layers.stream.inputSig, page: pageSig, staleBelow: p?.staleBelow ?? null };
    check(pageSig === ready.layers.stream.inputSig && (p?.staleBelow ?? []).length === 0, '预渲染进程带来的签名和页面按 store 里的项目算的是同一个(父页没有把它判成过期)', out.signature);
    check(!!p?.heavy.includes(GLASS) && !p.heavy.includes(MOVER), '父页的分派表里毛玻璃卡判重、下面那张卡是轻卡(活渲)', p?.heavy);
  }

  /* ---------------------------------------------------------------- 参照:导出页逐帧 */
  const emptyUrl = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
  bakery = await openBakery({ url: emptyUrl });
  const exportAll = async (proj, tag) => {
    await bakery.reset(proj, emptyUrl);
    bakery.streamLease = null;
    const frames = new Map();
    const dir = path.join(OUT, `ref-${tag}`);
    await fs.mkdir(dir, { recursive: true });
    await bakeFrames(bakery, { out: dir, fps: FPS, frames: `0-${LAST + 2}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
      onFrame: async (i, buf) => { frames.set(i, PNG.sync.read(Buffer.from(buf))); } });
    return frames;
  };
  const exported = await exportAll(project, 'project');
  say('exported', { frames: exported.size });

  /* ---------------------------------------------------------------- 舞台侧的观察 */
  /** 毛玻璃卡改动过的那一块(流的收紧矩形,按比例);只在这一块里比 */
  const tightOf = (manifest) => { const t = manifest.tight ?? manifest.bound; return { x: t.x / WIDTH, y: t.y / HEIGHT, w: t.w / WIDTH, h: t.h / HEIGHT }; };
  let region = tightOf(ready.manifest);
  const refCache = new Map();
  /** 截预览里那块可见舞台,和导出页的几帧比(导出帧缩放到截图的大小,只比毛玻璃卡那一块):回最像的那一帧 */
  const scoreShot = (shot, candidates, from = exported, tag = 'p') => {
    const scores = [...new Set(candidates)].filter((c) => from.has(c)).map((c) => {
      const key = `${tag}|${c}|${shot.width}x${shot.height}`;
      if (!refCache.has(key)) { refCache.set(key, resized(from.get(c), shot.width, shot.height)); if (refCache.size > 60) refCache.delete(refCache.keys().next().value); }
      return [c, round2(rectMean(shot, refCache.get(key), region))];
    });
    const sorted = [...scores].sort((x, y) => x[1] - y[1]);
    return { best: sorted[0]?.[0] ?? null, mean: sorted[0]?.[1] ?? null, runnerUp: sorted[1]?.[1] ?? null, scores, size: [shot.width, shot.height], shot };
  };
  const shootAndScore = async (candidates, saveAs = null, from = exported, tag = 'p') => {
    const shot = await shootStage(saveAs);
    return shot ? scoreShot(shot, candidates, from, tag) : { error: '找不到可见舞台' };
  };
  // 参照的那几张(不贴流的活渲)各最像导出页的哪一帧:只记录
  for (const ref of liveRef.values()) ref.best = scoreShot(ref.shot, [ref.frame - 2, ref.frame - 1, ref.frame, ref.frame + 1, ref.frame + 2]).best;
  /** 可见舞台里毛玻璃卡此刻的样子 */
  const cardState = async () => {
    const f = await frontFrame();
    if (!f) return null;
    return f.evaluate((id) => {
      const d = window.__pcStageDiag();
      const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
      const track = d.streams.tracks.find((t) => t.id.split('#')[0] === id) ?? null;
      const plane = document.querySelector(`canvas[data-pc-group-plane][data-pc-stream-group="${id}"]`);
      const live = wrap ? [...wrap.children].filter((el) => !el.hasAttribute('data-pc-stream-plane') && !el.hasAttribute('data-pc-snapshot-plane')
        && !el.hasAttribute('data-pc-placeholder-slot') && !el.hasAttribute('data-pc-proxy-plane')) : [];
      const hiddenEl = (el) => { const cs = getComputedStyle(el); return cs.display === 'none' || cs.visibility === 'hidden'; };
      const slot = wrap?.querySelector(':scope > [data-pc-placeholder-slot]') ?? null;
      return {
        t: d.t, role: d.role, cls: wrap?.className ?? null, mounted: !!wrap,
        suppressed: d.suppressed.includes(id), named: d.parentSuppressed.includes(id), waiting: d.streamWaiting.includes(id), settling: d.settling.includes(id), awaiting: d.awaiting.includes(id),
        snapshot: d.snapshots.includes(id) || !!wrap?.querySelector(':scope > [data-pc-snapshot-plane]'),
        planes: d.streamPlanes.map((p) => ({ clip: p.clipIds.join(','), plane: p.plane, key: (p.key ?? '').slice(0, 12) })),
        track: track && { key: (track.key ?? '').slice(0, 12), lastDrawn: track.lastDrawn, picture: track.picture, stale: track.stale, level: track.level, plane: track.plane, kind: track.kind, fits: track.fits, errors: track.errors, lastError: track.lastError },
        canvasInWrapper: !!wrap?.querySelector(':scope > canvas[data-pc-stream-plane]'),
        planeShown: !!plane && getComputedStyle(plane).display !== 'none', liveCount: live.length, liveHidden: live.length > 0 && live.every(hiddenEl),
        placeholder: d.placeholders.includes(id) || (!!slot && !slot.hidden),
      };
    }, GLASS).catch((e) => ({ error: String(e).slice(0, 200) }));
  };
  /** 逐帧采样器(两个舞台都装;只记可见的那一台):毛玻璃卡有没有「活子树藏着、流又没有画面」的时刻、活画面和流叠着的时刻、占位符、快照 */
  const installSampler = async () => {
    for (const f of stageFrames()) {
      await f.evaluate((id) => {
        const now = () => (window.__pcRealNow ?? (() => Date.now()))();
        const raf = window.__pcRealRaf ?? window.requestAnimationFrame.bind(window);
        const st = window.__probeSampler = { on: true, samples: 0, empty: 0, emptyRuns: [], both: 0, placeholder: 0, snapshot: 0, keys: [], log: [] };
        let eStart = null, lastKey = '';
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
              const plane = document.querySelector(`canvas[data-pc-group-plane][data-pc-stream-group="${id}"]`);
              const streamOn = !!track && track.lastDrawn !== null && !!plane && getComputedStyle(plane).display !== 'none';
              const hidden = /\bpc-(suppressed|settling|awaiting|snapshot)\b/.test(wrap.className);
              const snap = d.snapshots.includes(id);
              const slot = wrap.querySelector(':scope > [data-pc-placeholder-slot]');
              const ph = d.placeholders.includes(id) || (!!slot && !slot.hidden);
              const empty = hidden && !streamOn && !snap;
              if (empty) { st.empty++; if (eStart === null) eStart = at; } else if (eStart !== null) { st.emptyRuns.push(Math.round(at - eStart)); eStart = null; }
              if (!hidden && streamOn) st.both++;
              if (ph) st.placeholder++;
              if (snap) st.snapshot++;
              const shownKey = streamOn ? (track.key ?? '').slice(0, 12) : '-';
              if (st.keys[st.keys.length - 1] !== shownKey) st.keys.push(shownKey);
              const key = `f${Math.round(d.t * 30)}|${track ? track.lastDrawn : '-'}|${hidden ? 'hid' : 'live'}|${streamOn ? 'stream' : '-'}|${d.settling.includes(id) ? 'settling' : '-'}|${snap ? 'snap' : '-'}|${ph ? 'ph' : '-'}`;
              if (key !== lastKey && st.log.length < 300) { lastKey = key; st.log.push(`${Math.round(at - began)}ms ${key}`); }
            }
            st.flush = () => { if (eStart !== null) { st.emptyRuns.push(Math.round(now() - eStart)); eStart = null; } };
          }
          raf(tick);
        };
        raf(tick);
      }, GLASS).catch(() => {});
    }
  };
  const collectSampler = async () => {
    const total = { samples: 0, empty: 0, emptyRuns: [], both: 0, placeholder: 0, snapshot: 0, keys: [], log: [] };
    for (const f of stageFrames()) {
      const s = await f.evaluate(() => {
        const st = window.__probeSampler;
        if (!st) return null;
        st.flush?.();
        st.on = false;
        return { samples: st.samples, empty: st.empty, emptyRuns: st.emptyRuns, both: st.both, placeholder: st.placeholder, snapshot: st.snapshot, keys: st.keys, log: st.log };
      }).catch(() => null);
      if (!s) continue;
      for (const k of ['samples', 'empty', 'both', 'placeholder', 'snapshot']) total[k] += s[k];
      total.emptyRuns.push(...s.emptyRuns); total.keys.push(...s.keys); total.log.push(...s.log);
    }
    return total;
  };
  const checkSampler = (label, s) => {
    check(s.samples > 0, `${label}:采到了样`, s.samples);
    check(s.empty === 0, `${label}:毛玻璃卡没有「活子树藏着、流又没有画面」的时刻`, { empty: s.empty, runs: s.emptyRuns, log: s.log.slice(0, 40) });
    check(s.placeholder === 0, `${label}:占位符没有显示出来`, { placeholder: s.placeholder, log: s.log.slice(0, 40) });
    check(s.snapshot === 0, `${label}:一张快照都没有挂(有流不读快照)`, { snapshot: s.snapshot, log: s.log.slice(0, 40) });
    check(s.both === 0, `${label}:活画面和流没有叠在一起的时刻`, { both: s.both, log: s.log.slice(0, 40) });
  };
  /** 停下以后:回到精确活渲 —— 不抑制、活子树露着、没有快照、没有占位符;流平面藏着、这一帧已经解好;父页照发着流平面 */
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
    const warm = await until(`${label}:停下以后流平面藏着、这一帧已经解好`, async () => {
      const s = await cardState();
      return s && s.track && s.track.lastDrawn === frame && !s.planeShown && s.planes.length === 1 ? s : null;
    }, 8000, 40);
    const p = await parentDiag();
    check(!!warm, `${label}:停下以后流平面藏着、播放头下这一帧已经解好`, await cardState());
    check(p.streams.length === 1 && p.streams[0].plane === 'stage' && p.scrub.length === 0 && p.picks.length === 0 && p.mounted.length === 0, `${label}:停下以后父页照发流平面(舞台坐标)、不抑制、不选快照`, p);
    return { ok: true, ms: Date.now() - began };
  };

  check(CLICKS.filter((f) => liveRef.has(f)).length >= 3, '活渲的参照:流产出来之前至少截到了三处', [...liveRef.keys()]);
  if ([...liveRef.values()].some((r) => r.best !== r.frame)) notes.push(`里程表不贴流时预览的活渲就和导出页对不齐(与流无关;帧号 → 最像导出页的帧):${JSON.stringify([...liveRef.values()].map((r) => [r.frame, r.best]))}`);

  /* ---------------------------------------------------------------- 1. 点时间轴跳过去 */
  await store(`actions.pause(); actions.seek(args[0]);`, (FIRST + 5) / FPS);
  await waitSettled('起步', FIRST + 5);
  out.click = [];
  for (const f of CLICKS) {
    await installSampler();
    await store(`actions.pause(); actions.seek(args[0]);`, f / FPS);
    const settled = await waitSettled(`点到第 ${f} 帧`, f);
    const sampler = await collectSampler();
    checkSampler(`点到第 ${f} 帧`, sampler);
    const score = await shootAndScore([f - 2, f - 1, f, f + 1, f + 2], f === CLICKS[0] ? `click-${f}-settled.png` : null);
    const ref = liveRef.get(f);
    const vsLive = ref ? round2(rectMean(score.shot, ref.shot, region)) : null;
    // 只记录:重卡停下追到活渲走的是另一条路(子树虚拟时间追帧),入场动画没放完的帧上它和轻卡时的活渲会差一帧 ——
    // 不产这种流的对照档(`--settle-control`)里同样如此,不是贴流带来的。差得多的记进 notes
    if (ref && !(vsLive < 1)) notes.push(`点到第 ${f} 帧:贴流再停下以后的活渲和轻卡时的活渲不是同一张(平均差 ${vsLive};最像导出页的帧 ${score.best} 对 ${ref.best})。对照档 --settle-control(不产这种流)里重卡停下以后同样如此`);
    out.click.push({ 对不贴流的活渲: vsLive, 不贴流最像导出页的: ref?.best ?? null, frame: f, settledMs: settled.ms, best: score.best, mean: score.mean, runnerUp: score.runnerUp, log: sampler.log.slice(0, 10) });
  }
  say('1-click', { clicks: out.click.map((c) => ({ frame: c.frame, settledMs: c.settledMs, best: c.best, mean: c.mean, runnerUp: c.runnerUp })) });

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
  /** 拖到这一帧以后:流画出这一帧;核这张卡在舞台上、父页那一侧的样子;截图和导出页比 */
  const checkDragStep = async (label, target, { from = exported, tag = 'p', key = null, saveAs = null } = {}) => {
    const state = await until(`${label}:流画出这一帧`, async () => {
      const s = await cardState();
      return s && !s.error && s.track && s.track.lastDrawn === target && !s.track.stale && Math.abs(s.t - target / FPS) < 1e-6 && (!key || s.track.key === key.slice(0, 12)) ? s : null;
    }, 15000, 15);
    const s = state ?? await cardState();
    const p = await parentDiag();
    if (s && !s.error) {
      check(s.suppressed && /\bpc-suppressed\b/.test(s.cls ?? '') && s.liveHidden, `${label}:毛玻璃卡被抑制、活子树藏着`, s);
      check(s.planeShown && !s.canvasInWrapper && s.track?.level === 'dense' && s.track?.kind === 'below' && s.track?.plane === 'stage' && s.track?.fits === true, `${label}:舞台根下的流平面露着,贴的是满密度的这一帧`, s);
      check(!s.placeholder && !s.snapshot && !s.awaiting, `${label}:没有占位符、没有快照、不等快照`, s);
      check((s.track?.errors ?? 0) === 0, `${label}:解码没有报错`, s.track);
    }
    check(p.suppressed.includes(GLASS) && !p.suppressed.includes(MOVER) && p.streams.length === 1 && p.streams[0].plane === 'stage' && p.picks.length === 0 && p.mounted.length === 0 && p.staleBelow.length === 0,
      `${label}:父页只抑制毛玻璃卡、发它的流平面(舞台坐标)、不选快照`, p);
    const score = await shootAndScore([target - 1, target, target + 1], saveAs, from, tag);
    check(score.best === target, `${label}:截图和导出页的第 ${target} 帧最像(比前一帧、后一帧都像)`, { best: score.best, scores: score.scores });
    return { state: s, parent: p, score };
  };
  {
    await waitSettled('拖动之前', 60);
    await installSampler();
    await page.keyboard.down('Alt');   // 不吸附到整秒 / 片段边界,落在哪一帧由坐标定
    const steps = [];
    for (let i = 0; i < STEPS.length; i++) {
      const target = STEPS[i];
      const landed = await moveToFrame(target, { down: i === 0 });
      const step = { i, target, landed, sample: (target - FIRST) % SEG };
      steps.push(step);
      if (!check(landed === target, `拖动第 ${i} 步落在第 ${target} 帧`, { landed })) continue;
      const r = await checkDragStep(`拖动第 ${i} 步(第 ${target} 帧)`, target, { saveAs: [33, 70].includes(target) ? `drag-${target}-stream.png` : null });
      step.best = r.score.best; step.mean = r.score.mean; step.runnerUp = r.score.runnerUp;
      check(r.parent.setTimeLog.at(-1)?.settle === false, `拖动第 ${i} 步:这一次 setTime 不带「停下」`, r.parent.setTimeLog.at(-1));
    }
    await page.mouse.up();
    await page.keyboard.up('Alt');
    const released = STEPS.at(-1);
    const settled = await waitSettled('松手', released);
    const sampler = await collectSampler();
    checkSampler('拖动全程', sampler);
    out.drag = { steps, releasedAt: released, settleMs: settled.ms, empty: sampler.empty, placeholder: sampler.placeholder, snapshot: sampler.snapshot };
    say('2-drag', { steps: steps.map((s) => [s.target, s.best, s.mean, s.runnerUp]), settleMs: settled.ms });
  }

  /* ---------------------------------------------------------------- 3. 暂停着起播、播放中暂停 */
  out.play = [];
  for (const [round, [from, playMs]] of [[20, 900], [45, 600]].entries()) {
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
    const beats = traces.map((b) => ({ frame: Math.round(b.sec * FPS), level: b.levels[GLASS] ?? null, snapshots: b.snapshots }));
    const stopped = frameOf(await storeT());
    const settled = await waitSettled(`第 ${round} 轮播放中暂停`, stopped);
    const sampler = await collectSampler();
    checkSampler(`第 ${round} 轮起播到暂停全程`, sampler);
    const inRange = beats.filter((b) => b.frame >= FIRST && b.frame <= LAST);
    const notDense = inRange.filter((b) => b.level !== 'dense');
    check(inRange.length >= 8, `第 ${round} 轮:播了一段`, beats.length);
    check(beats[0]?.frame === from + 1 && beats[0]?.level === 'dense', `第 ${round} 轮起播:头一拍毛玻璃卡就是流的画面(暂停着已经把这一帧解好)`, beats.slice(0, 3));
    check(notDense.length === 0, `第 ${round} 轮播放:每一拍都是满密度流的画面(没有空拍、没有占位符、没有快照)`, notDense.slice(0, 5));
    check(beats.every((b) => b.snapshots === 0), `第 ${round} 轮播放:舞台上一张快照都没有`, beats.filter((b) => b.snapshots).slice(0, 3));
    const score = await shootAndScore([stopped - 2, stopped - 1, stopped, stopped + 1, stopped + 2], round === 0 ? `pause-${stopped}-settled.png` : null);
    const entry = { from, stoppedAt: stopped, beats: beats.length, firstBeat: beats[0] ?? null, notDense: notDense.length, settleMs: settled.ms, best: score.best, mean: score.mean };
    out.play.push(entry);
    say('3-play', entry);
  }

  /* ---------------------------------------------------------------- 4. 下层改一处:旧流不贴、重产、再贴 */
  {
    await store(`actions.pause(); actions.seek(args[0]);`, 60 / FPS);
    await waitSettled('改下层之前', 60);
    await page.keyboard.down('Alt');
    const landed = await moveToFrame(EDIT_AT, { down: true });
    check(landed === EDIT_AT, `按着标尺停在第 ${EDIT_AT} 帧`, { landed });
    const before = await checkDragStep('改下层之前(贴着旧流)', EDIT_AT, { key: key0 });
    await installSampler();
    // 把下面那张卡的一个参数改掉(亮带的颜色)。store 换成新的项目对象,父页按它算的签名和旧流带的对不上
    const editedAt = Date.now();
    await store(`actions.setClipParams(args[0], { accent: '#ff4d6d' });`, MOVER);
    const dropped = await until('下层改了以后父页不再发旧流的流平面', async () => {
      const p = await parentDiag();
      const s = await cardState();
      return p && p.staleBelow.includes(GLASS) && p.streams.length === 0 && s && !s.error && !s.track && s.planes.length === 0 ? { p, s, ms: Date.now() - editedAt } : null;
    }, 5000, 10);
    const edit = { frame: EDIT_AT, oldKey: key0.slice(0, 12), droppedMs: dropped?.ms ?? null, afterDrop: dropped ? { staleBelow: dropped.p.staleBelow, streams: dropped.p.streams.length, suppressed: dropped.p.suppressed, picks: dropped.p.picks, stageSuppressed: dropped.s.suppressed, placeholder: dropped.s.placeholder } : null };
    check(!!dropped, '下层改了一处:父页当场认出旧流过期(签名对不上),不再发它的流平面,舞台上旧流的轨道关掉', { parent: await parentDiag(), card: await cardState() });
    // 这一帧没有流了:暂停 / 拖动时照没有流的重卡办(现状:不抑制,落到快照,再没有就露出活组件)
    if (dropped) check(!dropped.p.suppressed.includes(GLASS) && !dropped.p.scrub.includes(GLASS), '旧流过期以后这张卡当作没有流:不再因为贴流而抑制', dropped.p);
    // 重产:预渲染进程按新项目换版本,新键到货
    const t0 = Date.now();
    const again = await waitStream('下层改了以后新流全部分段满密度', key0);
    if (!again) throw new Error('改了下层以后新流没产出来');
    edit.reproduceMs = Date.now() - t0;
    const key1 = again.layers.stream.key;
    edit.newKey = key1.slice(0, 12);
    edit.newLayer = { streamKind: again.layers.stream.streamKind, inputSig: again.layers.stream.inputSig, oldSig: ready.layers.stream.inputSig };
    check(key1 !== key0 && again.layers.stream.inputSig !== ready.layers.stream.inputSig && again.layers.stream.streamKind === 'below', '重产出来的是新键、新签名', edit);
    region = tightOf(again.manifest);
    const edited = await storeProject();
    const exported1 = await exportAll(edited, 'edited');
    // 手还按着:父页收到新的一层以后自己重新发流平面,舞台贴上新流
    const after = await checkDragStep('重产以后(贴着新流)', EDIT_AT, { from: exported1, tag: 'e', key: key1, saveAs: `edit-${EDIT_AT}-new-stream.png` });
    const vsOld = round2(rectMean(after.score.shot, resized(exported.get(EDIT_AT), after.score.size[0], after.score.size[1]), region));
    edit.afterMean = after.score.mean; edit.afterRunnerUp = after.score.runnerUp; edit.对改之前的导出页同一帧 = vsOld; edit.beforeMean = before.score.mean;
    check(vsOld > after.score.mean * 1.3 + 0.3, '对照:贴着新流的画面拿改之前的导出页比明显更差(这套比法分得出下层变没变)', edit);
    // 再拖两处,都是新流
    for (const f of [EDIT_AT + 19, EDIT_AT - 13]) {
      const got = await moveToFrame(f);
      if (check(got === f, `重产以后拖到第 ${f} 帧`, { got })) await checkDragStep(`重产以后拖到第 ${f} 帧`, f, { from: exported1, tag: 'e', key: key1 });
    }
    await page.mouse.up();
    await page.keyboard.up('Alt');
    const sampler = await collectSampler();
    // 采样里流平面上先后露过的键:旧键没有了以后再也没有回来
    const order = sampler.keys.filter((k, i, a) => i === 0 || a[i - 1] !== k);
    edit.shownKeys = order;
    const firstGone = order.findIndex((k) => k !== key0.slice(0, 12));
    check(order.includes(key1.slice(0, 12)) && (firstGone < 0 || !order.slice(firstGone).includes(key0.slice(0, 12))), '旧流撤下以后再也没有被贴回去;后来贴的是新流', order);
    out.edit = edit;
    say('4-edit', edit);
    await waitSettled('改完松手', EDIT_AT - 13);
  }

  out.pageErrors = pageErrors.slice(0, 5);
  check(pageErrors.length === 0, '页面没有未捕获的错误', pageErrors.slice(0, 3));
} catch (error) {
  if (!error?.done) {
    fails.push(`异常:${error?.stack || error}`);
    say('ERROR', { error: String(error?.stack || error) });
  }
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
