/**
 * Browser instance for the agent. **Two different things from frame rendering, do not merge.**
 *
 * The difference is not purism, but three hard conflicts:
 *
 * 1. **Opposite launch arguments**. server/bakery/chrome.mjs carries a full suite of flags tuned
 *    for byte-level reproducibility (--disable-gpu-rasterization / --disable-partial-raster /
 *    --disable-threaded-animation) so exporting the same timeline twice matches byte-for-byte. Web
 *    browsing requires normal rendering: site lazy loading, animations, and GPU compositing must
 *    run normally, otherwise what is seen differs from what users see in their own browser.
 * 2. **Profile must be isolated**. Browsing needs to store cookies and login state (the cookie
 *    after Bilibili QR code login is what media collection uses), while export needs a blank slate.
 *    Sharing user-data-dir will corrupt each other sooner or later.
 * 3. **Different lifecycles**. Export and image viewing close after use, whereas browsing is
 *    long-lived: pages opened by the agent in the previous turn must be clicked in the next.
 *
 * ## Why "headed + offscreen" instead of headless
 *
 * Web operations inevitably hit logins, CAPTCHAs, cookie consent, and paywalls. These **should not
 * and cannot be delegated to the agent** (especially CAPTCHAs: humans must click them). Headless
 * has no window and is a dead end when encountered; headed + placed at -32000,-32000 is invisible
 * normally, and when human takeover is needed, CDP Browser.setWindowBounds moves it back onto the
 * screen, then hides it back after handling. Verified in both directions; see showWindow /
 * hideWindow.
 *
 * By the way: headless is more easily blocked by sites as a bot, and rendering differs from headed.
 */
import path from 'node:path';
import fs from 'node:fs';

/** Viewport is fixed to this size so image coordinate scaling is constant; see scaleOf in view.mjs */
export const VIEWPORT = { width: 1280, height: 800 };

/** Model image scales **long edge** to this, short proportional; stretched image coordinates cannot be restored */
export const IMAGE_LONG_EDGE = 800;

/** Position to hide window. Chrome allows negative coords; -32000 is off-screen in any multi-display setup */
const OFFSCREEN = { left: -32000, top: -32000 };

let instance = null;      // { browser, page, cdp, windowId, shared }
let launching = null;     // Concurrent calls share the same launch; avoid starting two browsers

/** Record who started this browser. Used to distinguish "hot-restart orphans" from "in use by another instance" */
const OWNER_FILE = 'promptcut-owner.json';

function ownerPath(userDataDir) {
  return path.join(userDataDir, OWNER_FILE);
}

function writeOwner(userDataDir) {
  try {
    fs.writeFileSync(ownerPath(userDataDir), JSON.stringify({ pid: process.pid, at: Date.now() }));
  } catch { /* Failure to record does not affect usage, only prevents distinguishing orphans next time */ }
}

/**
 * Is the recorded process still alive? Alive and not self = another instance is currently using it.
 *
 * `process.kill(pid, 0)` only probes liveness without sending a signal. Throwing EPERM means **the
 * process exists, but there is no permission to touch it** (e.g. running under another user), which
 * still counts as alive: judging it dead would make us close someone else's browser. Only ESRCH
 * (no such process) means it is truly gone.
 *
 * PIDs are recycled by the system, so this check is not 100% accurate. **However, it fails in a
 * safe direction**: if a recycled PID happens to be taken by someone else, we misidentify the
 * orphan as shared: the only consequence is web_close does not kill that browser, and the next
 * getBrowser re-takes it over, self-healing. The inverse (classifying what someone else is using as
 * an orphan) is what would cause real harm, and that requires their process to happen to be dead,
 * in which case it was supposed to be taken over anyway. So no extra complexity is added here for
 * PID recycling.
 */
