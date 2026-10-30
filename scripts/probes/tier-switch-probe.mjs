/**
 * 两档素材换档的端到端探针(`docs/plan/c66-design.md` 第 4 节、验收 T5 / T6 / T7):真 Chrome 里的真编辑台,
 * 素材从一台「远程素材服务」来,经本地素材服务的读路由按需拉取。
 *
 *   node scripts/probes/tier-switch-probe.mjs --origin http://127.0.0.1:5570 [--remote-port 5575] [--out <dir>]
 *
 * dev server 按分配的端口段起:`npx vite --port 5570 --strictPort --host 127.0.0.1`(舞台端口 5571 / 5572)。
 * 「远程素材服务」由本探针自己在 `--remote-port` 上起(只实现契约里本探针用到的几条:
 * `GET media/<hash>`(含 Range)、`GET media/<hash>/chunks`、跨源预检),每一档 `complete` 与否由探针控制。
 *
 * 测试素材现场用 ffmpeg 生成(设计稿第 8 节「测试素材」):1280×720、30 fps、6 秒,画面顶上一条 10 格的黑白条
 * 按二进制编码帧号(第 k 格亮 = 帧号第 k 位是 1),素材小尺寸照设计稿的素材小尺寸命令转(800×450),ProRes 素材原尺寸是同一段画面
 * 转 `prores_ks`。每次运行在元数据里写一个随机串,哈希每次都不一样,不会命中上一次留在本地内容库里的文件。
 *
 * 场景:
 *   T5a(暂停中换档):素材层先透明(还没连远程,两档都没到齐,角上「等待上传方」)→ 连上远程、只有素材小尺寸到齐:素材小尺寸出现
 *        → 素材原尺寸到齐:下一次轮询内换素材原尺寸;换档前后同一目标时刻(2.5 s)解出的帧号相差不超过一帧,换档期间逐帧采样无黑帧。
 *   T5b(播放中换档):素材小尺寸在播,中途素材原尺寸到齐;换档那一刻前后两帧的帧号跳变与时间差对得上(误差 ≤ 1 帧),无黑帧。
 *   T6 :素材原尺寸是 ProRes:本机探出放不了(设备本地缓存记 0),两档都到齐也一直停在素材小尺寸。
 *   T7 :素材原尺寸没到齐时导出:`exportVideo` 拒绝、提示「等待上传方」,顶栏点导出弹出同样的提示,没有任何导出请求发出。
 *   T5c(暂停中、素材原尺寸慢到;`docs/archive/agent-reports/AGENT-tier-reload-seek.md`):同 T5a 的开头(先等待上传方、素材原尺寸地址挂失败过),
 *        素材原尺寸报齐后远程先扣住字节 `--hold-ms`(回了头、不给字节),可播性探测因此超时(记「未知」);之后探针不再碰页面的
 *        任何状态(播放头停着、集合不变),也必须换到素材原尺寸。跨机 T9 `ht9a0927` 里观察端就是这样一直停在素材小尺寸。
 *   T5e(暂停中、可播性早有结论、预热槽位要重载):同 T5a 的开头,但本机早就记下「素材原尺寸放得了」;素材原尺寸报齐那一轮,
 *        之前挂失败过的槽位直接成了预热槽位、又被 `load()` 重载 —— 重载会把刚下的定位清回 0;之后没有重渲染也必须
 *        回到 2.5 s、交出对齐的一帧并换档。
 *
 *   `--only T5a,T5c` 只跑列出的场景(缺省全跑)。
 *
 * 耗时只记录(verification.md「耗时只记录,不当闸门」):T5a「complete 翻真后多久被页面轮询看到」(原门槛 ≤ 2600 ms)与各场景
 * 换到素材原尺寸的用时只写进 `TIMINGS` 行与结果的 `timings`,不决定过不过。黑帧数、帧号与帧误差(不超过一帧)、
 * 「等待上传方」的提示照旧是通过条件。等待时限只为防卡死,一律不少于 120 秒。
 *
 * 输出:最后一行是一行 JSON(`ok`、各场景的关键数),截图在 `--out` 目录。
 * 帧号的读法:在可见舞台里对**显示着的**那个 `<video>` 做 `drawImage`,读顶上那条的 10 个格子。
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { devOrigin, flagArg } from './probe-connect.mjs';
import { createTimings } from './probe-timings.mjs';
import { findFfmpeg } from '../../server/bakery/ffmpeg.mjs';

const args = process.argv.slice(2);
const origin = devOrigin(args);
const REMOTE_PORT = Number(flagArg('remote-port', '5575', args));
const RUN = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-tier-probe-${RUN}`));
const FPS = 30;
const ONLY = flagArg('only', null, args);
const want = (scene) => !ONLY || ONLY.split(',').map((x) => x.trim()).includes(scene);
/** T5c:素材原尺寸报齐后远程扣住字节多久(要长过远端可播性探测的 10 s 时限,再留出轮询的 2 s) */
const HOLD_MS = Number(flagArg('hold-ms', '16000', args));
const fails = [];
const notes = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 400))); return !!cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 等待时限只为防卡死(verification.md「耗时只记录,不当闸门」):不到 WAIT_FLOOR_MS 的一律提到它;等到头没有结果仍算不过 */
const WAIT_FLOOR_MS = 120000;
const timings = createTimings('tier-switch-probe');
async function until(label, fn, timeoutMs, everyMs = 200) {
  const deadline = Date.now() + Math.max(timeoutMs, WAIT_FLOOR_MS);
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await sleep(everyMs);
  }
}

