/*
 * R9「canvas 卡的共享 WebGL 渲染器」的舞台侧验收探针。
 *
 *   node scripts/probes/gl-stage-probe.mjs --origin http://127.0.0.1:5240 [--out out/gl-stage] [--only 直连,编辑台]
 *
 * 两段:
 *
 * **直连**(不经编辑台,顶层直接开一个舞台页 `http://<舞台端口>/?stage=1&id=A&preview=stage`,经 `window.__pcStage` 驱动):
 *   - 路线 1 的上下文数:舞台主线程 0 个活的 WebGL 上下文,它的 Worker 里恰好 1 个;
 *   - 20 张不同参数的 `scene-3d` 同时活跃,不触发 `webglcontextlost`,20 个平面都贴上了位图;
 *   - 3 张卡引用同一张贴图:Worker 里 `THREE.Texture` 一个、上传一次;
 *   - 节拍:暂停时点一次时间轴只发一拍;K3(a) 的同步 `advanceTo`(往前 < 0.5 秒)只在结束后发一拍;
 *   - 快照:`back` 角色下生成快照,three 卡是非空 `<img>`、`lossy = 0`;把 `data-pc-gl-frame` 人为改掉 → `lossy` 计到它;
 *   - 能力退路:`?glOffscreen=0` 时 canvas 卡在主线程画(主线程 1 个上下文、没有 Worker),画面和 Worker 那条路逐像素比。
 *
 * **编辑台**(`/?editor&headless=1&preview=stage`,两个跨源舞台):
 *   - 路线 2(`project.glRoute = 'shared'`):两个舞台文档都走父页交来的端口、主线程 0 个上下文,父页的共享 Worker 里 1 个;
 *     对 `B` 发 `setRole('back')` 后共享 Worker 里 `B` 那份图集被释放、`A` 的不动,`stageId` 不变;
 *   - 播放:`frame` 的 `sec` 差恒为 1/fps;Worker 故意睡 100 ms 时舞台等它、不跳帧,主文档判卡顿(音频暂停);
 *   - 追帧(K5 第一路):判重、`vtOk` 的 `scene-3d`,`setTime(t, { settle: true })` 之后追上那一拍——
 *     `.pc-settling` 摘掉的那一刻平面上已经是目标帧的位图(`data-pc-gl-frame` = 包裹层的本地帧号),追帧中间步不发 `beat`。
 *
 * 图存在 `--out`(缺省 out/gl-stage/):worker.png / main.png(退路)/ twenty.png / editor-front.png。
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { PNG } from 'pngjs';
import { flagArg, devOrigin } from './probe-connect.mjs';

const origin = devOrigin();
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const out = path.resolve(flagArg('out', path.join(ROOT, 'out', 'gl-stage')));
const only = (flagArg('only', '') || '').split(',').filter(Boolean);
const wants = (n) => !only.length || only.includes(n);
fs.mkdirSync(out, { recursive: true });

const fails = [];
const result = { origin, cases: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); console.log(`${cond ? 'PASS' : 'FAIL'} ${label}`); return cond; };

/** 每个文档里数 WebGL 上下文:包一层 getContext,活的 = 没 lost 的 */
function COUNT_GL() {
  const list = [];
  const wrap = (proto) => {
    if (!proto || proto.__pcGlWrapped) return;
    const orig = proto.getContext;
    proto.getContext = function (type, ...rest) {
      const c = orig.call(this, type, ...rest);
      if (c && /webgl/i.test(String(type)) && !list.includes(c)) list.push(c);
      return c;
    };
    proto.__pcGlWrapped = true;
  };
  wrap(HTMLCanvasElement.prototype);
  if (typeof OffscreenCanvas !== 'undefined') wrap(OffscreenCanvas.prototype);
  window.__pcGlCtxAlive = () => list.filter((c) => !c.isContextLost()).length;
  window.__pcGlCtxCreated = () => list.length;
}

const { ports } = await (await fetch(origin + '/api/stage/ports')).json();
const u = new URL(origin);
const stageOrigin = `${u.protocol}//${u.hostname}:${ports[0]}`;

const card = (id, over = {}, frame) => ({ id, cardId: 'scene-3d', start: 0, end: 4, params: {
  shape: 'knot', color: '#8ab4ff', metal: 0.6, rough: 0.25, size: 0.55, spinY: 0.15, spinX: 0, tilt: -18, light: 'studio', fov: 0, wire: 'no', texture: '', ...over }, ...(frame ? { frame } : {}) });
