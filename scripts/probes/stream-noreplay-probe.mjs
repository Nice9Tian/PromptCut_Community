/**
 * 产流时 remotion 式的卡不从挂载帧回放:服务端一半的端到端探针
 * (`docs/plan/prerender-products-contract.md` 第 4.2 节;任务书 `docs/plan/render-refactor-task.md`「戊」)。
 *
 *   node scripts/probes/stream-noreplay-probe.mjs [--port 27560] [--out <dir>] [--keep] [--json <file>]
 *
 * 自己在检出根起一个 dev server(`--port`,另占 +1、+2 当舞台端口;不碰 5190～5192),本进程里直接起一个
 * `FramePipeline`(同预渲染进程的代码,`interactive: true`),库根放临时目录。灌一个项目:
 *
 *   clip-av    声画提示脉冲 `av-pulse`    remotion 式(direct),圆环随时间扩散、淡出(10 个分段)
 *   clip-slow  探针卡 `probe-slow`        remotion 式(direct),方块随时间平移
 *   clip-pill  金句药丸 `punch-pill`      motion 式(stateful)
 *   clip-type  探针卡 `probe-typewriter`  motion 式(stateful),每 100 ms 推一格
 *
 * remotion 式的卡在审阅表里是 independent,但声明上是轻卡、不进预渲染集合;探针把 `pipeline.streamPicked`
 * 钉成全选(「钉成重卡」),让它们有流可产。逐条核对:
 *
 *   1. `planStreams` 的 `replay`:两张 remotion 式的流是 false,两张 motion 式的流是 true;
 *   2. 全部产完以后 `status()` 里 remotion 式的流 `replayedFrames` 恒为 0;
 *   3. 把中间几个分段(7、3、5,不按顺序、互不相邻)作废再产,每个都断租约(`resets` 增加):remotion 式的流
 *      `replayedFrames` 仍是 0;motion 式的流 `replayedFrames` 大于 0(照旧从挂载帧回放);
 *   4. 画面逐帧相同(像素比):对每条流的第 2、6 段,同一个会话重灌页面后
 *        A 路 = 不回放(不传 mountFrame、预热 0,就是 runSegment 现在的做法),
 *        B 路 = 照旧回放(传挂载帧、预热缺省 3),
 *      逐帧比 PNG 的像素。remotion 式的流两路必须一张不差;motion 式的流是**对照**:两路必须比出差别
 *      (证明这套比法测得出「该回放而没回放」);
 *   5. 产出的流和回放着产的相同:把 B 路的 PNG 用同一个编码器编成一段,和流库里 runSegment 不回放产出的
 *      那一段逐字节比(不同再解码逐像素比)。
 *
 * 输出 JSON 结论,过程写 stderr;任何一条不过就以非零退出。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { SEGMENT_FRAMES, splitFmp4 } from '../../server/frame-stream.mjs';
import { streamSegmentFirstFrame, streamSegmentLastFrame } from '../../src/render/streamSegments.mjs';
import { bakeStream } from '../../server/bakery/bake.mjs';
import { openStreamSegmentEncoder } from '../../server/bakery/ffmpeg.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const PORT = Number(flagArg('port', '27560', args));
const KEEP = args.includes('--keep');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-noreplay-probe-${Date.now().toString(36)}`));
if ([5190, 5191, 5192].some((p) => p >= PORT && p <= PORT + 2)) throw new Error('这一段是用户常驻的开发服务器的端口,换一个');

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); say('FAIL', { label, extra }); } return cond; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const PROJECT = {
  id: 'noreplay-probe', name: '不回放探针', width: 1920, height: 1080, fps: 30, duration: 5,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-av', name: 'av', hidden: false, clips: [
      { id: 'clip-av', kind: 'card', cardId: 'av-pulse', start: 0.5, end: 4.5, params: { color: '#ff7a1a', duration: 4 }, frame: { x: 480, y: 270, w: 960, h: 540 } },
    ] },
    { id: 'tr-slow', name: 'slow', hidden: false, clips: [
      { id: 'clip-slow', kind: 'card', cardId: 'probe-slow', start: 0, end: 5, params: { burnMs: 0, label: 'slow' } },
    ] },
    { id: 'tr-pill', name: 'pill', hidden: false, clips: [
      { id: 'clip-pill', kind: 'card', cardId: 'punch-pill', start: 0, end: 4, params: { text: '不回放' }, frame: { x: 960, y: 540, w: 640, h: 360, anchor: [0.5, 0.5] } },
    ] },
    { id: 'tr-type', name: 'type', hidden: false, clips: [
      { id: 'clip-type', kind: 'card', cardId: 'probe-typewriter', start: 0, end: 5, params: {} },
    ] },
  ],
};
const DIRECT = ['clip-av', 'clip-slow'];
const STATEFUL = ['clip-pill', 'clip-type'];
const REGEN = [7, 3, 5]; // 不按顺序、互不相邻的三段
const COMPARE = [2, 6]; // 逐帧比的两段

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fsSync.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

/** ffmpeg 把 init + 一个分段解成逐帧 RGBA(上下拼合的编码画面) */
async function decodeSegment(init, seg, dir, name) {
  const file = path.join(dir, `${name}.mp4`);
  await fs.writeFile(file, Buffer.concat([init, seg]));
  const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 1 << 30, windowsHide: true });
  return stdout;
}

