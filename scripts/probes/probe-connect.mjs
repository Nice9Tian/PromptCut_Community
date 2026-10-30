// Shared plumbing for the browser probes so the same probe can run in two places:
//
//   node scripts/probes/<probe>.mjs                      -> launches puppeteer's own Chrome (unchanged)
//   node scripts/probes/<probe>.mjs --connect            -> attaches to http://127.0.0.1:9333
//   node scripts/probes/<probe>.mjs --connect http://... -> attaches to that CDP endpoint
//
// The `--connect` form is what we use to run a probe inside the desktop shell's
// WebView2 (PROMPTCUT_AGENT_CDP=9333, see desktop/src-tauri/src/agent_webview.rs):
// WebView2 speaks the same debugging protocol, but it will not let us open new
// targets, so in connect mode every case reuses one existing page and navigates it.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const LAUNCH_JSON = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../.claude/launch.json');

/** `--connect [url]` -> endpoint string, or null when the probe should launch Chrome. */
export function connectArg(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--connect');
  if (i === -1) return null;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : 'http://127.0.0.1:9333';
}

/** `--flag value` -> value, or `fallback`. */
export function flagArg(name, fallback = null, argv = process.argv.slice(2)) {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : fallback;
}

/**
 * The dev server a probe attaches to: `--origin`, else `PC_STAGE_TEST_URL`, else the port of
 * the `dev-test` entry in `.claude/launch.json` (the verification server, see
 * docs/semantics/guide_files/verification.md). There is deliberately no hard-coded port to fall
 * back to: the old 5197 went stale and probes quietly hit whatever else was listening there.
 * Throws when none of the three gives an origin.
 */
export function devOrigin(argv = process.argv.slice(2), launchJson = LAUNCH_JSON) {
  const given = flagArg('origin', null, argv) || process.env.PC_STAGE_TEST_URL;
  if (given) return given.replace(/\/+$/, '');
  let port;
  try {
    port = JSON.parse(fs.readFileSync(launchJson, 'utf8')).configurations?.find((c) => c.name === 'dev-test')?.port;
  } catch (e) {
    throw new Error(`读不到 ${launchJson}(${e.message}):用 --origin 或 PC_STAGE_TEST_URL 指定 dev server`);
  }
  if (!Number.isInteger(port)) throw new Error(`${launchJson} 里没有带 port 的 dev-test 配置:用 --origin 或 PC_STAGE_TEST_URL 指定 dev server`);
  return `http://127.0.0.1:${port}`;
}

/**
 * Open a browser. `connect` wins over `launch`.
 * Returns { browser, mode, endpoint, close() }.
 */
export async function openBrowser({ connect, launch } = {}) {
  if (connect) {
    const browser = await puppeteer.connect({ browserURL: connect, defaultViewport: null });
    return {
      browser,
      mode: 'connect',
      endpoint: connect,
      close: async () => { await browser.disconnect(); },
    };
  }
  // 起的 Chrome 以 PROBE_CHROME_ARGS 打头(`probe-chrome.mjs`),调用方给的参数接在后面
  const opts = launch ?? { headless: true };
  const browser = await puppeteer.launch({ ...opts, args: [...PROBE_CHROME_ARGS, ...(opts.args ?? []).filter((a) => !PROBE_CHROME_ARGS.includes(a))] });
  return {
    browser,
    mode: 'launch',
    endpoint: browser.wsEndpoint(),
    close: async () => { await browser.close(); },
  };
}

/**
 * The page the shell already has open. Prefer the agent webview
 * (desktop/src-tauri/src/agent_webview.rs): it is parked outside the client area and
 * its `on_navigation` accepts anything, so driving it does not disturb the editor.
 * Note the `__PROMPTCUT_AGENT__` marker is NOT set on the initial `about:blank`, so the
 * URL and "is it a blank page" checks carry the identification before the first goto.
 */
export async function pickExistingPage(browser, hint = null) {
  const pages = await browser.pages();
  if (!pages.length) throw new Error('连上了浏览器但一个 page target 都没有');
  if (hint) {
    const byHint = pages.find((p) => p.url().includes(hint));
    if (byHint) return byHint;
  }
  const byUrl = pages.find((p) => p.url().includes('promptcut-agent'));
  if (byUrl) return byUrl;
  for (const p of pages) {
    const marked = await p.evaluate(() => window.__PROMPTCUT_AGENT__ === true).catch(() => false);
    if (marked) return p;
  }
  return pages.find((p) => p.url().startsWith('about:blank')) ?? pages[0];
}

/**
 * A source of "clean" pages. Every backdrop/OAC case must start from a fresh
 * document — reusing one document across cases is what made the first version of
 * scripts/archive/probes/backdrop-probe.mjs report white for cases 2 and 3.
 *
 * launch mode: a real new page per case (and it gets closed).
 * connect mode: one page, navigated to about:blank between cases (WebView2 has no
 * Target.createTarget; we try once and fall back).
 */
export async function pageFactory(browser, mode, { hint = null, viewport = null, reusePage = false } = {}) {
  // Do not even try `browser.newPage()` in connect mode: WebView2 does not implement
  // Target.createTarget and the call never comes back (it also side-effects the agent
  // webview onto plain about:blank before hanging).
  // `reusePage` forces the same one-page behaviour in launch mode, which is how you
  // reproduce connect mode's browsing-context lifetime in a normal Chrome.
  const canCreate = mode === 'launch' && !reusePage;
  let shared = null;
  let sharedHome = 'about:blank';

  const applyViewport = async (page) => {
    if (!viewport) return;
    await page.setViewport(viewport).catch(() => {});
  };

  return {
    async fresh() {
      if (canCreate) {
        const page = await browser.newPage();
        await applyViewport(page);
        return { page, owned: true };
      }
      if (!shared) {
        shared = await pickExistingPage(browser, hint);
        // Put it back where we found it when we are done — the shell expects its agent
        // webview to sit on about:blank#promptcut-agent.
        sharedHome = shared.url() || 'about:blank';
        await applyViewport(shared);
      }
      if (shared.url() !== sharedHome) await shared.goto(sharedHome, { waitUntil: 'load' }).catch(() => {});
      return { page: shared, owned: false };
    },
    async release(handle) {
      if (!handle) return;
      if (handle.owned) await handle.page.close().catch(() => {});
      else await handle.page.goto(sharedHome, { waitUntil: 'load' }).catch(() => {});
    },
    get reusesOnePage() { return !canCreate; },
  };
}

/** Targets as the browser itself reports them — the only reliable OOPIF signal. */
export async function listTargets(endpointOrBrowser) {
  if (typeof endpointOrBrowser === 'string') {
    const res = await fetch(new URL('/json/list', endpointOrBrowser));
    return await res.json();
  }
  const cdp = await endpointOrBrowser.target().createCDPSession();
  const { targetInfos } = await cdp.send('Target.getTargets');
  await cdp.detach().catch(() => {});
  return targetInfos;
}

/** Minimal static/dynamic http server bound on all interfaces (we need 127.0.0.x). */
export function serve(port, handler, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    const s = http.createServer(handler);
    s.on('error', reject);
    s.listen(port, host, () => resolve(s));
  });
}

// `server.close()` alone waits for every keep-alive socket to go away. In connect mode
// the browser outlives the probe, so its idle sockets would hang the process forever.
export const closeAll = (servers) =>
  Promise.all(servers.map((s) => new Promise((r) => { s.close(r); s.closeAllConnections?.(); })));

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