/* ------------------------------------------------------------------ 素材 */
await fs.mkdir(OUT, { recursive: true });
const ffmpeg = await findFfmpeg();
function ff(argv) {
  const r = spawnSync(ffmpeg, ['-v', 'error', '-y', ...argv], { windowsHide: true, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ffmpeg 失败:${r.stderr}`);
}
/** 一对素材(素材原尺寸 + 素材小尺寸)。`prores` 时素材原尺寸转 ProRes MOV */
async function makePair(tag, { prores = false } = {}) {
  const src = path.join(OUT, `${tag}-src.mp4`);
  ff(['-f', 'lavfi', '-i', `color=c=gray:s=1280x720:r=${FPS}:d=6`,
    '-vf', "geq=lum='if(lt(Y,96),255*mod(floor(N/pow(2,floor(X/128))),2),96+64*sin(X/40+N/5))':cb=128:cr=128",
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-g', '150', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-metadata', `comment=${RUN}-${tag}`, src]);
  const orig = prores ? path.join(OUT, `${tag}-orig.mov`) : src;
  if (prores) ff(['-i', src, '-c:v', 'prores_ks', '-profile:v', '3', '-pix_fmt', 'yuv422p10le', '-an', '-metadata', `comment=${RUN}-${tag}-p`, orig]);
  const small = path.join(OUT, `${tag}-small.mp4`);
  // 设计稿第 8 节的素材小尺寸命令(保留 VFR 时间戳、只丢间隔不足 1/60 s 的帧、限 800×600、偶数尺寸)
  ff(['-i', orig, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', "select='isnan(prev_selected_t)+gte(t-prev_selected_t\\,1/60)',scale=w='min(iw\\,800)':h='min(ih\\,600)':force_original_aspect_ratio=decrease:force_divisible_by=2:reset_sar=1,format=yuv420p",
    '-fps_mode:v', 'vfr', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', small]);
  const read = async (f, type) => {
    const bytes = await fs.readFile(f);
    return { bytes, hash: crypto.createHash('sha256').update(bytes).digest('hex'), type };
  };
  return { orig: await read(orig, prores ? 'video/quicktime' : 'video/mp4'), small: await read(small, 'video/mp4'), ext: prores ? 'mov' : 'mp4' };
}

/* ------------------------------------------------------------------ 远程素材服务 */
const remoteFiles = new Map(); // hash → { bytes, type, complete }
const remoteLog = [];
/** T5c:回了头、字节扣到 `holdUntil` 才给(慢链路上「素材原尺寸还在路上」) */
function later(f, req, res, body) {
  if (req.method === 'HEAD') return res.end();
  const wait = (f.holdUntil ?? 0) - Date.now();
  if (wait > 0) setTimeout(() => res.end(body), wait);
  else res.end(body);
}
const remote = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges, Content-Length, Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Range, Authorization', 'Access-Control-Max-Age': '600' });
    return res.end();
  }
  const m = /^\/api\/asset\/media\/([0-9a-f]{64})(\/chunks)?$/.exec(req.url.split('?')[0]);
  const f = m ? remoteFiles.get(m[1]) : null;
  remoteLog.push({ at: Date.now(), path: m ? `${m[1].slice(0, 8)}${m[2] ?? ''}` : req.url, auth: !!req.headers.authorization, range: req.headers.range ?? null });
  if (m && m[2]) {
    res.setHeader('Content-Type', 'application/json');
    return res.end(JSON.stringify(f ? { size: f.bytes.length, chunkSize: 8388608, received: f.complete ? [0] : [], complete: !!f.complete } : { size: null, chunkSize: 8388608, received: [], complete: false }));
  }
  if (!f || !f.complete) { res.statusCode = 404; return res.end('Not found'); }
  const range = req.headers.range && /^bytes=(\d+)-(\d*)$/.exec(req.headers.range);
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), f.bytes.length - 1) : f.bytes.length - 1;
    res.writeHead(206, { 'Content-Type': f.type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${f.bytes.length}`, 'Accept-Ranges': 'bytes' });
    return later(f, req, res, f.bytes.subarray(start, end + 1));
  }
  res.writeHead(200, { 'Content-Type': f.type, 'Content-Length': f.bytes.length, 'Accept-Ranges': 'bytes' });
  later(f, req, res, f.bytes);
});
await new Promise((r) => remote.listen(REMOTE_PORT, '127.0.0.1', r));
const REMOTE_BASE = `http://127.0.0.1:${REMOTE_PORT}/api/asset`;
const publish = (x, complete, holdUntil = 0) => remoteFiles.set(x.hash, { bytes: x.bytes, type: x.type, complete, holdUntil });

