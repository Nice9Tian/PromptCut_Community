/**
 * 片段速度的界面探针(手机版「速度」入口、桌面编辑分区的「速度」一栏、预览里变速段不出原声、舞台视频按倍率放)。
 * 环境同 `mobile-entries-probe.mjs`:本机托管组合 + 仿 nginx 代理 + 在线构建,不连任何远端。
 *
 *   npx vite build --mode online
 *   node scripts/probes/clip-speed-ui-probe.mjs [--dist dist-online] [--out out/clip-speed-ui] [--base-port 5930] [--doc-port 5936] [--asset-port 5937]
 *
 * 断言:
 *  P1 手机版:时间轴分页选中视频段,子导航栏有「速度」(在「静音」之后、「调整」之前,同演示稿);
 *  P2 点「速度」打开速度面板,写明「变速后这一段不出原声」;点 2× → 片段 speed = 2、起点与素材起点不动、时长减半;
 *  P3 完整时间轴上这一段标出「2× 无原声」;
 *  P4 预览的声音层:变速前主文档里有这一段的 <audio>,变速后没有(变速段原声不出);
 *  P5 播放中舞台里放这一段的 <video> 的 playbackRate ≈ 2(纠偏 ±10% 以内);
 *  P6 撤销一步回到 1×,speed 字段删掉(不是 speed: 1);
 *  D1 桌面版(在线页面的桌面布局):选中视频段,编辑分区有「速度」一栏和同一句说明;选 0.5× → speed = 0.5、时长翻倍不截断,
 *     后面的段被推开并有说明;撤销一步速度和被推开的段一起退回;
 *  D2 时间轴片段名后带「· 0.5×」,静音标记的说明写明「变速段不出原声」。
 * 最后一行是一行 JSON。
 */
