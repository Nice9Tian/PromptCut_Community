/**
 * R8 轨道流**生产侧**的端到端探针(任务书 `docs/plan/r8-streams-task.md` 的「验收」里编码 / 切分与索引 /
 * 连续生产 / 隔离那几条)。
 *
 *   node scripts/probes/stream-produce-probe.mjs [--origin http://127.0.0.1:5230] [--out <dir>] [--keep] [--json <file>]
 *
 * 本进程里直接起一个 `FramePipeline`(和预渲染进程同一份代码,`interactive: true`),库根放在临时目录,
 * 导出页打 `--origin` 那台 dev server(缺省 `.claude/launch.json` 的 `dev-test`,或 `PC_STAGE_TEST_URL`)。
 * 灌一个含三张重卡的项目,等轨道流全部生产完(先稀疏、后补密),然后逐条核对:
 *
 *   1. 每个分段恰好 15 个样本(每条流自己的末段除外:分段从流自己的第一帧起数,到它的最后一帧为止)、首帧是 IDR、只有一个 moof;`mfra` 不落盘;
 *   2. 同一个变体里 `init.mp4` 只写一次,后续分段算出来的 `ftyp + moov` 与它逐字节相同;
 *   3. 稀疏分段(每个分段只截第一帧、其余帧重复它)体积 ≤ 满密度的 1.0 倍;稀疏分段被满密度替换后,旧文件 5 秒内删除;
 *   4. 一条 15 帧分段的编码耗时(只记录,不当通过条件;原门槛 1080p 全幅流 p50 ≤ 300 ms)、分段体积(≤ 512 KB);
 *   5. 连续生产只付一次换页:`bakeStream` 的重挂载次数 ≤ 流数 × 2(稀疏一趟 + 补密一趟);
 *      同时存活的分段编码器 ≤ 2 × streamPool;
 *   6. 就绪索引里每条流一层 `kind: 'stream'`、单位是分段号;组流(`--group` 把解码器预算压到 1)带 `groupClipIds`;
 *   7. **隔离**:和粒子卡重叠的另一张卡的颜色不出现在粒子流的分段里(ffmpeg 解出来逐像素查);
 *   8. 收紧矩形:框比画面小的卡,稀疏一趟量完之后补密分段用的是收紧后的矩形(新变体);
 *   9. alpha 平均误差 ≤ 0.5 / 255(同一批 15 张 PNG 编一段、ffmpeg 解回来比 alpha 半区);
 *  10. 单独重新生产第 5 段(把它的签名弄旧):只重做这一段,索引区间不变,旧文件 5 秒内删掉(G6);
 *  11. F5:关掉这个 FramePipeline,同一个库根上新起一个 —— 扫盘挂键、项目到位后按键认领、每条流的层原样发出,
 *      一个分段都不重新生产;
 *  12. 组流(`--group`):组流的分段里恰好是组内那几张卡(粒子的绿、药丸的蓝都在);
 *  13. 环境指纹进结果键(M4,契约 E.7):诊断里的指纹是 16 位十六进制,快照键与流键都等于
 *      `resultKeyOf(内容键, 指纹)`。
 *
 * 输出 JSON 结论;任何一条不过就以非零退出。`--keep` 不删库根(给 `stream-play-probe.mjs` 接着用)。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { devOrigin, flagArg } from './probe-connect.mjs';
import { createTimings } from './probe-timings.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { splitFmp4, segmentInfo, topLevelBoxes, SEGMENT_FRAMES } from '../../server/frame-stream.mjs';
import { bakeStream } from '../../server/bakery/bake.mjs';
import { openStreamSegmentEncoder } from '../../server/bakery/ffmpeg.mjs';
import { PROJECT, until as untilIn } from './stream-probe-project.mjs';
import { segmentSignature } from '../../server/frame-stream.mjs';
import { streamSegmentFrameCount } from '../../src/render/streamSegments.mjs';
import { resultKeyOf } from '../../server/render-node/fingerprint.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const origin = flagArg('port', null, args) ? `http://127.0.0.1:${flagArg('port', null, args)}` : devOrigin(args);
const KEEP = args.includes('--keep');
const GROUP = args.includes('--group');
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-probe-${Date.now().toString(36)}`));
const JSON_OUT = flagArg('json', null, args);
if (GROUP) process.env.PROMPTCUT_STREAM_DECODERS = '1';

const fails = [];
const timings = createTimings('stream-produce-probe');
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); return cond; };

async function until(label, fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
    await new Promise(r => setTimeout(r, everyMs));
  }
}

/** ffmpeg 把 init + 一个分段解成逐帧 RGBA(上下拼合的编码画面) */
async function decodeSegment(init, seg, dir, name) {
  const file = path.join(dir, `${name}.mp4`);
  await fs.writeFile(file, Buffer.concat([init, seg]));
  const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { windowsHide: true, encoding: 'buffer', maxBuffer: 1 << 30 });
  return stdout;
}

