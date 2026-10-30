/**
 * R3「舞台内容」验收探针(E4b / E7 / D3 第 4 步)。
 *
 *   node scripts/probes/stage-content-probe.mjs [--origin http://127.0.0.1:5241] [--same-origin]
 *
 * 不带 `--origin` 就看 `PC_STAGE_TEST_URL`,再没有就打 `.claude/launch.json` 的 `dev-test`。
 *
 * 和 `stage-rpc-probe.mjs` 同一套骨架:本进程临时起一个 http 服务发「测试页」,页面里挂两个
 * 舞台 iframe(默认打编辑器进程的两个舞台端口,`--same-origin` 打编辑器自己这个源),
 * 只经 postMessage RPC 驱动它们。**iframe 的地址带 `&preview=stage`** —— 舞台靠它决定渲
 * `FrameScene` 的 live 变体(素材层进舞台、六个平面 prop 生效),不带就是今天那条 `Stage` 路。
 *
 * 验的是任务书 E7 / E4b / D3 第 4 步这几条:
 *
 *   1. **组件实例不变**:快照挂上、摘掉、同一片段换另一帧三种情况下,卡片组件的 DOM 根是同一个
 *      元素对象(挂了标记),而且它的内部状态(打字机的格数)一格都没丢 —— 不靠人看 DevTools;
 *   2. **四个类的可见性**:`.pc-snapshot` / `.pc-suppressed` 藏子树(display:none)但放过三种平面;
 *      `.pc-awaiting` / `.pc-settling` 是 visibility:hidden(子树保留布局盒);
 *   3. **被抑制的卡**:粒子卡的 `<canvas>` 像素哈希在抑制期间不变(传给组件的 `t` 冻住了),
 *      而包裹层的 `data-pc-local-frame` 仍随 `t` 变(`cardT` 的其余用途照常用实时值),
 *      `hitTest` 仍能点中它(贴着快照平面时);
 *   4. **`.pc-awaiting` 的 500 ms 兜底**:快照没来也要自己摘掉,不能永久隐身;
 *   5. **素材层在舞台里**:视频出画面、图片出画面、带像素映射的素材段也出;`rects()` 含素材段;
 *      被别人接管的素材段(像素映射 / 素材效果卡节点)不被画两遍;
 *   6. **E4b 两条**:`setInterval` 每 100 ms 一格的打字机卡补跑到第 3 秒恰好 30 格;
 *      `Date.now()` 倒计时卡续推 10 秒后恰好少 10 秒。
 *
 * 素材用 ffmpeg 现生成一份(`testsrc`),按内容哈希落进 `out/media/`,所以 `/@media/<hash>`
 * 和舞台同源 —— 跨源的 `<video>` 上传成 WebGL 纹理会污染画布,像素映射那条就验不了。
 *
 * 输出 JSON 结论到 stdout;任何一条不过就以非零退出。
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

/* ------------------------------------------------------------------ 素材 */

/** 落一份内容到本地内容库(`out/media/<sha256>.<ext>`),回 `/@media/<hash>` 能取到的 hash */
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

/** ffmpeg 现生成两份小素材(彩条视频 + 彩条图),放临时目录再收进内容库 */
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

/* ------------------------------------------------------------------ 测试页 */

