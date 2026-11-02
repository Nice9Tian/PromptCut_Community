/**
 * Unit tests for server/web/.
 *
 * Here we **do not launch a real browser**: launching a headed Chrome takes hundreds of
 * milliseconds and requires network access to have pages to test; putting it into npm test
 * would turn the entire test suite from 6 seconds into minutes. Verification of the real browser
 * goes through scripts/web-check.mjs (run manually, with network). What is tested here is the
 * half that does not depend on a browser: coordinate conversion, rejection phrasing, parameter
 * validation, and the behavior of the action layer after page is replaced with a fake object.
 *
 * The fake page only implements those few methods that are used. **Intentionally not made into
 * a generic mock**: if session.mjs ever calls an extra puppeteer method someday, this will blow
 * up directly with a TypeError instead of silently returning undefined to let tests pretend to pass.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { scaleOf, captureView, liveViewport } from '../web/view.mjs';
import { explain } from '../web/hit.mjs';
import * as session from '../web/session.mjs';

// ── Coordinate conversion ──────────────────────────────────────────────
// This group is the foundation of the whole module: coordinates on the image must uniquely map
// back to page coordinates. Uniform scaling (a single scale) is the prerequisite: once the aspect
// ratios of the two axes differ, coordinates reported by the model cannot be reversed.

test('The long side is scaled to 800, the short side proportionally', () => {
  assert.equal(scaleOf({ width: 1280, height: 800 }), 800 / 1280);
  // Portrait viewport: long edge is height, calculated by height
  assert.equal(scaleOf({ width: 600, height: 1200 }), 800 / 1200);
});

test('When the viewport is smaller than 800, it is given as is, without upscaling', () => {
  // Upscaling only makes images larger and more expensive without adding a single pixel of information
  assert.equal(scaleOf({ width: 640, height: 480 }), 1);
  assert.equal(scaleOf({ width: 800, height: 600 }), 1);
});

test('Both axes share one scale: the aspect ratio is unchanged', () => {
  const vp = { width: 1280, height: 800 };
  const s = scaleOf(vp);
  const img = { w: vp.width * s, h: vp.height * s };
  assert.ok(Math.abs(img.w / img.h - vp.width / vp.height) < 1e-9,
    'The image and the viewport must have the same aspect ratio, otherwise the coordinates reported by the model, mapped back, would be off by different amounts on the two axes');
});

// ── Screenshots must not touch the viewport ──────────────────────────
// This is a regression test. The previous version modified deviceScaleFactor for scaling, which
// in a headed window was a real window resize: it hung while the page was navigating, and in actual
// tests web_view stalled for the full 45-second timeout before returning. After switching to
// clip.scale, the viewport does not budge at all. Once the viewport is touched, the coordinate
// system of elementFromPoint changes with it, throwing off all hit detection, so this must be
// locked down tight.

test('captureView never calls setViewport; scaling relies on clip.scale', async () => {
  const calls = [];
  const page = {
    viewport: () => ({ width: 1280, height: 800 }),
    setViewport: async (v) => { calls.push(v); },
    waitForFunction: async () => {},
    evaluate: async () => ({ items: [], total: 0, url: 'https://x.test/', title: 'x' }),
    screenshot: async (opts) => { calls.push({ screenshot: opts }); return 'ZmFrZQ=='; },
  };
  const out = await captureView(page);
  assert.equal(calls.filter((c) => !c.screenshot).length, 0,
    'setViewport should never be called: in a headed window it is a real resize and hangs during navigation');
  const shot = calls.find((c) => c.screenshot).screenshot;
  assert.equal(shot.clip.scale, 800 / 1280, 'Scaling must be handed to clip.scale');
  assert.equal(shot.clip.width, 1280);
  assert.equal(shot.clip.height, 800);
  assert.equal(out.image.width, 800);
  assert.equal(out.image.height, 500, '1280x800: the long side is scaled to 800, and the short side proportionally is 500');
});

test('captureView waits for the page readyState, but still captures if it never arrives', async () => {
  let waited = false;
  const page = {
    viewport: () => ({ width: 1280, height: 800 }),
    waitForFunction: async () => { waited = true; throw new Error('timeout'); },
    evaluate: async () => ({ items: [], total: 0, url: 'u', title: 't' }),
    screenshot: async () => 'ZmFrZQ==',
  };
  const out = await captureView(page);
  assert.ok(waited, 'It must wait for the load state first');
  assert.ok(out.__image.base64, 'Even if the wait times out, an image must still be given: half an image is more useful than a timeout message');
});

test('The shape of __image must be the one the harness recognizes', async () => {
  const page = {
    viewport: () => ({ width: 1280, height: 800 }),
    waitForFunction: async () => {},
    evaluate: async () => ({ items: [], total: 0, url: 'u', title: 't' }),
    screenshot: async () => 'ZmFrZQ==',
  };
  const out = await captureView(page);
  // Both agent.mjs and mcp-server.mjs extract images by __image.base64 / __image.mime; changing field
  // names is equivalent to dumping base64 into history as plain text, blowing up the context with
  // hundreds of thousands of characters
  assert.equal(typeof out.__image.base64, 'string');
  assert.match(out.__image.mime, /^image\//);
});

// ── Rejection phrasing ──────────────────────────────────────────────────
// When hit detection rejects, the sentence returned to the model is its sole basis for the next step.
// Testing it is not about testing phrasing, but testing that **every kind of rejection provides an
// actionable next step**.

test('Coordinates reported before any screenshot: tell it to run web_view first', () => {
  const msg = explain({ ok: false, reason: 'no_snapshot' });
  assert.match(msg, /web_view/);
});

test('Clicking on blank space: say what is there, and give two options', () => {
  const msg = explain({ ok: false, reason: 'empty', saw: 'This is a paragraph of body text' });
  assert.match(msg, /This is a paragraph of body text/);
  assert.match(msg, /u/, 'It must hint that u can be used to specify the target directly');
});

test('Multiple candidates: each one carries a directly callable u', () => {
  const msg = explain({
    ok: false, reason: 'ambiguous',
    cands: [
      { u: 'e7', n: 'CSS', t: 'button', b: [183, 79, 229, 107], d: 0 },
      { u: 'e6', n: 'HTML', t: 'button', b: [128, 79, 183, 107], d: 2 },
    ],
  });
  assert.match(msg, /u="e7"/);
  assert.match(msg, /u="e6"/);
  assert.match(msg, /web_click/, 'It must say explicitly to specify with web_click, so it does not have to guess the next step');
});

test('Candidates covered by a layer above must be flagged', () => {
  const msg = explain({
    ok: false, reason: 'ambiguous',
    cands: [{ u: 'e3', n: 'Download', t: 'a', b: [0, 0, 10, 10], d: 0, stacked: true }],
  });
  assert.match(msg, /covered/, 'Clicking directly on an element underneath a popup gets intercepted, so a warning is required');
});

test('expect does not match: echo expect back verbatim so the model knows what it was looking for', () => {
  const msg = explain({
    ok: false, reason: 'expect_mismatch', expect: 'Log in',
    cands: [{ u: 'e1', n: 'Sign up', t: 'a', b: [0, 0, 10, 10], d: 4 }],
  });
  assert.match(msg, /Log in/);
  assert.match(msg, /Sign up/);
});

test('No message is produced when the hit succeeds', () => {
  assert.equal(explain({ ok: true, pick: { u: 'e1' } }), null);
});

// ── Parameter validation of the action layer ─────────────────────────

test('web_click given neither u nor coordinates: rejected on the spot, without touching the page', async () => {
  // Passing null for page: if the implementation touches the page before validating, this throws
  // TypeError instead of getting a clean error
  const r = await session.click(null, {});
  assert.equal(r.ok, false);
  assert.match(r.error, /u/);
  assert.match(r.error, /x,y/);
});

test('web_click given only x and no y also counts as no coordinates', async () => {
  const r = await session.click(null, { x: 100 });
  assert.equal(r.ok, false);
});

test('When web_type cannot find the number, it says explicitly that numbers expire with the screenshot', async () => {
  const page = { $: async () => null };
  const r = await session.type(page, { u: 'e99', text: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /web_view/, 'It must tell the model to take a new screenshot, otherwise it will keep retrying with the same dead number');
});

test('When web_click gets a number that does not exist, it likewise explains the reason', async () => {
  const page = { $: async () => null };
  const r = await session.click(page, { u: 'e99' });
  assert.equal(r.ok, false);
  assert.match(r.error, /e99/);
  assert.match(r.error, /web_view/);
});

// ── Serial queue ──────────────────────────────────────────────────────

test('enqueue is strictly serial: the next one must wait for the previous one to finish', async () => {
  const order = [];
  const slow = session.enqueue(async () => {
    order.push('slow-start');
    await new Promise((r) => setTimeout(r, 30));
    order.push('slow-end');
  });
  const fast = session.enqueue(async () => { order.push('fast'); });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ['slow-start', 'slow-end', 'fast']);
});

test('An error thrown by the previous one does not jam the queue', async () => {
  await session.enqueue(async () => { throw new Error('boom'); }).catch(() => {});
  const r = await session.enqueue(async () => 'still alive');
  assert.equal(r, 'still alive');
});

// ── Handoff ────────────────────────────────────────────────────────────

test('web_handoff moves the window into view and explicitly requires the agent to stop', async () => {
  const calls = [];
  const inst = {
    cdp: { send: async (m, p) => { calls.push({ m, s: p?.bounds?.windowState, left: p?.bounds?.left }); } },
    page: { bringToFront: async () => calls.push({ m: 'front' }) },
    windowId: 1,
  };
  const r = await session.handoff(inst, { reason: 'Bilibili QR code login' });
  assert.equal(r.ok, true);
  assert.equal(r.visible, true);
  assert.match(r.message, /Bilibili QR code login/);
  assert.match(r.message, /Do not keep calling tools/, 'The agent must stop and wait for a person, and must not keep clicking on its own');

  // Tested on Windows: moving the window back onscreen directly leaves it hidden: must do minimized
  // first then normal (see showWindow comment)
  assert.equal(calls[0].s, 'minimized', 'The first step must be minimized, otherwise the window cannot be seen even if its position is right');
  assert.ok(calls.some((c) => c.s === 'normal'), 'It must be restored to normal');
  const placed = calls.find((c) => typeof c.left === 'number');
  assert.ok(placed && placed.left >= 0, 'The position must be placed on screen at least once');
  assert.ok(calls.some((c) => c.m === 'Emulation.clearDeviceMetricsOverride'),
    'When handing over to a person, viewport emulation must be removed, otherwise the displayed content does not grow when the window is enlarged');
  noStateWithPosition(calls);
});

/**
 * **State and position must never be crammed into the same setWindowBounds.**
 *
 * This is not a matter of style, but CDP's actual behavior: when both are given together, it only
 * recognizes state and drops position entirely.
 * Verified in practice (Windows 11, logged bounds step by step):
 *   After minimized                   {"left":-32000,...,"windowState":"minimized"}
 *   normal + left:120 sent at once    {"left":-32000,...,"windowState":"normal"}   ← Position did not take effect
 *   Send bounds separately after restore  {"left":120,"top":80,...}                 ← Only then is it correct
 *
 * The consequence of making this mistake is **silent**: in showWindow the window stays offscreen,
 * while the agent thinks it was already handed over to the user; in hideWindow (after user
 * maximized) the window stays onscreen, while the agent thinks it is hidden. Neither side throws
 * an error, so only this test stands guard.
 */
