/**
 * R3 "stage content" acceptance check probe (E4b / E7 / D3 step 4).
 *
 *   node scripts/probes/stage-content-probe.mjs [--origin http://127.0.0.1:5241] [--same-origin]
 *
 * Without `--origin`, check `PC_STAGE_TEST_URL`; if still missing, hit `dev-test` in
 * `.claude/launch.json`.
 *
 * Same skeleton as `stage-rpc-probe.mjs`: this process temporarily starts an HTTP service serving
 * the "test page", mounting two stage iframes in the page (by default targeting the two stage
 * ports of the editor process; `--same-origin` targets the editor's own origin), driving them
 * only via postMessage RPC. **The iframe address includes `&preview=stage`**: the stage uses it
 * to decide whether to render the live variant of `FrameScene` (asset layer enters stage, six
 * plane props take effect); without it, it takes today's `Stage` path.
 *
 * Verifies these items from task brief E7 / E4b / D3 step 4:
 *
 *   1. **Component instance unchanged**: across three cases: snapshot attached, removed, and same
 *      clip switching to another frame, the card component DOM root is the same element object
 *      (tagged), and none of its internal state (typewriter step count) is lost: without relying
 *      on manual DevTools inspection;
 *   2. **Visibility of four classes**: `.pc-snapshot` / `.pc-suppressed` hide subtrees
 *      (display:none) but pass through three planes; `.pc-awaiting` / `.pc-settling` are
 *      visibility:hidden (subtrees retain layout boxes);
 *   3. **Suppressed cards**: the particle card's `<canvas>` pixel hash does not change during
 *      suppression (the `t` passed to the component is frozen), while the wrapper layer's
 *      `data-pc-local-frame` still changes with `t` (other uses of `cardT` still use real-time
 *      values as usual), and `hitTest` can still hit it (when flush against snapshot plane);
 *   4. **500 ms fallback for `.pc-awaiting`**: must remove itself if snapshot does not arrive,
 *      cannot remain permanently hidden;
 *   5. **Asset layer in stage**: video displays frames, image displays frames, media clips with
 *      pixel maps also display; `rects()` includes media clips; media clips taken over by others
 *      (pixel map / media effect card nodes) are not drawn twice;
 *   6. **Two E4b items**: a typing card with `setInterval` advancing one step every 100 ms reaches
 *      exactly 30 steps when caught up to second 3; a countdown card using `Date.now()` decreases
 *      by exactly 10 seconds after advancing 10 seconds.
 *
 * Media is generated on the fly via ffmpeg (`testsrc`) and stored into `out/media/` by content
 * hash, so `/@media/<hash>` is same-origin with the stage: cross-origin `<video>` uploaded as a
 * WebGL texture taints the canvas, making the pixel map check unverifiable.
 *
 * Outputs JSON conclusion to stdout; exits with non-zero if any item fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { serve, closeAll, devOrigin } from './probe-connect.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const origin = devOrigin(args);
const sameOrigin = args.includes('--same-origin');
const HOST_PATH = '/__stage-content-probe-host';

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); return cond; };

/* ------------------------------------------------------------------ Assets */

/** Stores content into local content store (`out/media/<sha256>.<ext>`), returns hash for `/@media/<hash>` */
function intoMediaStore(file) {
  const bytes = fs.readFileSync(file);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const ext = path.extname(file).slice(1).toLowerCase();
  const dir = path.resolve(ROOT, 'out', 'media');
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `${hash}.${ext}`);
  if (!fs.existsSync(dest)) fs.writeFileSync(dest, bytes);
  return hash;
}

