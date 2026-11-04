import puppeteer from 'puppeteer';
import path from 'path';
import fsSync from 'node:fs';
import { launchHealthyChrome } from './chrome-health.mjs';

/**
 * Frame-by-frame export: beginFrame backend.
 *
 * # Why replace virtual time
 *
 * The original approach (archived in scripts/archive/export-frames-virtual-time.mjs) was to advance
 * CDP virtual time by one step, then capture screenshots with `page.screenshot`. The slowness was
 * not in encoding: under the same state, capturing a 1x1 image took 66.7ms and full screen took
 * 85ms: almost equally slow regardless of capture size. The cost was spent on "making Chrome emit
 * a frame just for the screenshot", plus the entire round trip of temporarily releasing virtual
 * time during screenshots.
 *
 * Here we switch to chrome-headless-shell's `HeadlessExperimental.beginFrame`: **we supply the frame
 * time**, completing rAF + paint + screenshot within a single tick, without needing virtual time.
 * Measured (docs/archive/topics/render-rebuild-plan.md stage 1):
 *   - Demo total length 1800 frames: old 107.7 ms/frame → here 26.9 ms/frame, ~4x;
 *   - Reconciling frame-by-frame against the old pipeline: both sides are 1800/1800 across two
 *     passes each; all mutually inconsistent frames came from system font fallbacks (already fixed
 *     in theme), not differences in how frames are emitted;
 *   - The old pipeline had sporadic non-determinism (once across 600 frames, 13 frames differed
 *     between two passes); here, all four pairwise comparisons are identical.
 *
 * # Per-frame steps, mapped one-to-one against the old pipeline
 *
 *   Old                                                 Here
 *   __pcSetT                                            Same
 *   setVirtualTimePolicy(pauseIfNetworkFetchesPending)   Wait for network (Network domain counts in-flight requests; proceeds only after clearing to zero) → settle → beginFrame() → wait for network
 *   settle(): advance 0.001ms virtual time              In-page setTimeout(0) until __pcMutationCount stops changing
 *   __pcSyncAnims → settle → wait for image decode / __pcFrameReady  Same (merged into two in-page calls)
 *   page.screenshot + switch advance during capture     beginFrame({ screenshot })
 *   Warm up 3 frames → __pcRestartCards → discard 1 more frame  Same
 *
 * **The wait-for-network step cannot be omitted**: scene-3d dynamically calls `import("three")`
 * in the pre-mounted frame; without waiting for it to return, 3D visuals appear one frame late
 * (measured 320,000 different pixels at frame 119); byte-for-byte identical after adding it.
 * The old pipeline did this implicitly via pauseIfNetworkFetchesPending.
 *
 * # Page clock
 *
 * performance.now / rAF are still pinned to __pcExportMs by src/kernel/exportClock.ts; random
 * numbers, wall clock, and crypto are pinned by src/kernel/pinEntropy.ts. The frame time supplied
 * to beginFrame only requires monotonic increase; visuals do not read it.
 *
 * # Dependencies
 *
 * Requires chrome-headless-shell (the `HeadlessExperimental` domain only exists in it). Puppeteer
 * installs it by default on development machines; copied into runtime/chrome for desktop packages
 * via desktop/scripts/prepare-runtime.mjs.
 * Pinned version: this is an experimental CDP domain; run scripts/verify-determinism.mjs before
 * upgrading Chrome.
 */

/**
 * Nominal interval per tick (ms). As long as frame time is monotonically increasing, whatever
 * value is chosen does not affect visuals: display reads __pcExportMs
 */
const FRAME_INTERVAL = 1000 / 60;

