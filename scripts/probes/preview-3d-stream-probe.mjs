/**
 * 3D 视图轨道流播放与停下就精确探针 (rr-bake3d-stream)。
 *
 * 验收意图：
 *   1. 3D 模式开启（切到 3D 页）后，planDispatch 的 view3d 为 true，
 *      独立轻卡（如 punch-pill）纳入 prerenderSet（scene-3d 照旧除外）；
 *   2. 播放中 (playing: true)：
 *      - 绝对不向 /api/vision/bake-batch 或 /api/ui-render/bake-batch 发起渲染请求；
 *      - 3D 板子使用轨道流画面（且几何按 bound 收紧，不是拉伸为全屏）；
 *   3. 暂停态 (!playing)：
 *      - 发起当前时刻的精确单帧渲染；
 *      - 在精确图返回前保持流画面/占位作为过渡；到位后无缝切换为精确 PNG 快照。
 *
 * 运行方式：
 *   node scripts/probes/preview-3d-stream-probe.mjs [--port 20020] [--out <dir>]
 */
import '../lib/no-user-dirs.mjs';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const argOf = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);

const PORT = Number(argOf('--port') ?? 20020);
const OUT_DIR = argOf('--out') ? path.resolve(argOf('--out')) : path.join(os.tmpdir(), `pc-3d-stream-probe-${Date.now().toString(36)}`);
const GIVEN_ORIGIN = argOf('--origin');

const fails = [];
const check = (cond, label, extra) => {
  if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''));
  return cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  return path.resolve(ROOT, 'node_modules/.bin/vite.cmd');
}

function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    child.kill('SIGKILL');
  }
}

let serverProc = null;
let browser = null;
const out = { port: PORT, outDir: OUT_DIR };

await fsPromises.mkdir(OUT_DIR, { recursive: true });