function noStateWithPosition(calls) {
  for (const c of calls) {
    if (c.m !== 'Browser.setWindowBounds') continue;
    assert.ok(!(c.s && typeof c.left === 'number'),
      `setWindowBounds was given both windowState=${c.s} and left=${c.left}: the position will be dropped by CDP`);
  }
}

test('web_handoff hide:true hides the window back off-screen', async () => {
  const calls = [];
  const inst = {
    cdp: { send: async (m, p) => { calls.push({ m, s: p?.bounds?.windowState, left: p?.bounds?.left }); } },
    page: { bringToFront: async () => {}, setViewport: async () => {} },
    windowId: 1,
  };
  const r = await session.handoff(inst, { hide: true });
  assert.equal(r.visible, false);
  const placed = calls.find((c) => typeof c.left === 'number');
  assert.ok(placed && placed.left < 0, 'Hiding it again must use negative coordinates');
  // The user may have maximized the window during takeover, when hide is a real state change:
  // likewise cannot be sent together with position
  noStateWithPosition(calls);
});

// ── Browser takeover after hot restart ────────────────────────────────
// The cause was a real bug reported by that parallel session: under dev, Vite hot restart replaces
// browser.mjs with a new copy, resetting the module-level instance to zero, **but the Chrome
// launched by the previous copy is still alive and still holds out/web-profile**. Afterward, all
// web_* report "occupied by another instance" until manually killing that Chrome. Reproduced and
// fixed. What is locked here is the criterion for "how to distinguish orphans from those being used
// by others": judging wrong means closing someone else's browser.

