/**
 * 源依赖卡和外框用了三维变形的卡的轨道流 —— 产流、贴回舞台、改了输入以后作废重产的端到端探针,**逐帧比像素**
 * (语义 `docs/semantics/mechanism/rendering.md`「重管线:预渲染」「怎么产,按卡分」;计划的一侧在 `server/frame-stream.mjs` 的 `soloStreamKind`)。
 *
 *   node scripts/probes/stream-source-probe.mjs --port 27060 [--host-port 27070] [--out <dir>] [--keep] [--json <file>]
 *   node scripts/probes/stream-source-probe.mjs --port 27060 --measure [--size 1920x1080] [--seconds 10]     只量耗时与体积(见文末)
 *
 * 自己在检出根起一台开发服务器(`--port`,另占 +1、+2 当舞台端口;素材目录、数据目录、卡片改动层都是新建的临时目录,
 * 检出目录一个文件都不写),用完按进程号收掉。本进程里直接起 `FramePipeline`(同预渲染进程的代码),库根放临时目录。
 *
 * 项目(1280×720,30 帧每秒)里三类卡,都钉成重卡,**都不从 15 的倍数帧开始**:
 *
 *   fx     一段视频套一张素材效果卡(反色,motion 式:产流时从挂载帧回放),第 39～128 帧。片段自己带着素材和卡
 *   trans  两段视频之间的一个转场(交叉溶解,remotion 式:产流时不回放),第 166～195 帧;两段视频 va、vb 是时间轴上普通的素材段
 *   tilt   一张外框带三维变形的独立卡(`r6-stateful`,一块字每帧横移 10 像素;rotateY 35°、rotateX 12°),第 70～144 帧,压在 fx 上面
 *
 * 逐条核对:
 *
 *   1. 计划:三条都是单卡流(`kind: 'card'`、`plane: 'local'`),fx、trans 标 `solo: 'source'`,tilt 标 `solo: 'spatial'`;
 *      各自的第一帧是片段的第一帧,分段从它起数。
 *   2. 稀疏版(生产者先把三条流的稀疏版铺满,探针卡住不让补满密度):每个分段 `stride` 是一个分段的帧数、带位置矩形 `box`;
 *      **舞台贴稀疏版**:时间设到分段中间的帧,舞台上贴出来的画面最像导出页里这个分段第一帧的那一幅(源依赖卡的流里带着视频,
 *      所以这时整幅画面连视频一起停在分段第一帧 —— 这是要报给用户的那个后果)。
 *   3. 放行补满密度。**产流,逐帧**:把每个分段解出来,第 n 段的第 k 个样本应当是项目的第 `originFrame + n × 15 + k` 帧。参照是这条流的
 *      隔离工程在导出页顺推、每帧截一张:fx、trans 的参照里就是「视频经过这张卡以后」的画面;tilt 的参照是**变形之前**的平面画面
 *      (隔离工程里框只留位置和宽高)。每个样本拿去比它自己、前后各两帧,最像的必须是它自己。
 *   4. **舞台贴流,逐帧**(测试页扮演父页,流平面用产品里的 `streamPlanesFor`):三条流在场的每一帧,打乱顺序跳(拖动),
 *      等流平面画出这一帧,截舞台,和**完整项目的导出页同一帧**比,同样比前后各一帧,最像的必须是它自己。tilt 的流里是平面画面,
 *      贴的时候由包裹层做三维变形,所以这一条同时验「贴的时候再做变形,结果和导出一致」;fx 的那一段舞台上没有别的东西在画视频。
 *   5. 真的播放一小段再暂停:不跳帧,暂停的那一帧同样比。
 *      (「停下以后回到精确活渲」不在这里核:测试页没有成本记录和分派表,舞台不起追帧。三维外框的那一种在真的编辑器里核,
 *      `scrub-stream-probe.mjs --tilt`;素材效果卡没有成本记录,停下以后怎么回到活渲是原来就有的另一条路,这次没有动。)
 *   6. **改了输入**:视频的裁剪起点(fx)、卡的参数(trans)、三维的角度(tilt)各改一处。fx、trans 的流键换了(旧流不属于这一版,
 *      就绪消息里是新键),重产;tilt 的流键不变、一个分段都不重产。重产完以后三条流各抽几帧,舞台贴出来的和**改过的项目**的导出同一帧最像
 *      (tilt 那几帧验的是同一条流照新的角度贴)。
 *
 * `--measure`:只量。一个项目里只有一段视频套一张素材效果卡(缺省 10 秒、1920×1080),从 `preload` 起计时:稀疏版铺满用了多久、
 * 满密度补齐用了多久、这条流稀疏版和满密度版各多大。不比像素。耗时只记录,不是通过条件。缺省用 motion 式的那张卡(产流时每帧都推);
 * 加 `--direct` 换成 remotion 式的写法(稀疏版直接跳到要截的帧)。
 *
 * 输出 JSON 结论,过程写 stderr;任何一条不过就以非零退出。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { serve, flagArg } from './probe-connect.mjs';
import { startDevServer } from '../lib/dev-server.mjs';
import { emptyUrlOf, decodeSegment, newError, errorSummary, tallyDecodedDirect, cropRgba, savePreview, sleep, round2 } from './below-stream-common.mjs';
import { STREAM_SEGMENT_FRAMES, streamSegmentFirstFrame, streamSegmentFrameCount, streamSegmentOf } from '../../src/render/streamSegments.mjs';

const execFileAsync = promisify(execFile);
const args = process.argv.slice(2);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
const MEASURE = args.includes('--measure');
/** `--measure --direct`:素材效果卡换成 remotion 式的那一张(产流时不回放、稀疏版直接跳到要截的帧) */
const DIRECT = args.includes('--direct');
const JSON_OUT = flagArg('json', null, args);
const HOST_PORT = Number(flagArg('host-port', '0', args)) || 0;
const RUN = Date.now().toString(36) + crypto.randomBytes(2).toString('hex');
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-source-probe-${RUN}`));
if (!PORT) { console.error('要给 --port <自己起一台开发服务器的端口>'); process.exit(2); }

const FPS = 30;
const [WIDTH, HEIGHT] = MEASURE ? String(flagArg('size', '1920x1080', args)).split('x').map(Number) : [1280, 720];
const MEASURE_SECONDS = Math.max(1, Number(flagArg('seconds', '10', args)) || 10);
const WORK = path.join(OUT, 'work');
const MEDIA_DIR = path.join(WORK, 'media');
const DATA_DIR = path.join(WORK, 'data');
const OVERRIDES = path.join(WORK, 'card-overrides');
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

/* ------------------------------------------------------------------ 素材与卡 */

/** ffmpeg 的测试图样(有清晰的边、有连续的运动、每帧都不一样),按内容哈希放进素材目录。回项目里的素材记录 */
async function makeVideo(ffmpeg, id, filter, seconds, width, height) {
  const tmp = path.join(WORK, `${id}.mp4`);
  await execFileAsync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${width}x${height}:rate=${FPS}:duration=${seconds}`,
    ...(filter ? ['-vf', filter] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(FPS), '-crf', '18', '-movflags', '+faststart', tmp], { windowsHide: true });
  const bytes = await fs.readFile(tmp);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.rename(tmp, path.join(MEDIA_DIR, `${hash}.mp4`));
  return { id, kind: 'video', name: `${id}.mp4`, url: `/@media/${hash}`, hash, duration: seconds, width, height, fps: FPS, bytes: bytes.length };
}

