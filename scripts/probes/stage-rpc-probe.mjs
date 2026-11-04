/**
 * E0 / E1 acceptance check probe: mounts **two** stage iframes (`?stage=1&id=A` / `id=B`) on a
 * "test page", driving them only via postMessage RPC. Targets two cross-origin stage ports by
 * default, while `--legacy` targets the same origin.
 *
 *   node scripts/probes/stage-rpc-probe.mjs [--origin http://127.0.0.1:5211] [--legacy]
 *
 * Without `--origin`, check `PC_STAGE_TEST_URL`; if still missing, target `dev-test` in
 * `.claude/launch.json`.
 *
 * In cross-origin mode, URLs of the two iframes are obtained from `/api/stage/ports` of the
 * editor process (fails with an error and exits if it cannot start); `--legacy` points both
 * iframes back to the editor's own origin, verifying that "it passes as usual under legacy".
 *
 * Verifies the items from task brief E0 / E1:
 *   - All RPCs work normally, and all time parameters are in seconds; handshakes of the two
 *     iframes each carry their own hostCapabilities (J4), and `stageId` is `A` / `B`: **it is
 *     merely an instance name, unrelated to role**;
 *   - **Role gate (E1)**: default role is `front`; sending `render` or `setTime({ probe: true })`
 *     to it always returns `{ aborted: true, reason: 'role' }`; after `setRole('back')`, the same
 *     instance can receive them;
 *   - Scrub the playhead 60 times during pause (including scrubbing backward and jumping 60
 *     seconds): playToken is unchanged (wrapper layer DOM element is the same), and each setTime
 *     stage main thread ≤ 5 ms (without advanceTo);
 *   - render only verifies the method itself: Promise resolves only after frame push completes;
 *     response includes remounted / caughtUpAtSec / elapsedMs; calling twice back-to-back returns
 *     `superseded` on the first; setProject cuts off in-flight render and returns `project`;
 *     render({ probe: true }) posts one probe-frame per frame, and frames matches the event count;
 *   - hitTest / rectsWithBounds work as usual; under 17 tracks × 10 cards,
 *     rectsWithBounds({ pixels: 'selected' }) ≤ 5 ms;
 *   - Stage page exposes __pcCreateSnapshot; snapshot controls is wrapper layer innerHTML
 *     (excluding data-pc-clip);
 *   - play / pause return the unified PlayReply (`ok` is non-optional).
 *
 * **After cross-origin, the parent page cannot access window in the iframe**, so timing and DOM
 * checks on the stage side always use puppeteer frame handles (`page.frames()` still provides
 * them for cross-origin iframes), rather than `document.getElementById('f').contentWindow`.
 *
 * The test page is served by a temporary HTTP service (random available port) started by this
 * process, leaving no static page in the repository.
 * **Puppeteer request interception can no longer be used to serve this page**: responses created
 * by `Fetch.fulfillRequest` have no remote IP, and Chrome classifies this document's address space
 * as non-local, so when it accesses the two stage ports at 127.0.0.1 for the iframes, it gets
 * blocked by Local Network Access (observed `net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS`).
 * The same-origin version does not hit this because the iframe and document are same-origin and
 * follow a different check.
 *
 * Output JSON conclusions to stdout; exit with non-zero if any check fails.
 */
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { serve, closeAll, devOrigin } from './probe-connect.mjs';

const args = process.argv.slice(2);
const origin = devOrigin(args);
const legacy = args.includes('--legacy');
const HOST_PATH = '/__stage-rpc-probe-host';

/** Origins of the two stages. Under legacy, both are the editor's own origin (the same-origin single-stage path) */
async function stageOrigins() {
  if (legacy) return [origin, origin];
  const r = await fetch(origin + '/api/stage/ports');
  const j = await r.json();
  if (!j.ok || !Array.isArray(j.ports) || j.ports.length < 2) throw new Error(`Stage ports did not come up: ${JSON.stringify(j)}`);
  const u = new URL(origin);
  return j.ports.slice(0, 2).map((p) => `${u.protocol}//${u.hostname}:${p}`);
}