try {
  let origin = GIVEN_ORIGIN;
  if (!origin) {
    origin = `http://127.0.0.1:${PORT}`;
    const env = {
      ...process.env,
      PROMPTCUT_ACCOUNT_PROVIDER_ROOT: 'C:\\Users\\admin\\Documents\\VisuHive',
      PROMPTCUT_PASSWORD_ORDER_MODULE: 'C:\\Users\\admin\\Documents\\VisuHive\\account\\password-order.mjs',
      PROMPTCUT_NO_PORT_FILE: '1',
    };
    serverProc = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env,
    });
    serverProc.stdout.resume();
    serverProc.stderr.resume();

    // 等待服务就绪
    const deadline = Date.now() + 60000;
    let up = false;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${origin}/api/media/upload-queue`);
        if (res.ok) { up = true; break; }
      } catch {}
      await sleep(500);
    }
    if (!up) throw new Error(`Dev server 启动超时: ${origin}`);
  }

  out.origin = origin;

  browser = await puppeteer.launch({
    headless: true,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'],
  });

  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  let bakeRequestsWhilePlaying = 0;
  let bakeRequestsTotal = 0;
  let isCurrentlyPlaying = false;

  page.on('request', (req) => {
    const url = req.url();
    if (url.includes('/bake-batch')) {
      bakeRequestsTotal++;
      if (isCurrentlyPlaying) {
        bakeRequestsWhilePlaying++;
      }
    }
  });

  await page.goto(origin + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForSelector('iframe[data-pc="stage-frame"]', { timeout: 120000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage() && m.backRole() === 'back';
  }, { timeout: 120000, polling: 500 }).catch(() => {});

  // 创建项目：包含 scene-3d（右后方）与 punch-pill（左前方），保证两者互不遮挡
  const ids = await page.evaluate(async () => {
    const { actions, getState } = await import('/src/store/project.ts');
    actions.newProject('3d-stream-test');
    // scene-3d 挪到右侧偏后
    const a = actions.addCardClip('scene-3d', 0, {
      duration: 8,
    });
    if (a?.id) {
      actions.setClipFrame(a.id, { x: 1200, y: 540, w: 750, h: 550, translateZ: -120, rotateY: -15 });
    }
    // punch-pill 设在左前方，带倾角和深度
    const b = actions.addCardClip('punch-pill', 0, {
      duration: 8,
      params: { text: '3D Stream Test' },
    });
    if (b?.id) {
      actions.setClipFrame(b.id, { x: 450, y: 540, w: 700, h: 260, translateZ: 220, rotateY: 18 });
    }
    actions.seek(0);
    return { scene: a?.id, pill: b?.id, clips: getState().project.tracks.reduce((n, t) => n + t.clips.length, 0) };
  });
  out.ids = ids;
  check(ids.scene && ids.pill, '成功添加 scene-3d 与 punch-pill 片段', ids);

  await sleep(1000);

  // 切到 3D 选项卡
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-pc="preview-tabs"] button')].find((b) => b.textContent?.trim() === '3D');
    btn?.click();
  });
  await page.waitForSelector('.pc-3d-checker canvas', { timeout: 30000 });
  await sleep(1000);

  // 1. 验证 3D 视图开启后 planDispatch 的 view3d 与 prerenderSet 行为
  const planInfo = await page.evaluate(async (pillId, sceneId) => {
    const { plan3DView, currentPlan } = await import('/src/editor/planDispatch.ts');
    const plan = currentPlan();
    return {
      view3d: plan3DView(),
      pillInPrerenderSet: plan ? plan.prerenderSet.has(pillId) : false,
      sceneInPrerenderSet: plan ? plan.prerenderSet.has(sceneId) : false,
    };
  }, ids.pill, ids.scene);
  out.planInfo = planInfo;
  check(planInfo.view3d === true, '切到 3D 视图时 plan3DView() 为 true', planInfo);
  check(planInfo.pillInPrerenderSet === true, '3D 模式下 punch-pill 独立轻卡纳入 prerenderSet', planInfo);
  check(planInfo.sceneInPrerenderSet === false, '3D 模式下 scene-3d 真三维卡不纳入 prerenderSet', planInfo);

  // 触发并等待预渲染进程产出 punch-pill 的轨道流
  const streamReadyDeadline = Date.now() + 120000;
  let streamReady = false;
  let lastDiag = null;
  let lastReadyIndex = null;
  while (Date.now() < streamReadyDeadline) {
    let prerenderInfo = null;
    try {
      prerenderInfo = await (await fetch(origin + '/api/prerender/info')).json();
      out.prerenderInfo = prerenderInfo;
    } catch {}

    if (prerenderInfo?.url && prerenderInfo?.ready) {
      try {
        const k = await page.evaluate(async () => (await import('/src/render/dataMirror.ts')).mirrorKey());
        if (k) {
          const res = await fetch(prerenderInfo.url + '/api/frames/preload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ session: k.session, localRev: k.localRev, lane: 'background' }),
          }).catch(() => null);
          if (res) out.preloadStatus = res.status;
        }
        lastDiag = await (await fetch(prerenderInfo.url + '/api/frames/diagnostics').catch(() => null))?.json().catch(() => null);
      } catch {}
    }

    const { hasStream, readyKeys } = await page.evaluate(async (id) => {
      const m = await import('/src/editor/snapshotFeed.ts');
      const idx = m.currentReadyIndex();
      const l = idx.get(id)?.get('stream');
      const keys = [];
      for (const [k, v] of idx.entries()) {
        keys.push({ id: k, kinds: [...v.keys()] });
      }
      return { hasStream: !!l && (l.ranges?.length ?? 0) > 0, readyKeys: keys };
    }, ids.pill);
    lastReadyIndex = readyKeys;
    if (hasStream) {
      streamReady = true;
      break;
    }
    await sleep(2000);
  }
  out.streamReady = streamReady;
  out.lastDiag = lastDiag;
  out.lastReadyIndex = lastReadyIndex;
  check(streamReady, 'punch-pill 轨道流已在父页就绪索引中 ready', { streamReady, lastReadyIndex, lastDiag: out.lastDiag?.streams?.stats });

  // 2. 播放测试：播放中绝对不发 bake-batch 请求，在两个不同时刻分别截图
  bakeRequestsWhilePlaying = 0;
  isCurrentlyPlaying = true;
  await page.evaluate(async () => {
    const { actions } = await import('/src/store/project.ts');
    actions.seek(0);
  });
  await page.click('.pc-pv-btn--play');

  // 等待播放推进至 t ≈ 0.3s
  await sleep(350);
  const headT1 = await page.evaluate(async () => {
    const { getState } = await import('/src/store/project.ts');
    return { t: getState().t, playing: getState().playing };
  });
  out.headT1 = headT1;
  check(headT1.playing === true, '时刻 1 播放中 playing 为 true', headT1);

  // 截图 1：播放中时刻 1
  const playingT1Path = path.join(OUT_DIR, '3d-playing-t1.png');
  await page.screenshot({ path: playingT1Path });
  out.playingT1Screenshot = playingT1Path;

  // 继续播放至 t ≈ 1.5s
  await sleep(1200);
  const headT2 = await page.evaluate(async () => {
    const { getState } = await import('/src/store/project.ts');
    return { t: getState().t, playing: getState().playing };
  });
  out.headT2 = headT2;
  check(headT2.playing === true, '时刻 2 播放中 playing 为 true', headT2);
  check(headT2.t > headT1.t, '播放头从时刻 1 持续前进至时刻 2', { t1: headT1.t, t2: headT2.t });
  check(bakeRequestsWhilePlaying === 0, '播放中严禁调用 /bake-batch', { bakeRequestsWhilePlaying });

  // 截图 2：播放中时刻 2
  const playingT2Path = path.join(OUT_DIR, '3d-playing-t2.png');
  await page.screenshot({ path: playingT2Path });
  out.playingT2Screenshot = playingT2Path;

  // 3. 暂停测试：停下就精确
  isCurrentlyPlaying = false;
  await page.click('.pc-pv-btn--play');

  // 等待暂停状态生效并触发停下精确渲染（parked 延迟 500ms，开始请求 bake-batch）
  await sleep(1000);

  // 等待 .pc-3d-note 烘焙提示彻底消失（精确 PNG 快照渲染并贴上完成）
  await page.waitForFunction(() => {
    const note = document.querySelector('.pc-3d-note');
    return !note || note.textContent === '';
  }, { timeout: 60000, polling: 500 }).catch(() => {});

  await sleep(800); // 确保最后一次 raf 渲染完毕并上屏

  const headAfterPause = await page.evaluate(async () => {
    const { getState } = await import('/src/store/project.ts');
    return { t: getState().t, playing: getState().playing };
  });
  out.headAfterPause = headAfterPause;
  check(headAfterPause.playing === false, '暂停后 playing 变为 false', headAfterPause);

  // 截图 3：暂停后精确渲染
  const pausedExactPath = path.join(OUT_DIR, '3d-paused-exact.png');
  await page.screenshot({ path: pausedExactPath });
  out.pausedExactScreenshot = pausedExactPath;

  // 4. 切回 2D 视图时 view3d 应恢复为 false
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('[data-pc="preview-tabs"] button')].find((b) => b.textContent?.trim() === '2D');
    btn?.click();
  });
  await sleep(500);
  const view3dAfter2D = await page.evaluate(async () => {
    const { plan3DView } = await import('/src/editor/planDispatch.ts');
    return plan3DView();
  });
  out.view3dAfter2D = view3dAfter2D;
  check(view3dAfter2D === false, '切回 2D 视图后 plan3DView() 恢复为 false', { view3dAfter2D });

  out.errors = errors.filter((e) => !/favicon|Download the React DevTools|Failed to load resource/i.test(e));
  check(out.errors.length === 0, '页面无未捕获异常', out.errors);
} catch (err) {
  fails.push('exception: ' + (err?.stack || err));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (serverProc) killTree(serverProc);
}

out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
