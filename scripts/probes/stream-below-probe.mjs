/**
 * 依赖下层的卡的轨道流(`kind: 'below'`)**生产侧**的端到端探针
 * (`docs/plan/render-refactor-task.md`「戊二」的验收里产流那一半;`docs/plan/prerender-products-contract.md` 第 5.2、5.3 节)。
 *
 *   node scripts/probes/stream-below-probe.mjs [--origin http://127.0.0.1:27800 | --port 27804] [--media-port 27811]
 *        [--scenes a,b] [--sizes 960x540] [--out <dir>] [--keep] [--json <file>]
 *
 * 给了 `--origin` 就用那台 dev server;没给就自己在检出根起一台(`--port`,另占 +1、+2;不碰 5190～5192),用完按进程号收掉。
 * 本进程里直接起 `FramePipeline`(同预渲染进程的代码),库根放临时目录;这种流产品里缺省开着
 * (探针另明着设一次 `PROMPTCUT_TEST_BELOW_STREAMS=1`)。贴回舞台的那一半在 `stream-below-stage-probe.mjs`。两个场景(见 `below-stream-common.mjs`):
 *
 *   甲  毛玻璃卡压在一张会动的卡(粒子)和一段视频上面
 *   乙  下层是半透明的(不透明度 0.6、带阴影的药丸),上面压同一张毛玻璃卡
 *
 * 毛玻璃卡钉成重卡(`pipeline.streamPicked` 全选)。逐条核对:
 *
 *   1. 这种流产得出来:计划里有一条 `kind: 'below'`、`plane: 'stage'` 的流挂在毛玻璃卡上,全部分段满密度;
 *      差分取层的记录里实测没有不过的(`below.failed` 为空、没有打开「下张先丢一张」);
 *   2. 流只含目标卡改动的那一块:稀疏那一趟量出的收紧矩形明显小于整幅;流从毛玻璃卡自己的第一帧(第 6 帧,不是 15 的倍数)起分段,
 *      里面没有它入场之前的帧(原来按项目帧号分段时,头一个分段里有 6 帧是入场之前的、全透明);
 *      收紧矩形里目标卡没有改动的像素(带目标卡和不带目标卡两幅导出画面逐像素相同的地方)解出来也是透明的;
 *   3. 把解出来的每一帧盖回「同一时刻只有下层的导出画面」上,和「同一时刻整幅的导出画面」比(预乘色,满分 255):
 *      差不超过「整幅的导出画面原样过一遍同一个编码器」的差(这就是编码误差);带对照:和 7 帧以后的整幅画面比明显更大;
 *   4. 下层改一张卡:这条流的键变了,就绪索引里这张卡的层换成新键,生产者手里不再有旧键的流(旧分段不再被认);
 *      改回来,键回到原来那一个,旧分段原样认回来、一个都不重产;在它上面加一张卡:键不变,分段一个都不重产;
 *   5. 别的流不受影响:下层那张独立卡照旧有自己的单卡流。
 *
 * 「下层三」(贴回舞台)接着用:`--keep` 留着库根(每个场景一个 `lib-<场景>-<画幅>`),结论里有流键、收紧矩形、每个分段的文件;
 * 两幅导出画面怎么渲、怎么把一帧盖回去再比,都在 `below-stream-common.mjs` 里,播放那一头拿舞台截图换掉「解出来的帧」即可。
 *
 * 输出 JSON 结论,过程写 stderr;任何一条不过就以非零退出。耗时只记录。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { SEGMENT_FRAMES, splitFmp4, isolatedBelowProject, belowStreamsEnabled, BELOW_STREAMS_DEFAULT } from '../../server/frame-stream.mjs';
import { BELOW_STREAM_VERSION } from '../../server/card-identity.mjs';
import { streamSegmentFirstFrame, streamSegmentFrameCount } from '../../src/render/streamSegments.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { findFfmpeg, openStreamSegmentEncoder, dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';
import { decodePngRgba } from '../../server/bakery/capture-canvas.mjs';
import { FPS, DURATION, TARGET, ABOVE, scenarioProject, lowerClipIds, startDevServer, ensureVideo, serveMedia, emptyUrlOf, decodeSegment,
  newError, errorSummary, tallyDecoded, tallyDecodedDirect, composeDecoded, cropRgba, savePreview, round2, sleep } from './below-stream-common.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '27804', args));
const MEDIA_PORT = Number(flagArg('media-port', '27811', args));
const SCENES = String(flagArg('scenes', 'a,b', args)).split(',').map((s) => s.trim()).filter((s) => s === 'a' || s === 'b');
const SIZES = String(flagArg('sizes', '960x540', args)).split(',').map((s) => s.trim().split('x').map(Number)).filter(([w, h]) => w > 0 && h > 0);
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-below-probe-${Date.now().toString(36)}`));
// 这种流产品里缺省开着;这里明着设一次,不受外面环境变量的影响。一个会话、一条一条地产
process.env.PROMPTCUT_TEST_BELOW_STREAMS = '1';
process.env.PROMPTCUT_STREAM_POOL = '1';

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); say('FAIL', { label, extra }); } return cond; };
async function until(label, fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await sleep(everyMs);
  }
}
const SCENE_NAME = { a: '甲', b: '乙' };
const N = DURATION * FPS;
const pad = (n) => String(n).padStart(4, '0');

const out = { library: OUT, switchDefault: BELOW_STREAMS_DEFAULT, belowStreamVersion: BELOW_STREAM_VERSION, runs: [] };
await fs.mkdir(OUT, { recursive: true });
let dev = null, media = null, bakery = null;
const pipelines = [];
try {
  check(BELOW_STREAMS_DEFAULT === true, '这种流缺省是开的', BELOW_STREAMS_DEFAULT);
  check(belowStreamsEnabled() === true, '探针里开着');
  check(BELOW_STREAM_VERSION === 1, '流里放什么的版本是 1', BELOW_STREAM_VERSION);
  const ffmpeg = await findFfmpeg();
  let origin = ORIGIN;
  if (!origin) { dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'belowprobe' }); origin = dev.origin; say('spawn', { pid: dev.pid, port: PORT }); }
  out.origin = origin;
  const mediaDir = path.join(OUT, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  media = await serveMedia(MEDIA_PORT, mediaDir);

  for (const kind of SCENES) for (const [width, height] of SIZES) {
    const tag = `${SCENE_NAME[kind]} ${width}x${height}`;
    const run = { scene: SCENE_NAME[kind], size: `${width}x${height}` };
    out.runs.push(run);
    const dir = path.join(OUT, `ref-${kind}-${width}x${height}`);
    await fs.mkdir(dir, { recursive: true });
    const mediaUrl = kind === 'a' ? media.url(path.basename(await ensureVideo(ffmpeg, mediaDir, width, height))) : '';
    const project = scenarioProject(kind, { width, height, mediaUrl });
    const edited = scenarioProject(kind, { width, height, mediaUrl, edit: 'below' });

    // ---------- 1. 产流
    const pipeline = new FramePipeline({ root: path.join(OUT, `lib-${kind}-${width}x${height}`), origin: () => origin, interactive: true, playhead: () => null });
    pipelines.push(pipeline);
    pipeline.streamPicked = () => true; // 钉成重卡
    const producer = pipeline.streamProducer();
    producer.attachRoute();
    const layers = [];
    pipeline.readyIndex.subscribe((message) => { if (message.type === 'layer' && message.kind === 'stream') layers.push({ at: Date.now(), ...message }); });
    const allDense = () => {
      const status = producer.status();
      if (!status.streams.some((s) => s.kind === 'below')) return null;
      for (const s of status.streams) for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
      return !producer.workers.size && !producer.encoding.size ? status : null;
    };
    const t0 = Date.now();
    await pipeline.preload(project);
    const status = await until(`${tag}:全部分段满密度`, allDense, 900_000, 500);
    if (!status) throw new Error(`${tag}:生产没做完:${JSON.stringify(producer.status().log.slice(-8))}`);
    run.produceMs = Date.now() - t0;
    out.encoder = status.encoder;
    const row = status.streams.find((s) => s.kind === 'below');
    const state = [...producer.streams.values()].find((s) => s.spec.kind === 'below');
    const { spec, manifest } = state;
    run.stream = { streamKey: spec.streamKey, contentKey: spec.contentKey, clipIds: spec.clipIds, belowClipIds: spec.belowClipIds, belowScene: spec.belowScene, hasMedia: spec.hasMedia,
      replay: spec.replay, mountFrame: spec.mountFrame, bound: manifest.bound, tight: manifest.tight, segments: spec.lastSegment - spec.firstSegment + 1,
      below: row.below, capture: row.capture, resets: row.resets, replayedFrames: row.replayedFrames,
      files: Object.fromEntries(Object.entries(manifest.segments).map(([n, s]) => [n, { file: s.file, init: s.init, bytes: s.bytes, stride: s.stride }])) };
    run.kinds = status.streams.map((s) => ({ kind: s.kind, clipIds: s.clipIds }));
    say('produced', { tag, ms: run.produceMs, kinds: run.kinds, tight: manifest.tight, below: row.below });
    check(status.streams.filter((s) => s.kind === 'below').length === 1 && spec.clipIds.length === 1 && spec.clipIds[0] === TARGET, `${tag}:有一条依赖下层的流,挂在毛玻璃卡上`, run.kinds);
    check(manifest.kind === 'below' && manifest.plane === 'stage', `${tag}:清单里是 below、舞台坐标`, { kind: manifest.kind, plane: manifest.plane });
    check(JSON.stringify(spec.belowClipIds) === JSON.stringify([...lowerClipIds(kind)].reverse()), `${tag}:算进键里的下层正好是场景里那几层(画家顺序,下面的在前)`, spec.belowClipIds);
    check(spec.belowScene === false, `${tag}:键没有退回整个项目的键`);
    check(spec.hasMedia === (kind === 'a'), `${tag}:有画面素材时截图前等素材就位`, spec.hasMedia);
    check(row.below && row.below.failed === null && row.below.primeLower === false, `${tag}:差分取层的实测没有不过的`, row.below);
    check(row.below?.checks >= 2 * run.stream.segments, `${tag}:稀疏、满密度两趟的每个分段都实测过`, row.below?.checks);
    check(row.below?.glassFrames > 0, `${tag}:量到了毛玻璃的外框`, row.below?.glassFrames);
    // 分段从目标卡自己的第一帧起数(0.2 秒入场 → 第 6 帧),流里没有它入场之前的帧
    const ENTRY = Math.ceil(0.2 * FPS - 1e-9);
    check(spec.originFrame === ENTRY && spec.firstSegment === 0 && manifest.originFrame === ENTRY && ENTRY % SEGMENT_FRAMES !== 0,
      `${tag}:流的第一帧是毛玻璃卡入场的那一帧(第 ${ENTRY} 帧,不是 15 的倍数),清单记着它`, { originFrame: spec.originFrame, firstSegment: spec.firstSegment, manifest: manifest.originFrame });
    check(row.below?.absent === 0, `${tag}:截的帧里没有「目标卡不在页面上」的(流不再含入场之前的帧)`, row.below?.absent);
    const lowerCard = kind === 'a' ? 'clip-move' : 'clip-block';
    check(status.streams.some((s) => s.kind === 'card' && s.clipIds[0] === lowerCard), `${tag}:下层那张独立卡照旧有自己的单卡流`, run.kinds);
    // 2a. 只含目标卡改动的那一块
    const tight = manifest.tight;
    run.tightShare = tight ? round2(tight.w * tight.h / (width * height)) : null;
    check(!!tight && tight.w * tight.h < width * height * 0.5, `${tag}:收紧矩形明显小于整幅`, { tight, share: run.tightShare });

    // ---------- 2. 两幅导出画面:整幅的、只有下层的
    const emptyUrl = emptyUrlOf(origin, { width, height });
    if (!bakery) bakery = await openBakery({ url: emptyUrl });
    const exportFrames = async (proj, name) => {
      await bakery.reset(proj, emptyUrl);
      bakery.streamLease = null;
      await bakeFrames(bakery, { out: path.join(dir, `export-${name}`), fps: FPS, frames: `0-${N - 1}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
        onFrame: async (i, buf) => { await fs.writeFile(path.join(dir, `${name}-${pad(i)}.png`), buf); } });
    };
    await exportFrames(project, 'whole');
    await exportFrames(isolatedBelowProject(project, spec, { withTarget: false }), 'lower');
    const cache = new Map();
    const load = async (name, frame) => {
      const key = `${name}-${frame}`;
      if (cache.has(key)) return cache.get(key);
      const data = decodePngRgba(await fs.readFile(path.join(dir, `${name}-${pad(frame)}.png`)))?.data;
      if (!data) throw new Error(`解不开 ${name}-${frame}`);
      cache.set(key, data);
      if (cache.size > 64) cache.delete(cache.keys().next().value);
      return data;
    };

    // ---------- 3. 逐个分段解出来,盖回去比
    const after = newError(), other = newError(), floor = newError();
    const quiet = { before: { frames: 0, alphaMax: 0, alphaSum: 0, pixels: 0 }, unchanged: { pixels: 0, alphaSum: 0, over16: 0 } };
    const previewAt = 47;
    let streamBytes = 0;
    for (let n = spec.firstSegment; n <= spec.lastSegment; n++) {
      const seg = manifest.segments[n];
      if (!check(seg?.stride === 1, `${tag}#${n}:满密度`, seg)) continue;
      const meta = manifest.inits[seg.init];
      const rect = { x: meta.rect.x + spec.offset.x, y: meta.rect.y + spec.offset.y, w: meta.rect.w, h: meta.rect.h };
      check(JSON.stringify(meta.rect) === JSON.stringify(tight), `${tag}#${n}:用的是收紧矩形`, meta.rect);
      const init = await fs.readFile(producer.store.initFile(spec.streamKey, seg.init));
      const bytes = await fs.readFile(path.join(producer.store.dir(spec.streamKey), seg.file));
      streamBytes += bytes.length;
      const decoded = await decodeSegment(ffmpeg, init, bytes, dir, `seg-${n}`);
      const frameBytes = rect.w * 2 * (rect.h + 8) * 3;
      if (!check(decoded.length === seg.samples * frameBytes, `${tag}#${n}:解出 ${seg.samples} 帧`, decoded.length / frameBytes)) continue;
      // 参照:整幅的导出画面裁到同一个矩形,原样过一遍同一个编码器
      // 第 n 段盖住的帧:从这条流自己的第一帧起数(`src/render/streamSegments.mjs`),末段到它的最后一帧为止
      const firstFrame = streamSegmentFirstFrame(n, spec.originFrame);
      check(seg.samples === streamSegmentFrameCount(n, spec.originFrame, spec.lastFrame), `${tag}#${n}:样本数 = 这一段盖住的帧数`, { samples: seg.samples, firstFrame, lastFrame: spec.lastFrame });
      const plain = openStreamSegmentEncoder(ffmpeg, { encoder: status.encoder, fps: FPS, raw: { width: rect.w, height: rect.h } });
      for (let k = 0; k < seg.samples; k++) await plain.write(cropRgba(await load('whole', firstFrame + k), width, rect));
      const plainParts = splitFmp4((await plain.finish()).bytes);
      const plainDecoded = await decodeSegment(ffmpeg, plainParts.init, plainParts.segments[0], dir, `plain-${n}`);
      for (let k = 0; k < seg.samples; k++) {
        const f = firstFrame + k;
        const picture = decoded.subarray(k * frameBytes, (k + 1) * frameBytes);
        const whole = await load('whole', f), lower = await load('lower', f);
        tallyDecoded(after, picture, rect, lower, whole, width);
        tallyDecoded(other, picture, rect, lower, await load('whole', (f + 7) % N), width);
        tallyDecodedDirect(floor, plainDecoded.subarray(k * frameBytes, (k + 1) * frameBytes), rect, whole, width);
        // 2b. 解出来的不透明度:入场前的帧整张、其余的帧里两幅导出画面相同的像素
        const alphaTop = (rect.h + 8) * rect.w * 3;
        const absent = f < Math.ceil(0.2 * FPS - 1e-9);
        if (absent) quiet.before.frames++;
        for (let y = 0; y < rect.h; y++) for (let x = 0; x < rect.w; x++) {
          const a = picture[alphaTop + (y * rect.w + x) * 3];
          if (absent) { quiet.before.pixels++; quiet.before.alphaSum += a; if (a > quiet.before.alphaMax) quiet.before.alphaMax = a; continue; }
          const i = ((y + rect.y) * width + x + rect.x) * 4;
          if (whole[i] === lower[i] && whole[i + 1] === lower[i + 1] && whole[i + 2] === lower[i + 2] && whole[i + 3] === lower[i + 3]) {
            quiet.unchanged.pixels++; quiet.unchanged.alphaSum += a; if (a > 16) quiet.unchanged.over16++;
          }
        }
        if (f === previewAt) {
          await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-back.png`), composeDecoded(picture, rect, lower, width), rect.w, rect.h);
          await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-truth.png`), cropRgba(whole, width, rect), rect.w, rect.h);
          await savePreview(path.join(OUT, 'previews', `${kind}-${width}x${height}-whole.png`), whole, width, height);
        }
      }
    }
    run.streamBytes = streamBytes;
    run.error = { 盖回去对整幅的导出画面: errorSummary(after), 参照_整幅画面原样过一遍编码器: errorSummary(floor), 对照_七帧以后的整幅画面: errorSummary(other) };
    run.transparent = {
      入场前的帧: { frames: quiet.before.frames, 不透明度平均: round2(quiet.before.alphaSum / Math.max(1, quiet.before.pixels)), 不透明度最大: quiet.before.alphaMax },
      收紧矩形里没被改动的像素: { pixels: quiet.unchanged.pixels, 不透明度平均: round2(quiet.unchanged.alphaSum / Math.max(1, quiet.unchanged.pixels)), 超过16的占比: +(quiet.unchanged.over16 / Math.max(1, quiet.unchanged.pixels)).toFixed(4) },
    };
    say('compare', { tag, ...run.error, transparent: run.transparent });
    const got = run.error.盖回去对整幅的导出画面, ref = run.error.参照_整幅画面原样过一遍编码器, ctl = run.error.对照_七帧以后的整幅画面;
    const streamFrames = spec.lastFrame - spec.originFrame + 1;
    check(got.pixels === streamFrames * tight.w * tight.h, `${tag}:这条流的 ${streamFrames} 帧(第 ${spec.originFrame}～${spec.lastFrame} 帧)都比过了`, got.pixels / (tight.w * tight.h));
    check(got.mean <= ref.mean + 0.5 && got.bad <= ref.bad * 1.25 + got.pixels * 0.001, `${tag}:盖回去和整幅的导出画面的差在编码误差以内(不超过整幅画面原样过一遍编码器的差)`, { got, ref });
    check(ctl.mean > 3 * got.mean && ctl.bad > 5 * (got.bad + 1), `${tag}:对照(别的时刻的整幅画面)明显更大`, { got, ctl });
    check(quiet.before.frames === 0, `${tag}:流里没有入场之前的帧`, run.transparent.入场前的帧);
    check(quiet.unchanged.pixels > 0 && quiet.unchanged.alphaSum / quiet.unchanged.pixels < 1.5 && quiet.unchanged.over16 / quiet.unchanged.pixels < 0.01,
      `${tag}:收紧矩形里目标卡没有改动的像素解出来是透明的`, run.transparent.收紧矩形里没被改动的像素);

    // ---------- 4. 下层改一张卡:键变,旧分段不再被认;改回来原样认回
    const oldKey = spec.streamKey;
    const keyOfTarget = () => [...producer.streams.values()].find((s) => s.spec.kind === 'below')?.spec.streamKey ?? null;
    const segmentsBefore = producer.stats.segments;
    const editedAt = Date.now();
    await pipeline.preload(edited);
    const newKey = await until(`${tag}:改了下层以后计划换了一版`, () => { const k = keyOfTarget(); return k && k !== oldKey ? k : null; }, 120_000, 100);
    run.edit = { oldKey, newKey };
    if (check(!!newKey, `${tag}:下层改一张卡,这条流的键变了`, { oldKey, now: keyOfTarget() })) {
      check(!producer.streams.has(oldKey), `${tag}:生产者手里不再有旧键的流`);
      const fresh = producer.streams.get(newKey);
      const reused = Object.values(fresh.manifest.segments).filter((s) => Object.values(manifest.segments).some((o) => o.file === s.file));
      check(reused.length === 0, `${tag}:新键的清单里没有旧分段`, reused.length);
      const firstLayer = await until(`${tag}:新键的层发出来`, () => layers.find((l) => l.at >= editedAt && l.clipId === TARGET && l.key === newKey), 300_000, 200);
      const oldAfter = layers.filter((l) => l.at >= editedAt && l.clipId === TARGET && l.key === oldKey);
      check(!!firstLayer && oldAfter.length === 0, `${tag}:改了以后就绪索引里这张卡的层只发新键,旧键不再发`, { newLayer: !!firstLayer, oldAfter: oldAfter.length });
      // 只记录,不当通过条件:被改的那张下层卡自己的单卡流键变没变。乙里它带着强调(阴影),现有的单卡流键不看强调前面那张卡的参数,
      // 所以不变(`main` 上原有的问题,见报告);依赖下层的流的键取的是带整条输入链的缓存内容键,不受它影响
      run.edit.lowerCardStreamKeyChanged = !producer.streams.has(status.streams.find((s) => s.kind === 'card' && s.clipIds[0] === lowerCard)?.streamKey);
    }
    // 改回来:键回到原来那一个,盘上的旧分段原样认回,不重产
    const producedMid = producer.stats.segments;
    const backAt = Date.now();
    await pipeline.preload(project);
    const back = await until(`${tag}:改回来以后键回到原来那一个`, () => (keyOfTarget() === oldKey ? oldKey : null), 120_000, 100);
    if (check(!!back, `${tag}:改回来,键回到原来那一个`, keyOfTarget())) {
      const again = producer.streams.get(oldKey);
      const sameFiles = Object.entries(manifest.segments).every(([n, s]) => again.manifest.segments[n]?.file === s.file && again.manifest.segments[n]?.stride === 1);
      check(sameFiles, `${tag}:旧分段原样认回(同一批文件)`);
      const layer = await until(`${tag}:改回来以后旧键的层重新发出来`, () => layers.find((l) => l.at >= backAt && l.clipId === TARGET && l.key === oldKey), 60_000, 200);
      check(!!layer, `${tag}:改回来以后就绪索引里又是原来那个键`);
      await sleep(1500);
      const remade = Object.entries(again.manifest.segments).filter(([n, s]) => manifest.segments[n]?.file !== s.file).length;
      check(remade === 0, `${tag}:改回来以后这条流一个分段都没有重产`, remade);
    }
    run.edit.segmentsProducedWhileEdited = producedMid - segmentsBefore;
    // 在它上面加一张卡:键不变,旧分段照用,一个都不重产
    await pipeline.preload(scenarioProject(kind, { width, height, mediaUrl, edit: 'above' }));
    const withAbove = await until(`${tag}:上面加了一张卡以后计划换了一版`, () => ([...producer.streams.values()].some((s) => s.spec.clipIds.includes(ABOVE)) ? keyOfTarget() : null), 120_000, 100);
    run.edit.keyWithLayerAbove = withAbove;
    if (check(withAbove === oldKey, `${tag}:在它上面加一张卡,这条流的键不变`, { oldKey, withAbove })) {
      await sleep(1500);
      const kept = producer.streams.get(oldKey);
      const same = Object.entries(manifest.segments).every(([n, s]) => kept.manifest.segments[n]?.file === s.file);
      check(same, `${tag}:上面加了一张卡,这条流的分段一个都没有重产`);
    }

    cache.clear();
    run.log = producer.status().log.map((l) => l.message).filter((m) => /差分|收紧|失败|没过/.test(m)).slice(-12);
    await pipeline.close();
    pipelines.splice(pipelines.indexOf(pipeline), 1);
    dropStreamEncoderSpares();
    if (!KEEP) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  for (const pipeline of pipelines) { try { await pipeline.close(); } catch { /* ignore */ } }
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
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
