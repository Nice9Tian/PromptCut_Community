/**
 * UI probe for clip speed (mobile app "Speed" entry, desktop edit section "Speed" field, preview
 * speed-changed clips without original audio, stage video playing at multiplier rate).
 * Environment matches `mobile-entries-probe.mjs`: local hosted suite + mock nginx proxy + online
 * build, without connecting to any remotes.
 *
 *   npx vite build --mode online
 *   node scripts/probes/clip-speed-ui-probe.mjs [--dist dist-online] [--out out/clip-speed-ui] [--base-port 5930] [--doc-port 5936] [--asset-port 5937]
 *
 * Assertions:
 *  P1 Mobile app: select video clip on timeline tab, sub-navigation bar has "Speed" (after "Mute",
 *     before "Adjust", same as demo);
 *  P2 Click "Speed" to open speed panel, stating "Original audio will not play after changing speed";
 *     click 2× → clip speed = 2, start point and media start point unchanged, duration halved;
 *  P3 Clip on full timeline is labeled "2× no original audio";
 *  P4 Preview audio layer: main document has this clip's <audio> before speed change, none after
 *     (speed-changed clip original audio does not play);
 *  P5 During playback, <video> playing this clip on stage has playbackRate ≈ 2 (within ±10%
 *     correction);
 *  P6 Undo one step reverts to 1×, deleting speed field (not speed: 1);
 *  D1 Desktop app (desktop layout of online page): select video clip, edit section has "Speed"
 *     field and the same description; select 0.5× → speed = 0.5, duration doubles without
 *     truncation, subsequent clips are pushed back with a notice; undoing one step reverts both
 *     speed and pushed clips;
 *  D2 Timeline clip name is suffixed with "· 0.5×", mute indicator notice states "Speed-changed clip
 *     does not play original audio".
 * The last line is a single JSON line.
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startMobileEnv, emptyProject, gateClear } from './lib/mobile-env.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 15 * 60_000).unref();
const argv = process.argv.slice(2);
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIST = path.resolve(arg('--dist', path.join(ROOT, 'dist-online')));
const OUT = path.resolve(arg('--out', path.join(ROOT, 'out', 'clip-speed-ui')));
fs.mkdirSync(OUT, { recursive: true });

const fails = [];
const out = { ok: false, out: OUT, steps: {} };
const step = (k, v) => { out.steps[k] = v; };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30_000, every = 250) {
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
const tap = async (page, sel) => { await gateClear(page); const r = await rect(page, sel); if (!r) throw new Error(`Cannot click ${sel}`); await page.touchscreen.tap(r.x + r.w / 2, r.y + r.h / 2); await sleep(400); };
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
const clipOf = (page, id) => store(page, 'return S.getState().project.tracks.flatMap((t) => t.clips).find((x) => x.id === args[0]) ?? null;', id);
/** Close all open panels (click "Close" on the panel header until none remain) */
const closeSheet = async (page) => {
  for (let i = 0; i < 5; i++) {
    const n = await page.evaluate(() => { const bs = [...document.querySelectorAll('.sheet-head button[aria-label="Close"]')]; bs.forEach((b) => b.click()); return bs.length; });
    if (!n) return;
    await sleep(500);
  }
};

