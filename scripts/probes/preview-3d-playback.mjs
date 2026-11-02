/**
 * 3D tab playback (regression probe): genuinely open editor, press play on 3D tab, and check
 * whether playhead follows stage as normal.
 *
 *   node scripts/probes/preview-3d-playback.mjs [--origin http://127.0.0.1:5230]
 *
 * Without `--origin`, check `PC_STAGE_TEST_URL`; if still missing, hit `dev-test` in
 * `.claude/launch.json`. Only verifies default cross-origin dual stage (K4: playhead is driven
 * by `frame` from visible stage); fails immediately with explanation if page falls back to
 * single stage.
 *
 * Pins down these items (see fix commit message for troubleshooting process):
 *
 *   1. **Press play on 3D tab: t advances, audio layer remains.** Previously, switching to 3D
 *      unmounted the 2D subtree along with both stage iframes; `frontStage()` handed over a client
 *      pointing to a closed window, `play()` never responded, playhead was stuck in place while
 *      button showed "Pause". Also check that 3D canvas is not obscured by hidden 2D page (they
 *      overlap in the same area).
 *   2. **Switch back and forth between 2D and 3D during playback: playback uninterrupted.** Stage
 *      is no longer rebuilt upon tab switching, t advances continuously.
 *   3. **Switch stage render surface while `playing` (simulated here by reloading visible stage
 *      iframe): playback resumes on its own.** Previously, the new stage received `play` before
 *      receiving the project, returning `no-project`; parent page did not retry: picture never
 *      moved.
 *   4. **When stage refuses to start playback, UI reverts to paused.** Let visible stage
 *      temporarily take the `back` role; pressing play must return `{ ok: false }`; store's
 *      `playing` must flip back to false, cannot stay on "playing".
 *   5. **RPC sent to an iframe removed from DOM is rejected, not hanging forever** (real Chrome
 *      WindowProxy; unit test uses a mock).
 *
 * Like editor-preview-smoke, each pass first calls `newProject` to start an empty project, with
 * card parameters tagged for this pass, to avoid cross-contamination from cost records
 * (`out/card-costs.json`) left by earlier passes on the same server.
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

  // Parent page side: count `frame` events (one per tick in K4), and read the playhead
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
  /** Wait for player to settle (pause wrap-up is async RPC) so next segment does not start with moving playhead */
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

  /* ── 1. Press play on 3D tab ─────────────────────────────────── */
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

  /* ── 2. Switch tabs back and forth during playback ──────────── */
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

  /* ── 3. Switch stage render surface while playing (reload visible stage iframe) ── */
  await page.evaluate(async () => { (await import('/src/store/project.ts')).actions.seek(0.5); });
  await sleep(400);
  await clickPlay();
  await sleep(400);
  await page.evaluate(async () => { window.__p3d.oldFront = (await import('/src/editor/stageBridge.ts')).frontStage(); });
  const frontId = await page.evaluate(() => (typeof window.__pcPreviewDiag === 'function' ? window.__pcPreviewDiag().frontId : 'A'));
  const frontFrame = page.frames().find((f) => f.url().includes('stage=1') && f.url().includes(`id=${frontId}`));
  await frontFrame.evaluate(() => location.reload()).catch(() => { /* Navigation aborted this evaluate, normal */ });
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

  /* ── 4. Stage refuses playback start → UI reverts to paused ─── */
  await page.evaluate(async () => {
    const { frontStage } = await import('/src/editor/stageBridge.ts');
    await frontStage().setRole('back');   // Stage play() only accepts front, always returns { ok: false, reason: 'role' }
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

  /* ── 5. RPC sent to iframe removed from DOM is rejected ──────── */
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
    // Both have timeouts: before the fix they really hung forever; probe itself cannot hang dead with them
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