const BASE_CHROME_ARGS = [
  // Windows headless-shell can still own a blank native window. Keep both
  // startup and every subsequently created target outside the desktop.
  '--window-position=-32000,-32000', '--no-first-run', '--no-default-browser-check',
  // Prerequisite for beginFrame: renderer no longer emits frames on its own; every frame waits for
  // us to send BeginFrame
  '--enable-begin-frame-control', '--run-all-compositor-stages-before-draw',
  '--hide-scrollbars',
  // Software rasterization: GPU rasterization is not completely consistent across two runs on
  // rotated/scaled antialiased edges (measured differences of a dozen pixels per frame, magnitude ≤ 8/255)
  '--disable-gpu', '--disable-gpu-rasterization', '--disable-gpu-compositing',
  '--font-render-hinting=none', '--force-device-scale-factor=1',
  // Disable partial rasterization: taking a screenshot of previous frame alters compositor damage
  // rect boundaries of next frame, causing identical geometry to be rasterized differently
  '--disable-partial-raster',
  // Run all animations on main thread: animations on compositor thread advance half a step extra
  // by their own clock on screenshot frames
  '--disable-threaded-animation',
  // The --disable-gpu* flags above also disable WebGL (getContext returns null, three.js cards
  // render as empty canvases without errors); this flag enables SwiftShader software WebGL, drawing
  // the same triangle across three consecutive passes byte-for-byte identically
  '--enable-unsafe-swiftshader',
];

/**
 * Whether to disable Chrome's sandbox (`docs/plan/hosted-render-contract.md` section 7.3; task brief
 * "Chrome automatically includes sandbox flags in root or containers"):
 * Chrome refuses to launch with sandbox as root, and containers usually lack the user namespaces
 * it requires. Evaluated only on **Linux**: never added on Windows or macOS, keeping desktop app
 * launch arguments identical to before. Returns the reason in three cases, otherwise null:
 *   - `PROMPTCUT_CHROME_NO_SANDBOX=1` (explicitly requested); set to `0` to never add it;
 *   - Process runs as root (`getuid() === 0`);
 *   - Inside a container (`/.dockerenv` or `/run/.containerenv` exists).
 * Arguments can all be injected, so unit tests do not need to switch platforms.
 */
export function noSandboxReason({ platform = process.platform, env = process.env, getuid = process.getuid?.bind(process), exists = fsSync.existsSync } = {}) {
  if (platform !== 'linux') return null;
  if (env.PROMPTCUT_CHROME_NO_SANDBOX === '0') return null;
  if (env.PROMPTCUT_CHROME_NO_SANDBOX === '1') return 'env';
  let uid = null;
  try { uid = typeof getuid === 'function' ? getuid() : null; } catch { uid = null; }
  if (uid === 0) return 'root';
  try { if (exists('/.dockerenv') || exists('/run/.containerenv')) return 'container'; } catch { /* If unable to check, assume not in a container */ }
  return null;
}

/**
 * Arguments used to launch Chrome this time: the fixed set, plus `--no-sandbox` (Linux root /
 * container only), plus `PC_CHROME_ARGS="--flag-a --flag-b"` for troubleshooting. Computed fresh on
 * each launch rather than fixed at module load time (environment variables may be set after load).
 */
export function chromeLaunchArgs(options = {}) {
  const env = options.env ?? process.env;
  return [
    ...BASE_CHROME_ARGS,
    ...(noSandboxReason(options) ? ['--no-sandbox'] : []),
    // For experimentation/troubleshooting: PC_CHROME_ARGS="--flag-a --flag-b" appends launch arguments
    ...(env.PC_CHROME_ARGS ? env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : []),
  ];
}

/**
 * Injected before each new document loads. Blocks Vite's HMR / heartbeat (which keep network
 * requests pending indefinitely), then injects the frosted-glass mask logic.
 *
 * `__bfSettle` (settle), `__pcCreateSnapshot` (generate HTML snapshots), and asset loaders
 * (`__pcHideFrameMedia` / `__pcPrepareFrameMedia`) are no longer here: they are part of the page bundle;
 * see `src/render/snapshotSettle.ts`, `src/render/createSnapshot.ts`, `src/render/frameMedia.ts`, mounted
 * by `ExportView` / `StageView` (J1). Only Puppeteer-specific code unneeded by the page itself remains here.
 */