const out = { origin, library: OUT, group: GROUP };
await fs.mkdir(OUT, { recursive: true });
const pipeline = new FramePipeline({ root: OUT, origin: () => origin, interactive: true, playhead: () => null });
// 读口:这支探针不经 http 取字节(直接读盘核对),但生产者要读口接上才开工(见 `routeAttached`)
pipeline.streamProducer().attachRoute();
const layers = [];
const off = pipeline.readyIndex.subscribe(message => { if (message.type === 'layer' && message.kind === 'stream') layers.push(message); });
const started = Date.now();
try {
  await pipeline.preload(PROJECT);
  const producer = await until('生产者起来', () => pipeline._streams?.streams.size ? pipeline._streams : null, 120000);
  if (!producer) throw new Error('生产者没起来');
  const expect = GROUP ? 1 : 3;
  check(producer.streams.size === expect, `流数应当是 ${expect}`, producer.streams.size);
  // 全部分段满密度、没有在跑的 worker / 编码
  const done = await until('全部分段满密度', () => {
    const status = producer.status();
    if (!status.streams.length) return null;
    for (const s of status.streams) {
      for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
    }
    return !producer.workers.size && !producer.encoding.size ? status : null;
  }, 600000, 1000);
  out.produceMs = Date.now() - started;
  timings.record('全部分段满密度(从 preload 起)', out.produceMs);
  if (!done) throw new Error('生产没做完');
  // G6:旧文件延迟 5 秒删除 —— 等 6 秒再看盘
  await new Promise(r => setTimeout(r, 6000));
  const status = producer.status();
  // M4(契约 E.7「探针」):环境指纹定下来了,快照键与流键都 = resultKeyOf(内容键, 指纹)
  {
    const diagnostics = pipeline.diagnostics();
    const fingerprint = diagnostics.environment?.fingerprint;
    out.environment = diagnostics.environment ?? null;
    check(typeof fingerprint === 'string' && /^[0-9a-f]{16}$/.test(fingerprint), 'M4:diagnostics.environment.fingerprint 是 16 位十六进制', out.environment);
    const badControls = (diagnostics.plans || []).flatMap(p => (p.controls || [])
      .filter(c => c.snapshotKey && !(typeof c.contentKey === 'string' && c.envFingerprint === fingerprint && c.snapshotKey === resultKeyOf(c.contentKey, c.envFingerprint)))
      .map(c => ({ clipId: c.clipId, snapshotKey: c.snapshotKey, contentKey: c.contentKey, envFingerprint: c.envFingerprint })));
    check((diagnostics.plans || []).some(p => (p.controls || []).some(c => c.snapshotKey)), 'M4:诊断里有带 snapshotKey 的 control', diagnostics.plans);
    check(badControls.length === 0, 'M4:plans[].controls[] 的 snapshotKey === resultKeyOf(contentKey, envFingerprint),且 envFingerprint 就是本进程的指纹', badControls);
    const listed = diagnostics.streams?.streams ?? [];
    const badStreams = listed.filter(s => !(typeof s.contentKey === 'string' && s.streamKey === resultKeyOf(s.contentKey, fingerprint)))
      .map(s => ({ clipIds: s.clipIds, streamKey: s.streamKey, contentKey: s.contentKey }));
    check(listed.length > 0 && badStreams.length === 0, 'M4:streams.streams[] 的 streamKey === resultKeyOf(contentKey, environment.fingerprint)', { listed: listed.length, badStreams });
  }
  out.stats = status.stats;
  out.encoder = status.encoder;
  out.pool = status.pool;
  out.log = status.log.map(l => l.message);
  out.streams = [];
  for (const state of producer.streams.values()) {
    const { spec, manifest } = state;
    const dir = producer.store.dir(spec.streamKey);
    const files = await fs.readdir(dir);
    const segFiles = files.filter(f => f.endsWith('.m4s'));
    const inits = files.filter(f => f.startsWith('init-'));
    check(Number.isInteger(spec.originFrame) && spec.originFrame === spec.firstFrame && spec.firstSegment === 0 && manifest.originFrame === spec.originFrame,
      `${spec.clipIds}: 分段从这条流自己的第一帧起数,清单记着这一帧`, { originFrame: spec.originFrame, firstFrame: spec.firstFrame, firstSegment: spec.firstSegment, manifest: manifest.originFrame });
    const record = { streamKey: spec.streamKey, kind: spec.kind, clipIds: spec.clipIds, originFrame: spec.originFrame, lastFrame: spec.lastFrame, bound: manifest.bound, tight: manifest.tight,
      segments: spec.lastSegment - spec.firstSegment + 1, segFiles: segFiles.length, inits: inits.length, variants: Object.keys(manifest.inits).length,
      encodeMs: [], bytes: [], sparseBytes: {} };
    check(!files.some(f => f.includes('mfra')), 'mfra 不落盘', files);
    check(segFiles.length === record.segments, `${spec.clipIds}: 替换后盘上每段只剩一个文件`, { segFiles: segFiles.length, segments: record.segments });
    // 每个变体的 init 逐字节相同:每个分段按清单找自己的 init,再和 ffmpeg 输出里的 ftyp+moov 比 —— 清单里的
    // init 本身就是「第一次编码时截下来的那份」,后续分段编出来的若不同会记成新变体,所以变体数就是判据
    check(record.variants <= 2, `${spec.clipIds}: 变体数(上界 + 收紧)≤ 2`, record.variants);
    for (let n = spec.firstSegment; n <= spec.lastSegment; n++) {
      const seg = manifest.segments[n];
      const buf = await fs.readFile(path.join(dir, seg.file));
      const info = segmentInfo(buf);
      // 分段从这条流自己的第一帧起数,末段到它的最后一帧为止(`src/render/streamSegments.mjs`)
      const want = streamSegmentFrameCount(n, spec.originFrame, spec.lastFrame);
      check(want >= 1 && want <= SEGMENT_FRAMES && (n === spec.lastSegment || want === SEGMENT_FRAMES), `${spec.clipIds}#${n}: 只有末段可以不满`, want);
      check(info.sampleCount === want, `${spec.clipIds}#${n}: 样本数`, { got: info.sampleCount, want });
      check(info.firstSampleIsSync === true, `${spec.clipIds}#${n}: 首帧 IDR`);
      check(info.moofs === 1 && topLevelBoxes(buf).every(b => b.type === 'moof' || b.type === 'mdat'), `${spec.clipIds}#${n}: 只有 moof + mdat`);
      check(buf.length <= 512 * 1024, `${spec.clipIds}#${n}: 分段 ≤ 512 KB`, buf.length);
      record.encodeMs.push(seg.encodeMs);
      record.bytes.push(seg.bytes);
    }
    out.streams.push(record);
  }
  // 稀疏 vs 满密度的体积:日志里记了每个变体;这里从生产日志拿不到稀疏分段的字节(已被替换删除),
  // 所以另跑一次同一段的稀疏编码不划算 —— 由 status 的 segment 表在稀疏那一趟结束时记下(见 sparseSnapshot)
  out.sparseSnapshot = producer.sparseBytes ?? null;
  // 连续生产只付一次换页:10 个分段的粒子背景,稀疏一趟、补密一趟各只重挂载一次(失败重试另算)
  for (const s of status.streams) out[`resets_${s.clipIds.join('+')}`] = s.resets;
  const bgStatus = status.streams.find(s => s.clipIds.includes('clip-bg'));
  if (bgStatus && !GROUP) check(bgStatus.resets?.sparse === 1 && bgStatus.resets?.dense === 1 && bgStatus.lastSegment - bgStatus.firstSegment + 1 >= 10,
    '10 个分段的流:稀疏一趟、补密一趟各只付一次换页', bgStatus.resets);
  check(status.stats.maxAliveEncoders <= 2 * status.pool, '同时存活的分段编码器 ≤ 2 × streamPool', status.stats);
  check(status.stats.replacedDeleted >= 1, '替换后的旧分段 5 秒内删除', status.stats.replacedDeleted);
  // 就绪索引
  const byClip = new Map();
  for (const m of layers) byClip.set(m.clipId, m);
  out.layers = [...byClip.values()];
  for (const state of producer.streams.values()) {
    const layer = byClip.get(state.spec.topClipId);
    check(!!layer && layer.key === state.spec.streamKey, `${state.spec.topClipId}: 索引里有这条流的层`, layer ?? null);
    if (layer) check(JSON.stringify(layer.ranges) === JSON.stringify([[state.spec.firstSegment, state.spec.lastSegment]]), `${state.spec.topClipId}: 索引区间 = 全部分段`, layer.ranges);
    if (layer) check(layer.originFrame === state.spec.originFrame, `${state.spec.topClipId}: 层带着这条流的第一帧`, { layer: layer.originFrame, spec: state.spec.originFrame });
    if (GROUP && layer) check(Array.isArray(layer.groupClipIds) && layer.groupClipIds.length === state.spec.clipIds.length, '组流的层带 groupClipIds', layer);
  }
  // 隔离:绿色粒子背景那条流(单卡流)里不能有金句药丸的蓝色
  if (!GROUP) {
    const bg = [...producer.streams.values()].find(s => s.spec.clipIds[0] === 'clip-bg');
    const pill = [...producer.streams.values()].find(s => s.spec.clipIds[0] === 'clip-pill');
    for (const [state, name] of [[bg, 'bg'], [pill, 'pill']]) {
      if (!state) continue;
      const seg = state.manifest.segments[1];
      const init = await fs.readFile(producer.store.initFile(state.spec.streamKey, seg.init));
      const raw = await decodeSegment(init, await fs.readFile(path.join(producer.store.dir(state.spec.streamKey), seg.file)), OUT, `decoded-${name}`);
      const meta = state.manifest.inits[seg.init];
      const W = meta.width, Hc = meta.height, H = Hc / 2 - 8;
      const frame = raw.subarray(0, W * Hc * 4);
      let blue = 0, opaque = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const a = frame[((y + H + 8) * W + x) * 4];
        if (a > 200) opaque++;
        // 药丸的蓝:B 高、R 低、B 比 G 高出一截(预乘色 ≤ a;绿色粒子是 G 高 B 低)
        if (a > 200 && frame[i + 2] > 180 && frame[i] < 140 && frame[i + 2] - frame[i + 1] > 50) blue++;
      }
      out[`isolation_${name}`] = { width: W, height: H, bluePixels: blue, opaquePixels: opaque, rect: meta.rect };
    }
    if (out.isolation_bg) check(out.isolation_bg.bluePixels === 0, '粒子背景流里没有金句药丸的像素', out.isolation_bg);
    if (out.isolation_pill) check(out.isolation_pill.bluePixels > 1000, '金句药丸流里有它自己的蓝色像素', out.isolation_pill);
    if (pill) check(pill.manifest.tight && pill.manifest.tight.w * pill.manifest.tight.h < pill.manifest.bound.w * pill.manifest.bound.h, '框比画面小的卡:收紧矩形小于上界', { bound: pill.manifest.bound, tight: pill.manifest.tight });
  }
  // 编码耗时(只记录;原验收门槛「一条 1080p 流 15 帧分段编码 ≤ 300 ms,前提:没有别的编码器争 CPU」已不作通过条件):
  // 先把 15 张 PNG 截在内存里,再一次性喂给编码器计时(G0-b 的量法,和出帧不重叠)
  out.bench = [];
  for (const clipId of GROUP ? [] : ['clip-bg', 'clip-pill']) {
    const state = [...producer.streams.values()].find(s => s.spec.clipIds[0] === clipId);
    if (!state) continue;
    const bakery = await pipeline.leaseStreamBakery();
    const pngs = [];
    try {
      await bakery.reset(state.isolated, pipeline.emptyUrl(state.isolated), { deferCards: true });
      bakery.streamLease = null;
      const rect = state.manifest.tight ?? state.manifest.bound;
      const clip = { x: rect.x + state.spec.offset.x, y: rect.y + state.spec.offset.y, w: rect.w, h: rect.h };
      const t0 = Date.now();
      await bakeStream(bakery, { streamSignature: 'bench', fromFrame: 30, toFrame: 44, stride: 1, fps: 30, mountFrame: state.spec.mountFrame, clip,
        onFrame: async (_f, png) => { pngs.push(png); } });
      const captureMs = Date.now() - t0;
      const runs = [];
      for (let k = 0; k < 3; k++) {
        const enc = openStreamSegmentEncoder('ffmpeg', { encoder: status.encoder, fps: 30 });
        const e0 = Date.now();
        for (const png of pngs) await enc.write(png);
        const result = await enc.finish();
        runs.push({ ms: Date.now() - e0, bytes: result.bytes.length });
      }
      runs.sort((a, b) => a.ms - b.ms);
      // alpha 误差:这 15 张编成一段,ffmpeg 解回来,下半区的灰度 vs 原 PNG 的 alpha
      const enc = openStreamSegmentEncoder('ffmpeg', { encoder: status.encoder, fps: 30 });
      for (const png of pngs) await enc.write(png);
      const encoded = await enc.finish();
      const { init: initBuf, segments: segs } = splitFmp4(encoded.bytes);
      const raw = await decodeSegment(initBuf, segs[0], OUT, `alpha-${clipId}`);
      const W = rect.w, H = rect.h, Hc = 2 * (H + 8);
      let sum = 0, n = 0, max = 0;
      for (let k = 0; k < pngs.length; k++) {
        const ref = PNG.sync.read(pngs[k]);
        const frame = raw.subarray(k * W * Hc * 4, (k + 1) * W * Hc * 4);
        for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
          const d = Math.abs(frame[((y + H + 8) * W + x) * 4] - ref.data[(y * W + x) * 4 + 3]);
          sum += d; n++; if (d > max) max = d;
        }
      }
      const alpha = { mean: +(sum / n).toFixed(4), max };
      out.bench.push({ clipId, rect, captureMsFor15: captureMs, encodeMs: runs.map(r => r.ms), p50: runs[1].ms, bytes: runs[1].bytes, alpha });
      check(alpha.mean <= 0.5, `${clipId}: alpha 平均误差 ≤ 0.5 / 255`, alpha);
    } finally { pipeline.returnStreamBakery(bakery); }
  }
  const bgBench = out.bench.find(b => b.clipId === 'clip-bg');
  // 耗时只记录(verification.md「耗时只记录,不当闸门」):编码 p50 原来是 ≤ 300 ms 的通过条件,现在只记数
  for (const b of out.bench) {
    timings.record(`${b.clipId} 15 帧分段编码 p50`, b.p50, b.clipId === 'clip-bg' ? { formerLimit: '1080p 全幅流 ≤ 300 ms' } : {});
    timings.record(`${b.clipId} 15 帧出帧`, b.captureMsFor15);
  }
  for (const item of status.stats.sparseVsDense ?? []) {
    if (item.sameRect) check(item.sparse <= item.dense, '稀疏分段(每段一张)≤ 满密度 1.0 倍(同一矩形)', item);
  }
  // 组流:分段里恰好是组内那几张卡 —— 药丸的蓝、粒子的绿都在
  if (GROUP) {
    const state = [...producer.streams.values()][0];
    const seg = state.manifest.segments[1];
    const init = await fs.readFile(producer.store.initFile(state.spec.streamKey, seg.init));
    const raw = await decodeSegment(init, await fs.readFile(path.join(producer.store.dir(state.spec.streamKey), seg.file)), OUT, 'decoded-group');
    const meta = state.manifest.inits[seg.init];
    const W = meta.width, H = meta.height / 2 - 8;
    // 药丸的蓝(画面中间);粒子:画面右边那一条(x ≥ 1300)只有粒子背景,那里有不透明的像素就是它
    let blue = 0, particles = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const a = raw[((y + H + 8) * W + x) * 4];
      if (a > 200 && raw[i + 2] > 180 && raw[i] < 140 && raw[i + 2] - raw[i + 1] > 50) blue++;
      if (x >= 1300 && a > 100) particles++;
    }
    out.groupContent = { clipIds: state.spec.clipIds, blue, particles };
    check(blue > 1000 && particles > 100, '组流里恰好是组内那几张卡(药丸的蓝、右边一条里的粒子都在)', out.groupContent);
  }
  // G6:单独重新生产第 5 段 —— 把它的签名弄旧,只有这一段重做,索引区间不变,旧文件 5 秒内删
  if (!GROUP) {
    const bg = [...producer.streams.values()].find(s => s.spec.clipIds[0] === 'clip-bg');
    const before = { ...bg.manifest.segments[5] };
    const segmentsBefore = producer.stats.segments;
    bg.manifest.segments[5] = { ...before, sig: 'stale' };
    producer.kick();
    const redone = await untilIn(fails, '第 5 段重新生产', () => {
      const seg = bg.manifest.segments[5];
      return seg.sig !== 'stale' && !producer.workers.size && !producer.encoding.size ? seg : null;
    }, 120000);
    // 旧文件延迟 5 秒删:原来固定等 6 秒就看盘(等于拿 6 秒当门槛)。现在等到它没了为止(至多 60 秒,防卡死),用时只记录
    const goneT0 = Date.now();
    const oldFile = path.join(producer.store.dir(bg.spec.streamKey), before.file);
    let oldGone = before.file === redone?.file;
    while (!oldGone && Date.now() - goneT0 < 60000) {
      oldGone = !(await fs.stat(oldFile).then(() => true, () => false));
      if (!oldGone) await new Promise(r => setTimeout(r, 500));
    }
    timings.record('G6 替换后旧分段文件删掉', Date.now() - goneT0, { formerLimit: '固定等 6 秒后看盘(设计值 5 秒内删)' });
    const lastLayer = [...layers].reverse().find(m => m.clipId === 'clip-bg');
    out.resegment = { before: before.file, after: redone?.file, produced: producer.stats.segments - segmentsBefore, oldGone, ranges: lastLayer?.ranges,
      sigOk: redone?.sig === segmentSignature({ streamKey: bg.spec.streamKey, segment: 5, stride: 1, encoder: status.encoder, rect: bg.manifest.tight ?? bg.manifest.bound }) };
    check(out.resegment.produced === 1 && out.resegment.sigOk, '只重新生产了第 5 段', out.resegment);
    check(JSON.stringify(out.resegment.ranges) === JSON.stringify([[bg.spec.firstSegment, bg.spec.lastSegment]]), '重新生产第 5 段后索引区间不变', out.resegment);
    check(oldGone, '替换后旧文件删掉了(用时见 timings)', out.resegment);
  }
  const checkExists = file => fs.access(file).then(() => true, () => false);
  check(!(await checkExists(path.join(OUT, 'controls-html'))), '帧库下不再生成 controls-html 快照目录');
  check(!(await checkExists(path.join(OUT, 'controls-local'))), '帧库下不再生成 controls-local 快照目录');
  // F5:同一个库根上重起一个 FramePipeline(模拟预渲染进程被杀后拉起)
  {
    const keys = [...producer.streams.keys()];
    await pipeline.close();
    const restarted = new FramePipeline({ root: OUT, origin: () => origin, interactive: true, playhead: () => null });
    restarted.streamProducer().attachRoute();
    const seen = [];
    restarted.readyIndex.subscribe(m => seen.push(m));
    try {
      await restarted.rescanSnapshots();
      const staged = restarted.readyIndex.stagedKeys().filter(k => k.kind === 'stream').map(k => k.key);
      const beforeProject = seen.filter(m => m.type === 'layer' && m.kind === 'stream').length;
      await restarted.preload(PROJECT);
      const back = await untilIn(fails, 'F5:重启后每条流的层重新发出', () => {
        const got = new Set(seen.filter(m => m.type === 'layer' && m.kind === 'stream').map(m => m.key));
        return keys.every(k => got.has(k)) ? got : null;
      }, 120000);
      await new Promise(r => setTimeout(r, 3000));
      out.restart = { staged: staged.length, streams: keys.length, layersBeforeProject: beforeProject, republished: back ? back.size : 0,
        producedAfterRestart: restarted._streams?.stats.segments ?? null };
      check(staged.length === keys.length && keys.every(k => staged.includes(k)), 'F5:扫盘把每条流挂在键上', out.restart);
      check(beforeProject === 0, 'F5:项目到位之前不发 layer', out.restart);
      check(out.restart.producedAfterRestart === 0, 'F5:重启后一个分段都不重新生产', out.restart);
    } finally { await restarted.close().catch(() => {}); }
  }
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
} finally {
  off();
  out.fails = fails;
  out.timings = timings.list;
  await pipeline.close().catch(() => {});
  if (!KEEP) await fs.rm(OUT, { recursive: true, force: true }).catch(() => {});
  const text = JSON.stringify(out, null, 2);
  if (JSON_OUT) await fs.writeFile(JSON_OUT, text);
  console.log(text);
  timings.print();
  console.log(fails.length ? `FAIL ${fails.length}` : 'PASS');
  process.exit(fails.length ? 1 : 0);
}