const projectOf = (clips, extra = {}) => ({ version: 1, id: 'gl-stage', name: 'gl-stage', width: 960, height: 540, fps: 30, duration: 4, themeId: 'default', media: [],
  tracks: clips.map((c, i) => ({ id: `t${i}`, clips: [c] })), ...extra });
const SHAPES = ['knot', 'cube', 'sphere', 'torus', 'cone', 'cylinder', 'crystal'];
const grid = (n, cols, over = () => ({})) => Array.from({ length: n }, (_, i) => {
  const w = 960 / cols, rows = Math.ceil(n / cols), h = 540 / rows;
  return card(`c${i}`, { shape: SHAPES[i % SHAPES.length], color: `#${(((i * 2654435761) >>> 8) & 0xffffff | 0x404040).toString(16).padStart(6, "0")}`, spinY: 0.1 + i * 0.03, ...over(i) },
    { x: (i % cols) * w, y: Math.floor(i / cols) * h, w, h });
});

const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 240000,
  args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
    '--disable-gpu-vsync', '--disable-frame-rate-limit'],
});


/**
 * 自己写 scene-3d 的成本记录(同 playback-probe 的做法):`heavy` = 判重、`vtOk`(K5 第一路追帧);否则判轻(播放中活渲)。
 * 记录落在 dev server 的 out/card-costs.json 里、下一轮还在,所以每段开头都要按自己要的轻重重写一遍。
 */