function ownerAlive(userDataDir) {
  let pid;
  try {
    ({ pid } = JSON.parse(fs.readFileSync(ownerPath(userDataDir), 'utf8')));
  } catch {
    return false;           // File missing or corrupted: treat as unclaimed
  }
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * Debug endpoint of the still-living Chrome in profile. Returns null if none.
 *
 * When Chrome starts, it writes `<port>\n<ws path>` into DevToolsActivePort in the profile
 * directory. A clean exit deletes it, while being killed leaves a stale file: so even if found,
 * it cannot be taken as truth; treat as absent if connection fails.
 */
function debugEndpoint(userDataDir) {
  try {
    const raw = fs.readFileSync(path.join(userDataDir, 'DevToolsActivePort'), 'utf8');
    const [port, wsPath] = raw.trim().split('\n');
    if (!port || !wsPath) return null;
    return `ws://127.0.0.1:${port}${wsPath}`;
  } catch {
    return null;
  }
}

/**
 * Connect to the agent child webview inside the shell (Tauri main window). Returns null if unable
 * to connect or cannot find that area.
 *
 * Under one WebView2 environment, all webviews share a single debugging endpoint. The listed
 * targets include both the editor main page and the agent area, identified by **initial URL**:
 * the shell uses about:blank#promptcut-agent when creating it; after the agent navigates, the URL
 * changes, so once identified for the first time, remember that page object and no longer search
 * by URL.
 */
async function connectShell(pptr, port, initialUrl) {
  let browser;
  try {
    browser = await pptr.connect({ browserURL: `http://127.0.0.1:${port}`, defaultViewport: null });
  } catch {
    return null;
  }
  try {
    let page = null;
    // Shell creating the webview and sidecar startup run in parallel; give it a few seconds.
    // Which part to identify: the shell injects window.__PROMPTCUT_AGENT__ into the agent area on
    // every navigation, so identify by that first (reconnecting after a hot restart, the agent is
    // long gone from the initial URL); for pages that cannot be evaluated (crashed, cross-origin
    // blocked), fall back to identifying by initial URL.
    for (let i = 0; i < 20 && !page; i++) {
      const pages = await browser.pages();
      for (const p of pages) {
        try {
          if (await p.evaluate(() => window.__PROMPTCUT_AGENT__ === true)) { page = p; break; }
        } catch { /* Cannot evaluate this page, inspect the next */ }
      }
      if (!page) page = pages.find((p) => p.url() === initialUrl) || null;
      if (!page) await new Promise((r) => setTimeout(r, 250));
    }
    if (!page) {
      await browser.disconnect();
      return null;
    }
    await page.setViewport(VIEWPORT);
    const cdp = await page.createCDPSession();
    // shared: this browser belongs to shell, disconnect self only; shell: show/hide uses shell commands
    return { browser, page, cdp, windowId: null, shared: true, shell: true, userDataDir: undefined };
  } catch {
    try { await browser.disconnect(); } catch { /* Ignore */ }
    return null;
  }
}

/**
 * Close the browser. **Not done here**: process exit fallback, which is Tauri's job killing the
 * whole process tree (see sidecar pid in desktop/src-tauri/src/lib.rs); here we only handle active
 * closes.
 *
 * `shared` instances are taken over while the original owner is still alive: only disconnect our
 * own side, do not close the browser on someone else's behalf.
 */
export async function closeBrowser() {
  const cur = instance;
  instance = null;
  launching = null;
  if (!cur) return;
  try {
    if (cur.shared) await cur.browser.disconnect();
    else await cur.browser.close();
  } catch { /* Already dead, ignore */ }

  // Verified: DevToolsActivePort is **not** deleted by Chrome after clean shutdown (at least on
  // Windows). Leaving it causes no errors: next getBrowser falls back to launch if connection fails,
  // but that wastes a connection round-trip at the start of every session. Delete it ourselves to
  // keep the happy path clean. Do not delete shared: that endpoint belongs to others and is in use.
  if (!cur.shared && cur.userDataDir) {
    try { fs.rmSync(path.join(cur.userDataDir, 'DevToolsActivePort'), { force: true }); } catch { /* Doesn't matter if deletion fails */ }
  }
}

/**
 * Get the browser and current page. Start one if not yet running.
 *
 * `dataDir` holds the profile. Passing null uses a temporary directory (for tests), so login
 * state is not persisted.
 *
 * ## Why try to "take over" first instead of launching directly
 *
 * The same user-data-dir cannot be occupied by two Chrome instances at once. In dev, Vite hot
 * reload replaces this module with a fresh copy: module-level `instance` resets to zero, **but the
 * Chrome process launched by the previous copy is still alive and holds the profile**. Then all
 * subsequent web_* calls report "occupied by another instance" until manually killing Chrome.
 * Editing files under server/ hits this every time, almost guaranteed during development.
 *
 * Therefore, inspect DevToolsActivePort in profile first: if connectable, take over that browser
 * directly; if connection fails (a dead record left from last kill), launch instead.
 *
 * After takeover, two cases must be distinguished using the owner record in profile:
 *   - Original owner process is gone → **orphan**, take over fully, web_close should actually
 *     shut it down;
 *   - Original owner is still alive → another PromptCut instance is running, mark `shared`,
 *     web_close only disconnects our side without closing the browser for others.
 */
export async function getBrowser({ dataDir, puppeteer, executablePath } = {}) {
  if (instance) {
    // User might have closed the window. Restart if unreachable, don't hand out a dead instance
    if (instance.browser.connected !== false) return instance;
    instance = null;
  }
  if (launching) return launching;

  launching = (async () => {
    const pptr = puppeteer || (await import('puppeteer')).default;

    // ── Shell mode: agent browser is a child webview in the Tauri main window ──
    // When the desktop shell starts, it enables --remote-debugging-port for WebView2, passing the port
    // via an environment variable.
    // Among targets listed on that endpoint, the one whose initial URL is PROMPTCUT_AGENT_URL
    // belongs to the agent.
    // Showing / hiding is handled by frontend invoking shell commands (see showWindow / hideWindow);
    // this only handles connecting.
    const shellPort = Number(process.env.PROMPTCUT_AGENT_CDP || 0);
    if (shellPort > 0) {
      const inst = await connectShell(pptr, shellPort, process.env.PROMPTCUT_AGENT_URL || 'about:blank#promptcut-agent');
      if (inst) { instance = inst; return inst; }
      // If connection fails, launch Chrome as usual: if the shell did not create the webview, at least
      // there is still the fallback path
      process.stderr.write(`[web] cannot connect to the agent webview in the shell (port ${shellPort}), falling back to Chrome\n`);
    }

    const userDataDir = dataDir ? path.join(dataDir, 'web-profile') : undefined;
    if (userDataDir) fs.mkdirSync(userDataDir, { recursive: true });

    // ── Try takeover first ──
    const endpoint = userDataDir ? debugEndpoint(userDataDir) : null;
    if (endpoint) {
      try {
        const browser = await pptr.connect({ browserWSEndpoint: endpoint, defaultViewport: null });
        const shared = ownerAlive(userDataDir);
        const pages = await browser.pages();
        const page = pages.find((p) => !p.url().startsWith('devtools://')) || await browser.newPage();
        await page.setViewport(VIEWPORT);
        const cdp = await page.createCDPSession();
        const { windowId } = await cdp.send('Browser.getWindowForTarget');
        // If orphaned, change owner to itself so the next hot restart will not treat it as "someone else's"
        if (!shared) writeOwner(userDataDir);
        instance = { browser, page, cdp, windowId, shared, userDataDir };
        return instance;
      } catch {
        // Cannot connect = DevToolsActivePort is a dead file left from the previous kill; proceed with
        // launch as usual
      }
    }

    /*
     * The same user-data-dir cannot be occupied by two Chrome instances at once. This also happens in
     * normal usage: the user opens two PromptCut instances (or runs scripts/web-check.mjs on the side),
     * and agents on both sides want internet access. What puppeteer throws as-is is cryptic English
     * that users cannot understand or act upon, so we translate it here into actionable instructions.
     */
    const launch = (opts) => pptr.launch(opts).catch((e) => {
      if (/already running for/i.test(String(e.message))) {
        throw new Error(
          'The browser is already in use by another PromptCut instance (they share the same login state and cannot be open at the same time).'
          + ' Close the other window, or call web_close there first and try again.',
        );
      }
      throw e;
    });

    const browser = await launch({
      headless: false,
      // Specify the path explicitly instead of relying on PUPPETEER_CACHE_DIR inheritance. Reason: this
      // variable is only set in official Tauri packages (lib.rs:338). Under dev, puppeteer uses the dev
      // machine's ~/.cache/puppeteer: if both versions happen to match, nothing breaks; once they differ,
      // it causes extremely elusive bugs like "the running binary is not the bundled one".
      ...(executablePath ? { executablePath } : {}),
      userDataDir,
      args: [
        `--window-position=${OFFSCREEN.left},${OFFSCREEN.top}`,
        `--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
        '--no-first-run',
        '--no-default-browser-check',
        // What users first see should not be Chrome's own UI: suppress both the "Sign in to Chromium"
        // welcome page on a new profile and the "Restore pages?" bubble after an ungraceful kill.
        // Chrome ignores unrecognized feature names, so listing a few extra candidates is harmless.
        '--hide-crash-restore-bubble',
        '--disable-session-crashed-bubble',
        // Pages opened by the agent autoplay videos, making sound while the user is not watching. The Chrome
        // path cannot toggle this at runtime, so mute completely throughout; only shell mode (WebView2)
        // has a switch to unmute when handing over to the user.
        '--mute-audio',
        '--disable-sync',
        '--disable-features=Translate,MediaRouter,ForYouFre,SigninPromo,ChromeWhatsNewUI',
        // Do **not** add the export determinism parameters here; see file header for rationale
      ],
      defaultViewport: null,   // Let the page viewport follow the window, rather than having puppeteer wrap another layer
    });

    const pages = await browser.pages();
    const page = pages[0] || await browser.newPage();
    await page.setViewport(VIEWPORT);

    const cdp = await page.createCDPSession();
    const { windowId } = await cdp.send('Browser.getWindowForTarget');

    if (userDataDir) writeOwner(userDataDir);
    instance = { browser, page, cdp, windowId, shared: false, userDataDir };
    return instance;
  })();

  try {
    return await launching;
  } finally {
    launching = null;
  }
}

/** Whether an instance is currently alive. Inspect only, do not launch: checking login state should not start Chrome just to "take a look" */
export function peekBrowser() {
  if (instance && instance.browser.connected !== false) return instance;
  return null;
}

/**
 * Whether there is a browser in the profile that might **possibly** still be alive to take over
 * (DevToolsActivePort exists). For callers that "only want to read, not launch": if so, feel free to
 * call getBrowser (it will take over instead of starting a new one); if not, do not call it, as
 * that will actually start Chrome. The file may be dead, hence only "possibly".
 */
export function existingEndpoint(dataDir) {
  if (!dataDir) return null;
  return debugEndpoint(path.join(dataDir, 'web-profile'));
}

/** Move window onto the screen and hand over to user. Login, CAPTCHA, and cookie consent all use this */
export async function showWindow(inst, { left = 120, top = 80 } = {}) {
  // Shell mode: webview is inside the main window, and its position is determined by frontend
  // invoking shell commands; this only clears viewport emulation.
  // Must use page.setViewport(null): calling Emulation.clearDeviceMetricsOverride directly only works
  // for the moment; puppeteer remembers 1280×800 and reapplies it on the next navigation: tested and
  // verified, this is exactly why the right and bottom of the page became misaligned.
  if (inst.shell) {
    try { await inst.page.setViewport(null); } catch { /* Older versions do not recognize null; fall back to raw call */ }
    try { await inst.cdp.send('Emulation.clearDeviceMetricsOverride'); } catch { /* Ignore */ }
    return { shell: true };
  }
  /*
   * Verified in testing (2026-09-08, Windows 11): for a window launched at -32000,-32000, simply moving
   * it back onto the screen using setWindowBounds is **not enough**: the position changes correctly,
   * but IsWindowVisible remains false, nothing appears on the user's screen, while bounds look completely
   * normal on the CDP side. Switching to minimized first and then restoring to normal causes Windows to
   * treat this restore as a user action: the window becomes visible and is brought to the foreground.
   * Verified step by step with EnumWindows.
   */
  /*
   * **State and position must be sent in two separate calls.** When CDP's setWindowBounds receives
   * both windowState and left/top in the same call, it **only recognizes state and drops position
   * entirely**. Verified in testing (same as above, logged bounds step by step):
   *
   *   After minimized                          {"left":-32000,...,"windowState":"minimized"}
   *   Sending normal + left:120 together       {"left":-32000,...,"windowState":"normal"}   ← position did not take effect
   *   Sending bounds separately after restore  {"left":120,"top":80,...}                     ← this is correct
   *
   * Therefore the order is: minimized → normal (state only) → send position separately.
   */
  await inst.cdp.send('Browser.setWindowBounds', { windowId: inst.windowId, bounds: { windowState: 'minimized' } });
  await new Promise((r) => setTimeout(r, 150));
  await inst.cdp.send('Browser.setWindowBounds', { windowId: inst.windowId, bounds: { windowState: 'normal' } });
  await new Promise((r) => setTimeout(r, 80));
  await inst.cdp.send('Browser.setWindowBounds', {
    windowId: inst.windowId,
    bounds: { left, top, width: VIEWPORT.width, height: VIEWPORT.height },
  });
  // Bring to foreground after restore as an extra safeguard; failing to take focus does not affect
  // window visibility
  try { await inst.page.bringToFront(); } catch { /* Ignore */ }
  // Clear viewport emulation when handing over to the user: otherwise if the user enlarges the window,
  // the page remains drawn only in that 1280×800 area in the top-left corner
  try { await inst.cdp.send('Emulation.clearDeviceMetricsOverride'); } catch { /* Ignore */ }
}

/** Hide offscreen. Restores fixed viewport on hide: calculating coordinates from images relies on it being constant */
export async function hideWindow(inst) {
  try { await inst.page.setViewport(VIEWPORT); } catch { /* Ignore */ }
  if (inst.shell) return { shell: true };
  /*
   * Same pitfall as showWindow: sending state and position together drops the position (see testing notes
   * above). This remained hidden before because the window was usually already normal; identical state
   * was not considered a change, so position went through. But if the user maximized the window during
   * takeover, this becomes a real state change: position is discarded, window stays on screen, while
   * agent assumes it is hidden. Therefore, split into two steps as well.
   */
  await inst.cdp.send('Browser.setWindowBounds', { windowId: inst.windowId, bounds: { windowState: 'normal' } });
  await inst.cdp.send('Browser.setWindowBounds', {
    windowId: inst.windowId,
    bounds: { ...OFFSCREEN, width: VIEWPORT.width, height: VIEWPORT.height },
  });
}

/** Whether the window is currently on-screen (left >= 0 counts) */
export async function isWindowVisible(inst) {
  const { bounds } = await inst.cdp.send('Browser.getWindowForTarget', { targetId: undefined });
  return bounds.left >= 0;
}
