/**
 * 依赖下层的卡下面压着一张**中途进场**的 motion 式卡时,它的流产得对不对(`server/frame-stream.mjs` 的 `BELOW_DISCARD_SHOT`)。
 *
 *   node scripts/probes/below-late-lower-probe.mjs (--origin http://127.0.0.1:<dev server> | --port 26980)
 *        [--pill-start 1] [--pill-text 对照卡] [--out <目录>] [--json <文件>] [--keep]
 *
 * 项目(960×540,4 秒):上面是毛玻璃卡(里程表,第 6 帧入场),下面是 `punch-pill`,从 `--pill-start` 秒进场(缺省 1 秒,第 30 帧)。
 * 本进程里起一个 `FramePipeline`(同预渲染进程的代码),只把毛玻璃卡钉成重卡。
 *
 * 这个场景查出过的毛病(2026-10-14,修之前):下层那张卡上面压着毛玻璃时,只推帧不截图的那几拍里它的动画在画面上不往前走
 * (动画的时刻在页面里是对的,合成出来的像素停在挂载那一帧),所以
 *   - 稀疏版(每个分段只截第一帧)里,药丸比该有的样子落后五到七帧;
 *   - 断了租约单独重产的满密度分段(要从挂载帧回放过来)里,药丸停在它刚进场的样子;
 *   - 画面还在一拍一拍地追,差分取层的自检(藏起目标卡再露出来,带目标卡的那张要不变)有时过不了,整条流被判死、不再产。
 * 修法是这种流推过去的每一拍都画一张丢掉。这支探针把三条都钉住,**不靠碰运气**:第 2、3 条每次都能量出来。
 *
 * 逐条核对(参照是导出页:整幅的画面 R 和只有下层的画面 L;把流里解出来的那一层盖回 L,在流的矩形里和 R 比,按预乘色,满分 255):
 *   1. 稀疏那一趟、满密度那一趟都产完,差分取层没有判死。
 *   2. 满密度(接着租约一路产下来的):每一帧盖回去和导出页同一帧的平均差都在编码误差的量级。
 *   3. 稀疏版:每个分段的那一张,盖回它那一帧的下层,同样对得上(修之前药丸进场以后的分段对不上)。
 *   4. 把后面几个分段作废、倒着一个一个重产(每个都断租约,从挂载帧回放过来):重产出来的和第 2 条里的逐帧相同(解码以后的平均差接近 0),
 *      盖回去同样对得上(修之前停在药丸刚进场的样子)。
 * 对照:同一帧盖回去和 6 帧以前的导出画面比,药丸入场那一段明显更差(这套比法量得出「落后几帧」)。
 *
 * 输出 JSON 结论,过程写 stderr;任何一条不过就以非零退出。耗时只记录。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { isolatedBelowProject } from '../../server/frame-stream.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { findFfmpeg, dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';
import { decodePngRgba } from '../../server/bakery/capture-canvas.mjs';
import { streamSegmentFirstFrame } from '../../src/render/streamSegments.mjs';
import { startDevServer, emptyUrlOf, decodeSegment, newError, errorSummary, tallyDecoded, sleep, round2 } from './below-stream-common.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
if (!ORIGIN && !PORT) { console.error('要给 --origin <dev server> 或 --port <自己起一台>'); process.exit(2); }
const pillStart = Number(flagArg('pill-start', '1', args));
const pillText = String(flagArg('pill-text', '对照卡', args));
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-below-late-lower-${Date.now().toString(36)}`));
process.env.PROMPTCUT_STREAM_POOL = '1';

const W = 960, H = 540, FPS = 30, SECONDS = 4, N = SECONDS * FPS, TARGET = 'clip-t';
const PILL_FIRST = Math.ceil(pillStart * FPS - 1e-9);
const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 700))); say('FAIL', { label, extra }); } return !!cond; };

const project = { id: `below-late-lower-${pillStart}-${pillText.length}`, name: '下层中途进场', width: W, height: H, fps: FPS, duration: SECONDS,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-t', name: 't', hidden: false, clips: [{ id: TARGET, kind: 'card', cardId: 'odometer', start: 0.2, end: SECONDS, params: { position: 'left', value: 86420, label: 'x' },
      frame: { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: 0.5 } }] },
    { id: 'tr-p', name: 'p', hidden: false, clips: [{ id: 'clip-p', kind: 'card', cardId: 'punch-pill', start: pillStart, end: SECONDS, params: { text: pillText }, frame: { x: 320, y: 150, w: 560, h: 200, anchor: [0.5, 0.5] } }] },
  ] };

const out = { out: OUT, pillStart, pillText, pillFirstFrame: PILL_FIRST };
await fs.mkdir(OUT, { recursive: true });
let dev = null, pipeline = null, bakery = null;
const started = Date.now();
try {
  const ffmpeg = await findFfmpeg();
  let origin = ORIGIN;
  if (!origin) {
    process.env.PROMPTCUT_EXPORT_DIR = path.join(OUT, 'export');
    await fs.mkdir(process.env.PROMPTCUT_EXPORT_DIR, { recursive: true });
    dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'belowlate' });
    origin = dev.origin;
    say('spawn', { pid: dev.pid, port: PORT });
  }
  origin = origin.replace(/\/+$/, '');

  /* ---------- 产流:先只产稀疏那一趟 */
  pipeline = new FramePipeline({ root: path.join(OUT, 'lib'), origin: () => origin, interactive: true, playhead: () => null });
  pipeline.streamPicked = (_entry, clipId) => clipId === TARGET;
  const producer = pipeline.streamProducer();
  producer.attachRoute();
  let holdDense = true;
  const nextTask = producer.nextTask.bind(producer);
  producer.nextTask = (b) => { const task = nextTask(b); return task && task.stride === 1 && holdDense ? null : task; };
  await pipeline.preload(project);
  const stateNow = () => [...producer.streams.values()].find((s) => s.spec.kind === 'below') ?? null;
  const strides = () => { const s = stateNow(); return s ? Array.from({ length: s.spec.lastSegment + 1 }, (_, n) => s.manifest.segments[n]?.stride ?? 0) : []; };
  const idle = () => !producer.workers.size && !producer.encoding.size;
  /** 等到 `done(每段的间隔)` 成立,或者这条流被判死;超时也回来(照实记) */
  const wait = async (done, ms = 240_000) => {
    const t0 = Date.now();
    for (;;) {
      await sleep(400);
      const s = stateNow();
      if (s?.below?.failed) return 'failed';
      if (s && idle() && done(strides())) return 'ok';
      if (Date.now() - t0 > ms) return 'timeout';
    }
  };
  const sparse = await wait((st) => st.length > 0 && st.every((x) => x >= 1));
  const state = stateNow();
  out.sparse = { result: sparse, strides: strides(), below: state?.below ? { failed: state.below.failed, checks: state.below.checks, last: state.below.last } : null };
  say('sparse', out.sparse);
  if (!check(sparse === 'ok' && out.sparse.strides.every((x) => x > 1), '稀疏那一趟产完,差分取层没有判死', out.sparse)) throw new Error('稀疏那一趟没产完');
  const { spec } = state;
  out.stream = { originFrame: spec.originFrame, lastSegment: spec.lastSegment, mountFrame: spec.mountFrame, replay: spec.replay, belowClipIds: spec.belowClipIds };
  check(spec.replay === true && spec.belowClipIds.includes('clip-p'), '这条流要回放(下层是 motion 式的卡)', out.stream);

  /** 把第 n 段解出来:每帧一块(上半预乘色、下半不透明度),和它用的矩形 */
  const decodeOf = async (n, tag) => {
    const seg = stateNow().manifest.segments[n];
    const meta = stateNow().manifest.inits[seg.init];
    const rect = { x: meta.rect.x + spec.offset.x, y: meta.rect.y + spec.offset.y, w: meta.rect.w, h: meta.rect.h };
    const init = await fs.readFile(producer.store.initFile(spec.streamKey, seg.init));
    const bytes = await fs.readFile(path.join(producer.store.dir(spec.streamKey), seg.file));
    const decoded = await decodeSegment(ffmpeg, init, bytes, OUT, `${tag}-${n}`);
    const frameBytes = rect.w * 2 * (rect.h + 8) * 3;
    return { seg, rect, frames: Array.from({ length: Math.floor(decoded.length / frameBytes) }, (_, k) => decoded.subarray(k * frameBytes, (k + 1) * frameBytes)) };
  };
  const sparseDecoded = [];
  for (let n = 0; n <= spec.lastSegment; n++) sparseDecoded.push(await decodeOf(n, 'sparse'));

  holdDense = false;
  producer.kick();
  const dense = await wait((st) => st.every((x) => x === 1));
  out.dense = { result: dense, strides: strides(), below: { failed: stateNow().below.failed, checks: stateNow().below.checks, last: stateNow().below.last }, capture: stateNow().capture ?? null };
  say('dense', out.dense);
  if (!check(dense === 'ok', '满密度那一趟产完,差分取层没有判死', out.dense)) throw new Error('满密度那一趟没产完');
  const denseDecoded = [];
  for (let n = 0; n <= spec.lastSegment; n++) denseDecoded.push(await decodeOf(n, 'dense'));

  /* ---------- 参照:导出页的两幅画面 */
  const emptyUrl = emptyUrlOf(origin, { width: W, height: H });
  bakery = await openBakery({ url: emptyUrl });
  const exportAll = async (proj) => {
    await bakery.reset(proj, emptyUrl);
    bakery.streamLease = null;
    const frames = new Map();
    await bakeFrames(bakery, { out: path.join(OUT, 'ref'), fps: FPS, frames: `0-${N - 1}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
      onFrame: async (i, buf) => { frames.set(i, decodePngRgba(Buffer.from(buf)).data); } });
    return frames;
  };
  const whole = await exportAll(project);
  const lower = await exportAll(isolatedBelowProject(project, spec, { withTarget: false }));
  say('exported', { frames: whole.size });
  /** 第 f 帧的那一层盖回 `lowerAt` 帧的下层,和 `truthAt` 帧的整幅比:平均差 */
  const meanOf = (picture, rect, lowerAt, truthAt) => { const e = newError(); tallyDecoded(e, picture, rect, lower.get(lowerAt), whole.get(truthAt), W); return errorSummary(e).mean; };
  const LAG = 6;

  /* ---------- 2. 满密度(接着租约产下来的) */
  {
    const rows = [];
    for (let n = 0; n <= spec.lastSegment; n++) {
      const first = streamSegmentFirstFrame(n, spec.originFrame);
      denseDecoded[n].frames.forEach((picture, k) => { const f = first + k; rows.push({ f, same: meanOf(picture, denseDecoded[n].rect, f, f), lagged: f - LAG >= 0 ? meanOf(picture, denseDecoded[n].rect, f, f - LAG) : null }); });
    }
    const worst = rows.reduce((a, b) => (b.same > a.same ? b : a));
    const entering = rows.filter((r) => r.f >= PILL_FIRST + LAG && r.f < PILL_FIRST + 14);
    out.denseCheck = { frames: rows.length, 平均: round2(rows.reduce((s, r) => s + r.same, 0) / rows.length), 最差的一帧: worst,
      药丸入场那一段_对同一帧: round2(entering.reduce((s, r) => s + r.same, 0) / Math.max(1, entering.length)), 对照_对六帧以前: round2(entering.reduce((s, r) => s + r.lagged, 0) / Math.max(1, entering.length)) };
    say('2-dense', out.denseCheck);
    check(rows.length === spec.lastFrame - spec.originFrame + 1 && worst.same < 3, '满密度:每一帧盖回去和导出页同一帧的差都在编码误差的量级(平均差小于 3)', out.denseCheck);
    check(out.denseCheck.对照_对六帧以前 > out.denseCheck.药丸入场那一段_对同一帧 * 1.5 + 0.3, '对照:药丸入场那一段拿六帧以前的导出画面比明显更差(量得出落后几帧)', out.denseCheck);
  }

  /* ---------- 3. 稀疏版:每个分段的那一张 */
  {
    const rows = [];
    for (let n = 0; n <= spec.lastSegment; n++) {
      const f = streamSegmentFirstFrame(n, spec.originFrame);
      rows.push({ segment: n, frame: f, same: meanOf(sparseDecoded[n].frames[0], sparseDecoded[n].rect, f, f), lagged: f - LAG >= 0 ? meanOf(sparseDecoded[n].frames[0], sparseDecoded[n].rect, f, f - LAG) : null });
    }
    out.sparseCheck = rows;
    say('3-sparse', { rows });
    check(rows.every((r) => r.same < 3), '稀疏版:每个分段的那一张盖回它那一帧的下层,和导出页同一帧对得上(平均差小于 3)', rows.filter((r) => r.same >= 3));
  }

  /* ---------- 4. 断租约重产:倒着一个一个来 */
  {
    const picks = [...new Set([spec.lastSegment - 1, Math.max(2, Math.ceil((PILL_FIRST - spec.originFrame) / 15) + 1), Math.max(1, Math.ceil((PILL_FIRST - spec.originFrame) / 15))])]
      .filter((n) => n >= 1 && n <= spec.lastSegment).sort((a, b) => b - a);
    const rows = [];
    const before = stateNow().replayedFrames ?? 0;
    for (const n of picks) {
      delete stateNow().manifest.segments[n];
      stateNow().failures?.delete?.(n);
      producer.kick();
      const again = await wait((st) => st.every((x) => x === 1));
      if (!check(again === 'ok', `第 ${n} 段作废以后重产出来了`, { again, failed: stateNow().below.failed })) break;
      const redo = await decodeOf(n, 'redo');
      const first = streamSegmentFirstFrame(n, spec.originFrame);
      let diff = 0, same = 0;
      redo.frames.forEach((picture, k) => {
        const a = denseDecoded[n].frames[k];
        let sum = 0;
        for (let i = 0; i < picture.length; i++) sum += Math.abs(picture[i] - a[i]);
        diff = Math.max(diff, sum / picture.length);
        same = Math.max(same, meanOf(picture, redo.rect, first + k, first + k));
      });
      rows.push({ segment: n, firstFrame: first, 对接着租约产的_逐帧最大平均差: round2(diff), 盖回去对导出页同一帧_最差: round2(same) });
    }
    out.redo = { segments: rows, replayedFrames: (stateNow().replayedFrames ?? 0) - before, capture: stateNow().capture ?? null };
    say('4-redo', out.redo);
    check(rows.length === picks.length && out.redo.replayedFrames > 0, '重产的分段是断了租约、从挂载帧回放过来的', out.redo);
    check(rows.every((r) => r.对接着租约产的_逐帧最大平均差 < 0.5), '重产出来的和接着租约产的逐帧相同', rows);
    check(rows.every((r) => r.盖回去对导出页同一帧_最差 < 3), '重产出来的盖回去和导出页同一帧对得上', rows);
  }
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await pipeline?.close(); } catch { /* ignore */ }
  try { await bakery?.close(); } catch { /* ignore */ }
  dropStreamEncoderSpares();
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) { try { for (const name of await fs.readdir(OUT)) if (!/\.json$/.test(name)) await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ } }
}
out.elapsedMs = Date.now() - started;
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(out.ok ? 'PASS' : `FAIL ${fails.length}`);
process.exit(out.ok ? 0 : 1);
