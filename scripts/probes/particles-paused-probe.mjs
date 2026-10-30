/**
 * 粒子卡暂停时画面非空、且按时间确定的探针。
 *
 *   node scripts/probes/particles-paused-probe.mjs [--origin http://127.0.0.1:5860] [--out <目录>] [--config <URL>]
 *
 * 不带 `--origin` 就看 `PC_STAGE_TEST_URL`,再没有就打 `.claude/launch.json` 的 `dev-test`。
 *
 * 打开编辑器(`?editor&nosetup=1&preview=stage`),新建工程,放一张粒子卡(默认参数;`--config` 给了就填进 config),
 * 播放头停在 T 秒(不播放),等前台舞台 iframe 里的粒子 canvas 出来,然后:
 *   1. 读 canvas 的 2d 像素,数不透明像素(alpha > 0) —— 修前是 0(全透明),修后要 > 0;
 *   2. 跳到别处再跳回 T,再读一次像素哈希,和第一次比 —— 同一时刻两次画面逐像素相同;
 *   3. 拿另一个时刻 T2 的哈希,和 T 的不同 —— 画面确实随时间走;
 *   4. 留图写进 --out(缺省 out/particles-paused/):canvas 原始像素(*-canvas.png,透明底)与前台舞台 iframe 截图(*-stage.png)。
 *
 * 输出 JSON 结论到 stdout;任何一条不过就以非零退出。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { devOrigin, flagArg } from './probe-connect.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const origin = devOrigin(args);
const OUT = path.resolve(flagArg('out', path.join(ROOT, 'out', 'particles-paused'), args));
const CONFIG = flagArg('config', '', args);
const T = 3, T2 = 5;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); return cond; };

async function until(fn, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) return null;
    await sleep(everyMs);
  }
}

await fs.mkdir(OUT, { recursive: true });
const out = { origin, config: CONFIG || null, T, T2 };
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 180000,
  args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1200 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage();
  }, { timeout: 120000, polling: 500 });
  const store = (src, ...a) => page.evaluate(async (src, a2) => {
    const { actions, getState } = await import('/src/store/project.ts');
    // eslint-disable-next-line no-new-func
    return new Function('actions', 'getState', 'args', src)(actions, getState, a2);
  }, src, a);

  const clipId = await store(`actions.newProject('particles-paused-' + Date.now());
    const c = actions.addCardClip('particles', 0, { duration: 10, params: args[0] ? { config: args[0] } : {} });
    actions.seek(${T});
    return c?.id;`, CONFIG);
  out.clipId = clipId;
  check(!!clipId, '加上了粒子卡');

  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()));
  const frontFrame = async () => {
    const id = await page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A').catch(() => 'A');
    const fs2 = stageFrames();
    return fs2.find((f) => f.url().includes(`id=${id}`)) ?? fs2[0] ?? null;
  };
  /** 前台舞台里粒子 canvas 的像素统计:尺寸、不透明像素数、sha1 */
  const readCanvas = async () => {
    const f = await frontFrame();
    if (!f) return null;
    return f.evaluate(async () => {
      const cs = [...document.querySelectorAll('canvas')].filter((c) => c.parentElement && c.parentElement.classList.contains('inset-0'));
      const c = cs[0];
      if (!c || !c.width) return null;
      const ctx = c.getContext('2d');
      if (!ctx) return { w: c.width, h: c.height, noCtx: true };
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) ink++;
      const buf = await crypto.subtle.digest('SHA-1', d);
      const hash = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return { w: c.width, h: c.height, ink, hash, canvases: cs.length };
    });
  };
  const seekAndRead = async (t) => {
    await store(`actions.seek(${t});`);
    // 等画面稳:连续两次读到同一个哈希
    let prev = null;
    const got = await until(async () => {
      const r = await readCanvas();
      if (r && prev && r.hash === prev.hash && r.w > 0) return r;
      prev = r;
      return null;
    }, 30000, 400);
    return got ?? prev;
  };

  /**
   * 留图:canvas 原始像素存一张 PNG(透明底),再等编辑器的「正在测量卡片」遮罩退掉后截前台舞台 iframe 一张。
   * 遮罩是 K1 成本测量(后台舞台逐帧推这张卡量耗时)期间盖在预览上的,不等它退掉截到的只是遮罩。
   */
  const shoot = async (name) => {
    const f = await frontFrame();
    if (!f) return;
    const url = await f.evaluate(() => document.querySelector('.inset-0 > canvas')?.toDataURL('image/png') ?? null).catch(() => null);
    if (url) await fs.writeFile(path.join(OUT, `${name}-canvas.png`), Buffer.from(url.split(',')[1], 'base64'));
    await until(() => page.evaluate(() => !document.body.innerText.includes('正在测量卡片')), 90000, 500);
    const el = await f.frameElement();
    if (el) await el.screenshot({ path: path.join(OUT, `${name}-stage.png`) });
  };

  const a = await seekAndRead(T);
  out.first = a;
  await shoot(`t${T}-first`);
  check(!!a && a.w > 0, '粒子 canvas 在位', a);
  check(!!a && a.ink > 0, `t=${T}s 暂停时粒子画面非空(不透明像素 > 0)`, a);

  const b = await seekAndRead(T2);
  out.other = b;
  check(!!b && b.ink > 0, `t=${T2}s 暂停时粒子画面非空`, b);
  check(!!a && !!b && a.hash !== b.hash, '不同时刻画面不同', { a: a?.hash, b: b?.hash });

  const a2 = await seekAndRead(T);
  out.again = a2;
  await shoot(`t${T}-again`);
  check(!!a && !!a2 && a.hash === a2.hash, `跳走再跳回 t=${T}s,两次画面逐像素相同`, { a: a?.hash, a2: a2?.hash });
  out.pageErrors = errors.slice(-5);
} finally {
  await browser.close();
}
out.ok = fails.length === 0;
out.fails = fails;
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
