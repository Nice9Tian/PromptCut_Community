/**
 * 建卡指南的「盲写」验收脚本（任务书 `docs/plan/render-refactor-task.md`「丙」的验收：派一个不带上下文的子 Agent，只读
 * `server/card-authoring-guide.md`，各写一张 remotion 式和一张 motion 式的卡，都能通过建卡检查并渲染正确）。
 *
 * 给它两个源码文件，它：
 *   1. 在临时目录里建改动层与数据目录，在本检出根起一个自己的开发服务器（卡片同步关掉），建的卡只写进改动层，检出目录一个文件都不多；
 *   2. 经真的 `POST /api/cards/create`（Agent 的 `create_card` 调的就是它）把两张卡建出来，必须都回 200；
 *   3. 在真 Chrome 里渲染（画面台 `scripts/probes/remotion-style-harness.html?css=1`，只把卡的 Component 挂在 1920×1080 的框里，带上编辑器自己的样式，用 Tailwind 类写的卡也排得对）：
 *        - remotion 式的那张：和 `remotion-style-probe.mjs` 一样的办法——在一页上从第 0 帧顺着渲到第 N 帧（中途在几个检查点截图），
 *          与另开一页直接渲那一帧逐像素比，再在同一页上倒着跳一遍也比；检查点之间画面确实不同、最后一帧不是空的；
 *        - motion 式的那张：挂上后顺着播若干帧（每帧等一小会儿，让 Motion 之类自带时钟的动画往前走），确认画面在变、最后一帧不是空的；
 *      各存几张截图到 --out；
 *   4. 收尾：只结束自己起的进程树；临时目录缺省删掉。
 *
 * 用法（在仓库根或 worktree 根）：
 *   node scripts/probes/guide-blind-check.mjs --remotion <remotion 式的卡的 .tsx> --motion <motion 式的卡的 .tsx>
 *        [--port 7450] [--out <截图目录>] [--frames 90] [--motion-seconds 2] [--keep-temp]
 *
 * 端口：编辑器用 --port，另占 +1、+2 当舞台端口，三个连号都要空着。不碰用户常驻的 5190～5192、58xx、59xx。
 * 两张卡也可以只给一张（只验那一种）。卡的 Component 要存在（画面台只挂 DOM 卡）。
 *
 * remotion 式那张的判据（2026-10-13 主会话用盲写的两张卡实跑后定）：
 *   - 同一页「顺着渲」对「倒着跳」：必须 **0** 个像素不同。同一页上两条路径走到同一个 t，画面逐像素相同，这才是「卡是时间的纯函数」的判据；
 *   - 另开新页「直接渲」对同一页「顺着渲」：允许极小的容差——不同的像素不超过总数的十万分之五（1920×1080 是 103 个），且最大通道差不超过 2。
 *     输出里照样打印实际的像素数和最大通道差（`seqVsDirect` / `jumpVsDirect` 里的 `px`、`max`），不因为过了容差就不打印。
 *   原因（核实过）：用盲写的 blind-counter 在第 20、45、90 帧各比一次：新页与同页的 DOM（innerHTML）和每个元素的计算样式逐字相同；
 *   而两个全新的页面彼此之间也差 0～32 个像素（去掉所有不透明度淡入后还是 0～15 个），差的是大数字字形边缘的文字抗锯齿，最大通道差 2 以内。
 *   所以这几个像素是 Chrome 每个页面各自的文字光栅化/合成历史造成的，不是卡读了前一帧的东西（读了前一帧会差成百上千个像素，
 *   `remotion-style-probe.mjs` 的有状态对照卡差 13619 个）。
 *
 * 通过标准：fails 为空，退出码 0；不过退出码 1；用法不对或起不来退出码 2。
 * 输出：过程写 stderr；stdout 只有最后一行 JSON：{ ok, ..., fails: [] }。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import：不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const PORT = Number(arg('--port', '7450'));
const FRAMES = Number(arg('--frames', '90'));
const MOTION_SECONDS = Number(arg('--motion-seconds', '2'));
const FPS = 30;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'guide-blind-check')));
const KEEP_TEMP = argv.includes('--keep-temp');
const REMOTION_FILE = arg('--remotion', null);
const MOTION_FILE = arg('--motion', null);

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const die = (message, code = 2) => { process.stdout.write(`${JSON.stringify({ ok: false, fails: [message] })}\n`); process.exit(code); };
if (!REMOTION_FILE && !MOTION_FILE) die('用法：--remotion <文件> 和/或 --motion <文件>');
if ([5190, 5191, 5192].some((p) => p >= PORT && p <= PORT + 2) || (PORT >= 5800 && PORT < 6000)) die('这一段端口是用户常驻或别的探针占的，换一个');
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时(${ms} ms)`);
    await sleep(150);
  }
}

/** 读一张卡的源码，认出它的 id 和声明的写法 */
function loadCard(label, file, expectMode) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) die(`${label}：找不到文件 ${abs}`);
  const source = fs.readFileSync(abs, 'utf8').replace(/\r\n/g, '\n');
  const id = /\bid:\s*["'`]([^"'`]+)["'`]/.exec(source)?.[1];
  const mode = /\bframeMode:\s*["'`](direct|stateful)["'`]/.exec(source)?.[1] ?? null;
  if (!id) die(`${label}：源码里读不出 id`);
  return { label, file: abs, source, id, mode, expectMode };
}
const cardsToCheck = [
  REMOTION_FILE ? loadCard('remotion', REMOTION_FILE, 'direct') : null,
  MOTION_FILE ? loadCard('motion', MOTION_FILE, 'stateful') : null,
].filter(Boolean);
if (cardsToCheck.length === 2 && cardsToCheck[0].id === cardsToCheck[1].id) die('两张卡的 id 相同');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-guide-blind-'));
const OVERLAY = path.join(TMP, 'card-overrides');
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OVERLAY, { recursive: true });
const USER_DIR = path.join(ROOT, 'src', 'cards', 'user');
const userDirList = () => fs.readdirSync(USER_DIR).sort();
const RUN = Date.now().toString(36);