const TINT = 'probe-source-tint', FADE = 'probe-source-fade', TINT_DIRECT = 'probe-source-tint-direct';
/** 两张素材效果卡,写进临时的卡片改动层。反色那张写成 motion 式(产流时从挂载帧回放),溶解那张是 remotion 式(不回放) */
async function writeCards() {
  const dir = path.join(OVERRIDES, 'src', 'cards', 'user');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${TINT}.tsx`), `import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

/** 探针用(stream-source-probe.mjs 临时写进改动层):把输入画面按强度混向它的反色 */
export const probeSourceTint: CardDef<{ amount: number }> = {
  id: "${TINT}",
  name: "源依赖探针:反色",
  description: "把输入画面按强度混向它的反色",
  source: "user",
  kind: "filter",
  frameMode: "stateful",
  inputs: { source: { description: "输入画面" } },
  defaults: { amount: 1 },
  controls: [],
  card: (sources, t, params) => glsl(
    \`uniform sampler2D u_input0;
     uniform float amount;
     void main() { vec4 c = texture(u_input0, v_uv); outColor = vec4(mix(c.rgb, 1.0 - c.rgb, amount), 1.0); }\`,
    [sources.source.at(t)],
    { amount: params.amount },
  ),
};
`);
  // 同一张反色卡的 remotion 式写法(`--measure --direct` 用)
  await fs.writeFile(path.join(dir, `${TINT_DIRECT}.tsx`), `import "../../kernel/remotionStyle";
import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

export const probeSourceTintDirect: CardDef<{ amount: number }> = {
  id: "${TINT_DIRECT}",
  name: "源依赖探针:反色(remotion 式)",
  description: "把输入画面按强度混向它的反色",
  source: "user",
  kind: "filter",
  frameMode: "direct",
  inputs: { source: { description: "输入画面" } },
  defaults: { amount: 1 },
  controls: [],
  card: (sources, t, params) => glsl(
    \`uniform sampler2D u_input0;
     uniform float amount;
     void main() { vec4 c = texture(u_input0, v_uv); outColor = vec4(mix(c.rgb, 1.0 - c.rgb, amount), 1.0); }\`,
    [sources.source.at(t)],
    { amount: params.amount },
  ),
};
`);
  await fs.writeFile(path.join(dir, `${FADE}.tsx`), `import "../../kernel/remotionStyle";
import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

/** 探针用(stream-source-probe.mjs 临时写进改动层):A 在片段时长内溶解到 B;swap 为 1 时反过来 */
export const probeSourceFade: CardDef<{ swap: number }> = {
  id: "${FADE}",
  name: "源依赖探针:溶解",
  description: "A 画面溶解到 B 画面",
  source: "user",
  kind: "transition",
  frameMode: "direct",
  inputs: { A: { description: "转场前的画面" }, B: { description: "转场后的画面" } },
  defaults: { swap: 0 },
  controls: [],
  card: (sources, t, params, ctx) => glsl(
    \`uniform sampler2D u_input0;
     uniform sampler2D u_input1;
     uniform float progress;
     uniform float swap;
     void main() {
       float p = clamp(progress, 0.0, 1.0);
       p = mix(p, 1.0 - p, swap);
       outColor = vec4(mix(texture(u_input0, v_uv).rgb, texture(u_input1, v_uv).rgb, p), 1.0);
     }\`,
    [sources.A.at(t), sources.B.at(t)],
    { progress: t / Math.max(1e-6, ctx.duration), swap: params.swap },
  ),
};
`);
}

/* ------------------------------------------------------------------ 项目 */

/** 三张卡在时间轴上的帧(闭区间)与秒。入点、出点按秒写,落在两帧之间 */
const CLIPS = {
  fx: { frames: [39, 128], start: 1.29, end: 4.29, solo: 'source' },
  tilt: { frames: [70, 144], start: 2.32, end: 4.82, solo: 'spatial' },
  trans: { frames: [166, 195], start: 5.52, end: 6.52, solo: 'source' },
};
const VA = { start: 4.9, end: 6.02 }, VB = { start: 6.02, end: 7, mediaOffset: 0.5 };
const DURATION = 7;
const TILT_FRAME = { x: 640, y: 400, w: 900, h: 260, anchor: [0.5, 0.5], rotateY: 35, rotateX: 12 };

function project(media, { fxOffset = 0.4, swap = 0, rotateY = TILT_FRAME.rotateY } = {}) {
  return {
    id: 'stream-source-probe', name: '源依赖卡与三维外框卡的流探针', width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION,
    themeId: 'dark', camera3dFov: 50, media: [media.a, media.b, media.c], filters: [], pixelMaps: [], audioFx: [], style: {},
    cardNodes: [
      { id: 'n-fx', adapter: 'card', cardId: TINT, kind: 'filter', params: { amount: 1 }, inputs: { source: { nodeId: '@clip/fx/source', offset: 0, rate: 1 } } },
      // 两路输入的时间偏移取成「接着那段视频自己的时间走」:A 是 va 在转场入点时放到哪,B 是 vb 入点之前的那一截
      { id: 'n-trans', adapter: 'card', cardId: FADE, kind: 'transition', params: { swap },
        inputs: { A: { nodeId: '@clip/va/source', offset: +(CLIPS.trans.start - VA.start).toFixed(4), rate: 1 }, B: { nodeId: '@clip/vb/source', offset: +(CLIPS.trans.start - VB.start).toFixed(4), rate: 1 } } },
    ],
    // 第一条序列在最上面
    tracks: [
      { id: 'tr-tilt', name: 'tilt', hidden: false, clips: [{ id: 'tilt', kind: 'card', cardId: 'r6-stateful', start: CLIPS.tilt.start, end: CLIPS.tilt.end, params: {}, frame: { ...TILT_FRAME, rotateY } }] },
      { id: 'tr-trans', name: 'trans', hidden: false, clips: [{ id: 'trans', kind: 'card', cardId: FADE, nodeId: 'n-trans', start: CLIPS.trans.start, end: CLIPS.trans.end, params: { swap } }] },
      { id: 'tr-fx', name: 'fx', hidden: false, clips: [{ id: 'fx', cardId: TINT, nodeId: 'n-fx', mediaId: media.c.id, mediaOffset: fxOffset, start: CLIPS.fx.start, end: CLIPS.fx.end, params: { amount: 1 }, volume: 0 }] },
      { id: 'tr-va', name: 'va', hidden: false, clips: [{ id: 'va', cardId: '', mediaId: media.a.id, mediaOffset: 0, start: VA.start, end: VA.end, params: {}, volume: 0 }] },
      { id: 'tr-vb', name: 'vb', hidden: false, clips: [{ id: 'vb', cardId: '', mediaId: media.b.id, mediaOffset: VB.mediaOffset, start: VB.start, end: VB.end, params: {}, volume: 0 }] },
    ],
  };
}

/** `--measure` 的项目:只有一段视频套一张素材效果卡,从第 0 帧起、整段 */
function measureProject(media, seconds) {
  const card = DIRECT ? TINT_DIRECT : TINT;
  return {
    id: 'stream-source-measure', name: '源依赖卡的流:量耗时与体积', width: WIDTH, height: HEIGHT, fps: FPS, duration: seconds,
    themeId: 'dark', media: [media.c], filters: [], pixelMaps: [], audioFx: [], style: {},
    cardNodes: [{ id: 'n-fx', adapter: 'card', cardId: card, kind: 'filter', params: { amount: 1 }, inputs: { source: { nodeId: '@clip/fx/source', offset: 0, rate: 1 } } }],
    tracks: [{ id: 'tr-fx', name: 'fx', hidden: false, clips: [{ id: 'fx', cardId: card, nodeId: 'n-fx', mediaId: media.c.id, mediaOffset: 0, start: 0, end: seconds, params: { amount: 1 }, volume: 0 }] }],
  };
}

/* ------------------------------------------------------------------ 比像素 */

/** RGBA PNG → 垫在测试页底色上的 RGB(导出页的整帧是透明底,舞台截图叠在测试页的底色上) */
function rgbOver(buf, bg = [0x20, 0x20, 0x20]) {
  const png = PNG.sync.read(buf);
  const out = new Uint8Array(png.width * png.height * 3);
  for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) {
    const a = png.data[i + 3] / 255;
    for (let k = 0; k < 3; k++) out[j + k] = Math.round(png.data[i + k] * a + bg[k] * (1 - a));
  }
  return { width: png.width, height: png.height, rgb: out };
}
/** 两幅 RGB 的差:平均差,和差超过 48 的像素数(「明显不是同一幅」的像素) */
function rgbDiff(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { mean: Infinity, bad: Infinity };
  let sum = 0, bad = 0;
  for (let i = 0; i < a.rgb.length; i += 3) {
    const d0 = Math.abs(a.rgb[i] - b.rgb[i]), d1 = Math.abs(a.rgb[i + 1] - b.rgb[i + 1]), d2 = Math.abs(a.rgb[i + 2] - b.rgb[i + 2]);
    sum += d0 + d1 + d2;
    if (d0 > 48 || d1 > 48 || d2 > 48) bad++;
  }
  return { mean: sum / a.rgb.length, bad };
}
const toPng = (img) => { const png = new PNG({ width: img.width, height: img.height }); for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) { png.data[i] = img.rgb[j]; png.data[i + 1] = img.rgb[j + 1]; png.data[i + 2] = img.rgb[j + 2]; png.data[i + 3] = 255; } return PNG.sync.write(png); };

