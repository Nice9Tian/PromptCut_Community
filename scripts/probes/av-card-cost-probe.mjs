/**
 * 有声动效卡(画面是组件、另写了 `audio()`,如 `av-pulse`)的画面成本身份:自动、即时补测,不默认判重(2026-10-06 用户定)。
 * 桌面一侧的真实浏览器探针,全程在本机:本探针自己起的 dev server,不连任何托管端,不向扬声器出声(Chrome 无头、`--mute-audio`)。
 *
 * 两种用法:
 *
 *   # 1. 跑一遍:摆项目(或载入另一趟留下的项目)→ 等测量 → 核对 → 从编辑器页面的导出入口导出成片
 *   node scripts/probes/av-card-cost-probe.mjs run --out <目录> [--kind av|plain] [--project <另一趟的 project.json>]
 *        [--tree <仓库根,缺省本仓库>] [--port 5720] [--expect light|legacy]
 *
 *   # 2. 两趟的成片逐帧比(ffmpeg 解成原始像素,逐帧 sha256)
 *   node scripts/probes/av-card-cost-probe.mjs compare --a <目录甲> --b <目录乙>
 *
 * `--tree` 指到另一份检出(改前的提交)就能在那份代码上跑同一个项目,再用 `compare` 比两边的成片。
 * 端口:dev server 占 `--port` 起连号三个(编辑器页加两个舞台)。数据目录都在 `--out` 下。
 *
 * 验收标准(每项一行 `{ check, ok }`,最后一行 `{ summary }`,有失败退出码 1):
 *
 * `run --kind av --expect light`(改后的代码):
 *   V1 有声动效卡的片段有成本身份、有声明的帧模式;
 *   V2 第一次出现就测:测量日志里有它,成本记录按它的身份键写进去了;
 *   V3 测量期间不出声:从打开页面到测完,没有新建音频上下文、没有元素开始播放、没有声源启动;
 *   V4 测完判轻:分派表里它在自己的位置上是轻、不在预渲染集合里;
 *   V5 活渲:播放到它的位置时它不在被抑制的集合里,舞台上它的包裹层里是活组件,没有显示占位符,
 *      页面上没有「需要本地 PC 渲染辅助」;
 *   V6 重开不重测:刷新页面、载入同一个项目,测量日志里没有它;
 *   V7 导出成功,成片文件在。
 * `run --expect legacy`(改前的代码,只为留下对照,不算验收):记下有声动效卡有没有身份、判轻还是判重。
 * `run --kind plain`:不含有声动效卡的项目,只做导出(V7)。
 * `compare`:
 *   C1 两边每个成片文件帧数相同、逐帧 sha256 相同。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { findFfmpeg } from '../../server/bakery/ffmpeg.mjs';

const argv = process.argv.slice(2);
const MODE = argv[0];
const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const results = [];
const check = (name, ok, detail = {}) => { results.push({ check: name, ok: !!ok }); console.log(JSON.stringify({ check: name, ok: !!ok, detail }).slice(0, 2400)); return !!ok; };
const note = (name, detail = {}) => console.log(JSON.stringify({ note: name, detail }).slice(0, 2400));
const log = (...a) => console.error('[av-card-cost]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 60_000, every = 200) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    let v = null;
    try { v = await fn(); } catch (e) { last = String(e?.message ?? e); }
    if (v) return v;
    if (Date.now() - t0 > ms) { check(`等到:${what}`, false, { last }); return null; }
    await sleep(every);
  }
}

const cleanups = [];
let exitCode = 1;
try {
  if (MODE === 'run') await run();
  else if (MODE === 'compare') await compare();
  else throw new Error('用法见文件头:run 或 compare');
  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ summary: { mode: MODE, checks: results.length, passed: results.length - failed.length, fails: failed.map((r) => r.check) } }));
  exitCode = failed.length ? 1 : 0;
} catch (e) {
  console.log(JSON.stringify({ summary: { mode: MODE, checks: results.length, error: String(e?.stack ?? e).slice(0, 1500), fails: results.filter((r) => !r.ok).map((r) => r.check) } }));
} finally {
  for (const fn of cleanups.reverse()) { try { await fn(); } catch { /* 尽力清 */ } }
}
process.exit(exitCode);

/* ================================================================== run */

/** 页面里任何可能出声的动作都记一笔(同 `sound-ab-probe.mjs`) */
function AUDIO_HOOK() {
  if (window.__pcAudioLog) return;
  const logged = (window.__pcAudioLog = []);
  const mark = (kind) => logged.push({ kind, at: Math.round(performance.now()) });
  for (const name of ['AudioContext', 'OfflineAudioContext']) {
    const Original = window[name];
    if (!Original) continue;
    window[name] = new Proxy(Original, { construct(target, args, newTarget) { mark(name); return Reflect.construct(target, args, newTarget); } });
  }
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) { mark('play'); return play.apply(this, a); };
  if (window.AudioScheduledSourceNode) {
    const start = AudioScheduledSourceNode.prototype.start;
    AudioScheduledSourceNode.prototype.start = function (...a) { mark('sourceStart'); return start.apply(this, a); };
  }
}

