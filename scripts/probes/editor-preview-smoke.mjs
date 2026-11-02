/**
 * Editor smoke test (E0 / E1 / D3 page side): actually opens editor (?editor), adds two cards via
 * store, seeks, and verifies Preview only sends project and time to stage iframe via RPC,
 * and hit testing and selection stroke work as usual.
 *
 *   node scripts/probes/editor-preview-smoke.mjs [--origin http://127.0.0.1:5211] [--stage | --legacy]
 *
 * Without `--origin`, check `PC_STAGE_TEST_URL`; if still absent, hit `dev-test` in `.claude/launch.json`.
 *
 * `--stage` opens `?preview=stage` (two cross-origin stage iframes, E1), `--legacy` opens
 * `?preview=legacy` (one same-origin stage iframe). **Omitting both means "verify whatever the default is"**.
 *
 * Before R7, default was legacy, so omitting arguments = legacy; **R7 flipped default to stage**,
 * so omitting arguments became stage. The rollback item must therefore explicitly specify `--legacy`:
 * otherwise, after flipping the switch, the pass to "verify legacy" would actually open the new route,
 * and assertions would inevitably fail.
 *
 * **Can run consecutively on the same dev server**, each pass starting from the same baseline:
 *   - First `newProject` to switch to an empty project, then add two cards, and assert the
 *     project only contains these two;
 *   - Tag text parameters of both cards with current pass marker. Dev server persists cost records
 *     for each card on disk (`out/card-costs.json`, preserved across passes and restarts), looked up
 *     by card identity (card + parameters + duration + ...), and `demoted` tagged by K6 also sticks.
 *     If parameters remain unchanged, the next pass starts off following the previous pass's downgrade
 *     record; in testing, after seeking in that pass, local frames for both cards on stage read 0,
 *     failing the "local frame 45" check. Changing parameters treats it as an unseen card.
 *     The trade-off is adding a few extra records to that server's log each pass;
 *   - Editor uses `nosetup=1`: initial AI setup dialog waits for `/api/ai/providers` before popping
 *     up at unpredictable times; popping up lands right over the click point, blocking preview clicks.
 *
 * **Stage DOM must consistently use Puppeteer's frame handles** (`page.frames()` still provides
 * them for cross-origin iframes), not `iframe.contentDocument`: the parent page cannot access it
 * in cross-origin mode.
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { devOrigin } from './probe-connect.mjs';

const args = process.argv.slice(2);
const origin = devOrigin(args);
const forceStage = args.includes('--stage');
const forceLegacy = args.includes('--legacy');
/**
 * Default without arguments: opens `/?editor`, page decides which route to take based on default
 * `previewMode()`.
 */
const editorQuery = '/?editor&nosetup=1' + (forceStage ? '&preview=stage' : forceLegacy ? '&preview=legacy' : '');
/**
 * Marker for this pass, written into text parameters of both cards: cost records left on same
 * server from earlier passes will not match these two cards (see file header).
 */
const runTag = Date.now().toString(36);
const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
/**
 * Used when explicitly specified; without arguments, detected after page loads based on "whether
 * there is a second stage".
 */
