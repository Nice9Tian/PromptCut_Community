/**
 * 用 remotion 式的框架写的用户卡，经**在线页面自己的卡片运行时**（`src/online/cardRuntime/` 的转译、加载器、页面自带的模块表）
 * 在真浏览器（Chrome）里能不能载入并画对（任务书 `docs/plan/render-refactor-task.md`「丙」第 7 条第一处；
 * 框架合入时（「乙」）只在 Node 里跑过这一段，没有在真浏览器里验）。
 *
 *   node scripts/probes/online-remotion-card-probe.mjs [--port 7450] [--out <截图目录>] [--keep-temp]
 *
 * 做法：在本检出根起一个自己的开发服务器（端口 --port，另占 +1、+2；卡片同步关掉），真 Chrome 打开画面台
 * `scripts/probes/online-runtime-harness.html`：它把探针给的卡片源码（同步来的用户卡的样子：键 → 文本）交给在线页面的 `bundleCards`
 * 转译（Sucrase，含载入时锁只读那一句）、`createCardLoader` 载入（`new Function`、页面自带的模块表），再把载入出来的卡按 t 渲。
 *
 * **没有覆盖的**（写进报告）：经账号加入协作项目、内容库同步、跨源舞台 iframe 与内容安全策略。原因：在线构建的开始页现在只剩账号入口
 * （`StartPage.tsx` 的 `OnlineStartPage` 只挂 `AccountProjects`，`data-pc="join-form"` 不在在线构建里），`online-card-exec-probe.mjs` 这一类
 * 靠 `join-form` 加入项目的探针在 main 上已经走不通；走账号要冻结的官网加 63xx 固定端口的夹具（`account-user-pages-probe.mjs`），不在这次的范围里。
 *
 * 项目里放四张卡（都当作同步来的用户卡载入）：
 *   rs-title-reveal   测试夹具里的示例卡，原样（弹簧、错开进场、颜色过渡，行内样式）
 *   rs-orbit-canvas   测试夹具里的示例卡，原样（画布；每一帧清空重画）
 *   rs-online-mark    探针卡：用框架写，把 interpolate / random 算出来的值和「顶层对象是不是只读」写成 DOM 的数据属性
 *   rs-online-control 对照：同一张卡声明成 motion 式（不锁只读）
 *
 * # 验收（每条「过 / 不过」；最后一行是 JSON `{ ok, pass, fail, fails, ... }`；退出码 = 有没有「不过」）
 *
 * R1 四张卡都转译、载入成功（运行状态 ready）；框架卡的转译结果里接着载入时锁只读的那一句，对照卡不接。
 * R2 画出来了：示例卡画的字（逐字弹入的标题）都在；画布卡的画布上有像素。
 * R3 画得对：探针卡的 DOM 数据属性（位置、随机数）和本进程里用同一套框架算的逐字相同，三个 t 各一份；先到靠后的 t 再倒回靠前的，值与第一次相同。
 * R4 锁只读：探针卡里「顶层对象是只读」为真；对照卡（motion 式）为假；载入出来的卡定义是冻住的。
 * R5 画布卡每一帧整张重画：两个不同的 t 上画布的像素不同，回到先前的 t 上与先前逐像素相同。
 * R6 页面没有报错。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import：不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { Easing, interpolate, random } from '../../src/kernel/remotionStyle/index.ts';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = Number(arg('--port', 7450));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'online-remotion-card-probe')));
const KEEP_TEMP = argv.includes('--keep-temp');
if ([5190, 5191, 5192].some((p) => p >= PORT && p <= PORT + 2) || (PORT >= 5800 && PORT < 6000)) {
  console.log(JSON.stringify({ ok: false, fails: ['这一段端口是用户常驻或别的探针占的，换一个'] }));
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
let pass = 0;
const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s === undefined ? '' : (s.length > 500 ? `${s.slice(0, 500)}…` : s); };
const check = (label, ok, detail) => { console.log(`${ok ? '  过' : '不过'}  ${label}${detail !== undefined ? `  〔${short(detail)}〕` : ''}`); if (ok) pass++; else fails.push(label); return !!ok; };
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

/* ------------------------------------------------------------------ 卡片源码 */
const FIX = path.join(ROOT, 'server', 'test', 'fixtures', 'remotion-style');
const fixture = (n) => fs.readFileSync(path.join(FIX, n), 'utf8').replace(/\r\n/g, '\n');
const markCard = (id, mode) => `/** 探针卡：用框架写，把算出来的值写成 DOM 的数据属性 */
import type { CardDef, CardProps } from "../../kernel/types";
import { Easing, interpolate, random } from "../../kernel/remotionStyle";

interface Params { seed: number }

const CONFIG = { ease: Easing.out(Easing.cubic), span: 400 };

function OnlineMark({ params, t = 0 }: CardProps<Params>) {
  const x = interpolate(t, [0, 1], [0, CONFIG.span], { easing: CONFIG.ease });
  const r = random(params.seed, 1);
  return (
    <div
      data-rs-mark="${id}"
      data-rs-t={t.toFixed(4)}
      data-rs-x={x.toFixed(4)}
      data-rs-r={r.toFixed(6)}
      data-rs-readonly={String(Object.isFrozen(CONFIG))}
      style={{ position: "absolute", left: 100 + x, top: 400, width: 200, height: 200, borderRadius: 24, background: "hsl(" + Math.round(r * 360) + ", 80%, 60%)" }}
    />
  );
}

export const onlineMark: CardDef<Params> = {
  id: "${id}",
  name: "在线框架探针卡",
  description: "用框架写的探针卡：一个色块从左往右移，数据属性里记着算出来的值",
  source: "user",
  useWhen: "探针用，不用于真实项目。",
  tags: ["探针"],
  frameMode: "${mode}",
  defaults: { seed: 5 },
  controls: [{ key: "seed", label: "种子", type: "number", min: 0, max: 9999, step: 1 }],
  Component: OnlineMark,
};
`;
const U = 'src/cards/user/';
const CARDS = {
  'rs-title-reveal': fixture('rs-title-reveal.tsx'),
  'rs-orbit-canvas': fixture('rs-orbit-canvas.tsx'),
  'rs-online-mark': markCard('rs-online-mark', 'direct'),
  'rs-online-control': markCard('rs-online-control', 'stateful'),
};
const SOURCES = Object.fromEntries(Object.entries(CARDS).map(([id, body]) => [`${U}${id}.tsx`, body]));
const ENTRIES = Object.keys(SOURCES);
const CARD_IDS = Object.keys(CARDS);

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-online-rs-'));
function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

