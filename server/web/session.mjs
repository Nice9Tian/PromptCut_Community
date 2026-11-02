/**
 * Action layer: navigate / click / type / scroll / read content / hand off to user.
 *
 * ## Every action returns a new view
 *
 * Otherwise the model must remember on its own to "look again after clicking", but it often forgets
 * and continues clicking with IDs from three rounds ago. Returning actions and results bundled
 * together ensures IDs are always up to date, eliminating this error at its root.
 * The cost is an extra screenshot per action (about 640 tokens), which is well worth it.
 *
 * ## Why sequential
 *
 * The entire module shares a single browser and a single page; concurrent clicks are meaningless
 * anyway (by the second click, the page has already been modified by the first). A more pragmatic
 * reason is the lesson recorded in the comment in server/vite-plugin-vision.ts: when too many browser
 * instances run concurrently on this machine, the render process exits with 0xC0000142 without
 * reporting a cause. This browser instance is long-running; allowing internal concurrency inside it
 * is just asking for trouble.
 *
 * ## Hand off to humans when hitting a wall
 *
 * Login, captchas, cookie consent: these **should not and cannot be handled by the agent**
 * (captchas especially). detectWall scans after each action; if detected, it states so explicitly
 * in the response and provides the user_interface_web_handoff path. No automatic popups: deciding
 * when to interrupt the user is up to the model, and automatic popups would expose the off-screen
 * browser as a jittery window.
 */
import { captureView } from './view.mjs';
import { resolveAt, explain } from './hit.mjs';
import { showWindow, hideWindow } from './browser.mjs';

/** Wall-clock limit for a single action. Slow sites (Bilibili first screen) often take 10+ seconds, give plenty */
const ACTION_TIMEOUT = 45000;

/** Serial queue. The next item must still be queued even if the previous one fails, so catch first before chaining */
let queue = Promise.resolve();
export function enqueue(job) {
  const next = queue.then(job, job);
  queue = next.catch(() => {});
  return next;
}

