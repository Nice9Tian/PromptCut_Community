/**
 * 播放保活 —— **真的编辑器 + 真的预渲染进程**的端到端探针(任务「桌面版播放保活」;语义 `docs/semantics/mechanism/rendering.md`
 * 「重管线:预渲染」:之后要补的只在暂停时产,播放时不产)。
 *
 *   node scripts/probes/play-idle-probe.mjs --port 27100 [--out <目录>] [--json <文件>] [--keep]
 *   node scripts/probes/play-idle-probe.mjs --origin http://127.0.0.1:27100 …   # 接一台已经起好的 dev server
 *
 * 要复现的毛病:预渲染进程判断「用户在不在播放」只看页面报来的播放头(`FramePipeline.streamBusy()`:在播且 5 秒内有过音讯,或 800 毫秒内动过)。
 * 播放中页面只有「缺口」(`wanted`)那条路能刷新这个音讯,而播放头下每一层都有流盖着时没有缺口、不发。于是连着播放超过 5 秒,
 * 预渲染进程就当成机器闲了,在播放中接着把别的卡的流补成满密度。
 *
 * 流程:
 *   0. 编辑器 `?editor&nosetup=1&preview=stage`;新建项目,放八张每帧横移 10 像素的卡(`r6-stateful`),每张 6 秒,依次排开;
 *      都钉成重卡,触发预渲染。第一张(A)是播放用的:等它的轨道流盖满全段(稀疏的就算),这时别的卡的流还在补。
 *   1. 在 A 里循环播放(到近尾处跳回 A 的前段;播放头下只有 A,A 有流盖着,所以没有缺口)。页面一侧记下 `/api/data/playhead` 发了几条、
 *      带不带 `wanted`。
 *   2. 每 0.5 秒读一次预渲染进程的诊断(`/api/frames/diagnostics` 的 `streams`:已产分段数、截了多少帧、满密度分段数)和它手里的播放头
 *      (`/api/data/playhead`:最近一次收到的时刻 `at` 和 `playing`)。
 *   3. 播放 20 秒后停下。再读 12 秒,看它多久恢复产流。
 *
 * 断言:
 *   a. 起播 5 秒以后到停下之前,预渲染进程手里的播放头一直是「在播」、最近一次音讯不超过 `MAX_HEAD_AGE_MS`(保活要明显小于服务端的 5 秒窗口);
 *   b. 起播 5 秒以后到停下之前,已产分段数、截帧数、满密度分段数一个都没涨(一帧都没产);
 *   c. 停下以后 `RESUME_MS` 内恢复产流(证明剩下的活是真的在等,不是已经产完了才没动)。
 *
 * 结论 JSON 写 stdout,过程写 stderr;任何一条不过以非零退出。耗时只记录,等待时限只为防卡死。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { flagArg } from './probe-connect.mjs';
import { startDevServer, sleep } from './below-stream-common.mjs';

const args = process.argv.slice(2);
const GIVEN_ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const RUN = Date.now().toString(36);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-play-idle-${RUN}`));
if (!GIVEN_ORIGIN && !PORT) { console.error('要给 --origin <dev server> 或 --port <自己起一台>'); process.exit(2); }

const FPS = 30, SEG = 15;
/** 八张卡各 6 秒(剩下的活要比播放的 20 秒长;一路满密度 40 帧每秒上下);入点按秒写,落在两帧之间(第一张是第 40～219 帧,共 12 个分段) */
const CLIP_SECONDS = 6;
const STARTS = [1.32, 8.32, 15.32, 22.32, 29.32, 36.32, 43.32, 50.32];
const FIRST = Math.ceil(STARTS[0] * FPS), LAST = Math.ceil((STARTS[0] + CLIP_SECONDS) * FPS) - 1;
const SEG_COUNT = Math.ceil((LAST - FIRST + 1) / SEG);
/** 循环播放的范围:都在 A(1.32～7.32 秒)里 */
const LOOP_FROM = 2.0, LOOP_TO = 6.8;
/** 播放多久;预渲染进程的「在播」窗口是 5 秒,要播得比它长得多 */
const PLAY_MS = 20_000;
/** 起播多久以后开始要求「一帧都不产」:服务端的窗口是 5 秒 */
const QUIET_FROM_MS = 5_000;
/** 保活的最大间隔上限:预渲染进程手里的播放头最近一次音讯不许老过这个数(服务端窗口 5 秒,保活取 2 秒) */
const MAX_HEAD_AGE_MS = 3_500;
/** 停下以后多久内要恢复产流(停下推一次播放头,服务端再静 0.8 秒,生产者再醒;一个分段出完才计数,所以给宽一点) */
const RESUME_MS = 12_000;

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const notes = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 900))); say('FAIL', { label, extra }); } return !!cond; };
async function until(label, fn, timeoutMs, everyMs = 100, soft = false) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { (soft ? notes : fails).push(`超时:${label}`); say('TIMEOUT', { label, soft }); return null; }
    await sleep(everyMs);
  }
}

