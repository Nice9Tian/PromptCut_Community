/**
 * Acceptance check probe for mobile app "filter entry point" and "media cell / thumbnail card
 * real frame" (branch claude/mobile-entries; incorporated into scripts/probes/ by lead session).
 * Environment same as mobile-business-probe.mjs: local hosted suite + simulated nginx proxy +
 * online build.
 *
 *   npx vite build --mode online
 *   node scripts/probes/mobile-entries-probe.mjs [--dist dist-online] [--out out/mobile-entries] [--base-port 5820] [--doc-port 5826] [--asset-port 5827]
 *
 * Assertions:
 *  T1 Image cell displays real frame (colors match imported image); T2 Video cell displays
 *  first frame (first second blue, next second yellow; retrieved is blue);
 *  T3 Thumbnail card displays real frame, after splitting video clip second half displays its
 *  in-point frame (yellow); T4 When unavailable (asset request aborted), falls back to sampled
 *  background color, no broken images;
 *  T5 On demand: opening panel with 30 assets fetches only near viewport, fetching last only
 *  when scrolled to bottom;
 *  F1 Notice phrasing for card library "Filter" category and adjustments panel filter section
 *  when filter library is empty; F2 Attach filter, adjust parameters, undo in adjustments panel;
 *  F3 Detach / attach / delete in card library "Filter" category (detached together after
 *  confirmation). Last line of result is a line of JSON.
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startMobileEnv, emptyProject, solidPng, gateClear } from './lib/mobile-env.mjs';

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
    if (Date.now() - t0 > ms) { fails.push(`Timed out waiting for: ${what}`); return null; }
    await sleep(every);
  }
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
const rect = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);
const tap = async (page, sel) => { await gateClear(page); const r = await rect(page, sel); if (!r) throw new Error(`Cannot click ${sel}`); await page.touchscreen.tap(r.x + r.w / 2, r.y + r.h / 2); await sleep(350); };
const tapText = async (page, scope, label) => {
  const r = await page.evaluate((s, l) => { const b = [...document.querySelectorAll(`${s} button`)].find((x) => x.textContent.trim() === l); if (!b) return null; b.scrollIntoView({ block: 'nearest' }); const q = b.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; }, scope, label);
  if (!r) throw new Error(`Cannot tap "${label}"`);
  await page.touchscreen.tap(r.x, r.y);
  await sleep(350);
};
const closeSheet = async (page) => {
  const r = await page.evaluate(() => { const bs = [...document.querySelectorAll('.sheet-head button[aria-label="Close"]')]; const b = bs[bs.length - 1]; if (!b) return null; const q = b.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2 }; });
  if (r) { await page.touchscreen.tap(r.x, r.y); await sleep(450); }
};
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
/** Color of center pixel of a thumbnail (data URL) */
const centerRgb = (page, sel) => page.evaluate(async (s) => {
  const img = document.querySelector(s);
  if (!img || !img.getAttribute('src')) return null;
  await img.decode().catch(() => {});
  const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight;
  const x = c.getContext('2d'); x.drawImage(img, 0, 0);
  return [...x.getImageData(c.width >> 1, c.height >> 1, 1, 1).data.slice(0, 3)];
}, sel);
const near = (rgb, want, tol = 40) => !!rgb && rgb.every((v, i) => Math.abs(v - want[i]) <= tol);
/** Broken image in page: has src, finished loading, width is 0 */
const brokenImgs = (page) => page.$$eval('img', (is) => is.filter((i) => i.getAttribute('src') && i.complete && i.naturalWidth === 0).map((i) => i.getAttribute('src').slice(0, 60)));
const openAssets = async (page, tab) => {
  if (!(await page.$('[data-pcm="sheet-assets"]'))) await tap(page, `[data-pcm="sub-${tab === 'Video' ? 'video' : 'image'}"]`);
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

  /* ---------------- Media: two images + one video (first second blue, next second yellow) ---------------- */
  const red = await solidPng(path.join(OUT, 'red.png'), [210, 40, 40]);
  const green = await solidPng(path.join(OUT, 'green.png'), [40, 190, 70]);
  const mp4 = path.join(OUT, 'blue-yellow.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2040d0:s=320x180:d=1:r=30', '-f', 'lavfi', '-i', 'color=c=0xe0d020:s=320x180:d=1:r=30',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1[v]', '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4], { windowsHide: true });

  await openAssets(A, 'Image');
  await (await A.waitForSelector('[data-pcm="import-input"]')).uploadFile(red, green);
  await until('two images in the media library', async () => (await A.$$('[data-pcm="asset"]')).length >= 2 ? true : null, 60_000);
  const imgMedia = await store(A, 'return S.getState().project.media.filter((m) => m.kind === "image").map((m) => ({ id: m.id, name: m.name, hash: m.hash }));');
  const redM = imgMedia.find((m) => /red/.test(m.name)), greenM = imgMedia.find((m) => /green/.test(m.name));
  const readyImgs = await until('image tiles show the real picture', async () => (await A.$$('[data-pcm="sheet-assets"] .pic[data-thumb="ready"]')).length >= 2 ? true : null, 60_000);
  const rgbRed = await centerRgb(A, `[data-pcm="asset"][data-media="${redM.id}"] img.thumb-img`);
  const rgbGreen = await centerRgb(A, `[data-pcm="asset"][data-media="${greenM.id}"] img.thumb-img`);
  await shot(A, 'T1-assets-images');
  const tileSrc = await A.$eval('[data-pcm="sheet-assets"] img.thumb-img[src]', (i) => i.getAttribute('src').slice(0, 15)).catch(() => '');
  step('T1', { readyImgs, rgbRed, rgbGreen, tileSrc });
  check(near(rgbRed, [210, 40, 40]) && near(rgbGreen, [40, 190, 70]), 'T1 the real picture colors in the image tiles match', { rgbRed, rgbGreen });
  check(tileSrc.startsWith('data:image/jpeg'), 'T1 the tile carries a downscaled JPEG, not the original image URL', tileSrc);

  await openAssets(A, 'Video');
  await (await A.waitForSelector('[data-pcm="import-input"]')).uploadFile(mp4);
  await until('video in the media library', async () => (await A.$$('[data-pcm="asset"]')).length >= 1 ? true : null, 90_000);
  const vid = await until('video media has a duration', () => store(A, 'const m = S.getState().project.media.find((x) => x.kind === "video"); return m && m.duration ? { id: m.id, duration: m.duration, hash: m.hash, small: m.tiers?.small ?? null } : null;'), 90_000);
  await until('video tile shows the first frame', async () => (await A.$$('[data-pcm="sheet-assets"] .pic[data-thumb="ready"]')).length >= 1 ? true : null, 90_000);
  const rgbVid = await centerRgb(A, `[data-pcm="asset"][data-media="${vid?.id}"] img.thumb-img`);
  await shot(A, 'T2-assets-video');
  step('T2', { vid, rgbVid });
  check(near(rgbVid, [32, 64, 208], 50), 'T2 the video tile shows the first frame (blue)', rgbVid);

  /* ---------------- Thumbnail card: place into main content ---------------- */
  step('beforeVideoTap', await store(A, 'return S.getState().project.tracks.flatMap((t) => t.clips).map((c) => c.mediaId);'));
  await tap(A, `[data-pcm="asset"][data-media="${vid.id}"]`);
  step('afterVideoTap', await store(A, 'return S.getState().project.tracks.flatMap((t) => t.clips).map((c) => c.mediaId);'));
  for (const m of [redM, greenM]) { await openAssets(A, 'Image'); await tap(A, `[data-pcm="asset"][data-media="${m.id}"]`); }
  if (await A.$('[data-pcm="sheet-assets"]')) await closeSheet(A);
  if (await A.$('[data-pcm="tl-done"]')) await tap(A, '[data-pcm="tl-done"]');
  const main = await until('three clips in main content', async () => { const ids = await A.$$eval('[data-pcm="mblock"]', (bs) => bs.map((b) => b.dataset.id)); return ids.length >= 3 ? ids : null; });
  const stripReady = await until('thumbnail cards show the real picture', async () => { const n = await A.$$eval('[data-pcm="mblock"] img.thumb-img[data-ready]', (x) => x.length); return n >= 3 ? n : null; }, 60_000);
  const vClip = await store(A, 'return S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.mediaId === args[0]);', vid.id);
  const rgbBlockVid = await centerRgb(A, `[data-pcm="mblock"][data-id="${vClip.id}"] img.thumb-img`);
  await shot(A, 'T3-strip');
  // Video clip split at 1.5 s: second half in point is 1.5 s, thumbnail card should switch to yellow
  await store(A, 'S.actions.seek(args[0].start + 1.5); return S.actions.splitClip(args[0].id, args[0].start + 1.5) ? true : false;', vClip);
  const after = await store(A, 'return S.getState().project.tracks.flatMap((t) => t.clips).filter((c) => c.mediaId === args[0]).map((c) => ({ id: c.id, off: c.mediaOffset ?? 0 }));', vid.id);
  const second = after.find((c) => c.off > 1);
  await until('the second-half thumbnail card shows a picture', async () => (await A.$(`[data-pcm="mblock"][data-id="${second?.id}"] img.thumb-img[data-ready]`)) ? true : null, 30_000);
  const rgbSecond = await centerRgb(A, `[data-pcm="mblock"][data-id="${second?.id}"] img.thumb-img`);
  await shot(A, 'T3-strip-split');
  step('T3', { main, stripReady, rgbBlockVid, after, rgbSecond });
  check(near(rgbBlockVid, [32, 64, 208], 50), 'T3 the video clip\'s thumbnail card shows the in-point frame (blue)', rgbBlockVid);
  check(near(rgbSecond, [224, 208, 32], 50), 'T3 after the split, the second half shows its own in-point frame (yellow)', rgbSecond);
  await store(A, 'S.actions.undo(); return true;');

  /* ---------------- Filter: empty library notice ---------------- */
  const imgClip = await store(A, 'return S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.mediaId === args[0]).id;', redM.id);
  await tap(A, `[data-pcm="mblock"][data-id="${imgClip}"]`);
  await tap(A, '[data-pcm="sub-card"]');
  await tapText(A, '[data-pcm="sheet-cards"] .seg', 'Filter');
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
  check(emptyLong === 'No filters yet. Ask the Agent to create one (for example "give those night-scene clips a cool tone"). It will appear here and can then be attached to any video / image clip for reuse.', 'F1 empty-library hint for the filter category in the card library', emptyLong);
  check(emptyShort === 'The filter library is empty: ask the Agent to create one and it will appear in the "Filter" category of the card library', 'F1 empty-library hint for the filter row in the adjust panel', emptyShort);

  /* ---------------- Filter: Agent creates one (via store, stored as create_filter), attach in adjustments panel, adjust parameters, undo ---------------- */
  await store(A, 'S.actions.addFilter({ id: "flt-probe", name: "Probe cool tone", description: "probe", params: { s: { default: 0.4, min: 0, max: 2, label: "Saturation" } }, ops: [{ kind: "saturate", value: "s" }, { kind: "hue", value: 180 }], createdBy: "agent", createdAt: Date.now() }); return true;');
  await A.waitForFunction(() => !!document.querySelector('[data-pcm="clip-filter-select"] option[value="flt-probe"]'), { timeout: 10_000 });
  await A.select('[data-pcm="clip-filter-select"]', 'flt-probe');
  const attached = await until('filter attached', async () => { const c = await clipOf(A, imgClip); return c?.filter?.id === 'flt-probe' ? c.filter : null; }, 5000);
  await A.waitForSelector('[data-pcm="clip-filter-param-s"] input.num', { visible: true });
  const num = await A.$('[data-pcm="clip-filter-param-s"] input.num');
  await num.evaluate((e) => { e.focus(); e.select(); });
  await num.type('1.5');
  await A.keyboard.press('Enter');
  const tuned = await until('parameter tuned', async () => { const c = await clipOf(A, imgClip); return c?.filter?.params?.s === 1.5 ? c.filter : null; }, 5000);
  await shot(A, 'F2-params-filter');
  await store(A, 'S.actions.undo(); return true;');
  const undone = (await clipOf(A, imgClip))?.filter ?? null;
  step('F2', { attached, tuned, undone });
  check(!!attached && !!tuned, 'F2 attaching a filter and changing a parameter in the adjust panel are saved into the project', { attached, tuned });
  check(undone?.id === 'flt-probe' && undone?.params?.s !== 1.5, 'F2 one undo step reverts only the parameter', undone);
  await closeSheet(A);
  await tap(A, '[data-pcm="tl-done"]');

  /* ---------------- Filter: detach / attach / delete in card library "Filter" category ---------------- */
  if (!(await store(A, 'return S.getState().selection[0] === args[0];', imgClip))) await tap(A, `[data-pcm="mblock"][data-id="${imgClip}"]`);
  await tap(A, '[data-pcm="sub-card"]');
  await tapText(A, '[data-pcm="sheet-cards"] .seg', 'Filter');
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
  check(onBefore === '1', 'F3 the filter attached to the selected clip is marked as selected', onBefore);
  check(off === null && on?.id === 'flt-probe', 'F3 one tap removes it, another tap attaches it again', { off, on });
  check(/used on 1 clip/.test(askText ?? ''), 'F3 deleting a filter that is still attached asks for confirmation first and says how many clips it is used on', askText);
  check(gone.lib === 0 && gone.clip === null && !!emptyAgain, 'F3 after deleting, the library is empty and the filter on the clip is removed too', gone);
  await closeSheet(A);

  /* ---------------- T5 on demand: import 28 more small images, open panel after refresh ---------------- */
  const many = [];
  for (let i = 0; i < 28; i++) many.push(await solidPng(path.join(OUT, `many-${String(i).padStart(2, '0')}.png`), [(i * 37) % 255, (i * 71) % 255, (i * 13 + 90) % 255], 96, 54));
  await openAssets(A, 'Image');
  await (await A.waitForSelector('[data-pcm="import-input"]')).uploadFile(...many);
  await until('30 images in the media library', async () => (await A.$$('[data-pcm="asset"]')).length >= 30 ? true : null, 120_000, 500);
  await until('uploads finished', () => store(A, 'return S.getState().project.media.every((m) => !m.pending);'), 120_000, 500);
  const hashes = await store(A, 'return S.getState().project.media.filter((m) => m.kind === "image").map((m) => m.hash);');
  // Confirm all 30 uploaded to asset service before refresh: scroll cell by cell into viewport,
  // wait for frame (when not finished asset service returns 404, cell retries with backoff)
  const uploaded = await until('all 30 uploaded to the asset service', async () => {
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
  await openAssets(A, 'Image');
  await sleep(4000);
  const firstPass = await A.evaluate(() => ({ tiles: document.querySelectorAll('[data-pcm="sheet-assets"] [data-pcm="asset"]').length, ready: document.querySelectorAll('[data-pcm="sheet-assets"] .pic[data-thumb="ready"]').length }));
  const askedFirst = asked.size;
  await shot(A, 'T5-lazy-top');
  await A.evaluate(() => { const t = [...document.querySelectorAll('[data-pcm="sheet-assets"] [data-pcm="asset"]')].pop(); t.scrollIntoView({ block: 'end' }); });
  const lastReady = await until('last tile shows a picture after scrolling to the bottom', () => A.evaluate(() => [...document.querySelectorAll('[data-pcm="sheet-assets"] [data-pcm="asset"]')].pop().querySelector('.pic[data-thumb="ready"]') ? true : null), 30_000);
  await shot(A, 'T5-lazy-bottom');
  A.off('request', onReq);
  step('T5', { firstPass, askedFirst, askedAfterScroll: asked.size, lastReady });
  check(firstPass.tiles >= 30 && firstPass.ready > 0 && firstPass.ready < firstPass.tiles, 'T5 opening the panel fetched only the tiles near the viewport', firstPass);
  check(askedFirst < firstPass.tiles, 'T5 opening the panel did not request all media at once', { askedFirst, tiles: firstPass.tiles });
  check(!!lastReady, 'T5 the last tile is fetched only after scrolling to the bottom');
  await closeSheet(A);

  /* ---------------- T4 unavailable: abort red image asset request, falls back to sampled background color after refresh ---------------- */
  const fetchCdp = await A.createCDPSession();
  await fetchCdp.send('Fetch.enable', { patterns: [{ urlPattern: `*${redM.hash}*` }] });
  let killed = 0;
  fetchCdp.on('Fetch.requestPaused', (e) => { killed++; fetchCdp.send('Fetch.failRequest', { requestId: e.requestId, errorReason: 'ConnectionRefused' }).catch(() => {}); });
  await A.reload({ waitUntil: 'domcontentloaded' });
  await A.waitForSelector('[data-pcm="editor"]', { visible: true, timeout: 90_000 });
  await sleep(1500);
  await openAssets(A, 'Image');
  await A.evaluate((id) => document.querySelector(`[data-pcm="asset"][data-media="${id}"]`)?.scrollIntoView({ block: 'center' }), redM.id);
  await until('green image still shows its picture as usual', async () => (await A.$(`[data-pcm="asset"][data-media="${greenM.id}"] .pic[data-thumb="ready"]`)) ? true : null, 30_000);
  await sleep(3000);
  const redTile = await A.$eval(`[data-pcm="asset"][data-media="${redM.id}"] .pic`, (p) => ({ ready: p.dataset.thumb ?? null, bg: p.style.background.slice(0, 40), icon: getComputedStyle(p.querySelector('svg')).display, img: p.querySelector('img.thumb-img')?.getAttribute('src') ?? null }));
  const broken = await brokenImgs(A);
  await shot(A, 'T4-fallback');
  await fetchCdp.send('Fetch.disable').catch(() => {});
  step('T4', { killed, redTile, broken });
  check(killed > 0, 'T4 the red image\'s request was really cut off', killed);
  check(redTile.ready === null && /linear-gradient/.test(redTile.bg) && redTile.icon !== 'none' && redTile.img === null, 'T4 when it cannot be fetched, the tile shows a sampled-color background plus a type icon and no image', redTile);
  check(broken.length === 0, 'T4 no broken images on the page', broken);

  step('errors', { pageErrors: A.errors, consoleErrors: A.consoleErrors.slice(0, 20), bad: A.badResponses.slice(0, 20) });
  check(A.errors.length === 0, 'no uncaught exceptions on the page', A.errors);
} catch (e) {
  fails.push(`Probe error: ${e?.stack ?? e}`);
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