test('closeBrowser only disconnects a shared instance and does not close the browser on behalf of others', async () => {
  const acts = [];
  const fake = {
    connected: true,
    close: async () => acts.push('close'),
    disconnect: async () => acts.push('disconnect'),
  };
  // Directly construct a shared instance to test the branch: launching a real browser is too slow,
  // and what needs to be locked here is the branch itself
  const mod = await import('../web/browser.mjs?shared-test=1');
  await mod.getBrowser({
    dataDir: null,
    puppeteer: {
      launch: async () => ({
        ...fake,
        pages: async () => [{
          url: () => 'about:blank',
          setViewport: async () => {},
          createCDPSession: async () => ({ send: async () => ({ windowId: 1 }) }),
        }],
      }),
    },
  });
  await mod.closeBrowser();
  assert.deepEqual(acts, ['close'], 'One it launched itself should really be closed');
});

test('A taken-over instance carries userDataDir so that close can also clean up the stale endpoint file', async () => {
  // Verified: after Chrome exits cleanly, DevToolsActivePort does not disappear on its own (true on
  // Windows). Leaving it behind causes no errors (fails to connect next time and falls back to launch),
  // but wastes a connection round-trip at the start of every session.
  const mod = await import('../web/browser.mjs?udd-test=1');
  const inst = await mod.getBrowser({
    dataDir: null,
    puppeteer: {
      launch: async (opts) => ({
        connected: true,
        close: async () => {},
        pages: async () => [{
          url: () => 'about:blank',
          setViewport: async () => {},
          createCDPSession: async () => ({ send: async () => ({ windowId: 1 }) }),
        }],
        _opts: opts,
      }),
    },
  });
  // When dataDir is null, profile directory should not be created, so userDataDir is undefined
  assert.equal(inst.userDataDir, undefined, 'Passing null for dataDir means nothing is written to disk, so the login state must not remain');
  assert.equal(inst.shared, false);
  await mod.closeBrowser();
});