/* ------------------------------------------------------------------ 页面 */
const out = { ok: false, origin, run: RUN, out: OUT, T5a: {}, T5b: {}, T5c: {}, T5e: {}, T6: {}, T7: {} };
const browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
  args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  const exportRequests = [];
  page.on('request', (r) => { if (/\/api\/export(\/|$)/.test(r.url())) exportRequests.push(r.url()); });
  // 并行跑别的 Chrome 任务时 Vite 的首次模块转换偶尔会超时；只重试舞台初始化。
  let booted = false;
  for (let attempt = 0; attempt < 3 && !booted; attempt++) {
    try {
      await page.goto(origin + '/?editor&nosetup=1&preview=stage', { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.waitForFunction(async () => {
        const m = await import('/src/editor/stageBridge.ts');
        return !!m.frontStage() && m.backRole() === 'back';
      }, { timeout: 45000, polling: 500 });
      booted = true;
      out.bootstrapRetries = attempt;
      pageErrors.length = 0;
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(1000);
    }
  }
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  const stagePorts = (ports.ports ?? []).slice(0, 2).map(String);
  const store = (fn, ...a) => page.evaluate(async (src, a2) => {
    const { actions, getState } = await import('/src/store/project.ts');
    // eslint-disable-next-line no-new-func
    return new Function('actions', 'getState', 'args', src)(actions, getState, a2);
  }, fn, a);
  const tiers = (fn, ...a) => page.evaluate(async (src, a2) => {
    const T = await import('/src/editor/media/assetTiers.ts');
    const AsyncFunction = (async () => {}).constructor;
    return new AsyncFunction('T', 'args', src)(T, a2);
  }, fn, a);
  const stageFrames = () => page.frames().filter((f) => /[?&]stage=1/.test(f.url()) && stagePorts.some((p) => f.url().includes(`:${p}/`)));
  const front = async () => {
    const id = await page.evaluate(() => window.__pcPreviewDiag?.().frontId ?? 'A');
    return stageFrames().find((f) => f.url().includes(`id=${id}`)) ?? null;
  };
  const preview = async (name) => {
    const el = await page.$('[data-pc="stage-frame"]');
    const box = el ? await el.boundingBox() : null;
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, clip: box ? { x: Math.max(0, box.x - 4), y: Math.max(0, box.y - 4), width: box.width + 8, height: box.height + 8 } : undefined });
    return file;
  };
  /** 显示着的素材层眼下是什么:哪一档、解出的帧号、就绪没有、角上有没有「等待上传方」 */
  const layer = async () => (await front())?.evaluate((F) => {
    const v = document.querySelector('[data-pc-media] > video');
    const awaiting = !!document.querySelector('[data-pc-media-awaiting]');
    if (!v) return { shown: false, awaiting };
    const r = { shown: true, awaiting, src: v.currentSrc || v.getAttribute('src') || '', rs: v.readyState, ct: v.currentTime, err: v.error?.code ?? null };
    if (v.readyState >= 2 && v.videoWidth) {
      const cv = document.createElement('canvas');
      cv.width = v.videoWidth; cv.height = v.videoHeight;
      const ctx = cv.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0);
      const y = Math.round(cv.height * (48 / 720));
      let idx = 0;
      for (let k = 0; k < 10; k++) {
        const x = Math.round(cv.width * ((k + 0.5) / 10));
        if (ctx.getImageData(x, y, 1, 1).data[0] > 128) idx |= 1 << k;
      }
      r.idx = idx;
      r.expect = Math.round(v.currentTime * F);
    }
    return r;
  }, FPS);
  /** 在可见舞台里逐帧(真 rAF)采样显示着的那一层,直到 stopSampler */
  const startSampler = async () => (await front()).evaluate((F) => {
    window.__tierSamples = [];
    window.__tierSampling = true;
    window.__pcTierTrace = [];
    const cv = document.createElement('canvas');
    cv.width = 100; cv.height = 72;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const now = () => (window.__pcRealNow ?? (() => performance.now()))();
    const raf = window.__pcRealRaf ?? window.requestAnimationFrame.bind(window);
    const loop = () => {
      if (!window.__tierSampling) return;
      const v = document.querySelector('[data-pc-media] > video');
      const s = { at: now(), shown: !!v, t: window.__pcStageDiag?.().t ?? null };
      if (v) {
        s.src = (v.currentSrc || '').split('/@media/')[1]?.slice(0, 8) ?? '';
        s.rs = v.readyState;
        s.ct = v.currentTime;
        if (v.readyState >= 2 && v.videoWidth) {
          ctx.drawImage(v, 0, 0, cv.width, cv.height);
          const y = 5;
          let idx = 0;
          for (let k = 0; k < 10; k++) if (ctx.getImageData(Math.round(cv.width * ((k + 0.5) / 10)), y, 1, 1).data[0] > 128) idx |= 1 << k;
          s.idx = idx;
          // 下半截的平均亮度:全黑(< 16)就是黑帧
          const d = ctx.getImageData(0, Math.round(cv.height * 0.5), cv.width, 1).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += d[i];
          s.luma = sum / (d.length / 4);
        }
      }
      window.__tierSamples.push(s);
      raf(loop);
    };
    raf(loop);
  }, FPS);
  const stopSampler = async () => (await front()).evaluate(() => {
    window.__tierSampling = false;
    const trace = window.__pcTierTrace ?? [];
    delete window.__pcTierTrace;
    const samples = window.__tierSamples.splice(0);
    samples.trace = trace;
    return { samples, trace };
  });
  /** T5b:在显示元素交帧时读实际画面；DOM 换槽后立即订阅新元素。 */
  const startFrameSampler = async () => (await front()).evaluate(() => {
    const frames = [];
    const watched = new Map();
    const cv = document.createElement('canvas');
    cv.width = 100; cv.height = 72;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    const visible = () => document.querySelector('[data-pc-media] > video');
    const watch = () => {
      const v = visible();
      if (!v || watched.has(v)) return;
      const onFrame = (_now, meta) => {
        if (!window.__tierFrameSampler || visible() !== v) return;
        const s = { src: (v.currentSrc || '').split('/@media/')[1]?.slice(0, 8) ?? '',
          at: meta.expectedDisplayTime, mediaTime: meta.mediaTime, t: window.__pcStageDiag?.().t ?? null,
          rs: v.readyState };
        if (v.readyState >= 2 && v.videoWidth) {
          ctx.drawImage(v, 0, 0, cv.width, cv.height);
          const y = 5;
          let idx = 0;
          for (let k = 0; k < 10; k++) if (ctx.getImageData(Math.round(cv.width * ((k + 0.5) / 10)), y, 1, 1).data[0] > 128) idx |= 1 << k;
          s.idx = idx;
          const d = ctx.getImageData(0, Math.round(cv.height * 0.5), cv.width, 1).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += d[i];
          s.luma = sum / (d.length / 4);
        }
        frames.push(s);
        watched.set(v, v.requestVideoFrameCallback(onFrame));
      };
      watched.set(v, v.requestVideoFrameCallback(onFrame));
    };
    const observer = new MutationObserver(watch);
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-pc-media', 'style'], subtree: true });
    window.__tierFrameSampler = { frames, watched, observer };
    watch();
  });
  const stopFrameSampler = async () => (await front()).evaluate(() => {
    const sampler = window.__tierFrameSampler;
    if (!sampler) return [];
    delete window.__tierFrameSampler;
    sampler.observer.disconnect();
    for (const [v, id] of sampler.watched) v.cancelVideoFrameCallback(id);
    return sampler.frames;
  });
  const blackOf = (samples, fromAt) => samples.filter((s) => s.at >= fromAt && (!s.shown || s.rs < 2 || !(s.luma > 16)));

  /**
   * 新项目 + 一段 6 秒的视频片段,素材记录带两档。
   * 注意:载入别的项目 = 回到本机空间(syncManager 的 switchToLocal),当前远程素材服务随之清掉 ——
   * 和「在共享项目里载入别的项目 = 离开共享项目」一个口径。所以 `remote` 为真时建完项目再连一次远程。
   */
  const setupProject = async (pair, name, remote = true) => {
    const r = await setupProjectOnly(pair, name);
    if (remote) await tiers(`T.setRemoteAssets({ base: args[0], ticket: async () => 'probe-ticket' });`, REMOTE_BASE);
    return r;
  };
  const setupProjectOnly = async (pair, name) => {
    await store('actions.newProject(args[0]);', name);
    // 远程素材来自共享项目。只改素材服务地址却仍留在本机空间，会让
    // 本机缺失检查按正常规则清空尚未拉到的原尺寸地址，干扰换档观察。
    // 用真实协作入口建立隔离的共享项目，再由场景控制远程素材服务。
    const shared = await page.evaluate(async (name) => {
      const { enableCollab } = await import('/src/editor/sync/collab.ts');
      const result = await enableCollab({ where: 'lan', mode: 'free', name,
        creator: { username: 'tier-probe', password: 'isolated-tier-probe-creator' },
        projectPassword: 'isolated-tier-probe-project' });
      return { ok: result.ok, error: result.ok ? null : result.error };
    }, name);
    if (!shared.ok) throw new Error(`换档探针共享项目初始化失败: ${shared.error}`);
    return store(`
    const m = actions.addMedia({ kind: 'video', name: args[0] + '.' + args[4], url: '/@media/' + args[1], hash: args[1], ext: args[4], size: args[3],
      tiers: { original: args[1], small: args[2] }, duration: 6, width: 1280, height: 720 });
    const c = actions.addMediaClip(m.id, 0, { duration: 6 });
    actions.seek(2.5);
    return { mediaId: m.id, clipId: c && c.id };`, name, pair.orig.hash, pair.small.hash, pair.orig.bytes.length, pair.ext);
  };

  /* ============================================================ T5a:暂停中换档 */
  if (want('T5a')) {
  const A = await makePair('a');
  publish(A.small, false);
  publish(A.orig, false);
  await tiers('T.setRemoteAssets(null);');
  const setupA = await setupProject(A, `tier-a-${RUN}`, false);
  check(setupA?.clipId, 'T5a:加上了视频片段');
  // 1) 还没连远程:本地素材服务上两档都没有 → 透明 + 「等待上传方」
  const transparent = await until('T5a:素材层透明、角上「等待上传方」', async () => {
    const l = await layer();
    return l && l.awaiting && !(l.shown && l.rs >= 2) ? l : null;
  }, 15000);
  out.T5a.transparent = transparent ? { awaiting: transparent.awaiting, shown: transparent.shown, rs: transparent.rs ?? null } : null;
  out.T5a.shotTransparent = await preview('t5a-1-transparent');
  // 2) 连上远程、只有素材小尺寸到齐 → 素材小尺寸出现
  publish(A.small, true);
  const tConnect = Date.now();
  await tiers(`T.setRemoteAssets({ base: args[0], ticket: async () => 'probe-ticket' });`, REMOTE_BASE);
  const smallUp = await until('T5a:素材小尺寸出现', async () => {
    const l = await layer();
    return l && l.shown && l.rs >= 2 && l.src.includes(A.small.hash) && Number.isInteger(l.idx) ? l : null;
  }, 20000);
  out.T5a.smallMs = Date.now() - tConnect;
  out.T5a.small = smallUp ? { idx: smallUp.idx, expect: smallUp.expect, awaiting: smallUp.awaiting } : null;
  check(smallUp && !smallUp.awaiting, 'T5a:素材小尺寸出现后「等待上传方」撤下', smallUp);
  check(smallUp && Math.abs(smallUp.idx - 75) <= 1, 'T5a:素材小尺寸停在 2.5 s(帧号 75 ± 1)', smallUp);
  out.T5a.shotSmall = await preview('t5a-2-small');
  // 3) 素材原尺寸到齐 → 下一次轮询内换素材原尺寸(轮询 2 s + 按需拉取 + 可播性探测 + 预热对齐)
  await startSampler();
  const samplerStart = await (await front()).evaluate(() => (window.__pcRealNow ?? (() => performance.now()))());
  publish(A.orig, true);
  const tOrig = Date.now();
  const polled = await until('T5a:页面轮询看到素材原尺寸到齐', () => tiers(`return T.tierHashes().includes(args[0]);`, A.orig.hash), 10000, 50);
  out.T5a.pollMs = polled ? Date.now() - tOrig : null;
  // 耗时只记录:原来 ≤ 2600 ms 是通过条件;「看到了」由上面的 until 判(等不到记超时)
  timings.record('T5a complete 翻真到页面轮询看到素材原尺寸', out.T5a.pollMs, { formerLimit: '≤ 2600 ms(轮询 2 s + 余量)' });
  const origUp = await until('T5a:换到素材原尺寸', async () => {
    const l = await layer();
    return l && l.shown && l.rs >= 2 && l.src.includes(A.orig.hash) && Number.isInteger(l.idx) ? l : null;
  }, 20000);
  out.T5a.switchMs = Date.now() - tOrig;
  timings.record('T5a 素材原尺寸到齐到换到素材原尺寸(暂停中)', origUp ? out.T5a.switchMs : null, { formerLimit: '等待上限 20 秒' });
  await sleep(300);
  const { samples: samplesA, trace: traceA } = await stopSampler();
  out.T5a.trace = traceA.map((x) => ({ mediaTime: +x.mediaTime.toFixed(4), ref: +x.ref.toFixed(4), errFrames: +((x.mediaTime - x.ref) * x.fps).toFixed(2), playing: x.playing }));
  check(traceA.length >= 1 && traceA.every((x) => Math.abs(x.mediaTime - x.ref) * x.fps <= 1.03), 'T5a:换档那一帧的帧回调 mediaTime 与目标差不超过一帧', out.T5a.trace);
  out.T5a.original = origUp ? { idx: origUp.idx, expect: origUp.expect } : null;
  check(origUp && smallUp && Math.abs(origUp.idx - smallUp.idx) <= 1, 'T5a:换档前后同一目标时刻的帧号相差不超过一帧', { small: smallUp?.idx, orig: origUp?.idx });
  const blackA = blackOf(samplesA, samplerStart);
  out.T5a.samples = samplesA.length;
  out.T5a.black = blackA.length;
  check(samplesA.length > 10 && blackA.length === 0, 'T5a:换档期间逐帧采样无黑帧 / 无空档', blackA.slice(0, 3));
  const idxsA = [...new Set(samplesA.filter((s) => Number.isInteger(s.idx)).map((s) => s.idx))];
  out.T5a.idxSeen = idxsA;
  check(idxsA.every((i) => Math.abs(i - 75) <= 1), 'T5a:暂停中换档,画面一直停在 2.5 s(帧号 75 ± 1),没有跳回片头', idxsA);
  out.T5a.shotOriginal = await preview('t5a-3-original');
  out.T5a.playable = await (await front()).evaluate((h) => Object.keys(localStorage).filter((k) => k.endsWith(h)).map((k) => [k.split('.').slice(0, 3).join('.'), localStorage.getItem(k)]), A.orig.hash);

  }
  /* ============================================================ T5b:播放中换档 */
  if (want('T5b')) {
  const B = await makePair('b');
  publish(B.small, true);
  publish(B.orig, false);
  await setupProject(B, `tier-b-${RUN}`);
  await store('actions.seek(0.3);');
  const readyB = await until('T5b:素材小尺寸就绪', async () => { const l = await layer(); return l && l.rs >= 2 && l.src.includes(B.small.hash) ? l : null; }, 20000);
  if (!readyB) {
    out.T5b.debug = { layer: await layer(), tiers: await tiers('return T.assetTiersDebug();'), small: B.small.hash.slice(0, 8), orig: B.orig.hash.slice(0, 8),
      remoteLog: remoteLog.slice(-12), status: await (await fetch(origin + '/api/media/remote')).json() };
  }
  await startSampler();
  await startFrameSampler();
  const bStart = await (await front()).evaluate(() => (window.__pcRealNow ?? (() => performance.now()))());
  await store('actions.play();');
  await sleep(800);
  publish(B.orig, true);
  const tB = Date.now();
  const switchedB = await until('T5b:播放中换到素材原尺寸', async () => { const l = await layer(); return l && l.rs >= 2 && l.src.includes(B.orig.hash) ? l : null; }, 15000, 100);
  out.T5b.switchMs = switchedB ? Date.now() - tB : null;
  timings.record('T5b 素材原尺寸到齐到换到素材原尺寸(播放中)', out.T5b.switchMs, { formerLimit: '等待上限 15 秒' });
  await sleep(600);
  const { samples: samplesB, trace: traceB } = await stopSampler();
  const framesB = await stopFrameSampler();
  out.T5b.trace = traceB.map((x) => ({ mediaTime: +x.mediaTime.toFixed(4), ref: +x.ref.toFixed(4), errFrames: +((x.mediaTime - x.ref) * x.fps).toFixed(2), playing: x.playing }));
  const swapTrace = traceB.find((x) => x.playing);
  check(swapTrace && Math.abs(swapTrace.mediaTime - swapTrace.ref) * swapTrace.fps <= 1.03,
    'T5b:播放中换档当帧与前台交帧外推到同一显示时刻的误差不超过一帧', out.T5b.trace);
  await store('actions.pause();');
  const shotB = await preview('t5b-after-switch');
  out.T5b.shot = shotB;
  const decB = framesB.filter((s) => s.at >= bStart && Number.isInteger(s.idx));
  const k = decB.findIndex((s, i) => i > 0 && decB[i - 1].src === B.small.hash.slice(0, 8) && s.src === B.orig.hash.slice(0, 8));
  if (k > 0) {
    const a = decB[k - 1], b = decB[k];
    // 两个逐帧回调的显示时刻不相同，把前一帧外推到后一帧的显示时刻再比较。
    // 探针自身可能因负载漏收中间的 rVFC；精确对调帧取预热回调里与前台回调同显示时刻的比较。
    // 显示元素的逐帧读图另外验证两侧确有画；回调延迟时画布可能已走到后一帧，
    // 因此不把画布帧号强行配给该次回调的 mediaTime。
    const frameError = swapTrace ? (swapTrace.mediaTime - swapTrace.ref) * FPS : NaN;
    const observedGap = (b.mediaTime - (a.mediaTime + (b.at - a.at) / 1000)) * FPS;
    out.T5b.swap = { before: { idx: a.idx, mediaTime: a.mediaTime, displayTime: a.at },
      after: { idx: b.idx, mediaTime: b.mediaTime, displayTime: b.at }, frameError: +frameError.toFixed(2), observedGap: +observedGap.toFixed(2) };
    check(Math.abs(out.T5b.swap.frameError) <= 1, 'T5b:播放中换档那一刻帧误差不超过一帧', out.T5b.swap);
    check(b.idx >= a.idx - 1, 'T5b:换档不往回跳', out.T5b.swap);
    // 换档之后 300 ms 内每一帧都有画(新档对调时已经交过对齐的帧)
    const after = framesB.filter((s) => s.at >= b.at && s.at <= b.at + 300);
    out.T5b.afterSwapBlack = after.filter((s) => s.rs < 2 || !(s.luma > 16)).length;
    check(after.length > 0 && out.T5b.afterSwapBlack === 0, 'T5b:换档那一刻起 300 ms 内无黑帧 / 无空档', after.slice(0, 4));
  } else check(false, 'T5b:采样里找到了素材小尺寸 → 素材原尺寸的换档那一刻', { n: decB.length, srcs: [...new Set(samplesB.map((s) => s.src))] });
  // 解得出的帧里没有一帧是黑的(下半截平均亮度 < 16)
  const lumaBlack = decB.filter((s) => !(s.luma > 16));
  out.T5b.samples = samplesB.length;
  out.T5b.decoded = decB.length;
  out.T5b.lumaBlack = lumaBlack.length;
  check(decB.length > 10 && lumaBlack.length === 0, 'T5b:播放全程解得出的帧没有黑帧', lumaBlack.slice(0, 3));
  // 与换档无关的缓冲(播放中纠偏 seek 时 readyState 掉到 1,屏幕上仍是上一帧):只记数,不判
  out.T5b.bufferingSamples = blackOf(samplesB, bStart).length;
  const errs = decB.map((s) => s.idx - Math.round(s.t * FPS));
  out.T5b.frameErrVsStage = { min: Math.min(...errs), max: Math.max(...errs) };

  }
  /**
   * T5c / T5e 共用:暂停在 2.5 s,先「等待上传方」(素材原尺寸地址挂过、失败了)→ 素材小尺寸到齐、显示 → 素材原尺寸报齐。
   * 素材原尺寸报齐之后探针**不再碰页面的任何状态**(不 seek、不改集合、不点东西),只看它自己能不能换到素材原尺寸。
   */
  const pausedSwapAfterFailedOriginal = async (scene, tag, { holdMs = 0, cachePlayable = false, timeoutMs }) => {
    const o = out[scene];
    const X = await makePair(tag);
    publish(X.small, false);
    publish(X.orig, false);
    await tiers('T.setRemoteAssets(null);');
    const setup = await setupProject(X, `tier-${tag}-${RUN}`, false);
    check(setup?.clipId, `${scene}:加上了视频片段`);
    const awaiting = await until(`${scene}:先等待上传方(素材原尺寸地址挂失败)`, async () => {
      const l = await layer();
      return l && l.awaiting && !(l.shown && l.rs >= 2) ? l : null;
    }, 15000);
    o.awaitingFirst = !!awaiting;
    if (cachePlayable) {
      // 本机早就探过「素材原尺寸放得了」(两个舞台各是一个页面源,各记一份)
      for (const f of stageFrames()) await f.evaluate(async (h) => { (await import('/src/render/playability.ts')).rememberPlayable(h, true); }, X.orig.hash);
    }
    publish(X.small, true);
    await tiers(`T.setRemoteAssets({ base: args[0], ticket: async () => 'probe-ticket' });`, REMOTE_BASE);
    const small = await until(`${scene}:素材小尺寸出现`, async () => {
      const l = await layer();
      return l && l.shown && l.rs >= 2 && l.src.includes(X.small.hash) && Number.isInteger(l.idx) ? l : null;
    }, 20000);
    o.small = small ? { idx: small.idx } : null;
    check(small && Math.abs(small.idx - 75) <= 1, `${scene}:素材小尺寸停在 2.5 s(帧号 75 ± 1)`, small);
    const els = () => [...document.querySelectorAll('video')].map((v) => ({ src: (v.currentSrc || v.getAttribute('src') || '').split('/@media/')[1]?.slice(0, 8) ?? '',
      rs: v.readyState, net: v.networkState, err: v.error?.code ?? null, ct: +v.currentTime.toFixed(3), shown: getComputedStyle(v.parentElement).visibility === 'visible' }));
    o.elsBefore = await (await front()).evaluate(els);
    // 元素事件时间线(load() 调用、seeking / seeked),只记不判
    await (await front()).evaluate(() => {
      window.__tierEv = [];
      const now = () => (window.__pcRealNow ?? (() => performance.now()))();
      window.__tierT0 = now();
      const rec = (v, type) => window.__tierEv.push({ at: Math.round(now() - window.__tierT0), type, src: (v.currentSrc || v.getAttribute('src') || '').split('/@media/')[1]?.slice(0, 8) ?? '', rs: v.readyState, ct: +v.currentTime.toFixed(3) });
      for (const v of document.querySelectorAll('video')) {
        // 槽位元素跨场景复用:每个元素只挂一次
        if (v.__tierHooked) continue;
        v.__tierHooked = true;
        for (const type of ['loadstart', 'loadedmetadata', 'loadeddata', 'seeking', 'seeked', 'emptied', 'error']) v.addEventListener(type, () => rec(v, type));
        const load = v.load.bind(v);
        v.load = () => { rec(v, 'load()'); return load(); };
      }
    });
    await startSampler();
    const samplerStart = await (await front()).evaluate(() => (window.__pcRealNow ?? (() => performance.now()))());
    const tOrig = Date.now();
    publish(X.orig, true, holdMs ? tOrig + holdMs : 0);
    const orig = await until(`${scene}:换到素材原尺寸(素材原尺寸报齐之后没有任何别的状态变化)`, async () => {
      const l = await layer();
      return l && l.shown && l.rs >= 2 && l.src.includes(X.orig.hash) && Number.isInteger(l.idx) ? l : null;
    }, timeoutMs, 250);
    o.switchMs = orig ? Date.now() - tOrig : null;
    timings.record(`${scene} 素材原尺寸报齐到换到素材原尺寸`, o.switchMs, { formerLimit: `等待上限 ${Math.round(timeoutMs / 1000)} 秒` });
    await sleep(300);
    const { samples, trace } = await stopSampler();
    o.trace = trace.map((x) => ({ mediaTime: +x.mediaTime.toFixed(4), ref: +x.ref.toFixed(4), errFrames: +((x.mediaTime - x.ref) * x.fps).toFixed(2), playing: x.playing }));
    o.events = await (await front()).evaluate(() => (window.__tierEv ?? []).slice(0, 40));
    o.elsAfter = await (await front()).evaluate(els);
    o.playable = await (await front()).evaluate((h) => Object.keys(localStorage).filter((k) => k.endsWith(h)).map((k) => localStorage.getItem(k)), X.orig.hash);
    o.original = orig ? { idx: orig.idx } : null;
    check(orig && small && Math.abs(orig.idx - small.idx) <= 1, `${scene}:换档前后同一目标时刻的帧号相差不超过一帧`, { small: small?.idx, orig: orig?.idx });
    check(!orig || (trace.length >= 1 && trace.every((x) => Math.abs(x.mediaTime - x.ref) * x.fps <= 1.03)), `${scene}:换档那一帧的帧回调 mediaTime 与目标差不超过一帧`, o.trace);
    const black = blackOf(samples, samplerStart);
    o.samples = samples.length;
    o.black = black.length;
    check(samples.length > 10 && black.length === 0, `${scene}:换档期间逐帧采样无黑帧 / 无空档`, black.slice(0, 3));
    const idxs = [...new Set(samples.filter((s) => Number.isInteger(s.idx)).map((s) => s.idx))];
    o.idxSeen = idxs;
    check(idxs.every((i) => Math.abs(i - 75) <= 1), `${scene}:画面一直停在 2.5 s(帧号 75 ± 1)`, idxs);
    o.shot = await preview(`${scene.toLowerCase()}-original`);
  };

  /* ============================================================ T5c:暂停中、素材原尺寸慢到(可播性探测超时) */
  if (want('T5c')) await pausedSwapAfterFailedOriginal('T5c', 'e', { holdMs: HOLD_MS, timeoutMs: HOLD_MS + 30000 });

  /* ============================================================ T5e:暂停中、可播性早有结论、预热槽位重载 */
  if (want('T5e')) await pausedSwapAfterFailedOriginal('T5e', 'f', { cachePlayable: true, timeoutMs: 20000 });

  /* ============================================================ T6:素材原尺寸不可播(ProRes) */
  if (want('T6')) {
  const C = await makePair('c', { prores: true });
  publish(C.small, true);
  publish(C.orig, true);
  await setupProject(C, `tier-c-${RUN}`);
  const verdict = await until('T6:本机探出 ProRes 素材原尺寸放不了(设备本地缓存记 0)', async () => {
    const v = await (await front()).evaluate((h) => { const k = Object.keys(localStorage).find((x) => x.startsWith('pc.playable.') && x.endsWith(h)); return k ? { key: k.replace(h, '<hash>'), value: localStorage.getItem(k) } : null; }, C.orig.hash);
    return v;
  }, 25000, 300);
  out.T6.cache = verdict;
  check(verdict && verdict.value === '0', 'T6:缓存结论是放不了', verdict);
  // 结论出来之后再看 5 秒:一直停在素材小尺寸
  const stay = [];
  for (let i = 0; i < 10; i++) { const l = await layer(); stay.push(l?.src.includes(C.small.hash) ? 'small' : l?.src.includes(C.orig.hash) ? 'orig' : 'none'); await sleep(500); }
  out.T6.stay = [...new Set(stay)];
  check(stay.every((s) => s === 'small'), 'T6:两档都到齐,预览仍一直停在素材小尺寸', stay);
  const lc = await layer();
  out.T6.idx = lc?.idx ?? null;
  out.T6.shot = await preview('t6-prores-stays-small');
  const projectHasNoPlayable = await store(`return JSON.stringify(getState().project).includes('playable');`);
  check(!projectHasNoPlayable, 'T6:项目文档里没有可播性字段');
  // 导出侧仍按素材原尺寸:导出拦截问的是素材原尺寸的哈希(两档都到齐 → 放行,不拿素材小尺寸代替)
  const gateC = await tiers(`return (await T.exportGate((await import('/src/store/project.ts')).getState().project)).map((m) => m.hash);`);
  out.T6.exportGate = gateC;
  check(Array.isArray(gateC) && gateC.length === 0, 'T6:素材原尺寸到齐了,导出不拦(导出只认素材原尺寸)', gateC);

  }
  /* ============================================================ T7:素材原尺寸没到时导出 */
  if (want('T7')) {
  const D = await makePair('d');
  publish(D.small, true);
  publish(D.orig, false);
  await setupProject(D, `tier-d-${RUN}`);
  await until('T7:素材小尺寸就绪', async () => { const l = await layer(); return l && l.rs >= 2 && l.src.includes(D.small.hash) ? l : null; }, 20000);
  exportRequests.length = 0;
  const viaIo = await page.evaluate(async () => {
    try { await window.__pcIo.exportVideo(); return { resolved: true }; } catch (e) { return { message: String(e?.message ?? e), code: e?.code ?? null, missing: (e?.missing ?? []).length }; }
  });
  out.T7.exportVideo = viaIo;
  check(viaIo.code === 'awaiting-uploader' && /等待上传方/.test(viaIo.message) && viaIo.missing === 1, 'T7:exportVideo 拒绝并提示「等待上传方」、列出缺的素材', viaIo);
  // 顶栏点「导出」:不弹另存为,直接给同样的提示
  await sleep(2200); // 让轮询把「素材原尺寸没到齐」记进集合
  const clicked = await page.evaluate(() => {
    const b = [...document.querySelectorAll('button')].find((x) => /导出/.test(x.textContent || '') || /导出/.test(x.getAttribute('title') || '') || /导出/.test(x.getAttribute('aria-label') || ''));
    if (!b) return false;
    b.click();
    return true;
  });
  const dialog = clicked ? await until('T7:导出对话框的提示', () => page.evaluate(() => { const t = document.body.innerText; return /等待上传方/.test(t) ? t.split('\n').find((l) => /等待上传方/.test(l)) : null; }), 5000) : null;
  out.T7.dialog = dialog;
  check(clicked, 'T7:顶栏找到了导出按钮');
  check(dialog && dialog.includes(`tier-d-${RUN}`), 'T7:对话框提示「等待上传方」并列出素材名', dialog);
  await sleep(300);
  out.T7.shot = path.join(OUT, 't7-export-blocked.png');
  await page.screenshot({ path: out.T7.shot });
  out.T7.exportRequests = exportRequests.length;
  check(exportRequests.length === 0, 'T7:没有发出任何导出请求(不出片)', exportRequests);

  }
  /* ============================================================ 收尾 */
  const status = await (await fetch(origin + '/api/media/remote')).json();
  out.remoteAuthSeen = remoteLog.some((e) => e.auth);
  out.pull = { base: status.base, jobs: status.jobs.length };
  out.pageErrors = pageErrors.slice(0, 5);
  check(pageErrors.length === 0, '页面没有未捕获的错误', pageErrors.slice(0, 3));
  await tiers('T.setRemoteAssets(null);');
} catch (err) {
  fails.push(`探针异常:${err?.stack ?? err}`);
} finally {
  await browser.close().catch(() => {});
  remote.close();
}
out.fails = fails;
out.notes = notes;
out.ok = fails.length === 0;
out.timings = timings.list;
timings.print();
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
