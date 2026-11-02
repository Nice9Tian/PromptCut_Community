/**
 * 手机浏览器点输入框自动放大、失焦后不缩回的验收探针(`src/ui/focusZoomReset.ts` 与 `src/index.css` 的触屏输入框字号)。
 * 全程在本机:本机托管组合 + 仿 nginx 的代理(`lib/mobile-env.mjs`),在线构建当页面,不连真正的托管端。
 *
 *   npx vite build --mode online
 *   node scripts/probes/mobile-input-zoom-probe.mjs [--dist dist-online] [--base-port 5850] [--doc-port 5858] [--asset-port 5859]
 *
 * 安卓 Chrome 仿真(375×812、触屏)进手机版开始页:
 *   F 触屏下(`pointer: coarse` 成立)页面上每个文字输入框,以及临时插进手机版界面与页面根上的 input / textarea / select,
 *     计算字号都 ≥ 16px(iOS Safari 对小于 16px 的输入框聚焦放大;安卓 Chrome 按字号算「看得清」的倍数放大);
 *   Z 双指捏合放大页面,点输入框打字、失焦 → 兜底把 viewport 临时换成带 `maximum-scale=1` 的内容、随后恢复原样,
 *     恢复后仍能双指放大;
 *   K 焦点从一个输入框挪到下一个时不动 viewport(不打断连续输入),最后失焦才动;
 *   N 没碰输入框时不动 viewport(用户自己放大的页面不管)。
 * 仿真的局限(2026-10-21 实测无头 Chrome):聚焦小字号输入框不会自动放大,改 viewport 也不会把已有的缩放拉回 1,
 * 所以「真的放大了、真的缩回来了」只能在真机上看;本探针验的是放大的起因已去掉、兜底按时序动了 viewport。
 * 结果最后一行是一行 JSON(`ok`、`fails`、各项数字)。
 */
import puppeteer from 'puppeteer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startMobileEnv } from './lib/mobile-env.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 240_000).unref();

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));

const fails = [];
const out = { ok: false, F: {}, Z: {}, K: {}, N: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scale = (page) => page.evaluate(() => window.visualViewport?.scale ?? null);
const viewportMeta = (page) => page.evaluate(() => document.querySelector('meta[name="viewport"]')?.getAttribute('content') ?? null);
/**
 * CDP 两个触点从中线向两边拉开(zoomIn)或收拢,让页面放大或缩小。`Input.synthesizePinchGesture` 在无头里不生效;
 * 拉开的幅度和最终缩放不成比例(无头 Chrome 实测 100→200 px 就到上限 5 倍),探针只看「放大了没有」(> 1.5)。
 */
async function pinch(page, zoomIn) {
  const cx = 187, y = 420;
  const [d0, d1] = zoomIn ? [100, 200] : [240, 40];
  const pts = (d) => [{ x: cx - d / 2, y, id: 0 }, { x: cx + d / 2, y, id: 1 }];
  await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(d0) });
  for (let i = 1; i <= 20; i++) { await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(d0 + ((d1 - d0) * i) / 20) }); await sleep(16); }
  await page.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(600);
}
const pinchTo = (page) => pinch(page, true);
async function resetZoom(page) {
  for (let i = 0; i < 3 && (await scale(page)) > 1.01; i++) await pinch(page, false);
}

