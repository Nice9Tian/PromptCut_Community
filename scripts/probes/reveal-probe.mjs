/**
 * R7「露出舞台」的验收探针（D5 + E + K 的合验里属于 R7 的那几条）。
 *
 *   node scripts/probes/reveal-probe.mjs [--port 5291] [--origin http://127.0.0.1:5291]
 *                                        [--seconds 6] [--keep] [--json out/reveal.json]
 *                                        [--only 露出,拖动,播放,点选] [--headed]
 *
 * 不带 `--origin` 时自己起一台 dev server（缺省 5291，舞台端口随之 5292 / 5293），
 * `PROMPTCUT_DATA_DIR` 指到临时目录 —— 不隔离的话这一趟会把仓库 `out/card-costs.json` 冲掉。
 *
 * # 这个探针和别的不一样的地方：**一个参数都不带地打开编辑台**
 *
 * 别的探针要么带 `?preview=stage`（验新路），要么带 `?preview=legacy`（验回滚）。
 * 这一个**故意什么都不带** —— R7 的全部意义就是「缺省翻了过来」，所以它开
 * `/?editor&headless=1`，然后断言看到的是双舞台、而且可见那一个**真的露出来了**。
 * 翻开关之前跑它必然是红的，这正是它该有的样子。
 *
 * # 量法限制（照 R2 报告）
 *
 * 无头 Chrome 不带 `--disable-gpu-vsync --disable-frame-rate-limit` 时 rAF 会退到 10 Hz，
 * 舞台的节拍循环等不到帧、拍长全错，所以两个开关必须带。**代价**：带了之后 rAF 不再被
 * 垂直同步量化成 16.6 ms 的格子，于是「24 fps 自然是 2/3 帧交替」这类现象在这里观察不到。
 * 能量准、也是真正要保的，是**到达间隔的均值 = 1000 / fps** 和**连续 `sec` 差恒为 1/fps**。
 * `--headed` 用有头 Chrome 再跑一遍播放和拖动 —— 用户真正看到的是有头浏览器，
 * 有头下 rAF 受真实显示节拍约束，报出来的间隔才是用户感觉到的那个。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

import { stagePortsOf } from '../../server/stage-ports.mjs';

/* ------------------------------------------------------------------ 参数 */

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : fallback; };
const has = (name) => argv.includes(name);

const port = Number(flag('--port', '5291')) || 5291;
const originArg = flag('--origin');
const seconds = Math.max(1, Number(flag('--seconds', '6')) || 6);
const keep = has('--keep');
const headed = has('--headed');
const outJson = flag('--json');
const only = (flag('--only') || '').split(',').map((s) => s.trim()).filter(Boolean);
const origin = (originArg || `http://127.0.0.1:${port}`).replace(/\/+$/, '');
const wants = (name) => !only.length || only.includes(name);

/** **一个参数都不带** —— R7 验的就是缺省行为 */
const EDITOR_URL = '/?editor&headless=1';
/** 回滚那一条要显式带 legacy */
const LEGACY_URL = '/?editor&headless=1&preview=legacy';