async function run() {
  const TREE = path.resolve(arg('--tree', ROOT));
  const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-av-card-cost-${Date.now().toString(36)}${randomBytes(2).toString('hex')}`)));
  const KIND = arg('--kind', 'av');
  const EXPECT = arg('--expect', 'light');
  const PORT = Number(arg('--port', 5720));
  const PROJECT = arg('--project', null);
  fs.mkdirSync(OUT, { recursive: true });
  const dirs = { exportDir: path.join(OUT, 'export'), dataDir: path.join(OUT, 'data'), projectsDir: path.join(OUT, 'projects') };
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
  // 那一份检出自己的 dev server 辅助(它的 REPO 就是那一份检出)
  const { startDevServer } = await import(pathToFileURL(path.join(TREE, 'scripts', 'lib', 'dev-server.mjs')).href);
  log('起 dev server', TREE, PORT);
  const server = await startDevServer({ port: PORT, logFile: path.join(OUT, 'vite.log'), log,
    env: { PROMPTCUT_EXPORT_DIR: dirs.exportDir, PROMPTCUT_DATA_DIR: dirs.dataDir, PROMPTCUT_PROJECTS_DIR: dirs.projectsDir, PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_PUSH: '0' } });
  cleanups.push(() => server.stop());
  const browser = await puppeteer.launch({ headless: true, protocolTimeout: 900_000,
    args: [...PROBE_CHROME_ARGS, '--mute-audio', '--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required'] });
  cleanups.push(() => browser.close());
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e?.message ?? e).slice(0, 200)));
  await page.evaluateOnNewDocument(AUDIO_HOOK);
  const open = async () => {
    await page.goto(`${server.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    await until('编辑器就绪', () => page.evaluate(() => !!window.__pcStore && !!window.__pcIo && !!window.__pcPreviewDiag), 180_000);
  };
  await open();

  /* ---- 摆项目(或载入另一趟留下的那一份,片段 id 才相同) */
  let project;
  if (PROJECT) {
    project = JSON.parse(fs.readFileSync(path.resolve(PROJECT), 'utf8'));
    await page.evaluate((p) => window.__pcStore.actions.loadProject(p), project);
  } else {
    project = await page.evaluate((kind) => {
      const { actions, getState } = window.__pcStore;
      actions.newProject(`av-card-cost ${kind}`);
      actions.setProjectMeta({ width: 640, height: 360, fps: 30 });
      // 总时长跟着内容走:一张 4 秒的无声卡把时间轴撑到 4 秒
      actions.addCardClip('punch-pill', 0, { duration: 4 });
      if (kind === 'av') {
        actions.addCardClip('av-pulse', 0.5, { duration: 1.0, params: { frequency: 880, gain: 0.5, duration: 0.6 } });
        actions.addCardClip('av-pulse', 2.0, { duration: 1.5, params: { color: '#f97316', frequency: 520, gain: 0.5, duration: 1.2 } });
      } else {
        actions.addCardClip('odometer', 0.5, { duration: 1.5 });
        actions.addCardClip('ring-metric', 2.0, { duration: 1.5 });
      }
      return getState().project;
    }, KIND);
  }
  fs.writeFileSync(path.join(OUT, 'project.json'), JSON.stringify(project, null, 1));
  const cardClips = project.tracks.flatMap((t) => t.clips).filter((c) => c.cardId);
  const avClips = cardClips.filter((c) => c.cardId === 'av-pulse');
  note('项目', { kind: KIND, clips: cardClips.map((c) => [c.id, c.cardId, c.start, c.end]) });

  /** 页面这一侧此刻的判定:身份、测量日志、成本记录、分派表 */
  const judged = () => page.evaluate(async (ids) => {
    const CI = await import('/src/editor/costIdentity.ts');
    const D = await import('/src/editor/planDispatch.ts');
    const P = await import('/src/render/pipelinePlan.mjs');
    const p = window.__pcStore.getState().project;
    const identity = CI.clipIdentityOf(p);
    const plan = D.currentPlan();
    const PR = await import('/src/editor/probeRunner.ts');
    const diag = window.__pcPreviewDiag();
    const costs = D.currentCosts();
    return {
      probeRun: { running: diag.probeRun.running, settled: PR.probeSettledFor(p), probed: diag.probeRun.probed.map((e) => [e.clipId, e.cardId]) },
      clips: ids.map((id) => {
        const clip = p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
        const key = identity.identityKeys[id] ?? null;
        const record = key ? costs.find((r) => r.identityKey === key) ?? null : null;
        return { id, cardId: clip?.cardId, identityKey: key, frameMode: identity.frameModes[id] ?? null,
          record: record && { kind: record.kind, stepMs: record.stepMs, capped: record.capped === true, demoted: record.demoted === true },
          verdict: plan && clip ? P.pipelineAt(plan, id, (clip.start + clip.end) / 2) : null,
          inPrerenderSet: plan ? plan.prerenderSet.has(id) : null };
      }),
    };
  }, cardClips.map((c) => c.id));
  const settled = async (what) => {
    // 测量跑完:不在跑、而且连着两次看测量日志没再长
    let last = -1;
    return until(what, async () => {
      const j = await judged();
      const n = j.probeRun.probed.length;
      const ok = j.probeRun.settled && !j.probeRun.running && n === last;
      last = n;
      return ok ? j : null;
    }, 180_000, 700);
  };
  const first = await settled('第一轮测量跑完');
  if (!first) return;
  const audioLog = await page.evaluate(() => window.__pcAudioLog.slice());
  fs.writeFileSync(path.join(OUT, 'judged.json'), JSON.stringify(first, null, 1));
  const av = first.clips.filter((c) => c.cardId === 'av-pulse');

  if (KIND === 'av' && EXPECT === 'legacy') {
    note('改前的对照(不算验收):有声动效卡的身份与判定', { av });
  }
  if (KIND === 'av' && EXPECT === 'light') {
    check('V1 有声动效卡的片段有成本身份、有声明的帧模式', av.length === avClips.length && av.every((c) => typeof c.identityKey === 'string' && c.frameMode === 'direct'), { av });
    const probedIds = new Set(first.probeRun.probed.map((e) => e[0]));
    // 同一个身份键只测一次:两段参数、时长不同,键不同,各测各的
    const keys = new Set(av.map((c) => c.identityKey));
    check('V2 第一次出现就测:测量日志里有它,成本记录按它的身份键写进去了', av.every((c) => c.record) && [...keys].length === first.probeRun.probed.filter((e) => e[1] === 'av-pulse').length && av.some((c) => probedIds.has(c.id)),
      { probed: first.probeRun.probed, records: av.map((c) => [c.id, c.record]) });
    check('V3 测量期间不出声:没有新建音频上下文、没有元素开始播放、没有声源启动', audioLog.length === 0, { audioLog });
    check('V4 测完判轻:分派表里是轻、不在预渲染集合里', av.every((c) => c.verdict === 'light' && c.inPrerenderSet === false), { av: av.map((c) => [c.id, c.verdict, c.inPrerenderSet]) });

    /* ---- V5 活渲 */
    const target = avClips[0];
    const live = await page.evaluate(async (at) => {
      const { actions } = window.__pcStore;
      const wait = (n) => new Promise((r) => setTimeout(r, n));
      actions.pause(); actions.setVolume?.(0); actions.seek(at);
      await wait(600);
      actions.play();
      await wait(250);
      const playing = window.__pcPreviewDiag();
      actions.pause(); actions.seek(at);
      await wait(600);
      return { suppressedWhilePlaying: playing.suppressed, text: document.body.innerText.includes('需要本地 PC 渲染辅助') };
    }, target.start + 0.05);
    const stageDom = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const hit = await frame.evaluate((id) => {
        const el = document.querySelector(`[data-pc-clip="${id}"]`);
        if (!el) return null;
        const slot = el.querySelector('[data-pc-placeholder-slot]');
        const ring = [...el.querySelectorAll('div')].find((d) => d.style.borderRadius === '50%');
        return { suppressed: el.classList.contains('pc-suppressed'), placeholderShown: !!slot && !slot.hidden, ring: ring ? { width: ring.getBoundingClientRect().width } : null,
          unsupported: !!el.querySelector('[data-pc-placeholder-reason="unsupported"]:not([hidden])') && !!slot && !slot.hidden };
      }, target.id).catch(() => null);
      if (hit) stageDom.push({ url: frame.url().slice(0, 80), ...hit });
    }
    if (!stageDom.length) note('舞台的帧', { frames: page.frames().map((f) => f.url().slice(0, 100)) });
    await page.screenshot({ path: path.join(OUT, 'V5-preview.png') });
    check('V5 活渲:播放时不被抑制;舞台上是活组件(圆环在),没有占位符,没有「需要本地 PC 渲染辅助」',
      !live.suppressedWhilePlaying.includes(target.id) && !live.text && stageDom.some((s) => s.ring && s.ring.width > 20 && !s.placeholderShown && !s.suppressed),
      { live, stageDom });

    /* ---- V6 重开不重测 */
    await open();
    await page.evaluate((p) => window.__pcStore.actions.loadProject(p), project);
    const again = await settled('重开后的那一轮跑完');
    if (again) {
      check('V6 重开不重测:测量日志里没有有声动效卡,判定仍是轻', again.probeRun.probed.every((e) => e[1] !== 'av-pulse') && again.clips.filter((c) => c.cardId === 'av-pulse').every((c) => c.verdict === 'light' && c.record),
        { probed: again.probeRun.probed, av: again.clips.filter((c) => c.cardId === 'av-pulse').map((c) => [c.id, c.verdict]) });
    }
  }

  /* ---- V7 导出 */
  log('导出');
  const exported = await page.evaluate(async () => {
    const stages = [];
    try {
      const r = await window.__pcIo.exportVideo({ onProgress: (_d, _t, stage) => { const s = stage ?? 'render'; if (stages.at(-1) !== s) stages.push(s); } });
      return { ok: true, outDir: r.outDir, stages };
    } catch (e) { return { ok: false, error: String(e?.message ?? e), stages }; }
  });
  const files = [];
  if (exported.ok) {
    for (const name of ['preview.mp4', 'overlay.mov']) {
      const from = path.join(exported.outDir, name);
      if (!fs.existsSync(from)) continue;
      fs.copyFileSync(from, path.join(OUT, name));
      files.push([name, fs.statSync(from).size]);
    }
  }
  check('V7 导出成功,成片文件在', exported.ok && files.some((f) => f[0] === 'preview.mp4' && f[1] > 0), { error: exported.error, stages: exported.stages, files });
  const end = await judged();
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ tree: TREE, kind: KIND, expect: EXPECT, first, end, exported: { ok: exported.ok, stages: exported.stages, files }, errors }, null, 1));
  note('页面报错', { errors: errors.slice(0, 5) });
}