let stageMode = forceStage;
const out = { mode: forceStage ? 'stage' : forceLegacy ? 'legacy' : '(default, to be identified)', modeFrom: forceStage || forceLegacy ? 'flag' : 'default' };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(origin + editorQuery, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 120000 });
  // Stage handshake → front client registered in stageBridge
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage();
  }, { timeout: 120000, polling: 500 });
  /** Frame handle of visible stage iframe (parent page cannot access its document when cross-origin) */
  /**
   * Visible stage iframe. **Cannot hardcode id=A**: after K5's role swap (R5), visible stage may be B,
   * while A mostly holds probe's reduced project: reading `data-pc-local-frame` from A measures
   * a completely different scene. Which stage is front is determined by parent page's
   * `__pcPreviewDiag()`; falls back to A in legacy mode or when not yet ready.
   */
  /*
   * When omitting arguments: verify whatever the default is. Criterion is "page actually mounted
   * two stage iframes": the tier with `?preview=stage` but occupied port has only one iframe,
   * behaving like legacy and should be verified as legacy. Give back some time to register before
   * detecting.
   */
  if (!forceStage && !forceLegacy) {
    await page.waitForFunction(() => document.querySelectorAll('iframe[data-pc^="stage-frame"]').length === 2,
      { timeout: 8000, polling: 200 }).catch(() => {});
    stageMode = await page.evaluate(() => document.querySelectorAll('iframe[data-pc^="stage-frame"]').length === 2);
    out.mode = stageMode ? 'stage' : 'legacy';
  }
  const frontId = async () => (await page.evaluate(() => (typeof window.__pcPreviewDiag === 'function' ? window.__pcPreviewDiag().frontId : 'A'))) || 'A';
  const stageFrame = (id = 'A') => page.frames().find((f) => f.url().includes('stage=1') && f.url().includes(`id=${id}`));
  out.roles = await page.evaluate(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return { backRole: m.backRole(), hasBack: m.backStage() !== m.frontStage() };
  });
  if (stageMode) {
    // E1: Second iframe exists and is actually registered as back
    await page.waitForFunction(async () => {
      const m = await import('/src/editor/stageBridge.ts');
      return m.backRole() === 'back';
    }, { timeout: 120000, polling: 500 });
    out.roles = await page.evaluate(async () => {
      const m = await import('/src/editor/stageBridge.ts');
      return { backRole: m.backRole(), hasBack: m.backStage() !== m.frontStage() };
    });
    const origins = await page.evaluate(() => ({
      frames: [...document.querySelectorAll('iframe[data-pc^="stage-frame"]')].map((f) => new URL(f.src).origin),
      page: location.origin,
    }));
    out.stageOrigins = origins;
    check(origins.frames.length === 2 && origins.frames[0] !== origins.frames[1] && origins.frames.every((o) => o !== origins.page),
      'two stage iframes, each on its own origin and neither is the editor origin', origins);
    check(out.roles.backRole === 'back' && out.roles.hasBack, 'the second iframe is registered as the back stage', out.roles);
  } else {
    check(out.roles.backRole === 'front' && !out.roles.hasBack, 'legacy keeps a single same-origin stage (back falls back to front)', out.roles);
  }

  await page.evaluate(() => { window.__smokeMarker = 1; });
  const ids = await page.evaluate(async (runTag) => {
    const { actions, getState } = await import('/src/store/project.ts');
    actions.newProject('smoke'); // Editor inserts demo cards into empty projects on startup; switch to empty project first
    const a = actions.addCardClip('odometer', 0, { duration: 10, params: { label: `冒烟 ${runTag}` } });
    const b = actions.addCardClip('punch-pill', 0, { duration: 10, params: { text: `冒烟 ${runTag}` } });
    actions.seek(1.5);
    return { odo: a?.id, pill: b?.id, tracks: getState().project.tracks.map((t) => t.clips.length) };
  }, runTag);
  out.runTag = runTag;
  out.ids = ids;
  check(ids.odo && ids.pill, 'clips added', ids);
  check(ids.tracks.reduce((n, k) => n + k, 0) === 2, 'the run starts from an empty project (only its own two clips)', ids.tracks);
  await sleep(1500);

  const wraps = await stageFrame(await frontId()).evaluate(() =>
    [...document.querySelectorAll('[data-pc-clip]')].map((el) => ({ id: el.getAttribute('data-pc-clip'), frame: el.getAttribute('data-pc-local-frame') })));
  const stageState = await page.evaluate(async (wraps) => {
    const { frontStage, pushedProject } = await import('/src/editor/stageBridge.ts');
    const { getState } = await import('/src/store/project.ts');
    const synced = pushedProject('front') === getState().project;
    const size = await frontStage().size();
    return { wraps, synced, size, t: getState().t };
  }, wraps);
  out.stage = stageState;
  check(stageState.wraps.length === 2 && stageState.wraps.every((w) => w.frame === '45'), 'stage shows both clips at local frame 45 (t=1.5s @30fps)', stageState);
  check(stageState.synced, 'stageBridge baseline equals the store project after sync', stageState.synced);

  // Stroke: after selecting odometer, stroke should tightly hug content (smaller than full frame)
  const sel = await page.evaluate(async (odo) => {
    const { actions, getState } = await import('/src/store/project.ts');
    actions.select([odo]);
    await new Promise((r) => setTimeout(r, 400));
    // Scrub time once more to let refreshRects run
    actions.seek(1.6);
    await new Promise((r) => setTimeout(r, 600));
    const hit = document.querySelector('.pc-pv-hit');
    const frame = document.querySelector('.pc-pv-frame');
    const r = hit?.getBoundingClientRect(); const fr = frame?.getBoundingClientRect();
    return { selection: getState().selection, hit: r ? { w: r.width, h: r.height } : null, frame: fr ? { w: fr.width, h: fr.height } : null };
  }, ids.odo);
  out.sel = sel;
  check(sel.hit && sel.frame && sel.hit.w < sel.frame.w * 0.9 && sel.hit.h < sel.frame.h * 0.9, 'selection outline hugs the odometer content (smaller than the frame)', sel);

  // Click: click at center of odometer content, and it should be selected (hit via RPC round trip)
  const click = await page.evaluate(async (odo) => {
    const { frontStage } = await import('/src/editor/stageBridge.ts');
    const { actions } = await import('/src/store/project.ts');
    actions.select([]);
    const list = await frontStage().rectsWithBounds({ pixels: 'all' });
    const b = list.find((x) => x.clipId === odo)?.bounds;
    // Center of content box may land in the gap between two digits (penetrating transparency); scan
    // a small grid inside box to find a point that actually hits it
    let px = null;
    for (let iy = 1; iy < 6 && !px; iy++) for (let ix = 1; ix < 12 && !px; ix++) {
      const x = b.left + (b.width * ix) / 12, y = b.top + (b.height * iy) / 6;
      const h = await frontStage().hitTest(x, y);
      if (h && h.clipId === odo) px = { x, y };
    }
    const frame = document.querySelector('.pc-pv-frame').getBoundingClientRect();
    const scale = frame.width / 1920;
    if (!px) return null;
    const pt = { x: frame.left + px.x * scale, y: frame.top + px.y * scale };
    // After selection, editor pops up an overlay like suggestion card (.ais-card) above preview;
    // clicking it is not clicking preview; press Escape first to dismiss, then confirm top layer is
    // preview overlay
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise((r) => setTimeout(r, 200));
    const top = document.elementFromPoint(pt.x, pt.y);
    return { ...pt, top: top ? top.tagName + '.' + top.className : null, inPreview: !!top?.closest('.pc-pv-frame') };
  }, ids.odo);
  check(!!click, 'found a solid point inside the odometer content box');
  check(click && click.inPreview, 'the click point is on the preview overlay (no floating panel over it)', click);
  if (click) await page.mouse.click(click.x, click.y);
  await sleep(1200);
  const after = await page.evaluate(async () => {
    const { getState } = await import('/src/store/project.ts');
    return getState().selection;
  });
  out.clickSelection = after;
  check(after.length === 1 && after[0] === ids.odo, 'clicking the odometer content selects it via async hitTest', after);

  // Click empty space: deselect
  const blank = await page.evaluate(() => { const fr = document.querySelector('.pc-pv-frame').getBoundingClientRect(); return { x: fr.left + 20, y: fr.top + 20 }; });
  await page.mouse.click(blank.x, blank.y);
  await sleep(400);
  out.blankSelection = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().selection);
  check(out.blankSelection.length === 0, 'clicking blank deselects', out.blankSelection);

  // Play for 1 second. Under stage mode, pause() only synchronously changes store.playing; stage
  // stops only via async RPC.
  // Only observe player stopping ticks on its own; probe must not send pause() again, which would
  // mask bugs where player fails to send RPC.
  const atPause = await page.evaluate(async () => {
    const { actions, getState } = await import('/src/store/project.ts');
    actions.seek(0.5); actions.play();
    await new Promise((r) => setTimeout(r, 1000));
    actions.pause();
    return getState().t;
  });
  const readHead = () => page.evaluate(async () => {
    const { getState } = await import('/src/store/project.ts');
    const preview = typeof window.__pcPreviewDiag === 'function' ? window.__pcPreviewDiag() : null;
    return { t: getState().t, playing: getState().playing, frontId: preview?.frontId || 'A' };
  });
  let play;
  if (stageMode) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const before = await readHead();
      const stage = await stageFrame(before.frontId).evaluate(() => ({
        diag: typeof window.__pcStageDiag === 'function' ? window.__pcStageDiag() : null,
        frames: [...document.querySelectorAll('[data-pc-clip]')].map((el) => Number(el.getAttribute('data-pc-local-frame'))),
      }));
      const after = await readHead();
      // Two parent page readings before and after bracket stage readings; once ticks stop, timestamp
      // no longer changes, yielding a consistent cross-process sample.
      if (!before.playing && !after.playing && before.frontId === after.frontId && before.t === after.t
        && stage.diag?.role === 'front' && !stage.diag.beatRunning && stage.diag.beatPaused
        && Math.abs(stage.diag.beatLastSec - before.t) < 1e-6) {
        play = { t: before.t, atPause, stoppedAt: stage.diag.beatLastSec, frames: stage.frames };
        break;
      }
      await sleep(20);
    }
    if (!play) throw new Error('player did not settle to the same store and stage frame within 10s');
  } else {
    const frames = await stageFrame(await frontId()).evaluate(() =>
      [...document.querySelectorAll('[data-pc-clip]')].map((el) => Number(el.getAttribute('data-pc-local-frame'))));
    play = { t: atPause, stoppedAt: null, frames };
  }
  // When playback falls behind, make sure who stopped is visible (K4 ticks run in stage,
  // parent page only receives frames)
  play.preview = await page.evaluate(() => (typeof window.__pcPreviewDiag === 'function' ? window.__pcPreviewDiag() : null));
  play.stages = {};
  for (const f of page.frames()) {
    if (!f.url().includes('stage=1')) continue;
    const id = f.url().includes('id=A') ? 'A' : 'B';
    play.stages[id] = await f.evaluate(() => (typeof window.__pcStageDiag === 'function' ? window.__pcStageDiag() : null)).catch(() => null);
  }
  out.play = play;
  check(play.t > 1.0 && play.frames.every((n) => Math.abs(n - Math.round(play.t * 30)) <= 1),
    'after 1s of playback the stage local frame follows store.t', play);

  // Page side of get_layout (D4): measures entity box via single-flight queue on background stage.
  // Legacy queue falls back to visible stage; under cross-origin dual stage it first calls
  // setRole('back', { job: 'catchup' }) and releases after measuring: returned values from both sides
  // should match
  const layout = await page.evaluate(async (odo) => {
    const { contentLayoutOf } = await import('/src/mcp/common.ts');
    const r = await contentLayoutOf([odo]);
    return r[odo];
  }, ids.odo);
  out.layout = layout;
  check(layout && layout.contentBox && layout.contentBox.width > 0 && layout.contentBox.width < 1920 * 0.9,
    'get_layout (contentLayoutOf) measures a content box through the back-stage job queue', layout);

  // Drag with move tool: hit → drag → release to write frame. This path uses hitTest async round
  // trip + nudgeFrame
  const dragStart = await page.evaluate(async (odo) => {
    const { actions } = await import('/src/store/project.ts');
    actions.select([odo]);
    // Second button in tool row is "Move"
    document.querySelectorAll('.pc-pv-tool')[1].click();
    await new Promise((r) => setTimeout(r, 200));
    const hit = document.querySelector('.pc-pv-hit').getBoundingClientRect();
    return { x: hit.left + hit.width / 2, y: hit.top + hit.height / 2 };
  }, ids.odo);
  await page.mouse.move(dragStart.x, dragStart.y);
  await page.mouse.down();
  await page.mouse.move(dragStart.x + 40, dragStart.y + 24, { steps: 8 });
  await page.mouse.up();
  await sleep(600);
  out.drag = await page.evaluate(async (odo) => {
    const { getState } = await import('/src/store/project.ts');
    const { findClip } = await import('/src/kernel/project.ts');
    return findClip(getState().project, odo)?.clip.frame ?? null;
  }, ids.odo);
  check(out.drag && Number.isFinite(out.drag.x) && Number.isFinite(out.drag.y), 'dragging with the move tool writes a clip frame', out.drag);
  await page.evaluate(() => { document.querySelectorAll('.pc-pv-tool')[0].click(); });

  // Other agents modifying files causes vite to reload entire page, making results of such a run
  // untrustworthy: report if marker is lost
  out.reloaded = await page.evaluate(() => window.__smokeMarker !== 1);
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