/** ffmpeg generates two small assets (color bar video + image), placed in temp dir then stored into content store */
function makeMedia(tmpDir) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const mp4 = path.join(tmpDir, 'pc-stage-content-probe.mp4');
  const png = path.join(tmpDir, 'pc-stage-content-probe.png');
  if (!fs.existsSync(mp4)) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=4',
      '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-g', '15', mp4], { windowsHide: true, stdio: 'inherit' });
  }
  if (!fs.existsSync(png)) {
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=128x128', '-frames:v', '1', png], { windowsHide: true, stdio: 'inherit' });
  }
  return { video: intoMediaStore(mp4), image: intoMediaStore(png) };
}

/* ------------------------------------------------------------------ Test page */

async function stageOrigins() {
  if (sameOrigin) return [origin, origin];
  const r = await fetch(origin + '/api/stage/ports');
  const j = await r.json();
  if (!j.ok || !Array.isArray(j.ports) || j.ports.length < 2) throw new Error(`Stage ports did not come up: ${JSON.stringify(j)}`);
  const u = new URL(origin);
  return j.ports.slice(0, 2).map((p) => `${u.protocol}//${u.hostname}:${p}`);
}

const hostHtml = (oa, ob) => `<!doctype html><html><head><meta charset="utf-8"><title>stage content probe host</title></head>
<body style="margin:0;background:#222">
<iframe id="a" src="${oa}/?stage=1&id=A&preview=stage&prerender=1" style="width:1920px;height:1080px;border:0;display:block"></iframe>
<iframe id="b" src="${ob}/?stage=1&id=B&preview=stage&prerender=1" style="width:1920px;height:1080px;border:0;display:block;opacity:0;pointer-events:none"></iframe>
<script type="module">
function createStageRpc(target, targetOrigin) {
  let nextId = 1; const pending = new Map(); const listeners = new Set();
  window.addEventListener('message', (e) => {
    if (e.source !== target) return; const d = e.data;
    if (d && d.type === 'pc-rpc-reply') { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.ok ? p.resolve(d.result) : p.reject(new Error(d.error)); return; }
    if (d && typeof d.type === 'string' && ['mediaReady', 'frame', 'ended', 'settled', 'probe', 'demote', 'probe-frame'].includes(d.type)) for (const l of listeners) l(d);
  });
  const call = (method) => (...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); target.postMessage({ type: 'pc-rpc', id, method, args }, targetOrigin); });
  const c = { onEvent: (l) => { listeners.add(l); return () => listeners.delete(l); } };
  for (const m of ['setProject', 'setTime', 'render', 'hitTest', 'rectsWithBounds', 'size', 'setProxy', 'setRole', 'setPlan', 'play', 'pause', 'setSuppressed', 'setStreamPlanes', 'setScrubbing', 'setPlaying', 'setMediaT', 'setLocalHashes', 'setSnapshots']) c[m] = call(m);
  return c;
}
window.__events = []; window.__eventsB = [];
const waitReady = (frame, targetOrigin, bag) => new Promise((res) => {
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    const rpc = createStageRpc(frame.contentWindow, targetOrigin);
    rpc.onEvent((ev) => bag.push(ev.type === 'probe-frame' ? { ...ev, html: ev.html.length } : ev));
    res({ caps: e.data.hostCapabilities, rpc });
  });
});
window.__ready = Promise.all([
  waitReady(document.getElementById('a'), '${oa}', window.__events),
  waitReady(document.getElementById('b'), '${ob}', window.__eventsB),
]).then(([a, b]) => { window.__rpc = a.rpc; window.__rpcB = b.rpc; return true; });
</script></body></html>`;

/* ------------------------------------------------------------------ Run */

