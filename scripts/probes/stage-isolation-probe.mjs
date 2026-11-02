/**
 * E1 acceptance check: the two stage iframes genuinely land in **their own render processes** (R2).
 *
 *   node scripts/probes/stage-isolation-probe.mjs [--origin http://127.0.0.1:5211] [--repeats 3]
 *
 * If `--origin` is omitted, check `PC_STAGE_TEST_URL`; if still none, hit `dev-test` in
 * `.claude/launch.json`.
 *
 * Evaluate two criteria (following the approach in `scripts/probes/oac-probe.mjs`):
 *   1. CDP `Target.getTargets` contains **two** targets with `type: 'iframe'`: having targets indicates
 *      it is an out-of-process iframe. `window.originAgentCluster` **always returns true and cannot
 *      serve as a criterion**;
 *   2. Run an infinite loop on stage A's main thread for 2.5 seconds, measure the worst rAF interval of
 *      the editor main document: **< 20 ms**.
 *      If in the same process, this number would be over two thousand milliseconds (measured, see
 *      `docs/archive/restructure_planning/g0-a-webview2-probe.md`).
 *
 * This page is the real editor (`?editor&preview=stage`), and what is measured is also the real main
 * document: pinned render 1 states that "user interaction is not allowed to have any stutter", which
 * refers to this.
 *
 * The infinite loop is timed with `window.__pcRealNow()`: `performance.now` in the stage document is
 * replaced by stageClock with a virtual clock (identically equal to current frame timestamp); writing
 * a while loop with it will **spin forever**.
 *
 * When multiple Agents are running simultaneously, elapsed time is unreliable; defaults to running
 * 3 times and reporting the median.
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
 * **Frame rate limit must be disabled**. On this machine (and in any session without a real monitor
 * refreshing), Chrome's BeginFrame drops to 10 Hz: measured rAF interval median even on `about:blank`
 * is 100.4 ms, worst 100.9 ms: at that point what is measured is display pacing, not stutter; the
 * `< 20 ms` rule **cannot hold under any implementation**.
 * Adding `--disable-gpu-vsync --disable-frame-rate-limit`, rAF no longer waits for vertical sync,
 * and the interval equals the time between two yields of the main thread: exactly the quantity
 * asked by "whether the parent page is blocked by the stage".
 * Comparison: under the same flags, a blank page worst is 1.3 ms, and the editor without stage
 * lag is 3-6 ms worst.
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
  // Comparison: originAgentCluster always returns true, recorded to remind future maintainers
  // not to use it as a criterion
  out.originAgentClusterSaysTrue = await Promise.all(
    page.frames().filter((f) => f.url().includes('stage=1')).map((f) => f.evaluate(() => window.originAgentCluster).catch(() => 'n/a')),
  );

  const frameA = page.frames().find((f) => f.url().includes('id=A'));
  check(!!frameA, 'stage A frame handle');

  /** One measurement round: measure the worst rAF interval of the parent page over `ms + 800` ms */
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

  // Control group: what the parent page normally looks like when nothing is blocked. The criterion
  // uses the same metric; only with the baseline displayed can we tell whether 20 ms is lenient or strict
  out.baseline = await measureParent(BLOCK_MS);
  out.baseline.worst = Math.round(out.baseline.worst * 10) / 10;

  for (let i = 0; i < REPEATS; i++) {
    // Parent page starts measuring first, then let A freeze; both sides use real wall-clock time
    const measuring = measureParent(BLOCK_MS);
    await new Promise((r) => setTimeout(r, 150));
    const blocking = frameA.evaluate((ms) => {
      const now = window.__pcRealNow ?? (() => Date.now());
      const t0 = now();
      const end = t0 + ms;
      while (now() < end) { /* Fully occupy the main thread of this render process */ }
      return now() - t0;
    }, BLOCK_MS).catch((e) => String(e));
    const [m, blocked] = await Promise.all([measuring, blocking]);
    // If the infinite loop did not actually run, measuring "parent page is not blocked" below was in vain
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