function PAGE_PRELUDE() {
  const originalFetch = window.fetch;
  window.fetch = async (input, init) => {
    if (typeof input === 'string' && input.includes('__vite_ping')) {
      return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return originalFetch.call(window, input, init);
  };
  class MockWebSocket extends EventTarget {
    constructor() { super(); this.readyState = 1; setTimeout(() => this.dispatchEvent(new Event('open')), 10); }
    send() {}
    close() {}
  }
  window.WebSocket = MockWebSocket;
  window.location.reload = () => console.log('Intercepted location.reload');
  /*
   * Frosted-glass mask (used for exports that only render cards; see mask in server/export-compose.mjs).
   *
   * Card glass uses backdrop-filter:blur, which blurs what is **behind** it. When the page only renders
   * cards, the background is transparent, and video is underlaid later by ffmpeg: the glass becomes
   * a film that only has a background color without blurring the video. To restore the blur, ffmpeg
   * needs to know the exact shape of the glass on screen: position, 3D scale/rotation, border radius,
   * how much it is faded by ancestor opacity, and what clips it.
   * Calculating these manually is error-prone, so Chrome is tasked with drawing it: after capturing
   * cards for this frame, everything on the stage except glass is temporarily hidden, glass itself
   * is painted solid white, and another screenshot is taken: white areas represent glass, and alpha
   * represents its coverage × opacity. Restored as-is after capture.
   *
   * Restoration must not disrupt any animations:
   *   - Never touch transition-property throughout (modifying it cancels running CSS transitions);
   *     only crush duration / delay to 0 so value changes do not trigger new transitions;
   *   - Tear down in two steps: first remove the override while keeping "duration 0", force a style
   *     recalculation (reverting values without triggering transitions), then remove everything completely;
   *   - Animations (Motion's WAAPI, CSS animation) are lower in the cascade than !important author
   *     styles; they are suppressed during overrides and recover immediately upon removal;
   *   - Only mark glass that is already visible: what was originally visibility:hidden must not be
   *     exposed by these rules.
   * Leave filter on ancestors untouched: removing it alters the containing block for absolutely
   * positioned descendants and may shift the glass; the tradeoff is that frosted-glass cards with
   * emphasis shadows will have a faint shadow ring around mask edges (blur slightly bleeding past
   * glass edges).
   */
  const GLASS_HOLD = '#root *, #root *::before, #root *::after { transition-duration: 0s !important; transition-delay: 0s !important; }';
  const GLASS_ON = GLASS_HOLD + `
    #root *, #root *::before, #root *::after { visibility: hidden !important; }
    #root [data-bf-glass] { visibility: visible !important; background: #fff !important; border-color: #fff !important;
      box-shadow: none !important; outline: none !important; filter: none !important; backdrop-filter: none !important;
      -webkit-backdrop-filter: none !important; color: transparent !important; text-shadow: none !important; }
    #root [data-bf-glass] *, #root [data-bf-glass]::before, #root [data-bf-glass]::after { visibility: hidden !important; }`;
  window.__bfGlassOn = () => {
    const root = document.getElementById('root');
    if (!root) return null;
    const els = [];
    const blurs = [];
    for (const el of root.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      const bf = cs.backdropFilter || cs.webkitBackdropFilter;
      if (!bf || bf === 'none' || cs.visibility !== 'visible') continue;
      els.push(el);
      const m = /blur\(([\d.]+)px\)/.exec(bf);
      if (m) blurs.push(parseFloat(m[1]));
    }
    if (!els.length) return null;
    for (const el of els) el.setAttribute('data-bf-glass', '');
    const st = document.createElement('style');
    st.id = '__bf_glass';
    st.textContent = GLASS_ON;
    document.head.appendChild(st);
    window.__bfGlassEls = els;
    return { count: els.length, blurs };
  };
  window.__bfGlassOff = () => {
    const st = document.getElementById('__bf_glass');
    if (!st) return;
    st.textContent = GLASS_HOLD;
    void document.body.offsetHeight;
    st.remove();
    for (const el of window.__bfGlassEls || []) el.removeAttribute('data-bf-glass');
    window.__bfGlassEls = null;
    void document.body.offsetHeight;
  };
}

/**
 * Opens a frame-controlled blank page (`Target.createTarget({ enableBeginFrameControl: true })`,
 * window positioned off-screen). Every prerender pass opens its page here; the host render
 * service startup self-check (`server/hosted-render/selfcheck.mjs`) also uses this path, so
 * "self-check passed, but worker process failed to open page" will no longer occur.
 *
 * Only chrome-headless-shell recognizes this set of parameters: full Chrome / Chromium (even if
 * launched headless) returns `Target position can only be set for new windows` for `left` / `top`
 * without `newWindow`, and lacks `HeadlessExperimental.beginFrame`, making frame-controlled frame
 * emission completely impossible. Therefore render nodes must use chrome-headless-shell, with
 * the version determined by the repository's locked puppeteer (`expectedHeadlessShellVersion()`).
 */
export async function openFrameTarget(browser) {
  const bs = await browser.target().createCDPSession();
  let targetId;
  try {
    ({ targetId } = await bs.send('Target.createTarget', { url: 'about:blank', enableBeginFrameControl: true, left: -32000, top: -32000, width: 1920, height: 1080, focus: false }));
  } finally {
    await bs.detach().catch(() => {});
  }
  const target = await browser.waitForTarget((t) => t._targetId === targetId, { timeout: 30000 });
  return target.page();
}

/**
 * Runs through prerender page opening and frame emission in a launched browser: opens a
 * frame-controlled page, sends `beginFrame` to capture one frame. Returns `{ ok: true, bytes }`
 * (byte count of that frame's PNG) on success, or `{ ok: false, stage: 'open' | 'frame', detail }`
 * on failure. Used for self-checks; does not modify any render paths.
 */
export async function probeFramePath(browser, { timeoutMs = 30000 } = {}) {
  let page = null;
  let stage = 'open';
  const work = (async () => {
    page = await openFrameTarget(browser);
    stage = 'frame';
    const client = await page.createCDPSession();
    await client.send('Page.enable');
    await page.evaluate(() => { document.documentElement.style.background = '#204060'; });
    let tick = 1000;
    for (let i = 0; i < 8; i += 1) {
      const out = await client.send('HeadlessExperimental.beginFrame', { frameTimeTicks: (tick += FRAME_INTERVAL), interval: FRAME_INTERVAL, screenshot: { format: 'png' } });
      if (out?.screenshotData) return { ok: true, bytes: Buffer.from(out.screenshotData, 'base64').length };
    }
    return { ok: false, stage: 'frame', detail: 'beginFrame was sent 8 times in a row without returning a frame' };
  })();
  let timer = null;
  try {
    return await Promise.race([
      work,
      new Promise((resolve) => { timer = setTimeout(() => resolve({ ok: false, stage, detail: `no result after ${timeoutMs / 1000} seconds` }), timeoutMs); }),
    ]);
  } catch (err) {
    return { ok: false, stage, detail: String(err?.message ?? err).split('\n')[0].slice(0, 300) };
  } finally {
    clearTimeout(timer);
    try { await page?.close(); } catch { /* The browser closes immediately afterwards */ }
  }
}

/**
 * chrome-headless-shell version matching the repository-locked puppeteer (e.g. `152.0.7977.75`);
 * returns null if unreadable
 */
export async function expectedHeadlessShellVersion() {
  try { return await headlessShellBuildId(); } catch { return null; }
}

/**
 * Opens a **brand-new, frame-controlled page** in an already launched browser, navigates to the
 * export page, and waits for page readiness.
 *
 * Why open a new page on every pass: pages have animation anchors, mounted cards, and states pushed
 * to the end of the cut; re-rendering in place on the same page would not yield the frame 0 visual.
 * A new page is a brand-new renderer, equivalent to launching a fresh browser.
 * Pages must be opened with `Target.createTarget({ enableBeginFrameControl: true })`: pages opened
 * via `browser.newPage()` are not frame-controlled, and beginFrame has no effect on them.
 */
async function newSession(browser, url) {
  const page = await openFrameTarget(browser);
  page.on('console', (msg) => { if (msg.type() !== 'debug') console.log('PAGE LOG:', msg.text()); });
  const client = await page.createCDPSession();
  await client.send('Page.enable');

  /*
   * Wait for network: corresponds to pauseIfNetworkFetchesPending in the old pipeline. Explicitly
   * throws an error if requests never return (such as a persistent connection); hanging is worse.
   * Event-driven: returns immediately when no requests are in flight, avoiding wasted waiting.
   */
  /** requestId → what this request is; needed to identify which request is hanging on timeout error */
  const inflight = new Map();
  let waiters = [];
  const drained = () => {
    if (inflight.size) return;
    const w = waiters;
    waiters = [];
    w.forEach((f) => f());
  };
  await client.send('Network.enable');
  client.on('Network.requestWillBeSent', (e) => {
    /*
     * <video>/<audio> media streams do not count. When a large video is mounted on the page, its
     * request stays open fetching while playing, never reaching loadingFinished: counting it would
     * waste 30 full seconds waiting every frame before failing (measured on a project mounting 20
     * videos, max 265 MB, where not a single frame could export). The video layer has its own waiting
     * strategy: ExportView's __pcFrameReady waits layer by layer for seek completion; waiting again
     * here is neither necessary nor possible.
     */
    if (e.type === 'Media') return;
    /*
     * `blob:` scripts also do not count (R9): GL Worker is launched by a blob bootstrap script, and
     * the completion event for the main Worker script request is reported on the Worker's own target,
     * so the page's Network domain never receives loadingFinished. A blob is local memory; there is no
     * such thing as being "in flight" to begin with.
     */
    if (String(e.request?.url || '').startsWith('blob:')) return;
    inflight.set(e.requestId, `${e.type || '?'} ${String(e.request?.url || '').slice(0, 120)}`);
  });
  for (const ev of ['Network.loadingFinished', 'Network.loadingFailed', 'Network.requestServedFromCache']) {
    client.on(ev, (e) => { inflight.delete(e.requestId); drained(); });
  }
  const waitNet = (ms = 30000) => (inflight.size === 0 ? Promise.resolve() : new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(
      `${inflight.size} network requests have not returned after ${ms / 1000} seconds: the page may have requests that never finish.`
      + ` First few: ${[...inflight.values()].slice(0, 3).join(' | ')}`
    )), ms);
    waiters.push(() => { clearTimeout(timer); resolve(); });
  }));

  let tick = 1000;
  const beginFrame = (extra = {}) => client.send('HeadlessExperimental.beginFrame', {
    frameTimeTicks: (tick += FRAME_INTERVAL), interval: FRAME_INTERVAL, ...extra,
  });

  // In-page evaluate with timeout (used as caller fallback; with virtual time gone, the page's own
  // timers are reliable as well)
  const evalWithTimeout = (fn, ms) => Promise.race([
    page.evaluate(fn).catch(() => {}),
    new Promise((r) => setTimeout(r, ms)),
  ]);

  /**
   * Waits for window.__pcReady. Frame-controlled pages do not emit frames on their own, so empty
   * ticks must be continuously sent while waiting (no painting or capturing)
   */
  const waitReady = async () => {
    const t0 = Date.now();
    for (;;) {
      await beginFrame({ noDisplayUpdates: true }).catch(() => {});
      if (await page.evaluate(() => window.__pcReady === true).catch(() => false)) return;
      if (Date.now() - t0 > 60000) throw new Error('The export page was not ready after 60 seconds (window.__pcReady never became true)');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  await page.evaluateOnNewDocument(PAGE_PRELUDE);
  console.log(`Navigating to ${url}...`);
  /*
   * On navigation failure (no server on the port, etc.), Page.navigate does not throw, only returning
   * errorText while the page stops on Chrome's error page. Without checking this, waitReady would
   * waste a full 60 seconds waiting, only to report an error that sounds like an issue in page code.
   * URLs often include the entire project JSON (?timeline=data:…); when too long, errors retain only
   * the origin and path.
   */
  const { errorText } = await client.send('Page.navigate', { url });
  if (errorText) {
    const u = new URL(url);
    const where = url.length > 120 ? `${u.origin}${u.pathname}…` : url;
    throw new Error(`Cannot open the export page ${where}: ${errorText}. Is the dev server running at this address?`);
  }
  console.log('Waiting for window.__pcReady...');
  await waitReady();

  return {
    page, client, beginFrame, waitNet, evalWithTimeout,
    /**
     * Swaps to another project in place and waits for ready: without re-navigating. Used only in
     * reset() on a **brand-new page**; swapping projects in place on a used page leaves animation
     * anchors and mounted cards from the previous pass, failing to yield frame 0.
     */
    async loadProject(project, options = {}) {
      await page.evaluate((p, o) => window.__pcLoadProject(p, o), project, options);
      await waitReady();
    },
  };
}

/**
 * chrome-headless-shell version required by this puppeteer release. Read from puppeteer-core's
 * revisions table: the same source desktop/scripts/prepare-runtime.mjs reads Chrome versions from,
 * ensuring both sides match.
 */
async function headlessShellBuildId() {
  const { createRequire } = await import('node:module');
  const require_ = createRequire(import.meta.url);
  const pkgDir = path.dirname(require_.resolve('puppeteer-core/package.json'));
  for (const rel of ['lib/esm/puppeteer/revisions.js', 'lib/cjs/puppeteer/revisions.js', 'lib/puppeteer/revisions.js']) {
    const f = path.join(pkgDir, rel);
    if (!fsSync.existsSync(f)) continue;
    const src = fsSync.readFileSync(f, 'utf8');
    const m = src.match(/['"]chrome-headless-shell['"]\s*:\s*['"]([^'"]+)['"]/) || src.match(/\bchrome\s*:\s*['"]([^'"]+)['"]/);
    if (m) return m[1];
  }
  throw new Error('Cannot read the chrome-headless-shell version of puppeteer-core');
}

/** Installed only once when opening bakery concurrently (chunked export) in the same process */
let installingShell = null;

/** Install chrome-headless-shell into puppeteer's cache directory (desktop app = runtime/chrome) */
async function installHeadlessShell() {
  installingShell ??= (async () => {
    const os = await import('node:os');
    const { install, Browser, detectBrowserPlatform } = await import('@puppeteer/browsers');
    const cacheDir = process.env.PUPPETEER_CACHE_DIR || path.join(os.homedir(), '.cache', 'puppeteer');
    const buildId = await headlessShellBuildId();
    console.log(`Installing chrome-headless-shell@${buildId} to ${cacheDir} (about 100 MB, installed only once)…`);
    await install({ browser: Browser.CHROMEHEADLESSSHELL, buildId, cacheDir, platform: detectBrowserPlatform() });
  })();
  try {
    await installingShell;
  } finally {
    installingShell = null;
  }
}

const DEFAULT_URL = 'http://127.0.0.1:5190/?export=1';

/**
 * Open a "prerender room": launch the browser, navigate to the export page, wait for the page to
 * be ready.
 *
 * Split out separately to let the resident process (scripts/render-worker.mjs) reuse the same
 * browser: cold start takes several seconds, while reuse only needs switching a page. How to
 * reuse: call `await bakery.reset(project, url)` once before each frame-rendering pass, then
 * bakeFrames.
 */
export async function openBakery(opts = {}) {
  const url = opts.url || DEFAULT_URL;

  console.log('Launching Puppeteer (chrome-headless-shell)...');
  const sandboxOff = noSandboxReason();
  if (sandboxOff) console.log(`Chrome launched with --no-sandbox (reason: ${sandboxOff})`);
  const launch = () => puppeteer.launch({ headless: 'shell', protocolTimeout: 60000, args: chromeLaunchArgs() });
  let browser;
  try {
    browser = await launchHealthyChrome({ launch });
  } catch (e) {
    if (!/could not find/i.test(e?.message || '')) throw e;
    /*
     * Install a copy on the fly if not found. Why this step is needed: the update patch only includes
     * runtime/app (the Node side), not runtime/chrome; users upgrading via patches from 0.3.x only
     * have full Chrome without headless-shell, so export would fail to launch directly.
     * Install into PUPPETEER_CACHE_DIR (desktop app = runtime/chrome), only this once; if installation
     * fails (no network), clearly report what to do.
     */
    console.warn('chrome-headless-shell not found, trying to install it automatically…');
    try {
      await installHeadlessShell();
    } catch (e2) {
      throw new Error(
        'Export needs chrome-headless-shell, which was not found, and the automatic install also failed (' + (e2?.message || e2) + ').' +
        ' For the desktop app, reinstall using the full installer; on a dev machine, run `npx puppeteer browsers install chrome-headless-shell`. Original error:' + e.message,
      );
    }
    browser = await launchHealthyChrome({ launch });
  }

  let session;
  try {
    session = await newSession(browser, url);
  } catch (error) {
    // No caller owns this browser until the bakery object is returned.
    await browser.close().catch(() => {});
    throw error;
  }
  const bakery = {
    browser,
    ...session,
    /**
     * Switch to a new pass: open a brand-new page (optionally injecting the project into it), replace
     * page/client on bakery, then close the old page.
     * The old page must be closed: leaking one unclosed per pass causes renderer processes to leak
     * linearly (0xC0000142 was reproduced on this machine with multiple Chrome instances).
     * `nextUrl` switches to another export page URL before reopening: the resident worker renders a
     * different isolated project each pass, and the project is fetched by the page itself.
     */
    async reset(project, nextUrl, options = {}) {
      // Hook before switching pages (c10a section 9: prerender small size draws on this page to be
      // discarded); errors do not block page switching
      if (typeof bakery.beforeReset === 'function') { try { await bakery.beforeReset(bakery); } catch { /* Small size failure does not block original size */ } }
      const old = bakery.page;
      const s = await newSession(browser, nextUrl || url);
      if (project) await s.loadProject(project, options);
      Object.assign(bakery, s);
      await old.close();
    },
    /**
     * Standby page: a **brand-new** page opened in advance, parked on an empty project. When a job
     * arrives, resetWith injects the project in place.
     *
     * Why it is worth it: in the preparation of a pass, opening a new page + navigation + loading the
     * full module graph + waiting for ready takes ~310 ms, while injecting the project into an already
     * ready new page takes only 3~4 ms (measured: rank-bars / mu-number-ticker / particles).
     * Why it does not break determinism: the standby page is brand-new and has never pushed a frame,
     * just like a freshly opened page; injecting the project takes the `loadProject` path "used only on
     * brand-new pages": measured results show both paths render the same frame byte-for-byte
     * identically (3 cards × 3 runs, 9/9).
     */
    spare: null,
    preload(emptyUrl) {
      if (!bakery.spare) {
        bakery.spare = newSession(browser, emptyUrl);
        bakery.spare.catch(() => {}); // Failure to open the standby page is not reported; resetWith will open one on the fly as a fallback
      }
      return bakery.spare;
    },
    /**
     * Discard the standby page. Once card source code changes, what is loaded in the standby page is
     * the old module: using it to inject the next project renders the old card without error (see
     * invalidate in render-worker).
     */
    dropSpare() {
      const p = bakery.spare;
      bakery.spare = null;
      p?.then((s) => s?.page?.close(), () => {}).catch(() => {});
    },
    /**
     * Switch to a new pass using the standby page (or open an empty project page on the fly if none),
     * then inject project into it
     */
    async resetWith(project, emptyUrl) {
      if (typeof bakery.beforeReset === 'function') { try { await bakery.beforeReset(bakery); } catch { /* Same as above */ } }
      const old = bakery.page;
      let s = null;
      if (bakery.spare) {
        const p = bakery.spare;
        bakery.spare = null;
        s = await p.catch(() => null);
      }
      if (!s) s = await newSession(browser, emptyUrl);
      await s.loadProject(project);
      Object.assign(bakery, s);
      await old.close();
    },
    /**
     * Legacy pipeline interface for "releasing virtual time". There is no virtual time here; kept as a
     * no-op so legacy callers do not need changes.
     */
    releaseClock: async () => {},
    close: () => browser.close(),
  };
  return bakery;
}

export { DEFAULT_URL };