async function stageOrigins() {
  if (sameOrigin) return [origin, origin];
  const r = await fetch(origin + '/api/stage/ports');
  const j = await r.json();
  if (!j.ok || !Array.isArray(j.ports) || j.ports.length < 2) throw new Error(`舞台端口没起来:${JSON.stringify(j)}`);
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

/* ------------------------------------------------------------------ 跑 */

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

  /* ── 项目工厂(形状同 kernel/project.ts 的 createEmptyProject) ─────────── */
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
   * A. 素材层在舞台里(E7 第 1 条 / D3 第 4 步)
   * ================================================================ */
  const mediaProject = await page.evaluate(() => window.__mk([
    // 最上面一条:普通视频段
    { id: 'tr-v', clips: [{ id: 'c-video', mediaId: 'mv', start: 0, end: 4, params: {}, frame: { x: 0, y: 0, w: 960, h: 540, anchor: [0, 0] } }] },
    // 图片段
    { id: 'tr-i', clips: [{ id: 'c-image', mediaId: 'mi', start: 0, end: 4, params: {}, frame: { x: 960, y: 0, w: 960, h: 540, anchor: [0, 0] } }] },
    // 带像素映射的视频段
    { id: 'tr-p', clips: [{ id: 'c-pixel', mediaId: 'mv', start: 0, end: 4, params: {}, pixelMap: { id: 'pm1' }, frame: { x: 0, y: 540, w: 960, h: 540, anchor: [0, 0] } }] },
  ], {
    pixelMaps: [{
      id: 'pm1', name: '反色', source: { stage: 'origin' }, where: '1',
      to: { kind: 'expr', r: '1 - r', g: '1 - g', b: '1 - b', a: 'a' }, mode: 'continuous',
    }],
  }));
  await page.evaluate(async (p) => {
    await window.__rpc.setProject(p, { reset: true });
    await window.__rpc.setMediaT(1.5);
    await window.__rpc.setTime(1.5);
  }, mediaProject);
  // 解码 + 出画要几个真帧:素材层跟的是墙钟,不是虚拟时钟
  await new Promise((r) => setTimeout(r, 2500));
  await page.evaluate(async () => { await window.__rpc.setMediaT(1.5); await window.__rpc.setTime(1.5); });
  await new Promise((r) => setTimeout(r, 1500));

  out.mediaLayer = await fa.evaluate(() => {
    const shown = [...document.querySelectorAll('[data-pc-clip][data-pc-media] video')].filter((v) => v.getAttribute('src'));
    const v = shown.find((x) => !x.closest('[data-pc-clip="c-pixel"]'));
    const img = document.querySelector('[data-pc-clip="c-image"] img');
    const px = document.querySelector('[data-pc-clip="c-pixel"] canvas[data-pc-pixel-map]');
    /** 画到一张离屏画布上,看是不是真有画面(全黑 / 单色 = 没出画) */
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
      // 同一个素材不能被画两遍:带像素映射的那条序列上不该有装着它的 <video src>
      pixelTrackVideos: [...document.querySelectorAll('[data-pc-track="tr-p"] video[src]')].length,
      slotWrappers: [...document.querySelectorAll('[data-pc-clip]')].map((e) => e.getAttribute('data-pc-clip')),
    };
  });
  check(out.mediaLayer.videoReady >= 2 && out.mediaLayer.videoSize?.[0] > 0, 'live 素材层:<video> 解码就绪', out.mediaLayer);
  check(out.mediaLayer.videoColours > 8, 'live 素材层:视频真的出画面(不是单色)', out.mediaLayer.videoColours);
  check(out.mediaLayer.imgNatural?.[0] > 0 && out.mediaLayer.imgColours > 8, 'live 素材层:图片真的出画面', out.mediaLayer);
  check(!out.mediaLayer.pixelError && out.mediaLayer.pixelColours > 8, '带像素映射的素材段也出画面(R1b 的 WebGL 路)', out.mediaLayer);
  check(out.mediaLayer.pixelTrackVideos === 1, '带像素映射的素材段不被画两遍(VideoTrack 里没有它)', out.mediaLayer.pixelTrackVideos);

  out.rects = await page.evaluate(async () => (await window.__rpc.rectsWithBounds({ pixels: 'none' })).map((r) => r.clipId));
  check(['c-video', 'c-image', 'c-pixel'].every((id) => out.rects.includes(id)), 'rects() 含素材段(D3 第 4 步)', out.rects);
  check(new Set(out.rects).size === out.rects.length, 'rects() 里每个 clipId 只出现一次', out.rects);

  /* 素材效果卡接管的素材段:节点是 adapter:'card' 的,素材层不画它 */
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
    '素材效果卡接管的素材段不被 VideoTrack 画(普通素材段照画)', out.graphTakeover);

  /* ================================================================
   * B. 平面与类(E7 第 4、5 条)+ 组件实例不变
   * ================================================================ */
  const cardProject = await page.evaluate(() => window.__mk([
    { id: 'tr-a', clips: [{ id: 'c-type', cardId: 'probe-typewriter', start: 0, end: 10, params: {} }] },
    { id: 'tr-b', clips: [{ id: 'c-par', cardId: 'particles', start: 0, end: 10, params: {} }] },
  ]));
  await page.evaluate(async (p) => { await window.__rpc.setProject(p, { reset: true }); await window.__rpc.setTime(1); }, cardProject);
  await new Promise((r) => setTimeout(r, 600));

  // 样式表进来了没有(只有真的用上平面 prop 的宿主才注入)
  out.planeStyle = await fa.evaluate(() => ({
    injected: !!document.querySelector('style[data-pc-planes]'),
    css: document.querySelector('style[data-pc-planes]')?.textContent?.split('\n').length ?? 0,
  }));
  check(out.planeStyle.injected && out.planeStyle.css === 4, 'E7 的四条样式规则已注入', out.planeStyle);

  // 给组件根挂标记:React 一旦重挂载,这个 DOM 元素就换人了
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

  // ① 挂上快照
  await page.evaluate(async (html) => { await window.__rpc.setSnapshots({ 'c-type': html }, {}); }, SNAP_A);
  const onSnap = await fa.evaluate(() => ({ marked: window.__marked('c-type'), cells: window.__state('c-type'), cls: window.__classes('c-type'), vis: window.__vis('c-type'), snap: document.querySelector('[data-pc-clip="c-type"] [data-pc-snapshot-plane] [data-probe-snap]')?.getAttribute('data-probe-snap') ?? null }));
  // ② 同一片段换另一帧
  await page.evaluate(async (html) => { await window.__rpc.setSnapshots({ 'c-type': html }, {}); }, SNAP_B);
  const swapSnap = await fa.evaluate(() => ({ marked: window.__marked('c-type'), cells: window.__state('c-type'), planes: document.querySelectorAll('[data-pc-clip="c-type"] [data-pc-snapshot-plane]').length, snap: document.querySelector('[data-pc-clip="c-type"] [data-pc-snapshot-plane] [data-probe-snap]')?.getAttribute('data-probe-snap') ?? null }));
  // ③ 摘掉
  await page.evaluate(async () => { await window.__rpc.setSnapshots({ 'c-type': null }, {}); });
  const offSnap = await fa.evaluate(() => ({ marked: window.__marked('c-type'), cells: window.__state('c-type'), cls: window.__classes('c-type'), vis: window.__vis('c-type') }));
  out.snapshot = { cellsBefore, onSnap, swapSnap, offSnap };

  check(onSnap.marked === true && swapSnap.marked === true && offSnap.marked === true,
    '快照挂上 / 换帧 / 摘掉:卡片组件的 DOM 根是同一个元素(没重挂载)', out.snapshot);
  check(onSnap.cells === cellsBefore && swapSnap.cells === cellsBefore && offSnap.cells === cellsBefore,
    '三种情况下组件内部状态一格都没丢', out.snapshot);
  check(onSnap.cls?.includes('pc-snapshot') && !offSnap.cls?.includes('pc-snapshot'), '`.pc-snapshot` 跟着快照来去', out.snapshot);
  check(onSnap.snap === 'a' && swapSnap.snap === 'b' && swapSnap.planes === 1,
    '换帧是同一个平面的 innerHTML 原子替换,前后两张不共存', out.snapshot);
  check(onSnap.vis?.comp?.display === 'none' && onSnap.vis?.plane?.display !== 'none',
    '`.pc-snapshot`:子树 display:none,快照平面放过', onSnap.vis);
  check(offSnap.vis?.comp?.display !== 'none' && offSnap.vis?.hasPlane === false, '摘掉之后平面没了、组件露出来', offSnap.vis);

  /* ── 抑制:粒子卡 ───────────────────────────────────────────────── */
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
  check(sup1.cls?.includes('pc-suppressed'), '`.pc-suppressed` 挂上了', sup1.cls);
  check(sup1.vis?.comp?.display === 'none' && sup1.vis?.plane?.display !== 'none', '`.pc-suppressed`:子树 display:none,平面放过', sup1.vis);
  check(!!sup1.hash && sup1.hash === sup2.hash, '被抑制的粒子卡 <canvas> 像素在抑制期间不变(传给组件的 t 冻住了)', { a: sup1.hash, b: sup2.hash });
  check(sup1.localFrame !== sup2.localFrame, '包裹层的 data-pc-local-frame 仍随 t 变(cardT 的其余用途照常用实时值)', { a: sup1.localFrame, b: sup2.localFrame });
  check(hit?.clipId === 'c-par', '被抑制的卡 hitTest 仍能点中(贴着平面)', hit);

  await page.evaluate(async () => { await window.__rpc.setSuppressed([]); await window.__rpc.setSnapshots({}, { reset: true }); });

  /* ── `.pc-awaiting`:挂上、500 ms 兜底自己摘掉 ─────────────────── */
  const awaitOn = await page.evaluate(async () => {
    await window.__rpc.setTime(2.5, { awaiting: ['c-type'] });
    return true;
  });
  void awaitOn;
  const awaiting1 = await fa.evaluate(() => ({ cls: window.__classes('c-type'), vis: window.__vis('c-type') }));
  await new Promise((r) => setTimeout(r, 700));
  const awaiting2 = await fa.evaluate(() => ({ cls: window.__classes('c-type'), vis: window.__vis('c-type'), marked: window.__marked('c-type') }));
  out.awaiting = { awaiting1, awaiting2 };
  check(awaiting1.cls?.includes('pc-awaiting'), '`.pc-awaiting` 由 setTime({ awaiting }) 挂上', awaiting1);
  check(awaiting1.vis?.comp?.visibility === 'hidden' && awaiting1.vis?.comp?.display !== 'none',
    '`.pc-awaiting` 是 visibility:hidden,子树保留布局盒', awaiting1.vis);
  check(!awaiting2.cls?.includes('pc-awaiting'), '`.pc-awaiting` 500 ms 后自动摘掉(真定时器兜底)', awaiting2);
  check(awaiting2.vis?.comp?.visibility !== 'hidden' && awaiting2.marked === true, '兜底之后露出的是同一个活组件', awaiting2);

  /* ── 快照到达就把 `.pc-awaiting` 摘掉(另一条退出路) ─────────── */
  const awaitSnap = await page.evaluate(async (html) => {
    await window.__rpc.setTime(2.6, { awaiting: ['c-type'] });
    await window.__rpc.setSnapshots({ 'c-type': html }, {});
    return true;
  }, SNAP_A);
  void awaitSnap;
  out.awaitingBySnapshot = await fa.evaluate(() => ({ cls: window.__classes('c-type') }));
  check(!out.awaitingBySnapshot.cls?.includes('pc-awaiting') && out.awaitingBySnapshot.cls?.includes('pc-snapshot'),
    '快照到达时 `.pc-awaiting` 立刻换成 `.pc-snapshot`', out.awaitingBySnapshot);
  await page.evaluate(async () => { await window.__rpc.setSnapshots({}, { reset: true }); });

  /* ── `.pc-settling` 的可见性(R5 才有驱动,这里直接验样式契约) ── */
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
    '`.pc-settling` 是 visibility:hidden(子树保留布局盒,动画照跑、syncIn 钉得上)', out.settling);
  check(out.settling.off.visibility !== 'hidden', '摘掉 `.pc-settling` 就恢复', out.settling);

  /* ================================================================
   * C. E4b 两条
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
  check(!out.typewriter.aborted && Math.abs(out.typewriter.caughtUpAtSec - 3) < 1e-6, 'E4b:打字机卡补跑到第 3 秒', out.typewriter);
  check(out.typewriterCells.cells === 30 && out.typewriterCells.text === 30,
    'E4b:setInterval 每 100 ms 一格,补跑到第 3 秒恰好 30 格', out.typewriterCells);

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
  // 续推(不重挂载)10 秒:倒计时的终点是挂载那一刻记下的,推完必须正好少 10 秒
  await page.evaluate(async () => { await window.__rpcB.render(10, { maxCatchUp: Infinity }); });
  await new Promise((r) => setTimeout(r, 300));
  const rem10 = await readRemaining();
  out.countdown = { rem0, rem10, delta: rem0 !== null && rem10 !== null ? rem0 - rem10 : null };
  check(out.countdown.delta === 10000, 'E4b:Date.now() 倒计时卡推 10 秒后恰好少 10 秒', out.countdown);

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
