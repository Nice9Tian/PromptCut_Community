/**
 * New version notice bar probe for online browser (semantics `docs/semantics/product/platforms.md`
 * and `docs/semantics/mechanism/platforms.md` "Online browser" -> "New version notice").
 *
 * Usage:
 *   node scripts/probes/update-notice-probe.mjs [--dist <online-build-dir>] [--port 6410] [--keep-temp]
 *
 * Ports:
 *   Default 6410 (`--port` can change, only 6410~6419 allowed; exits with error directly when port
 *   is occupied, does not terminate external processes).
 *
 * Acceptance criteria (criteria, one line per item into output JSON `checks`):
 *   U0 Online build outputs `version.json`, whose `codeVersion` is a non-empty string and appears
 *      as-is in `assets/*.js` (same value as `CODE_VERSION` in the page);
 *   U1 Open `/editor/`, wait for `#root` to render and then wait ~2 s: page has no
 *      `[data-pc="update-notice"]`, and `version.json` request count is 0 (not fetched at startup);
 *   U2 Switch to background and back to foreground when server version is unchanged: `version.json`
 *      request count increments by 1 (15-second timeout), and still no notice bar after waiting ~1 s;
 *   U3 Change version in server memory to new value, then switch to background and back to foreground:
 *      `version.json` is requested again, and `[data-pc="update-notice"]` appears (15-second timeout),
 *      containing text "New version available. Refresh to use." and `[data-pc="update-notice-refresh"]`
 *      button;
 *   U3b Change server version back to this page's version and switch again: notice bar dismisses
 *      (15-second timeout); change back to new value and switch again, notice bar reappears (for U4);
 *   U4 After setting `window.__updateProbeMark = 1` in page, click "Refresh": page reloads
 *      (`waitForNavigation`), mark disappears and `index.html` request count increases;
 *   U5 Open `/editor/?stage=1`, `/editor/stage.html`, `/editor/?export=1`, `/editor/?audioMix=1`
 *      respectively; after loading, switch to background and back to foreground, and wait ~2 s:
 *      `version.json` request count remains unchanged and none shows a notice bar.
 *   U6 On mobile width (390×844, touch screen, `?layout=mobile` start page) with new version on
 *      server, switch once: notice bar appears, text occupies only one line, entire bar is in
 *      viewport, leaving at least 16px on left and right.
 *
 * Output: progress to stderr; last line of stdout outputs single-line JSON
 * `{ ok, fails, checks, visibility, ... }`; exit code 0 if all pass, otherwise 1.
 */
import '../lib/no-user-dirs.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const KEEP = argv.includes('--keep-temp');
const PORT = Number(arg('--port', 6410));

const started = Date.now();
const fails = [];
const checks = [];
const out = {
  ok: false,
  port: PORT,
  site: `http://127.0.0.1:${PORT}`,
  visibility: null,
  steps: {},
};

const check = (cond, label, extra) => {
  checks.push({ ok: !!cond, label, ...(extra === undefined ? {} : { extra }) });
  if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 400)}`));
  return !!cond;
};
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), step, ...fields })}\n`);

async function until(label, fn, timeoutMs, everyMs = 150) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > end) { fails.push(`Timeout: ${label}`); return null; }
    await delay(everyMs);
  }
}

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

const portFree = (port) => new Promise((resolve) => {
  const s = net.createServer();
  s.once('error', () => resolve(false));
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
});

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-update-notice-'));
let server = null;
let browser = null;
let currentVersion = '';
const reqCounts = { indexHtml: 0, fallback: 0, versionJson: 0 };

/**
 * Switch to background then back to foreground:
 * 1) First try real tab switching (open new blank page bringToFront -> original page hidden ->
 * original page bringToFront -> original page visible);
 * 2) Under headless Chrome, if real switching does not change document.visibilityState, fall back
 * to simulating hidden -> visible in-page with Object.defineProperty and dispatching visibilitychange.
 */
async function cycleVisibility(page, ctx) {
  let blank = null;
  try {
    blank = await ctx.newPage();
    await blank.bringToFront();
    const hid = await (async () => {
      for (let i = 0; i < 6; i++) {
        const s = await page.evaluate(() => document.visibilityState).catch(() => null);
        if (s === 'hidden') return true;
        await delay(100);
      }
      return false;
    })();
    if (hid) {
      await page.bringToFront();
      const vis = await (async () => {
        for (let i = 0; i < 6; i++) {
          const s = await page.evaluate(() => document.visibilityState).catch(() => null);
          if (s === 'visible') return true;
          await delay(100);
        }
        return false;
      })();
      await blank.close().catch(() => {});
      blank = null;
      if (vis) {
        out.visibility ||= 'tab-switch';
        return 'tab-switch';
      }
    }
  } catch {
    /* Fall back to simulation */
  } finally {
    if (blank) await blank.close().catch(() => {});
    await page.bringToFront().catch(() => {});
  }

  await page.evaluate(() => {
    let state = 'hidden';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => state,
    });
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => state !== 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    state = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
  });
  out.visibility ||= 'simulated';
  return 'simulated';
}