/** 两张 PNG 有多少个像素不同(RGBA 任一分量不等);尺寸不同回 -1 */
function diffPixels(a, b) {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return -1;
  let n = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    if (pa.data[i] !== pb.data[i] || pa.data[i + 1] !== pb.data[i + 1] || pa.data[i + 2] !== pb.data[i + 2] || pa.data[i + 3] !== pb.data[i + 3]) n++;
  }
  return n;
}
/** 有多少个不透明度大于 0 的像素(画面是不是空的) */
function inkPixels(png) {
  const p = PNG.sync.read(png);
  let n = 0;
  for (let i = 3; i < p.data.length; i += 4) if (p.data[i] > 0) n++;
  return n;
}

const out = { port: PORT, library: OUT, project: PROJECT.id };
await fs.mkdir(OUT, { recursive: true });
const RUN = Date.now().toString(36);
const TMP = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pc-noreplay-dev-'));
let child = null;
let pipeline = null;
try {
  // ---------- 0. dev server(本检出根,临时数据目录)
  const log = [];
  child = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    env: {
      ...process.env, BROWSER: 'none', PROMPTCUT_DATA_DIR: path.join(TMP, 'data'), PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0',
      PROMPTCUT_LAN_HOST: '', PROMPTCUT_DEVICE_ID: `noreplay-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'noreplay-probe',
    },
  });
  const keep = (c) => { log.push(c.toString()); if (log.length > 400) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  say('spawn', { pid: child.pid, port: PORT });
  const origin = `http://127.0.0.1:${PORT}`;
  const up = await until('dev server 起来', async () => {
    if (child.exitCode !== null) throw new Error(`dev server 退出了:${log.join('').slice(-600)}`);
    return fetch(`${origin}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
  }, 180_000, 300);
  if (!up) throw new Error(`dev server 没起来:${log.join('').slice(-600)}`);
  out.origin = origin;

  // ---------- 1. 管线:把 remotion 式的卡钉成重卡,灌项目,等全部分段满密度
  pipeline = new FramePipeline({ root: OUT, origin: () => origin, interactive: true, playhead: () => null });
  pipeline.streamPicked = () => true; // 钉成重卡:remotion 式的卡声明上是轻卡,不钉就没有流
  const producer = pipeline.streamProducer();
  producer.attachRoute();
  const dense = () => {
    const status = producer.status();
    if (!status.streams.length) return null;
    for (const s of status.streams) for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
    return !producer.workers.size && !producer.encoding.size ? status : null;
  };
  const t0 = Date.now();
  await pipeline.preload(PROJECT);
  const ready = await until('生产者起来', () => (pipeline._streams?.streams.size >= 4 ? pipeline._streams : null), 180_000);
  if (!ready) throw new Error('生产者没起来');
  const first = await until('全部分段满密度', dense, 900_000, 1000);
  if (!first) throw new Error('第一轮生产没做完');
  out.produceMs = Date.now() - t0;
  const stateOf = (clipId) => [...producer.streams.values()].find((s) => s.spec.clipIds.length === 1 && s.spec.clipIds[0] === clipId);
  const rowOf = (status, clipId) => status.streams.find((s) => s.clipIds.length === 1 && s.clipIds[0] === clipId);
  check(producer.streams.size === 4, '4 条流', producer.streams.size);
  out.encoder = first.encoder;

  // ---------- 2. planStreams 的 replay 和第一轮产出以后的 replayedFrames
  out.firstRound = {};
  for (const clipId of [...DIRECT, ...STATEFUL]) {
    const row = rowOf(first, clipId);
    const want = STATEFUL.includes(clipId);
    check(!!row, `${clipId}:有流`);
    if (!row) continue;
    check(row.replay === want, `${clipId}:replay 应当是 ${want}`, row.replay);
    out.firstRound[clipId] = { replay: row.replay, replayedFrames: row.replayedFrames, resets: row.resets, segments: row.lastSegment - row.firstSegment + 1 };
    if (!want) check(row.replayedFrames === 0, `${clipId}:第一轮产完 replayedFrames 为 0`, row.replayedFrames);
  }
  say('first-round', out.firstRound);

  // ---------- 3. 中间几段作废再产:不按顺序、每段都断租约
  const before = Object.fromEntries([...DIRECT, ...STATEFUL].map((id) => {
    const r = rowOf(producer.status(), id);
    return [id, { replayedFrames: r.replayedFrames, resets: { ...(r.resets ?? { sparse: 0, dense: 0 }) } }];
  }));
  for (const clipId of [...DIRECT, ...STATEFUL]) {
    const state = stateOf(clipId);
    for (const n of REGEN) delete state.manifest.segments[n];
  }
  producer.kick();
  const second = await until('作废的分段重新产完', () => {
    const status = dense();
    return status && status.streams.every((s) => REGEN.every((n) => s.segments[n]?.stride === 1)) ? status : null;
  }, 900_000, 1000);
  if (!second) throw new Error('第二轮生产没做完');
  out.regen = {};
  for (const clipId of [...DIRECT, ...STATEFUL]) {
    const row = rowOf(second, clipId);
    const delta = row.replayedFrames - before[clipId].replayedFrames;
    const resetsDelta = (row.resets?.sparse ?? 0) + (row.resets?.dense ?? 0) - before[clipId].resets.sparse - before[clipId].resets.dense;
    out.regen[clipId] = { replay: row.replay, replayedFramesDelta: delta, resetsDelta };
    check(resetsDelta >= REGEN.length, `${clipId}:作废的 ${REGEN.length} 段都断了租约(重灌页面 ≥ ${REGEN.length} 次)`, resetsDelta);
    if (DIRECT.includes(clipId)) check(delta === 0 && row.replayedFrames === 0, `${clipId}(remotion 式):断租约重产以后 replayedFrames 仍是 0`, { delta, total: row.replayedFrames });
    else check(delta > 0, `${clipId}(motion 式):断租约重产照旧从挂载帧回放(replayedFrames 增加)`, delta);
  }
  say('regen', out.regen);

  // ---------- 4. 逐帧比:不回放(A 路)vs 照旧回放(B 路)
  out.compare = [];
  const bakery = await pipeline.leaseStreamBakery();
  const SHOTS = path.join(OUT, 'shots');
  await fs.mkdir(SHOTS, { recursive: true });
  const cmpDir = path.join(OUT, 'cmp');
  await fs.mkdir(cmpDir, { recursive: true });
  try {
    for (const clipId of [...DIRECT, ...STATEFUL]) {
      const state = stateOf(clipId);
      const { spec, manifest } = state;
      const rect = manifest.tight ?? manifest.bound;
      const clip = { x: rect.x + spec.offset.x, y: rect.y + spec.offset.y, w: rect.w, h: rect.h };
      /** 重灌页面以后产这个分段的全部 PNG;replay = 照旧(传挂载帧、预热缺省) */
      const shoot = async (segment, replay) => {
        // 这个分段盖住的帧:从这条流自己的第一帧起数(`src/render/streamSegments.mjs`)
        const fromFrame = streamSegmentFirstFrame(segment, spec.originFrame), toFrame = streamSegmentLastFrame(segment, spec.originFrame, spec.lastFrame);
        await bakery.reset(state.isolated, pipeline.emptyUrl(state.isolated), { deferCards: true });
        bakery.streamLease = null;
        const pngs = [];
        const stats = await bakeStream(bakery, {
          streamSignature: `${spec.streamKey}:${replay ? 'replay' : 'direct'}`, fromFrame, toFrame, stride: 1, fps: spec.fps,
          ...(replay ? { mountFrame: spec.mountFrame } : { warm: 0 }), clip, hasMedia: false,
          onFrame: async (_f, png) => { pngs.push(png); },
        });
        bakery.streamLease = null;
        return { pngs, stats };
      };
      for (const segment of COMPARE) {
        if (segment < spec.firstSegment || segment > spec.lastSegment) continue;
        const direct = await shoot(segment, false); // A 路
        const replay = await shoot(segment, true); // B 路
        check(direct.stats.replayed === 0, `${clipId}#${segment}:A 路 bakeStream 的 replayed 为 0`, direct.stats.replayed);
        check(direct.pngs.length === replay.pngs.length && direct.pngs.length > 0, `${clipId}#${segment}:两路帧数相同`, [direct.pngs.length, replay.pngs.length]);
        const diffs = direct.pngs.map((png, i) => diffPixels(png, replay.pngs[i]));
        const ink = replay.pngs.map(inkPixels);
        const rec = { clipId, segment, mode: STATEFUL.includes(clipId) ? 'stateful(对照)' : 'direct', frames: direct.pngs.length, replayedB: replay.stats.replayed,
          diffPixelsMax: Math.max(...diffs), diffPixelsSum: diffs.reduce((a, b) => a + Math.max(0, b), 0), inkMin: Math.min(...ink), inkMax: Math.max(...ink) };
        out.compare.push(rec);
        say('compare', rec);
        if (DIRECT.includes(clipId)) {
          check(rec.diffPixelsMax === 0, `${clipId}#${segment}:remotion 式的卡,不回放和回放着产逐帧相同(像素)`, diffs);
          check(rec.inkMax > 0, `${clipId}#${segment}:画面不是空的`, ink);
          check(replay.stats.replayed > 0, `${clipId}#${segment}:B 路确实回放了(replayed > 0)`, replay.stats.replayed);
        } else {
          check(rec.diffPixelsSum > 0, `${clipId}#${segment}:对照 —— motion 式的卡不回放必须比出差别(这套比法测得出)`, diffs);
        }
        // 留两张图看(第一帧):A 路、B 路
        await fs.writeFile(path.join(SHOTS, `${clipId}-seg${segment}-A-direct.png`), direct.pngs[Math.min(7, direct.pngs.length - 1)]);
        await fs.writeFile(path.join(SHOTS, `${clipId}-seg${segment}-B-replay.png`), replay.pngs[Math.min(7, replay.pngs.length - 1)]);

        // ---------- 5. 流库里 runSegment(不回放)产出的这一段 vs B 路的 PNG 用同一个编码器编出来的
        if (DIRECT.includes(clipId)) {
          const seg = manifest.segments[segment];
          const stored = await fs.readFile(path.join(producer.store.dir(spec.streamKey), seg.file));
          const storedInit = await fs.readFile(producer.store.initFile(spec.streamKey, seg.init));
          const enc = openStreamSegmentEncoder(producer.ffmpeg, { encoder: producer.encoderName, fps: spec.fps });
          for (const png of replay.pngs) await enc.write(png);
          const encoded = await enc.finish();
          const { init: refInit, segments: refSegs } = splitFmp4(encoded.bytes);
          const sameBytes = Buffer.compare(refSegs[0], stored) === 0;
          let sameDecoded = null;
          if (!sameBytes) {
            const a = await decodeSegment(storedInit, stored, cmpDir, `stored-${clipId}-${segment}`);
            const b = await decodeSegment(refInit, refSegs[0], cmpDir, `ref-${clipId}-${segment}`);
            sameDecoded = Buffer.compare(a, b) === 0;
          }
          const row = { clipId, segment, storedBytes: stored.length, refBytes: refSegs[0].length, sameBytes, sameDecoded, storedStride: seg.stride, storedRect: manifest.inits[seg.init]?.rect ?? null };
          out.compare.push({ ...row, kind: 'stream-vs-replay-encode' });
          say('stream-vs-replay', row);
          check(seg.stride === 1, `${clipId}#${segment}:流库里这一段是满密度`, seg.stride);
          check(sameBytes || sameDecoded === true, `${clipId}#${segment}:流库里不回放产出的分段和回放着产的编码结果相同(字节或解码像素)`, row);
        }
      }
    }
  } finally { pipeline.returnStreamBakery(bakery); }

  // ---------- 6. 键没变:replay 不进任何键(同一份计划里 direct 流的键 = 内容键 × 指纹,与 replay 无关)
  out.finalStatus = producer.status().streams.map((s) => ({ clipIds: s.clipIds, replay: s.replay, replayedFrames: s.replayedFrames, resets: s.resets }));
  out.stats = producer.status().stats;
  check(DIRECT.every((id) => rowOf(producer.status(), id).replayedFrames === 0), 'remotion 式的流 replayedFrames 恒为 0(收尾再看一次)');
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await pipeline?.close(); } catch { /* ignore */ }
  if (child && child.exitCode === null) {
    // 只结束自己起的进程树
    if (process.platform === 'win32') {
      await new Promise((resolve) => { const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); k.on('close', resolve); k.on('error', resolve); });
    } else child.kill('SIGKILL');
  }
  try { fsSync.rmSync(TMP, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ }
  if (!KEEP) {
    // 留下 shots 和结论 JSON,别的(流库)删掉
    try {
      for (const name of await fs.readdir(OUT)) if (name !== 'shots' && name !== 'result.json') await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* ignore */ }
  }
}
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