const media = makeMedia(path.join(process.env.TEMP || process.env.TMP || ROOT, 'pc-probe-media'));
const [originA, originB] = await stageOrigins();
const hostServer = await serve(0, (req, res) => {
  if (new URL(req.url, 'http://x').pathname !== HOST_PATH) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(hostHtml(originA, originB));
}, '127.0.0.1');
const hostUrl = `http://127.0.0.1:${hostServer.address().port}${HOST_PATH}`;
const browser = await puppeteer.launch({
  headless: true, protocolTimeout: 300000,
  args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--autoplay-policy=no-user-gesture-required'],
});
const out = { mode: sameOrigin ? 'same-origin' : 'cross-origin', originA, originB, host: hostUrl, media };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(hostUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.evaluate(() => Promise.race([window.__ready, new Promise((_, rej) => setTimeout(() => rej(new Error('stage ready timeout')), 120000))]));

  const frameOf = (id) => page.frames().find((f) => f.url().includes(`id=${id}`));
  const fa = frameOf('A');
  const fb = frameOf('B');
  check(!!fa && !!fb, 'both stage iframes are attached', { a: fa?.url(), b: fb?.url() });
  check(!!fa && fa.url().includes('preview=stage'), 'stage iframe carries ?preview=stage (live FrameScene)', fa?.url());

  /* ── Project factory (same shape as createEmptyProject in kernel/project.ts) ─── */
  await page.evaluate((m) => {
    window.__media = m;
    window.__mk = (tracks, extra = {}) => ({
      version: 1, id: 'probe', name: 'probe', width: 1920, height: 1080, fps: 30, duration: 20, themeId: 'midnight',
      media: [
        { id: 'mv', kind: 'video', name: 'probe.mp4', url: `/@media/${m.video}`, hash: m.video, duration: 4 },
        { id: 'mi', kind: 'image', name: 'probe.png', url: `/@media/${m.image}`, hash: m.image },
      ],
      tracks, ...extra,
    });
  }, media);

  /* ================================================================
   * A. Asset layer in the stage (E7 item 1 / D3 step 4)
   * ================================================================ */
  const mediaProject = await page.evaluate(() => window.__mk([
    // Topmost one: regular video clip
    { id: 'tr-v', clips: [{ id: 'c-video', mediaId: 'mv', start: 0, end: 4, params: {}, frame: { x: 0, y: 0, w: 960, h: 540, anchor: [0, 0] } }] },
    // Image clip
    { id: 'tr-i', clips: [{ id: 'c-image', mediaId: 'mi', start: 0, end: 4, params: {}, frame: { x: 960, y: 0, w: 960, h: 540, anchor: [0, 0] } }] },
    // Video clip with pixel map
    { id: 'tr-p', clips: [{ id: 'c-pixel', mediaId: 'mv', start: 0, end: 4, params: {}, pixelMap: { id: 'pm1' }, frame: { x: 0, y: 540, w: 960, h: 540, anchor: [0, 0] } }] },
  ], {
    pixelMaps: [{
      id: 'pm1', name: 'Invert colors', source: { stage: 'origin' }, where: '1',
      to: { kind: 'expr', r: '1 - r', g: '1 - g', b: '1 - b', a: 'a' }, mode: 'continuous',
    }],
  }));
  await page.evaluate(async (p) => {
    await window.__rpc.setProject(p, { reset: true });
    await window.__rpc.setMediaT(1.5);
    await window.__rpc.setTime(1.5);
  }, mediaProject);
  // Decoding + displaying frames takes several real frames: the asset layer follows wall clock, not virtual clock
  await new Promise((r) => setTimeout(r, 2500));
  await page.evaluate(async () => { await window.__rpc.setMediaT(1.5); await window.__rpc.setTime(1.5); });
  await new Promise((r) => setTimeout(r, 1500));

  out.mediaLayer = await fa.evaluate(() => {
    const shown = [...document.querySelectorAll('[data-pc-clip][data-pc-media] video')].filter((v) => v.getAttribute('src'));
    const v = shown.find((x) => !x.closest('[data-pc-clip="c-pixel"]'));
    const img = document.querySelector('[data-pc-clip="c-image"] img');
    const px = document.querySelector('[data-pc-clip="c-pixel"] canvas[data-pc-pixel-map]');
    /** Draws to an offscreen canvas to check if frames actually render (all black / solid color = no frame displayed) */
    const colours = (el, w, h) => {
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const x = c.getContext('2d');
      try { x.drawImage(el, 0, 0, w, h); } catch { return -1; }
      const d = x.getImageData(0, 0, w, h).data;
      const seen = new Set();
      for (let i = 0; i < d.length; i += 4) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3]}`);
      return seen.size;
    };
    return {
      videoSrc: v?.getAttribute('src') ?? null,
      videoReady: v?.readyState ?? -1,
      videoSize: v ? [v.videoWidth, v.videoHeight] : null,
      videoColours: v ? colours(v, 64, 48) : -1,
      imgNatural: img ? [img.naturalWidth, img.naturalHeight] : null,
      imgColours: img ? colours(img, 64, 64) : -1,
      pixelError: px?.getAttribute('data-pc-pixel-error') ?? null,
      pixelColours: px ? colours(px, 64, 48) : -1,
      // The same asset cannot be drawn twice: the track with pixel map should not contain a <video src> holding it
      pixelTrackVideos: [...document.querySelectorAll('[data-pc-track="tr-p"] video[src]')].length,
      slotWrappers: [...document.querySelectorAll('[data-pc-clip]')].map((e) => e.getAttribute('data-pc-clip')),
    };
  });
  check(out.mediaLayer.videoReady >= 2 && out.mediaLayer.videoSize?.[0] > 0, 'live media layer: <video> decode ready', out.mediaLayer);
  check(out.mediaLayer.videoColours > 8, 'live media layer: the video really shows a picture (not a single color)', out.mediaLayer.videoColours);
  check(out.mediaLayer.imgNatural?.[0] > 0 && out.mediaLayer.imgColours > 8, 'live media layer: the image really shows a picture', out.mediaLayer);
  check(!out.mediaLayer.pixelError && out.mediaLayer.pixelColours > 8, 'media clips with a pixel map also show a picture (R1b\'s WebGL path)', out.mediaLayer);
  check(out.mediaLayer.pixelTrackVideos === 1, 'media clips with a pixel map are not drawn twice (VideoTrack does not contain them)', out.mediaLayer.pixelTrackVideos);

  out.rects = await page.evaluate(async () => (await window.__rpc.rectsWithBounds({ pixels: 'none' })).map((r) => r.clipId));
  check(['c-video', 'c-image', 'c-pixel'].every((id) => out.rects.includes(id)), 'rects() includes media clips (D3 step 4)', out.rects);
  check(new Set(out.rects).size === out.rects.length, 'each clipId appears only once in rects()', out.rects);

  /* Media clip taken over by a media effect card: where node is adapter:'card', asset layer does not draw it */
  const graphProject = await page.evaluate(() => window.__mk([
    { id: 'tr-v', clips: [{ id: 'c-video', mediaId: 'mv', start: 0, end: 4, params: {} }] },
    { id: 'tr-g', clips: [{ id: 'c-graph', mediaId: 'mv', nodeId: 'gnode', start: 0, end: 4, params: {} }] },
  ], { cardNodes: [{ id: 'gnode', adapter: 'card', cardId: 'punch-pill', kind: 'animation', inputs: {}, params: { text: '素材效果卡' } }] }));
  await page.evaluate(async (p) => { await window.__rpc.setProject(p, { reset: true }); await window.__rpc.setMediaT(1); await window.__rpc.setTime(1); }, graphProject);
  await new Promise((r) => setTimeout(r, 800));
  out.graphTakeover = await fa.evaluate(() => ({
    wrappers: [...document.querySelectorAll('[data-pc-clip="c-graph"]')].length,
    videosOnGraphTrack: [...document.querySelectorAll('[data-pc-track="tr-g"] video[src]')].length,
    videosOnPlainTrack: [...document.querySelectorAll('[data-pc-track="tr-v"] video[src]')].length,
  }));
  check(out.graphTakeover.videosOnGraphTrack === 0 && out.graphTakeover.videosOnPlainTrack >= 1,
    'media clips taken over by a media effect card are not drawn by VideoTrack (ordinary media clips are drawn as usual)', out.graphTakeover);

  /* ================================================================
   * B. Planes and classes (E7 items 4 and 5) + component instance unchanged
   * ================================================================ */
  const cardProject = await page.evaluate(() => window.__mk([
    { id: 'tr-a', clips: [{ id: 'c-type', cardId: 'probe-typewriter', start: 0, end: 10, params: {} }] },
    { id: 'tr-b', clips: [{ id: 'c-par', cardId: 'particles', start: 0, end: 10, params: {} }] },
  ]));
  await page.evaluate(async (p) => { await window.__rpc.setProject(p, { reset: true }); await window.__rpc.setTime(1); }, cardProject);
  await new Promise((r) => setTimeout(r, 600));

  // Whether stylesheet loaded (injected only if the host actually uses plane props)
  out.planeStyle = await fa.evaluate(() => ({
    injected: !!document.querySelector('style[data-pc-planes]'),
    css: document.querySelector('style[data-pc-planes]')?.textContent?.split('\n').length ?? 0,
  }));
  check(out.planeStyle.injected && out.planeStyle.css === 4, 'E7\'s four style rules have been injected', out.planeStyle);

  // Tag the component root: once React remounts, this DOM element changes
  await fa.evaluate(() => {
    window.__mark = (id) => {
      const el = document.querySelector(`[data-pc-clip="${id}"] > *:not([data-pc-snapshot-plane]):not([data-pc-proxy-plane]):not([data-pc-stream-plane])`);
      if (el) el.__pcProbeMark = 1;
      return !!el;
    };
    window.__marked = (id) => {
      const el = document.querySelector(`[data-pc-clip="${id}"] > *:not([data-pc-snapshot-plane]):not([data-pc-proxy-plane]):not([data-pc-stream-plane])`);
      return el ? el.__pcProbeMark === 1 : null;
    };
    window.__state = (id) => {
      const el = document.querySelector(`[data-pc-clip="${id}"] [data-pc-probe="typewriter"]`);
      return el ? Number(el.getAttribute('data-pc-probe-cells')) : null;
    };
    window.__classes = (id) => document.querySelector(`[data-pc-clip="${id}"]`)?.className ?? null;
    window.__vis = (id) => {
      const wrap = document.querySelector(`[data-pc-clip="${id}"]`);
      if (!wrap) return null;
      const comp = wrap.querySelector(':scope > *:not([data-pc-snapshot-plane]):not([data-pc-proxy-plane]):not([data-pc-stream-plane])');
      const plane = wrap.querySelector(':scope > [data-pc-snapshot-plane]');
      const cs = comp ? getComputedStyle(comp) : null;
      const ps = plane ? getComputedStyle(plane) : null;
      return {
        comp: cs ? { display: cs.display, visibility: cs.visibility } : null,
        plane: ps ? { display: ps.display, visibility: ps.visibility } : null,
        hasPlane: !!plane,
      };
    };
    return true;
  });

  const SNAP_A = '<div data-probe-snap="a" style="position:absolute;inset:0;background:#f00"></div>';
  const SNAP_B = '<div data-probe-snap="b" style="position:absolute;inset:0;background:#0f0"></div>';

  out.instance = await page.evaluate(async (a, b) => {
    const mark = async () => await window.__rpc.setTime(1.2);
    void mark;
    return { a, b };
  }, SNAP_A, SNAP_B);

  await fa.evaluate(() => window.__mark('c-type'));
  const cellsBefore = await fa.evaluate(() => window.__state('c-type'));

  // (1) Attach snapshot
  await page.evaluate(async (html) => { await window.__rpc.setSnapshots({ 'c-type': html }, {}); }, SNAP_A);
  const onSnap = await fa.evaluate(() => ({ marked: window.__marked('c-type'), cells: window.__state('c-type'), cls: window.__classes('c-type'), vis: window.__vis('c-type'), snap: document.querySelector('[data-pc-clip="c-type"] [data-pc-snapshot-plane] [data-probe-snap]')?.getAttribute('data-probe-snap') ?? null }));
  // (2) Switch to another frame in the same clip
  await page.evaluate(async (html) => { await window.__rpc.setSnapshots({ 'c-type': html }, {}); }, SNAP_B);
  const swapSnap = await fa.evaluate(() => ({ marked: window.__marked('c-type'), cells: window.__state('c-type'), planes: document.querySelectorAll('[data-pc-clip="c-type"] [data-pc-snapshot-plane]').length, snap: document.querySelector('[data-pc-clip="c-type"] [data-pc-snapshot-plane] [data-probe-snap]')?.getAttribute('data-probe-snap') ?? null }));
  // (3) Remove
  await page.evaluate(async () => { await window.__rpc.setSnapshots({ 'c-type': null }, {}); });
  const offSnap = await fa.evaluate(() => ({ marked: window.__marked('c-type'), cells: window.__state('c-type'), cls: window.__classes('c-type'), vis: window.__vis('c-type') }));
  out.snapshot = { cellsBefore, onSnap, swapSnap, offSnap };

  check(onSnap.marked === true && swapSnap.marked === true && offSnap.marked === true,
    'snapshot attached / frame swapped / detached: the card component\'s DOM root is the same element (not remounted)', out.snapshot);
  check(onSnap.cells === cellsBefore && swapSnap.cells === cellsBefore && offSnap.cells === cellsBefore,
    'in all three cases the component\'s internal state lost nothing', out.snapshot);
  check(onSnap.cls?.includes('pc-snapshot') && !offSnap.cls?.includes('pc-snapshot'), '`.pc-snapshot` comes and goes with the snapshot', out.snapshot);
  check(onSnap.snap === 'a' && swapSnap.snap === 'b' && swapSnap.planes === 1,
    'frame swap is an atomic innerHTML replacement on the same plane; the before and after images never coexist', out.snapshot);
  check(onSnap.vis?.comp?.display === 'none' && onSnap.vis?.plane?.display !== 'none',
    '`.pc-snapshot`: subtree is display:none, the snapshot plane is spared', onSnap.vis);
  check(offSnap.vis?.comp?.display !== 'none' && offSnap.vis?.hasPlane === false, 'after detaching, the plane is gone and the component shows', offSnap.vis);

  /* ── Suppression: particle card ─────────────────────────────────── */
  await page.evaluate(async (html) => {
    await window.__rpc.setSnapshots({ 'c-par': html }, { reset: true });
    await window.__rpc.setSuppressed(['c-par']);
    await window.__rpc.setTime(2.0);
  }, SNAP_A);
  await new Promise((r) => setTimeout(r, 400));
  const sup1 = await fa.evaluate(() => {
    const cv = document.querySelector('[data-pc-clip="c-par"] canvas');
    return {
      cls: window.__classes('c-par'),
      vis: window.__vis('c-par'),
      localFrame: document.querySelector('[data-pc-clip="c-par"]')?.getAttribute('data-pc-local-frame'),
      hash: cv ? cv.toDataURL().length + ':' + cv.toDataURL().slice(-64) : null,
    };
  });
  await page.evaluate(async () => { await window.__rpc.setTime(3.0); });
  await new Promise((r) => setTimeout(r, 400));
  const sup2 = await fa.evaluate(() => {
    const cv = document.querySelector('[data-pc-clip="c-par"] canvas');
    return {
      localFrame: document.querySelector('[data-pc-clip="c-par"]')?.getAttribute('data-pc-local-frame'),
      hash: cv ? cv.toDataURL().length + ':' + cv.toDataURL().slice(-64) : null,
    };
  });
  const hit = await page.evaluate(async () => {
    const list = await window.__rpc.rectsWithBounds({ pixels: 'none' });
    const r = list.find((x) => x.clipId === 'c-par');
    return r ? await window.__rpc.hitTest(r.rect.left + r.rect.width / 2, r.rect.top + r.rect.height / 2) : null;
  });
  out.suppressed = { sup1, sup2, hit };
  check(sup1.cls?.includes('pc-suppressed'), '`.pc-suppressed` is attached', sup1.cls);
  check(sup1.vis?.comp?.display === 'none' && sup1.vis?.plane?.display !== 'none', '`.pc-suppressed`: subtree is display:none, the plane is spared', sup1.vis);
  check(!!sup1.hash && sup1.hash === sup2.hash, 'a suppressed particle card\'s <canvas> pixels do not change during suppression (the t passed to the component is frozen)', { a: sup1.hash, b: sup2.hash });
  check(sup1.localFrame !== sup2.localFrame, 'the wrapper layer\'s data-pc-local-frame still changes with t (the other uses of cardT still use the live value)', { a: sup1.localFrame, b: sup2.localFrame });
  check(hit?.clipId === 'c-par', 'a suppressed card can still be hit by hitTest (it is attached to the plane)', hit);

  await page.evaluate(async () => { await window.__rpc.setSuppressed([]); await window.__rpc.setSnapshots({}, { reset: true }); });

  /* ── `.pc-awaiting`: attached, removed via 500 ms fallback ───────── */
  const awaitOn = await page.evaluate(async () => {
    await window.__rpc.setTime(2.5, { awaiting: ['c-type'] });
    return true;
  });
  void awaitOn;
  const awaiting1 = await fa.evaluate(() => ({ cls: window.__classes('c-type'), vis: window.__vis('c-type') }));
  await new Promise((r) => setTimeout(r, 700));
  const awaiting2 = await fa.evaluate(() => ({ cls: window.__classes('c-type'), vis: window.__vis('c-type'), marked: window.__marked('c-type') }));
  out.awaiting = { awaiting1, awaiting2 };
  check(awaiting1.cls?.includes('pc-awaiting'), '`.pc-awaiting` is attached by setTime({ awaiting })', awaiting1);
  check(awaiting1.vis?.comp?.visibility === 'hidden' && awaiting1.vis?.comp?.display !== 'none',
    '`.pc-awaiting` is visibility:hidden, the subtree keeps its layout box', awaiting1.vis);
  check(!awaiting2.cls?.includes('pc-awaiting'), '`.pc-awaiting` is removed automatically after 500 ms (real-timer fallback)', awaiting2);
  check(awaiting2.vis?.comp?.visibility !== 'hidden' && awaiting2.marked === true, 'after the fallback, what shows is the same live component', awaiting2);

  /* ── Remove `.pc-awaiting` when snapshot arrives (the other exit path) ── */
  const awaitSnap = await page.evaluate(async (html) => {
    await window.__rpc.setTime(2.6, { awaiting: ['c-type'] });
    await window.__rpc.setSnapshots({ 'c-type': html }, {});
    return true;
  }, SNAP_A);
  void awaitSnap;
  out.awaitingBySnapshot = await fa.evaluate(() => ({ cls: window.__classes('c-type') }));
  check(!out.awaitingBySnapshot.cls?.includes('pc-awaiting') && out.awaitingBySnapshot.cls?.includes('pc-snapshot'),
    'when the snapshot arrives, `.pc-awaiting` is immediately replaced by `.pc-snapshot`', out.awaitingBySnapshot);
  await page.evaluate(async () => { await window.__rpc.setSnapshots({}, { reset: true }); });

  /* ── `.pc-settling` visibility (driven only in R5, tests style contract directly here) ── */
  out.settling = await fa.evaluate(() => {
    const wrap = document.querySelector('[data-pc-clip="c-type"]');
    const comp = wrap.querySelector(':scope > *:not([data-pc-snapshot-plane]):not([data-pc-proxy-plane]):not([data-pc-stream-plane])');
    wrap.classList.add('pc-settling');
    const on = { display: getComputedStyle(comp).display, visibility: getComputedStyle(comp).visibility };
    wrap.classList.remove('pc-settling');
    const off = { display: getComputedStyle(comp).display, visibility: getComputedStyle(comp).visibility };
    return { on, off };
  });
  check(out.settling.on.visibility === 'hidden' && out.settling.on.display !== 'none',
    '`.pc-settling` is visibility:hidden (the subtree keeps its layout box, animations keep running, syncIn can still pin it)', out.settling);
  check(out.settling.off.visibility !== 'hidden', 'removing `.pc-settling` restores it', out.settling);

  /* ================================================================
   * C. Two E4b items
   * ================================================================ */
  const typeProject = await page.evaluate(() => window.__mk([
    { id: 'tr-a', clips: [{ id: 'c-type', cardId: 'probe-typewriter', start: 0, end: 10, params: {} }] },
  ]));
  out.typewriter = await page.evaluate(async (p) => {
    await window.__rpcB.setRole('back', { job: 'probe' });
    await window.__rpcB.setProject(p, { reset: true });
    const r = await window.__rpcB.render(3.0, { jump: true, maxCatchUp: Infinity });
    return r;
  }, typeProject);
  await new Promise((r) => setTimeout(r, 300));
  out.typewriterCells = await fb.evaluate(() => {
    const el = document.querySelector('[data-pc-probe="typewriter"]');
    return { cells: el ? Number(el.getAttribute('data-pc-probe-cells')) : null, text: el?.textContent?.length ?? null };
  });
  check(!out.typewriter.aborted && Math.abs(out.typewriter.caughtUpAtSec - 3) < 1e-6, 'E4b: the typewriter card\'s catch-up run reaches second 3', out.typewriter);
  check(out.typewriterCells.cells === 30 && out.typewriterCells.text === 30,
    'E4b: setInterval steps once every 100 ms, so the catch-up run to second 3 gives exactly 30 steps', out.typewriterCells);

  const countProject = await page.evaluate(() => window.__mk([
    { id: 'tr-a', clips: [{ id: 'c-count', cardId: 'probe-countdown', start: 0, end: 30, params: {} }] },
  ]));
  const readRemaining = () => fb.evaluate(() => {
    const el = document.querySelector('[data-pc-probe="countdown"]');
    return el ? Number(el.getAttribute('data-pc-probe-remaining')) : null;
  });
  await page.evaluate(async (p) => {
    await window.__rpcB.setProject(p, { reset: true });
    await window.__rpcB.render(0, { jump: true, maxCatchUp: Infinity });
  }, countProject);
  await new Promise((r) => setTimeout(r, 300));
  const rem0 = await readRemaining();
  // Advance 10 s (without remounting): countdown endpoint was recorded at mount,
  // must be exactly 10 s less after advance
  await page.evaluate(async () => { await window.__rpcB.render(10, { maxCatchUp: Infinity }); });
  await new Promise((r) => setTimeout(r, 300));
  const rem10 = await readRemaining();
  out.countdown = { rem0, rem10, delta: rem0 !== null && rem10 !== null ? rem0 - rem10 : null };
  check(out.countdown.delta === 10000, 'E4b: after advancing 10 seconds, the Date.now() countdown card shows exactly 10 seconds less', out.countdown);

  await page.evaluate(async () => { await window.__rpcB.setRole('front'); });

  out.pageErrors = errors.filter((e) => !/favicon|Download the React DevTools|Failed to load resource/i.test(e));
  check(out.pageErrors.length === 0, 'no page errors', out.pageErrors.slice(0, 5));
} catch (err) {
  fails.push('exception: ' + (err && err.stack || err));
} finally {
  await browser.close();
  await closeAll([hostServer]);
}
out.fails = fails;
console.log(JSON.stringify(out, null, 2));
process.exit(fails.length ? 1 : 0);