await fs.mkdir(OUT, { recursive: true });
const out = { out: OUT, clips: STARTS.map((s) => ({ start: s, seconds: CLIP_SECONDS })), loop: [LOOP_FROM, LOOP_TO], playMs: PLAY_MS };
let dev = null, browser = null;
const started = Date.now();
try {
  let origin = GIVEN_ORIGIN;
  if (!origin) {
    process.env.PROMPTCUT_EXPORT_DIR = path.join(OUT, 'export');
    await fs.mkdir(process.env.PROMPTCUT_EXPORT_DIR, { recursive: true });
    dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'playidle' });
    origin = dev.origin;
    say('spawn', { pid: dev.pid, port: PORT });
  }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;

  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1920, height: 1200 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)));
  // 数页面向 /api/data/playhead 发了什么:在页面脚本跑之前装好。
  await page.evaluateOnNewDocument(() => {
    const tally = window.__playheadPosts = { total: 0, playing: 0, withWanted: 0, playingNoWanted: 0, at: [] };
    const real = window.fetch.bind(window);
    window.fetch = (input, init) => {
      try {
        const url = typeof input === 'string' ? input : input?.url;
        if (typeof url === 'string' && url.includes('/api/data/playhead') && String(init?.method || 'GET').toUpperCase() === 'POST') {
          const body = JSON.parse(String(init?.body ?? '{}'));
          tally.total++;
          if (body.playing) tally.playing++;
          if (Array.isArray(body.wanted) && body.wanted.length) tally.withWanted++;
          else if (body.playing) tally.playingNoWanted++;
          tally.at.push([Date.now(), body.playing ? 1 : 0, Array.isArray(body.wanted) && body.wanted.length ? 1 : 0]);
        }
      } catch { /* 只是计数 */ }
      return real(input, init);
    };
  });
  await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => {
    const m = await import('/src/editor/stageBridge.ts');
    return !!m.frontStage() && m.backRole() === 'back';
  }, { timeout: 180000, polling: 500 });
  const store = (fn, ...a) => page.evaluate(async (src, a2) => {
    const { actions, getState } = await import('/src/store/project.ts');
    // eslint-disable-next-line no-new-func
    return new Function('actions', 'getState', 'args', src)(actions, getState, a2);
  }, fn, a);

  /* ---------------------------------------------------------------- 0. 项目 */
  const clipIds = await store(`actions.newProject('play-idle-${RUN}');
    const ids = [];
    for (const start of args[0]) { const c = actions.addCardClip('r6-stateful', start, { duration: args[1], params: {} }); if (c) ids.push(c.id); }
    actions.seek(args[2]);
    return ids;`, STARTS, CLIP_SECONDS, LOOP_FROM);
  out.clipIds = clipIds;
  if (!check(clipIds.length === STARTS.length, '八张卡都加上了', clipIds)) throw new Error('卡没加全');
  const A = clipIds[0];
  const project = await page.evaluate(async () => JSON.parse(JSON.stringify((await import('/src/store/project.ts')).getState().project)));
  out.project = { width: project.width, height: project.height, fps: project.fps, duration: project.duration };
  check(project.fps === FPS, '项目是 30 帧每秒', project.fps);

  const pinHeavy = (persist = false) => page.evaluate(async (ids, persist) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const keys = clipIdentityOf(getState().project).identityKeys;
    const costs = pd.currentCosts();
    const device = costs[0]?.device ?? 'probe';
    const recs = ids.map((id) => ({ ...(costs.find((r) => r.identityKey === keys[id]) ?? { identityKey: keys[id], device }), pinnedHeavy: true }));
    pd.mergePlanCosts(recs);
    if (persist) {
      const saved = recs.filter((r) => typeof r.stepMs === 'number');
      if (saved.length) await fetch('/api/data/costs', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: saved }) });
    }
    return recs.map((r) => typeof r.stepMs === 'number');
  }, clipIds, persist);
  await until('八张卡的成本记录', () => page.evaluate(async (ids) => {
    const { getState } = await import('/src/store/project.ts');
    const { clipIdentityOf } = await import('/src/editor/costIdentity.ts');
    const pd = await import('/src/editor/planDispatch.ts');
    const keys = clipIdentityOf(getState().project).identityKeys;
    const costs = pd.currentCosts();
    return ids.every((id) => costs.some((r) => r.identityKey === keys[id] && typeof r.stepMs === 'number'));
  }, clipIds), 240000, 500, true);
  out.costRecords = await pinHeavy(true);

  const prerender = await (await fetch(origin + '/api/prerender/info')).json();
  out.prerender = { url: prerender.url, ready: prerender.ready, mode: prerender.mode };
  const getJson = (url) => fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(5000) }).then((r) => (r.ok ? r.json() : null), () => null);
  /** 预渲染进程现在产了多少:已产分段数、截帧数、满密度分段数、稀疏分段数 */
  const produced = async () => {
    const d = await getJson(`${prerender.url}/api/frames/diagnostics`);
    const s = d?.streams;
    if (!s) return null;
    let frames = 0, dense = 0, sparse = 0;
    for (const st of s.streams ?? []) {
      frames += st.capture?.frames ?? 0;
      for (const seg of Object.values(st.segments ?? {})) { if (seg.stride === 1) dense++; else sparse++; }
    }
    return { segments: s.stats?.segments ?? 0, frames, dense, sparse, streams: (s.streams ?? []).length };
  };
  /** 预渲染进程手里的播放头:最近一次收到的时刻离现在多久、在播不在播 */
  const headNow = async () => {
    const h = await getJson(`${prerender.url}/api/data/playhead`);
    return h ? { playing: !!h.playing, age: Date.now() - Number(h.at), wanted: h.wanted?.length ?? 0 } : null;
  };

  const layersNow = () => page.evaluate(async (id) => {
    const m = await import('/src/editor/snapshotFeed.ts');
    const byKind = m.currentReadyIndex().get(id);
    return byKind ? Object.fromEntries([...byKind].map(([k, v]) => [k, { key: v.key, ranges: v.ranges, originFrame: v.originFrame ?? null }])) : null;
  }, A);
  const startedPrerender = Date.now();
  const readyA = await until('A 的轨道流盖满全段(稀疏的就算)', async () => {
    const k = await page.evaluate(async () => (await import('/src/render/dataMirror.ts')).mirrorKey());
    if (!k) return null;
    await pinHeavy(true);
    await fetch(prerender.url + '/api/frames/preload', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ session: k.session, localRev: k.localRev, lane: 'background' }) }).catch(() => {});
    const layers = await layersNow();
    if (!layers?.stream || !(layers.stream.ranges ?? []).some((r) => r[0] <= 0 && r[1] >= SEG_COUNT - 1)) return null;
    return { layers, produced: await produced() };
  }, 900000, 2000);
  if (!readyA) throw new Error('A 的轨道流没产出来');
  out.aReadyMs = Date.now() - startedPrerender;
  say('a-ready', { ms: out.aReadyMs, produced: readyA.produced });
  out.beforePlay = await produced();
  say('before-play', out.beforePlay);

  /* ---------------------------------------------------------------- 1. 循环播放 */
  // 页面里的循环:近尾处跳回前段。seek 不改 playing;播放头始终在 A 里。
  await page.evaluate(async (from, to) => {
    const { actions, getState } = await import('/src/store/project.ts');
    window.__loopTimer = setInterval(() => {
      const s = getState();
      if (s.playing && s.t >= to) actions.seek(from);
    }, 100);
  }, LOOP_FROM, LOOP_TO);
  const postsBefore = await page.evaluate(() => ({ ...window.__playheadPosts, at: undefined }));
  const playStart = Date.now();
  await store(`actions.seek(args[0]); actions.play();`, LOOP_FROM);
  const samples = [];
  let baseline = null;
  while (Date.now() - playStart < PLAY_MS) {
    // 每隔几轮重钉一次:页面测完第二趟会把成本记录整条重写,钉重卡那一位会被冲掉
    if (samples.length % 6 === 0) await pinHeavy(true).catch(() => {});
    const elapsed = Date.now() - playStart;
    const [p, h, st] = await Promise.all([produced(), headNow(), page.evaluate(async () => { const { getState } = await import('/src/store/project.ts'); const s = getState(); return { t: s.t, playing: s.playing }; })]);
    const sample = { ms: elapsed, produced: p, head: h, t: Math.round(st.t * 100) / 100, playing: st.playing };
    samples.push(sample);
    if (!baseline && elapsed >= QUIET_FROM_MS && p) baseline = sample;
    await sleep(500);
  }
  const playEnd = Date.now();
  const lastProduced = await produced();
  const posts = await page.evaluate(() => window.__playheadPosts);
  const playPosts = posts.at.filter(([at]) => at >= playStart && at <= playEnd);
  out.posts = { before: postsBefore, duringPlay: { total: playPosts.length, playing: playPosts.filter((p) => p[1] === 1).length, withWanted: playPosts.filter((p) => p[2] === 1).length,
    playingNoWanted: playPosts.filter((p) => p[1] === 1 && p[2] === 0).length, atMs: playPosts.map((p) => p[0] - playStart) } };
  say('played', { posts: out.posts.duringPlay, lastProduced });

  /* ---------------------------------------------------------------- 3. 停下,看多久恢复 */
  const stopAt = Date.now();
  await store(`actions.pause();`);
  let resumedAfterMs = null;
  const afterSamples = [];
  while (Date.now() - stopAt < RESUME_MS) {
    const p = await produced();
    afterSamples.push({ ms: Date.now() - stopAt, produced: p });
    if (p && lastProduced && (p.segments > lastProduced.segments || p.frames > lastProduced.frames)) { resumedAfterMs = Date.now() - stopAt; break; }
    await sleep(250);
  }
  await page.evaluate(() => clearInterval(window.__loopTimer)).catch(() => {});
  out.samples = samples;
  out.afterSamples = afterSamples;
  out.resumedAfterMs = resumedAfterMs;

  /* ---------------------------------------------------------------- 断言 */
  const quiet = samples.filter((s) => s.ms >= QUIET_FROM_MS && s.produced && s.head);
  check(samples.every((s) => s.playing), '播放一直在播(页面的 playing 没有掉)', samples.filter((s) => !s.playing).slice(0, 3));
  check(quiet.length >= 10, '起播 5 秒以后采到了足够多的样', quiet.length);
  const stale = quiet.filter((s) => !s.head.playing || s.head.age > MAX_HEAD_AGE_MS);
  check(stale.length === 0, `a. 起播 ${QUIET_FROM_MS / 1000} 秒以后到停下之前,预渲染进程手里的播放头一直是「在播」、最近一次音讯不超过 ${MAX_HEAD_AGE_MS} 毫秒`,
    { bad: stale.length, of: quiet.length, worst: Math.max(...quiet.map((s) => s.head.age)), first: stale.slice(0, 3).map((s) => ({ ms: s.ms, head: s.head })) });
  if (baseline && lastProduced) {
    const grew = { segments: lastProduced.segments - baseline.produced.segments, frames: lastProduced.frames - baseline.produced.frames, dense: lastProduced.dense - baseline.produced.dense };
    out.producedWhilePlaying = { from: baseline.ms, ...grew };
    check(grew.segments === 0 && grew.frames === 0 && grew.dense === 0, `b. 起播 ${QUIET_FROM_MS / 1000} 秒以后到停下之前,预渲染进程一帧都没产`, { baseline: baseline.produced, last: lastProduced, grew });
  } else check(false, 'b. 没有取到基线', { baseline: !!baseline, lastProduced: !!lastProduced });
  check(resumedAfterMs !== null, `c. 停下以后 ${RESUME_MS / 1000} 秒内恢复产流(剩下的活确实在等)`, { after: afterSamples.slice(-3), lastProduced });
  // 页面一侧:播放中没有缺口(没有 wanted),也就是说这个场景确实是「没有缺口」的那一种
  check(out.posts.duringPlay.withWanted === 0, '场景成立:播放中页面没有报过缺口(播放头下的层都有流盖着)', out.posts.duringPlay);
  check(pageErrors.length === 0, '页面没有未捕获的错误', pageErrors.slice(0, 3));
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
} finally {
  try { await browser?.close(); } catch { /* 收尾 */ }
  try { await dev?.stop(); } catch { /* 收尾 */ }
  if (!KEEP && dev) { try { await fs.rm(path.join(OUT, 'dev-data'), { recursive: true, force: true }); } catch { /* 收尾 */ } }
}
out.fails = fails;
out.notes = notes;
out.ms = Date.now() - started;
const summary = { ...out, samples: undefined, afterSamples: undefined, sampleCount: out.samples?.length };
const text = JSON.stringify(summary, null, 2);
if (JSON_OUT) await fs.writeFile(path.resolve(JSON_OUT), JSON.stringify(out, null, 2));
console.log(text);
process.exit(fails.length ? 1 : 0);