function attachPageLogs(page) {
  page.pageErrors = [];
  page.consoleErrors = [];
  page.on('dialog', (d) => void d.accept());
  page.on('pageerror', (e) => {
    if (page.pageErrors.length < 20) page.pageErrors.push(String(e?.message ?? e).slice(0, 200));
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && page.consoleErrors.length < 20) {
      page.consoleErrors.push(m.text().slice(0, 200));
    }
  });
  return page;
}

try {
  if (!Number.isInteger(PORT) || PORT < 6410 || PORT > 6419) {
    throw new Error(`--port only allows 6410-6419, current value: ${arg('--port', 6410)}`);
  }
  if (!(await portFree(PORT))) {
    throw new Error(`Port ${PORT} is in use (external processes are not terminated, pick a free port within 6410-6419)`);
  }

  /* ---------------------------------------------------------------- 1. Build and validate version.json */
  let DIST = arg('--dist', null);
  if (!DIST) {
    DIST = path.join(TMP, 'dist-online');
    say('build.start', { dist: DIST });
    const b = spawnSync(
      process.execPath,
      [viteBin(), 'build', '--mode', 'online', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'error'],
      { cwd: ROOT, encoding: 'utf8', windowsHide: true },
    );
    if (b.status !== 0) throw new Error(`Online build failed: ${String(b.stderr).slice(-600)}`);
  }
  DIST = path.resolve(DIST);
  out.dist = DIST;

  const versionFile = path.join(DIST, 'version.json');
  const rawVersionJson = fs.existsSync(versionFile) ? fs.readFileSync(versionFile, 'utf8') : '';
  let parsedVersion = null;
  try { parsedVersion = JSON.parse(rawVersionJson); } catch { parsedVersion = null; }
  const V = typeof parsedVersion?.codeVersion === 'string' ? parsedVersion.codeVersion.trim() : '';
  const assetsDir = path.join(DIST, 'assets');
  const jsFiles = fs.existsSync(assetsDir) ? fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js')) : [];
  const inBundle = !!V && jsFiles.some((f) => fs.readFileSync(path.join(assetsDir, f), 'utf8').includes(V));
  out.buildVersion = { codeVersion: V || null, jsFilesCount: jsFiles.length, inBundle };
  if (!check(V.length > 0 && inBundle, 'U0 the online build produces version.json, codeVersion is non-empty and appears verbatim in assets/*.js', out.buildVersion)) {
    throw new Error('version.json validation did not pass');
  }

  /* ---------------------------------------------------------------- 2. Static serving simulating hosted side nginx */
  currentVersion = V;
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.ttf': 'font/ttf',
    '.wasm': 'application/wasm',
  };
  const SEC_HEADERS = {
    'Origin-Agent-Cluster': '?1',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
  };
  const indexHtmlPath = path.join(DIST, 'index.html');
  const sendFile = (res, file, cacheControl) => {
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Cache-Control': cacheControl,
      ...SEC_HEADERS,
    });
    fs.createReadStream(file).pipe(res);
  };

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', out.site);
    if (url.pathname === '/editor' || url.pathname === '/editor/' || url.pathname === '/editor/index.html') {
      reqCounts.indexHtml++;
      return sendFile(res, indexHtmlPath, 'no-store');
    }
    if (url.pathname === '/editor/version.json') {
      reqCounts.versionJson++;
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...SEC_HEADERS,
      });
      return res.end(JSON.stringify({ codeVersion: currentVersion }));
    }
    if (url.pathname.startsWith('/editor/assets/')) {
      const rel = decodeURIComponent(url.pathname.slice('/editor/'.length));
      const f = path.resolve(DIST, rel);
      const assetsRoot = path.resolve(DIST, 'assets') + path.sep;
      if (!f.startsWith(assetsRoot) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SEC_HEADERS });
        return res.end('not found');
      }
      return sendFile(res, f, 'public, max-age=31536000, immutable');
    }
    if (url.pathname.startsWith('/editor/')) {
      const rel = decodeURIComponent(url.pathname.slice('/editor/'.length));
      const f = path.resolve(DIST, rel);
      if (f.startsWith(DIST + path.sep) && fs.existsSync(f) && fs.statSync(f).isFile()) {
        return sendFile(res, f, 'no-store');
      }
      reqCounts.fallback++;
      return sendFile(res, indexHtmlPath, 'no-store');
    }
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SEC_HEADERS });
    res.end('not found');
  });

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  say('server.up', { site: out.site, dist: DIST });

  /* ---------------------------------------------------------------- 3. Launch headless Chrome */
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  browser = await puppeteer.launch({
    headless: true,
    protocolTimeout: 180_000,
    defaultViewport: { width: 1280, height: 800 },
    args: [
      ...PROBE_CHROME_ARGS,
      '--window-position=-32000,-32000',
      '--no-first-run',
      '--hide-scrollbars',
      '--force-device-scale-factor=1',
    ],
  });

  const ctx = await browser.createBrowserContext();
  const page = attachPageLogs(await ctx.newPage());

  /* ---------------------------------------------------------------- U1: Do not fetch version.json at startup, no notice bar */
  await page.goto(`${out.site}/editor/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const rootRendered = await until(
    'U1 #root renders content',
    () => page.evaluate(() => (document.getElementById('root')?.children.length ?? 0) > 0),
    30_000,
    100,
  );
  await delay(2000);
  const u1HasNotice = await page.evaluate(() => !!document.querySelector('[data-pc="update-notice"]'));
  out.steps.u1 = {
    rootRendered: !!rootRendered,
    hasNotice: u1HasNotice,
    versionJsonRequests: reqCounts.versionJson,
    indexHtmlRequests: reqCounts.indexHtml,
    fallbackRequests: reqCounts.fallback,
  };
  check(
    !!rootRendered && !u1HasNotice && reqCounts.versionJson === 0,
    'U1 after opening /editor/ and rendering, wait 2 seconds: no [data-pc="update-notice"], and the version.json request count is 0',
    out.steps.u1,
  );

  /* ---------------------------------------------------------------- U2: Switch to background and back to foreground when version is unchanged */
  const vBeforeU2 = reqCounts.versionJson;
  const visModeU2 = await cycleVisibility(page, ctx);
  const u2Fetched = await until(
    'U2 version.json is requested after switching back to the foreground',
    () => (reqCounts.versionJson >= vBeforeU2 + 1 ? reqCounts.versionJson : null),
    15_000,
    100,
  );
  await delay(1000);
  const u2HasNotice = await page.evaluate(() => !!document.querySelector('[data-pc="update-notice"]'));
  out.steps.u2 = { visibility: visModeU2, before: vBeforeU2, after: reqCounts.versionJson, hasNotice: u2HasNotice };
  check(
    !!u2Fetched && reqCounts.versionJson === vBeforeU2 + 1 && !u2HasNotice,
    'U2 with an unchanged version, switching to the background and back to the foreground: the version.json request count goes up by 1, and there is still no notice bar afterwards',
    out.steps.u2,
  );

  /* ---------------------------------------------------------------- U3: Switch to background and back to foreground after server updates to new version */
  const nextVersion = V === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
  currentVersion = nextVersion;
  const vBeforeU3 = reqCounts.versionJson;
  await cycleVisibility(page, ctx);
  const u3Bar = await until(
    'U3 [data-pc="update-notice"] appears',
    () => page.evaluate(() => {
      const el = document.querySelector('[data-pc="update-notice"]');
      if (!el) return null;
      const btn = el.querySelector('[data-pc="update-notice-refresh"]');
      return {
        text: el.textContent ?? '',
        step: el.getAttribute('data-step'),
        hasRefreshBtn: !!btn,
        refreshText: btn?.textContent ?? '',
      };
    }),
    15_000,
    100,
  );
  out.steps.u3 = { before: vBeforeU3, after: reqCounts.versionJson, bar: u3Bar };
  check(
    reqCounts.versionJson > vBeforeU3
      && !!u3Bar
      && u3Bar.text.includes('New version available, refresh to use it.')
      && u3Bar.hasRefreshBtn,
    'U3 after the server switches to a new version and the page goes to the background and back to the foreground: version.json is requested, and the notice bar "New version available, refresh to use it." with a refresh button appears',
    out.steps.u3,
  );

  /* ---------------------------------------------------------------- U3b: Server rolls back to this page's version, notice dismissed; updates to new version again and reappears */
  currentVersion = V;
  await cycleVisibility(page, ctx);
  const u3bGone = await until(
    'U3b the notice bar is dismissed after the server reverts to this page\'s version',
    () => page.evaluate(() => !document.querySelector('[data-pc="update-notice"]')),
    15_000,
    100,
  );
  currentVersion = nextVersion;
  await cycleVisibility(page, ctx);
  const u3bBack = await until(
    'U3b the notice bar reappears after switching to a new version again',
    () => page.evaluate(() => !!document.querySelector('[data-pc="update-notice"]')),
    15_000,
    100,
  );
  out.steps.u3b = { gone: !!u3bGone, back: !!u3bBack, versionJsonRequests: reqCounts.versionJson };
  check(!!u3bGone && !!u3bBack, 'U3b when the server reverts to this page\'s version the notice bar is dismissed, and it appears again after switching to a new version', out.steps.u3b);

  /* ---------------------------------------------------------------- U4: Click "Refresh" to reload page */
  await page.evaluate(() => { window.__updateProbeMark = 1; });
  const idxBeforeU4 = reqCounts.indexHtml;
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
    page.click('[data-pc="update-notice-refresh"]'),
  ]);
  await until(
    'U4 #root re-renders after refresh',
    () => page.evaluate(() => (document.getElementById('root')?.children.length ?? 0) > 0),
    30_000,
    100,
  );
  const markAfterU4 = await page.evaluate(() => window.__updateProbeMark);
  out.steps.u4 = { indexBefore: idxBeforeU4, indexAfter: reqCounts.indexHtml, markAfter: markAfterU4 ?? null };
  check(
    markAfterU4 === undefined && reqCounts.indexHtml > idxBeforeU4,
    'U4 clicking "Refresh": the page reloads, window.__updateProbeMark disappears and the index.html request count goes up',
    out.steps.u4,
  );

  /* ---------------------------------------------------------------- U5: Do not check or notify on pages that should not mount */
  await page.close().catch(() => {});
  await ctx.close().catch(() => {});

  const skipRoutes = ['/editor/?stage=1', '/editor/stage.html', '/editor/?export=1', '/editor/?audioMix=1'];
  const u5Results = {};
  let u5AllOk = true;
  for (const routePath of skipRoutes) {
    const subCtx = await browser.createBrowserContext();
    const subPage = attachPageLogs(await subCtx.newPage());
    try {
      const vBefore = reqCounts.versionJson;
      await subPage.goto(`${out.site}${routePath}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await delay(400);
      await cycleVisibility(subPage, subCtx);
      await delay(2000);
      const hasNotice = await subPage.evaluate(() => !!document.querySelector('[data-pc="update-notice"]')).catch(() => false);
      const vAfter = reqCounts.versionJson;
      const routeOk = vAfter === vBefore && !hasNotice;
      if (!routeOk) u5AllOk = false;
      u5Results[routePath] = {
        versionBefore: vBefore,
        versionAfter: vAfter,
        hasNotice,
        pageErrors: subPage.pageErrors,
        consoleErrors: subPage.consoleErrors,
      };
    } finally {
      await subPage.close().catch(() => {});
      await subCtx.close().catch(() => {});
    }
  }
  out.steps.u5 = u5Results;
  check(
    u5AllOk,
    'U5 stage page and export/audio-mix pages (?stage=1, stage.html, ?export=1, ?audioMix=1) switched to the background and back to the foreground: version.json is not requested and there is no notice bar',
    u5Results,
  );

  /* ---------------------------------------------------------------- U6: Fits on one line at mobile width */
  {
    const phoneCtx = await browser.createBrowserContext();
    const phone = attachPageLogs(await phoneCtx.newPage());
    try {
      await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      await phone.goto(`${out.site}/editor/?layout=mobile`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await until('U6 #root renders content', () => phone.evaluate(() => (document.getElementById('root')?.children.length ?? 0) > 0), 30_000, 100);
      await cycleVisibility(phone, phoneCtx);
      const bar = await until(
        'U6 notice bar appears at mobile width',
        () => phone.evaluate(() => {
          const el = document.querySelector('[data-pc="update-notice"]');
          const text = el?.querySelector('.pc-update-notice-text');
          if (!el || !text) return null;
          const r = el.getBoundingClientRect();
          return { textHeight: Math.round(text.getBoundingClientRect().height), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), vw: innerWidth };
        }),
        15_000,
        100,
      );
      out.steps.u6 = { bar, pageErrors: phone.pageErrors };
      // One line: about 18px at 12.5px with line-height 1.4; two lines is around 35px (text is a flexbox
      // child, getClientRects returns only one box, so we can only check height)
      check(!!bar && bar.textHeight < 26 && bar.left >= 16 && bar.right <= bar.vw - 16,
        'U6 mobile width (390): the notice bar text takes only one line, with at least 16px of space on each side', out.steps.u6);
    } finally {
      await phone.close().catch(() => {});
      await phoneCtx.close().catch(() => {});
    }
  }
} catch (e) {
  fails.push(`Probe error: ${String(e?.stack ?? e).slice(0, 1200)}`);
} finally {
  out.reqCounts = reqCounts;
  try { await browser?.close(); } catch { /* Closed */ }
  if (server) {
    await new Promise((r) => {
      server.close(() => r());
      server.closeAllConnections?.();
    });
  }
  if (!KEEP) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Handle not released */ }
  } else {
    out.tempDir = TMP;
  }
  out.ms = Date.now() - started;
  out.checks = checks;
  out.fails = fails;
  out.ok = fails.length === 0;
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}
