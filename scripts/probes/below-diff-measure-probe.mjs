/**
 * 依赖下层的流里放什么:先量再定(渲染重构「戊二」的「下层二」,`docs/plan/prerender-products-contract.md` 第 5.3 节)。
 *
 *   node scripts/probes/below-diff-measure-probe.mjs [--origin http://127.0.0.1:27800 | --port 27804] [--media-port 27810]
 *        [--scenes a,b] [--sizes 960x540,1920x1080] [--frames 90] [--rounds 2] [--out <dir>] [--keep] [--json <file>]
 *
 * 不经过生产者和帧库:自己开一个预渲染间,直接用 `bakeStream` 和 `server/bakery/capture-below.mjs` 取帧,
 * 所以开关(`BELOW_STREAMS_DEFAULT`)关着也能跑。两个场景、两种画幅(见 `below-stream-common.mjs`),各量:
 *
 *   1. **每帧截两张多花多少**:同一段帧,只截一张(现在的办法)对截两张再算那一层,轮流各走几趟取中位数,取图那一段每帧多少毫秒
 *      (等素材就位的时间两边一样,单列);稀疏一趟(交出去的是整幅)、满密度一趟(交出去的是收紧矩形)各一组。
 *      另量「把截图矩形也收紧会快多少」和「收紧截图矩形会不会改画面」(会改,所以产品里两张都截整幅再裁)。
 *   2. **取两张不扰动页面**:两张那一趟的上张和只截一张那一趟的逐字节相同;上张、下张分别和「带目标卡」「只有下层」两个工程
 *      照导出的办法渲出来的同一帧逐像素比。
 *   3. **误差**:四种流里放的东西,各自盖回「只有下层的导出画面」以后和「整幅的导出画面」比(预乘色,满分 255),
 *      编码前一个数、经 H.264 编码再解码以后一个数:
 *        - 契约  契约第 5.3 节的算式(不透明度取最小的那个);
 *        - 两让  下层半透明时不透明度和颜色的误差两头各让一点,没有毛玻璃掩码;
 *        - 取层  产品里用的:「两让」加上毛玻璃外框里不透明度取 1(`diffLayer`);
 *        - 原样  原样盖:直接把带下层的画面裁出来。
 *      带对照:同一帧盖回去的画面和 7 帧以后的真画面比。另给一个参照「编码本身的误差」:把真画面原样编一遍、解出来直接和真画面比。
 *   4. **下层错开一帧**:流是第 f 帧的,下层已经是第 f+1 帧(贴回舞台时视频和活渲的卡常常差这么多),盖回去和第 f+1 帧的真画面比。
 *
 * 耗时只记录,不当通过条件。任何一条不变式不成立(取两张扰动了页面、盖回去的误差超出量级、没有对照)就以非零退出。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { flagArg } from './probe-connect.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeStream, bakeFrames } from '../../server/bakery/bake.mjs';
import { findFfmpeg, openStreamSegmentEncoder, dropStreamEncoderSpares, pickStreamEncoder } from '../../server/bakery/ffmpeg.mjs';
import { decodePngRgba, rgbaAlphaBox } from '../../server/bakery/capture-canvas.mjs';
import { belowSegmentCapture, diffLayer, glassMask, newBelowRecord } from '../../server/bakery/capture-below.mjs';
import { isolatedBelowProject, splitFmp4, evenRect, padRect, unionRect, intersectRect, SEGMENT_FRAMES, SPARSE_STRIDE, MEASURE_PAD_PX } from '../../server/frame-stream.mjs';
import { ROOT, FPS, TARGET, scenarioProject, startDevServer, ensureVideo, serveMedia, emptyUrlOf, decodeSegment,
  newError, errorSummary, tallyStraight, tallyDecoded, tallyDecodedDirect, composeDecoded, cropRgba, savePreview, round2, median } from './below-stream-common.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '27804', args));
const MEDIA_PORT = Number(flagArg('media-port', '27810', args));
const SCENES = String(flagArg('scenes', 'a,b', args)).split(',').map((s) => s.trim()).filter((s) => s === 'a' || s === 'b');
const SIZES = String(flagArg('sizes', '960x540,1920x1080', args)).split(',').map((s) => s.trim().split('x').map(Number)).filter(([w, h]) => w > 0 && h > 0);
const FRAMES = Math.max(30, Math.min(90, Number(flagArg('frames', '90', args)) || 90));
const ROUNDS = Math.max(1, Number(flagArg('rounds', '2', args)) || 2);
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-below-measure-${Date.now().toString(36)}`));

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); say('FAIL', { label, extra }); } return cond; };
const sha = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 16);
const pad = (n) => String(n).padStart(4, '0');
const SCENE_NAME = { a: '甲', b: '乙' };
const VARIANTS = ['契约', '两让', '取层', '原样'];

/** 契约第 5.3 节原来的算式:不透明度取「不透明度那条式子」和各颜色通道两条下限里最大的 */
function diffContract(upper, lower, width, crop) {
  const out = Buffer.alloc(crop.w * crop.h * 4);
  for (let y = 0; y < crop.h; y++) {
    let i = ((y + crop.y) * width + crop.x) * 4, o = y * crop.w * 4;
    for (let x = 0; x < crop.w; x++, i += 4, o += 4) {
      const ra8 = upper[i + 3], la8 = lower[i + 3];
      if (ra8 === la8 && upper[i] === lower[i] && upper[i + 1] === lower[i + 1] && upper[i + 2] === lower[i + 2]) continue;
      if (ra8 === 0) continue;
      const ra = ra8 / 255, la = la8 / 255;
      let a = la8 < 255 ? (ra - la) / (1 - la) : 0;
      const rc = [0, 0, 0], lc = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        rc[k] = upper[i + k] / 255 * ra; lc[k] = lower[i + k] / 255 * la;
        if (lc[k] > 0) a = Math.max(a, 1 - rc[k] / lc[k]);
        if (lc[k] < 1) a = Math.max(a, (rc[k] - lc[k]) / (1 - lc[k]));
      }
      a = Math.max(0, Math.min(1, a));
      const a8 = Math.round(a * 255);
      if (!a8) continue;
      const aq = a8 / 255;
      for (let k = 0; k < 3; k++) out[o + k] = Math.round(Math.max(0, Math.min(aq, rc[k] - lc[k] * (1 - aq))) / aq * 255);
      out[o + 3] = a8;
    }
  }
  return out;
}

