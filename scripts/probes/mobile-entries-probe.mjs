/**
 * 手机版「滤镜入口」与「素材格子 / 缩略卡真画面」的验收探针(分支 claude/mobile-entries;已由主会话收进 scripts/probes/)。
 * 环境同 mobile-business-probe.mjs:本机托管组合 + 仿 nginx 代理 + 在线构建。
 *
 *   npx vite build --mode online
 *   node scripts/probes/mobile-entries-probe.mjs [--dist dist-online] [--out out/mobile-entries] [--base-port 5820] [--doc-port 5826] [--asset-port 5827]
 *
 * 断言:
 *  T1 图片格子显示真画面(颜色对得上导入的图);T2 视频格子显示首帧(首秒蓝、后一秒黄,取到的是蓝);
 *  T3 缩略卡显示真画面,视频段切开后后半段显示它入点那一帧(黄);T4 取不到(素材请求被掐断)时退回取色底色、无破图;
 *  T5 按需:30 个素材打开面板时只取视口附近的,滑到底才取到最后一个;
 *  F1 滤镜库空时卡片库「滤镜」分类、调整面板滤镜一栏的提示口径;F2 调整面板挂滤镜、调参数、撤销;
 *  F3 卡片库「滤镜」分类摘掉 / 挂上 / 删除(确认后一起摘掉)。结果最后一行是一行 JSON。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startMobileEnv, emptyProject, solidPng } from './lib/mobile-env.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'mobile-entries')));
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, steps: {} };
const step = (k, v) => { out.steps[k] = v; };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 20_000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}`); return null; }
    await sleep(every);
  }
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
const rect = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);
const tap = async (page, sel) => { const r = await rect(page, sel); if (!r) throw new Error(`点不到 ${sel}`); await page.touchscreen.tap(r.x + r.w / 2, r.y + r.h / 2); await sleep(350); };
const tapText = async (page, scope, label) => {
  const r = await page.evaluate((s, l) => { const b = [...document.querySelectorAll(`${s} button`)].find((x) => x.textContent.trim() === l); if (!b) return null; b.scrollIntoView({ block: 'nearest' }); const q = b.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; }, scope, label);
  if (!r) throw new Error(`点不到「${label}」`);
  await page.touchscreen.tap(r.x, r.y);
  await sleep(350);
};
const closeSheet = async (page) => {
  const r = await page.evaluate(() => { const bs = [...document.querySelectorAll('.sheet-head button[aria-label="关闭"]')]; const b = bs[bs.length - 1]; if (!b) return null; const q = b.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; });
  if (r) { await page.touchscreen.tap(r.x, r.y); await sleep(450); }
};
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
/** 一张缩略图(data URL)中心像素的颜色 */
const centerRgb = (page, sel) => page.evaluate(async (s) => {
  const img = document.querySelector(s);
  if (!img || !img.getAttribute('src')) return null;
  await img.decode().catch(() => {});
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  return [...x.getImageData(c.width >> 1, c.height >> 1, 1, 1).data.slice(0, 3)];
}, sel);
const near = (rgb, want, tol = 40) => !!rgb && rgb.every((v, i) => Math.abs(v - want[i]) <= tol);
/** 页面里的破图:有 src、加载完了、宽为 0 */
const brokenImgs = (page) => page.$$eval('img', (is) => is.filter((i) => i.getAttribute('src') && i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src').slice(0, 60)));
const openAssets = async (page, tab) => {
  if (!(await page.$('[data-pcm="sheet-assets"]'))) await tap(page, `[data-pcm="sub-${tab === '视频' ? 'video' : 'image'}"]`);
  await page.waitForSelector('[data-pcm="sheet-assets"]', { visible: true });
  await tapText(page, '[data-pcm="sheet-assets"] .seg', tab);
};
const clipOf = (page, id) => store(page, 'return S.getState().project.tracks.flatMap((t) => t.clips).find((x) => x.id === args[0]) ?? null;', id);

const NAME = `me-${Date.now().toString(36)}`;
const env = await startMobileEnv({
  dist: DIST, basePort: Number(arg('--base-port', 5820)), base2Port: 0,
  docPort: Number(arg('--doc-port', 5826)), assetPort: Number(arg('--asset-port', 5827)), name: NAME,
});
await env.seed({ ...emptyProject(NAME), name: NAME });
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--autoplay-policy=no-user-gesture-required'] });
let A;
try {
  A = await env.newPage(browser, 'phone');
  await env.enter(A, { username: 'yi' });
  await A.waitForSelector('[data-pcm="editor"]', { visible: true });

  /* ---------------- 素材:两张图 + 一段视频(首秒蓝、后一秒黄) ---------------- */
  const red = await solidPng(path.join(OUT, 'red.png'), [210, 40, 40]);
  const green = await solidPng(path.join(OUT, 'green.png'), [40, 190, 70]);
  const mp4 = path.join(OUT, 'blue-yellow.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2040d0:s=320x180:d=1:r=30', '-f', 'lavfi', '-i', 'color=c=0xe0d020:s=320x180:d=1:r=30',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { windowsHide: true });

  await openAssets(A, '图片');
  await (await A.waitForSelector('[data-pcm="import-input"]')).uploadFile(red, green);
  await until('两张图进素材库', async () => (await A.$$('[data-pcm="asset"]')).length >= 2 ? true : null, 60_000);
  const imgMedia = await store(A, 'return S.getState().project.media.filter((m) => m.kind === "image").map((m) => ({ id: m.id, name: m.name, hash: m.hash }));');
  const redM = imgMedia.find((m) => /red/.test(m.name)), greenM = imgMedia.find((m) => /green/.test(m.name));
  const readyImgs = await until('图片格子出真画面', async () => (await A.$$('[data-pcm="sheet-assets"] .pic[data-thumb="ready"]')).length >= 2 ? true : null, 60_000);
  const rgbRed = await centerRgb(A, `[data-pcm="asset"][data-media="${redM.id}"] img.thumb-img`);
  const rgbGreen = await centerRgb(A, `[data-pcm="asset"][data-media="${greenM.id}"] img.thumb-img`);
  await shot(A, 'T1-assets-images');
  const tileSrc = await A.$eval('[data-pcm="sheet-assets"] img.thumb-img[src]', (i) => i.getAttribute('src').slice(0, 15)).catch(() => '');
  step('T1', { readyImgs, rgbRed, rgbGreen, tileSrc });
  check(near(rgbRed, [210, 40, 40]) && near(rgbGreen, [40, 190, 70]), 'T1 图片格子的真画面颜色对得上', { rgbRed, rgbGreen });
  check(tileSrc.startsWith('data:image/jpeg'), 'T1 格子上挂的是缩小后的 JPEG,不是原图地址', tileSrc);

  await openAssets(A, '视频');
  await (await A.waitForSelector('[data-pcm="import-input"]')).uploadFile(mp4);
  await until('视频进素材库', async () => (await A.$$('[data-pcm="asset"]')).length >= 1 ? true : null, 90_000);
  const vid = await until('视频素材有时长', () => store(A, 'const m = S.getState().project.media.find((x) => x.kind === "video"); return m && m.duration ? { id: m.id, duration: m.duration, hash: m.hash, small: m.tiers?.small ?? null } : null;'), 90_000);
  await until('视频格子出首帧', async () => (await A.$$('[data-pcm="sheet-assets"] .pic[data-thumb="ready"]')).length >= 1 ? true : null, 90_000);
  const rgbVid = await centerRgb(A, `[data-pcm="asset"][data-media="${vid?.id}"] img.thumb-img`);
  await shot(A, 'T2-assets-video');
  step('T2', { vid, rgbVid });
  check(near(rgbVid, [32, 64, 208], 50), 'T2 视频格子显示首帧(蓝)', rgbVid);

  /* ---------------- 缩略卡:放进主要内容 ---------------- */
  step('beforeVideoTap', await store(A, 'return S.getState().project.tracks.flatMap((t) => t.clips).map((c) => c.mediaId);'));
  await tap(A, `[data-pcm="asset"][data-media="${vid.id}"]`);
  step('afterVideoTap', await store(A, 'return S.getState().project.tracks.flatMap((t) => t.clips).map((c) => c.mediaId);'));
  for (const m of [redM, greenM]) { await openAssets(A, '图片'); await tap(A, `[data-pcm="asset"][data-media="${m.id}"]`); }
  if (await A.$('[data-pcm="sheet-assets"]')) await closeSheet(A);
  if (await A.$('[data-pcm="tl-done"]')) await tap(A, '[data-pcm="tl-done"]');
  const main = await until('主要内容三段', async () => { const ids = await A.$$eval('[data-pcm="mblock"]', (bs) => bs.map((b) => b.dataset.id)); return ids.length >= 3 ? ids : null; });
  const stripReady = await until('缩略卡出真画面', async () => { const n = await A.$$eval('[data-pcm="mblock"] img.thumb-img[data-ready]', (x) => x.length); return n >= 3 ? n : null; }, 60_000);
  const vClip = await store(A, 'return S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.mediaId === args[0]);', vid.id);
  const rgbBlockVid = await centerRgb(A, `[data-pcm="mblock"][data-id="${vClip.id}"] img.thumb-img`);
  await shot(A, 'T3-strip');
  // 视频段在 1.5 秒处切开:后半段入点 1.5 秒,缩略卡应换成黄
  await store(A, 'S.actions.seek(args[0].start + 1.5); return S.actions.splitClip(args[0].id, args[0].start + 1.5) ? true : false;', vClip);
  const after = await store(A, 'return S.getState().project.tracks.flatMap((t) => t.clips).filter((c) => c.mediaId === args[0]).map((c) => ({ id: c.id, off: c.mediaOffset ?? 0 }));', vid.id);
  const second = after.find((c) => c.off > 1);
  await until('后半段缩略卡出画面', async () => (await A.$(`[data-pcm="mblock"][data-id="${second?.id}"] img.thumb-img[data-ready]`)) ? true : null, 30_000);
  const rgbSecond = await centerRgb(A, `[data-pcm="mblock"][data-id="${second?.id}"] img.thumb-img`);
  await shot(A, 'T3-strip-split');
  step('T3', { main, stripReady, rgbBlockVid, after, rgbSecond });
  check(near(rgbBlockVid, [32, 64, 208], 50), 'T3 视频段缩略卡显示入点帧(蓝)', rgbBlockVid);
  check(near(rgbSecond, [224, 208, 32], 50), 'T3 切开后后半段显示它的入点帧(黄)', rgbSecond);
  await store(A, 'S.actions.undo(); return true;');

  /* ---------------- 滤镜:空库提示 ---------------- */
  const imgClip = await store(A, 'return S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.mediaId === args[0]).id;', redM.id);
  await tap(A, `[data-pcm="mblock"][data-id="${imgClip}"]`);
  await tap(A, '[data-pcm="sub-card"]');
  await tapText(A, '[data-pcm="sheet-cards"] .seg', '滤镜');
  const emptyLong = await A.$eval('[data-pcm="filters-empty"]', (e) => e.textContent).catch(() => null);
  await shot(A, 'F1-cards-filter-empty');
  await closeSheet(A);
  await tap(A, '[data-pcm="pg-timeline"]');
  await A.waitForSelector('[data-pcm="full-timeline"]', { visible: true });
  if (!(await store(A, 'return S.getState().selection[0] === args[0];', imgClip))) await tap(A, `[data-pcm="clip"][data-id="${imgClip}"]`);
  await tap(A, '[data-pcm="sub-adjust"]');
  await A.waitForSelector('[data-pcm="clip-filter"]', { visible: true });
  const emptyShort = await A.$eval('[data-pcm="clip-filter-empty"]', (e) => e.textContent).catch(() => null);
  await shot(A, 'F1-params-filter-empty');
  step('F1', { emptyLong, emptyShort });
  check(emptyLong === '还没有滤镜。让 Agent 建一个（比如「给夜景那几段做个冷色调」），它会出现在这里，之后能挂到任意视频 / 图片片段上复用。', 'F1 卡片库滤镜分类空库提示', emptyLong);
  check(emptyShort === '滤镜库是空的：让 Agent 建一个，会出现在卡片库的「滤镜」分类', 'F1 调整面板滤镜一栏空库提示', emptyShort);

  /* ---------------- 滤镜:Agent 建一个(经 store,同 create_filter 入库),调整面板挂上、调参数、撤销 ---------------- */
  await store(A, 'S.actions.addFilter({ id: "flt-probe", name: "探针冷调", description: "探针", params: { s: { default: 0.4, min: 0, max: 2, label: "饱和" } }, ops: [{ kind: "saturate", value: "s" }, { kind: "hue", value: 180 }], createdBy: "agent", createdAt: Date.now() }); return true;');
  await A.waitForFunction(() => !!document.querySelector('[data-pcm="clip-filter-select"] option[value="flt-probe"]'), { timeout: 10_000 });
  await A.select('[data-pcm="clip-filter-select"]', 'flt-probe');
  const attached = await until('挂上滤镜', async () => { const c = await clipOf(A, imgClip); return c?.filter?.id === 'flt-probe' ? c.filter : null; }, 5000);
  await A.waitForSelector('[data-pcm="clip-filter-param-s"] input.num', { visible: true });
  const num = await A.$('[data-pcm="clip-filter-param-s"] input.num');
  await num.evaluate((e) => { e.focus(); e.select(); });
  await num.type('1.5');
  await A.keyboard.press('Enter');
  const tuned = await until('调参数', async () => { const c = await clipOf(A, imgClip); return c?.filter?.params?.s === 1.5 ? c.filter : null; }, 5000);
  await shot(A, 'F2-params-filter');
  await store(A, 'S.actions.undo(); return true;');
  const undone = (await clipOf(A, imgClip))?.filter ?? null;
  step('F2', { attached, tuned, undone });
  check(!!attached && !!tuned, 'F2 调整面板挂上滤镜、改参数进项目', { attached, tuned });
  check(undone?.id === 'flt-probe' && undone?.params?.s !== 1.5, 'F2 撤销一步只撤回参数', undone);
  await closeSheet(A);
  await tap(A, '[data-pcm="tl-done"]');

  /* ---------------- 滤镜:卡片库「滤镜」分类摘掉 / 挂上 / 删除 ---------------- */
  if (!(await store(A, 'return S.getState().selection[0] === args[0];', imgClip))) await tap(A, `[data-pcm="mblock"][data-id="${imgClip}"]`);
  await tap(A, '[data-pcm="sub-card"]');
  await tapText(A, '[data-pcm="sheet-cards"] .seg', '滤镜');
  await A.waitForSelector('[data-pcm="filter"][data-filter="flt-probe"]', { visible: true });
  const onBefore = await A.$eval('[data-pcm="filter"][data-filter="flt-probe"]', (e) => e.dataset.on ?? null);
  await shot(A, 'F3-cards-filter');
  await tap(A, '[data-pcm="filter"][data-filter="flt-probe"] [data-pcm="filter-apply"]');
  const off = (await clipOf(A, imgClip))?.filter ?? null;
  await tap(A, '[data-pcm="filter"][data-filter="flt-probe"] [data-pcm="filter-apply"]');
  const on = (await clipOf(A, imgClip))?.filter ?? null;
  await tap(A, '[data-pcm="filter"][data-filter="flt-probe"] [data-pcm="filter-del"]');
  const askText = await A.$eval('[data-pcm="confirm"] p', (e) => e.textContent).catch(() => null);
  await tap(A, '[data-pcm="confirm-ok"]');
  const gone = await store(A, 'const p = S.getState().project; return { lib: (p.filters ?? []).length, clip: p.tracks.flatMap((t) => t.clips).find((x) => x.id === args[0]).filter ?? null };', imgClip);
  const emptyAgain = await A.$('[data-pcm="filters-empty"]');
  step('F3', { onBefore, off, on, askText, gone });
  check(onBefore === '1', 'F3 选中片段挂着的滤镜标成选中', onBefore);
  check(off === null && on?.id === 'flt-probe', 'F3 点一下摘掉、再点挂上', { off, on });
  check(/用在 1 段上/.test(askText ?? ''), 'F3 删除还挂着的滤镜先确认并说明用在几段', askText);
  check(gone.lib === 0 && gone.clip === null && !!emptyAgain, 'F3 删除后库空、片段上的一起摘掉', gone);
  await closeSheet(A);

  /* ---------------- T5 按需:再导入 28 张小图,刷新后打开面板 ---------------- */
  const many = [];
  for (let i = 0; i < 28; i++) many.push(await solidPng(path.join(OUT, `many-${String(i).padStart(2, '0')}.png`), [(i * 37) % 255, (i * 71) % 255, (i * 13 + 90) % 255], 96, 54));
  await openAssets(A, '图片');
  await (await A.waitForSelector('[data-pcm="import-input"]')).uploadFile(...many);
  await until('30 张图进素材库', async () => (await A.$$('[data-pcm="asset"]')).length >= 30 ? true : null, 120_000, 500);
  await until('上传完', () => store(A, 'return S.getState().project.media.every((m) => !m.pending);'), 120_000, 500);
  const hashes = await store(A, 'return S.getState().project.media.filter((m) => m.kind === "image").map((m) => m.hash);');
  // 刷新前确认 30 张都已传到素材服务:逐格滚到视口里,等它出画面(没传完时素材服务答 404,格子按退避重试)
  const uploaded = await until('30 张都传到素材服务', async () => {
    const left = await A.evaluate(() => { const ps = [...document.querySelectorAll('[data-pcm="sheet-assets"] [data-pcm="asset"]')].filter((t) => !t.querySelector('.pic[data-thumb="ready"]')); ps[0]?.scrollIntoView({ block: 'center' }); return ps.length; });
    return left === 0 ? true : null;
  }, 180_000, 1000);
  step('T5-preupload', { uploaded });
  await closeSheet(A);
  await A.reload({ waitUntil: 'domcontentloaded' });
  await A.waitForSelector('[data-pcm="editor"]', { visible: true, timeout: 90_000 });
  await sleep(1500);
  const asked = new Set();
  const onReq = (r) => { const h = hashes.find((x) => x && r.url().includes(x)); if (h && r.frame() === A.mainFrame()) asked.add(h); };
  A.on('request', onReq);
  await openAssets(A, '图片');
  await sleep(4000);
  const firstPass = await A.evaluate(() => ({ tiles: document.querySelectorAll('[data-pcm="sheet-assets"] [data-pcm="asset"]').length, ready: document.querySelectorAll('[data-pcm="sheet-assets"] .pic[data-thumb="ready"]').length }));
  const askedFirst = asked.size;
  await shot(A, 'T5-lazy-top');
  await A.evaluate(() => { const t = [...document.querySelectorAll('[data-pcm="sheet-assets"] [data-pcm="asset"]')].pop(); t.scrollIntoView({ block: 'end' }); });
  const lastReady = await until('滑到底后最后一格出画面', () => A.evaluate(() => [...document.querySelectorAll('[data-pcm="sheet-assets"] [data-pcm="asset"]')].pop().querySelector('.pic[data-thumb="ready"]') ? true : null), 30_000);
  await shot(A, 'T5-lazy-bottom');
  A.off('request', onReq);
  step('T5', { firstPass, askedFirst, askedAfterScroll: asked.size, lastReady });
  check(firstPass.tiles >= 30 && firstPass.ready > 0 && firstPass.ready < firstPass.tiles, 'T5 打开面板只取了视口附近的格子', firstPass);
  check(askedFirst < firstPass.tiles, 'T5 打开面板时没有一次把全部素材都请求一遍', { askedFirst, tiles: firstPass.tiles });
  check(!!lastReady, 'T5 滑到底后才取到最后一格');
  await closeSheet(A);

  /* ---------------- T4 取不到:掐断红图的素材请求,刷新后它退回取色底色 ---------------- */
  const fetchCdp = await A.createCDPSession();
  await fetchCdp.send('Fetch.enable', { patterns: [{ urlPattern: `*${redM.hash}*` }] });
  let killed = 0;
  fetchCdp.on('Fetch.requestPaused', (e) => { killed++; fetchCdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'ConnectionRefused' }).catch(() => {}); });
  await A.reload({ waitUntil: 'domcontentloaded' });
  await A.waitForSelector('[data-pcm="editor"]', { visible: true, timeout: 90_000 });
  await sleep(1500);
  await openAssets(A, '图片');
  await A.evaluate((id) => document.querySelector(`[data-pcm="asset"][data-media="${id}"]`)?.scrollIntoView({ block: 'center' }), redM.id);
  await until('绿图照常出画面', async () => (await A.$(`[data-pcm="asset"][data-media="${greenM.id}"] .pic[data-thumb="ready"]`)) ? true : null, 30_000);
  await sleep(3000);
  const redTile = await A.$eval(`[data-pcm="asset"][data-media="${redM.id}"] .pic`, (p) => ({ ready: p.dataset.thumb ?? null, bg: p.style.background.slice(0, 40), icon: getComputedStyle(p.querySelector('svg')).display, img: p.querySelector('img.thumb-img')?.getAttribute('src') ?? null }));
  const broken = await brokenImgs(A);
  await shot(A, 'T4-fallback');
  await fetchCdp.send('Fetch.disable').catch(() => {});
  step('T4', { killed, redTile, broken });
  check(killed > 0, 'T4 确实掐断了红图的请求', killed);
  check(redTile.ready === null && /linear-gradient/.test(redTile.bg) && redTile.icon !== 'none' && redTile.img === null, 'T4 取不到时是取色底色加类型图标,不挂图', redTile);
  check(broken.length === 0, 'T4 页面上没有破图', broken);

  step('errors', { pageErrors: A.errors, consoleErrors: A.consoleErrors.slice(0, 20), bad: A.badResponses.slice(0, 20) });
  check(A.errors.length === 0, '页面没有未捕获异常', A.errors);
} catch (e) {
  fails.push(`探针异常:${e?.stack ?? e}`);
  if (A) await shot(A, 'crash');
} finally {
  await browser.close().catch(() => {});
  await env.close().catch(() => {});
}
out.ok = fails.length === 0;
out.fails = fails;
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2));
console.log(JSON.stringify({ ok: out.ok, fails, out: OUT }));
process.exit(out.ok ? 0 : 1);