// ── Shell mode: agent browser is a child webview in Tauri main window ────
// The desktop shell enables --remote-debugging-port for WebView2, passing the port via
// PROMPTCUT_AGENT_CDP. When this variable exists, getBrowser connects instead of launches,
// recognizing the agent part by initial URL; show / hide no longer touches the window (there is no
// window to touch in the shell), only returning a shell flag to let the frontend invoke shell commands.

function fakeShellPuppeteer(acts, pagesList) {
  return {
    launch: async () => { acts.push('launch'); throw new Error('Shell mode must not launch'); },
    connect: async (opts) => {
      acts.push(['connect', opts.browserURL]);
      return {
        connected: true,
        pages: async () => pagesList,
        disconnect: async () => acts.push('disconnect'),
        close: async () => acts.push('close'),
      };
    },
  };
}
/** Pages with agent true carry the window.__PROMPTCUT_AGENT__ flag injected by the shell */
const fakePage = (url, agent = false) => ({
  url: () => url,
  evaluate: async () => agent,
  setViewport: async () => {},
  bringToFront: async () => {},
  createCDPSession: async () => ({ send: async (m) => { return m === 'Browser.getWindowForTarget' ? { windowId: 1 } : {}; } }),
});

test('Shell mode: connect to the debugging port via PROMPTCUT_AGENT_CDP, recognize the agent\'s pane by the injected marker (its address is no longer the initial one), and do not launch', async () => {
  process.env.PROMPTCUT_AGENT_CDP = '9333';
  process.env.PROMPTCUT_AGENT_URL = 'about:blank#promptcut-agent';
  try {
    const acts = [];
    const mod = await import('../web/browser.mjs?shell-test=1');
    const inst = await mod.getBrowser({
      dataDir: null,
      // The agent part has navigated to Bilibili, with only the flag remaining; main editor page has no flag
      puppeteer: fakeShellPuppeteer(acts, [fakePage('http://127.0.0.1:5210/'), fakePage('https://www.bilibili.com/', true)]),
    });
    assert.deepEqual(acts, [['connect', 'http://127.0.0.1:9333']]);
    assert.equal(inst.shell, true);
    assert.equal(inst.shared, true, 'The browser belongs to the shell, so on close it can only disconnect itself');
    assert.equal(inst.page.url(), 'https://www.bilibili.com/', 'It recognizes the marked agent pane, not the editor\'s main page');
    // Show / hide only returns the flag
    assert.deepEqual(await mod.showWindow(inst), { shell: true });
    assert.deepEqual(await mod.hideWindow(inst), { shell: true });
    await mod.closeBrowser();
    assert.ok(acts.includes('disconnect') && !acts.includes('close'), 'The shell\'s browser must not be closed by Node');
  } finally {
    delete process.env.PROMPTCUT_AGENT_CDP;
    delete process.env.PROMPTCUT_AGENT_URL;
  }
});

