/**
 * remotion 式的框架的端到端探针（任务书 `docs/plan/render-refactor-task.md`「乙」的验收）：真的开发服务器、真的 Chrome。
 *
 * 用法（在仓库根或 worktree 根）：
 *   node scripts/probes/remotion-style-probe.mjs [--port 7440] [--out <截图目录>] [--frames 90]
 *
 * 端口：编辑器用 --port，另占 +1、+2 当舞台端口，三个连号都要空着。不碰用户常驻的 5190～5192。
 *
 * 做什么（卡片源码都取自测试夹具 `server/test/fixtures/remotion-style/`，不进卡片库）：
 *   1. 临时目录里建改动层（PROMPTCUT_CARD_OVERRIDES）与数据目录，在本检出根起一个编辑器（卡片同步关掉）；
 *      建的卡全部写进改动层，检出目录一个文件都不多；
 *   2. 桌面建卡这条路（`POST /api/cards/create`，Agent 的 create_card 调的就是它）：
 *        - 每条规矩的违规样例：回 400，报错里指出违规的那一行；
 *        - 用框架写的三张示例卡与「绕一道往顶层写」的那张：回 200，源码进了改动层；
 *      桌面改卡（`POST /api/cards/edit`）：往示例卡里新加一条违规回 400 并指出行号；
 *   3. 现有的卡照常载入：页面里装载整套卡片（`src/cards/index.ts`），内置卡一张不少、没有被跳过的，
 *      声明成 remotion 式的内置卡在；新建的四张也在；内置卡模块的文本里没有接「锁只读」那一段，新建的有；
 *   4. 三张示例卡各自：从第 0 帧顺着渲到第 N 帧（中途在几个检查点截图），与另开一页直接渲那一帧，截图逐像素相同；
 *      同一页上先渲靠后的帧再渲靠前的帧（倒着跳），也与直接渲相同；检查点之间画面确实不同、画面不是空的；
 *   5. 对照：一张有状态的卡（过不了建卡检查，直接从夹具载入）同样的比法**必须**比出差别——证明这套比法测得出问题；
 *   6. 第二道只读：「绕一道往顶层写」的那张卡载入后，卡片定义是冻住的；不写的时候照常渲，一写组件当场抛 TypeError；
 *   7. 收尾：只结束自己起的进程树；临时目录缺省删掉。
 *
 * 通过标准：fails 为空。输出：过程写 stderr；stdout 只有最后一行 JSON：{ ok, ..., fails: [] }。
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
const PORT = Number(arg('--port', '7440'));
const FRAMES = Number(arg('--frames', '90'));
const FPS = 30;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'remotion-style-probe')));
const KEEP_TEMP = argv.includes('--keep-temp');
fs.mkdirSync(OUT, { recursive: true });
if ([5190, 5191, 5192].some((p) => p >= PORT && p <= PORT + 2)) throw new Error('这一段是用户常驻的开发服务器的端口，换一个');

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
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

const FIX = path.join(ROOT, 'server', 'test', 'fixtures', 'remotion-style');
const fixture = (name) => fs.readFileSync(path.join(FIX, name), 'utf8').replace(/\r\n/g, '\n');
const idOf = (source) => /\bid:\s*"([^"]+)"/.exec(source)[1];
const lineOf = (source, needle) => source.slice(0, source.indexOf(needle)).split('\n').length;

/** 每条规矩的违规样例：文件、违规那一行里的字样 */
const VIOLATIONS = [
  ['real-time.tsx', 'performance.now()'], ['timer.tsx', 'setTimeout('], ['frame-callback.tsx', 'requestAnimationFrame('],
  ['motion.tsx', '<motion.div'], ['presence.tsx', '<AnimatePresence>'], ['css-animation.tsx', 'transition: "opacity'],
  ['random.tsx', 'Math.random()'], ['state.tsx', 'useState(0)'], ['state-ref.tsx', 'frames.current += 1'],
  ['state-top-write.tsx', 'COUNTER.frames += 1'], ['state-global.tsx', 'window as'], ['top-level.tsx', 'let frames = 0'],
  ['import.tsx', 'from "lottie-web"'], ['frame-mode.tsx', 'frameMode: MODES[0]'],
];
const SAMPLES = ['rs-title-reveal.tsx', 'rs-bar-race.tsx', 'rs-orbit-canvas.tsx'];
const ALIAS = 'rs-alias-write.tsx';
/** 顺着渲的途中截图的帧；最后一个是 N */
const CHECKPOINTS = [...new Set([0, 7, 20, 45, FRAMES])].filter((n) => n <= FRAMES).sort((a, b) => a - b);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-remotion-style-probe-'));
const OVERLAY = path.join(TMP, 'card-overrides');
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(OVERLAY, { recursive: true });
const USER_DIR = path.join(ROOT, 'src', 'cards', 'user');
const userDirList = () => fs.readdirSync(USER_DIR).sort();
const RUN = Date.now().toString(36);