const hostHtml = (oa, ob) => `<!doctype html><html><head><meta charset="utf-8"><title>stream source probe host</title></head>
<body style="margin:0;background:#202020">
<iframe id="a" src="${oa}/?stage=1&id=A&preview=stage&prerender=1" style="width:${WIDTH}px;height:${HEIGHT}px;border:0;display:block"></iframe>
<iframe id="b" src="${ob}/?stage=1&id=B&preview=stage&prerender=1" style="width:${WIDTH}px;height:${HEIGHT}px;border:0;display:block;opacity:0;pointer-events:none;position:absolute;left:0;top:0"></iframe>
<script type="module">
function createStageRpc(target, targetOrigin) {
  let nextId = 1; const pending = new Map(); const listeners = new Set();
  window.addEventListener('message', (e) => {
    if (e.source !== target) return; const d = e.data;
    if (d && d.type === 'pc-rpc-reply') { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.ok ? p.resolve(d.result) : p.reject(new Error(d.error)); return; }
    if (d && typeof d.type === 'string' && ['mediaReady', 'frame', 'ended', 'settled', 'probe', 'demote', 'probe-frame'].includes(d.type)) for (const l of listeners) l(d);
  });
  const call = (method) => (...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); target.postMessage({ type: 'pc-rpc', id, method, args }, targetOrigin); });
  const c = { onEvent: (l) => { listeners.add(l); return () => listeners.delete(l); } };
  for (const m of ['setProject', 'setTime', 'setRole', 'play', 'pause', 'setSuppressed', 'setStreamPlanes', 'setPlaying']) c[m] = call(m);
  return c;
}
window.__frames = [];
const waitReady = (frame, targetOrigin) => new Promise((res) => {
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    res(createStageRpc(frame.contentWindow, targetOrigin));
  });
});
window.__ready = Promise.all([waitReady(document.getElementById('a'), '${oa}'), waitReady(document.getElementById('b'), '${ob}')])
  .then(([a, b]) => { window.__rpc = a; window.__rpcB = b; a.onEvent((ev) => { if (ev.type === 'frame') window.__frames.push({ sec: ev.sec, at: performance.now() }); }); return true; });
</script></body></html>`;

/* ------------------------------------------------------------------ 主流程 */