const SET_COSTS = async ({ heavy }) => {
  const { getState } = await import('/src/store/project.ts');
  const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
  const { setPlanCosts } = await import('/src/editor/planDispatch.ts');
  const project = getState().project;
  const { identityKeys } = clipIdentityOf(project);
  const existing = (await (await fetch('/api/data/costs')).json())?.costs ?? [];
  // 沿用 K1 常驻探针给**这几张卡**写下的那个 device(同一 device 才是覆盖;换一个只会多一条、真实测的那条还在)
  const mine = new Set(Object.values(identityKeys));
  const device = existing.find((r) => mine.has(r.identityKey))?.device ?? existing[0]?.device ?? 'gl-stage-probe';
  const seen = new Set();
  const records = [];
  for (const tr of project.tracks) for (const clip of tr.clips) {
    const key = identityKeys[clip.id];
    if (clip.cardId !== 'scene-3d' || !key || seen.has(key)) continue;
    seen.add(key);
    records.push({ identityKey: key, device, mode: 'dev', fps: project.fps, stepMs: 1, stepMaxMs: 1, inlineMs: 1, rasterMs: 1, serializeMs: 1,
      catchUpMs: heavy ? 10 : 0, kind: heavy ? 'stepped' : 'random', vtOk: true, seekOk: !heavy, seekMs: heavy ? null : 1, capped: heavy, demoted: false, measuredAt: Date.now() });
  }
  const put = await (await fetch('/api/data/costs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records }) })).json();
  const after = await (await fetch('/api/data/costs')).json();
  const tuning = after?.tuning ?? null;
  // 整份 costs 一起给(只给这几条的话,常驻探针下一轮 GET 回来的那份会把它盖掉)
  setPlanCosts(after?.costs ?? records, tuning);
  await new Promise((r) => setTimeout(r, 100));
  const stored = (after?.costs ?? []).filter((r) => mine.has(r.identityKey)).map((r) => ({ key: r.identityKey, device: r.device === device, capped: r.capped, kind: r.kind }));
  return { n: records.length, put, stored };
};

/** 等这个舞台把 gl 平面都贴上位图(每个平面都有 data-pc-gl-frame 且等于包裹层的本地帧号) */
const WAIT_PAINTED = async (n) => {
  // 舞台页的 setTimeout / performance.now 是虚拟时钟(暂停时不走),轮询一律用真的那份
  const now = window.__pcRealNow ?? (() => performance.now());
  const later = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
  const t0 = now();
  for (;;) {
    const planes = [...document.querySelectorAll('[data-pc-gl-plane]')];
    const ok = planes.length >= n && planes.every((p) => p.getAttribute('data-pc-gl-frame') !== null
      && p.getAttribute('data-pc-gl-frame') === p.closest('[data-pc-local-frame]')?.getAttribute('data-pc-local-frame'));
    if (ok) return { planes: planes.length, ms: now() - t0 };
    if (now() - t0 > 60000) return { planes: planes.length, timeout: true, frames: planes.map((p) => p.getAttribute('data-pc-gl-frame')) };
    await later(30);
  }
};

async function openStage(query = '') {
  const page = await browser.newPage();
  await page.setViewport({ width: 960, height: 540 });
  await page.evaluateOnNewDocument(COUNT_GL);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${stageOrigin}/?stage=1&id=A&preview=stage${query}`, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(() => !!window.__pcStage, { timeout: 180000 });
  return { page, errors };
}

const shot = async (page, file) => {
  const buf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 960, height: 540 }, omitBackground: true });
  fs.writeFileSync(path.join(out, file), buf);
  return PNG.sync.read(buf);
};

try {
  /* ============================================================ 直连 */
  if (wants('直连')) {
    /* ---- 路线 1:上下文数 + 3 张卡同一张贴图 ---- */
    const texUrl = '/@media/gl-migrate-texture.png';
    {
      const { page, errors } = await openStage();
      const project = projectOf([
        card('k1', { texture: texUrl, shape: 'sphere' }, { x: 0, y: 0, w: 320, h: 270 }),
        card('k2', { texture: texUrl, shape: 'cube' }, { x: 320, y: 0, w: 320, h: 270 }),
        card('k3', { texture: texUrl, shape: 'torus' }, { x: 640, y: 0, w: 320, h: 270 }),
        card('k4', { shape: 'knot' }, { x: 0, y: 270, w: 960, h: 270 }),
      ]);
      await page.evaluate((p) => window.__pcStage.setProject(p), project);
      await page.evaluate(() => window.__pcStage.setTime(0.5));
      const painted = await page.evaluate(WAIT_PAINTED, 4);
      const diag = await page.evaluate(() => window.__pcStageDiag().gl);
      const worker = await page.evaluate(() => window.__pcGlWorkerDiag());
      const mainAlive = await page.evaluate(() => window.__pcGlCtxAlive?.() ?? null);
      const mainCreated = await page.evaluate(() => window.__pcGlCtxCreated?.() ?? null);
      await shot(page, 'worker.png');
      result.cases.route1 = { painted, diag: { mode: diag.mode, route: diag.route, beats: diag.beats }, worker, mainAlive, mainCreated, errors };
      check(!painted.timeout, '路线 1:4 个 gl 平面都贴上了当前帧的位图', painted);
      check(diag.mode === 'worker', '路线 1:glHost 走自己的 Worker', diag.mode);
      check(mainAlive === 0, '路线 1:舞台主线程 0 个活的 WebGL 上下文', { mainAlive, mainCreated });
      check(worker?.contexts === 1, '路线 1:Worker 里恰好 1 个上下文', worker);
      check(worker?.threeTextures === 1 && worker?.uploads === 1, '同一张贴图被 3 张卡引用:THREE.Texture 一个、上传一次', worker);

      /* ---- 节拍:点一次时间轴只发一拍;同步 advanceTo 只在结束后发一拍 ---- */
      const beats0 = diag.beats;
      await page.evaluate(() => window.__pcStage.setTime(2.0));
      await page.evaluate(WAIT_PAINTED, 4);
      const beats1 = (await page.evaluate(() => window.__pcStageDiag().gl)).beats;
      await page.evaluate(() => window.__pcStage.setTime(2.3)); // 往前 0.3 秒:连续路,同步 advanceTo 推 9 帧
      await page.evaluate(WAIT_PAINTED, 4);
      const beats2 = (await page.evaluate(() => window.__pcStageDiag().gl)).beats;
      result.cases.beatCount = { beats0, beats1, beats2 };
      check(beats1 - beats0 === 1, '点一次时间轴(远跳)只发一拍 beat', { beats0, beats1 });
      check(beats2 - beats1 === 1, 'K3(a) 的同步 advanceTo(往前 0.3 秒 = 9 帧)只在结束后发一拍 beat', { beats1, beats2 });

      /* ---- 快照:back 角色下生成快照 ---- */
      await page.evaluate(() => window.__pcStage.setRole('back'));
      const probeReply = await page.evaluate(() => window.__pcStage.setTime(1.0, { probe: true }));
      const snap = await page.evaluate(() => {
        const s = window.__pcCreateSnapshot();
        return { lossy: s.lossy, imgs: s.controls.map((c) => (c.html.match(/<img[^>]*src="data:image\/png;base64,/g) || []).length), sizes: s.controls.map((c) => c.html.length) };
      });
      const tampered = await page.evaluate(() => {
        const p = document.querySelector('[data-pc-gl-plane]');
        p.setAttribute('data-pc-gl-frame', '99999');
        return window.__pcCreateSnapshot().lossy;
      });
      result.cases.snapshot = { probeReply, snap, tampered };
      check(snap.lossy === 0 && snap.imgs.every((n) => n >= 1), '生成快照:three 卡是非空 <img>、lossy = 0', snap);
      check(tampered === 1, '把一张卡的 data-pc-gl-frame 改成不符的值:lossy 计到它(= 1)', tampered);
      check(typeof probeReply?.stepMs === 'number', 'setTime({ probe }) 回包带 stepMs(含 beat → done 往返)', probeReply);
      await page.close();
    }

    /* ---- 20 张 three.js 卡同时活跃 ---- */
    {
      const { page, errors } = await openStage();
      const lost = [];
      page.on('console', (m) => { if (/context lost|CONTEXT_LOST/i.test(m.text())) lost.push(m.text()); });
      await page.evaluate((p) => window.__pcStage.setProject(p), projectOf(grid(20, 5)));
      await page.evaluate(() => window.__pcStage.setTime(1.2));
      const painted = await page.evaluate(WAIT_PAINTED, 20);
      const worker = await page.evaluate(() => window.__pcGlWorkerDiag());
      const mainAlive = await page.evaluate(() => window.__pcGlCtxAlive?.() ?? null);
      await shot(page, 'twenty.png');
      result.cases.twenty = { painted, worker, mainAlive, lost, errors };
      check(!painted.timeout && painted.planes === 20, '20 张 scene-3d 同时活跃:20 个平面都贴上了位图', painted);
      check(worker?.contextLost === 0 && worker?.contexts === 1 && lost.length === 0, '20 张卡不触发 webglcontextlost,Worker 里仍是 1 个上下文', { worker, lost });
      check(mainAlive === 0, '20 张卡:舞台主线程 0 个活的 WebGL 上下文', mainAlive);
      await page.close();
    }

    /* ---- 能力退路:?glOffscreen=0 ---- */
    {
      const project = projectOf([card('k4', { shape: 'knot' }, { x: 0, y: 0, w: 960, h: 540 })]);
      const run = async (query, file) => {
        const { page, errors } = await openStage(query);
        await page.evaluate((p) => window.__pcStage.setProject(p), project);
        await page.evaluate(() => window.__pcStage.setTime(1.5));
        const painted = await page.evaluate(WAIT_PAINTED, 1);
        const diag = await page.evaluate(() => window.__pcStageDiag().gl);
        const caps = await page.evaluate(async () => (await import('/src/render/stageRpc.ts')).detectHostCapabilities());
        const mainAlive = await page.evaluate(() => window.__pcGlCtxAlive?.() ?? null);
        const img = await shot(page, file);
        await page.close();
        return { painted, mode: diag.mode, offscreenGl: caps.offscreenGl, mainAlive, img, errors };
      };
      const w = await run('', 'fallback-worker.png');
      const m = await run('&glOffscreen=0', 'fallback-main.png');
      let diff = 0, maxd = 0;
      for (let i = 0; i < w.img.data.length; i++) { const d = Math.abs(w.img.data[i] - m.img.data[i]); if (d) { diff++; maxd = Math.max(maxd, d); } }
      result.cases.fallback = { worker: { ...w, img: undefined }, main: { ...m, img: undefined }, diffBytes: diff, maxDiff: maxd };
      check(m.offscreenGl === false && m.mode === 'main', '能力退路:offscreenGl 强制为 false 时 glHost 走主线程', { offscreenGl: m.offscreenGl, mode: m.mode });
      check(!m.painted.timeout, '能力退路:beat / done 协议不变,平面照样贴上当前帧', m.painted);
      check(m.mainAlive === 1, '能力退路:主线程恰好 1 个上下文(顶替 Worker 的那一个)', m.mainAlive);
      check(diff === 0, '能力退路:画面和 Worker 那条路逐像素相同', { diff, maxd });
    }
  }

  /* ============================================================ 编辑台 */
  if (wants('编辑台')) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1600, height: 1000 });
    await page.evaluateOnNewDocument(COUNT_GL);
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(origin + '/?editor&headless=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 180000 });
    await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 180000 });
    await page.waitForFunction(async () => (await import('/src/editor/stageBridge.ts')).backRole() === 'back', { timeout: 180000, polling: 500 });
    const frameOf = (id) => page.frames().find((f) => f.url().includes('stage=1') && f.url().includes(`id=${id}`));
    const build = async (n, route) => page.evaluate(async ({ n, route }) => {
      await import('/src/cards/index.ts');
      const { actions, getState } = await import('/src/store/project.ts');
      actions.newProject('gl-stage-probe');
      actions.setProjectMeta({ fps: 30, duration: 6 });
      for (let i = 0; i < n; i++) actions.addCardClip('scene-3d', 0, { duration: 6 });
      actions.editCardProject((p) => ({ ...p, glRoute: route }));
      const ids = getState().project.tracks.flatMap((t) => t.clips.filter((c) => c.cardId === 'scene-3d').map((c) => c.id));
      // 每轮换一个颜色:成本记录按 identityKey(含参数)落在 dev server 上、跨轮还在,换了参数就不会撞上上一轮写的
      const salt = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
      ids.forEach((id, i) => actions.setClipParams(id, { shape: ['knot', 'cube', 'torus'][i % 3], spinY: 0.2 + i * 0.1, color: '#' + salt }, { merge: true }));
      actions.seek(0.5);
      return ids;
    }, { n, route });
    const waitProbeIdle = () => page.waitForFunction(async () => (await import('/src/editor/probeRunner.ts')).probeProgress().running === false,
      { timeout: 300000, polling: 300 }).catch(() => {});

    /* ---- 路线 2:上下文数、端口、释放 ---- */
    const ids = await build(3, 'shared');
    await waitProbeIdle();
    const fronts = await page.evaluate(() => window.__pcPreviewDiag?.().frontId);
    const fa = frameOf(fronts);
    await page.evaluate(async (t) => { const { actions } = await import('/src/store/project.ts'); actions.seek(t); }, 1.0);
    const painted = await fa.evaluate(WAIT_PAINTED, 3);
    const other = fronts === 'A' ? 'B' : 'A';
    const fb = frameOf(other);
    const dA = await fa.evaluate(() => window.__pcStageDiag().gl);
    const dB = await fb.evaluate(() => window.__pcStageDiag().gl);
    const mainA = await fa.evaluate(() => window.__pcGlCtxAlive?.() ?? null);
    const mainB = await fb.evaluate(() => window.__pcGlCtxAlive?.() ?? null);
    const shared = await page.evaluate(() => window.__pcSharedGlDiag?.() ?? null);
    const parentAlive = await page.evaluate(() => window.__pcGlCtxAlive?.() ?? null);
    const buf = await page.screenshot({ type: 'png' });
    fs.writeFileSync(path.join(out, 'editor-front.png'), buf);
    result.cases.route2 = { front: fronts, painted, dA: { mode: dA.mode, route: dA.route, stageId: dA.stageId }, dB: { mode: dB.mode, route: dB.route, stageId: dB.stageId }, mainA, mainB, shared, parentAlive };
    check(!painted.timeout, '路线 2:可见舞台的 3 个平面都贴上了当前帧', painted);
    check(dA.mode === 'port' && dA.route === 'shared', '路线 2:可见舞台走父页交来的端口', dA.mode);
    check(mainA === 0 && mainB === 0, '路线 2:两个舞台文档主线程都是 0 个活的上下文', { mainA, mainB });
    check(shared?.contexts === 1, '路线 2:父页的共享 Worker 里 1 个上下文', shared);
    // 后台舞台也画一次(它平时只在探针 / 补跑时画),然后 setRole('back') 释放它那一份
    await fb.evaluate(async () => {
      const { getState } = await import('/src/store/project.ts').catch(() => ({ getState: null }));
      void getState;
    }).catch(() => {});
    const projectNow = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().project);
    await fb.evaluate(async (p) => { await window.__pcStage.setProject(p, { reset: true }); await window.__pcStage.setTime(1.0); }, projectNow);
    await fb.evaluate(WAIT_PAINTED, 3);
    const before = await page.evaluate(() => window.__pcSharedGlDiag());
    await fb.evaluate(() => window.__pcStage.setRole('back'));
    await new Promise((r) => setTimeout(r, 200));
    const after = await page.evaluate(() => window.__pcSharedGlDiag());
    const dB2 = await fb.evaluate(() => window.__pcStageDiag().gl);
    result.cases.release = { before: before?.atlas, after: after?.atlas, stageIdAfter: dB2.stageId, releases: dB2.releases };
    check(!!before?.atlas?.[other] && !!before?.atlas?.[fronts], `释放前:共享 Worker 里 ${fronts} / ${other} 各一份图集`, before?.atlas);
    check(!after?.atlas?.[other] && !!after?.atlas?.[fronts], `对 ${other} 发 setRole('back') 后:它那份图集被释放,${fronts} 的不动`, after?.atlas);
    check(dB2.stageId === other && dB2.mode === 'port', 'stageId 不随角色变、端口不换', dB2);

    /* ---- 播放节拍 + Worker 睡 100 ms ---- */
    await build(3, 'perDocument');
    await waitProbeIdle();
    result.cases.lightCosts = await page.evaluate(SET_COSTS, { heavy: false });
    const front = frameOf(await page.evaluate(() => window.__pcPreviewDiag?.().frontId));
    await front.evaluate(WAIT_PAINTED, 3);
    const recordPlay = async (ms) => {
      await page.evaluate(() => {
        window.__glFrames = [];
        if (!window.__glRec) {
          window.__glRec = true;
          window.addEventListener('message', (e) => { if (e.data?.type === 'frame') window.__glFrames.push({ sec: e.data.sec, at: performance.now() }); });
        }
      });
      await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(0); actions.play(); });
      await new Promise((r) => setTimeout(r, ms / 2));
      const mid = await page.evaluate(() => window.__pcPreviewDiag?.());
      const midStage = await frameOf(mid?.frontId ?? 'A').evaluate(() => {
        const d = window.__pcStageDiag();
        const id = document.querySelector('[data-pc-gl-plane]')?.getAttribute('data-pc-gl-plane');
        return { suppressed: d.suppressed, at: id ? window.__pcStagePipelineAt?.(id, d.t) : null, byClip: id ? window.__pcStagePlan?.()?.byClip?.get(id) ?? null : null };
      });
      await new Promise((r) => setTimeout(r, ms / 2));
      await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause(); });
      await new Promise((r) => setTimeout(r, 300));
      const frames = await page.evaluate(() => window.__glFrames);
      const secDiffs = frames.slice(1).map((f, i) => +(f.sec - frames[i].sec).toFixed(6));
      const gaps = frames.slice(1).map((f, i) => f.at - frames[i].at);
      return { mid: { front: mid?.frontId, ...midStage }, n: frames.length, badSec: secDiffs.filter((d) => Math.abs(d - 1 / 30) > 1e-6).length, gapMean: gaps.reduce((a, b) => a + b, 0) / Math.max(1, gaps.length), gapMin: Math.min(...gaps), gapMax: Math.max(...gaps) };
    };
    const normal = await recordPlay(2000);
    const glNormal = await front.evaluate(() => window.__pcStageDiag().gl);
    for (const id of ['A', 'B']) await frameOf(id).evaluate(() => { window.__pcGlDebugSleepMs = 100; });
    const slowBefore = await front.evaluate(() => { const d = window.__pcStageDiag(); return { beats: d.gl.beats, suppressed: d.suppressed }; });
    const slow = await recordPlay(2000);
    slow.glBeats = (await front.evaluate(() => window.__pcStageDiag().gl.beats)) - slowBefore.beats;
    slow.suppressedBefore = slowBefore.suppressed;
    const stall = await page.evaluate(() => window.__pcPreviewDiag?.());
    for (const id of ['A', 'B']) await frameOf(id).evaluate(() => { window.__pcGlDebugSleepMs = 0; });
    const rt = [...glNormal.roundTrips].sort((a, b) => a - b);
    result.cases.play = { normal, slow, stallCount: stall?.mediaStallCount, gapMax: stall?.mediaGapMaxMs,
      roundTrip: { p50: rt[Math.floor(rt.length / 2)], p90: rt[Math.floor(rt.length * 0.9)], max: rt[rt.length - 1], timeouts: glNormal.timeouts } };
    check(normal.n > 20 && normal.badSec === 0, '播放:frame 的 sec 差恒为 1/fps', normal);
    check(slow.n > 5 && slow.badSec === 0 && slow.gapMin >= 95, 'Worker 睡 100 ms:舞台等它、不跳帧(sec 差仍是 1/fps,到达间隔 ≥ 100 ms)', slow);
    check((stall?.mediaStallCount ?? 0) > 0, 'Worker 睡 100 ms:主文档判卡顿(40 ms 后暂停音频 / 素材)', stall);

    /* ---- 追帧(K5 第一路)---- */
    const setCosts = await page.evaluate(SET_COSTS, { heavy: true });
    const fstage = frameOf(await page.evaluate(() => window.__pcPreviewDiag?.().frontId));
    const catchup = await fstage.evaluate(async () => {
      const clipId = document.querySelector('[data-pc-gl-plane]').getAttribute('data-pc-gl-plane');
      const sp = window.__pcStagePlan?.();
      const planInfo = { at3: window.__pcStagePipelineAt?.(clipId, 3.0), vtOk: sp?.byClip?.get(clipId)?.vtOk ?? null, hasPlan: !!sp?.plan };
      const wrap = () => document.querySelector(`[data-pc-clip="${clipId}"]`);
      const beats0 = window.__pcStageDiag().gl.beats;
      let sawSettling = false;
      let settlingBeats = null;
      const unset = [];
      const obs = new MutationObserver(() => {
        const w = wrap();
        if (!w) return;
        if (w.classList.contains('pc-settling')) {
          if (!sawSettling) settlingBeats = window.__pcStageDiag().gl.beats;
          sawSettling = true;
          return;
        }
        if (sawSettling && !unset.length) {
          const plane = w.querySelector('[data-pc-gl-plane]');
          unset.push({ glFrame: plane?.getAttribute('data-pc-gl-frame'), localFrame: w.getAttribute('data-pc-local-frame'), beats: window.__pcStageDiag().gl.beats });
        }
      });
      obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'], childList: true });
      await window.__pcStage.setTime(3.0, { settle: true });
      const now = window.__pcRealNow, later = (ms) => new Promise((r) => window.__pcRealSetTimeout(r, ms));
      const t0 = now();
      while (!unset.length && now() - t0 < 10000) await later(20);
      obs.disconnect();
      return { clipId, planInfo, sawSettling, settlingBeats, unset: unset[0] ?? null, beats0, beatsEnd: window.__pcStageDiag().gl.beats };
    });
    result.cases.catchup = { setCosts, ...catchup };
    check(catchup.sawSettling, '追帧:判重、vtOk 的 canvas 卡进了 .pc-settling(K5 第一路)', catchup);
    check(!!catchup.unset && catchup.unset.glFrame === catchup.unset.localFrame, '追帧:摘 .pc-settling 的那一刻平面上已是目标帧的位图(gl-frame = 本地帧号)', catchup.unset);
    // setTime 自己一拍 + 追上那一拍;中间步(3 秒 × 30 帧 = 90 步)一拍都不发
    // 从进 .pc-settling 到摘掉:只有追上那一拍(3 秒 × 30 帧 = 90 步的中间步一拍都不发)
    // 进 .pc-settling 之后:setTime 自己落定那一拍(卡被 .pc-settling 藏着,画的是挂载帧)+ 追上那一拍;90 个中间步一拍不发
    check(catchup.unset && catchup.settlingBeats !== null && catchup.unset.beats - catchup.settlingBeats <= 2, '追帧中间步不发 beat(进 .pc-settling 到摘掉之间 ≤ 2 拍:setTime 那一拍 + 追上那一拍)', catchup);
    result.cases.editorErrors = errors;
    await page.close();
  }
} finally {
  await browser.close().catch(() => {});
}

fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ...result, fails }, null, 2));
console.log(JSON.stringify(result, (k, v) => (k === 'roundTrips' ? undefined : v), 2).slice(0, 6000));
console.log(fails.length ? `FAIL ${fails.length}:\n  ${fails.join('\n  ')}` : 'PASS 全部');
console.log('产物:', out);
process.exitCode = fails.length ? 1 : 0;
