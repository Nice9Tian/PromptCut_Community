/**
 * 舞台闸门、崩溃记录、护栏、档位气泡、查看口的真浏览器探针(`docs/plan/online-browser-task.md` 第三步;语义 `product/platforms.md`「在线浏览器」,
 * 做法 `mechanism/platforms.md`「三道闸门」)。无头 Chrome 打开在线构建的编辑页,**真的把页面进程杀掉**(CDP `Page.crash`)来模拟崩溃,
 * 再重新载入,看停在哪一级。
 *
 *   npx vite build --mode online
 *   node scripts/probes/stage-gate-probe.mjs [--dist dist-online] [--base-port 5870] [--out <目录>] [--only S1,S3]
 *
 * 端口:编辑器页 base、两个舞台 base+1 / +2、文档服务 base+3、素材服务 base+4(缺省 5870～5874)。本机隔离托管组合(`lib/mobile-env.mjs`),不连远端。
 * 页面里只读两个口:`window.__pcGates()`(查看口的数据)与 `[data-pc="tier-bubble"]`(气泡)。`?gateHold=<一步>`(只给验收)让舞台闸门记下那一步后停住,
 * 探针趁这时杀页面进程;`?gates=1` 打开只读查看口。
 *
 * 场景(每个场景一个新的浏览器上下文 = 全新的页面本地存储,除非写明接着上一个):
 *   S1  电脑全新打开:从低往高试,到第三级「顶配模式」;气泡文字照用户定的,几秒后自动消失;崩溃记录最后一步是「第 3 级运行中」
 *   S2  接着 S1 正常刷新(留了正常离开):不算崩;上次试成功,崩的次数为 0
 *   S3  试各一套渲染器时杀掉页面进程 → 重新载入停在第二级「标准模式」,崩 1 次、护栏 30 分钟;气泡「标准模式」
 *   S4  接着 S3:护栏内重新打开,停在第二级、不试
 *   S5  接着 S4:把护栏拨到过去(仿过了 30 分钟)→ 从头试,到第三级;再正常刷新 → 试成功一次,清零
 *   S6  试后台舞台时杀掉 → 停在第一级「精简模式」(一个舞台,没有后台舞台)
 *   S7  开可见舞台时(可见舞台就绪之前)杀掉 → 最低一档「低配模式」
 *   S8  切到后台(visibilitychange hidden)之后杀掉 → 不算崩
 *   S9  有护栏、崩过的记录,把记录里的软件版本改成旧的(仿升级)→ 清零,从头试
 *   S10 安卓手机(Chromium,报 4 GB)→ 不试,停在一个舞台,身份手机;报 8 GB → 试
 *   S11 电脑上只把后台舞台的进程杀掉(舞台崩了页面还在)→ 看守重载那一台、照旧第三级;反复崩 → 握手容错退回单舞台,只管当次:
 *       不留崩溃记录,重新载入照常试
 *   S12 iPad(桌面标识 + 多点触控):要试的先按电脑;试后台舞台时杀掉 → 重新载入停在第一级,身份改判手机
 *   S13 两个标签页:第一个还开着时开第二个,第二个不把第一个当成崩了
 *   S14 只读查看口:`?gates=1` 显示档位、舞台闸门、崩溃记录,不含凭证
 *   S15 最低一档(`?tier=low`):播放时卡被抑制、不即时渲染;停下后逐层追一帧画好(不设时限)
 *   S16 基准卡跑不动(舞台 CPU 降速 30 倍;再慢就超过气泡的等待上限,也容易测不出结论):进最低一档「低配模式」
 *   S17 测某张卡时杀掉页面进程 → 重新载入这张卡在测崩的卡里、不再测,直接当重卡
 *   S18 载入素材原尺寸时(留了记录的那段时间)杀掉 → 重新载入解码上限调低一级
 *   S19 解码上限:浏览器只说解得动 720p(仿弱设备)→ 上限 720p;查看口里看得到
 *   S20 两个舞台、项目里已有别的设备测好的成本记录:打开时按界限搜索只测几张划线(常驻探针先等着),之后常驻探针在后台补测、改按成本记录判;
 *       单舞台(`?tier=lite`)测完写进文档服务(所有在线浏览器测完都写)
 *
 * 输出:过程写 stderr;stdout 最后一行一行 JSON `{ ok, fails, scenes }`;截图在 --out。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { startMobileEnv, emptyProject, DEVICES } from './lib/mobile-env.mjs';

const args = process.argv.slice(2);
const DIST = path.resolve(flagArg('dist', 'dist-online', args));
const BASE = Number(flagArg('base-port', '5870', args));
const OUT = path.resolve(flagArg('out', path.join(os.tmpdir(), `stage-gate-${Date.now().toString(36)}`), args));
const ONLY = (flagArg('only', '', args) || '').split(',').filter(Boolean);
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const scenes = {};
const say = (...a) => process.stderr.write(`[stage-gate] ${a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')}\n`);
const check = (scene, cond, label, extra) => {
  if (!cond) fails.push(`${scene} ${label}${extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 600)}`}`);
  (scenes[scene] ??= { checks: 0, failed: 0 }).checks++;
  if (!cond) scenes[scene].failed++;
  return !!cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, timeoutMs = 60_000, everyMs = 150) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(everyMs);
  }
}

const IPAD = {
  ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  viewport: { width: 1180, height: 820, deviceScaleFactor: 2, isMobile: false, hasTouch: true },
};

const env = await startMobileEnv({ dist: DIST, basePort: BASE, docPort: BASE + 3, assetPort: BASE + 4, name: 'stage-gate-probe' });
// 项目里放一张内置卡(金句药丸,0～4 秒)与两份视频素材的登记(1080p、4K;只有登记、没有字节:素材闸门留记录与解码上限只看登记)
const seedProject = emptyProject('stage-gate-probe');
seedProject.tracks[0].clips.push({ id: 'pill-1', cardId: 'punch-pill', start: 0, end: 4, params: { text: '基准' } });
const HH = (c) => c.repeat(64);
seedProject.media = [
  { id: 'm-1080', kind: 'video', name: '1080.mp4', url: `/@media/${HH('1')}`, hash: HH('1'), ext: 'mp4', width: 1920, height: 1080, duration: 4, tiers: { original: HH('1'), small: HH('2') } },
  { id: 'm-4k', kind: 'video', name: '4k.mp4', url: `/@media/${HH('3')}`, hash: HH('3'), ext: 'mp4', width: 3840, height: 2160, duration: 4, tiers: { original: HH('3'), small: HH('4') } },
];
await env.seed(seedProject);
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 90_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--autoplay-policy=no-user-gesture-required'] });

/** 新的上下文与页面;`device` 是 mobile-env 的设备名或 'ipad';`memory` 覆盖 navigator.deviceMemory */
async function newPage(device = 'desktop', { memory } = {}) {
  let page;
  if (device === 'ipad') {
    page = await env.newPage(browser, 'none');
    await page.setViewport(IPAD.viewport);
    await page.cdp.send('Emulation.setUserAgentOverride', { userAgent: IPAD.ua });
    await page.cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  } else {
    page = await env.newPage(browser, device);
  }
  // 气泡只显示几秒:从文档一开始就记下它出现过的文字(进项目、等闸门走完这段时间里它可能已经出过又撤了)
  await page.evaluateOnNewDocument(() => {
    if (window.top !== window) return;
    window.__sgBubbles = [];
    const seen = () => { const t = document.querySelector('[data-pc="tier-bubble"]')?.textContent; if (t && window.__sgBubbles.at(-1) !== t) window.__sgBubbles.push(t); };
    new MutationObserver(seen).observe(document, { childList: true, subtree: true, characterData: true });
  });
  if (memory !== undefined) await page.evaluateOnNewDocument((m) => { try { Object.defineProperty(Navigator.prototype, 'deviceMemory', { get: () => m, configurable: true }); } catch { /* 改不了 */ } }, memory);
  return page;
}
const gates = (page) => page.evaluate(() => (typeof window.__pcGates === 'function' ? window.__pcGates() : null)).catch(() => null);
const waitDone = async (page, ms = 90_000) => {
  const g = await until(async () => { const x = await gates(page); return x?.tier?.online && x.tier.gate === 'done' && x.step?.kind === 'running' ? x : null; }, ms);
  if (!g) say('Timed out waiting for the gates to finish', { url: page.url(), gates: await gates(page) });
  return g;
};
const bubbleText = (page, ms = 30_000) => until(() => page.evaluate(() => document.querySelector('[data-pc="tier-bubble"]')?.textContent ?? window.__sgBubbles?.at(-1) ?? null).catch(() => null), ms, 100);
async function enter(page, query = '') {
  await env.enter(page, { layout: 'desktop' });
  if (query) await page.goto(`${env.origin}/editor?layout=desktop&${query}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
}
async function reload(page, query) {
  const url = `${env.origin}/editor?layout=desktop${query ? `&${query}` : ''}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });
}
/** 真的把页面(顶层文档)的渲染进程杀掉;回之后用新的 CDP 会话 */
async function crashPage(page) {
  const crashed = new Promise((resolve) => { page.once('error', () => resolve(true)); setTimeout(() => resolve(false), 15_000); });
  const cdp = await page.createCDPSession();
  // `Page.crash` 不回包(渲染进程当场没了):不等它,等页面的「Page crashed!」事件
  void cdp.send('Page.crash').catch(() => {});
  const ok = await crashed;
  if (!ok) fails.push('No page crash event within 15 seconds after Page.crash');
  return ok;
}
/** 崩了之后用户点「重新加载」(同一个标签页) */
async function reloadAfterCrash(page, query) {
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 120_000 }).catch(async () => { await reload(page, query); });
}
const tabStep = (g) => g?.step;
/** CPU 降速:页面与两个舞台(跨源舞台是另外的渲染进程,各自要设) */
async function throttleAll(page, rate) {
  await page.cdp?.send('Emulation.setCPUThrottlingRate', { rate }).catch(() => {});
  for (const t of browser.targets()) {
    if (!t.url().includes(`:${BASE + 1}/`) && !t.url().includes(`:${BASE + 2}/`)) continue;
    const c = await t.createCDPSession().catch(() => null);
    await c?.send('Emulation.setCPUThrottlingRate', { rate }).catch(() => {});
  }
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
const want = (id) => !ONLY.length || ONLY.includes(id);
const TEXT = {
  top: 'This device is running in top-spec mode', standard: 'This device is running in standard mode',
  lite: 'This device is running in lite mode: complex effects are handed to cloud rendering', low: 'This device is running in low-spec mode: playback only shows frames that are already rendered',
};
async function holdAndCrash(scene, page, what) {
  await reload(page, `gateHold=${what}`);
  const reached = await until(async () => { const g = await gates(page); return g?.step?.kind === 'stage' && g.step.what === what ? g : null; }, 90_000, 50);
  check(scene, !!reached, `stopped at the "${what}" step (gateHold)`, await gates(page));
  await crashPage(page);
  await reloadAfterCrash(page, `gateHold=${what}`);
}

try {
  /* ---------------------------------------------------------------- S1～S5:电脑 */
  if (want('S1') || want('S2') || want('S3') || want('S4') || want('S5')) {
    const page = await newPage('desktop');
    await enter(page);
    let g = await waitDone(page);
    check('S1', g?.tier?.reached === 3 && g.tier.target === 3 && !g.tier.lowest, 'Fresh open: reaches level 3', g?.tier);
    check('S1', g?.decision?.reason === 'trial', 'try from low to high', g?.decision);
    check('S1', g?.judged?.crashed === false, 'not judged as crashed');
    check('S1', tabStep(g)?.kind === 'running' && tabStep(g).level === 3, 'the last step is level 3 running', tabStep(g));
    const steps = (g?.log?.history ?? []).length;
    check('S1', steps >= 1, 'the inspection port lists each past judgment');
    const b1 = await bubbleText(page);
    check('S1', b1 === TEXT.top, 'Bubble: top-spec mode', b1);
    await shot(page, 'S1-bubble');
    const gone = await until(() => page.$('[data-pc="tier-bubble"]').then((e) => !e), 15_000, 200);
    check('S1', !!gone, 'the bubble disappears on its own after a few seconds');
    const iframes = await page.$$eval('iframe[data-pc^="stage-frame"]', (els) => els.map((e) => ({ pc: e.dataset.pc, src: e.getAttribute('src') })));
    check('S1', iframes.length === 2 && iframes.every((f) => /[?&]gl=shared/.test(f.src)), 'two stages; the URL is built from the starting route (shared) and does not change because level 3 is tried', iframes);
    scenes.S1.tier = g?.tier;
    // 即时渲染闸门的基准卡、素材闸门的解码上限(第四步):测完了,结论进查看口
    const gb = await until(async () => { const x = await gates(page); return x?.tier?.benchmark !== 'pending' ? x : null; }, 60_000);
    check('S1', gb?.tier?.benchmark === 'ok' && typeof gb.benchmark?.stepMs === 'number', 'the baseline card was measured and runs', gb?.benchmark);
    check('S1', typeof gb?.media?.decode?.maxPixels === 'number', 'the decode limit was measured once on open', gb?.media?.decode);
    scenes.S1.benchmark = gb?.benchmark;
    scenes.S1.decode = gb?.media?.decode;

    // S2 正常刷新
    await reload(page);
    g = await waitDone(page);
    check('S2', g?.judged?.crashed === false, 'a normal refresh is not counted as a crash', g?.judged);
    check('S2', g?.log?.device?.stage?.crashes === 0, 'crash count 0', g?.log?.device?.stage);
    check('S2', g?.tier?.reached === 3, 'still reaches level 3');

    // S3 试各一套时杀掉
    await holdAndCrash('S3', page, 'try-separate');
    g = await waitDone(page);
    check('S3', g?.judged?.crashed === true && g.judged.step?.what === 'try-separate', 'judged as crashed, crashed while trying separate sets', g?.judged);
    check('S3', g?.decision?.reason === 'crash' && g.tier.target === 2 && g.tier.reached === 2, 'stops at level 2, no trial', g?.tier);
    const st = g?.log?.device?.stage;
    check('S3', st?.crashes === 1 && st.guardUntil && Math.abs(st.guardUntil - Date.now() - 30 * 60_000) < 120_000, '1 crash, guard for 30 minutes', st);
    const b3 = await bubbleText(page);
    check('S3', b3 === TEXT.standard, 'Bubble: standard mode', b3);
    await shot(page, 'S3-standard');
    scenes.S3.sessionKept = g?.judged?.fromTab === g?.tab ? 'same-tab' : 'other-tab';

    // S4 护栏内
    await reload(page);
    g = await waitDone(page);
    check('S4', g?.decision?.reason === 'guard' && g.tier.target === 2, 'Within the guard: stops at level 2, no trial', g?.decision);

    // S5 过了护栏:从头试;试成功再刷新清零
    await page.evaluate(() => { const k = 'pc.online.crashLog'; const l = JSON.parse(localStorage.getItem(k)); l.device.stage.guardUntil = Date.now() - 1000; localStorage.setItem(k, JSON.stringify(l)); });
    await reload(page);
    g = await waitDone(page);
    check('S5', g?.decision?.reason === 'trial' && g.tier.reached === 3, 'Past the guard: tries from the start up to level 3', g?.decision);
    check('S5', g?.log?.device?.stage?.crashes === 1, 'the crash count is still there at this point (a trial counts as successful when the next load is not judged as crashed)');
    await reload(page);
    g = await waitDone(page);
    check('S5', g?.log?.device?.stage?.crashes === 0 && g.log.device.stage.guardUntil === null, 'one successful trial: reset to zero', g?.log?.device?.stage);

    // S9 升级清零(先造一条崩过、有护栏的记录)
    if (want('S9') || !ONLY.length) {
      await page.evaluate(() => { const k = 'pc.online.crashLog'; const l = JSON.parse(localStorage.getItem(k)); l.device.stage = { reached: 1, lowest: false, crashes: 3, guardUntil: Date.now() + 3600_000, tried: false }; l.device.version = 'older-build'; localStorage.setItem(k, JSON.stringify(l)); });
      await reload(page);
      g = await waitDone(page);
      check('S9', g?.decision?.reason === 'trial' && g.log.device.stage.crashes <= 0 && g.tier.reached === 3, 'software version changed: reset to zero, try from the start', g?.decision);
    }
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S6 试后台舞台时杀掉 */
  if (want('S6')) {
    const page = await newPage('desktop');
    await enter(page);
    await waitDone(page);
    await holdAndCrash('S6', page, 'try-back');
    const g = await waitDone(page);
    check('S6', g?.judged?.crashed && g.tier.target === 1 && !g.tier.lowest, 'stops at level 1 (lite)', g?.tier);
    const frames = await page.$$eval('iframe[data-pc^="stage-frame"]', (els) => els.map((e) => e.dataset.pc));
    check('S6', frames.length === 1, 'only one stage', frames);
    const b = await bubbleText(page);
    check('S6', b === TEXT.lite, 'Bubble: lite mode', b);
    await shot(page, 'S6-lite');
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S7 开可见舞台时杀掉 */
  if (want('S7')) {
    const page = await newPage('desktop');
    await enter(page);
    await waitDone(page);
    await holdAndCrash('S7', page, 'open-visible');
    const g = await waitDone(page);
    check('S7', g?.judged?.crashed && g.tier.lowest === 'stage' && g.tier.target === 1, 'lowest tier (not even one stage holds up)', g?.tier);
    const src = await page.$eval('iframe[data-pc="stage-frame"]', (e) => e.getAttribute('src')).catch(() => '');
    check('S7', /[?&]lowest=1/.test(src) && /[?&]compact=1/.test(src), 'the stage starts at the lowest tier from the beginning (media uses only the small size)', src);
    const b = await bubbleText(page);
    check('S7', b === TEXT.low, 'Bubble: low-spec mode', b);
    await shot(page, 'S7-low');
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S8 在后台被回收不算崩 */
  if (want('S8')) {
    const page = await newPage('desktop');
    await enter(page);
    await waitDone(page);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { get: () => 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await sleep(300);
    const g0 = await gates(page);
    const mine = g0?.log?.tabs?.[g0.tab];
    check('S8', mine?.background === true, 'recorded that it was in the background', mine);
    await crashPage(page);
    await reloadAfterCrash(page);
    const g = await waitDone(page);
    check('S8', g?.judged?.crashed === false && g.decision.reason === 'trial', 'reclaimed in the background: not counted as a crash', g?.judged);
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S10 安卓 */
  if (want('S10')) {
    for (const [mem, expect] of [[4, 'fixed'], [8, 'trial']]) {
      const page = await newPage('phone', { memory: mem });
      await enter(page);
      const g = await waitDone(page);
      if (expect === 'fixed') {
        check('S10', g?.decision?.reason === 'android-memory' && g.tier.target === 1, `Android ${mem} GB: stops at one stage, no trial`, g?.decision);
        check('S10', g?.tier?.identity === 'phone', 'identity is phone');
        const b = await bubbleText(page);
        check('S10', b === TEXT.lite, 'Bubble: lite mode', b);
        await shot(page, 'S10-android-4g');
      } else {
        check('S10', g?.decision?.reason === 'trial', `Android ${mem} GB: trial`, g?.decision);
      }
      await page.browserContext().close();
    }
  }

  /* ---------------------------------------------------------------- S11 电脑上只杀后台舞台的进程 */
  if (want('S11')) {
    const page = await newPage('desktop');
    await enter(page);
    let g = await waitDone(page);
    const before = g?.tier?.reached;
    const stageBTarget = () => browser.targets().find((t) => t.url().includes(`:${BASE + 2}/`) && /[?&]id=B/.test(t.url()));
    const crashB = async () => {
      const t = await until(() => stageBTarget(), 30_000, 200);
      if (!t) return false;
      const cdp = await t.createCDPSession().catch(() => null);
      void cdp?.send('Page.crash').catch(() => {});
      return true;
    };
    check('S11', !!stageBTarget(), 'the background stage is a separate render process (OOPIF target)');
    // 第一次崩:看守整页重载那一台,握回来恢复双舞台(原有做法);页面与档位都不受影响、不留崩溃记录
    await crashB();
    const watch1 = await until(() => page.evaluate(() => window.__pcStageWatch?.()).then((w) => (w && w.reloads >= 1 ? w : null)), 90_000, 500);
    check('S11', !!watch1, 'the stage crashed but the page is still there: the watcher reloads that stage', watch1);
    g = await until(async () => { const x = await gates(page); return x?.tier?.reached === 3 ? x : null; }, 60_000, 500);
    check('S11', g?.tier?.target === 3 && g.step?.kind === 'running' && g.step.level === 3, 'after reloading that stage it is still level 3, the crash record is untouched', g?.step);
    // 反复崩(看守重载到上限):握手容错退回单舞台,只管当次
    for (let i = 0; i < 4; i++) {
      const w = await page.evaluate(() => window.__pcStageWatch?.()).catch(() => null);
      if (w?.fellBack) break;
      await until(() => page.evaluate(() => { const x = window.__pcStageWatch?.(); return x && x.B === 'ok' ? x : null; }), 60_000, 500);
      await crashB();
      await until(() => page.evaluate((n) => { const x = window.__pcStageWatch?.(); return x && (x.reloads > n || x.fellBack) ? x : null; }, (w?.reloads ?? 0)), 90_000, 500);
    }
    g = await until(async () => { const x = await gates(page); return x?.tier?.target === 1 ? x : null; }, 120_000, 500);
    check('S11', !!g && g.tier.reached === 1, `Repeated crashes: handshake fault tolerance falls back to a single stage (previously level ${before})`, g?.tier ?? await gates(page));
    check('S11', g?.step?.kind === 'running' && g.step.level === 1, 'current attempt only: the last step is level 1 running, with no "crashed while trying…" left behind', g?.step);
    await reload(page);
    g = await waitDone(page);
    check('S11', g?.judged?.crashed === false && g.decision.reason === 'trial' && g.tier.reached === 3, 'reloading tries as usual, not counted as a crash', g?.decision);
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S12 iPad */
  if (want('S12')) {
    const page = await newPage('ipad');
    await enter(page);
    let g = await waitDone(page);
    check('S12', g?.tier?.identity === 'desktop', 'iPad gets a trial: treated as a desktop first', g?.tier);
    await holdAndCrash('S12', page, 'try-back');
    g = await waitDone(page);
    check('S12', g?.tier?.target === 1 && g.tier.identity === 'phone', 'iPad stops at level 1: identity reclassified as phone', g?.tier);
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S13 两个标签页 */
  if (want('S13')) {
    const page = await newPage('desktop');
    await enter(page);
    await waitDone(page);
    const second = await page.browserContext().newPage();
    await second.setViewport(DEVICES.desktop.viewport);
    await second.goto(`${env.origin}/editor?layout=desktop`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
    // 新标签页没有会话恢复记录:停在开始页也照样开舞台闸门吗?闸门只在编辑页挂,这里直接读崩溃记录
    await sleep(3000);
    const log = await second.evaluate(() => JSON.parse(localStorage.getItem('pc.online.crashLog') || 'null'));
    const last = log?.history?.at(-1);
    check('S13', log && last && last.crashed === false, 'second tab: the first one that is still open is not counted as crashed', last);
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S14 查看口 */
  if (want('S14')) {
    const page = await newPage('desktop');
    await enter(page);
    await reload(page, 'gates=1');
    await waitDone(page);
    const rows = await until(() => page.$$eval('[data-pc="gate-viewer"] td[data-pc-gate-row]', (els) => els.map((e) => [e.dataset.pcGateRow, e.textContent])), 30_000);
    check('S14', rows && rows.length >= 8, 'the inspection port has the results of each gate', rows);
    const json = await page.evaluate(() => JSON.stringify(window.__pcGates()));
    check('S14', !/ticket|password|token|"key":"[A-Za-z0-9_-]{43}"/i.test(json), 'the inspection port contains no credentials', json.slice(0, 200));
    await shot(page, 'S14-viewer');
    await page.browserContext().close();
  }
  /* ---------------------------------------------------------------- S15 最低一档:播放不即时渲染,停下逐层画 */
  if (want('S15')) {
    const page = await newPage('desktop');
    await enter(page);
    await reload(page, 'tier=low');
    const g = await waitDone(page);
    check('S15', g?.tier?.lowest === 'stage' && g.decision.reason === 'forced', 'forced lowest tier', g?.tier);
    await until(() => page.evaluate(() => !!window.__pcStore && !!window.__pcPreviewDiag), 30_000);
    await page.evaluate(() => { window.__pcStore.actions.seek(1); window.__pcStore.actions.play(); });
    const playing = await until(() => page.evaluate(() => { const d = window.__pcPreviewDiag(); return window.__pcStore.getState().playing && d.suppressed.includes('pill-1') ? d : null; }), 20_000, 100);
    check('S15', !!playing, 'cards are suppressed during playback (no on-demand render; show the prerender output, or a placeholder if there is none)', await page.evaluate(() => window.__pcPreviewDiag().suppressed));
    await sleep(800);
    await page.evaluate(() => window.__pcStore.actions.pause());
    const settled = await until(() => page.evaluate(() => { const r = window.__pcPreviewDiag().lastSettle; return r && r.ok && r.drawn.some((x) => x.clipId === 'pill-1') ? r : null; }), 60_000, 200);
    check('S15', !!settled && settled.timeoutMs === null, 'after stopping, catch up one frame layer by layer until it is painted, no time limit', settled ?? await page.evaluate(() => window.__pcPreviewDiag().lastSettle));
    // 画好的那一层看得见、里面有内容(不在 .pc-settling 下、没被抑制、不是空包裹)
    const look = await until(async () => {
      const f = page.frames().find((x) => /[?&]stage=1/.test(x.url()));
      const v = f ? await f.evaluate(() => {
        const w = document.querySelector('[data-pc-clip="pill-1"]:not([data-pc-media])');
        if (!w) return null;
        const r = w.getBoundingClientRect();
        const cs = getComputedStyle(w);
        const hiddenUp = !!w.closest('.pc-settling') || !!w.closest('.pc-suppressed');
        const text = (w.textContent ?? '').trim().slice(0, 40);
        return { cls: w.className, hiddenUp, visibility: cs.visibility, opacity: cs.opacity, kids: w.querySelectorAll('*').length, text, w: Math.round(r.width), h: Math.round(r.height) };
      }).catch(() => null) : null;
      return v && !v.hiddenUp && v.visibility === 'visible' && v.kids > 2 && v.text ? v : null;
    }, 20_000, 200);
    scenes.S15 = { ...(scenes.S15 ?? { checks: 0, failed: 0 }), look };
    check('S15', !!look, 'after stopping, the layer that was painted is visible and has content', look);
    await shot(page, 'S15-low-settled');
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S16 基准卡跑不动 */
  if (want('S16')) {
    const page = await newPage('desktop');
    await enter(page);
    await waitDone(page);
    // 舞台闸门停在「各一套渲染器就绪」那一步,给两个舞台降速 30 倍,再放行:走完之后测基准卡
    await reload(page, 'gateHold=separate-ready');
    await until(async () => { const x = await gates(page); return x?.step?.kind === 'stage' && x.step.what === 'separate-ready' ? x : null; }, 90_000, 100);
    await throttleAll(page, 30);
    await page.evaluate(() => window.__pcGateRelease?.());
    const g = await until(async () => { const x = await gates(page); return x?.tier?.benchmark && x.tier.benchmark !== 'pending' ? x : null; }, 240_000, 500);
    await throttleAll(page, 1);
    scenes.S16 = { ...(scenes.S16 ?? { checks: 0, failed: 0 }), benchmark: g?.benchmark, tier: g?.tier, step: (await gates(page))?.step, driverError: (await gates(page))?.driverError };
    check('S16', g?.tier?.benchmark === 'slow' && g.tier.lowest === 'benchmark', 'the baseline card cannot run: lowest tier', g?.benchmark);
    const b = await bubbleText(page, 30_000);
    check('S16', b === TEXT.low, 'Bubble: low-spec mode', b);
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S17 测某张卡时杀掉 */
  if (want('S17')) {
    const page = await newPage('desktop');
    await page.cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    await enter(page);
    const measuring = await until(async () => { const x = await gates(page); return x?.step?.kind === 'measure' && x.step.key !== '@benchmark' ? x : null; }, 120_000, 30);
    check('S17', !!measuring, 'waits until a card is being measured (resident probe)', await gates(page));
    if (measuring) {
      const mine = measuring.log?.tabs?.[measuring.tab];
      say('S17 measuring card', { key: measuring.step.key, alive: mine?.alive, now: Date.now() });
      const t0 = Date.now();
      const ok = await crashPage(page);
      say('S17 kill page', { ok, ms: Date.now() - t0 });
      // 崩了之后的新渲染进程不带降速(旧的 CDP 会话已经断了,不再发)
      const t1 = Date.now();
      await reloadAfterCrash(page);
      say('S17 reload', { ms: Date.now() - t1, sinceMeasure: Date.now() - t0 });
      const g = await waitDone(page);
      const key = measuring.step.key;
      check('S17', g?.judged?.crashed && g.judged.step?.kind === 'measure' && g.log.device.heavyCards.includes(key), 'this card is recorded as a card that crashed when measured', { judged: g?.judged, device: g?.log?.device, history: g?.log?.history });
      check('S17', g?.decision?.reason === 'trial', 'not counted as a stage crash: the stage is tried as usual', g?.decision);
      await sleep(8000);
      const after = await page.evaluate((k) => ({ probed: window.__pcPreviewDiag().probeRun, heavy: window.__pcGates().log.device.heavyCards.includes(k) }), key);
      const probedAgain = JSON.stringify(after.probed ?? '').includes(key);
      check('S17', !probedAgain, 'it is not measured again', after.probed);
      const heavy = await page.evaluate(() => [...(window.__pcPlanDebug?.()?.prerenderSet ?? [])]).catch(() => null);
      scenes.S17.heavyPlan = heavy;
    }
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S18 载入原尺寸时杀掉 */
  if (want('S18')) {
    const page = await newPage('desktop');
    await enter(page);
    let g = await until(async () => { const x = await gates(page); return x?.step?.kind === 'media' ? x : null; }, 60_000, 50);
    check('S18', !!g, 'a record was left before loading the original size ("Load media original size")', await gates(page));
    const before = g?.media?.decode;
    await crashPage(page);
    await reloadAfterCrash(page);
    g = await waitDone(page);
    const decode = await until(async () => (await gates(page))?.media?.decode, 30_000);
    check('S18', g?.judged?.step?.kind === 'media' && g.log.device.media.lowered === 1, 'judged as crashed at loading the original size, the decode limit is lowered by one step', g?.log?.device);
    check('S18', decode && before && decode.index === Math.min(4, before.measured + 1), 'the effective limit is one step lower', { before, decode });
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S19 仿弱设备的解码上限 */
  if (want('S19')) {
    const page = await newPage('desktop');
    await page.evaluateOnNewDocument(() => {
      if (window.top !== window) return;
      const mc = navigator.mediaCapabilities;
      if (!mc) return;
      mc.decodingInfo = async (cfg) => ({ supported: true, smooth: (cfg?.video?.width ?? 0) <= 1280, powerEfficient: true });
    });
    await enter(page);
    const decode = await until(async () => (await gates(page))?.media?.decode, 30_000);
    check('S19', decode?.name === '720p' && decode.maxPixels === 1280 * 720, 'decode limit 720p', decode);
    const sig = await page.evaluate(() => window.__pcGates().step);
    scenes.S19.step = sig;
    await page.browserContext().close();
  }

  /* ---------------------------------------------------------------- S20 有记录时二分只测几张 */
  if (want('S20')) {
    // 先由一台单舞台的页面测一遍、写进文档服务(界限搜索没记录时逐张实测,测完都写)
    const a = await newPage('desktop');
    await enter(a);
    await reload(a, 'tier=lite');
    await waitDone(a);
    const searched = await until(() => a.evaluate(() => { const x = window.__pcCostSearch?.(); return x?.outcome ? x : null; }), 120_000, 500);
    check('S20', !!searched && searched.outcome.measured.some((m) => !m.cached), 'single stage: cards without a record are measured one by one', searched?.outcome);
    await sleep(3000);
    await a.browserContext().close();
    // 再开一个新的上下文(另一台设备),两个舞台:读到了记录 → 界限搜索在后台舞台里只测几张;之后常驻探针在后台补测
    const b = await newPage('desktop');
    await enter(b);
    await waitDone(b);
    const ds = await until(() => b.evaluate(() => window.__pcDualSearch?.() ?? null), 120_000, 500);
    check('S20', !!ds && ds.records >= 1 && ds.measurements <= ds.keys.length + 4, 'two stages, with records: bounds search draws the line (only a few cards measured)', ds);
    const settled = await until(() => b.evaluate(() => { const d = window.__pcPreviewDiag?.(); return d && d.probeRun && !d.probeRun.running && d.probeRun.done >= 1 ? d.probeRun : null; }), 120_000, 500);
    check('S20', !!settled, 'the resident probe then finishes the remaining measurements in the background', settled);
    scenes.S20.dual = ds;
    await b.browserContext().close();
  }

} catch (e) {
  fails.push(`Exception: ${String(e?.stack ?? e).slice(0, 800)}`);
} finally {
  await browser.close().catch(() => {});
  await env.close().catch(() => {});
}

const result = { ok: fails.length === 0, fails, scenes, out: OUT };
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exit(fails.length ? 1 : 0);