let child = null, browser = null;
const summary = { out: OUT, port: PORT };
try {
  const log = [];
  fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
  fs.mkdirSync(path.join(TMP, 'overlay'), { recursive: true });
  child = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, BROWSER: 'none', PROMPTCUT_DATA_DIR: path.join(TMP, 'data'), PROMPTCUT_CARD_OVERRIDES: path.join(TMP, 'overlay'), PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '', PROMPTCUT_DEVICE_ID: 'onliners-probe-0001', PROMPTCUT_DEVICE_NAME: 'online-remotion-card-probe' },
  });
  const keep = (c) => { log.push(c.toString()); if (log.length > 400) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const HARNESS = `http://127.0.0.1:${PORT}/scripts/probes/online-runtime-harness.html`;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`开发服务器退出了：${log.join('').slice(-600)}`);
    return fetch(HARNESS, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 180_000, '开发服务器起来');

  browser = await puppeteer.launch({
    headless: true, defaultViewport: { width: 1920, height: 1080, deviceScaleFactor: 1 },
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'],
  });
  summary.chrome = await browser.version();
  const pageErrors = [];
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e).slice(0, 300)));
  page.on('dialog', (d) => void d.dismiss());
  await page.goto(HARNESS, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__orsReady === true, { timeout: 120_000 });
  const settle = () => page.evaluate(async () => { await document.fonts.ready; await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); });
  const clip = { x: 0, y: 0, width: 1920, height: 1080 };

  console.log('\n== R1 转译、载入');
  const loaded = await page.evaluate((s, e) => window.__ors.setSources(s, e), SOURCES, ENTRIES);
  summary.R1 = { runtime: await page.evaluate(() => window.__ors.runtime), ...loaded };
  check('R1 四张卡都转译成功', loaded.bundled.length === 4 && loaded.bundled.every((b) => b.ok), loaded.bundled);
  check('R1 四张卡都载入成功（运行状态 ready，卡定义都认出来了）', loaded.loaded.length === 4 && loaded.loaded.every((l) => l.ok) && CARD_IDS.every((id) => loaded.cards.some((c) => c.id === id)), loaded.loaded);
  const lockOf = Object.fromEntries(loaded.bundled.map((b) => [b.entry.split('/').pop().replace('.tsx', ''), b.lockSuffix]));
  check('R1 转译结果里：引用了框架的 remotion 式的卡（示例卡两张、探针卡）接着「载入时锁只读」那一句；motion 式的对照卡不接',
    lockOf['rs-title-reveal'] && lockOf['rs-orbit-canvas'] && lockOf['rs-online-mark'] && !lockOf['rs-online-control'], lockOf);

  console.log('\n== R2 画出来了');
  await page.evaluate(() => window.__ors.mount('rs-title-reveal', 3));
  await settle();
  const title = await page.evaluate(() => ({ text: document.getElementById('stage').textContent, error: window.__ors.error() }));
  await page.screenshot({ path: path.join(OUT, 'online-title-t3.png'), clip });
  check('R2 示例卡画的字（默认文字「由 t 直接算」）都在，没有渲染错误', title.text === '由 t 直接算' && !title.error, title);
  await page.evaluate(() => window.__ors.unmount());
  /** 画布卡的画面：用截图的哈希比（对画布 getImageData 会让 Chrome 把它换成软件画布、边缘的抗锯齿就变了，所以读像素放在最后） */
  const shotHash = async (name) => { const buf = Buffer.from(await page.screenshot({ clip })); if (name) fs.writeFileSync(path.join(OUT, name), buf); return createHash('sha256').update(buf).digest('hex').slice(0, 16); };
  const inkOf = () => page.evaluate(() => {
    const c = document.querySelector('#stage canvas');
    if (!c) return null;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) ink++;
    return { ink };
  });
  await page.evaluate(() => window.__ors.mount('rs-orbit-canvas', 1));
  await settle();
  const h1 = await shotHash('online-orbit-t1.png');
  console.log('\n== R5 画布卡每一帧整张重画');
  const seq = [h1];
  for (const t of [1, 2.5, 1, 2.5, 1]) { await page.evaluate((x) => window.__ors.set(x), t); await settle(); seq.push(await shotHash(t === 2.5 ? 'online-orbit-t25.png' : null)); }
  summary.R5seq = seq;
  check('R5 两个不同的 t 上画布的画面不同；回到先前的 t 上（连着换几次）与先前逐像素相同', seq[0] === seq[1] && seq[0] === seq[3] && seq[0] === seq[5] && seq[2] === seq[4] && seq[0] !== seq[2], seq);
  const c1 = await inkOf();
  check('R2 画布卡的画布上有像素', (c1?.ink ?? 0) > 500, c1);
  await page.evaluate(() => window.__ors.unmount());


  console.log('\n== R3 画得对');
  const ease = Easing.out(Easing.cubic);
  const expected = (t) => ({ x: interpolate(t, [0, 1], [0, 400], { easing: ease }).toFixed(4), r: random(5, 1).toFixed(6) });
  let mounted = false;
  const markAt = async (id, t) => {
    await page.evaluate((i, x, m) => { if (!m) window.__ors.mount(i, x); else window.__ors.set(x); }, id, t, mounted);
    mounted = true;
    await settle();
    return page.evaluate(() => { const m = document.querySelector('[data-rs-mark]'); return m ? { t: m.getAttribute('data-rs-t'), x: m.getAttribute('data-rs-x'), r: m.getAttribute('data-rs-r'), readonly: m.getAttribute('data-rs-readonly'), error: window.__ors.error() } : { error: window.__ors.error() }; });
  };
  const unmount = async () => { await page.evaluate(() => window.__ors.unmount()); mounted = false; };
  const TS = [0.5, 0.8, 1.6];
  const first = [];
  for (const t of TS) first.push(await markAt('rs-online-mark', t));
  const rows = first.map((m, i) => ({ t: TS[i], got: m, want: expected(TS[i]) }));
  summary.R3 = rows;
  check('R3 探针卡里 interpolate / random 算出来的值，和本进程里用同一套框架按同一个 t 算的逐字相同（三个 t）', rows.every((r) => r.got.t === r.t.toFixed(4) && r.got.x === r.want.x && r.got.r === r.want.r), rows);
  check('R3 三个 t 上位置各不相同', new Set(first.map((m) => m.x)).size === 3, first.map((m) => m.x));
  const again = [];
  for (const t of [...TS].reverse()) again.push(await markAt('rs-online-mark', t));
  again.reverse();
  check('R3 先到靠后的 t 再倒回靠前的：同一个 t 上的值与第一次逐字相同（直接算，与先后无关）', again.every((m, i) => m.t === first[i].t && m.x === first[i].x && m.r === first[i].r), { first: first.map((m) => m.x), again: again.map((m) => m.x) });
  await page.screenshot({ path: path.join(OUT, 'online-mark-t16.png'), clip });
  await unmount();

  console.log('\n== R4 锁只读');
  const ro = await markAt('rs-online-mark', 1);
  await unmount();
  const ctl = await markAt('rs-online-control', 1);
  await unmount();
  check('R4 探针卡（remotion 式、引用框架）里 Object.isFrozen(顶层常量对象) 为真——载入时锁只读那一句在真浏览器里接上了', ro.readonly === 'true', ro);
  check('R4 对照卡（同一张卡声明成 motion 式）为假——不是白给的', ctl.readonly === 'false', ctl);
  const defs = Object.fromEntries(loaded.cards.map((c) => [c.id, c]));
  check('R4 载入出来的卡定义：remotion 式的是冻住的，对照卡不是', defs['rs-online-mark']?.frozen === true && defs['rs-online-mark']?.defaultsFrozen === true && defs['rs-online-control']?.frozen === false, defs);

  console.log('\n== R6 页面没有报错');
  check('R6 页面没有未捕获的错误', pageErrors.length === 0, pageErrors.slice(0, 3));
} catch (e) {
  check('探针没有中途出错', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  await browser?.close().catch(() => {});
  if (child?.pid && child.exitCode === null) {
    // 只结束自己起的这一棵
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    else child.kill('SIGKILL');
  }
  if (!KEEP_TEMP) { try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 留给系统清 */ } }
}
const ok = fails.length === 0;
console.log(JSON.stringify({ ok, pass, fail: fails.length, fails, ...summary }));
process.exit(ok ? 0 : 1);