const fails = [];
const res = { runId: RUN, port: PORT, frames: FRAMES, cards: cardsToCheck.map((c) => ({ label: c.label, id: c.id, declared: c.mode })) };
const fail = (what, detail) => { fails.push(what); say('FAIL', { what, ...(detail ? { detail } : {}) }); };

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

/** 两张截图：不同的像素数 px、最大通道差 max（0～255）、总像素数 total；尺寸不同 px 回 -1 */
function diffStats(a, b) {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return { px: -1, max: 255, total: pa.width * pa.height };
  let px = 0, max = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    let d = 0;
    for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(pa.data[i + c] - pb.data[i + c]));
    if (d > 0) { px++; if (d > max) max = d; }
  }
  return { px, max, total: pa.width * pa.height };
}
const diffPixels = (a, b) => diffStats(a, b).px;
/** 新页直接渲对同页顺着渲的容差：不超过总数的十万分之五，最大通道差不超过 2 */
const TOLERANCE = { fraction: 5e-5, maxChannel: 2 };
const withinTolerance = (d) => d.px >= 0 && d.px <= Math.floor(d.total * TOLERANCE.fraction) && d.max <= TOLERANCE.maxChannel;
/** 不是画面台底色的像素有多少（画面是不是空的） */
function inkPixels(buf) {
  const p = PNG.sync.read(buf);
  let n = 0;
  for (let i = 0; i < p.data.length; i += 4) if (p.data[i] !== 0x10 || p.data[i + 1] !== 0x14 || p.data[i + 2] !== 0x18) n++;
  return n;
}