const hostHtml = (oa, ob) => `<!doctype html><html><head><meta charset="utf-8"><title>stage rpc probe host</title></head>
<body style="margin:0;background:#222">
<iframe id="a" src="${oa}/?stage=1&id=A&prerender=1" style="width:1920px;height:1080px;border:0;display:block"></iframe>
<iframe id="b" src="${ob}/?stage=1&id=B&prerender=1" style="width:1920px;height:1080px;border:0;display:block;opacity:0;pointer-events:none"></iframe>
<script type="module">
// A minimal RPC client (same protocol as src/render/stageRpc.ts), inlined here so the same probe can also hit the vite preview build output (there is no /src/*.ts there)
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
]).then(([a, b]) => { window.__rpc = a.rpc; window.__caps = a.caps; window.__rpcB = b.rpc; window.__capsB = b.caps; return true; });
</script></body></html>`;

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra !== undefined ? ' :: ' + JSON.stringify(extra) : '')); return cond; };

const [originA, originB] = await stageOrigins();
const hostServer = await serve(0, (req, res) => {
  if (new URL(req.url, 'http://x').pathname !== HOST_PATH) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(hostHtml(originA, originB));
}, '127.0.0.1');
const hostUrl = `http://127.0.0.1:${hostServer.address().port}${HOST_PATH}`;
const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
const out = { mode: legacy ? 'legacy' : 'cross-origin', originA, originB, host: hostUrl };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1080 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('response', (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });
  await page.goto(hostUrl, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.evaluate(() => Promise.race([window.__ready, new Promise((_, rej) => setTimeout(() => rej(new Error('stage ready timeout')), 120000))]));

  /*
   * After cross-origin, parent page cannot access window in the iframe: timing and DOM on stage side
   * always go through frame handles.
   * The frame url carries id=A / id=B, used for identification.
   */
  const frameOf = (id) => page.frames().find((f) => f.url().includes(`id=${id}`));
  const fa = frameOf('A');
  const fb = frameOf('B');
  check(!!fa && !!fb, 'both stage iframes are attached', { a: fa?.url(), b: fb?.url() });
  out.caps = await page.evaluate(() => window.__caps);
  out.capsB = await page.evaluate(() => window.__capsB);
  check(out.caps && typeof out.caps.prerender === 'boolean' && typeof out.caps.compact === 'boolean' && typeof out.caps.offscreenGl === 'boolean', 'handshake carries hostCapabilities', out.caps);
  // stageId is merely an instance name: both instances report their own id, while their roles at this
  // moment are still the default front
  check(out.caps.stageId === 'A' && out.capsB.stageId === 'B', 'stageId is the instance name (A / B), not a role', { a: out.caps.stageId, b: out.capsB.stageId });

  // ---- Role gate (E1): default role is front; render and setTime({probe}) should both be blocked
  const gate = await page.evaluate(async () => ({
    render: await window.__rpcB.render(1.0, { jump: true, maxCatchUp: Infinity }),
    probeTime: await window.__rpcB.setTime(1.0, { probe: true }),
    plainTime: await window.__rpcB.setTime(1.0),
  }));
  out.gate = gate;
  check(gate.render?.aborted === true && gate.render.reason === 'role', 'render on a front-role stage is refused with reason role', gate.render);
  check(gate.probeTime?.aborted === true && gate.probeTime.reason === 'role', 'setTime({probe}) on a front-role stage is refused with reason role', gate.probeTime);
  check(!gate.plainTime?.aborted && typeof gate.plainTime?.path === 'string', 'plain setTime is NOT gated (front drags, back measures)', gate.plainTime);
  // Switching the same instance to back allows it to receive: the gate checks role, not instance name
  const gate2 = await page.evaluate(async () => {
    await window.__rpcB.setRole('back', { job: 'probe' });
    const r = await window.__rpcB.render(0.2, { jump: true, maxCatchUp: Infinity });
    const p = await window.__rpcB.setTime(0.2, { probe: true });
    await window.__rpcB.setRole('front');
    return { r, p };
  });
  out.gate2 = gate2;
  check(gate2.r?.aborted === true && gate2.r.reason === 'project', 'the same instance in back role gets past the gate (no project yet → reason project)', gate2.r);
  check(!gate2.p?.aborted, 'setTime({probe}) in back role gets past the gate', gate2.p);

  // ---- Project: small project with 3 tracks + large project with 17 tracks × 10 cards
  const mkProject = await page.evaluate(async () => {
    // Empty project shape follows createEmptyProject in src/kernel/project.ts (not imported here so the
    // probe can also target build bundles)
    window.__mk = (tracks, extra = {}) => ({ version: 1, id: 'probe', name: 'probe', width: 1920, height: 1080, fps: 30, duration: 60, themeId: 'midnight', media: [], tracks, ...extra });
    return true;
  });
  check(mkProject, 'project factory');
  const small = await page.evaluate(() => window.__mk([
    { id: 'tr-a', clips: [{ id: 'c-pill', cardId: 'punch-pill', start: 0, end: 10, params: { text: 'RPC 探针' } }, { id: 'c-pill2', cardId: 'punch-pill', start: 20, end: 30, params: { text: '后半段' } }] },
    { id: 'tr-b', clips: [{ id: 'c-odo', cardId: 'odometer', start: 0, end: 60, params: {} }] },
    { id: 'tr-c', clips: [{ id: 'c-3d', cardId: 'scene-3d', start: 0, end: 60, params: {} }] },
  ]));
  const big = await page.evaluate(() => window.__mk(Array.from({ length: 17 }, (_, ti) => ({
    id: 'big-' + ti,
    clips: Array.from({ length: 10 }, (_, ci) => ({ id: `b-${ti}-${ci}`, cardId: ci % 2 ? 'odometer' : 'punch-pill', start: ci * 6, end: ci * 6 + 6, params: ci % 2 ? {} : { text: 'k' + ti + ci } })),
  }))));

  const domOnly = await page.evaluate(() => window.__mk([
    { id: 'tr-a', clips: [{ id: 'c-pill', cardId: 'punch-pill', start: 0, end: 10, params: { text: 'RPC 探针' } }, { id: 'c-pill2', cardId: 'punch-pill', start: 20, end: 30, params: { text: '后半段' } }] },
    { id: 'tr-b', clips: [{ id: 'c-odo', cardId: 'odometer', start: 0, end: 60, params: {} }] },
  ]));

  // ---- setProject full + reset. The ≤ 5 ms for 60 scrubs is measured on a project with "two DOM
  // cards": machine overhead of setTime itself is ≈ 0.3 ms (empty project), and the rest is entirely
  // the card's own single React render (measured odometer ≈ 2.4 ms, chapter-bar ≈ 1.7 ms, punch-pill
  // ≈ 0.9 ms, dev React); for 3D cards, three.js must also render a frame whenever t changes: those
  // are card costs, and the K1 probe will classify slow ones as heavy; here we only guard setTime
  // without catch-up runs (no advanceTo).
  const sp = await page.evaluate(async (p) => await window.__rpc.setProject(p, { reset: true }), domOnly);
  check(sp && sp.ok === true, 'setProject(full, reset) ok', sp);
  const st0 = await page.evaluate(async () => await window.__rpc.setTime(0.5));
  check(st0 && (st0.path === 'set' || st0.path === 'continuous'), 'setTime replies with path', st0);
  await new Promise((r) => setTimeout(r, 300));

  // Wrap timing in the stage document: measures the stage main thread (real wall clock __pcRealNow),
  // not RPC round trip
  await fa.evaluate(() => {
    window.__times = { setTime: [], rects: [] };
    const api = window.__pcStage;
    for (const m of ['setTime', 'rectsWithBounds']) {
      const orig = api[m];
      api[m] = async function (...a) { const t0 = window.__pcRealNow(); const r = await orig.apply(this, a); window.__times[m === 'setTime' ? 'setTime' : 'rects'].push(window.__pcRealNow() - t0); return r; };
    }
    for (const el of document.querySelectorAll('[data-pc-clip]')) el.__probeMark = 1;
  });

  // ---- 60 scrubs: forward, backward, jump 60 seconds
  const seq = [];
  for (let i = 0; i < 60; i++) {
    const r = i % 6;
    seq.push(r === 0 ? 55 + (i % 5) : r === 1 ? 0.2 : r === 2 ? 3.1 : r === 3 ? 1.0 : r === 4 ? 9.7 : 4.3);
  }
  const paths = await page.evaluate(async (seq) => {
    const out = [];
    for (const t of seq) out.push((await window.__rpc.setTime(t)).path);
    return out;
  }, seq);
  const drag = await fa.evaluate((n) => {
    const wrappers = [...document.querySelectorAll('[data-pc-clip]')];
    // Only inspect clips active across the entire range (c-odo is 0~60s): c-pill is expected to
    // unmount at 55s, and remount when scrubbed back to 0.2s
    const always = ['c-odo'];
    const kept = wrappers.filter((el) => always.includes(el.getAttribute('data-pc-clip'))).every((el) => el.__probeMark === 1) && always.every((id) => wrappers.some((el) => el.getAttribute('data-pc-clip') === id));
    const times = window.__times.setTime.slice(-n);
    return { kept, max: Math.max(...times), p90: [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.9)] };
  }, seq.length);
  out.drag = { ...drag, setPaths: paths.filter((p) => p === 'set').length };
  check(drag.kept, 'wrappers (playToken) unchanged across 60 setTime', out.drag);
  check(out.drag.setPaths > 0 && paths.every((p) => p === 'set' || p === 'continuous'), 'setTime paths', paths.slice(0, 8));
  check(typeof drag.p90 === 'number', 'the stage main-thread time of setTime yielded a p90 (record only; previously required ≤ 5 ms: timings are only recorded, not used as a gate (verification.md, user decision 2026-10-07); amended during the second scan of the 2026-10-23 overall probe audit)', { p90: drag.p90, max: drag.max });

  // Measure the same set of scrubs again on a project with 3D cards, reporting numbers without
  // judging (the card's own rendering cost)
  await page.evaluate(async (p) => { await window.__rpc.setProject(p, { reset: true }); await window.__rpc.setTime(0.5); }, small);
  await new Promise((r) => setTimeout(r, 300));
  await fa.evaluate(() => { window.__times.setTime = []; });
  await page.evaluate(async (seq) => { for (const t of seq) await window.__rpc.setTime(t); }, seq);
  out.drag3d = await fa.evaluate(() => {
    const times = window.__times.setTime;
    return { max: Math.max(...times), p90: [...times].sort((a, b) => a - b)[Math.floor(times.length * 0.9)] };
  });

  // ---- hitTest / rectsWithBounds on the small project
  await page.evaluate(async () => { await window.__rpc.setTime(2); });
  await new Promise((r) => setTimeout(r, 200));
  const geo = await page.evaluate(async () => {
    const all = await window.__rpc.rectsWithBounds({ pixels: 'all' });
    const sel = await window.__rpc.rectsWithBounds({ pixels: 'selected', clipIds: ['c-odo'] });
    const b = all.find((r) => r.clipId === 'c-odo')?.bounds;
    const hit = b ? await window.__rpc.hitTest(b.left + b.width / 2, b.top + b.height / 2) : null;
    const size = await window.__rpc.size();
    const c3 = all.find((r) => r.clipId === 'c-3d');
    return { ids: all.map((r) => r.clipId), selIds: sel.map((r) => r.clipId), b, hit, size, c3 };
  });
  out.geo = geo;
  check(geo.size.width === 1920 && geo.size.height === 1080, 'size() is the project size', geo.size);
  check(geo.ids.includes('c-odo') && geo.ids.includes('c-pill') && !geo.ids.includes('c-pill2'), 'rectsWithBounds lists active clips only', geo.ids);
  check(geo.b && Number.isFinite(geo.b.left) && geo.b.width > 0 && geo.b.width < 1920, 'odometer bounds is a finite content box smaller than the stage', geo.b);
  check(geo.hit && geo.hit.clipId === 'c-odo', 'hitTest at the odometer content centre hits it', geo.hit);
  check(geo.c3 && geo.c3.bounds && geo.c3.bounds.width < 1920 * 0.95, 'scene-3d bounds (pixels: all) is not the whole canvas', geo.c3);

  // ---- Snapshot surface (first seek to the time when the 3D card has drawn content; at 0.7s it is
  // still an empty canvas, and if no canvas pixels are scanned, no entity box is written)
  await page.evaluate(async () => { await window.__rpc.setTime(2); await new Promise((r) => setTimeout(r, 800)); });
  const frozen = await fa.evaluate(() => {
    const f = window.__pcCreateSnapshot();
    const c3 = f.controls.find((c) => c.id === 'c-3d');
    // Avoid <img[^>]* regex: inline styles are hundreds of thousands of bytes, backtracking is too
    // slow; look up attributes directly
    const pi = c3 ? c3.html.indexOf('data-pc-painted-box="') : -1;
    const painted = pi >= 0 ? /^(\d+),(\d+),(\d+),(\d+)/.exec(c3.html.slice(pi + 21, pi + 60)) : null;
    return { controls: f.controls.length, first: f.controls[0] ? { id: f.controls[0].id, hasClipAttr: /data-pc-clip=/.test(f.controls[0].html), hasProxyPlane: /data-pc-proxy-plane/.test(f.controls[0].html), len: f.controls[0].html.length } : null, sceneAttr: /data-pc-scene/.test(f.html), painted: painted ? painted.slice(1).map(Number) : null, canvasLeft: c3 ? /<canvas/.test(c3.html) : null };
  });
  out.frozen = frozen;
  check(frozen.controls > 0 && frozen.first && !frozen.first.hasClipAttr && !frozen.first.hasProxyPlane, 'stage __pcCreateSnapshot controls are wrapper innerHTML without data-pc-clip', frozen);
  // A2(4): Canvas of the 3D card is replaced with <img> with data-pc-painted-box; coordinates are
  // canvas pixel coordinates (smaller than the whole canvas)
  check(frozen.painted && frozen.canvasLeft === false && frozen.painted[2] > 0 && frozen.painted[2] < 1920, 'frozen scene-3d canvas became <img data-pc-painted-box> in canvas pixel coords', frozen);

  // ---- Large project: heartbeat elapsed time for 17 tracks × 10 cards
  await page.evaluate(async (p) => { await window.__rpc.setProject(p, { reset: true }); await window.__rpc.setTime(1); }, big);
  await new Promise((r) => setTimeout(r, 800));
  await fa.evaluate(() => { window.__times.rects = []; });
  const active = await page.evaluate(async () => {
    for (let i = 0; i < 10; i++) await window.__rpc.rectsWithBounds({ pixels: 'selected', clipIds: ['b-3-0'] });
    return (await window.__rpc.rectsWithBounds({ pixels: 'none' })).length;
  });
  const beatTimes = await fa.evaluate(() => window.__times.rects.slice(0, 10));
  out.beat = { active, max: Math.max(...beatTimes), p50: [...beatTimes].sort((a, b) => a - b)[5] };
  check(active === 17, '17 active clips on the big project', out.beat);
  check(out.beat.p50 <= 5, "rectsWithBounds({pixels:'selected'}) p50 ≤ 5 ms on 17×10", out.beat);

  // ---- render: first switch A to background stage (the role gate regulates roles, not which
  // instance)
  await page.evaluate(async (p) => { await window.__rpc.setProject(p, { reset: true }); }, small);
  const role = await page.evaluate(async () => ({ back: await window.__rpc.setRole('back', { job: 'probe' }), bake: await window.__rpc.setRole('back', { job: 'bake' }) }));
  check(role.back.ok === true && role.bake.ok === false && role.bake.reason === 'unsupported', 'setRole back ok / bake unsupported', role);
  const r1 = await page.evaluate(async () => {
    const t0 = performance.now();
    const r = await window.__rpc.render(2.0, { jump: true, maxCatchUp: Infinity });
    return { r, wall: performance.now() - t0 };
  });
  out.render = r1;
  check(r1.r && r1.r.remounted === true && Math.abs(r1.r.caughtUpAtSec - 2.0) < 1e-6 && r1.r.elapsedMs > 0 && r1.r.elapsedMs <= r1.wall + 1, 'render(jump) resolves after catch-up with remounted / caughtUpAtSec / elapsedMs', r1);
  const pair = await page.evaluate(async () => {
    const p1 = window.__rpc.render(1.0, { jump: true, maxCatchUp: Infinity });
    const p2 = window.__rpc.render(1.5, { jump: true, maxCatchUp: Infinity });
    return { a: await p1, b: await p2 };
  });
  out.pair = pair;
  check(pair.a && pair.a.aborted === true && pair.a.reason === 'superseded', 'first of two back-to-back renders is superseded', pair.a);
  check(pair.b && pair.b.remounted === true && Math.abs(pair.b.caughtUpAtSec - 1.5) < 1e-6, 'second render completes', pair.b);
  const proj = await page.evaluate(async (p) => {
    const p1 = window.__rpc.render(5.0, { jump: true, maxCatchUp: Infinity });
    await new Promise((r) => setTimeout(r, 5));
    await window.__rpc.setProject({ ...p, themeId: p.themeId }, { reset: true });
    return await p1;
  }, small);
  out.proj = proj;
  check(proj && proj.aborted === true && proj.reason === 'project', 'setProject during render aborts it with reason project', proj);
  // Resume push: no remount; going backward directly returns superseded
  const cont = await page.evaluate(async () => {
    await window.__rpc.render(1.0, { jump: true, maxCatchUp: Infinity });
    const fwd = await window.__rpc.render(1.2, { maxCatchUp: Infinity });
    const back = await window.__rpc.render(0.5, {});
    return { fwd, back };
  });
  out.cont = cont;
  check(cont.fwd && cont.fwd.remounted === false && Math.abs(cont.fwd.caughtUpAtSec - 1.2) < 1e-6, 'continue-mode render does not remount', cont.fwd);
  check(cont.back && cont.back.aborted === true && cont.back.reason === 'superseded', 'continue-mode render backwards is superseded', cont.back);
  // probe: one probe-frame per frame
  const probe = await page.evaluate(async () => {
    window.__events.length = 0;
    const r = await window.__rpc.render(0.5, { jump: true, probe: true, maxCatchUp: Infinity, maxFrames: 6 });
    const evs = window.__events.filter((e) => e.type === 'probe-frame');
    const controls = new Set(evs.map((e) => e.clipId)).size;
    return { r, n: evs.length, controls, sample: evs[0] };
  });
  out.probe = probe;
  check(probe.r && (probe.r.frames * probe.controls === probe.n) && probe.n > 0 && probe.sample.html > 0 && typeof probe.sample.localFrame === 'number', 'render(probe) posts one probe-frame per frame and reports frames', probe);
  check(!probe.r.aborted || probe.r.reason === 'timeout', 'probe render ends normally or by timeout', probe.r);
  const stp = await page.evaluate(async () => await window.__rpc.setTime(0.7, { probe: true }));
  check(stp && stp.path === 'set' && typeof stp.elapsedMs === 'number' && stp.elapsedMs > 0, 'setTime(probe) replies elapsedMs on the set path', stp);
  // Instance B should not receive any probe-frame: events only come from the iframe that initiated
  // them
  out.eventsB = await page.evaluate(() => window.__eventsB.filter((e) => e.type === 'probe-frame').length);
  check(out.eventsB === 0, 'probe-frame events come only from the iframe that produced them', out.eventsB);

  // ---- Response shapes of other methods
  const misc = await page.evaluate(async () => ({
    play: await window.__rpc.play(0), pause: await window.__rpc.pause(),
    snaps: await window.__rpc.setSnapshots({ 'c-odo': '<div>x</div>', 'c-pill': null }, { reset: true }),
    plan: await window.__rpc.setPlan({ plan: {}, costs: [] }), lh: await window.__rpc.setLocalHashes([]), sup: await window.__rpc.setSuppressed([]),
    front: await window.__rpc.setRole('front'),
  }));
  out.misc = misc;
  /*
   * PlayReply: `ok` is non-optional. **Both have real implementations after R5** (the tick loop of
   * K4), and the stage here is still `back` at this moment (A was switched to background stage
   * above), so:
   *   - `play` hits the role gate and returns `{ ok: false, reason: 'role' }`: only `front` runs
   *     ticks;
   *   - `pause` immediately returns `{ ok: true, stoppedAt: sec of the last tick }` when "the loop
   *     was already stopped"; not a single tick has run here, so `stoppedAt` is 0.
   */
  check(misc.play.ok === false && misc.play.reason === 'role', 'play on a back stage hits the role gate', misc.play);
  check(misc.pause.ok === true && misc.pause.stoppedAt === 0, 'pause on a stopped loop replies immediately with the last beat', misc.pause);
  check(misc.snaps.ok === true && misc.snaps.bytes === 12 && misc.plan.ok && misc.lh.ok && misc.sup.ok && misc.front.ok, 'misc replies', misc);
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