const NAME = `cs-${Date.now().toString(36)}`;
const env = await startMobileEnv({
  dist: DIST, basePort: Number(arg('--base-port', 5930)), base2Port: 0,
  docPort: Number(arg('--doc-port', 5936)), assetPort: Number(arg('--asset-port', 5937)), name: NAME,
});
await env.seed({ ...emptyProject(NAME), name: NAME });
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--autoplay-policy=no-user-gesture-required'] });
let A, B;
try {
  A = await env.newPage(browser, 'phone');
  await env.enter(A, { username: 'yi' });
  await A.waitForSelector('[data-pcm="editor"]', { visible: true });

  /* ---------- Asset: 6-second video with audio ---------- */
  const mp4 = path.join(OUT, 'tone.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', mp4], { windowsHide: true });
  await tap(A, '[data-pcm="sub-video"]');
  await A.waitForSelector('[data-pcm="sheet-assets"]', { visible: true });
  await (await A.waitForSelector('[data-pcm="import-input"]')).uploadFile(mp4);
  const vid = await until('Video is in the media library and has a duration', () => store(A, 'const m = S.getState().project.media.find((x) => x.kind === "video"); return m && m.duration ? { id: m.id, duration: m.duration } : null;'), 120_000);
  await tap(A, `[data-pcm="asset"][data-media="${vid.id}"]`);
  await closeSheet(A);
  const placed = await until('Video clip placed on the timeline', () => store(A, 'return S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.mediaId === args[0]) ?? null;', vid.id));
  step('placed', placed && { id: placed.id, start: placed.start, end: placed.end, mediaOffset: placed.mediaOffset ?? 0 });

  /* ---------- P4 first half: main document has sound layer for this clip before speed change ---------- */
  await store(A, 'S.actions.seek(args[0]); return true;', placed.start + 1);
  const audioBefore = await until('Sound layer present before the speed change', async () => (await A.$(`audio[data-pc-audio-clip="${placed.id}"]`)) ? true : null, 20_000);
  step('P4-before', { audioLayer: !!audioBefore });

  /* ---------- P1 Selected on timeline tab → sub-navigation bar has "Speed" ---------- */
  await closeSheet(A);
  await tap(A, '[data-pcm="pg-timeline"]');
  await A.waitForSelector(`[data-pcm="clip"][data-id="${placed.id}"]`, { visible: true, timeout: 20_000 });
  // Click this clip on the timeline to select it (selection state is in store selection; select
  // directly if clicking misses)
  await tap(A, `[data-pcm="clip"][data-id="${placed.id}"]`);
  if (!(await A.$('[data-pcm="sub-speed"]'))) await store(A, 'S.actions.select([args[0]]); return true;', placed.id);
  await until('Clip tools appear in the sub-navigation bar', async () => (await A.$('[data-pcm="sub-speed"]')) ? true : null, 10_000);
  const tools = await A.$$eval('.subnav [data-pcm]', (bs) => bs.map((b) => b.dataset.pcm));
  await shot(A, 'P1-subnav');
  step('P1', { tools });
  check(tools.includes('sub-speed'), 'P1 after selecting the video clip, the sub-navigation bar has "Speed"', tools);
  check(tools.indexOf('sub-mute') < tools.indexOf('sub-speed') && tools.indexOf('sub-speed') < tools.indexOf('sub-adjust'), 'P1 order matches the prototype: mute, speed, adjust', tools);

  /* ---------- P2 Speed panel ---------- */
  // Click element directly (sub-navigation bar may happen to be reflowing when clicking by
  // coordinates, hitting other items)
  await closeSheet(A);
  await A.$eval('[data-pcm="sub-speed"]', (b) => b.click());
  await A.waitForSelector('[data-pcm="speed-presets"]', { visible: true, timeout: 10_000 });
  await sleep(700); // Click only after panel slide-in animation finishes
  const note = await A.$eval('[data-pcm="speed-note"]', (e) => e.textContent);
  const presets = await A.$$eval('[data-pcm="speed-preset"]', (bs) => bs.map((b) => [b.dataset.speed, b.getAttribute('aria-pressed')]));
  await shot(A, 'P2-sheet-before');
  check(/no original sound/.test(note ?? ''), 'P2 the panel states that speed-changed clips play no original sound', note);
  check(presets.some(([v, on]) => v === '1' && on === 'true'), 'P2 current 1× is highlighted', presets);
  await tap(A, '[data-pcm="speed-preset"][data-speed="2"]');
  const fast = await until('Clip becomes 2×', async () => { const c = await clipOf(A, placed.id); return c?.speed === 2 ? c : null; });
  await shot(A, 'P2-sheet-after');
  step('P2', { note, presets, after: fast && { start: fast.start, end: fast.end, mediaOffset: fast.mediaOffset ?? 0, speed: fast.speed } });
  check(!!fast && fast.start === placed.start && (fast.mediaOffset ?? 0) === (placed.mediaOffset ?? 0), 'P2 clip start and media start do not move', fast);
  check(!!fast && Math.abs((fast.end - fast.start) - (placed.end - placed.start) / 2) < 1e-6, 'P2 duration is halved', fast && [fast.start, fast.end]);
  // P2b Manual speed multiplier input: reject with notice outside 0.25-4, no change; 1.5 changes
  // normally (manual input allowed, user decision, 2026-10-23)
  const typeSpeed = async (v) => {
    await A.evaluate((x) => { const el = document.querySelector('[data-pcm="speed-input"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, x); el.dispatchEvent(new Event('input', { bubbles: true })); }, String(v));
    await tap(A, '[data-pcm="speed-apply"]');
    await sleep(500);
  };
  await typeSpeed(5);
  const toastBad = await A.evaluate(() => document.body.innerText.includes('0.25-4'));
  const afterBad = await clipOf(A, placed.id);
  await shot(A, 'P2b-input-rejected');
  await typeSpeed(1.5);
  const afterOk = await until('Manual input 1.5', async () => { const c = await clipOf(A, placed.id); return c?.speed === 1.5 ? c : null; }, 5000);
  step('P2b', { rejectedToast: toastBad, speedAfterBad: afterBad?.speed, speedAfterOk: afterOk?.speed, end: afterOk?.end });
  check(toastBad && afterBad?.speed === 2, 'P2b entering 5× is rejected with a message, speed unchanged', { toastBad, s: afterBad?.speed });
  check(!!afterOk && Math.abs(afterOk.end - (placed.start + (placed.end - placed.start) / 1.5)) < 1e-6, 'P2b entering 1.5 is applied', afterOk && [afterOk.start, afterOk.end]);
  await tap(A, '[data-pcm="speed-preset"][data-speed="2"]');
  await until('Back to 2×', async () => ((await clipOf(A, placed.id))?.speed === 2 ? true : null), 5000);
  await closeSheet(A);

  /* ---------- P3 Full timeline indicator ---------- */
  const badge = await A.$eval(`[data-pcm="clip"][data-id="${placed.id}"] [data-pcm="clip-speed"]`, (e) => e.textContent).catch(() => null);
  await shot(A, 'P3-timeline-badge');
  step('P3', { badge });
  check(/2×\s*no original sound/.test(badge ?? ''), 'P3 the full timeline shows "2× no original sound"', badge);

  /* ---------- P4 second half: no sound layer after speed change ---------- */
  await store(A, 'S.actions.seek(args[0]); return true;', placed.start + 0.8);
  await sleep(1500);
  const audioAfter = await A.$(`audio[data-pc-audio-clip="${placed.id}"]`);
  step('P4-after', { audioLayer: !!audioAfter });
  check(!!audioBefore && !audioAfter, 'P4 after a speed change the preview plays no original sound (the sound layer is gone)', { before: !!audioBefore, after: !!audioAfter });

  /* ---------- P5 Stage video plays at 2× during playback ---------- */
  // Wait until video is playing on stage (playback start has latency); **seek back to clip start and
  // replay once playhead leaves this clip**.
  // Previously it only sought back once every 12 iterations: after speeding up, this clip occupies
  // only "original duration ÷ multiplier" on the timeline; each iteration takes 200 ms plus
  // cross-frame evaluate, so 12 iterations easily miss the whole clip: this is why P5 occasionally
  // failed, and higher multipliers failed even more easily (observable window divided by the
  // multiplier). Changed to judge by actual playhead position.
  let rates = [];
  for (let k = 0; k < 60 && !rates.length; k++) {
    const inSeg = await store(A, 'const s = S.getState(); const c = s.project.tracks.flatMap((t) => t.clips).find((x) => x.id === args[0]); return !!c && s.playing && s.t >= c.start && s.t < c.end - 0.05;', placed.id).catch(() => false);
    if (!inSeg) { await store(A, 'const c = S.getState().project.tracks.flatMap((t) => t.clips).find((x) => x.id === args[0]); S.actions.pause(); S.actions.seek(c.start + 0.05); S.actions.play(); return true;', placed.id); }
    await sleep(200);
    for (const f of A.frames()) {
      const r = await f.evaluate(() => [...document.querySelectorAll('video')].filter((v) => !v.paused).map((v) => ({ rate: v.playbackRate, t: +v.currentTime.toFixed(2) }))).catch(() => []);
      if (r.length) rates.push({ url: f.url().slice(0, 60), r });
    }
  }
  await shot(A, 'P5-playing');
  const playState = await store(A, 'const s = S.getState(); return { playing: s.playing, t: s.t, front: document.querySelector("iframe[data-front], iframe.front")?.src?.slice(0, 60) ?? null };');
  const allVideos = [];
  for (const f of A.frames()) {
    const r = await f.evaluate(() => [...document.querySelectorAll('video')].map((v) => ({ paused: v.paused, rate: v.playbackRate, t: +v.currentTime.toFixed(2), src: (v.currentSrc || '').slice(-24) }))).catch((e) => [{ err: String(e).slice(0, 80) }]);
    allVideos.push({ url: f.url().slice(0, 70), r });
  }
  await store(A, 'S.actions.pause(); return true;');
  step('P5', { rates, playState, allVideos });
  // Criterion is based on **rate**, not whether it is paused at sampling time: stage video follows
  // frames in a start-and-stop manner (paused after seeking each frame); if only checking "not paused
  // at this moment", sampling right at a pause returns empty-handed: this was precisely why P5
  // previously failed intermittently.
  // Tested on 2026-10-23: during that failure, stage video playbackRate = 1.9457 (≈2×, 1.9-2.2 is ±10%
  // correction range); product side is fine.
  const playing = rates.flatMap((x) => x.r);
  const anyRate = allVideos.flatMap((x) => (Array.isArray(x.r) ? x.r : [])).filter((v) => typeof v.rate === 'number' && v.rate >= 1.8 && v.rate <= 2.2);
  check(playing.length > 0 ? playing.every((v) => v.rate >= 1.8 && v.rate <= 2.2) : anyRate.length > 0,
    'P5 the video of the speed-changed clip plays at 2× on the stage (±10%)', { rates, anyRate });

  /* ---------- P6 Undo: one step reverts one change; reverting fully returns to 1×, leaving no speed field ---------- */
  // Speed was changed three times before this: 1→2 (P2), 2→1.5, 1.5→2 (P2b; entering 5 was rejected,
  // not counted as a step)
  await store(A, 'S.actions.undo(); return true;');
  const undo1 = await clipOf(A, placed.id);
  await store(A, 'S.actions.undo(); S.actions.undo(); return true;');
  const undone = await clipOf(A, placed.id);
  step('P6', { afterOneUndo: undo1 && [undo1.speed, undo1.end], speedField: undone && 'speed' in undone, end: undone?.end });
  check(undo1?.speed === 1.5 && Math.abs(undo1.end - 4) < 1e-6, 'P6 one undo step goes back only to the previous change (1.5×)', undo1 && [undo1.speed, undo1.end]);
  check(!!undone && !('speed' in undone) && undone.end === placed.end, 'P6 undoing all the way returns to 1×, leaving no speed field', undone);

  /* ---------- P7 Change speed with attached transition: transition shortens when it does not fit,
     popping up a bubble to explain (user decision, 2026-10-23) ---------- */
  const added = await store(A, 'return S.actions.addTransition({ kind: "fadeOut", clipId: args[0], dur: 2.5 }).ok;', placed.id);
  await store(A, 'S.actions.select([args[0]]); return true;', placed.id);
  await until('Sub-navigation bar has Speed', async () => (await A.$('[data-pcm="sub-speed"]')) ? true : null, 10_000);
  await closeSheet(A);
  await A.$eval('[data-pcm="sub-speed"]', (b) => b.click());
  await A.waitForSelector('[data-pcm="speed-presets"]', { visible: true, timeout: 10_000 });
  await sleep(700);
  await tap(A, '[data-pcm="speed-preset"][data-speed="4"]');
  const bubble = await until('Bubble about the shortened transition', () => A.evaluate(() => { const t = document.body.innerText; const i = t.indexOf('Fade-out shortens too'); return i >= 0 ? t.slice(Math.max(0, i - 30), i + 60) : null; }), 5000);
  await shot(A, 'P7-transition-bubble');
  const fast4 = await clipOf(A, placed.id);
  const fadeTr = await store(A, 'return (S.getState().project.transitions || []).find((t) => t.aId === args[0] && t.kind === "fadeOut") ?? null;', placed.id);
  step('P7', { added, bubble, clip: fast4 && { start: fast4.start, end: fast4.end, fadeOut: fast4.fadeOut, speed: fast4.speed }, transitionDur: fadeTr?.dur });
  check(added && fast4?.speed === 4, 'P7 speed can still be changed with a fade-out attached', { added, s: fast4?.speed });
  check(/2\.50 s → 1\.49 s/.test(bubble ?? ''), 'P7 the bubble states the fade-out shrinks from 2.50 s to 1.49 s', bubble);
  check(fadeTr?.dur === 1.49 && fast4?.fadeOut === 1.49, 'P7 the transition record and the clip fade-out both change to 1.49', { tr: fadeTr?.dur, f: fast4?.fadeOut });
  await closeSheet(A);
  await store(A, 'S.actions.undo(); S.actions.undo(); return true;');

  /* ---------- D1 / D2 Desktop layout ---------- */
  B = await env.newPage(browser, 'desktop');
  await env.enter(B, { username: 'er' });
  await until('Desktop page synced to the video clip', () => clipOf(B, placed.id), 60_000);
  await store(B, 'S.actions.select([args[0]]); return true;', placed.id);
  await sleep(1500);
  // Switch left rail to "Edit" section
  await B.evaluate(() => { const b = [...document.querySelectorAll('[data-pc="left-rail"] button, [data-pc="left-rail"] [role="tab"]')].find((x) => x.textContent.trim() === 'Edit'); b?.click(); });
  await sleep(800);
  await shot(B, 'D0-selected');
  step('D0', { leftTabs: await B.$$eval('[data-pc]', (es) => es.map((e) => e.dataset.pc).filter((x) => /tab|section|left/i.test(x)).slice(0, 30)) });
  const form = await until('Speed row appears in the edit section', async () => (await B.$('[data-pc="clip-speed"]')) ? true : null, 20_000);
  if (form) {
    const dnote = await B.$eval('[data-pc="clip-speed-note"]', (e) => e.textContent);
    // Manual input out of range: reject with notice
    await B.evaluate(() => { const el = document.querySelector('[data-pc="clip-speed-input"]'); el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '9'); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); });
    await sleep(600);
    const dBadMsg = await B.$eval('[data-pc="clip-speed-msg"]', (e) => e.textContent).catch(() => null);
    const dBad = await clipOf(B, placed.id);
    step('D1-input', { msg: dBadMsg, speed: dBad?.speed ?? 1 });
    check(/0\.25-4/.test(dBadMsg ?? '') && (dBad?.speed ?? 1) === 1, 'D1 entering 9× manually on desktop is rejected with a message', { dBadMsg, s: dBad?.speed });
    await B.select('[data-pc="clip-speed-select"]', '0.5');
    const slow = await until('Desktop changed to 0.5×', async () => { const c = await clipOf(B, placed.id); return c?.speed === 0.5 ? c : null; });
    await sleep(800);
    await shot(B, 'D1-inspector');
    const label = await B.$eval(`[data-pc-clip-speed]`, (e) => e.textContent).catch(() => null);
    const badgeTitle = await B.$eval('[data-pc="clip-muted"]', (e) => e.getAttribute('title')).catch(() => null);
    await shot(B, 'D2-timeline');
    step('D1', { note: dnote, after: slow && { start: slow.start, end: slow.end, speed: slow.speed } });
    step('D2', { label, badgeTitle });
    check(/no original sound/.test(dnote ?? ''), 'D1 the desktop edit section states that speed-changed clips play no original sound', dnote);
    // 0.5× requires 2× duration without truncation; subsequent clips on the same track are pushed back
    // as a whole upon collision (user decision, 2026-10-23), with the panel explaining how much was pushed
    const nextId = await store(B, 'const t = S.getState().project.tracks.find((tr) => tr.clips.some((c) => c.id === args[0])); const n = t.clips.filter((c) => c.id !== args[0] && c.start >= args[1] - 1e-9).sort((x, y) => x.start - y.start)[0]; return n ? n.id : null;', placed.id, placed.end);
    const nextAfter = nextId ? await clipOf(B, nextId) : null;
    const pushMsg = await B.$eval('[data-pc="clip-speed-msg"]', (e) => e.textContent).catch(() => null);
    step('D1-push', { nextId, nextAfter: nextAfter && [nextAfter.start, nextAfter.end], pushMsg });
    check(!!slow && Math.abs((slow.end - slow.start) - (placed.end - placed.start) * 2) < 1e-6, 'D1 0.5× doubles the duration (no truncation)', slow && [slow.start, slow.end]);
    if (nextAfter) {
      check(nextAfter.start >= slow.end - 1e-6, 'D1 the following clips are pushed back, no overlap', [slow.end, nextAfter.start]);
      check(/pushed back/.test(pushMsg ?? ''), 'D1 the panel explains when later clips are pushed back', pushMsg);
    }
    // One-step undo: speed and pushed clips revert together
    await store(B, 'S.actions.undo(); return true;');
    const backV = await clipOf(B, placed.id), backN = nextId ? await clipOf(B, nextId) : null;
    step('D1-undo', { v: backV && [backV.start, backV.end, backV.speed ?? null], next: backN && [backN.start, backN.end] });
    check(!!backV && backV.speed === undefined && backV.end === placed.end, 'D1 one undo step returns to the original speed', backV);
    if (nextAfter) check(!!backN && backN.start < nextAfter.start, 'D1 one undo step also restores the clips that were pushed', backN && [backN.start, nextAfter.start]);
    await store(B, 'S.actions.redo(); return true;');
    await sleep(800);
    check(/0\.5×/.test(label ?? ''), 'D2 the timeline clip name carries "0.5×"', label);
    check(/Speed-changed clips play no original sound/.test(badgeTitle ?? ''), 'D2 the mute badge states the reason', badgeTitle);
    // Mobile page syncs to the same speed
    const synced = await until('Mobile page synced to 0.5×', async () => { const c = await clipOf(A, placed.id); return c?.speed === 0.5 ? true : null; }, 30_000);
    step('D-sync', { phoneSeesHalf: !!synced });
  }
  step('errors', { phone: A.errors.slice(0, 5), desktop: B.errors.slice(0, 5) });
  check(!A.errors.length && !B.errors.length, 'Page has no uncaught exceptions', { A: A.errors.slice(0, 3), B: B.errors.slice(0, 3) });
} catch (error) {
  fails.push(String(error?.stack || error));
  if (A) await shot(A, 'ERR-phone');
  if (B) await shot(B, 'ERR-desktop');
} finally {
  await browser.close().catch(() => {});
  await env.close().catch(() => {});
}
out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
