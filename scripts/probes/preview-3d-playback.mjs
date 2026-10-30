/**
 * 3D 页播放(回归探针):真的打开编辑台,在 3D 页按播放,看播放头是不是照常跟着舞台走。
 *
 *   node scripts/probes/preview-3d-playback.mjs [--origin http://127.0.0.1:5230]
 *
 * 不带 `--origin` 就看 `PC_STAGE_TEST_URL`,再没有就打 `.claude/launch.json` 的 `dev-test`。
 * 只验缺省的跨源双舞台(K4:播放头由可见舞台的 `frame` 推);页面退回单舞台时直接判失败并说明。
 *
 * 钉的是这几件事(排障过程见 fix 提交说明):
 *
 *   1. **3D 页按播放,t 往前走、声音层还在。** 以前切到 3D 会把 2D 子树连同两个舞台 iframe 一起卸掉,
 *      `frontStage()` 交出一个指向已关窗口的客户端,`play()` 永不回包,播放头停在原地、按钮却显示「暂停」。
 *      同时看 3D 画布没有被藏起来的 2D 页挡住(它们叠在同一块地方)。
 *   2. **播放中来回切 2D / 3D,播放不断。** 舞台不再随切页重建,t 一直往前。
 *   3. **带着 `playing` 换一个舞台渲染面(这里用重载可见舞台 iframe 模拟),播放自己接上。**
 *      以前新舞台先收到 `play`、后收到项目,回 `no-project`,父页不重试 —— 画面永远不动。
 *   4. **舞台拒绝起播时界面退回暂停。** 让可见舞台临时顶着 `back` 角色,按播放必回 `{ ok: false }`;
 *      store 的 `playing` 要翻回 false,不能停在「在播」。
 *   5. **RPC 发给已经拿出 DOM 的 iframe 会被回绝,不会永远挂着**(真 Chrome 的 WindowProxy,
 *      单测里用的是替身)。
 *
 * 和 editor-preview-smoke 一样,每一趟先 `newProject` 起空项目,卡片参数带本趟标记,
 * 免得同一台 server 上前几趟留下的成本记录(`out/card-costs.json`)串进来。
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { devOrigin } from './probe-connect.mjs';

const args = process.argv.slice(2);
const origin = devOrigin(args);
const runTag = Date.now().toString(36);
const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
const out = { origin, runTag };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(origin + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 120000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage() && m.backRole() === 'back';
  }, { timeout: 120000, polling: 500 }).catch(() => {});
  const dual = await page.evaluate(() => document.querySelectorAll('iframe[data-pc^="stage-frame"]').length === 2);
  if (!check(dual, 'the editor runs the default cross-origin dual stage (this probe only covers K4 playback)')) throw new Error('not dual stage');

  // 父页这一侧:数 `frame` 事件(K4 每拍一条),以及读播放头
  await page.evaluate(() => {
    window.__p3d = { frames: 0, marker: 1 };
    window.addEventListener('message', (e) => { if (e.data && e.data.type === 'frame') window.__p3d.frames++; });
  });
  const head = () => page.evaluate(async () => {
    const { getState } = await import('/src/store/project.ts');
    return { t: getState().t, playing: getState().playing, frames: window.__p3d.frames };
  });
  const tab = (label) => page.evaluate((label) => {
    [...document.querySelectorAll('[data-pc="preview-tabs"] button')].find((b) => b.textContent === label).click();
  }, label);
  const clickPlay = () => page.click('.pc-pv-btn--play');
  /** 等播放器自己停稳(暂停收尾是异步 RPC),免得下一段从一个还在走的播放头开始 */
  const waitStopped = async () => {
    const deadline = Date.now() + 5000;
    let prev = null;
    while (Date.now() < deadline) {
      const h = await head();
      if (!h.playing && prev && prev.t === h.t) return h;
      prev = h;
      await sleep(200);
    }
    return head();
  };
  const pauseIfPlaying = async () => { if ((await head()).playing) await clickPlay(); return waitStopped(); };

  const ids = await page.evaluate(async (runTag) => {
    const { actions, getState } = await import('/src/store/project.ts');
    actions.newProject('3d-playback');
    const a = actions.addCardClip('scene-3d', 0, { duration: 8 });
    const b = actions.addCardClip('punch-pill', 0, { duration: 8, params: { text: `3D 播放 ${runTag}` } });
    actions.seek(0);
    return { scene: a?.id, pill: b?.id, clips: getState().project.tracks.reduce((n, t) => n + t.clips.length, 0) };
  }, runTag);
  out.ids = ids;
  check(ids.scene && ids.pill && ids.clips === 2, 'the run starts from an empty project with its own scene-3d + 2D card', ids);
  await sleep(1500);

  /* ── 1. 3D 页按播放 ─────────────────────────────────────────── */
  await tab('3D');
  await page.waitForSelector('.pc-3d-checker canvas', { timeout: 30000 });
  await sleep(800);
  const in3d = await page.evaluate(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    const c = m.frontStage();
    const cv = document.querySelector('.pc-3d-checker canvas').getBoundingClientRect();
    const top = document.elementFromPoint(cv.left + cv.width / 2, cv.top + cv.height / 2);
    const twoD = document.querySelector('[data-pc="preview-2d"]');
    return {
      stageFrames: document.querySelectorAll('iframe[data-pc^="stage-frame"]').length,
      front: c ? { disposed: c.disposed, closed: c.target.closed } : null,
      topIsCanvas: top?.tagName === 'CANVAS' && !!top.closest('.pc-3d-checker'),
      twoD: twoD ? { opacity: getComputedStyle(twoD).opacity, pointerEvents: getComputedStyle(twoD).pointerEvents, inert: twoD.inert } : null,
    };
  });
  out.in3d = in3d;
  check(in3d.stageFrames === 2, '3D page keeps both stage iframes mounted', in3d);
  check(in3d.front && !in3d.front.disposed && !in3d.front.closed, 'frontStage() on the 3D page is a live client (not a closed window)', in3d.front);
  check(in3d.topIsCanvas, 'the hidden 2D page does not cover the 3D canvas (it gets the pointer)', in3d);
  check(in3d.twoD && in3d.twoD.opacity === '0' && in3d.twoD.pointerEvents === 'none' && in3d.twoD.inert, '2D page is hidden with opacity 0 / pointer-events none / inert, not unmounted', in3d.twoD);

  const p1a = await head();
  await clickPlay();
  await sleep(1500);
  const p1b = await head();
  out.play3d = { before: p1a, after: p1b };
  check(p1b.playing && p1b.t - p1a.t > 0.8, 'pressing play on the 3D page advances the playhead (~1.5 s of playback)', out.play3d);
  check(p1b.frames - p1a.frames > 20, 'the visible stage keeps posting frame beats while the 3D page is shown', out.play3d);
  out.play3dStopped = await pauseIfPlaying();
  check(!out.play3dStopped.playing, 'pause on the 3D page stops playback', out.play3dStopped);

  /* ── 2. 播放中来回切页 ──────────────────────────────────────── */
  await tab('2D');
  await page.evaluate(async () => { (await import('/src/store/project.ts')).actions.seek(0.2); });
  await sleep(500);
  await clickPlay();
  await sleep(600);
  const s0 = await head();
  await tab('3D');
  await sleep(800);
  const s1 = await head();
  await tab('2D');
  await sleep(800);
  const s2 = await head();
  out.switching = { s0, s1, s2 };
  check(s1.playing && s1.t - s0.t > 0.5, 'switching 2D -> 3D while playing keeps the playhead moving', out.switching);
  check(s2.playing && s2.t - s1.t > 0.5, 'switching 3D -> 2D while playing keeps the playhead moving', out.switching);
  await pauseIfPlaying();

  /* ── 3. 带着 playing 换舞台渲染面(重载可见舞台 iframe) ─────── */
  await page.evaluate(async () => { (await import('/src/store/project.ts')).actions.seek(0.5); });
  await sleep(400);
  await clickPlay();
  await sleep(400);
  await page.evaluate(async () => { window.__p3d.oldFront = (await import('/src/editor/stageBridge.ts')).frontStage(); });
  const frontId = await page.evaluate(() => (typeof window.__pcPreviewDiag === 'function' ? window.__pcPreviewDiag().frontId : 'A'));
  const frontFrame = page.frames().find((f) => f.url().includes('stage=1') && f.url().includes(`id=${frontId}`));
  await frontFrame.evaluate(() => location.reload()).catch(() => { /* 导航掐断了这次 evaluate,正常 */ });
  await page.waitForFunction(async () => {
    const c = (await import('/src/editor/stageBridge.ts')).frontStage();
    return !!c && c !== window.__p3d.oldFront;
  }, { timeout: 60000, polling: 100 });
  const r0 = await head();
  await sleep(1500);
  const r1 = await head();
  out.remount = { frontId, afterHandshake: r0, later: r1 };
  check(r1.playing && r1.t - r0.t > 0.8, 'after the visible stage is replaced mid-playback, playback resumes on the new stage (play waits for the project)', out.remount);
  await pauseIfPlaying();

  /* ── 4. 舞台拒绝起播 → 界面退回暂停 ─────────────────────────── */
  await page.evaluate(async () => {
    const { frontStage } = await import('/src/editor/stageBridge.ts');
    await frontStage().setRole('back');   // 舞台的 play() 只认 front,必回 { ok: false, reason: 'role' }
  });
  await clickPlay();
  const deadline = Date.now() + 3000;
  let refused = await head();
  while (refused.playing && Date.now() < deadline) { await sleep(100); refused = await head(); }
  out.refused = refused;
  check(!refused.playing, 'when the stage refuses play(), the store falls back to paused instead of showing "playing" with a frozen picture', refused);
  await page.evaluate(async () => {
    const { frontStage } = await import('/src/editor/stageBridge.ts');
    await frontStage().setRole('front');
  });
  await sleep(300);
  const q0 = await head();
  await clickPlay();
  await sleep(1000);
  const q1 = await head();
  out.recovered = { q0, q1 };
  check(q1.playing && q1.t - q0.t > 0.5, 'after the stage accepts again, one click on play starts cleanly', out.recovered);
  await pauseIfPlaying();

  /* ── 5. 发给已拿出 DOM 的 iframe 的 RPC 会被回绝 ────────────── */
  out.closedTarget = await page.evaluate(async () => {
    const { createStageRpc } = await import('/src/render/stageRpc.ts');
    const f = document.createElement('iframe');
    f.src = 'about:blank';
    document.body.appendChild(f);
    const win = f.contentWindow;
    const early = createStageRpc(win, location.origin);
    const pending = early.play(0).then(() => 'resolved', (e) => String(e.message));
    f.remove();
    const late = createStageRpc(win, location.origin);
    const t0 = performance.now();
    // 两个都限时:修之前它们真的会永远挂着,探针自己不能跟着挂死
    const within = (p) => Promise.race([p, new Promise((r) => setTimeout(() => r('still pending'), 3000))]);
    const pendingResult = await within(pending);
    const lateResult = await within(late.play(0).then(() => 'resolved', (e) => String(e.message)));
    return { closed: win.closed, pendingResult, pendingMs: Math.round(performance.now() - t0), lateResult };
  });
  check(out.closedTarget.closed && /detached/.test(out.closedTarget.pendingResult) && out.closedTarget.pendingMs < 2500,
    'a request pending when its iframe is removed is rejected as detached within ~1 s', out.closedTarget);
  check(/detached/.test(out.closedTarget.lateResult), 'a request to an already-removed iframe is rejected immediately', out.closedTarget);

  out.reloaded = await page.evaluate(() => window.__p3d?.marker !== 1);
  check(!out.reloaded, 'page was not reloaded by HMR during the run (rerun when the tree is quiet)');
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