/* ================================================================== compare */

async function frameHashes(ffmpeg, file) {
  // 解成 rgba 原始像素,按帧切、逐帧 sha256(带 alpha 的 overlay.mov 也照此)
  const probe = await new Promise((resolve) => {
    const c = spawn(ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true });
    let err = '';
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', () => resolve(err));
  });
  const m = /Stream #\d+:\d+.*Video:.*?(\d{2,5})x(\d{2,5})/.exec(probe);
  if (!m) throw new Error(`读不出画幅:${file}`);
  const frameBytes = Number(m[1]) * Number(m[2]) * 4;
  return new Promise((resolve, reject) => {
    const c = spawn(ffmpeg, ['-v', 'error', '-i', file, '-an', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'], { windowsHide: true });
    const hashes = [];
    let pending = Buffer.alloc(0), err = '';
    c.stdout.on('data', (chunk) => {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= frameBytes) {
        hashes.push(createHash('sha256').update(pending.subarray(0, frameBytes)).digest('hex'));
        pending = pending.subarray(frameBytes);
      }
    });
    c.stderr.on('data', (d) => { err += d; });
    c.on('close', (code) => (code === 0 ? resolve({ hashes, size: `${m[1]}x${m[2]}` }) : reject(new Error(`ffmpeg 解码失败:${err.slice(-300)}`))));
  });
}