import puppeteer from 'puppeteer';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startMobileEnv, emptyProject } from './lib/mobile-env.mjs';

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
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}`); return null; }
    await sleep(every);
  }
}
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) }).catch(() => {});
const rect = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) return null; e.scrollIntoView({ block: 'nearest', inline: 'nearest' }); const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, sel);
const tap = async (page, sel) => { const r = await rect(page, sel); if (!r) throw new Error(`点不到 ${sel}`); await page.touchscreen.tap(r.x + r.w / 2, r.y + r.h / 2); await sleep(400); };
const store = (page, src, ...a) => page.evaluate((s, a2) => new Function('S', 'args', s)(window.__pcStore, a2), src, a);
const clipOf = (page, id) => store(page, 'return S.getState().project.tracks.flatMap((t) => t.clips).find((x) => x.id === args[0]) ?? null;', id);
/** 关掉所有打开着的面板(点面板头的「关闭」,点到没有为止) */
const closeSheet = async (page) => {
  for (let i = 0; i < 5; i++) {
    const n = await page.evaluate(() => { const bs = [...document.querySelectorAll('.sheet-head button[aria-label="关闭"]')]; bs.forEach((b) => b.click()); return bs.length; });
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

  /* ---------- 素材:6 秒带声音的视频 ---------- */
  const mp4 = path.join(OUT, 'tone.mp4');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '30', '-c:a', 'aac', '-shortest', '-movflags', '+faststart', mp4], { windowsHide: true });
  await tap(A, '[data-pcm="sub-video"]');
  await A.waitForSelector('[data-pcm="sheet-assets"]', { visible: true });
  await (await A.waitForSelector('[data-pcm="import-input"]')).uploadFile(mp4);
  const vid = await until('视频进素材库且有时长', () => store(A, 'const m = S.getState().project.media.find((x) => x.kind === "video"); return m && m.duration ? { id: m.id, duration: m.duration } : null;'), 120_000);
  await tap(A, `[data-pcm="asset"][data-media="${vid.id}"]`);
  await closeSheet(A);
  const placed = await until('视频段放上时间轴', () => store(A, 'return S.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.mediaId === args[0]) ?? null;', vid.id));
  step('placed', placed && { id: placed.id, start: placed.start, end: placed.end, mediaOffset: placed.mediaOffset ?? 0 });

  /* ---------- P4 前半:变速前主文档里有这一段的声音层 ---------- */
  await store(A, 'S.actions.seek(args[0]); return true;', placed.start + 1);
  const audioBefore = await until('变速前声音层在', async () => (await A.$(`audio[data-pc-audio-clip="${placed.id}"]`)) ? true : null, 20_000);
  step('P4-before', { audioLayer: !!audioBefore });

  /* ---------- P1 时间轴分页选中 → 子导航栏有「速度」 ---------- */
  await closeSheet(A);
  await tap(A, '[data-pcm="pg-timeline"]');
  await A.waitForSelector(`[data-pcm="clip"][data-id="${placed.id}"]`, { visible: true, timeout: 20_000 });
  // 点时间轴上的这一段选中它(选中态在 store 的 selection 里;点不中就直接选)
  await tap(A, `[data-pcm="clip"][data-id="${placed.id}"]`);
  if (!(await A.$('[data-pcm="sub-speed"]'))) await store(A, 'S.actions.select([args[0]]); return true;', placed.id);
  await until('子导航栏出现片段工具', async () => (await A.$('[data-pcm="sub-speed"]')) ? true : null, 10_000);
  const tools = await A.$$eval('.subnav [data-pcm]', (bs) => bs.map((b) => b.dataset.pcm));
  await shot(A, 'P1-subnav');
  step('P1', { tools });
  check(tools.includes('sub-speed'), 'P1 选中视频段后子导航栏有「速度」', tools);
  check(tools.indexOf('sub-mute') < tools.indexOf('sub-speed') && tools.indexOf('sub-speed') < tools.indexOf('sub-adjust'), 'P1 顺序同演示稿:静音、速度、调整', tools);

  /* ---------- P2 速度面板 ---------- */
  // 直接点元素(按坐标点时子导航栏可能刚好在重排,会点到别的项)
  await closeSheet(A);
  await A.$eval('[data-pcm="sub-speed"]', (b) => b.click());
  await A.waitForSelector('[data-pcm="speed-presets"]', { visible: true, timeout: 10_000 });
  await sleep(700); // 面板滑入动画走完再点
  const note = await A.$eval('[data-pcm="speed-note"]', (e) => e.textContent);
  const presets = await A.$$eval('[data-pcm="speed-preset"]', (bs) => bs.map((b) => [b.dataset.speed, b.getAttribute('aria-pressed')]));
  await shot(A, 'P2-sheet-before');
  check(/不出原声/.test(note ?? ''), 'P2 面板写明变速段不出原声', note);
  check(presets.some(([v, on]) => v === '1' && on === 'true'), 'P2 当前 1× 高亮', presets);
  await tap(A, '[data-pcm="speed-preset"][data-speed="2"]');
  const fast = await until('片段变成 2×', async () => { const c = await clipOf(A, placed.id); return c?.speed === 2 ? c : null; });
  await shot(A, 'P2-sheet-after');
  step('P2', { note, presets, after: fast && { start: fast.start, end: fast.end, mediaOffset: fast.mediaOffset ?? 0, speed: fast.speed } });
  check(!!fast && fast.start === placed.start && (fast.mediaOffset ?? 0) === (placed.mediaOffset ?? 0), 'P2 起点与素材起点不动', fast);
  check(!!fast && Math.abs((fast.end - fast.start) - (placed.end - placed.start) / 2) < 1e-6, 'P2 时长减半', fast && [fast.start, fast.end]);
  // P2b 手动输入倍率:超出 0.25～4 拒绝并提示、不改;1.5 照改(用户 2026-10-23 定可以手动输入)
  const typeSpeed = async (v) => {
    await A.evaluate((x) => { const el = document.querySelector('[data-pcm="speed-input"]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, x); el.dispatchEvent(new Event('input', { bubbles: true })); }, String(v));
    await tap(A, '[data-pcm="speed-apply"]');
    await sleep(500);
  };
  await typeSpeed(5);
  const toastBad = await A.evaluate(() => document.body.innerText.includes('0.25～4'));
  const afterBad = await clipOf(A, placed.id);
  await shot(A, 'P2b-input-rejected');
  await typeSpeed(1.5);
  const afterOk = await until('手动输入 1.5', async () => { const c = await clipOf(A, placed.id); return c?.speed === 1.5 ? c : null; }, 5000);
  step('P2b', { rejectedToast: toastBad, speedAfterBad: afterBad?.speed, speedAfterOk: afterOk?.speed, end: afterOk?.end });
  check(toastBad && afterBad?.speed === 2, 'P2b 输入 5 倍被拒绝并提示,速度不变', { toastBad, s: afterBad?.speed });
  check(!!afterOk && Math.abs(afterOk.end - (placed.start + (placed.end - placed.start) / 1.5)) < 1e-6, 'P2b 输入 1.5 照改', afterOk && [afterOk.start, afterOk.end]);
  await tap(A, '[data-pcm="speed-preset"][data-speed="2"]');
  await until('回到 2×', async () => ((await clipOf(A, placed.id))?.speed === 2 ? true : null), 5000);
  await closeSheet(A);

  /* ---------- P3 完整时间轴的标记 ---------- */
  const badge = await A.$eval(`[data-pcm="clip"][data-id="${placed.id}"] [data-pcm="clip-speed"]`, (e) => e.textContent).catch(() => null);
  await shot(A, 'P3-timeline-badge');
  step('P3', { badge });
  check(/2×\s*无原声/.test(badge ?? ''), 'P3 完整时间轴上标出「2× 无原声」', badge);

  /* ---------- P4 后半:变速后没有声音层 ---------- */
  await store(A, 'S.actions.seek(args[0]); return true;', placed.start + 0.8);
  await sleep(1500);
  const audioAfter = await A.$(`audio[data-pc-audio-clip="${placed.id}"]`);
  step('P4-after', { audioLayer: !!audioAfter });
  check(!!audioBefore && !audioAfter, 'P4 变速后预览不出原声(声音层没了)', { before: !!audioBefore, after: !!audioAfter });

  /* ---------- P5 播放中舞台视频按 2 倍放 ---------- */
  // 等到舞台里有视频在放(起播有延迟);**播放头跑出这一段就回到段首重放**。
  // 原先每 12 次迭代才回 seek 一次:提速之后这一段在时间轴上只占「原时长 ÷ 倍率」,
  // 一次迭代要 200 ms 加上跨 frame 的 evaluate,12 次很容易整段错过 —— P5 偶发翻就是这么来的,
  // 而且偏偏倍率越大越容易翻(可观察窗口被倍率除了一次)。改成按播放头实际位置判。
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
  // 判据按**速率**，不按取样那一刻停没停:舞台的视频是走走停停地跟帧(每帧 seek 后暂停),
  // 只统计「此刻没暂停」的话，取样撞上暂停的那一刻就空手而归 —— 这正是 P5 以前偶发翻的原因。
  // 2026-10-23 实测：翻的那一次舞台视频 playbackRate = 1.9457(≈2×，1.9～2.2 是 ±10% 的纠偏范围)，产品侧没问题。
  const playing = rates.flatMap((x) => x.r);
  const anyRate = allVideos.flatMap((x) => (Array.isArray(x.r) ? x.r : [])).filter((v) => typeof v.rate === 'number' && v.rate >= 1.8 && v.rate <= 2.2);
  check(playing.length > 0 ? playing.every((v) => v.rate >= 1.8 && v.rate <= 2.2) : anyRate.length > 0,
    'P5 舞台里变速段的视频按 2 倍(±10%)', { rates, anyRate });

  /* ---------- P6 撤销:一步只退一次改动;退到底回到 1×、不留 speed 字段 ---------- */
  // 这之前改过三次速度:1→2(P2)、2→1.5、1.5→2(P2b;输入 5 被拒绝,不算一步)
  await store(A, 'S.actions.undo(); return true;');
  const undo1 = await clipOf(A, placed.id);
  await store(A, 'S.actions.undo(); S.actions.undo(); return true;');
  const undone = await clipOf(A, placed.id);
  step('P6', { afterOneUndo: undo1 && [undo1.speed, undo1.end], speedField: undone && 'speed' in undone, end: undone?.end });
  check(undo1?.speed === 1.5 && Math.abs(undo1.end - 4) < 1e-6, 'P6 撤销一步只退回上一次(1.5×)', undo1 && [undo1.speed, undo1.end]);
  check(!!undone && !('speed' in undone) && undone.end === placed.end, 'P6 退到底回到 1×、不留 speed 字段', undone);

  /* ---------- P7 挂着转场改速度:装不下时转场跟着缩短,弹气泡说清楚(用户 2026-10-23 定) ---------- */
  const added = await store(A, 'return S.actions.addTransition({ kind: "fadeOut", clipId: args[0], dur: 2.5 }).ok;', placed.id);
  await store(A, 'S.actions.select([args[0]]); return true;', placed.id);
  await until('子导航栏有速度', async () => (await A.$('[data-pcm="sub-speed"]')) ? true : null, 10_000);
  await closeSheet(A);
  await A.$eval('[data-pcm="sub-speed"]', (b) => b.click());
  await A.waitForSelector('[data-pcm="speed-presets"]', { visible: true, timeout: 10_000 });
  await sleep(700);
  await tap(A, '[data-pcm="speed-preset"][data-speed="4"]');
  const bubble = await until('转场缩短的气泡', () => A.evaluate(() => { const t = document.body.innerText; const i = t.indexOf('淡出跟着缩短'); return i >= 0 ? t.slice(Math.max(0, i - 30), i + 60) : null; }), 5000);
  await shot(A, 'P7-transition-bubble');
  const fast4 = await clipOf(A, placed.id);
  const fadeTr = await store(A, 'return (S.getState().project.transitions || []).find((t) => t.aId === args[0] && t.kind === "fadeOut") ?? null;', placed.id);
  step('P7', { added, bubble, clip: fast4 && { start: fast4.start, end: fast4.end, fadeOut: fast4.fadeOut, speed: fast4.speed }, transitionDur: fadeTr?.dur });
  check(added && fast4?.speed === 4, 'P7 挂着淡出也能改速度', { added, s: fast4?.speed });
  check(/2\.50 秒 → 1\.49 秒/.test(bubble ?? ''), 'P7 气泡写明淡出从 2.50 秒缩到 1.49 秒', bubble);
  check(fadeTr?.dur === 1.49 && fast4?.fadeOut === 1.49, 'P7 转场记录与片段淡出都改成 1.49', { tr: fadeTr?.dur, f: fast4?.fadeOut });
  await closeSheet(A);
  await store(A, 'S.actions.undo(); S.actions.undo(); return true;');

  /* ---------- D1 / D2 桌面布局 ---------- */
  B = await env.newPage(browser, 'desktop');
  await env.enter(B, { username: 'er' });
  await until('桌面页同步到视频段', () => clipOf(B, placed.id), 60_000);
  await store(B, 'S.actions.select([args[0]]); return true;', placed.id);
  await sleep(1500);
  // 左栏切到「编辑」分区
  await B.evaluate(() => { const b = [...document.querySelectorAll('[data-pc="left-rail"] button, [data-pc="left-rail"] [role="tab"]')].find((x) => x.textContent.trim() === '编辑'); b?.click(); });
  await sleep(800);
  await shot(B, 'D0-selected');
  step('D0', { leftTabs: await B.$$eval('[data-pc]', (es) => es.map((e) => e.dataset.pc).filter((x) => /tab|section|left/i.test(x)).slice(0, 30)) });
  const form = await until('编辑分区出现速度一栏', async () => (await B.$('[data-pc="clip-speed"]')) ? true : null, 20_000);
  if (form) {
    const dnote = await B.$eval('[data-pc="clip-speed-note"]', (e) => e.textContent);
    // 手动输入超出范围:拒绝并提示
    await B.evaluate(() => { const el = document.querySelector('[data-pc="clip-speed-input"]'); el.focus(); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, '9'); el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); });
    await sleep(600);
    const dBadMsg = await B.$eval('[data-pc="clip-speed-msg"]', (e) => e.textContent).catch(() => null);
    const dBad = await clipOf(B, placed.id);
    step('D1-input', { msg: dBadMsg, speed: dBad?.speed ?? 1 });
    check(/0\.25～4/.test(dBadMsg ?? '') && (dBad?.speed ?? 1) === 1, 'D1 桌面手动输入 9 倍被拒绝并提示', { dBadMsg, s: dBad?.speed });
    await B.select('[data-pc="clip-speed-select"]', '0.5');
    const slow = await until('桌面改成 0.5×', async () => { const c = await clipOf(B, placed.id); return c?.speed === 0.5 ? c : null; });
    await sleep(800);
    await shot(B, 'D1-inspector');
    const label = await B.$eval(`[data-pc-clip-speed]`, (e) => e.textContent).catch(() => null);
    const badgeTitle = await B.$eval('[data-pc="clip-muted"]', (e) => e.getAttribute('title')).catch(() => null);
    await shot(B, 'D2-timeline');
    step('D1', { note: dnote, after: slow && { start: slow.start, end: slow.end, speed: slow.speed } });
    step('D2', { label, badgeTitle });
    check(/不出原声/.test(dnote ?? ''), 'D1 桌面编辑分区写明变速段不出原声', dnote);
    // 0.5× 要 2 倍时长,不截断;同一序列后面的段碰到了就整体往后推(用户 2026-10-23 定),面板说清推了多少
    const nextId = await store(B, 'const t = S.getState().project.tracks.find((tr) => tr.clips.some((c) => c.id === args[0])); const n = t.clips.filter((c) => c.id !== args[0] && c.start >= args[1] - 1e-9).sort((x, y) => x.start - y.start)[0]; return n ? n.id : null;', placed.id, placed.end);
    const nextAfter = nextId ? await clipOf(B, nextId) : null;
    const pushMsg = await B.$eval('[data-pc="clip-speed-msg"]', (e) => e.textContent).catch(() => null);
    step('D1-push', { nextId, nextAfter: nextAfter && [nextAfter.start, nextAfter.end], pushMsg });
    check(!!slow && Math.abs((slow.end - slow.start) - (placed.end - placed.start) * 2) < 1e-6, 'D1 0.5× 时长翻倍(不截断)', slow && [slow.start, slow.end]);
    if (nextAfter) {
      check(nextAfter.start >= slow.end - 1e-6, 'D1 后面的段被推开、不重叠', [slow.end, nextAfter.start]);
      check(/往后推了/.test(pushMsg ?? ''), 'D1 推开时面板说明', pushMsg);
    }
    // 一步撤销:速度和推开的段一起退回
    await store(B, 'S.actions.undo(); return true;');
    const backV = await clipOf(B, placed.id), backN = nextId ? await clipOf(B, nextId) : null;
    step('D1-undo', { v: backV && [backV.start, backV.end, backV.speed ?? null], next: backN && [backN.start, backN.end] });
    check(!!backV && backV.speed === undefined && backV.end === placed.end, 'D1 撤销一步回到原速', backV);
    if (nextAfter) check(!!backN && backN.start < nextAfter.start, 'D1 撤销一步,推开的段也退回', backN && [backN.start, nextAfter.start]);
    await store(B, 'S.actions.redo(); return true;');
    await sleep(800);
    check(/0\.5×/.test(label ?? ''), 'D2 时间轴片段名带「0.5×」', label);
    check(/变速段不出原声/.test(badgeTitle ?? ''), 'D2 静音标记写明原因', badgeTitle);
    // 手机页同步到同一个速度
    const synced = await until('手机页同步到 0.5×', async () => { const c = await clipOf(A, placed.id); return c?.speed === 0.5 ? true : null; }, 30_000);
    step('D-sync', { phoneSeesHalf: !!synced });
  }
  step('errors', { phone: A.errors.slice(0, 5), desktop: B.errors.slice(0, 5) });
  check(!A.errors.length && !B.errors.length, '页面没有未捕获的异常', { A: A.errors.slice(0, 3), B: B.errors.slice(0, 3) });
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
