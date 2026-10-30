/**
 * E1 验收:两个舞台 iframe 真的落在**自己的渲染进程**里(R2)。
 *
 *   node scripts/probes/stage-isolation-probe.mjs [--origin http://127.0.0.1:5211] [--repeats 3]
 *
 * 不带 `--origin` 就看 `PC_STAGE_TEST_URL`,再没有就打 `.claude/launch.json` 的 `dev-test`。
 *
 * 判两条(照 `scripts/probes/oac-probe.mjs` 的做法):
 *   1. CDP `Target.getTargets` 里有**两个** `type: 'iframe'` 的 target —— 有 target 才说明
 *      它是 out-of-process iframe。`window.originAgentCluster` **恒回 true,不能当判据**;
 *   2. 让 A 舞台的主线程死循环 2.5 秒,量编辑器主文档最坏的 rAF 间隔:**< 20 ms**。
 *      同一个进程的话这个数会是两千多毫秒(实测,见 `docs/archive/restructure_planning/g0-a-webview2-probe.md`)。
 *
 * 这张页就是真的编辑台(`?editor&preview=stage`),量的也是真的主文档 —— pinned 渲染 1
 * 说的「用户交互不允许有任何卡顿」讲的就是它。
 *
 * 死循环用 `window.__pcRealNow()` 计时:舞台文档里的 `performance.now` 被 stageClock 换成了
 * 虚拟时钟(恒等于当前帧的时刻),拿它写 while 循环会**永远转下去**。
 *
 * 多个 Agent 同时在跑时耗时不可信,默认跑 3 遍报中位数。
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg, listTargets, devOrigin } from './probe-connect.mjs';

const origin = devOrigin();
const REPEATS = Number(flagArg('repeats', '3'));
const BLOCK_MS = 2500;

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); return cond; };
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/*
 * **必须关掉帧率限制**。这台机器上(以及任何没有真显示器在刷的会话里)Chrome 的 BeginFrame
 * 退到 10 Hz:实测连 `about:blank` 的 rAF 间隔中位数都是 100.4 ms,最坏 100.9 ms ——
 * 那时量到的是显示节拍,不是卡顿,`< 20 ms` 这条**在任何实现下都不可能成立**。
 * 加上 `--disable-gpu-vsync --disable-frame-rate-limit` 之后 rAF 不再等垂直同步,
 * 间隔就等于主线程两次让出之间的时间 —— 正是「父页有没有被舞台卡住」要问的那个量。
 * 对照:同样的开关下空白页最坏 1.3 ms、不卡舞台的编辑台最坏 3～6 ms。
 */
const browser = await puppeteer.launch({
  headless: false,
  args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--window-size=900,600', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--disable-gpu-vsync', '--disable-frame-rate-limit',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'],
});
const out = { origin, repeats: REPEATS, blockMs: BLOCK_MS, rounds: [] };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(origin + '/?editor&preview=stage', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return m.backRole() === 'back';
  }, { timeout: 120000, polling: 500 });

  const targets = await listTargets(browser);
  const iframeTargets = targets.filter((t) => t.type === 'iframe').map((t) => t.url);
  out.iframeTargets = iframeTargets;
  check(iframeTargets.length === 2, 'two out-of-process iframe targets in CDP Target.getTargets', iframeTargets);
  // 对照:originAgentCluster 恒回 true,记下来提醒后来人别拿它当判据
  out.originAgentClusterSaysTrue = await Promise.all(
    page.frames().filter((f) => f.url().includes('stage=1')).map((f) => f.evaluate(() => window.originAgentCluster).catch(() => 'n/a')),
  );

  const frameA = page.frames().find((f) => f.url().includes('id=A'));
  check(!!frameA, 'stage A frame handle');

  /** 一轮测量:量父页 `ms + 800` 毫秒里最坏的 rAF 间隔 */
  const measureParent = (ms) => page.evaluate((ms) => new Promise((res) => {
    const gaps = [];
    let last = performance.now();
    const t0 = last;
    (function loop() {
      const now = performance.now();
      gaps.push(now - last);
      last = now;
      if (now - t0 > ms + 800) res({ worst: Math.max(...gaps), frames: gaps.length });
      else requestAnimationFrame(loop);
    })();
  }), ms);

  // 对照组:谁都不卡的时候父页本来是什么样。判据用的是同一个量,基线摆出来才知道 20 ms 是宽是严
  out.baseline = await measureParent(BLOCK_MS);
  out.baseline.worst = Math.round(out.baseline.worst * 10) / 10;

  for (let i = 0; i < REPEATS; i++) {
    // 父页先开始量,再让 A 卡住;两边都用真墙钟
    const measuring = measureParent(BLOCK_MS);
    await new Promise((r) => setTimeout(r, 150));
    const blocking = frameA.evaluate((ms) => {
      const now = window.__pcRealNow ?? (() => Date.now());
      const t0 = now();
      const end = t0 + ms;
      while (now() < end) { /* 把这个渲染进程的主线程占满 */ }
      return now() - t0;
    }, BLOCK_MS).catch((e) => String(e));
    const [m, blocked] = await Promise.all([measuring, blocking]);
    // 死循环没真跑起来的话,下面那个「父页没被卡住」就是白量的
    check(typeof blocked === 'number' && blocked >= BLOCK_MS, `stage A really blocked for ${BLOCK_MS} ms`, blocked);
    out.rounds.push({ ...m, blockedMs: typeof blocked === 'number' ? Math.round(blocked) : blocked });
  }
  out.parentWorstRafMs = out.rounds.map((r) => Math.round(r.worst * 10) / 10);
  out.medianWorstRafMs = median(out.parentWorstRafMs);
  check(out.medianWorstRafMs < 20, `parent worst rAF gap < 20 ms while stage A blocks ${BLOCK_MS} ms`, out.parentWorstRafMs);
  out.errors = errors.filter((e) => !/favicon|Download the React DevTools|Failed to load resource/i.test(e));
  check(out.errors.length === 0, 'no page errors', out.errors.slice(0, 5));
} catch (err) {
  fails.push('exception: ' + (err && err.stack || err));
} finally {
  await browser.close();
}
out.fails = fails;
console.log(JSON.stringify(out, null, 2));
process.exit(fails.length ? 1 : 0);