const out = { measure: MEASURE, out: OUT, size: `${WIDTH}x${HEIGHT}`, fps: FPS };
await fs.mkdir(MEDIA_DIR, { recursive: true });
await fs.mkdir(DATA_DIR, { recursive: true });
let dev = null, bakery = null, pipeline = null, browser = null, hostServer = null, dropSpares = () => {};
const started = Date.now();
try {
  // 这几样环境变量本进程里的管线也要(卡片改动层、素材目录):和开发服务器用同一份
  const env = { PROMPTCUT_EXPORT_DIR: WORK, PROMPTCUT_DATA_DIR: DATA_DIR, PROMPTCUT_CARD_OVERRIDES: OVERRIDES, PROMPTCUT_NO_PORT_FILE: '1',
    PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '', PROMPTCUT_DEVICE_ID: `srcprobe-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'source-probe' };
  Object.assign(process.env, env);
  const { FramePipeline } = await import('../../server/frame-pipeline.mjs');
  const { handleStreamRequest, splitFmp4, SPARSE_STRIDE } = await import('../../server/frame-stream.mjs');
  const { openBakery } = await import('../../server/bakery/chrome.mjs');
  const { bakeFrames } = await import('../../server/bakery/bake.mjs');
  const { findFfmpeg, openStreamSegmentEncoder, dropStreamEncoderSpares } = await import('../../server/bakery/ffmpeg.mjs');
  const { decodePngRgba } = await import('../../server/bakery/capture-canvas.mjs');
  const { streamPlanesFor } = await import('../../src/render/streamPlayer.ts');
  const ffmpeg = await findFfmpeg();
  dropSpares = dropStreamEncoderSpares;

  await writeCards();
  const seconds = MEASURE ? MEASURE_SECONDS + 1 : DURATION + 1;
  const media = {
    a: MEASURE ? null : await makeVideo(ffmpeg, 'm-a', null, seconds, WIDTH, HEIGHT),
    b: MEASURE ? null : await makeVideo(ffmpeg, 'm-b', 'hflip,hue=h=120', seconds, WIDTH, HEIGHT),
    c: await makeVideo(ffmpeg, 'm-c', 'vflip,hue=h=240', seconds, WIDTH, HEIGHT),
  };
  dev = await startDevServer({ env, port: PORT, logFile: path.join(WORK, 'vite.log'), log: (m) => say('dev', { m }) });
  const origin = dev.origin;
  out.origin = origin;
  say('spawn', { pid: dev.pid, port: PORT, stagePorts: dev.stagePorts });

  /** 起一条管线:钉成重卡;加「稀疏的都齐了以后先卡住」的闸(`hold`),放行以后才补满密度 */
  const openPipeline = (root) => {
    const p = new FramePipeline({ root, origin: () => origin, interactive: true, playhead: () => null });
    p.streamPicked = () => true;
    const producer = p.streamProducer();
    producer.attachRoute();
    const gate = { hold: true };
    const busy = p.streamBusy.bind(p);
    p.streamBusy = (now) => busy(now) || (gate.hold && producer.streams.size > 0 && !producer.encoding.size && !producer.needsSparseAnywhere());
    const stored = [];
    const store = producer.storeSegment.bind(producer);
    producer.storeSegment = async (state, generation, o) => { const r = await store(state, generation, o); stored.push({ key: state.spec.streamKey, n: o.segment, stride: o.stride, at: Date.now() }); return r; };
    const layers = new Map();
    p.readyIndex.subscribe((message) => { if (message.type === 'layer' && message.kind === 'stream') layers.set(message.clipId, message); });
    return { pipeline: p, producer, gate, stored, layers };
  };
  /** 这一版的每条流每个分段都满足 `want`(而且没有在产的)才回状态 */
  const allAt = (producer, keys, want) => {
    const s = producer.status();
    const rows = s.streams.filter((row) => keys.has(row.streamKey));
    if (rows.length !== keys.size) return null;
    for (const row of rows) for (let n = row.firstSegment; n <= row.lastSegment; n++) if (!want(row.segments[n])) return null;
    return s;
  };
  const bytesOf = (state) => {
    let sparse = 0, dense = 0, inits = 0;
    for (const seg of Object.values(state.manifest.segments)) { if (seg.stride > 1) sparse += seg.bytes; else dense += seg.bytes; }
    for (const init of Object.values(state.manifest.inits)) inits += init.bytes ?? 0;
    return { sparse, dense, inits };
  };

  /* ================================================================ 只量 */
  if (MEASURE) {
    const PROJECT = measureProject(media, MEASURE_SECONDS);
    const P = openPipeline(path.join(OUT, 'library'));
    pipeline = P.pipeline;
    const t0 = Date.now();
    const entry = await pipeline.preload(PROJECT);
    void entry;
    const keysOf = () => new Set([...P.producer.streams.values()].map((s) => s.spec.streamKey));
    const sparse = await until('稀疏版铺满', () => (P.producer.streams.size ? allAt(P.producer, keysOf(), (seg) => !!seg) : null), 1_800_000, 200);
    const sparseMs = Date.now() - t0;
    const state = [...P.producer.streams.values()][0];
    if (!sparse || !state) throw new Error(`稀疏版没铺完:${JSON.stringify(P.producer.status().log.slice(-8))}`);
    const sparseBytes = bytesOf(state);
    const segments = state.spec.lastSegment + 1;
    const sparseCapture = { ...(state.capture ?? {}) };
    P.gate.hold = false;
    P.producer.kick();
    const dense = await until('满密度补齐', () => { const s = allAt(P.producer, keysOf(), (seg) => seg?.stride === 1); return s && !P.producer.workers.size && !P.producer.encoding.size ? s : null; }, 3_600_000, 300);
    const denseMs = Date.now() - t0;
    if (!dense) throw new Error(`满密度没补完:${JSON.stringify(P.producer.status().log.slice(-8))}`);
    const denseBytes = bytesOf(state);
    const frames = state.spec.lastFrame - state.spec.originFrame + 1;
    const cap = state.capture ?? {};
    out.result = {
      seconds: MEASURE_SECONDS, frames, segments, card: DIRECT ? 'remotion 式' : 'motion 式', encoder: dense.encoder, solo: state.spec.solo ?? null, replay: state.spec.replay,
      sourceVideoBytes: media.c.bytes,
      sparseMs, denseMs, denseOnlyMs: denseMs - sparseMs,
      sparseBytes: sparseBytes.sparse, denseBytes: denseBytes.dense, initBytes: denseBytes.inits,
      // 取图那一段的累计(生产者自己记的):截了几张、截图一共多少毫秒、推帧(含等素材效果卡解出这一帧的视频)一共多少毫秒
      sparsePass: { captured: sparseCapture.frames ?? 0, captureMs: Math.round(sparseCapture.captureMs ?? 0), stepMs: Math.round(sparseCapture.stepMs ?? 0) },
      densePass: { captured: (cap.frames ?? 0) - (sparseCapture.frames ?? 0), captureMs: Math.round((cap.captureMs ?? 0) - (sparseCapture.captureMs ?? 0)), stepMs: Math.round((cap.stepMs ?? 0) - (sparseCapture.stepMs ?? 0)) },
      tight: state.manifest.tight, bound: state.manifest.bound, resets: state.resets ?? null, replayedFrames: state.replayedFrames ?? 0,
    };
    say('measure', out.result);
    check(state.spec.kind === 'card' && state.spec.solo === 'source', '量的这条流是源依赖卡的单卡流', { kind: state.spec.kind, solo: state.spec.solo });
    check(sparseBytes.sparse > 0 && denseBytes.dense > 0, '稀疏版、满密度版都产出来了', { sparseBytes, denseBytes });
  } else {
  /* ================================================================ 逐帧核对 */
  const PROJECT = project(media);
  const A = openPipeline(path.join(OUT, 'library'));
  pipeline = A.pipeline;
  const { producer } = A;
  const t0 = Date.now();
  await pipeline.preload(PROJECT);
  const keysNow = () => new Set([...producer.streams.values()].map((s) => s.spec.streamKey));

  // ---------- 1. 计划 + 2. 稀疏版
  const sparseStatus = await until('三条流的稀疏版铺满', () => (producer.streams.size ? allAt(producer, keysNow(), (seg) => !!seg) : null), 900_000, 200);
  if (!sparseStatus) throw new Error(`稀疏版没铺完:${JSON.stringify(producer.status().log.slice(-8))}`);
  out.sparseMs = Date.now() - t0;
  out.encoder = sparseStatus.encoder;
  const states = () => [...producer.streams.values()];
  const stateOf = (clipId) => states().find((s) => s.spec.topClipId === clipId) ?? null;
  out.plan = states().map((s) => ({ clip: s.spec.topClipId, kind: s.spec.kind, plane: s.spec.plane, solo: s.spec.solo ?? null, replay: s.spec.replay,
    originFrame: s.spec.originFrame, lastFrame: s.spec.lastFrame, lastSegment: s.spec.lastSegment, bound: s.spec.bound, offset: s.spec.offset }));
  say('plan', { ms: out.sparseMs, plan: out.plan });
  check(states().length === 3, '有三条流', out.plan.map((p) => `${p.kind}:${p.clip}`));
  for (const [id, want] of Object.entries(CLIPS)) {
    const st = stateOf(id);
    if (!check(!!st, `${id}:有这条流`)) continue;
    const { spec, manifest } = st;
    const lastSegment = Math.floor((want.frames[1] - want.frames[0]) / STREAM_SEGMENT_FRAMES);
    check(spec.kind === 'card' && spec.plane === 'local' && spec.solo === want.solo, `${id}:单卡流,solo 是 ${want.solo}`, { kind: spec.kind, plane: spec.plane, solo: spec.solo });
    check(spec.originFrame === want.frames[0] && spec.lastFrame === want.frames[1] && spec.firstSegment === 0 && spec.lastSegment === lastSegment,
      `${id}:第一帧 ${want.frames[0]}、最后一帧 ${want.frames[1]}、分段 0～${lastSegment}`, { originFrame: spec.originFrame, lastFrame: spec.lastFrame, lastSegment: spec.lastSegment });
    check(want.frames[0] % STREAM_SEGMENT_FRAMES !== 0, `${id}:第一帧不是 15 的倍数`, want.frames[0]);
    check(spec.replay === (id !== 'trans'), `${id}:回放与否(反色那张和 r6 是 motion 式,溶解那张是 remotion 式)`, spec.replay);
    const sparseSegs = Object.entries(manifest.segments);
    check(sparseSegs.length === lastSegment + 1 && sparseSegs.every(([, seg]) => seg.stride === SPARSE_STRIDE), `${id}:稀疏版每个分段的间隔是一个分段的帧数`, sparseSegs.map(([n, seg]) => [n, seg.stride]));
    check(sparseSegs.every(([n, seg]) => seg.samples === streamSegmentFrameCount(Number(n), want.frames[0], want.frames[1])), `${id}:稀疏分段的样本数 = 这一段盖住的帧数`, sparseSegs.map(([n, seg]) => [n, seg.samples]));
    check(sparseSegs.every(([, seg]) => seg.box && seg.box.w > 0 && seg.box.h > 0), `${id}:稀疏版每个分段带位置矩形`, sparseSegs.map(([n, seg]) => [n, seg.box ?? null]));
    const layer = A.layers.get(id);
    check(!!layer && layer.key === spec.streamKey && layer.originFrame === want.frames[0], `${id}:就绪消息带着流键和第一帧`, layer && { key: layer.key.slice(0, 12), originFrame: layer.originFrame, ranges: layer.ranges });
  }
  out.sparseBytes = Object.fromEntries(states().map((s) => [s.spec.topClipId, bytesOf(s).sparse]));
  // fx 的位置矩形:视频铺满画面、不透明,所以每个分段的框就是整个画面
  {
    const st = stateOf('fx');
    const boxes = Object.values(st?.manifest.segments ?? {}).map((seg) => seg.box);
    check(boxes.length > 0 && boxes.every((b) => b && b.x === 0 && b.y === 0 && b.w === WIDTH && b.h === HEIGHT), 'fx:位置矩形是整个画面(流里带着视频,不透明)', boxes.slice(0, 2));
  }

  // ---------- 参照:完整项目在导出页顺推,每帧截一张整幅
  const emptyUrl = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
  bakery = await openBakery({ url: emptyUrl });
  const LAST = CLIPS.trans.frames[1];
  /** 导出页顺推 0..last,每帧截一张整幅(透明底)。回 `{ png(f), rgba(f), rgb(f) }` */
  const exportAll = async (proj, last, dir) => {
    await fs.mkdir(dir, { recursive: true });
    const pngs = new Map();
    await bakery.reset(proj, emptyUrl);
    bakery.streamLease = null;
    await bakeFrames(bakery, { out: dir, fps: FPS, frames: `0-${last}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
      onFrame: async (i, buf) => { pngs.set(i, Buffer.from(buf)); } });
    const rgbaCache = new Map(), rgbCache = new Map();
    return {
      has: (f) => pngs.has(f),
      png: (f) => pngs.get(f),
      rgba(f) { if (!rgbaCache.has(f)) { const d = decodePngRgba(pngs.get(f))?.data; if (!d) throw new Error(`解不开第 ${f} 帧的参照`); rgbaCache.set(f, d); if (rgbaCache.size > 40) rgbaCache.delete(rgbaCache.keys().next().value); } return rgbaCache.get(f); },
      rgb(f) { if (!rgbCache.has(f)) { rgbCache.set(f, rgbOver(pngs.get(f))); if (rgbCache.size > 24) rgbCache.delete(rgbCache.keys().next().value); } return rgbCache.get(f); },
    };
  };
  const tExport = Date.now();
  const exported = await exportAll(PROJECT, LAST + 1, path.join(OUT, 'ref-project'));
  out.exportMs = Date.now() - tExport;
  say('exported', { frames: LAST + 2, ms: out.exportMs });

  // ---------- 舞台
  const u = new URL(origin);
  const [originA, originB] = dev.stagePorts.slice(0, 2).map((p) => `${u.protocol}//${u.hostname}:${p}`);
  const HOST_PATH = '/__stream-source-probe-host';
  /** 被换掉的稀疏分段文件生产者过几秒就删;流播放器手里可能还拿着旧清单,留一份照样给(同 `sparse-stream-probe`) */
  const kept = new Map();
  let servedKept = 0;
  hostServer = await serve(HOST_PORT, (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === HOST_PATH) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(hostHtml(originA, originB)); return; }
    if (url.pathname.startsWith('/api/frames/')) {
      const rest = url.pathname.slice('/api/frames'.length);
      const m = /^\/stream\/([a-f0-9]{64})\/(\d+-[a-f0-9]{16}\.m4s)$/.exec(rest);
      if (m) {
        const file = path.join(pipeline.streamProducer().store.dir(m[1]), m[2]);
        if (fsSync.existsSync(file)) { try { kept.set(rest, fsSync.readFileSync(file)); } catch { /* 正在删 */ } }
        else if (kept.has(rest)) { servedKept++; res.setHeader('Content-Type', 'video/iso.segment'); res.end(kept.get(rest)); return; }
      }
      if (handleStreamRequest(pipeline.streamProducer().store, req, res, rest)) return;
    }
    res.statusCode = 404; res.end();
  }, '127.0.0.1');
  const base = `http://127.0.0.1:${hostServer.address().port}`;
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  const frameA = () => page.frames().find((f) => f.url().startsWith(originA));
  const frameB = () => page.frames().find((f) => f.url().startsWith(originB));
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const rpcB = (method, ...a) => page.evaluate((m, a2) => window.__rpcB[m](...a2), method, a);
  const diagA = () => frameA().evaluate(() => window.__pcStageDiag());
  const heavy = Object.keys(CLIPS);
  let layersNow = () => [...A.layers.values()];
  const planesAt = (f) => streamPlanesFor(layersNow(), new Set(heavy), f);
  /** (重新)打开父页和两个舞台:流播放器从头建 */
  const openStage = async (proj) => {
    await page.goto(base + HOST_PATH);
    await page.waitForFunction(() => window.__ready, { timeout: 120000 });
    await page.evaluate(() => window.__ready);
    for (const f of [frameA(), frameB()]) await f.evaluate((b) => { window.__pcStreamBase = b; }, base);
    await rpc('setProject', proj, { reset: true });
    await rpcB('setProject', proj, { reset: true });
    await rpc('setRole', 'front');
    await rpcB('setRole', 'back', { job: 'probe' });
    await rpc('setTime', CLIPS.fx.frames[0] / FPS);
    await rpc('setPlaying', true);
    await rpc('setSuppressed', heavy);
  };
  let iframeBox = null;
  const shotStage = async () => {
    await frameA().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } });
    return rgbOver(await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } }));
  };
  /** 把时间设到第 f 帧,等每条在场的流画出这一帧。照父页的做法:先发流平面,再抑制这一帧贴流的那几张,再设时间 */
  const seekTo = async (f) => {
    const planes = planesAt(f);
    await rpc('setStreamPlanes', planes);
    await rpc('setSuppressed', [...new Set(planes.flatMap((p) => p.clipIds))]);
    const got = await frameA().evaluate(async (frame, fps, want) => {
      const now = window.__pcRealNow ?? (() => performance.now());
      const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
      const start = now();
      await window.__pcStage.setTime(frame / fps + 1e-4);
      for (;;) {
        const d = window.__pcStageDiag();
        const tracks = d.streams.tracks;
        if (tracks.length === want && tracks.every((t) => t.lastDrawn === frame)) {
          await wait(0);
          return { ms: +(now() - start).toFixed(1), errors: tracks.map((t) => t.errors), placeholders: window.__pcStageDiag().placeholders };
        }
        if (now() - start > 8000) return { ms: null, drawn: tracks.map((t) => t.lastDrawn), errors: tracks.map((t) => t.lastError), tracks: tracks.length };
        await wait(2);
      }
    }, f, FPS, planes.length);
    return { planes, got };
  };
  const onStage = (f) => Object.keys(CLIPS).filter((id) => f >= CLIPS[id].frames[0] && f <= CLIPS[id].frames[1]);

  await openStage(PROJECT);
  iframeBox = await (await page.$('#a')).boundingBox();

  // ---------- 2(续). 舞台贴稀疏版:分段中间的帧,贴出来的是分段第一帧的画面
  {
    const rows = [];
    // [帧, 判哪条流] —— fx 单独在场的、trans 的、tilt 单独在场的(第 129 帧以后下面没有东西)
    for (const [f, id] of [[46, 'fx'], [63, 'fx'], [174, 'trans'], [190, 'trans'], [137, 'tilt'], [142, 'tilt']]) {
      const { planes, got } = await seekTo(f);
      if (!check(got.ms !== null && planes.length === onStage(f).length, `舞台贴稀疏版:第 ${f} 帧流平面画出来了`, { got, planes: planes.length })) continue;
      const stage = await shotStage();
      const first = streamSegmentFirstFrame(streamSegmentOf(f, CLIPS[id].frames[0]), CLIPS[id].frames[0]);
      const scores = [...new Set([first, f, f - 1])].map((c) => [c, rgbDiff(stage, exported.rgb(c)).mean]).sort((x, y) => x[1] - y[1]);
      rows.push({ frame: f, clip: id, segmentFirst: first, best: scores[0][0], scores: scores.map(([c, v]) => [c, round2(v)]), placeholders: got.placeholders?.length ?? 0 });
      if (f === 46) { await fs.writeFile(path.join(OUT, 'stage-sparse-46.png'), toPng(stage)); await fs.writeFile(path.join(OUT, 'export-39.png'), toPng(exported.rgb(39))); await fs.writeFile(path.join(OUT, 'export-46.png'), toPng(exported.rgb(46))); }
    }
    out.stageSparse = rows;
    say('stage-sparse', { rows: rows.map((r) => [r.frame, r.clip, r.segmentFirst, r.best, r.scores]) });
    check(rows.length === 6, '舞台贴稀疏版:六帧都比过了', rows.length);
    check(rows.every((r) => r.best === r.segmentFirst), '舞台贴稀疏版:分段中间的帧,贴的是分段第一帧的画面(源依赖卡的流连视频一起停在那一帧)', rows.filter((r) => r.best !== r.segmentFirst));
    check(rows.every((r) => r.placeholders === 0), '舞台贴稀疏版:没有占位符', rows.filter((r) => r.placeholders));
  }

  // ---------- 3. 放行补满密度;产流逐帧
  const tDense = Date.now();
  A.gate.hold = false;
  producer.kick();
  const denseStatus = await until('三条流补成满密度', () => { const s = allAt(producer, keysNow(), (seg) => seg?.stride === 1); return s && !producer.workers.size && !producer.encoding.size ? s : null; }, 1_800_000, 300);
  if (!denseStatus) throw new Error(`满密度没补完:${JSON.stringify(producer.status().log.slice(-8))}`);
  out.denseMs = Date.now() - tDense;
  out.denseBytes = Object.fromEntries(states().map((s) => [s.spec.topClipId, bytesOf(s).dense]));
  say('dense', { ms: out.denseMs, bytes: out.denseBytes });
  out.streams = [];
  for (const [id, want] of Object.entries(CLIPS)) {
    const state = stateOf(id);
    if (!state) continue;
    const { spec, manifest } = state;
    const [first0, last0] = want.frames;
    const lastSegment = spec.lastSegment;
    const dir = path.join(OUT, `ref-${id}`);
    const truth = await exportAll(state.isolated, last0, dir);
    const got = newError(), floor = newError(), next = newError();
    let frames = 0, minMargin = Infinity;
    const wrong = [];
    for (let n = 0; n <= lastSegment; n++) {
      const seg = manifest.segments[n];
      if (!check(seg?.stride === 1, `${id}#${n}:满密度`, seg)) continue;
      const count = streamSegmentFrameCount(n, first0, last0);
      check(seg.samples === count, `${id}#${n}:样本数 = 这一段盖住的帧数`, { samples: seg.samples, count });
      check(seg.box !== undefined, `${id}#${n}:补成满密度以后位置矩形还在`, seg.box ?? null);
      const meta = manifest.inits[seg.init];
      const rect = { x: meta.rect.x + spec.offset.x, y: meta.rect.y + spec.offset.y, w: meta.rect.w, h: meta.rect.h };
      const init = await fs.readFile(producer.store.initFile(spec.streamKey, seg.init));
      const bytes = await fs.readFile(path.join(producer.store.dir(spec.streamKey), seg.file));
      const decoded = await decodeSegment(ffmpeg, init, bytes, dir, `seg-${n}`);
      const frameBytes = rect.w * 2 * (rect.h + 8) * 3;
      if (!check(decoded.length === seg.samples * frameBytes, `${id}#${n}:解出 ${seg.samples} 帧`, decoded.length / frameBytes)) continue;
      const first = streamSegmentFirstFrame(n, first0);
      // 参照的底:同一批真画面裁到同一个矩形,原样过一遍同一个编码器
      const plain = openStreamSegmentEncoder(ffmpeg, { encoder: denseStatus.encoder, fps: FPS, raw: { width: rect.w, height: rect.h } });
      for (let k = 0; k < count; k++) await plain.write(cropRgba(truth.rgba(first + k), WIDTH, rect));
      const plainParts = splitFmp4((await plain.finish()).bytes);
      const plainDecoded = await decodeSegment(ffmpeg, plainParts.init, plainParts.segments[0], dir, `plain-${n}`);
      for (let k = 0; k < count; k++) {
        const f = first + k;
        const picture = decoded.subarray(k * frameBytes, (k + 1) * frameBytes);
        const scores = [];
        for (let c = f - 2; c <= f + 2; c++) if (c >= Math.max(0, first0 - 1) && c <= last0) scores.push([c, (() => { const e = newError(); tallyDecodedDirect(e, picture, rect, truth.rgba(c), WIDTH); return e.count ? e.sum / e.count : 0; })()]);
        scores.sort((x, y) => x[1] - y[1]);
        if (scores[0][0] !== f) wrong.push({ frame: f, segment: n, sample: k, best: scores[0][0], scores: scores.map(([c, d]) => [c, round2(d)]) });
        else if (scores[1]) minMargin = Math.min(minMargin, scores[1][1] / Math.max(scores[0][1], 1e-6));
        tallyDecodedDirect(got, picture, rect, truth.rgba(f), WIDTH);
        tallyDecodedDirect(floor, plainDecoded.subarray(k * frameBytes, (k + 1) * frameBytes), rect, truth.rgba(f), WIDTH);
        tallyDecodedDirect(next, picture, rect, truth.rgba(f < last0 ? f + 1 : f - 1), WIDTH);
        frames++;
        if (f === first0 + 7) await savePreview(path.join(OUT, 'previews', `${id}-stream-truth-${f}.png`), cropRgba(truth.rgba(f), WIDTH, rect), rect.w, rect.h);
      }
    }
    const record = { clip: id, solo: spec.solo, streamKey: spec.streamKey.slice(0, 16), frames, tight: manifest.tight, bound: manifest.bound, resets: state.resets ?? null, replayedFrames: state.replayedFrames ?? 0,
      error: { 对它自己那一帧: errorSummary(got), 参照_同一幅画面原样过一遍编码器: errorSummary(floor), 对照_下一帧: errorSummary(next) },
      wrongFrames: wrong.slice(0, 6), wrongCount: wrong.length, minMargin: Number.isFinite(minMargin) ? round2(minMargin) : null };
    out.streams.push(record);
    say('produce-compare', { clip: id, frames, wrong: wrong.length, minMargin: record.minMargin, ...record.error });
    const g = record.error.对它自己那一帧, ref = record.error.参照_同一幅画面原样过一遍编码器, nx = record.error.对照_下一帧;
    check(frames === last0 - first0 + 1, `${id}:从第 ${first0} 帧到第 ${last0} 帧每一帧都比过了`, frames);
    check(wrong.length === 0, `${id}:产流逐帧 —— 每个样本最像的都是它该是的那一帧`, { wrong: wrong.length, first: wrong.slice(0, 3) });
    check(g.mean <= ref.mean + 0.5 && g.bad <= ref.bad * 1.25 + g.pixels * 0.001, `${id}:和它自己那一帧的差在编码误差以内`, { got: g, ref });
    check(nx.mean > 2 * g.mean, `${id}:对照(下一帧)明显更大`, { got: g, next: nx });
    if (!KEEP) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }

  // ---------- 4. 舞台贴流,逐帧(拖动)
  /** 一批帧:逐帧设时间、等流画出来、截舞台,和 `ref` 的同一帧、前后各一帧比。回汇总 */
  const scrubFrames = async (order, ref, tag) => {
    const acc = { frames: 0, wrong: [], notDrawn: [], retried: [], placeholders: [], minMargin: Infinity, seekMs: [], same: { mean: 0, bad: 0 }, next: { mean: 0, bad: 0 }, byClip: {}, rows: [] };
    const score = (stage, f) => { const scores = [f - 1, f, f + 1].map((c) => [c, rgbDiff(stage, ref.rgb(c))]); return { scores, best: [...scores].sort((x, y) => x[1].mean - y[1].mean)[0][0] }; };
    for (const f of order) {
      const { planes, got } = await seekTo(f);
      if (planes.length !== onStage(f).length) { acc.wrong.push({ frame: f, planes: planes.length, expectPlanes: onStage(f).length }); continue; }
      if (got.ms === null) { acc.notDrawn.push({ frame: f, ...got }); continue; }
      acc.seekMs.push(got.ms);
      if (got.placeholders?.length) acc.placeholders.push({ frame: f, placeholders: got.placeholders });
      let stage = await shotStage();
      let { scores, best } = score(stage, f);
      if (best !== f) {
        // 没对上:先存下来,等一会儿原样再截(截图那一刻舞台还没合成完),还不对就重新设一次时间;如实记进 retried
        await fs.writeFile(path.join(OUT, `stage-mismatch-${tag}-${f}.png`), toPng(stage));
        const firstTry = { best, scores: scores.map(([c, d]) => [c, round2(d.mean), d.bad]) };
        await sleep(400);
        stage = await shotStage();
        ({ scores, best } = score(stage, f));
        let how = 'reshoot';
        if (best !== f) { how = 'reseek'; await seekTo(f); await sleep(200); stage = await shotStage(); ({ scores, best } = score(stage, f)); }
        acc.retried.push({ frame: f, first: firstTry, fixedBy: best === f ? how : null });
      }
      const same = scores[1][1];
      if (best !== f) acc.wrong.push({ frame: f, best, scores: scores.map(([c, d]) => [c, round2(d.mean), d.bad]) });
      else acc.minMargin = Math.min(acc.minMargin, Math.min(scores[0][1].mean, scores[2][1].mean) / Math.max(same.mean, 1e-6));
      const other = scores[0][1].mean < scores[2][1].mean ? scores[0][1] : scores[2][1];
      acc.same.mean += same.mean; acc.same.bad += same.bad; acc.next.mean += other.mean; acc.next.bad += other.bad;
      acc.frames++;
      acc.rows.push({ frame: f, same: round2(same.mean), prev: round2(scores[0][1].mean), next: round2(scores[2][1].mean) });
      const key = onStage(f).join('+');
      const row = acc.byClip[key] ||= { frames: 0, same: 0, next: 0, sameMax: 0 };
      row.frames++; row.same += same.mean; row.next += other.mean; row.sameMax = Math.max(row.sameMax, same.mean);
      if ([100, 137, 180].includes(f)) { await fs.writeFile(path.join(OUT, `stage-${tag}-${f}.png`), toPng(stage)); await fs.writeFile(path.join(OUT, `export-${tag}-${f}.png`), toPng(ref.rgb(f))); }
    }
    const n = Math.max(1, acc.frames);
    return { frames: acc.frames, wrong: acc.wrong.slice(0, 6), wrongCount: acc.wrong.length, notDrawn: acc.notDrawn.slice(0, 6), notDrawnCount: acc.notDrawn.length,
      retried: acc.retried, retriedCount: acc.retried.length, placeholdersLeft: acc.placeholders.slice(0, 6), placeholdersLeftCount: acc.placeholders.length,
      seekMsMedian: acc.seekMs.length ? [...acc.seekMs].sort((a, b) => a - b)[acc.seekMs.length >> 1] : null, seekMsMax: acc.seekMs.length ? Math.max(...acc.seekMs) : null,
      minMargin: Number.isFinite(acc.minMargin) ? round2(acc.minMargin) : null,
      // 和同一帧差得最多的几帧、和相邻帧分得最不开的几帧(给人看的:哪几帧最悬)
      worstSame: [...acc.rows].sort((x, y) => y.same - x.same).slice(0, 4),
      closest: [...acc.rows].sort((x, y) => Math.min(x.prev, x.next) / Math.max(x.same, 1e-6) - Math.min(y.prev, y.next) / Math.max(y.same, 1e-6)).slice(0, 4),
      对导出同一帧: { mean: round2(acc.same.mean / n), bad: Math.round(acc.same.bad / n) }, 对照_导出相邻帧里更像的那一帧: { mean: round2(acc.next.mean / n), bad: Math.round(acc.next.bad / n) },
      按在场的流分: Object.fromEntries(Object.entries(acc.byClip).map(([k, r]) => [k, { frames: r.frames, same: round2(r.same / r.frames), sameMax: round2(r.sameMax), next: round2(r.next / r.frames) }])) };
  };
  // 换一页(流播放器从头建:刚才贴过稀疏版,它手里是旧清单),然后打乱着跳
  await openStage(PROJECT);
  const all = [];
  for (let f = CLIPS.fx.frames[0]; f <= CLIPS.tilt.frames[1]; f++) all.push(f);
  for (let f = CLIPS.trans.frames[0]; f <= CLIPS.trans.frames[1]; f++) all.push(f);
  const order = [...all];
  for (let i = 0; i < order.length; i++) { const j = (i * 37 + 11) % order.length; [order[i], order[j]] = [order[j], order[i]]; }
  out.scrub = await scrubFrames(order, exported, 'scrub');
  say('scrub', out.scrub);
  check(out.scrub.notDrawnCount === 0, '拖动:每一帧流平面都画出了这一帧', out.scrub.notDrawn);
  check(out.scrub.placeholdersLeftCount === 0, '拖动:流的帧画出来的那一刻没有占位符', out.scrub.placeholdersLeft);
  check(out.scrub.retried.every((r) => r.fixedBy !== null), '拖动:重截过的帧原样再截就对上了', out.scrub.retried.slice(0, 3));
  check(out.scrub.frames === all.length, `拖动:三条流在场的 ${all.length} 帧每一帧都比过了`, out.scrub.frames);
  check(out.scrub.wrongCount === 0, '拖动逐帧 —— 舞台上贴出来的画面最像的都是导出页的同一帧(不是前一帧、后一帧)', { wrong: out.scrub.wrongCount, first: out.scrub.wrong.slice(0, 3) });
  check(out.scrub.对导出同一帧.mean < 3, '拖动:舞台(贴流)与导出同一帧的平均差 < 3/255', out.scrub.对导出同一帧);

  // ---------- 5. 真的播放:从 fx 入场之前起播,播进 tilt,暂停
  {
    const forced = layersNow().map((l) => ({ clipIds: [l.clipId], key: l.key, ranges: l.ranges, originFrame: l.originFrame }));
    const from = 60;
    await rpc('setTime', from / FPS + 1e-4);
    await rpc('setStreamPlanes', forced);
    await rpc('setSuppressed', heavy);
    await page.evaluate(() => { window.__frames = []; });
    await rpc('play', from / FPS + 1e-4);
    await sleep(900);
    const stop = await rpc('pause');
    const frames = await page.evaluate(() => window.__frames);
    const steps = frames.slice(1).map((f, i) => +(f.sec - frames[i].sec).toFixed(6));
    const stopped = Math.round(stop.stoppedAt * FPS);
    await sleep(150);
    const d = await diagA();
    const stage = await shotStage();
    const scores = [stopped - 1, stopped, stopped + 1].map((c) => [c, rgbDiff(stage, exported.rgb(Math.min(c, LAST + 1)))]);
    const best = [...scores].sort((x, y) => x[1].mean - y[1].mean)[0][0];
    const active = d.streams.tracks.filter((t) => t.lastDrawn !== null);
    out.play = { from, stoppedAt: stopped, beats: frames.length, noSkip: steps.every((s) => Math.abs(s - 1 / FPS) < 1e-6),
      tracks: d.streams.tracks.map((t) => ({ id: String(t.id).slice(0, 14), lastDrawn: t.lastDrawn, drawn: t.drawn, errors: t.errors })),
      scores: scores.map(([c, x]) => [c, round2(x.mean), x.bad]), best };
    say('play', out.play);
    check(out.play.noSkip && frames.length > 5, '播放:不跳帧(frame 的 sec 差恒为 1/fps)', { beats: frames.length, steps: [...new Set(steps)] });
    check(stopped > CLIPS.tilt.frames[0] && stopped <= CLIPS.fx.frames[1], '播放:播进了 tilt 压着 fx 的那一段', stopped);
    check(active.length >= 2 && active.every((t) => t.errors === 0 && t.drawn > 3), '播放:两条流平面一路画着,解码器没报错', out.play.tracks);
    check(active.every((t) => t.lastDrawn === stopped), '播放:暂停时流平面停在暂停的那一帧', out.play.tracks);
    check(best === stopped && scores[1][1].mean < 3, '播放:暂停的那一帧,舞台(贴流)最像导出页的同一帧', out.play.scores);
  }

  // ---------- 6. 改了输入:视频的裁剪(fx)、卡的参数(trans)、三维的角度(tilt)
  {
    const before = Object.fromEntries(states().map((s) => [s.spec.topClipId, { key: s.spec.streamKey, contentKey: s.spec.contentKey }]));
    const storedBefore = A.stored.length;
    const EDITED = project(media, { fxOffset: 1.4, swap: 1, rotateY: -30 });
    A.gate.hold = false;
    const tEdit = Date.now();
    await pipeline.preload(EDITED);
    const after = () => Object.fromEntries(states().map((s) => [s.spec.topClipId, { key: s.spec.streamKey, contentKey: s.spec.contentKey }]));
    await until('改过的这一版的流进了生产者', () => { const a = after(); return a.fx && a.trans && a.tilt && a.fx.key !== before.fx.key ? a : null; }, 60_000, 100);
    const now = after();
    check(now.fx?.contentKey !== before.fx.contentKey, '改了视频的裁剪起点:fx 的流键换了', { before: before.fx.key.slice(0, 12), after: now.fx?.key.slice(0, 12) });
    check(now.trans?.contentKey !== before.trans.contentKey, '改了卡的参数:trans 的流键换了', { before: before.trans.key.slice(0, 12), after: now.trans?.key.slice(0, 12) });
    check(now.tilt?.key === before.tilt.key, '只改三维的角度:tilt 的流键不变(三维不在流里)', { before: before.tilt.key.slice(0, 12), after: now.tilt?.key.slice(0, 12) });
    // 旧流不属于这一版:生产者手里没有旧键,就绪消息(父页据此贴流)里这两张卡是新键
    check(!producer.streams.has(before.fx.key) && !producer.streams.has(before.trans.key), '旧的两条流不在这一版里', [...producer.streams.keys()].map((k) => k.slice(0, 12)));
    const redone = await until('改过的两条流重产完(满密度)', () => { const s = allAt(producer, keysNow(), (seg) => seg?.stride === 1); return s && !producer.workers.size && !producer.encoding.size ? s : null; }, 1_800_000, 300);
    out.edit = { reproduceMs: Date.now() - tEdit, before: Object.fromEntries(Object.entries(before).map(([k, v]) => [k, v.key.slice(0, 12)])), after: Object.fromEntries(Object.entries(now).map(([k, v]) => [k, v.key.slice(0, 12)])) };
    if (!check(!!redone, '改过的两条流重产完了', producer.status().log.slice(-6))) throw new Error('重产没做完');
    const redoneKeys = new Set(A.stored.slice(storedBefore).map((s) => s.key));
    out.edit.restored = [...redoneKeys].map((k) => k.slice(0, 12));
    check(redoneKeys.has(now.fx.key) && redoneKeys.has(now.trans.key), '重产的是 fx 和 trans 的新流', out.edit.restored);
    check(!redoneKeys.has(now.tilt.key), 'tilt 的流一个分段都没有重产', out.edit.restored);
    for (const id of ['fx', 'trans']) {
      const layer = A.layers.get(id);
      check(layer?.key === now[id].key, `${id}:就绪消息里是新流的键(旧流不再贴)`, layer && { key: layer.key.slice(0, 12), ranges: layer.ranges });
    }
    // 改过的项目的导出,当参照;舞台换成改过的项目,三条流各抽几帧
    const exportedEdit = await exportAll(EDITED, LAST + 1, path.join(OUT, 'ref-edited'));
    await openStage(EDITED);
    const sample = [41, 55, 77, 90, 100, 113, 128, 131, 137, 144, 166, 173, 180, 188, 195];
    out.edit.scrub = await scrubFrames(sample, exportedEdit, 'edited');
    say('edit', out.edit);
    check(out.edit.scrub.notDrawnCount === 0 && out.edit.scrub.frames === sample.length, '改了以后:抽的每一帧流平面都画出来了', out.edit.scrub.notDrawn);
    check(out.edit.scrub.wrongCount === 0, '改了以后:舞台贴出来的最像改过的项目导出的同一帧(fx、trans 是重产的流;tilt 是原来那条流照新的角度贴)', out.edit.scrub.wrong);
    check(out.edit.scrub.对导出同一帧.mean < 3, '改了以后:与导出同一帧的平均差 < 3/255', out.edit.scrub.对导出同一帧);
    // 对照:改过的舞台和**没改的**项目的导出比,明显对不上(说明贴的确实是新画面,不是旧流)
    {
      const rows = [];
      for (const f of [100, 137, 170]) {
        await seekTo(f);
        const stage = await shotStage();
        rows.push({ frame: f, 对改过的: round2(rgbDiff(stage, exportedEdit.rgb(f)).mean), 对没改的: round2(rgbDiff(stage, exported.rgb(f)).mean) });
      }
      out.edit.versusOld = rows;
      check(rows.every((r) => r.对没改的 > 2 * r.对改过的 + 1), '改了以后:和没改的项目的导出明显对不上', rows);
    }
  }
  out.servedKept = servedKept;
  await rpc('setRole', 'back', { job: 'probe' });
  }
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { hostServer?.close(); } catch { /* ignore */ }
  try { await pipeline?.close(); } catch { /* ignore */ }
  try { await bakery?.close(); } catch { /* ignore */ }
  try { dropSpares(); } catch { /* ignore */ }
  try { dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) {
    await sleep(1500);
    try {
      for (const name of await fs.readdir(OUT)) if (!/\.(json|png)$/.test(name) && name !== 'previews') await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    } catch { /* ignore */ }
  }
}
out.elapsedMs = Date.now() - started;
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(out.ok ? 'PASS' : `FAIL ${fails.length}`);
process.exit(out.ok ? 0 : 1);