/** Wraps calls like page.evaluate that do not have a built-in timeout */
function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${what} did not return within ${ms / 1000} seconds`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/* c8 ignore start - Executed inside page */
function scanWall() {
  const has = (sel) => !!document.querySelector(sel);
  const text = (document.body && document.body.innerText || '').slice(0, 4000);
  const walls = [];
  if (has('input[type=password]')) walls.push('login');
  // Captcha frameworks used by sites: reCAPTCHA / hCaptcha / Cloudflare Turnstile / GeeTest
  if (has('iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare"],.geetest_panel,#captcha,[class*=captcha]')) walls.push('captcha');
  if (/扫码登录|扫描二维码|scan (the )?qr/i.test(text)) walls.push('qrcode'); // i18n-allow
  if (/(cookie|隐私).{0,12}(政策|设置|同意)|accept (all )?cookies|consent/i.test(text) // i18n-allow
      && has('button,[role=button]')) walls.push('consent');
  return walls;
}

function readMain(limit) {
  const pick = document.querySelector('article,main,[role=main]') || document.body;
  const t = (pick.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  return { text: t.slice(0, limit), total: t.length, url: location.href, title: document.title.slice(0, 120) };
}
/* c8 ignore stop */

/** Every action concludes here: scans for walls + outputs a new view */
async function finish(page, extra = {}) {
  const walls = await withTimeout(page.evaluate(scanWall), 10000, 'detect page state');
  const view = await withTimeout(captureView(page), ACTION_TIMEOUT, 'screenshot');
  const out = { ok: true, ...extra, ...view };
  if (walls.length) {
    const names = { login: 'login form', captcha: 'verification code', qrcode: 'QR code login', consent: 'cookie consent bar' };
    out.wall = walls;
    out.wallNote = `This page has ${walls.map((w) => names[w] || w).join(', ')}.`
      + 'Do not handle this yourself: call user_interface_web_handoff to move the browser window in front of the user, and continue after the user has dealt with it.'
      + (walls.includes('captcha') ? 'A captcha must be clicked by the user.' : '');
  }
  return out;
}

/** Opens a link */
export async function open(page, url, { waitUntil = 'domcontentloaded' } = {}) {
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  await page.goto(target, { waitUntil, timeout: ACTION_TIMEOUT });
  return finish(page, { navigated: target });
}

/** Only captures a screenshot and outputs manifest without actions. Waits for page to load, or reviews after scrolling */
export async function view(page) {
  return finish(page);
}

/**
 * Click. Specify `u` directly, or inspect the image and report `x,y` coordinates (strongly
 * recommend providing `expect` as well).
 *
 * Real clicks go through puppeteer Locator: it waits for elements to be visible and clickable,
 * scrolling into the viewport when necessary; coordinate clicks (`Input.dispatchMouseEvent`)
 * ignore all of these.
 */
export async function click(page, { u, x, y, expect } = {}) {
  let uid = u;
  if (!uid) {
    if (typeof x !== 'number' || typeof y !== 'number') {
      return { ok: false, error: 'Give either u, or x,y. x,y are pixel coordinates on the image returned by the last web_view.' };
    }
    const res = await withTimeout(resolveAt(page, x, y, { expect }), 10000, 'hit test');
    if (!res.ok) return { ok: false, error: explain(res), ...(res.cands ? { candidates: res.cands } : {}) };
    uid = res.pick.u;
  }
  const handle = await page.$(`[data-pcuid="${uid}"]`);
  if (!handle) {
    return { ok: false, error: `Cannot find ${uid}. IDs are only valid for the most recent web_view, and become invalid after the page scrolls or navigates: run web_view again first.` };
  }
  const label = await page.evaluate(
    (el) => (el.getAttribute('aria-label') || el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 40),
    handle,
  );
  // Clicks may trigger navigation. During navigation, the old handle becomes invalid, so race
  // navigation and click together: if navigation occurs, wait for it to settle; if no navigation
  // occurs (SPA modifying the DOM), give it a little time to finish rendering.
  const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null);
  await handle.click();
  await nav;
  await new Promise((r) => setTimeout(r, 400));
  return finish(page, { clicked: { u: uid, n: label } });
}

/** Types into an input box. Clears first by default: appending is rarely what the model wants; pass append to append */
export async function type(page, { u, text, append = false, submit = false } = {}) {
  const handle = await page.$(`[data-pcuid="${u}"]`);
  if (!handle) return { ok: false, error: `Cannot find ${u}, run web_view again first.` };
  await handle.click();
  if (!append) {
    await handle.evaluate((el) => { if ('value' in el) el.value = ''; else el.textContent = ''; });
  }
  await handle.type(String(text ?? ''), { delay: 12 });
  if (submit) {
    const nav = page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => null);
    await page.keyboard.press('Enter');
    await nav;
    await new Promise((r) => setTimeout(r, 400));
  }
  return finish(page, { typed: { u, submit } });
}

/** Scrolls. dy is in page pixels (positive goes down); can also use to:"top"/"bottom" */
export async function scroll(page, { dy = 600, to } = {}) {
  await page.evaluate((dy, to) => {
    if (to === 'top') scrollTo({ top: 0 });
    else if (to === 'bottom') scrollTo({ top: document.body.scrollHeight });
    else scrollBy({ top: dy });
  }, dy, to);
  // Sites with lazy loading take a moment to populate content after scrolling
  await new Promise((r) => setTimeout(r, 500));
  return finish(page, { scrolled: to || dy });
}

/**
 * Reads article text. **This action does not return an image**, used for "research": that scenario
 * needs text, not visuals; a 640-token image does not provide more information than plain text.
 */
export async function read(page, { limit = 8000 } = {}) {
  const r = await withTimeout(page.evaluate(readMain, limit), 15000, 'read body text');
  return {
    ok: true, ...r,
    ...(r.total > r.text.length ? { truncated: true, note: `The body text has ${r.total} characters in total, and only the first ${r.text.length} were returned. To get the rest, run web_scroll first and then read again.` } : {}),
  };
}

/**
 * Moves the browser window in front of the user. Login, captchas, QR code scanning, and paywalls
 * all use this route.
 *
 * **No waiting, no blocking**: the agent should not sit here waiting for someone; it should end
 * this round and tell the user what to do. After the user finishes, have the agent call `web_view`
 * to check the current state.
 */
export async function handoff(inst, { reason = '', hide = false } = {}) {
  // shell: the agent browser is a child webview in the desktop shell; actual show/hide is performed
  // by the frontend invoking shell commands, so this only returns the flag. Under the Chrome approach,
  // this is the final action.
  const shell = !!inst.shell;
  if (hide) {
    await hideWindow(inst);
    return { ok: true, visible: false, shell, message: shell ? 'The browser has been put away.' : 'The browser window has been hidden off screen.' };
  }
  await showWindow(inst);
  return {
    ok: true,
    visible: true,
    shell,
    message: (shell
      ? `The browser is now shown in the main editor window${reason ? `(${reason})` : ''}.`
      : `The browser window has been moved onto the user's screen${reason ? `(${reason})` : ''}.`)
      + 'Stop now and tell the user, in their language, what to do and what to say when done. **Do not keep calling tools**, '
      + 'and after the user replies, run web_view to see the current state.',
  };
}