const fails = [];
const out = { origin, editorUrl: EDITOR_URL, stagePorts: stagePortsOf(port), seconds, headed, cases: {} };
const check = (cond, label, extra) => {
  if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${msg}\n`);

/* ------------------------------------------------------------------ dev server */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-reveal-'));
let server = null;

async function startServer() {
  if (originArg) return null;
  const viteBin = path.join(path.dirname(createRequire(import.meta.url).resolve('vite/package.json')), 'bin', 'vite.js');
  const proc = spawn(process.execPath,
    [viteBin, '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
    { windowsHide: true, cwd: path.resolve(import.meta.dirname, '../..'), env: { ...process.env, PROMPTCUT_DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = [];
  proc.stdout.on('data', (b) => log.push(String(b)));
  proc.stderr.on('data', (b) => log.push(String(b)));
  for (let i = 0; i < 240; i++) {
    try {
      const res = await fetch(origin + '/@vite/client');
      if (res.ok) return proc;
    } catch { /* 还没起来 */ }
    await sleep(500);
  }
  proc.kill();
  throw new Error(`dev server 240 秒没起来:\n${log.join('')}`);
}

async function stopServer() {
  if (!server) return;
  const pid = server.pid;
  server.kill();
  if (process.platform === 'win32') {
    await new Promise((r) => spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('close', r));
  }
  server = null;
}

/* ------------------------------------------------------------------ 页面侧脚本 */

const INSTALL_RECORDERS = async () => {
  const bridge = await import('/src/editor/stageBridge.ts');
  window.__pcFrames = [];
  window.__pcEvents = [];
  if (!window.__pcOffEvents) {
    window.__pcOffEvents = bridge.onStageEvent((e) => {
      const at = performance.now();
      if (e.type === 'frame') window.__pcFrames.push({ sec: e.sec, at });
      else window.__pcEvents.push({ type: e.type, sec: e.sec, clipId: e.clipId ?? null, at });
    });
  }
  window.__pcLongTasks = [];
  if (!window.__pcLongObs) {
    try {
      window.__pcLongObs = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) window.__pcLongTasks.push({ start: entry.startTime, dur: entry.duration });
      });
      window.__pcLongObs.observe({ entryTypes: ['longtask'] });
    } catch { window.__pcLongObs = null; }
  }
  return true;
};

const RESET_RECORDERS = () => { window.__pcFrames = []; window.__pcEvents = []; window.__pcLongTasks = []; };
const READ_RECORDERS = () => ({ frames: window.__pcFrames, events: window.__pcEvents, longTasks: window.__pcLongTasks });

/** 建一个项目:一条轨道一张卡 */
const BUILD = async ({ fps, duration, cards }) => {
  await import('/src/cards/index.ts');
  const { actions, getState } = await import('/src/store/project.ts');
  actions.newProject('reveal-probe');
  actions.setProjectMeta({ fps, duration });
  for (const card of cards) actions.addCardClip(card.id, card.start ?? 0, { duration: card.duration ?? duration });
  const project = getState().project;
  const byCard = {};
  for (const tr of project.tracks) for (const c of tr.clips) if (c.cardId) (byCard[c.cardId] ||= []).push(c.id);
  actions.setProjectMeta({ duration });
  return { byCard, fps: getState().project.fps, duration: getState().project.duration };
};

/**
 * 主文档里此刻有没有「整帧预览」和「素材元素」。
 *
 * R7 之后两样都该没有:整帧 `<img>`(UnifiedPreview)只留给 legacy,素材层在舞台里。
 * **只看预览区**(`.pc-pv-stagebox` 那棵子树 / 退回舞台 iframe 的父节点):
 * 右栏聊天里的截图、时间轴缩略图也是 `<img>`,它们不算。
 */
const SCAN_MAIN_DOC = () => {
  const frame = document.querySelector('iframe[data-pc="stage-frame"]');
  const box = frame ? frame.parentElement : null;
  if (!box) return { noBox: true };
  const imgs = [...box.querySelectorAll('img')].map((el) => ({ src: String(el.getAttribute('src') || '').slice(0, 80), w: el.clientWidth, h: el.clientHeight }));
  const videos = [...box.querySelectorAll('video')].map((el) => ({ src: String(el.currentSrc || el.getAttribute('src') || '').slice(0, 80) }));
  const canvases = [...box.querySelectorAll('canvas')].map((el) => ({ w: el.width, h: el.height }));
  const frames = [...box.querySelectorAll('iframe[data-pc^="stage-frame"]')].map((el) => ({
    which: el.getAttribute('data-pc'),
    src: String(el.getAttribute('src') || ''),
    opacity: getComputedStyle(el).opacity,
    display: getComputedStyle(el).display,
    visibility: getComputedStyle(el).visibility,
    pointerEvents: getComputedStyle(el).pointerEvents,
  }));
  return { imgs, videos, canvases, frames };
};

/** ProbeGate 遮罩还在不在 */
const GATE_ON = () => !!document.querySelector('[data-pc="probe-gate"]');

/* ------------------------------------------------------------------ 小工具 */

const stats = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return { n: xs.length, mean: +mean.toFixed(3), p50: +s[Math.floor(s.length * 0.5)].toFixed(3), min: +s[0].toFixed(3), max: +s[s.length - 1].toFixed(3) };
};

async function waitProbeIdle(page, timeoutMs = 300000) {
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/probeRunner.ts');
    return m.probeProgress().running === false;
  }, { timeout: timeoutMs, polling: 300 }).catch(() => {});
}

async function stageDiag(page, id) {
  const frame = page.frames().find((f) => f.url().includes('stage=1') && f.url().includes(`id=${id}`));
  if (!frame) return null;
  return await frame.evaluate(() => (typeof window.__pcStageDiag === 'function' ? window.__pcStageDiag() : null)).catch(() => null);
}
async function frontDiag(page) {
  const which = await page.evaluate(() => (typeof window.__pcPreviewDiag === 'function' ? window.__pcPreviewDiag() : null));
  if (!which) return { preview: null, stage: null };
  return { preview: which, stage: await stageDiag(page, which.frontId) };
}

/** CDP 眼里有几个 `type: 'iframe'` 的 target —— 有 target 才说明它是独立进程的 iframe */
async function iframeTargets(page) {
  const cdp = await page.target().createCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  await cdp.detach().catch(() => {});
  return targetInfos.filter((t) => t.type === 'iframe');
}

/** 开一页编辑台并等到「能用」 */
async function openEditor(browser, url, { dual = true } = {}) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(origin + url, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 180000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage();
  }, { timeout: 180000, polling: 500 });
  if (dual) {
    await page.waitForFunction(async () => {
      const m = await import('/src/editor/stageBridge.ts');
      return m.backRole() === 'back';
    }, { timeout: 180000, polling: 500 });
  }
  return { page, errors };
}

/* ------------------------------------------------------------------ 主流程 */

const launchOpts = {
  headless: !headed,
  protocolTimeout: 240000,
  args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding'],
};
if (headed) {
  /*
   * **有头下不关垂直同步**:这一趟的意义就是量用户真正看到的那个数。关掉 vsync
   * 量到的是「主线程最快能推多少拍」,不是屏幕上真实的节拍。
   */
} else {
  // R2 报告:不带这两个,这台机器上无头 Chrome 的 rAF 退到 10 Hz,节拍循环根本等不到帧
  launchOpts.args.push('--disable-gpu-vsync', '--disable-frame-rate-limit');
  launchOpts.args.splice(PROBE_CHROME_ARGS.length, 0, '--window-position=-32000,-32000'); // 仍以 PROBE_CHROME_ARGS 打头
}

const browser = await puppeteer.launch(launchOpts);
let exitCode = 0;
let page = null;
let errors = [];
try {
  server = await startServer();
  step('goto editor (缺省模式,一个 preview 参数都不带)');
  ({ page, errors } = await openEditor(browser, EDITOR_URL, { dual: true }));
  step('两个舞台都登记好了');
  await page.evaluate(INSTALL_RECORDERS);

  /* ========================================================= 1. 露出舞台 */
  if (wants('露出')) {
    // 建一个项目,让 ProbeGate 真的有东西要测
    await page.evaluate(BUILD, { fps: 30, duration: 12, cards: [{ id: 'probe-css' }, { id: 'odometer' }] });
    // 遮罩:测的时候在,测完摘掉
    const sawGate = await page.waitForFunction(GATE_ON, { timeout: 30000, polling: 50 }).then(() => true, () => false);
    await waitProbeIdle(page);
    await sleep(500);
    const gateAfter = await page.evaluate(GATE_ON);
    const scan = await page.evaluate(SCAN_MAIN_DOC);
    const targets = await iframeTargets(page);
    const diag = await frontDiag(page);
    const frontWhich = diag.preview?.frontId === 'B' ? 'stage-frame-back' : 'stage-frame';
    const frontEl = (scan.frames ?? []).find((f) => f.which === frontWhich);
    const backEl = (scan.frames ?? []).find((f) => f.which !== frontWhich);
    out.cases['露出'] = { sawGate, gateAfter, scan, iframeTargets: targets.length, frontId: diag.preview?.frontId ?? null };

    check(sawGate, '打开项目时 ProbeGate 遮罩出现过');
    check(gateAfter === false, '测完之后遮罩摘掉了');
    check(frontEl && frontEl.opacity === '1', '可见舞台露出来了(front 的 opacity 是 1)', frontEl);
    check(backEl && backEl.opacity === '0' && backEl.pointerEvents === 'none',
      '后台舞台仍然是 opacity: 0 + pointer-events: none', backEl);
    check(backEl && backEl.display !== 'none' && backEl.visibility !== 'hidden',
      '后台舞台不用 display / visibility 藏(K5 (4))', backEl);
    check(targets.length === 2, 'CDP 里有两个 type: iframe 的 target(各自一个进程)', targets.length);
    check((scan.imgs ?? []).length === 0, '主文档的预览区里没有整帧 <img>', scan.imgs);
    check((scan.videos ?? []).length === 0, '主文档的预览区里没有素材 <video>(素材层在舞台里)', scan.videos);
  }

  /* ========================================================= 2. 暂停拖动 */
  if (wants('拖动')) {
    await page.evaluate(BUILD, { fps: 30, duration: 30, cards: [{ id: 'probe-css' }, { id: 'odometer' }] });
    await waitProbeIdle(page);
    await sleep(400);
    const N = 30;
    const trips = [];
    let awaitingSeen = 0;
    let awaitingStuck = 0;
    const genBefore = (await frontDiag(page)).stage?.remountGen ?? null;
    for (let i = 0; i < N; i++) {
      const sec = 1 + (i * 0.7) % 25;
      const t0 = Date.now();
      await page.evaluate(async (s) => {
        const { actions } = await import('/src/store/project.ts');
        actions.seek(s);
      }, sec);
      // 一次 setTime 往返(不等 HTTP)——父页发完就回
      await page.waitForFunction(async (s) => {
        const { getState } = await import('/src/store/project.ts');
        return Math.abs(getState().t - s) < 1e-6;
      }, { timeout: 5000, polling: 10 }, sec).catch(() => {});
      trips.push(Date.now() - t0);
      // `.pc-awaiting` 必须 500 ms 内摘掉
      const st = await stageDiag(page, (await page.evaluate(() => window.__pcPreviewDiag?.().frontId)) || 'A');
      const awaiting = st?.awaiting ?? [];
      if (awaiting.length) {
        awaitingSeen++;
        const cleared = await page.waitForFunction(async () => true, { timeout: 10 }).then(async () => {
          for (let k = 0; k < 25; k++) {
            await sleep(20);
            const s2 = await stageDiag(page, (await page.evaluate(() => window.__pcPreviewDiag?.().frontId)) || 'A');
            if (!(s2?.awaiting ?? []).length) return true;
          }
          return false;
        });
        if (!cleared) awaitingStuck++;
      }
    }
    const genAfter = (await frontDiag(page)).stage?.remountGen ?? null;
    const beat = 1000 / 30;
    out.cases['拖动'] = { trips: stats(trips), overBeat: trips.filter((x) => x > beat).length, awaitingSeen, awaitingStuck, genBefore, genAfter };
    // 原先这里要求「每一次 setTime 往返都不超过三拍（100 ms）」。那个数量的是机器有多快，语义里没有这条时间承诺，
    // 按 verification.md「耗时只记录，不当闸门」（2026-10-07 用户改定）改为只记录（往返次数与超过一拍的次数都在 out.cases['拖动'] 里）。
    // 它想证的「不等 HTTP」更该用「这段里没有发出网络请求」来断言，记进报告的待办，这次没有现编新断言。
    // 2026-10-23 探针总审第三遍扫描（阈值是表达式那一类，前两遍的正则都漏了）。
    check(trips.length > 0, '暂停拖动:每一次 setTime 都回来了(往返用时只记录,不当闸门)', out.cases['拖动']);
    check(awaitingStuck === 0, '.pc-awaiting 500 ms 内必被摘掉', { awaitingSeen, awaitingStuck });
  }

  /* ========================================================= 3. 播放 */
  if (wants('播放')) {
    const cadence = {};
    for (const fps of [24, 30, 60]) {
      step(`播放 ${fps} fps`);
      await page.evaluate(BUILD, { fps, duration: seconds + 6, cards: [{ id: 'probe-css' }] });
      await waitProbeIdle(page);
      await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(0); });
      await sleep(300);
      await page.evaluate(RESET_RECORDERS);
      await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.play(); });
      await sleep(seconds * 1000);
      await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause(); });
      await sleep(400);
      const rec = await page.evaluate(READ_RECORDERS);
      const gaps = [];
      for (let i = 1; i < rec.frames.length; i++) gaps.push(rec.frames[i].at - rec.frames[i - 1].at);
      const secDiffWrong = rec.frames.slice(1).filter((f, i) => Math.abs(f.sec - rec.frames[i].sec - 1 / fps) > 1e-6).length;
      const g = stats(gaps);
      cadence[fps] = { gap: g, secDiffWrong, frames: rec.frames.length, longTasks: rec.longTasks.length };
      check(g && Math.abs(g.mean - 1000 / fps) <= 1,
        `播放 ${fps} fps:frame 到达间隔均值 = 1000/fps ± 1 ms`, { want: 1000 / fps, got: g?.mean });
      check(secDiffWrong === 0, `播放 ${fps} fps:连续 sec 差恒为 1/fps(不跳帧)`, secDiffWrong);
    }
    out.cases['播放'] = cadence;

    /*
     * 「零卡顿」那一条:**这次要同时跑着后台舞台探针和预渲染进程**(R5 只量了没跑预渲染的情形)。
     * 后台探针靠换一份新项目触发(ProbeGate 之后 probeRunner 会继续在 back 上测),
     * 预渲染进程由 vite-plugin-prerender 自己拉起来 —— 这里只确认它在。
     */
    step('零卡顿:播放 + 后台探针 + 预渲染进程');
    const prerenderUp = await page.evaluate(async () => {
      try { const r = await fetch('/api/prerender/info', { cache: 'no-store' }); const d = await r.json(); return !!d?.ready; }
      catch { return false; }
    });
    await page.evaluate(BUILD, { fps: 30, duration: seconds + 6, cards: [{ id: 'probe-css' }, { id: 'odometer' }, { id: 'punch-pill' }] });
    // 故意**不**等探针测完:让它在 back 上边测边播
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.seek(0); });
    await sleep(200);
    await page.evaluate(RESET_RECORDERS);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.play(); });
    await sleep(seconds * 1000);
    await page.evaluate(async () => { const { actions } = await import('/src/store/project.ts'); actions.pause(); });
    await sleep(400);
    const busy = await page.evaluate(READ_RECORDERS);
    const probeState = await page.evaluate(async () => (await import('/src/editor/probeRunner.ts')).probeProgress());
    out.cases['零卡顿'] = {
      prerenderUp, probeRunningDuringPlayback: probeState.running,
      longTasks: busy.longTasks, longTaskCount: busy.longTasks.length, frames: busy.frames.length,
    };
    check(busy.longTasks.length === 0, '播放中主文档的长任务(> 50 ms)为 0', busy.longTasks.slice(0, 5));
  }

  /* ========================================================= 4. 点选 */
  if (wants('点选')) {
    const built = await page.evaluate(BUILD, { fps: 30, duration: 12, cards: [{ id: 'odometer' }] });
    await waitProbeIdle(page);
    await sleep(400);
    const odo = built.byCard['odometer'][0];
    await page.evaluate(async (id) => { const { actions } = await import('/src/store/project.ts'); actions.select([id]); }, odo);
    await sleep(300);
    // 在它的实体框中心点一下,看选中的是不是同一个 clipId、和 hitTest 说的一不一致
    const pt = await page.evaluate(async (id) => {
      const { frontStage } = await import('/src/editor/stageBridge.ts');
      const s = frontStage();
      const list = await s.rectsWithBounds({ pixels: 'all' });
      const b = list.find((r) => r.clipId === id)?.bounds;
      if (!b) return null;
      const x = b.left + b.width / 2;
      const y = b.top + b.height / 2;
      const hit = await s.hitTest(x, y);
      return { x, y, hitClipId: hit?.clipId ?? null };
    }, odo);
    out.cases['点选'] = { odo, ...pt };
    check(pt && pt.hitClipId === odo, '实体框中心的 hitTest 命中的就是它', pt);
  }

  const benign = (m) => /Failed to load resource/.test(m);
  out.errors = errors.filter((m) => !benign(m)).slice(0, 20);
  out.resourceErrors = errors.filter(benign).length;
  check(out.errors.length === 0, '页面没有 JS 报错', out.errors.slice(0, 5));

  /* ========================================================= 5. 回滚 */
  if (wants('回滚')) {
    step('回滚:?preview=legacy 下舞台该藏回去');
    const { page: lp } = await openEditor(browser, LEGACY_URL, { dual: false });
    await sleep(1500);
    const lscan = await lp.evaluate(SCAN_MAIN_DOC);
    out.cases['回滚'] = { scan: lscan };
    const lfront = (lscan.frames ?? [])[0];
    check((lscan.frames ?? []).length === 1, 'legacy 下只有一个舞台 iframe', (lscan.frames ?? []).length);
    check(lfront && lfront.opacity === '0', 'legacy 下舞台仍然是 opacity: 0(整帧 <img> 在上面)', lfront);
    /*
     * D5 / R7-6:回滚要把舞台里那个同名的 `LEGACY` 一起翻过去(`setProject` 立刻按跳转
     * 重算这一帧)。以前 `stageSrc` 从不传 `preview`,舞台侧那一半永远不生效。
     */
    check(!!lfront && /[?&]preview=legacy(&|$)/.test(lfront.src || ''),
      'legacy 下 ?preview=legacy 传进了舞台 iframe(舞台里的同名开关也翻过去)', lfront?.src);
    const lstage = lp.frames().find((fr) => fr.url().includes('stage=1'));
    const lstageUrl = lstage ? lstage.url() : null;
    out.cases['回滚'].stageUrl = lstageUrl;
    check(!!lstageUrl && lstageUrl.includes('preview=legacy') && !lstageUrl.includes('preview=stage'),
      'legacy 下舞台页自己的 URL 是 preview=legacy(不是 stage)', lstageUrl);
    await lp.close().catch(() => {});
  }
} catch (err) {
  fails.push('探针自己抛了:' + (err?.stack || String(err)));
  exitCode = 1;
} finally {
  out.fails = fails;
  out.ok = fails.length === 0;
  if (outJson) {
    fs.mkdirSync(path.dirname(path.resolve(outJson)), { recursive: true });
    fs.writeFileSync(path.resolve(outJson), JSON.stringify(out, null, 2));
  }
  console.log(JSON.stringify(out, null, 2));
  try { await browser.close(); } catch { /* 已经关了 */ }
  await stopServer();
  if (!keep) { try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* 删不掉就留着 */ } }
  else console.log('临时数据目录留着:' + dataDir);
}
process.exit(fails.length ? 1 : exitCode);
