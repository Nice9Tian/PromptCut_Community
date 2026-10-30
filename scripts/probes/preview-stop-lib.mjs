/**
 * `seek-back-exact-probe.mjs` 与 `scrub-hold-snapshot-probe.mjs` 共用的搭法,不单独运行。
 *
 *   - `startIsolatedEditor`:起一台隔离的编辑器(`scripts/lib/dev-server.mjs` 的 `startDevServer`):产物目录、数据目录、
 *     Vite 的依赖预构建缓存都指到仓库 `out/` 或临时目录,不写用户目录,也不在检出目录里建 `node_modules`;
 *   - `openEditorPage`:无头 Chrome 打开 `?editor&nosetup=1&preview=stage`,等两个舞台握上;回一组在页面 / 舞台里取数的函数;
 *   - `decodePng` / `comparePixels`:两张同尺寸的 RGBA 按预乘色逐像素比。
 *
 * 子进程一律 `windowsHide`,Chrome 无头并挪到屏幕外。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { startDevServer } from '../lib/dev-server.mjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 等到 `fn` 回真值;到时限回 null(调用方自己记失败)。等待时限只为防卡死 */
export async function waitFor(fn, timeoutMs, everyMs = 100) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) return null;
    await sleep(everyMs);
  }
}

/**
 * 起一台隔离的编辑器。`port` 是编辑器端口,舞台端口是 +1、+2,三个连号都要空着(被占了 `startDevServer` 直接抛)。
 * 回 `{ origin, stagePorts, stop, logFile }`。
 */
export async function startIsolatedEditor({ port, work }) {
  const exportDir = path.join(work, 'export');
  const dataDir = path.join(work, 'data');
  await fs.mkdir(exportDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  const logFile = path.join(work, 'vite.log');
  // 依赖预构建缓存按端口分开放在仓库 out/ 下:两台同时起的编辑器不抢同一份,重跑时是热的
  const cacheDir = path.join(ROOT, 'out', 'probe-vite-cache', String(port));
  await fs.mkdir(cacheDir, { recursive: true });
  /*
   * 端口被占是暂时性故障:重试加退避,不算失败。指定的端口落在系统的动态端口段里时,别的进程连出去的连接可能临时占到它们
   * (实测紧跟在一遍全量测试之后起探针,`startDevServer` 当场报「没有全空着」,隔几秒就空出来了)。
   * 试 6 次(间隔 3、6、9、12、15 秒)还占着,才照原样抛。
   */
  let server = null;
  for (let attempt = 1; ; attempt++) {
    try {
      server = await startDevServer({
        port, logFile,
        env: { PROMPTCUT_EXPORT_DIR: exportDir, PROMPTCUT_DATA_DIR: dataDir, PROMPTCUT_VITE_CACHE_DIR: cacheDir },
      });
      break;
    } catch (e) {
      if (attempt >= 6 || !/没有全空着/.test(String(e?.message))) throw e;
      console.error(`[preview-stop-lib] ${e.message};${attempt * 3} 秒后重试(第 ${attempt} 次)`);
      await sleep(attempt * 3000);
    }
  }
  return { origin: server.origin, stagePorts: server.stagePorts.map(String), stop: server.stop, logFile };
}

/**
 * 打开编辑台(双舞台),等可见舞台和后台舞台各就各位。
 * 回 `{ browser, page, pageErrors, store, stageFrames, frontFrame, frontId, parentDiag }`。
 */
export async function openEditorPage(origin, { viewport = { width: 2560, height: 1600 } } = {}) {
  const browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage() && m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  const stagePorts = (ports.ports ?? []).slice(0, 2).map(String);
  /** 在父页里拿 store 的 `actions` / `getState` 跑一段代码(`args` 是传进去的数组) */
  const store = (src, ...a) => page.evaluate(async (src2, a2) => {
    const { actions, getState } = await import('/src/store/project.ts');
    // eslint-disable-next-line no-new-func
    return new Function('actions', 'getState', 'args', src2)(actions, getState, a2);
  }, src, a);
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && stagePorts.some((p) => f.url().includes(`:${p}/`)));
  const frontId = () => page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A');
  const frontFrame = async () => { const id = await frontId(); return stageFrames().find((f) => f.url().includes(`id=${id}`)) ?? null; };
  const parentDiag = () => page.evaluate(() => window.__pcPreviewDiag?.() ?? null);
  return { browser, page, pageErrors, stagePorts, store, stageFrames, frontFrame, frontId, parentDiag };
}

/** 这张片段的成本记录(父页的分派表里);`patch` 给了就并进去再写回(钉重卡、改 `vtOk` 用) */
export function costRecordOf(page, clipId, patch = null, persist = false) {
  return page.evaluate(async (id, patch2, persist2) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const key = clipIdentityOf(getState().project).identityKeys[id];
    const costs = pd.currentCosts();
    const found = costs.find((r) => r.identityKey === key) ?? null;
    if (!patch2) return found;
    const rec = { ...(found ?? { identityKey: key, device: costs[0]?.device ?? 'probe' }), ...patch2 };
    pd.mergePlanCosts([rec]);
    if (persist2 && typeof rec.stepMs === 'number') {
      await fetch('/api/data/costs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [rec] }) });
    }
    return rec;
  }, clipId, patch, persist);
}

export function decodePng(dataUrl) {
  const png = PNG.sync.read(Buffer.from(dataUrl.split(',')[1], 'base64'));
  return { w: png.width, h: png.height, data: png.data };
}

/**
 * 两张同尺寸的 RGBA(非预乘)按预乘色比。
 *   - `diffPixels`:有任一通道(含不透明度)不同的像素数;`identical`:一个都没有;
 *   - `meanAll`:全部像素三个颜色通道的平均绝对差(满分 255);`meanContent`:只算任一张里不透明度 > 0 的像素;
 *   - `alphaMean`:不透明度的平均差;`max`:单通道最大差;`inkA` / `inkB`:各自不透明度 > 0 的像素数。
 */
export function comparePixels(a, b) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return { error: 'size', a: a && [a.w, a.h], b: b && [b.w, b.h] };
  let sum = 0, sumContent = 0, content = 0, alpha = 0, max = 0, inkA = 0, inkB = 0, diffPixels = 0;
  const n = a.w * a.h;
  for (let i = 0; i < n * 4; i += 4) {
    const aa = a.data[i + 3], ba = b.data[i + 3];
    if (aa) inkA++;
    if (ba) inkB++;
    let d = 0;
    let differs = aa !== ba;
    for (let c = 0; c < 3; c++) {
      if (a.data[i + c] !== b.data[i + c] && (aa || ba)) differs = true;
      const x = Math.abs((a.data[i + c] * aa) / 255 - (b.data[i + c] * ba) / 255);
      d += x;
      if (x > max) max = x;
    }
    if (differs) diffPixels++;
    sum += d;
    alpha += Math.abs(aa - ba);
    if (aa || ba) { content++; sumContent += d; }
  }
  return { w: a.w, h: a.h, identical: diffPixels === 0, diffPixels, meanAll: +(sum / (n * 3)).toFixed(4),
    meanContent: content ? +(sumContent / (content * 3)).toFixed(3) : 0, alphaMean: +(alpha / n).toFixed(4), max: Math.round(max), inkA, inkB };
}

export async function savePng(dir, name, dataUrl) {
  if (!dataUrl) return null;
  const file = path.join(dir, name);
  await fs.writeFile(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
  return file;
}