const env = await startMobileEnv({
  dist: DIST, basePort: Number(arg('--base-port', 5850)), docPort: Number(arg('--doc-port', 5858)), assetPort: Number(arg('--asset-port', 5859)),
  name: `input-zoom-${Date.now().toString(36)}`,
});
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 180_000, args: [...PROBE_CHROME_ARGS, '--no-first-run'] });
try {
  const page = await env.newPage(browser, 'phone');
  await page.goto(`${env.origin}/editor`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForSelector('.pcm input.text-in', { visible: true, timeout: 90_000 });
  await sleep(500);
  const base = await viewportMeta(page);
  out.viewport = base;

  /* viewport 的每次改动记下来(兜底只靠改它) */
  await page.evaluate(() => {
    const m = document.querySelector('meta[name="viewport"]');
    window.__metaLog = [];
    new MutationObserver(() => window.__metaLog.push(m.getAttribute('content'))).observe(m, { attributes: true });
  });
  const metaLog = () => page.evaluate(() => window.__metaLog.splice(0));

  /* F:字号 */
  out.F = await page.evaluate(() => {
    const visible = [...document.querySelectorAll('input, textarea, select')]
      .filter((e) => e.offsetParent !== null && !['checkbox', 'radio', 'range', 'button', 'submit', 'file'].includes(e.type))
      .map((e) => ({ name: e.name || e.dataset.pcm || e.type || e.tagName, fontSize: parseFloat(getComputedStyle(e).fontSize) }));
    const host = document.querySelector('.pcm');
    const probe = [];
    for (const [where, parent] of [['pcm', host], ['body', document.body]]) {
      for (const html of ['<input type="text" style="font-size:11px">', '<input type="search">', '<textarea style="font:12px/1 sans-serif"></textarea>', '<select><option>a</option></select>']) {
        const box = document.createElement('div'); box.innerHTML = html; const el = box.firstElementChild; parent.appendChild(el);
        probe.push({ name: `${where}:${el.tagName.toLowerCase()}${el.type ? '[' + el.type + ']' : ''}`, fontSize: parseFloat(getComputedStyle(el).fontSize) });
        el.remove();
      }
    }
    return { coarse: matchMedia('(pointer: coarse)').matches, inputs: visible, probe };
  });
  check(out.F.coarse, 'F (pointer: coarse) should hold under touch emulation', out.F);
  check(out.F.inputs.length > 0, 'F the start page should have text input boxes', out.F);
  for (const i of [...out.F.inputs, ...out.F.probe]) check(i.fontSize >= 16, `F input box ${i.name} font size should be ≥ 16px`, i);

  /* Z:放大 → 点输入框打字 → 失焦 → viewport 临时加 maximum-scale=1 再恢复 */
  await pinchTo(page);
  out.Z.zoomed = await scale(page);
  check(out.Z.zoomed > 1.5, 'Z the page should zoom in after a two-finger pinch', out.Z);
  const first = await page.$('.pcm input.text-in');
  await first.tap();
  // 放大 5 倍时输入框可能在可视区外,点不中就直接给焦点:这里验的是失焦之后,不是点击
  await first.evaluate((el) => { if (document.activeElement !== el) el.focus(); });
  await page.keyboard.type('probe');
  await sleep(300);
  out.Z.whileTyping = await metaLog();
  check(out.Z.whileTyping.length === 0, 'Z the viewport is not touched while typing', out.Z);
  await page.evaluate(() => document.activeElement?.blur());
  await sleep(1200);
  out.Z.afterBlur = await metaLog();
  out.Z.metaAfter = await viewportMeta(page);
  check(out.Z.afterBlur.length === 2 && /maximum-scale=1$/.test(out.Z.afterBlur[0]) && out.Z.afterBlur[1] === base, 'Z after blur, the viewport first gets maximum-scale=1 added, then the original content is restored', { base, log: out.Z.afterBlur });
  check(out.Z.metaAfter === base, 'Z the final viewport is the original content', { base, after: out.Z.metaAfter });
  out.Z.scaleAfterBlur = await scale(page);
  await resetZoom(page);
  await pinchTo(page);
  out.Z.pinchAgain = await scale(page);
  check(out.Z.pinchAgain > 1.5, 'Z pinch zoom still works after restoring', out.Z);
  await resetZoom(page);
  await metaLog();

  /* K:焦点从一个输入框挪到下一个 */
  // 社区版开始页只有一个输入框,补一个:焦点挪动的判断不看是哪个输入框
  await page.evaluate(() => {
    const all = document.querySelectorAll('.pcm input.text-in');
    if (all.length < 2) all[0].after(Object.assign(document.createElement('input'), { className: 'text-in' }));
  });
  const inputs = await page.$$('.pcm input.text-in');
  if (check(inputs.length >= 2, 'K the start page should have two or more input boxes', { n: inputs.length })) {
    await pinchTo(page);
    await inputs[0].evaluate((el) => el.focus());
    await page.evaluate(() => { const all = [...document.querySelectorAll('.pcm input.text-in')]; all[1].focus(); });
    await sleep(800);
    out.K.afterMove = await metaLog();
    check(out.K.afterMove.length === 0, 'K the viewport is not touched when focus moves to the next input box', out.K);
    await page.evaluate(() => document.activeElement?.blur());
    await sleep(1200);
    out.K.afterBlur = await metaLog();
    check(out.K.afterBlur.length === 2, 'K the viewport changes only on the final blur', out.K);
    await resetZoom(page);
    await metaLog();
  }

  /* N:没碰输入框 */
  await pinchTo(page);
  await page.evaluate(() => { document.body.focus(); document.body.blur(); });
  await sleep(1200);
  out.N.log = await metaLog();
  check(out.N.log.length === 0, 'N the viewport is not touched when no input box is touched', out.N);

  check(page.errors.length === 0, 'no uncaught exceptions on the page', page.errors.slice(0, 3));
} catch (e) {
  fails.push(`Exception: ${e?.stack ?? e}`);
} finally {
  await browser.close().catch(() => {});
  await env.close();
}
out.ok = fails.length === 0;
out.fails = fails;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