let child = null;
let browser = null;
const listBefore = userDirList();
try {
  // ---------- 1. 编辑器（带改动层）
  const log = [];
  child = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: {
      ...process.env,
      BROWSER: 'none',
      PROMPTCUT_DATA_DIR: DATA,
      PROMPTCUT_CARD_OVERRIDES: OVERLAY,
      PROMPTCUT_CARD_SYNC: '0',
      PROMPTCUT_PUSH: '0',
      PROMPTCUT_LAN_HOST: '',
      PROMPTCUT_DEVICE_ID: `guideblind-${RUN}`.padEnd(16, '0'),
      PROMPTCUT_DEVICE_NAME: 'guide-blind-check',
    },
  });
  const keep = (c) => { log.push(c.toString()); if (log.length > 400) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  say('spawn', { pid: child.pid });
  const origin = `http://127.0.0.1:${PORT}`;
  const HARNESS = `${origin}/scripts/probes/remotion-style-harness.html?css=1`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`编辑器退出了：${log.join('').slice(-600)}`);
    return fetch(HARNESS, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 180_000, '编辑器起来');

  browser = await puppeteer.launch({
    headless: true,
    defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'],
  });
  res.chrome = await browser.version();
  const pageErrors = [];
  const consoleErrors = [];
  /** 每个用例一页：新的文档、新的模块实例，谁也不沾谁 */
  const openHarness = async () => {
    const page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
    page.on('dialog', (d) => void d.dismiss());
    await page.goto(HARNESS, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__rsReady === true, { timeout: 120_000 });
    return page;
  };
  const shot = async (page) => Buffer.from(await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1920, height: 1080 } }));
  /** 等字体与这一帧画完（两次动画帧），再截 */
  const settle = (page) => page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });
  const save = (name, buf) => { fs.writeFileSync(path.join(OUT, name), buf); return path.join(OUT, name); };

  const api = await openHarness();
  const post = (url, body) => api.evaluate(async (u, b) => {
    const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, url, body);

  // ---------- 2. 建卡（真的 /api/cards/create）
  res.created = [];
  for (const c of cardsToCheck) {
    if (c.mode !== c.expectMode) fail(`${c.label}-declared-${c.mode ?? 'none'}-expected-${c.expectMode}`);
    const r = await post('/api/cards/create', { id: c.id, source: c.source, projectId: `blind-${RUN}` });
    const stored = path.join(OVERLAY, 'src', 'cards', 'user', `${c.id}.tsx`);
    const inOverlay = fs.existsSync(stored) && fs.readFileSync(stored, 'utf8') === c.source;
    res.created.push({ label: c.label, id: c.id, status: r.status, inOverlay, errors: r.status === 200 ? undefined : (r.body?.errors ?? [r.body?.error]).slice(0, 12) });
    say('create', res.created.at(-1));
    if (r.status !== 200) fail(`${c.label}-create-status-${r.status}`, JSON.stringify(r.body?.errors ?? r.body?.error).slice(0, 800));
    else if (!inOverlay) fail(`${c.label}-create-not-in-overlay`);
    c.created = r.status === 200 && inOverlay;
  }
  if (JSON.stringify(userDirList()) !== JSON.stringify(listBefore)) fail('checkout-user-dir-changed');

  // ---------- 3a. remotion 式：顺着渲到第 N 帧 与 直接渲第 N 帧，逐像素比
  const rem = cardsToCheck.find((c) => c.label === 'remotion');
  if (rem?.created) {
    const url = `/src/cards/user/${rem.id}.tsx`;
    const checkpoints = [...new Set([0, 7, 20, 45, FRAMES])].filter((n) => n <= FRAMES).sort((a, b) => a - b);
    const t0 = Date.now();
    const seq = await openHarness();
    const info = await seq.evaluate((u) => window.__rs.load(u), url);
    await seq.evaluate(() => window.__rs.mount(0));
    const sequential = new Map();
    for (let n = 0; n <= FRAMES; n++) {
      if (n > 0) await seq.evaluate((t) => window.__rs.set(t), n / FPS);
      if (checkpoints.includes(n)) { await settle(seq); sequential.set(n, await shot(seq)); }
    }
    const jumped = new Map();
    for (const n of [...checkpoints].reverse()) {
      await seq.evaluate((t) => window.__rs.set(t), n / FPS);
      await settle(seq);
      jumped.set(n, await shot(seq));
    }
    const seqError = await seq.evaluate(() => window.__rs.error());
    await seq.close();
    if (seqError) fail('remotion-render-error', `${seqError.name}: ${seqError.message}`);
    const rows = [];
    const saved = [];
    for (const n of checkpoints) {
      const page = await openHarness();
      await page.evaluate((u) => window.__rs.load(u), url);
      await page.evaluate((t) => window.__rs.mount(t), n / FPS);
      await settle(page);
      const direct = await shot(page);
      const directError = await page.evaluate(() => window.__rs.error());
      await page.close();
      if (directError) fail(`remotion-f${n}-direct-render-error`, `${directError.name}: ${directError.message}`);
      const seqVsDirect = diffStats(sequential.get(n), direct), jumpVsDirect = diffStats(jumped.get(n), direct), seqVsJump = diffStats(sequential.get(n), jumped.get(n));
      const row = { frame: n, seqVsJump: seqVsJump.px, seqVsDirect: { px: seqVsDirect.px, max: seqVsDirect.max }, jumpVsDirect: { px: jumpVsDirect.px, max: jumpVsDirect.max }, ink: inkPixels(direct) };
      rows.push(row);
      saved.push(save(`remotion-${rem.id}-f${String(n).padStart(3, '0')}-direct.png`, direct));
      // 同一页上两条路径必须逐像素相同；新页直接渲允许极小的容差（见文件头）
      if (seqVsJump.px !== 0) { fail(`remotion-f${n}-same-page-sequential-vs-jump-differs-${seqVsJump.px}`); save(`remotion-${rem.id}-f${String(n).padStart(3, '0')}-sequential.png`, sequential.get(n)); save(`remotion-${rem.id}-f${String(n).padStart(3, '0')}-jumped.png`, jumped.get(n)); }
      if (!withinTolerance(seqVsDirect)) { fail(`remotion-f${n}-new-page-differs-${seqVsDirect.px}px-max${seqVsDirect.max}`); save(`remotion-${rem.id}-f${String(n).padStart(3, '0')}-sequential.png`, sequential.get(n)); }
      if (!withinTolerance(jumpVsDirect)) { fail(`remotion-f${n}-jump-vs-new-page-differs-${jumpVsDirect.px}px-max${jumpVsDirect.max}`); save(`remotion-${rem.id}-f${String(n).padStart(3, '0')}-jumped.png`, jumped.get(n)); }
    }
    const first = checkpoints[0], last = checkpoints.at(-1);
    const moving = Math.max(...checkpoints.slice(1).map((n) => diffPixels(sequential.get(first), sequential.get(n))));
    if (!(moving > 300)) fail(`remotion-not-moving-${moving}`);
    if (!(rows.at(-1).ink > 300)) fail(`remotion-last-frame-blank-${rows.at(-1).ink}`);
    res.remotion = { tolerance: { ...TOLERANCE, pixelsAt1080p: Math.floor(1920 * 1080 * TOLERANCE.fraction) }, id: rem.id, frozen: info.frozen, frameMode: info.frameMode, checkpoints, rows, movingPixels: moving, lastInk: rows.at(-1).ink, ms: Date.now() - t0, screenshots: saved };
    say('remotion', res.remotion);
  }

  // ---------- 3b. motion 式：顺着播若干帧，画面在变、不是空的
  const mot = cardsToCheck.find((c) => c.label === 'motion');
  if (mot?.created) {
    const url = `/src/cards/user/${mot.id}.tsx`;
    const t0 = Date.now();
    const page = await openHarness();
    const info = await page.evaluate((u) => window.__rs.load(u), url);
    await page.evaluate(() => window.__rs.mount(0));
    const steps = Math.max(4, Math.round(MOTION_SECONDS * 5));
    const shots = [];
    for (let i = 0; i <= steps; i++) {
      if (i > 0) {
        await sleep(200); // 让 Motion 之类自带时钟的动画往前走
        await page.evaluate((t) => window.__rs.set(t), (i * 200) / 1000);
      }
      await settle(page);
      shots.push(await shot(page));
    }
    const err = await page.evaluate(() => window.__rs.error());
    await page.close();
    if (err) fail('motion-render-error', `${err.name}: ${err.message}`);
    const pick = [...new Set([0, Math.round(steps / 3), Math.round((2 * steps) / 3), steps])];
    const saved = pick.map((i) => save(`motion-${mot.id}-step${String(i).padStart(2, '0')}.png`, shots[i]));
    const inks = shots.map(inkPixels);
    let moving = 0;
    for (let i = 1; i < shots.length; i++) moving = Math.max(moving, diffPixels(shots[i - 1], shots[i]));
    const total = diffPixels(shots[0], shots.at(-1));
    if (!(Math.max(moving, total) > 300)) fail(`motion-not-moving-${Math.max(moving, total)}`);
    if (!(inks.at(-1) > 300)) fail(`motion-last-frame-blank-${inks.at(-1)}`);
    res.motion = { id: mot.id, frameMode: info.frameMode, steps, inks, maxStepDiff: moving, firstVsLast: total, ms: Date.now() - t0, screenshots: saved };
    say('motion', res.motion);
  }

  res.pageErrors = pageErrors;
  res.consoleErrors = consoleErrors.slice(0, 5);
  if (pageErrors.length) fail('page-errors', pageErrors.slice(0, 3).join(' | '));
  if (JSON.stringify(userDirList()) !== JSON.stringify(listBefore)) fail('checkout-user-dir-changed-at-end');
} catch (err) {
  fail('probe-crashed', String(err?.stack ?? err).slice(0, 600));
} finally {
  try { await browser?.close(); } catch { /* 已经关了 */ }
  if (child?.pid && child.exitCode === null) {
    // 只结束自己起的这一棵（编辑器下面还挂着预渲染进程和 Chrome）
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    else child.kill('SIGKILL');
    say('stopped', { pid: child.pid });
  }
  if (!KEEP_TEMP) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 留给系统清 */ } }
}
process.stdout.write(`${JSON.stringify({ ok: fails.length === 0, ...res, out: OUT, fails })}\n`);
process.exit(fails.length === 0 ? 0 : 1);