async function compare() {
  const A = path.resolve(arg('--a')), B = path.resolve(arg('--b'));
  const ffmpeg = await findFfmpeg();
  const rows = [];
  for (const name of ['preview.mp4', 'overlay.mov']) {
    const fa = path.join(A, name), fb = path.join(B, name);
    if (!fs.existsSync(fa) && !fs.existsSync(fb)) continue;
    if (!fs.existsSync(fa) || !fs.existsSync(fb)) { rows.push({ name, missing: !fs.existsSync(fa) ? 'a' : 'b' }); continue; }
    const [a, b] = [await frameHashes(ffmpeg, fa), await frameHashes(ffmpeg, fb)];
    let differ = 0;
    const firstDiff = [];
    for (let i = 0; i < Math.max(a.hashes.length, b.hashes.length); i++) if (a.hashes[i] !== b.hashes[i]) { differ++; if (firstDiff.length < 5) firstDiff.push(i); }
    const sameBytes = Buffer.compare(fs.readFileSync(fa), fs.readFileSync(fb)) === 0;
    rows.push({ name, size: a.size, framesA: a.hashes.length, framesB: b.hashes.length, differ, firstDiff, sameBytes,
      distinctA: new Set(a.hashes).size });
  }
  check('C1 两边每个成片文件帧数相同、逐帧 sha256 相同', rows.length > 0 && rows.every((r) => !r.missing && r.framesA === r.framesB && r.framesA > 0 && r.differ === 0), { rows });
}