const fails = [];
const res = { runId: RUN, port: PORT, frames: FRAMES, checkpoints: CHECKPOINTS };
const fail = (what, detail) => { fails.push(what); say('FAIL', { what, ...(detail ? { detail } : {}) }); };

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

/** 两张截图有多少个像素不同；尺寸不同回 -1 */
function diffPixels(a, b) {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return -1;
  let n = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    if (pa.data[i] !== pb.data[i] || pa.data[i + 1] !== pb.data[i + 1] || pa.data[i + 2] !== pb.data[i + 2] || pa.data[i + 3] !== pb.data[i + 3]) n++;
  }
  return n;
}
/** 不是底色的像素有多少（画面是不是空的） */
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
      PROMPTCUT_DEVICE_ID: `remotionstyle-${RUN}`.padEnd(16, '0'),
      PROMPTCUT_DEVICE_NAME: 'remotion-style-probe',
    },
  });
  const keep = (c) => { log.push(c.toString()); if (log.length > 400) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  say('spawn', { pid: child.pid });
  const origin = `http://127.0.0.1:${PORT}`;
  const HARNESS = `${origin}/scripts/probes/remotion-style-harness.html`;
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
  /** 每个用例一页：新的文档、新的模块实例，谁也不沾谁 */
  const openHarness = async () => {
    const page = await browser.newPage();
    page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 300)));
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

  const api = await openHarness();
  const post = (url, body) => api.evaluate(async (u, b) => {
    const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json().catch(() => null) };
  }, url, body);

  // ---------- 2. 桌面建卡：违规的拒绝并指出行号，合规的落盘
  res.rejected = [];
  for (const [file, needle] of VIOLATIONS) {
    const source = fixture(`violations/${file}`);
    const id = idOf(source);
    const r = await post('/api/cards/create', { id, source, projectId: `probe-${RUN}` });
    const line = lineOf(source, needle);
    const pointed = (r.body?.errors ?? []).find((e) => e.startsWith(`[remotion 式] 第 ${line} 行：`)) ?? null;
    res.rejected.push({ file, status: r.status, line, error: pointed ? pointed.slice(0, 60) : null });
    if (r.status !== 400) fail(`create-${file}-status-${r.status}`);
    if (!pointed) fail(`create-${file}-no-line-${line}`, String(r.body?.error ?? '').slice(0, 300));
    if (fs.existsSync(path.join(OVERLAY, 'src', 'cards', 'user', `${id}.tsx`))) fail(`create-${file}-written`);
  }
  say('rejected', { count: res.rejected.length, sample: res.rejected[0] });
  res.created = [];
  for (const file of [...SAMPLES, ALIAS]) {
    const source = fixture(file);
    const id = idOf(source);
    const r = await post('/api/cards/create', { id, source, projectId: `probe-${RUN}` });
    const stored = path.join(OVERLAY, 'src', 'cards', 'user', `${id}.tsx`);
    const written = fs.existsSync(stored) && fs.readFileSync(stored, 'utf8') === source;
    res.created.push({ file, status: r.status, inOverlay: written });
    if (r.status !== 200) fail(`create-${file}-status-${r.status}`, String(r.body?.error ?? '').slice(0, 400));
    if (!written) fail(`create-${file}-not-in-overlay`);
  }
  say('created', { created: res.created });
  // 桌面改卡：新加一条违规
  {
    const before = fixture('rs-bar-race.tsx');
    const find = '  const count = Math.max(';
    const replace = '  const jitter = Math.random();\n  const count = Math.max(';
    const r = await post('/api/cards/edit', { id: 'rs-bar-race', find, replace });
    const line = lineOf(before.replace(find, replace), 'Math.random()');
    const pointed = (r.body?.errors ?? []).find((e) => e.startsWith(`[remotion 式] 第 ${line} 行：用了不带种子的随机`)) ?? null;
    res.edit = { status: r.status, line, error: pointed ? pointed.slice(0, 60) : null };
    if (r.status !== 400 || !pointed) fail('edit-add-violation-not-rejected', String(r.body?.error ?? '').slice(0, 300));
    const ok = await post('/api/cards/edit', { id: 'rs-bar-race', find: 'name: "随机柱状起伏"', replace: 'name: "随机柱子"' });
    res.editRename = ok.status;
    if (ok.status !== 200) fail(`edit-rename-status-${ok.status}`, String(ok.body?.error ?? '').slice(0, 300));
  }
  if (JSON.stringify(userDirList()) !== JSON.stringify(listBefore)) fail('checkout-user-dir-changed');

  // ---------- 3. 现有的卡照常载入
  {
    const page = await openHarness();
    const warnings = [];
    page.on('console', (m) => { const text = m.text(); if (/\[cards\/user\]|已跳过|card id 重复/.test(text)) warnings.push(text.slice(0, 200)); });
    const reg = await page.evaluate(async () => {
      await import('/src/cards/index.ts');
      const R = await import('/src/kernel/registry.ts');
      const all = R.allCards();
      return {
        total: all.length,
        bySource: all.reduce((acc, c) => { acc[c.source ?? '?'] = (acc[c.source ?? '?'] ?? 0) + 1; return acc; }, {}),
        direct: all.filter((c) => c.frameMode === 'direct').map((c) => c.id).sort(),
        user: all.filter((c) => c.source === 'user').map((c) => c.id).sort(),
        noComponent: all.filter((c) => typeof c.Component !== 'function' && typeof c.card !== 'function' && typeof c.audio !== 'function').map((c) => c.id),
      };
    });
    res.registry = { ...reg, warnings };
    say('registry', res.registry);
    // 内置卡的数目按源码数：native、magicui、探针卡三个目录里的定义，加素材目录生成的
    const builtinTotal = reg.total - reg.user.length;
    if (builtinTotal < 101) fail(`builtin-cards-${builtinTotal}-lt-101`);
    for (const id of ['av-pulse', 'caption-track']) if (!reg.direct.includes(id)) fail(`builtin-direct-missing-${id}`);
    for (const id of ['rs-alias-write', 'rs-bar-race', 'rs-orbit-canvas', 'rs-title-reveal']) if (!reg.user.includes(id)) fail(`created-card-not-registered-${id}`);
    if (reg.noComponent.length) fail('cards-without-outlet', reg.noComponent.join(','));
    if (warnings.length) fail('card-load-warnings', warnings.join(' | '));
    // 模块文本：内置卡不接「锁只读」那一段，用框架写的用户卡接
    const text = (url) => page.evaluate((u) => fetch(u).then((r) => r.text()), url);
    const locked = {};
    for (const url of ['/src/cards/native/av-pulse.tsx', '/src/cards/native/caption-track.tsx', '/src/cards/user/mu-animated-shiny-text.tsx', '/src/cards/user/rs-title-reveal.tsx', '/src/cards/user/rs-alias-write.tsx']) {
      locked[url] = /__pcLockTopLevel/.test(await text(url));
    }
    res.lockAttached = locked;
    for (const [url, has] of Object.entries(locked)) if (has !== /\/user\/rs-/.test(url)) fail(`lock-attached-wrong-${url}`);
    await page.close();
  }

  // ---------- 4. 示例卡：顺着渲到第 N 帧 与 直接渲第 N 帧，逐像素比
  res.samples = [];
  for (const file of SAMPLES) {
    const id = idOf(fixture(file));
    const url = `/src/cards/user/${id}.tsx`;
    const t0 = Date.now();
    // 顺着渲：一页、一次挂载，从第 0 帧一帧帧到第 N 帧
    const seq = await openHarness();
    const info = await seq.evaluate((u) => window.__rs.load(u), url);
    if (!info.frozen || !info.defaultsFrozen) fail(`sample-${id}-not-locked`);
    await seq.evaluate(() => window.__rs.mount(0));
    const sequential = new Map();
    for (let n = 0; n <= FRAMES; n++) {
      if (n > 0) await seq.evaluate((t) => window.__rs.set(t), n / FPS);
      if (CHECKPOINTS.includes(n)) { await settle(seq); sequential.set(n, await shot(seq)); }
    }
    // 同一页上倒着跳：先渲靠后的帧，再渲靠前的帧
    const jumped = new Map();
    for (const n of [...CHECKPOINTS].reverse()) {
      await seq.evaluate((t) => window.__rs.set(t), n / FPS);
      await settle(seq);
      jumped.set(n, await shot(seq));
    }
    const seqError = await seq.evaluate(() => window.__rs.error());
    await seq.close();
    if (seqError) fail(`sample-${id}-render-error`, seqError.message);
    // 直接渲：每个检查点另开一页，挂上去就是那一帧
    const rows = [];
    for (const n of CHECKPOINTS) {
      const page = await openHarness();
      await page.evaluate((u) => window.__rs.load(u), url);
      await page.evaluate((t) => window.__rs.mount(t), n / FPS);
      await settle(page);
      const direct = await shot(page);
      await page.close();
      const row = { frame: n, seqVsDirect: diffPixels(sequential.get(n), direct), jumpVsDirect: diffPixels(jumped.get(n), direct), ink: inkPixels(direct) };
      rows.push(row);
      fs.writeFileSync(path.join(OUT, `${id}-f${String(n).padStart(3, '0')}-direct.png`), direct);
      if (row.seqVsDirect !== 0) { fail(`sample-${id}-f${n}-sequential-differs-${row.seqVsDirect}`); fs.writeFileSync(path.join(OUT, `${id}-f${String(n).padStart(3, '0')}-sequential.png`), sequential.get(n)); }
      if (row.jumpVsDirect !== 0) { fail(`sample-${id}-f${n}-jump-differs-${row.jumpVsDirect}`); fs.writeFileSync(path.join(OUT, `${id}-f${String(n).padStart(3, '0')}-jumped.png`), jumped.get(n)); }
    }
    // 画面确实在动、最后一帧不是空的
    const moving = diffPixels(sequential.get(CHECKPOINTS[1]), sequential.get(CHECKPOINTS.at(-1)));
    if (!(moving > 500)) fail(`sample-${id}-not-moving-${moving}`);
    if (!(rows.at(-1).ink > 2000)) fail(`sample-${id}-blank-${rows.at(-1).ink}`);
    res.samples.push({ id, rows, movingPixels: moving, ms: Date.now() - t0 });
    say('sample', res.samples.at(-1));
  }

  // ---------- 5. 对照：有状态的卡，同样的比法必须比出差别
  {
    const url = '/server/test/fixtures/remotion-style/rs-stateful-control.tsx';
    const seq = await openHarness();
    await seq.evaluate((u) => window.__rs.load(u), url);
    await seq.evaluate(() => window.__rs.mount(0, { text: '#' }));
    for (let n = 1; n <= 20; n++) await seq.evaluate((t) => window.__rs.set(t), n / FPS);
    await settle(seq);
    const sequential = await shot(seq);
    await seq.close();
    const page = await openHarness();
    await page.evaluate((u) => window.__rs.load(u), url);
    await page.evaluate((t) => window.__rs.mount(t, { text: '#' }), 20 / FPS);
    await settle(page);
    const direct = await shot(page);
    await page.close();
    const differs = diffPixels(sequential, direct);
    res.control = { differs };
    fs.writeFileSync(path.join(OUT, 'control-sequential.png'), sequential);
    fs.writeFileSync(path.join(OUT, 'control-direct.png'), direct);
    if (!(differs > 100)) fail(`control-not-detected-${differs}`);
    say('control', res.control);
  }

  // ---------- 6. 第二道只读：载入后往顶层写当场报错
  {
    const url = '/src/cards/user/rs-alias-write.tsx';
    const page = await openHarness();
    const info = await page.evaluate((u) => window.__rs.load(u), url);
    await page.evaluate(() => window.__rs.mount(0.5, { text: 'read-only' }));
    await settle(page);
    const quietError = await page.evaluate(() => window.__rs.error());
    const quietInk = inkPixels(await shot(page));
    await page.evaluate(() => window.__rs.unmount());
    const errors = {};
    for (const text of ['write-object', 'write-array']) {
      await page.evaluate((x) => window.__rs.mount(0.5, { text: x }), text);
      errors[text] = await page.evaluate(() => window.__rs.error());
      await page.evaluate(() => window.__rs.unmount());
    }
    // 没写进去：再渲一次不写的，读到的还是初值
    await page.evaluate(() => window.__rs.mount(0.5, { text: 'read-only' }));
    const after = await page.evaluate(() => document.getElementById('stage').textContent);
    await page.close();
    res.lock = { frozen: info.frozen, defaultsFrozen: info.defaultsFrozen, componentFrozen: info.componentFrozen, quietError, quietInk, errors, after };
    say('lock', res.lock);
    if (!info.frozen || !info.defaultsFrozen || !info.componentFrozen) fail('lock-card-def-not-frozen');
    if (quietError) fail('lock-read-only-render-threw', quietError.message);
    if (!(quietInk > 200)) fail(`lock-read-only-render-blank-${quietInk}`);
    for (const [text, e] of Object.entries(errors)) if (!e || e.name !== 'TypeError') fail(`lock-${text}-did-not-throw`, JSON.stringify(e));
    if (after !== 'read-only01') fail(`lock-write-went-through-${after}`);
  }

  res.pageErrors = pageErrors;
  // 第 6 步里组件抛的 TypeError 被画面台接住，不算页面错误；别的页面错误算失败
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