/** 两张 straight RGBA 逐像素比:不同的像素数、最大的通道差;给了 `width` 另回不同的像素的包围盒 */
function pixelDiff(a, b, width = 0) {
  if (a.equals(b)) return { differ: 0, max: 0, box: null };
  let differ = 0, max = 0, x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let i = 0; i < a.length; i += 4) {
    // 两边都全透明的像素颜色不算数
    if (!a[i + 3] && !b[i + 3]) continue;
    const d = Math.max(Math.abs(a[i] - b[i]), Math.abs(a[i + 1] - b[i + 1]), Math.abs(a[i + 2] - b[i + 2]), Math.abs(a[i + 3] - b[i + 3]));
    if (!d) continue;
    differ++;
    if (d > max) max = d;
    if (width) { const x = (i / 4) % width, y = Math.floor(i / 4 / width); if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return { differ, max, box: width && differ ? { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null };
}

const out = { library: OUT, frames: FRAMES, runs: [] };
await fs.mkdir(OUT, { recursive: true });
let dev = null, media = null, bakery = null;
try {
  const ffmpeg = await findFfmpeg();
  const { encoder } = await pickStreamEncoder(ffmpeg);
  out.encoder = encoder;
  let origin = ORIGIN;
  if (!origin) { dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'belowmeasure' }); origin = dev.origin; say('spawn', { pid: dev.pid, port: PORT }); }
  out.origin = origin;
  const mediaDir = path.join(OUT, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  media = await serveMedia(MEDIA_PORT, mediaDir);

  for (const kind of SCENES) for (const [width, height] of SIZES) {
    const tag = `${SCENE_NAME[kind]} ${width}x${height}`;
    const dir = path.join(OUT, `${kind}-${width}x${height}`);
    await fs.mkdir(dir, { recursive: true });
    const run = { scene: SCENE_NAME[kind], size: `${width}x${height}` };
    out.runs.push(run);
    const hasMedia = kind === 'a';
    const mediaUrl = hasMedia ? media.url(path.basename(await ensureVideo(ffmpeg, mediaDir, width, height))) : '';
    const project = scenarioProject(kind, { width, height, mediaUrl });
    const spec = { topClipId: TARGET, clipIds: [TARGET] };
    const withTarget = isolatedBelowProject(project, spec);
    const lowerOnly = isolatedBelowProject(project, spec, { withTarget: false });
    const view = { x: 0, y: 0, w: width, h: height };
    const emptyUrl = emptyUrlOf(origin, { width, height });
    if (!bakery) bakery = await openBakery({ url: emptyUrl });
    const N = FRAMES;

    // ---------- 1. 两个工程照导出的办法各渲一遍(真画面)
    const exportFrames = async (proj, name) => {
      await bakery.reset(proj, emptyUrl);
      bakery.streamLease = null;
      const started = performance.now();
      await bakeFrames(bakery, { out: path.join(dir, `export-${name}`), fps: FPS, frames: `0-${N - 1}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
        onFrame: async (i, buf) => { await fs.writeFile(path.join(dir, `${name}-${pad(i)}.png`), buf); } });
      return performance.now() - started;
    };
    run.exportMs = { full: round2(await exportFrames(withTarget, 'full')), lower: round2(await exportFrames(lowerOnly, 'lower')) };
    say('export', { tag, ...run.exportMs });

    // ---------- 2. 取帧的几趟
    /** 走一趟:前 `count` 帧,一个分段一个 `capture`。回每帧的耗时:`hook` 是取图钩子里花的,`media` 是等素材就位,`step` 是推帧 */
    const pass = async (label, { capture = null, clip = view, stride = 1, onFrame = null, count = N, hookMs = () => 0 }) => {
      await bakery.reset(withTarget, emptyUrl, { deferCards: true });
      bakery.streamLease = null;
      const sum = { captured: 0, captureMs: 0, stepMs: 0, stepped: 0 };
      const started = performance.now();
      for (let seg = 0; seg * SEGMENT_FRAMES < count; seg++) {
        const from = seg * SEGMENT_FRAMES, to = Math.min(count - 1, from + SEGMENT_FRAMES - 1);
        const r = await bakeStream(bakery, { streamSignature: `${label}:${tag}`, fromFrame: from, toFrame: to, stride, fps: FPS, mountFrame: 0, clip, hasMedia,
          ...(capture ? { capture: capture(seg) } : {}), onFrame: onFrame ?? (async () => {}) });
        sum.captured += r.captured; sum.captureMs += r.captureMs; sum.stepMs += r.stepMs; sum.stepped += to - from + 1 + r.replayed;
      }
      const hook = hookMs() / sum.captured;
      return { captured: sum.captured, wallMs: performance.now() - started, capture: sum.captureMs / sum.captured, hook, media: sum.captureMs / sum.captured - hook, step: sum.stepMs / sum.stepped };
    };
    const hookOf = (record) => record.upperMs + record.lowerMs + record.verifyMs + record.decodeMs + record.diffMs;
    const perFrame = (record) => ({ upper: round2(record.upperMs / record.frames), lower: round2(record.lowerMs / record.frames), decode: round2(record.decodeMs / record.frames),
      diff: round2(record.diffMs / record.frames), verify: round2(record.verifyMs / record.frames),
      frames: record.frames, absent: record.absent, same: record.same, glassFrames: record.glassFrames, checks: record.checks, last: record.last, failed: record.failed, primeLower: record.primeLower });
    /** 只截一张:钩子里就是原来那一次截图 */
    const singlePass = (label, options = {}) => { let ms = 0; return pass(label, { ...options, hookMs: () => ms, capture: () => async (_frame, shoot) => { const at = performance.now(); const png = await shoot(); ms += performance.now() - at; return png; } }); };
    /** 截两张再算那一层(产品里的钩子) */
    const pairPass = (label, { rect = view, clip = view, ...options } = {}) => { const record = newBelowRecord(); return pass(label, { ...options, clip, hookMs: () => hookOf(record),
      capture: () => belowSegmentCapture(bakery, { clipId: TARGET, view: clip, rect, record }) }).then((r) => ({ ...r, record })); };

    // 先走一趟只截一张的(记每一帧的指纹),再走一趟两张的(把两张都存下来,不计时)
    const singleSha = [];
    await pass('single', { onFrame: async (frame, png) => { singleSha[frame] = sha(png); } });
    const upperSha = [], absent = [], glassOf = [];
    let measured = null;
    const record = newBelowRecord();
    await pass('pair', {
      capture: () => belowSegmentCapture(bakery, { clipId: TARGET, view, rect: view, record,
        tap: async ({ frame, upperPng, lowerPng, glass, absent: gone }) => {
          upperSha[frame] = sha(upperPng); absent[frame] = gone; glassOf[frame] = glass;
          await fs.writeFile(path.join(dir, `up-${pad(frame)}.png`), upperPng);
          if (lowerPng) await fs.writeFile(path.join(dir, `lo-${pad(frame)}.png`), lowerPng);
        } }),
      onFrame: async (_frame, shot) => {
        const box = rgbaAlphaBox(shot.rgba, shot.width, shot.height);
        if (box) measured = unionRect(measured, box);
      } });
    run.pairRecord = perFrame(record);
    run.glass = glassOf.find((g) => g?.length) ?? null;
    check(!record.failed && record.checks >= 1 && record.last?.lowerStable && record.last?.upperStable && !record.primeLower, `${tag}:每个分段第一帧的实测都过了(藏着连截两张相同、撤掉以后上张没变)`, run.pairRecord);
    check(record.checks === Math.ceil(N / SEGMENT_FRAMES), `${tag}:每个分段各实测一次`, record.checks);
    check(record.frames === N, `${tag}:两张那一趟取了 ${N} 帧`, record.frames);
    check(absent.filter(Boolean).length === 6, `${tag}:入场前的 6 帧页面上没有目标卡`, absent.filter(Boolean).length);
    check(record.glassFrames === N - 6, `${tag}:目标卡在场的每一帧都量到了毛玻璃的外框`, record.glassFrames);
    const upperSame = upperSha.filter((h, f) => h === singleSha[f]).length;
    run.upperSameAsSingle = `${upperSame}/${N}`;
    check(upperSame === N, `${tag}:两张那一趟的上张和只截一张那一趟逐字节相同`, run.upperSameAsSingle);
    check(!!measured, `${tag}:那一层不是空的`);
    const tight = evenRect(intersectRect(padRect(measured ?? view, MEASURE_PAD_PX), view), view);
    run.measured = measured; run.tight = tight; run.tightShare = round2(tight.w * tight.h / (width * height));
    check(tight.w * tight.h < width * height * 0.85, `${tag}:目标卡没有改动的地方是全透明的(量出来的实体框明显小于整幅)`, { tight, share: run.tightShare });

    // 计时:只截一张对截两张,轮流走 ROUNDS 轮取中位数(前 60 帧)
    const COUNT = Math.min(N, 60);
    const rounds = { sparseSingle: [], sparsePair: [], denseSingle: [], densePair: [], densePairTightView: [] };
    for (let r = 0; r < ROUNDS; r++) {
      rounds.sparseSingle.push(await singlePass('t-sparse-single', { stride: SPARSE_STRIDE, count: COUNT }));
      rounds.sparsePair.push(await pairPass('t-sparse-pair', { stride: SPARSE_STRIDE, count: COUNT }));
      rounds.denseSingle.push(await singlePass('t-dense-single', { count: COUNT }));
      rounds.densePair.push(await pairPass('t-dense-pair', { rect: tight, count: COUNT }));
      if (r === 0) rounds.densePairTightView.push(await pairPass('t-dense-pair-tightview', { rect: tight, clip: tight, count: COUNT }));
    }
    const mid = (list) => ({ hook: round2(median(list.map((x) => x.hook))), media: round2(median(list.map((x) => x.media))), step: round2(median(list.map((x) => x.step))),
      wallPerFrame: round2(median(list.map((x) => x.wallMs / x.captured))), ...(list[0].record ? { breakdown: perFrame(list[0].record) } : {}) });
    const side = (single, pair) => { const a = mid(single), b = mid(pair); return { single: a, pair: b, extraHookPerFrame: round2(b.hook - a.hook), wallRatio: round2(b.wallPerFrame / a.wallPerFrame) }; };
    run.timing = {
      // 稀疏那一趟:每隔 3 帧取一张,交出去的是整幅(量实体框)
      sparse: side(rounds.sparseSingle, rounds.sparsePair),
      // 满密度那一趟:每帧取一张;两张都截整幅,交出去的是收紧矩形
      dense: side(rounds.denseSingle, rounds.densePair),
      // 只作参考:两张都按收紧矩形截(画面会变,不能用,见 tightClip)
      densePairTightView: mid(rounds.densePairTightView),
    };
    // 截图矩形收紧以后画面变不变:只截一张,按收紧矩形截,和整幅截的同一帧比
    const tightDiff = { frames: 0, differFrames: 0, differPixels: 0, max: 0, box: null };
    await pass('single-tight', { clip: tight, count: Math.min(N, 30), onFrame: async (frame, png) => {
      const small = decodePngRgba(png), full = decodePngRgba(await fs.readFile(path.join(dir, `up-${pad(frame)}.png`)));
      const d = pixelDiff(small.data, cropRgba(full.data, width, tight), tight.w);
      tightDiff.frames++; if (d.differ) tightDiff.differFrames++; tightDiff.differPixels += d.differ; tightDiff.max = Math.max(tightDiff.max, d.max);
      // 不同的像素落在收紧矩形里的哪一块(矩形自己的坐标)
      if (d.box) tightDiff.box = unionRect(tightDiff.box, d.box);
    } });
    run.tightClip = tightDiff;
    say('timing', { tag, ...run.timing, tightClip: tightDiff });

    // ---------- 3. 四种流里放的东西:编码前、编码后、错开一帧
    const cache = new Map();
    const load = async (name, frame) => {
      const key = `${name}-${frame}`;
      if (cache.has(key)) return cache.get(key);
      const file = path.join(dir, `${name}-${pad(frame)}.png`);
      const data = decodePngRgba(await fs.readFile(file))?.data;
      if (!data) throw new Error(`解不开 ${file}`);
      cache.set(key, data);
      if (cache.size > 96) cache.delete(cache.keys().next().value);
      return data;
    };
    const pairVsExport = { upper: { differFrames: 0, differPixels: 0, max: 0 }, lower: { differFrames: 0, differPixels: 0, max: 0 } };
    const errors = Object.fromEntries(VARIANTS.map((v) => [v, { before: newError(), after: newError(), other: newError(), shifted: newError(), bytes: 0, covered: 0 }]));
    const floor = newError();
    const previewAt = Math.min(N - 2, 47);
    const segments = Math.ceil(N / SEGMENT_FRAMES);
    for (let seg = 0; seg < segments; seg++) {
      const from = seg * SEGMENT_FRAMES, to = Math.min(N - 1, from + SEGMENT_FRAMES - 1);
      const layers = Object.fromEntries(VARIANTS.map((v) => [v, []]));
      for (let f = from; f <= to; f++) {
        const upper = await load('up', f);
        const lower = absent[f] ? upper : await load('lo', f);
        const full = await load('full', f), below = await load('lower', f);
        const du = pixelDiff(upper, full), dl = pixelDiff(lower, below);
        if (du.differ) { pairVsExport.upper.differFrames++; pairVsExport.upper.differPixels += du.differ; pairVsExport.upper.max = Math.max(pairVsExport.upper.max, du.max); }
        if (dl.differ) { pairVsExport.lower.differFrames++; pairVsExport.lower.differPixels += dl.differ; pairVsExport.lower.max = Math.max(pairVsExport.lower.max, dl.max); }
        const glass = glassOf[f]?.length ? glassOf[f] : null;
        const made = {
          契约: absent[f] ? Buffer.alloc(tight.w * tight.h * 4) : diffContract(upper, lower, width, tight),
          两让: absent[f] ? Buffer.alloc(tight.w * tight.h * 4) : diffLayer(upper, lower, width, height, { crop: tight }).rgba,
          取层: absent[f] ? Buffer.alloc(tight.w * tight.h * 4) : diffLayer(upper, lower, width, height, { crop: tight, mask: glass ? glassMask(glass, tight) : null }).rgba,
          原样: cropRgba(upper, width, tight),
        };
        for (const v of VARIANTS) {
          tallyStraight(errors[v].before, made[v], tight, below, full, width);
          for (let i = 3; i < made[v].length; i += 4) if (made[v][i]) errors[v].covered++;
          layers[v].push(made[v]);
        }
        if (f === previewAt) for (const v of VARIANTS) await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-layer-${v}.png`), made[v], tight.w, tight.h);
      }
      for (const v of VARIANTS) {
        const enc = openStreamSegmentEncoder(ffmpeg, { encoder, fps: FPS, raw: { width: tight.w, height: tight.h } });
        for (const layer of layers[v]) await enc.write(layer);
        const done = await enc.finish();
        const { init, segments: parts } = splitFmp4(done.bytes);
        if (!check(parts.length === 1 && init.length > 0, `${tag} ${v}#${seg}:编出一个分段`, parts.length)) continue;
        errors[v].bytes += parts[0].length;
        const decoded = await decodeSegment(ffmpeg, init, parts[0], dir, `dec-${seg}`);
        const frameBytes = tight.w * (2 * (tight.h + 8)) * 3;
        if (!check(decoded.length === (to - from + 1) * frameBytes, `${tag} ${v}#${seg}:解出 ${to - from + 1} 帧`, decoded.length / frameBytes)) continue;
        for (let f = from; f <= to; f++) {
          const picture = decoded.subarray((f - from) * frameBytes, (f - from + 1) * frameBytes);
          tallyDecoded(errors[v].after, picture, tight, await load('lower', f), await load('full', f), width);
          if (v === '原样') tallyDecodedDirect(floor, picture, tight, await load('full', f), width);
          // 对照:同一帧盖回去的画面,和 7 帧以后(回绕)的真画面比
          const g = (f + 7) % N;
          tallyDecoded(errors[v].other, picture, tight, await load('lower', f), await load('full', g), width);
          // 下层错开一帧:流是第 f 帧的,下层和真画面都是第 f+1 帧的
          if (f + 1 < N) tallyDecoded(errors[v].shifted, picture, tight, await load('lower', f + 1), await load('full', f + 1), width);
          if (f === previewAt) {
            await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-back-${v}.png`), composeDecoded(picture, tight, await load('lower', f), width), tight.w, tight.h);
            await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-shifted-${v}.png`), composeDecoded(picture, tight, await load('lower', f + 1), width), tight.w, tight.h);
          }
        }
      }
    }
    await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-truth.png`), cropRgba(await load('full', previewAt), width, tight), tight.w, tight.h);
    await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-truth-next.png`), cropRgba(await load('full', previewAt + 1), width, tight), tight.w, tight.h);
    await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-whole.png`), await load('full', previewAt), width, height);
    run.pairVsExport = pairVsExport;
    check(pairVsExport.lower.differFrames === 0, `${tag}:藏起目标卡截的下张,和「只有下层」的工程照导出的办法渲出来的同一帧逐像素相同`, pairVsExport.lower);
    check(pairVsExport.upper.differFrames === 0, `${tag}:上张和「带目标卡」的工程照导出的办法渲出来的同一帧逐像素相同`, pairVsExport.upper);
    run.errors = Object.fromEntries(VARIANTS.map((v) => [v, {
      编码前: errorSummary(errors[v].before), 编码后: errorSummary(errors[v].after), 对照_别的时刻: errorSummary(errors[v].other), 下层错开一帧: errorSummary(errors[v].shifted),
      流的字节: errors[v].bytes, 不透明像素占收紧矩形: round2(errors[v].covered / (N * tight.w * tight.h)),
    }]));
    for (const v of VARIANTS) say('errors', { tag, v, ...run.errors[v] });
    run.codecFloor = errorSummary(floor);
    say('floor', { tag, ...run.codecFloor });
    const mine = run.errors.取层, asIs = run.errors.原样;
    check(mine.编码前.mean <= 0.5 && mine.编码前.max <= 2.5, `${tag}:取层在编码前盖回去和真画面差在量化误差以内`, mine.编码前);
    // 「编码误差以内」的参照:真画面原样过一遍同一个编码器的误差
    check(mine.编码后.mean <= run.codecFloor.mean + 0.5 && mine.编码后.bad <= run.codecFloor.bad * 1.25 + mine.编码后.pixels * 0.001,
      `${tag}:取层在编码后盖回去和真画面的差,不超过真画面原样过一遍编码器的差`, { layer: mine.编码后, floor: run.codecFloor });
    check(mine.对照_别的时刻.mean > 3 * mine.编码后.mean && mine.对照_别的时刻.bad > 5 * (mine.编码后.bad + 1), `${tag}:对照(别的时刻的真画面)明显更大`, { same: mine.编码后, other: mine.对照_别的时刻 });
    run.verdict = { 取层比原样_编码后平均差: [mine.编码后.mean, asIs.编码后.mean], 取层比原样_下层错开一帧: [mine.下层错开一帧.mean, asIs.下层错开一帧.mean] };
    cache.clear();
    if (!KEEP) for (const name of await fs.readdir(dir)) await fs.rm(path.join(dir, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await bakery?.close(); } catch { /* ignore */ }
  dropStreamEncoderSpares();
  try { await media?.close(); } catch { /* ignore */ }
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) {
    try {
      for (const name of await fs.readdir(OUT)) if (name !== 'result.json' && name !== 'previews') await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* ignore */ }
  }
}
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
// 结论:每个场景、每种画幅一段
const brief = { ok: out.ok, fails, encoder: out.encoder, runs: out.runs.map((r) => ({ scene: r.scene, size: r.size, tight: r.tight, glass: r.glass, timing: r.timing, tightClip: r.tightClip, pairVsExport: r.pairVsExport, upperSameAsSingle: r.upperSameAsSingle, codecFloor: r.codecFloor, errors: r.errors, verdict: r.verdict })) };
console.log(JSON.stringify(brief, null, 2));
void ROOT; void fsSync;
process.exit(out.ok ? 0 : 1);
