/**
 * 在线浏览器的新版本提示条探针（语义 `docs/semantics/product/platforms.md` 与 `docs/semantics/mechanism/platforms.md`「在线浏览器」的「新版本提示」）。
 *
 * 用法：
 *   node scripts/probes/update-notice-probe.mjs [--dist <在线构建目录>] [--port 6410] [--keep-temp]
 *
 * 端口：
 *   缺省 6410（`--port` 可改，只允许 6410～6419；端口被占时直接报错退出，不结束外部进程）。
 *
 * 验收标准（判据，每项一行进输出 JSON 的 `checks`）：
 *   U0 在线构建产出 `version.json`，其 `codeVersion` 为非空字符串且原样出现在 `assets/*.js` 中（与页面内 `CODE_VERSION` 同值）；
 *   U1 打开 `/editor/`，等 `#root` 渲染后再等约 2 秒：页面无 `[data-pc="update-notice"]`，且 `version.json` 请求数为 0（启动时不取）；
 *   U2 服务端版本不变时切到后台再切回前台：`version.json` 请求数加 1（限时 15 秒），再等约 1 秒仍无提示条；
 *   U3 把服务端内存里的版本改为新值，再切后台再切回前台：`version.json` 再次被请求，出现 `[data-pc="update-notice"]`（限时 15 秒），含文字「有新版本，刷新后使用。」与 `[data-pc="update-notice-refresh"]` 按钮；
 *   U3b 把服务端版本改回本页的版本再切一次：提示条撤下（限时 15 秒）；再改回新值切一次，提示条重新出现（供 U4 用）；
 *   U4 在页面设置 `window.__updateProbeMark = 1` 后点击「刷新」：页面重新载入（`waitForNavigation`），标记消失且 `index.html` 请求数增加；
 *   U5 分别打开 `/editor/?stage=1`、`/editor/stage.html`、`/editor/?export=1`、`/editor/?audioMix=1`，载入后切后台再切回前台并等约 2 秒：`version.json` 请求数不变且均无提示条。
 *   U6 手机宽度（390×844、触屏、`?layout=mobile` 的开始页）服务端是新版本时切一次：提示条出现，文字只占一行，整条在视口里、左右各留出至少 16px。
 *
 * 输出：过程写 stderr；stdout 最后一行输出单行 JSON `{ ok, fails, checks, visibility, ... }`；全过退出码 0，否则 1。
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
    if (Date.now() > end) { fails.push(`超时:${label}`); return null; }
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
 * 切到后台再切回前台：
 * 1) 先试真实标签页切换（新开空白页 bringToFront -> 原页 hidden -> 原页 bringToFront -> 原页 visible）；
 * 2) 无头 Chrome 下若真实切换不改变 document.visibilityState，则退回在页面内用 Object.defineProperty 模拟 hidden -> visible 并派发 visibilitychange。
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
    /* 退回模拟 */
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
    throw new Error(`--port 只允许 6410～6419，当前值：${arg('--port', 6410)}`);
  }
  if (!(await portFree(PORT))) {
    throw new Error(`端口 ${PORT} 被占用（不结束外部进程，请换 6410～6419 内的空闲端口）`);
  }

  /* ---------------------------------------------------------------- 1. 构建与校验 version.json */
  let DIST = arg('--dist', null);
  if (!DIST) {
    DIST = path.join(TMP, 'dist-online');
    say('build.start', { dist: DIST });
    const b = spawnSync(
      process.execPath,
      [viteBin(), 'build', '--mode', 'online', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'error'],
      { cwd: ROOT, encoding: 'utf8', windowsHide: true },
    );
    if (b.status !== 0) throw new Error(`在线构建失败：${String(b.stderr).slice(-600)}`);
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
  if (!check(V.length > 0 && inBundle, 'U0 在线构建产出 version.json，codeVersion 非空且原样出现在 assets/*.js 中', out.buildVersion)) {
    throw new Error('version.json 校验未通过');
  }

  /* ---------------------------------------------------------------- 2. 仿托管端 nginx 的静态服务 */
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

  /* ---------------------------------------------------------------- 3. 启动无头 Chrome */
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

  /* ---------------------------------------------------------------- U1: 启动时不取 version.json、无提示条 */
  await page.goto(`${out.site}/editor/`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  const rootRendered = await until(
    'U1 #root 渲染出内容',
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
    'U1 打开 /editor/ 渲染后等 2 秒：无 [data-pc="update-notice"]，version.json 请求数为 0',
    out.steps.u1,
  );

  /* ---------------------------------------------------------------- U2: 版本不变时切后台再切回前台 */
  const vBeforeU2 = reqCounts.versionJson;
  const visModeU2 = await cycleVisibility(page, ctx);
  const u2Fetched = await until(
    'U2 切回前台后请求 version.json',
    () => (reqCounts.versionJson >= vBeforeU2 + 1 ? reqCounts.versionJson : null),
    15_000,
    100,
  );
  await delay(1000);
  const u2HasNotice = await page.evaluate(() => !!document.querySelector('[data-pc="update-notice"]'));
  out.steps.u2 = { visibility: visModeU2, before: vBeforeU2, after: reqCounts.versionJson, hasNotice: u2HasNotice };
  check(
    !!u2Fetched && reqCounts.versionJson === vBeforeU2 + 1 && !u2HasNotice,
    'U2 版本不变时切后台再切回前台：version.json 请求数加 1，之后仍无提示条',
    out.steps.u2,
  );

  /* ---------------------------------------------------------------- U3: 服务端换新版本后切后台再切回前台 */
  const nextVersion = V === 'f'.repeat(64) ? 'e'.repeat(64) : 'f'.repeat(64);
  currentVersion = nextVersion;
  const vBeforeU3 = reqCounts.versionJson;
  await cycleVisibility(page, ctx);
  const u3Bar = await until(
    'U3 出现 [data-pc="update-notice"]',
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
      && u3Bar.text.includes('有新版本，刷新后使用。')
      && u3Bar.hasRefreshBtn,
    'U3 服务端换新版本后切后台再切回前台：请求 version.json 并出现提示条「有新版本，刷新后使用。」与刷新按钮',
    out.steps.u3,
  );

  /* ---------------------------------------------------------------- U3b: 服务端退回本页的版本，提示撤下；再换新版本又挂上 */
  currentVersion = V;
  await cycleVisibility(page, ctx);
  const u3bGone = await until(
    'U3b 服务端退回本页版本后提示条撤下',
    () => page.evaluate(() => !document.querySelector('[data-pc="update-notice"]')),
    15_000,
    100,
  );
  currentVersion = nextVersion;
  await cycleVisibility(page, ctx);
  const u3bBack = await until(
    'U3b 再换新版本后提示条重新出现',
    () => page.evaluate(() => !!document.querySelector('[data-pc="update-notice"]')),
    15_000,
    100,
  );
  out.steps.u3b = { gone: !!u3bGone, back: !!u3bBack, versionJsonRequests: reqCounts.versionJson };
  check(!!u3bGone && !!u3bBack, 'U3b 服务端退回本页版本时提示条撤下，再换新版本又出现', out.steps.u3b);

  /* ---------------------------------------------------------------- U4: 点「刷新」重新载入页面 */
  await page.evaluate(() => { window.__updateProbeMark = 1; });
  const idxBeforeU4 = reqCounts.indexHtml;
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
    page.click('[data-pc="update-notice-refresh"]'),
  ]);
  await until(
    'U4 刷新后 #root 重新渲染',
    () => page.evaluate(() => (document.getElementById('root')?.children.length ?? 0) > 0),
    30_000,
    100,
  );
  const markAfterU4 = await page.evaluate(() => window.__updateProbeMark);
  out.steps.u4 = { indexBefore: idxBeforeU4, indexAfter: reqCounts.indexHtml, markAfter: markAfterU4 ?? null };
  check(
    markAfterU4 === undefined && reqCounts.indexHtml > idxBeforeU4,
    'U4 点击「刷新」：页面重新载入，window.__updateProbeMark 消失且 index.html 请求数增加',
    out.steps.u4,
  );

  /* ---------------------------------------------------------------- U5: 不该挂载的页面不查、不提示 */
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
    'U5 舞台页与导出/混音页（?stage=1、stage.html、?export=1、?audioMix=1）切后台再切回前台：不请求 version.json 且无提示条',
    u5Results,
  );

  /* ---------------------------------------------------------------- U6: 手机宽度上一行放得下 */
  {
    const phoneCtx = await browser.createBrowserContext();
    const phone = attachPageLogs(await phoneCtx.newPage());
    try {
      await phone.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
      await phone.goto(`${out.site}/editor/?layout=mobile`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      await until('U6 #root 渲染出内容', () => phone.evaluate(() => (document.getElementById('root')?.children.length ?? 0) > 0), 30_000, 100);
      await cycleVisibility(phone, phoneCtx);
      const bar = await until(
        'U6 手机宽度出现提示条',
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
      // 一行：12.5px、行高 1.4 时约 18px，两行就是 35px 上下（文字是弹性盒的子项，getClientRects 只回一个框，只能看高度）
      check(!!bar && bar.textHeight < 26 && bar.left >= 16 && bar.right <= bar.vw - 16,
        'U6 手机宽度（390）：提示条文字只占一行，左右各留出至少 16px', out.steps.u6);
    } finally {
      await phone.close().catch(() => {});
      await phoneCtx.close().catch(() => {});
    }
  }
} catch (e) {
  fails.push(`探针异常:${String(e?.stack ?? e).slice(0, 1200)}`);
} finally {
  out.reqCounts = reqCounts;
  try { await browser?.close(); } catch { /* 已关 */ }
  if (server) {
    await new Promise((r) => {
      server.close(() => r());
      server.closeAllConnections?.();
    });
  }
  if (!KEEP) {
    try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 句柄未放 */ }
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