test('Shell mode: if the port cannot be reached, fall back to the Chrome path', async () => {
  process.env.PROMPTCUT_AGENT_CDP = '9333';
  try {
    const acts = [];
    const mod = await import('../web/browser.mjs?shell-fallback-test=1');
    const inst = await mod.getBrowser({
      dataDir: null,
      puppeteer: {
        connect: async () => { acts.push('connect'); throw new Error('ECONNREFUSED'); },
        launch: async () => {
          acts.push('launch');
          return { connected: true, close: async () => {}, pages: async () => [fakePage('about:blank')] };
        },
      },
    });
    assert.deepEqual(acts, ['connect', 'launch']);
    assert.equal(inst.shell, undefined);
    await mod.closeBrowser();
  } finally {
    delete process.env.PROMPTCUT_AGENT_CDP;
  }
});

test('In shell mode handoff carries the shell flag, and the wording no longer says "window"', async () => {
  const inst = { shell: true, cdp: { send: async () => {} }, page: { setViewport: async () => {} } };
  const r = await session.handoff(inst, { reason: 'Log in' });
  assert.equal(r.shell, true);
  assert.equal(r.visible, true);
  assert.match(r.message, /in the main editor window/);
  const h = await session.handoff(inst, { hide: true });
  assert.equal(h.shell, true);
  assert.equal(h.visible, false);
});

// ── Shell mode: size source when viewport emulation is cleared ────────
// The cause was a reminder from a parallel session: in shell mode, when web_handoff hands the panel
// to the user it calls setViewport(null), at which point page.viewport() returns null. Originally
// screenshots and hit detection each fell back to constant 1280x800, causing two types of failure:
// screenshot clip went out of bounds and reapplied emulation (the screen the user was looking at
// shifted immediately), and hit detection calculated inversely with the wrong dimensions (**clicks
// silently landed on the wrong position**, which is worse than shifting). Now both go through
// liveViewport; these tests lock it down.

test('With emulation active, use the emulated size directly instead of asking the page', async () => {
  let asked = false;
  const page = {
    viewport: () => ({ width: 1280, height: 800 }),
    evaluate: async () => { asked = true; return { width: 1, height: 1 }; },
  };
  const vp = await liveViewport(page);
  assert.deepEqual(vp, { width: 1280, height: 800 });
  assert.equal(asked, false, 'If one is already available, skip the extra evaluate round trip');
});

test('When emulation is removed (viewport is null), use the size measured from the page', async () => {
  const page = {
    viewport: () => null,
    evaluate: async () => ({ width: 960, height: 620 }),
  };
  assert.deepEqual(await liveViewport(page), { width: 960, height: 620 });
});

test('Fall back to the constant only when measuring fails, and do not throw', async () => {
  const page = { viewport: () => null, evaluate: async () => { throw new Error('The page crashed'); } };
  assert.deepEqual(await liveViewport(page), { width: 1280, height: 800 });
});

test('The screenshot and hit detection must derive the same scale: otherwise clicks are all offset', async () => {
  // This is the focus of this test group: both sides **share a single size source**. When each fell
  // back to constants, screenshots on a 960-wide panel were calculated as 1280, and coordinates
  // reported by the model drifted horizontally by 33% when reversed.
  const panel = { width: 960, height: 620 };
  const page = { viewport: () => null, evaluate: async () => panel };
  const fromView = scaleOf(await liveViewport(page));
  const fromHit = scaleOf(await liveViewport(page));
  assert.equal(fromView, fromHit);
  assert.equal(fromView, 800 / 960, 'The long side is the width, 960, so the scale should be computed from 960');
});

test('The clip of captureView follows the measured size, so it never goes out of bounds', async () => {
  // When clip is larger than the real viewport, puppeteer enables captureBeyondViewport, which
  // reapplies device metrics emulation: the exact direct cause of screen shifting when the user
  // operates the panel
  let clip;
  const page = {
    viewport: () => null,
    waitForFunction: async () => {},
    evaluate: async (fn) => (typeof fn === 'function' && fn.length === 0
      ? { width: 960, height: 620 }
      : { items: [], total: 0, url: 'u', title: 't' }),
    screenshot: async (o) => { clip = o.clip; return 'ZmFrZQ=='; },
  };
  const out = await captureView(page);
  assert.equal(clip.width, 960, 'The clip width must be the measured 960, not the constant 1280');
  assert.equal(clip.height, 620);
  assert.equal(out.image.width, 800);
  assert.equal(out.image.height, Math.round(620 * (800 / 960)));
});
