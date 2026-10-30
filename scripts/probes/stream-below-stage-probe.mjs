/**
 * 依赖下层的卡的轨道流**贴回舞台** —— 舞台这一侧的探针(任务书 `docs/plan/render-refactor-task.md`「戊二」的第三块;
 * 契约 `docs/plan/prerender-products-contract.md` 第 5.4 节)。产的一侧(差分取层、键)在 `stream-below-probe.mjs`;
 * 父页那一侧(真的编辑器里哪些卡贴流、下层改了以后旧流不贴)在 `below-paste-editor-probe.mjs`。
 *
 *   node scripts/probes/stream-below-stage-probe.mjs (--origin http://127.0.0.1:26980 | --port 26980) [--host-port 26990] [--media-port 26991]
 *        [--scenes a,b,u,d] [--size 960x540] [--out <目录>] [--json <文件>] [--keep]
 *
 * 给 `--port` 就自己在检出根起一台 dev server(另占 +1、+2 当舞台端口;数据目录、卡片改动层都在 `--out` 下),用完按进程号收掉。
 * 本进程里直接起 `FramePipeline`(同预渲染进程的代码),库根在 `--out` 下。测试页扮演父页,照产品里父页的顺序发消息
 * (先发流平面、再发抑制、再设时间,素材层的时刻另发;依赖下层的那一层带 `streamKind: "below"`,流平面带 `plane: "stage"`)。
 *
 * 场景(每个场景最上面都另有一枚小药丸压在目标卡上:验上面的层照常盖在流平面上面):
 *
 *   甲  毛玻璃卡(里程表 `odometer`,审阅表里依赖下层)压在一张会动的卡(粒子)和一段视频上面;
 *   乙  下层是半透明的:不透明度 0.6、带阴影的药丸,底下什么都没有(透明);上面压同一张毛玻璃卡;
 *   丙  用 remotion 式框架写的**用户卡**(审阅表没覆盖到,按依赖下层处理;经真的 `POST /api/cards/create` 建)压在粒子和视频上面。
 *   丁  (缺省不跑,`--scenes d`)同甲,但毛玻璃卡的**外框用了三维变形**(`rotateY`、`rotateX`、`translateZ`),项目开了透视:
 *       流里是带着三维的舞台坐标画面,平面照旧挂在舞台根下、不再变形。第 F 条改的是**三维角度**(不是下层):旧流的签名对不上、
 *       键变、新流到了再贴,拿旧角度的导出页比明显更差。
 *
 * 目标卡都**不从 15 的倍数帧开始**(甲、乙第 6 帧,丙第 38 帧)。全部卡钉成重卡:目标卡走依赖下层的流,别的卡各走各的单卡流,
 * 视频由舞台现放 —— 所以暂停着跳到任意一帧时,舞台上的下层就是那一帧该有的画面,整幅截图能和导出页同一帧直接比
 * (下层是**活渲**的情形要走「停下追到精确活渲」,那是父页和成本记录的事,在 `below-paste-editor-probe.mjs` 里核)。
 *
 * 逐条核对(参照一律是导出页同一帧的整幅画面;只比这条流的收紧矩形那一块,最像的必须是该是的那一帧):
 *
 *   0. 计划与发层:目标卡有一条 `kind: below`、`plane: stage` 的流;发给页面的那一层带 `streamKind: "below"` 和输入签名,
 *      签名就是按同一份项目算出来的那一个(页面拿它认过期);别的卡的层不带这两项。
 *   A. **只有稀疏版**(先只产稀疏那一趟):暂停着设到几帧,贴的是不晚于这一帧的最近一张,舞台报稀疏这一级,没有占位符。
 *   B. **平面挂在哪**:目标卡的包裹层里没有流平面的画布;舞台根下有一块,和包裹层在同一个舞台里、层序相同、按清单的舞台坐标摆;
 *      包裹层是抑制着的(子树藏着),带着「点它退回包裹层框」的标记。
 *   C. **满密度,暂停着跳到任意一帧**(目标卡在场的每一帧,打乱顺序):贴出来的画面最像导出页的同一帧;和同一帧的差在编码误差的量级,
 *      和前后帧的差明显更大。压在上面的那枚药丸所在的那一块同样对得上(上面的层没有被平面盖住)。
 *   D. **拖动**(每一步不带「停下」、上一步还没画出来就走下一步):停住以后画的是最后那一帧,没有空着的时刻。
 *   E. **播放**:头一拍起每一拍目标卡都是满密度流的画面;播放中暂停,停住的那一帧贴的是这一帧。
 *   F. **下层改一处**:旧的那一层带的签名和按新项目算的对不上(父页据此不贴);预渲染进程换版本以后旧键不再发,新流产出来,
 *      带着新键、新签名;贴上新流,和新项目的导出页同一帧最像,而且比拿旧项目的导出页比明显更像(这套比法分得出下层变没变)。
 *   G. **两个舞台互换那一下**(`src/editor/stageSwap.ts` 的 `swapAndDress`,播放态):新的可见舞台手里是补跑出来的精确活画面,
 *      一条流都还没取。照改过的顺序**先发流平面、后发抑制**再起播:流画出第一帧之前目标卡原来的画面不藏,全程没有
 *      「活子树藏着、流又没有画面」的时刻,也没有占位符。对照:照原来的顺序(先抑制、后流平面)发一遍,量得出那一段空着的时间
 *      (分段的字节每次多等 80 毫秒,换一个地址前缀不吃缓存:新舞台第一次取这条流就是这样)。父页发的顺序本身由单测
 *      `src/editor/stageSwap.test.mjs` 钉住。
 *
 * 输出 JSON 结论,过程写 stderr;任何一条不过就以非零退出。耗时只记录,等待时限只为防卡死。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { PNG } from 'pngjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { serve, flagArg } from './probe-connect.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { handleStreamRequest, BELOW_STREAMS_DEFAULT, belowStreamsEnabled } from '../../server/frame-stream.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { bakeFrames } from '../../server/bakery/bake.mjs';
import { findFfmpeg, dropStreamEncoderSpares } from '../../server/bakery/ffmpeg.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startDevServer, serveMedia, emptyUrlOf, sleep, round2 } from './below-stream-common.mjs';
import { streamPlanesFor } from '../../src/render/streamPlayer.ts';
import { streamInputSig, streamSigStale } from '../../src/render/streamInputSig.mjs';
import { STREAM_SEGMENT_FRAMES, streamSegmentFirstFrame, streamSegmentOf } from '../../src/render/streamSegments.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const HOST_PORT = Number(flagArg('host-port', '0', args)) || 0;
const MEDIA_PORT = Number(flagArg('media-port', '0', args)) || 0;
const SCENES = String(flagArg('scenes', 'a,b,u', args)).split(',').map((s) => s.trim()).filter((s) => ['a', 'b', 'u', 'd'].includes(s));
const KEEP = args.includes('--keep');

const JSON_OUT = flagArg('json', null, args);
const RUN = Date.now().toString(36);
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-stream-below-stage-${RUN}`));
const [WIDTH, HEIGHT] = String(flagArg('size', '960x540', args)).split('x').map(Number);
process.env.PROMPTCUT_STREAM_POOL = '1';
if (!ORIGIN && !PORT) { console.error('要给 --origin <dev server> 或 --port <自己起一台>'); process.exit(2); }
if (!(WIDTH > 0 && HEIGHT > 0)) { console.error('--size 写成 960x540 这样'); process.exit(2); }

const FPS = 30, DURATION = 3, SEG = STREAM_SEGMENT_FRAMES, LAST = DURATION * FPS - 1;
const K = WIDTH / 1920;
const SCENE_NAME = { a: '甲', b: '乙', u: '丙', d: '丁' };
/** 丁:毛玻璃卡外框的三维摆放;`edited` 时换一个角度 */
const TILT = { rotateY: 18, rotateX: -8, translateZ: -60 }, TILT_EDITED = { rotateY: 30, rotateX: 6, translateZ: -60 }, FOV = 50;
const USER_CARD = `bp-panel-${RUN}`;

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 900))); say('FAIL', { label, extra }); } return !!cond; };
async function until(label, fn, timeoutMs, everyMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`超时:${label}`); say('TIMEOUT', { label }); return null; }
    await sleep(everyMs);
  }
}

/**
 * 甲、丙的视频:ffmpeg 的测试图样(有清晰的边、有连续的运动),**去掉颜色只留明暗**。舞台那个浏览器走显卡放视频,导出页走软件光栅,
 * 两条路把 YUV 换成 RGB 用的矩阵不一样(实测彩色的测试图样纯红差二三十级,写明矩阵也一样;这是舞台现放的视频和导出页的差,
 * 不是贴流的事),整幅和导出页比的时候会被算到贴流头上。只留明暗的视频色度恒为中值,哪个矩阵换出来都一样。
 * `below-stream-common.mjs` 的 `ensureVideo` 是彩色的,所以这里另出一份。
 */
async function taggedVideo(ffmpeg, dir) {
  const file = path.join(dir, `below-stage-${WIDTH}x${HEIGHT}.mp4`);
  await fs.mkdir(dir, { recursive: true });
  await promisify(execFile)(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `testsrc2=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${DURATION + 1}`,
    '-vf', 'hue=s=0,scale=out_color_matrix=bt709:out_range=tv,format=yuv420p', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
    '-c:v', 'libx264', '-g', String(FPS), '-crf', '18', '-movflags', '+faststart', file], { windowsHide: true });
  return file;
}

/* ---------------------------------------------------------------- 场景 */

/** 丙用的用户卡:remotion 式(画面只由 t 决定)、引用框架;一块半透明的牌子从左往右滑,里面一行字 */
const USER_SOURCE = `import type { CardDef, CardProps } from "../../kernel/types";
import { Easing, interpolate } from "../../kernel/remotionStyle";

interface Params { text: string; accent: string }

const SLIDE = Easing.bezier(0.16, 1, 0.3, 1);

function BpPanel({ params, t = 0 }: CardProps<Params>) {
  const x = interpolate(t, [0, 1.4], [0, 260], { easing: SLIDE });
  const show = interpolate(t, [0, 0.3], [0, 1]);
  const tilt = interpolate(t, [0, 1.4], [-6, 3]);
  return (
    <div style={{ position: "absolute", inset: 0, fontFamily: "sans-serif" }}>
      <div
        style={{
          position: "absolute", left: 60 + x, top: 190, width: 400, height: 150, borderRadius: 26,
          background: "rgba(18, 22, 40, 0.55)", border: \`3px solid \${params.accent}\`, opacity: show,
          transform: \`rotate(\${tilt}deg)\`, display: "flex", alignItems: "center", justifyContent: "center",
          color: params.accent, fontSize: 40, fontWeight: 800,
        }}
      >
        {params.text}
      </div>
    </div>
  );
}

export const bpPanel: CardDef<Params> = {
  id: "${USER_CARD}",
  name: "贴流探针：滑入的牌子",
  description: "探针用的 remotion 式 DOM 卡：一块半透明的牌子从左往右滑入",
  source: "user",
  useWhen: "探针用，不用于真实项目。",
  tags: ["探针"],
  frameMode: "direct",
  defaults: { text: "用户卡贴流", accent: "#ffd166" },
  controls: [
    { key: "text", label: "文字", type: "text" },
    { key: "accent", label: "主色", type: "color" },
  ],
  Component: BpPanel,
  lifecycle: { settleMs: 1500, after: "hold", exit: ["fade"] },
};
`;

/** 里程表按 1920×1080 设计:小画幅时整张卡按比例缩 */
const glassFrame = () => (WIDTH === 1920 && HEIGHT === 1080 ? {} : { frame: { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: K } });
/** 压在目标卡上面的那枚小药丸(位置由场景给:落在目标卡改动过的那一块里) */
const abovePill = (cx, cy) => ({ id: 'tr-above', name: 'above', hidden: false, clips: [
  { id: 'clip-above', kind: 'card', cardId: 'punch-pill', start: 0.5, end: DURATION, params: { text: '上面的层' },
    frame: { x: Math.round(cx), y: Math.round(cy), w: 1280, h: 720, anchor: [0.5, 0.5], scale: K * 0.45 } },
] });
const particles = (color = '#30ff60') => ({ id: 'tr-move', name: 'move', hidden: false, clips: [
  { id: 'clip-move', kind: 'card', cardId: 'particles', start: 0, end: DURATION, params: { color, quantity: 120, speed: 1.5, size: 4, links: 'yes', seed: 3 } },
] });
const videoTrack = () => ({ id: 'tr-video', name: 'video', hidden: false, clips: [{ id: 'clip-video', mediaId: 'm-video', start: 0, end: DURATION, params: {} }] });

/**
 * 场景项目。`edited`:把下层的一个控件改掉(甲、丙改粒子的颜色,乙改药丸的字)。回 `{ project, target, cards, hasVideo }`,
 * `cards` 是全部卡片段的 id(都钉成重卡)。
 */
function scene(kind, { mediaUrl = '', edited = false } = {}) {
  const base = { name: `贴流探针 ${SCENE_NAME[kind]}`, width: WIDTH, height: HEIGHT, fps: FPS, duration: DURATION, themeId: 'dark', filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {} };
  const media = [{ id: 'm-video', kind: 'video', name: 'below-probe.mp4', url: mediaUrl, duration: DURATION }];
  if (kind === 'u') {
    const target = { id: 'tr-user', name: 'user', hidden: false, clips: [
      { id: 'clip-user', kind: 'card', cardId: USER_CARD, start: 1.24, end: 2.9, params: { text: '用户卡贴流', accent: '#ffd166' } },
    ] };
    return { target: 'clip-user', cards: ['clip-above', 'clip-user', 'clip-move'], hasVideo: true,
      project: { ...base, id: `below-stage-u-${RUN}`, media, tracks: [abovePill(WIDTH * 0.42, HEIGHT * 0.5), target, particles(edited ? '#ff5a30' : '#30ff60'), videoTrack()] } };
  }
  const glass = { id: 'tr-glass', name: 'glass', hidden: false, clips: [
    { id: 'clip-glass', kind: 'card', cardId: 'odometer', start: 0.2, end: DURATION, params: { position: 'left', value: 86420, label: '贴流探针' }, ...glassFrame() },
  ] };
  if (kind === 'd') {
    const g = glass.clips[0];
    g.frame = { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: K, ...(g.frame ?? {}), ...(edited ? TILT_EDITED : TILT) };
    return { target: 'clip-glass', cards: ['clip-above', 'clip-glass', 'clip-move'], hasVideo: true, tilted: true,
      project: { ...base, camera3dFov: FOV, id: `below-stage-d-${RUN}`, media, tracks: [abovePill(WIDTH * 0.2, HEIGHT * 0.5), glass, particles(), videoTrack()] } };
  }
  if (kind === 'a') {
    return { target: 'clip-glass', cards: ['clip-above', 'clip-glass', 'clip-move'], hasVideo: true,
      project: { ...base, id: `below-stage-a-${RUN}`, media, tracks: [abovePill(WIDTH * 0.16, HEIGHT * 0.5), glass, particles(edited ? '#ff5a30' : '#30ff60'), videoTrack()] } };
  }
  const block = { id: 'tr-block', name: 'block', hidden: false, clips: [
    { id: 'clip-block', kind: 'card', cardId: 'punch-pill', start: 0, end: DURATION, params: { text: edited ? '半透明的下层(改过)' : '半透明的下层' },
      frame: { x: Math.round(WIDTH * 0.36), y: Math.round(HEIGHT * 0.5), w: 1280, h: 720, anchor: [0.5, 0.5], scale: K * 1.5 },
      opacity: 0.6, emphasis: { kind: 'shadow', color: '#000000', size: 36, opacity: 0.7, dx: 0, dy: 18 } },
  ] };
  return { target: 'clip-glass', cards: ['clip-above', 'clip-glass', 'clip-block'], hasVideo: false,
    project: { ...base, id: `below-stage-b-${RUN}`, media: [], tracks: [abovePill(WIDTH * 0.16, HEIGHT * 0.5), glass, block] } };
}

/* ---------------------------------------------------------------- 像素 */

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
/** 两幅 RGB 在一块矩形里的差:平均差(满分 255),和最大通道差超过 48 的像素占比 */
function rectDiff(a, b, rect) {
  if (a.width !== b.width || a.height !== b.height) return { mean: Infinity, bad: 1 };
  let sum = 0, bad = 0, n = 0;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let i = (y * a.width + rect.x) * 3, end = i + rect.w * 3; i < end; i += 3) {
      const d0 = Math.abs(a.rgb[i] - b.rgb[i]), d1 = Math.abs(a.rgb[i + 1] - b.rgb[i + 1]), d2 = Math.abs(a.rgb[i + 2] - b.rgb[i + 2]);
      sum += d0 + d1 + d2; n += 3;
      if (d0 > 48 || d1 > 48 || d2 > 48) bad++;
    }
  }
  return { mean: sum / Math.max(1, n), bad: bad / Math.max(1, n / 3) };
}
const toPng = (img) => { const png = new PNG({ width: img.width, height: img.height }); for (let i = 0, j = 0; i < png.data.length; i += 4, j += 3) { png.data[i] = img.rgb[j]; png.data[i + 1] = img.rgb[j + 1]; png.data[i + 2] = img.rgb[j + 2]; png.data[i + 3] = 255; } return PNG.sync.write(png); };
const clampRect = (r) => { const x = Math.max(0, Math.round(r.x)), y = Math.max(0, Math.round(r.y)); return { x, y, w: Math.max(0, Math.min(WIDTH, Math.round(r.x + r.w)) - x), h: Math.max(0, Math.min(HEIGHT, Math.round(r.y + r.h)) - y) }; };
const intersect = (a, b) => { const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y); return { x, y, w: Math.min(a.x + a.w, b.x + b.w) - x, h: Math.min(a.y + a.h, b.y + b.h) - y }; };
const shuffled = (from, to) => { const order = []; for (let f = from; f <= to; f++) order.push(f); for (let i = 0; i < order.length; i++) { const j = (i * 37 + 11) % order.length; [order[i], order[j]] = [order[j], order[i]]; } return order; };

const hostHtml = (oa) => `<!doctype html><html><head><meta charset="utf-8"><title>stream below stage probe host</title></head>
<body style="margin:0;background:#202020">
<iframe id="a" src="${oa}/?stage=1&id=A&preview=stage&prerender=1" style="width:${WIDTH}px;height:${HEIGHT}px;border:0;display:block"></iframe>
<script type="module">
function createStageRpc(target, targetOrigin) {
  let nextId = 1; const pending = new Map(); const listeners = new Set();
  window.addEventListener('message', (e) => {
    if (e.source !== target) return; const d = e.data;
    if (d && d.type === 'pc-rpc-reply') { const p = pending.get(d.id); if (!p) return; pending.delete(d.id); d.ok ? p.resolve(d.result) : p.reject(new Error(d.error)); return; }
    if (d && typeof d.type === 'string' && ['mediaReady', 'frame', 'ended', 'settled'].includes(d.type)) for (const l of listeners) l(d);
  });
  const call = (method) => (...args) => new Promise((resolve, reject) => { const id = nextId++; pending.set(id, { resolve, reject }); target.postMessage({ type: 'pc-rpc', id, method, args }, targetOrigin); });
  const c = { onEvent: (l) => { listeners.add(l); return () => listeners.delete(l); } };
  for (const m of ['setProject', 'setTime', 'setRole', 'play', 'pause', 'setSuppressed', 'setStreamPlanes', 'setPlaying', 'setScrubbing', 'setMediaT']) c[m] = call(m);
  return c;
}
window.__frames = [];
const frame = document.getElementById('a');
window.__ready = new Promise((res) => {
  window.addEventListener('message', (e) => {
    if (e.source !== frame.contentWindow || e.data?.type !== 'pc-stage-ready') return;
    const rpc = createStageRpc(frame.contentWindow, '${oa}');
    rpc.onEvent((ev) => { if (ev.type === 'frame') window.__frames.push({ sec: ev.sec, at: performance.now() }); });
    window.__rpc = rpc;
    res(true);
  });
});
</script></body></html>`;

const out = { out: OUT, size: `${WIDTH}x${HEIGHT}`, switchDefault: BELOW_STREAMS_DEFAULT, runs: [] };
await fs.mkdir(OUT, { recursive: true });
let dev = null, media = null, bakery = null, browser = null, hostServer = null;
const pipelines = [];
const current = { producer: null };
const started = Date.now();
try {
  check(BELOW_STREAMS_DEFAULT === true && belowStreamsEnabled({}) === true, '依赖下层的流缺省是开的(探针没有另外打开什么)', BELOW_STREAMS_DEFAULT);
  const ffmpeg = await findFfmpeg();
  let origin = ORIGIN;
  if (!origin) {
    process.env.PROMPTCUT_EXPORT_DIR = path.join(OUT, 'export');
    await fs.mkdir(process.env.PROMPTCUT_EXPORT_DIR, { recursive: true });
    dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'belowstage' });
    origin = dev.origin;
    say('spawn', { pid: dev.pid, port: PORT });
  }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;
  const mediaDir = path.join(OUT, 'media');
  await fs.mkdir(mediaDir, { recursive: true });
  media = await serveMedia(MEDIA_PORT, mediaDir);
  const mediaUrl = media.url(path.basename(await taggedVideo(ffmpeg, mediaDir)));

  // 丙:先经真的建卡接口建那张用户卡(舞台页、导出页载入之前)
  if (SCENES.includes('u')) {
    const r = await fetch(origin + '/api/cards/create', { method: 'POST', headers: { 'content-type': 'application/json', origin },
      body: JSON.stringify({ id: USER_CARD, source: USER_SOURCE, projectId: `below-stage-u-${RUN}` }), signal: AbortSignal.timeout(60_000) });
    const body = await r.json().catch(() => null);
    out.userCard = { id: USER_CARD, status: r.status, ok: body?.ok ?? null, errors: r.status === 200 ? undefined : (body?.errors ?? [body?.error]).slice?.(0, 6) };
    if (!check(r.status === 200 && body?.ok === true, '丙:用户卡建出来了(POST /api/cards/create 回 200)', out.userCard)) throw new Error('用户卡没建出来');
  }

  /* ------------------------------------------------------------ 舞台(一台,几个场景轮着用) */
  const ports = await (await fetch(origin + '/api/stage/ports')).json();
  if (!ports.ok || !Array.isArray(ports.ports) || ports.ports.length < 1) throw new Error(`舞台端口没起来:${JSON.stringify(ports)}`);
  const u = new URL(origin);
  const originA = `${u.protocol}//${u.hostname}:${ports.ports[0]}`;
  const HOST_PATH = '/__stream-below-stage-probe-host';
  hostServer = await serve(HOST_PORT, (req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (url.pathname === HOST_PATH) { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(hostHtml(originA)); return; }
    // 地址前缀 `/s<n>/`:换一个前缀浏览器的缓存里就没有;`/d<n>/`:另外每个分段的字节多等 80 毫秒(第 G 条)
    const m = /^\/(?:([sd])\d+\/)?api\/frames(\/.*)$/.exec(url.pathname);
    const go = () => { if (!m || !current.producer || !handleStreamRequest(current.producer.store, req, res, m[2])) { res.statusCode = 404; res.end(); } };
    if (m && m[1] === 'd' && /\/seg\//.test(m[2])) setTimeout(go, 80); else go();
  }, '127.0.0.1');
  const base = `http://127.0.0.1:${hostServer.address().port}`;
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 300000,
    args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required',
      '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
  const page = await browser.newPage();
  await page.setViewport({ width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 });
  await page.goto(base + HOST_PATH);
  await page.waitForFunction(() => window.__ready, { timeout: 180000 });
  await page.evaluate(() => window.__ready);
  const frameA = () => page.frames().find((f) => f.url().startsWith(originA));
  const rpc = (method, ...a) => page.evaluate((m, a2) => window.__rpc[m](...a2), method, a);
  const iframeBox = await (await page.$('#a')).boundingBox();
  const shotStage = async () => {
    await frameA().evaluate(() => new Promise((r) => (window.__pcRealRaf ?? requestAnimationFrame)(() => (window.__pcRealRaf ?? requestAnimationFrame)(() => r()))));
    await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } });
    return rgbOver(await page.screenshot({ clip: { x: iframeBox.x, y: iframeBox.y, width: WIDTH, height: HEIGHT } }));
  };
  const diagA = () => frameA().evaluate(() => {
    const d = window.__pcStageDiag();
    return { t: d.t, suppressed: d.suppressed, parentSuppressed: d.parentSuppressed, streamWaiting: d.streamWaiting, placeholders: d.placeholders, snapshots: d.snapshots,
      planes: d.streamPlanes.map((p) => ({ clipIds: p.clipIds, plane: p.plane })),
      tracks: d.streams.tracks.map((t) => ({ id: t.id.split('#')[0], lastDrawn: t.lastDrawn, picture: t.picture, level: t.level, stale: t.stale, plane: t.plane, kind: t.kind, fits: t.fits, errors: t.errors, lastError: t.lastError, bound: t.bound })) };
  });
  const emptyUrl = emptyUrlOf(origin, { width: WIDTH, height: HEIGHT });
  bakery = await openBakery({ url: emptyUrl });
  /** 导出页逐帧(整幅),回 帧号 → PNG 字节 */
  const exportAll = async (project, tag) => {
    await bakery.reset(project, emptyUrl);
    bakery.streamLease = null;
    const frames = new Map();
    const dir = path.join(OUT, `ref-${tag}`);
    await fs.mkdir(dir, { recursive: true });
    await bakeFrames(bakery, { out: dir, fps: FPS, frames: `0-${LAST}`, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false,
      onFrame: async (i, buf) => { frames.set(i, Buffer.from(buf)); } });
    return frames;
  };

  let slot = 0;
  for (const kind of SCENES) {
    const tag = SCENE_NAME[kind];
    const run = { scene: tag };
    out.runs.push(run);
    const sc = scene(kind, { mediaUrl });
    const { project, target, cards } = sc;
    const targetClip = project.tracks.flatMap((t) => t.clips).find((c) => c.id === target);
    const FIRST = Math.ceil(targetClip.start * FPS - 1e-9), TLAST = Math.min(LAST, Math.ceil(targetClip.end * FPS - 1e-9) - 1);
    run.target = { clip: target, firstFrame: FIRST, lastFrame: TLAST };
    check(FIRST % SEG !== 0, `${tag}:目标卡不从 15 的倍数帧开始`, FIRST);

    /* ---------- 产流:先只产稀疏那一趟 */
    const pipeline = new FramePipeline({ root: path.join(OUT, `lib-${kind}`), origin: () => origin, interactive: true, playhead: () => null });
    pipelines.push(pipeline);
    pipeline.streamPicked = () => true; // 全部钉成重卡
    const producer = pipeline.streamProducer();
    producer.attachRoute();
    current.producer = producer;
    let holdDense = true;
    const nextTask = producer.nextTask.bind(producer);
    producer.nextTask = (b) => { const task = nextTask(b); return task && task.stride === 1 && holdDense ? null : task; };
    const layerByClip = new Map();
    const layerLog = [];
    pipeline.readyIndex.subscribe((message) => {
      if (message.type === 'reset') { layerByClip.clear(); layerLog.push({ type: 'reset' }); }
      if (message.type === 'layer' && message.kind === 'stream') { layerByClip.set(message.clipId, message); layerLog.push({ type: 'layer', clipId: message.clipId, key: message.key }); }
    });
    const idle = () => !producer.workers.size && !producer.encoding.size;
    const stateOf = (clipId) => [...producer.streams.values()].find((s) => s.spec.clipIds.length === 1 && s.spec.clipIds[0] === clipId) ?? null;
    const stridesOf = (clipId) => { const s = stateOf(clipId); return s ? Array.from({ length: s.spec.lastSegment + 1 }, (_, n) => s.manifest.segments[n]?.stride ?? 0) : []; };
    const t0 = Date.now();
    await pipeline.preload(project);
    const sparseOk = await until(`${tag}:稀疏版铺满全段`, () => (producer.streams.size >= cards.length && idle() && cards.every((id) => { const st = stridesOf(id); return st.length && st.every((s) => s >= 1); }) ? true : null), 900_000, 300);
    if (!sparseOk) throw new Error(`${tag}:稀疏那一趟没做完:${JSON.stringify(producer.status().log?.slice(-6))}`);
    run.sparseMs = Date.now() - t0;
    const spec0 = stateOf(target).spec;
    run.stream = { kind: spec0.kind, plane: spec0.plane, key: spec0.streamKey.slice(0, 12), originFrame: spec0.originFrame, lastSegment: spec0.lastSegment, belowClipIds: spec0.belowClipIds, replay: spec0.replay,
      others: cards.filter((id) => id !== target).map((id) => `${stateOf(id)?.spec.kind}:${id}`) };
    say('sparse-ready', { scene: tag, ms: run.sparseMs, ...run.stream });

    /* ---------- 0. 计划与发层 */
    const layer0 = layerByClip.get(target);
    const sig0 = streamInputSig(project, { clipIds: [target], kind: 'below' });
    run.layer = { streamKind: layer0?.streamKind ?? null, inputSig: layer0?.inputSig ?? null, pageSig: sig0, originFrame: layer0?.originFrame ?? null };
    check(spec0.kind === 'below' && spec0.plane === 'stage' && spec0.originFrame === FIRST, `${tag}:目标卡有一条依赖下层的流(舞台坐标),第一帧是它自己的第一帧`, run.stream);
    check(layer0?.streamKind === 'below' && typeof sig0 === 'string' && layer0.inputSig === sig0, `${tag}:发给页面的那一层带着种类和输入签名,签名就是按同一份项目算的那一个`, run.layer);
    if (sc.tilted) {
      const f3 = targetClip.frame ?? {};
      check(!!(f3.rotateX && f3.rotateY && f3.translateZ) && project.camera3dFov > 0 && !('solo' in spec0), `${tag}:目标卡的外框带三维、项目开了透视,出的是依赖下层的流(不是单独成流的那一种)`, { frame: f3, fov: project.camera3dFov, solo: spec0.solo ?? null });
    }
    check(cards.filter((id) => id !== target).every((id) => stateOf(id)?.spec.kind === 'card' && layerByClip.get(id) && !('streamKind' in layerByClip.get(id)) && !('inputSig' in layerByClip.get(id))),
      `${tag}:别的卡是单卡流,它们的层不带这两项`, run.stream.others);
    /** 父页的做法(`snapshotFeed.ts` 的 `streamLayers`):依赖下层的那一层的流平面带 `plane: "stage"` */
    const layers = () => [...layerByClip.values()].map((l) => (l.streamKind === 'below' ? { ...l, plane: 'stage' } : l));
    const planesAt = (f) => streamPlanesFor(layers(), new Set(cards), f);
    const membersOf = (planes) => [...new Set(planes.flatMap((p) => p.clipIds))].sort();
    const pictureOf = (clipId, f) => {
      const state = stateOf(clipId);
      const o = state.spec.originFrame;
      const n = streamSegmentOf(f, o);
      const stride = state.manifest.segments[n]?.stride ?? 1;
      const start = streamSegmentFirstFrame(n, o);
      return stride > 1 && SEG % stride === 0 ? start + Math.floor((f - start) / stride) * stride : f;
    };

    /* ---------- 舞台换成这个场景 */
    slot++;
    await frameA().evaluate((b) => { window.__pcStreamBase = b; }, `${base}/s${slot}`);
    await rpc('setStreamPlanes', []);
    await rpc('setSuppressed', []);
    await rpc('setProject', project, { reset: true });
    await rpc('setRole', 'front');
    await rpc('setTime', FIRST / FPS + 1e-4);
    /**
     * 照父页的做法把时间设到第 f 帧:先发流平面、再发抑制、再设时间;然后不再发任何消息,在舞台里等每条流画出它该画的那一张、
     * 视频(有的话)拖到位。回从设时间到画出来的毫秒、那一刻显示着的占位符。
     */
    const seekTo = async (f, { scrubbing = false } = {}) => {
      const planes = planesAt(f);
      const want = Object.fromEntries(membersOf(planes).map((id) => [id, pictureOf(id, f)]));
      await rpc('setStreamPlanes', planes);
      await rpc('setSuppressed', membersOf(planes));
      const got = await frameA().evaluate(async (frame, fps, want, hasVideo) => {
        const now = window.__pcRealNow ?? (() => performance.now());
        const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
        const t0 = now();
        const sec = frame / fps + 1e-4;
        // 素材层(视频)跟的时刻父页是另发的(`Preview` 里跟着 store 的 t 发 `setMediaT`)
        if (hasVideo) void window.__pcStage.setMediaT(sec);
        await window.__pcStage.setTime(sec);
        const ids = Object.keys(want);
        let nudged = 0;
        for (;;) {
          const d = window.__pcStageDiag();
          const of = (id) => d.streams.tracks.find((t) => t.id.split('#')[0] === id);
          const videos = hasVideo ? [...document.querySelectorAll('video')].filter((v) => v.currentSrc || v.src) : [];
          const videoOk = !hasVideo || (videos.length > 0 && videos.every((v) => !v.seeking) && videos.some((v) => v.readyState >= 2 && Math.abs(v.currentTime - sec) < 0.4 / fps));
          // 暂停着的视频离目标不到 0.03 秒就不再拖(`mediaSync.ts` 的 `PAUSED_SEEK_SEC`,产品里的容差):播放后停下可能正好差一帧。
          // 探针要逐帧比像素,所以这时先把它拖开一点再拖回来
          if (hasVideo && !videoOk && nudged < 3 && now() - t0 > 400 * (nudged + 1) && videos.every((v) => !v.seeking)) {
            nudged++;
            await window.__pcStage.setMediaT(Math.max(0, sec - 0.5));
            await wait(120);
            await window.__pcStage.setMediaT(sec);
          }
          if (videoOk && ids.every((id) => of(id) && of(id).picture === want[id] && !of(id).stale)) {
            const ms = +(now() - t0).toFixed(1);
            await wait(0);
            const after = window.__pcStageDiag();
            return { ms, placeholders: after.placeholders, levels: Object.fromEntries(ids.map((id) => [id, of(id).level])), waiting: after.streamWaiting };
          }
          if (now() - t0 > 10000) return { ms: null, videoOk, videos: videos.map((v) => [v.currentTime, v.readyState, v.seeking]), tracks: d.streams.tracks.map((t) => ({ id: t.id.split('#')[0], lastDrawn: t.lastDrawn, picture: t.picture, stale: t.stale, fits: t.fits, err: t.lastError })) };
          await wait(2);
        }
      }, f, FPS, want, sc.hasVideo && !scrubbing);
      return { planes, want, got };
    };

    /* ---------- A. 只有稀疏版 */
    {
      const rec = { frames: 0, bad: [] };
      for (const f of [FIRST, FIRST + 1, FIRST + SEG - 1, FIRST + SEG, FIRST + SEG + 7, TLAST]) {
        const { want, got } = await seekTo(f);
        rec.frames++;
        if (got.ms === null || got.levels[target] !== 'sparse' || want[target] > f || got.placeholders.length) rec.bad.push({ frame: f, want: want[target], got });
      }
      run.sparse = { strides: stridesOf(target), ...rec };
      say('A-sparse', { scene: tag, ...run.sparse });
      check(run.sparse.strides.every((s) => s > 1), `${tag}:先只有稀疏版`, run.sparse.strides);
      check(rec.bad.length === 0, `${tag}:只有稀疏版时贴的是不晚于这一帧的最近一张,舞台报稀疏这一级,没有占位符`, rec.bad.slice(0, 3));
    }
    holdDense = false;
    producer.kick();
    const t1 = Date.now();
    const denseOk = await until(`${tag}:全部分段满密度`, () => (idle() && cards.every((id) => stridesOf(id).every((s) => s === 1)) ? true : null), 900_000, 500);
    if (!denseOk) throw new Error(`${tag}:满密度那一趟没做完:${JSON.stringify(producer.status().log?.slice(-6))}`);
    run.denseMs = Date.now() - t1;
    const manifest = stateOf(target).manifest;
    const tight = clampRect(manifest.tight ?? manifest.bound);
    run.stream.bound = manifest.bound; run.stream.tight = manifest.tight;
    run.stream.capture = producer.status().streams.find((s) => s.kind === 'below')?.below ?? null;
    say('dense-ready', { scene: tag, ms: run.denseMs, tight });
    check(!run.stream.capture?.failed, `${tag}:差分取层没有判死`, run.stream.capture);

    /* ---------- 参照:导出页逐帧 */
    const exported = await exportAll(project, kind);
    const exportRgb = new Map();
    const exportOf = (f, from = exported, cache = exportRgb) => { if (!cache.has(f)) { cache.set(f, rgbOver(from.get(f))); if (cache.size > 24) cache.delete(cache.keys().next().value); } return cache.get(f); };
    say('exported', { scene: tag, frames: exported.size });
    /**
     * 这幅舞台截图在矩形里最像导出页的哪一帧。`self` 是该是的那一帧:它的差比最小的差只多出 `tieOf` 以内就算它最像
     * (画面静止、入场动画收尾的那几帧,前后帧和它几乎逐像素相同,差的那一点比编码的噪声还小,分不出先后;`tie` 记这种情形),
     * 回的 `mean` / `bad` 是对 `self` 的。容差是它自己那个差的百分之五,至少 0.05(满分 255)。
     */
    const tieOf = (mean) => Math.max(0.05, mean * 0.05);
    const score = (stage, rect, candidates, of = exportOf, self = candidates[Math.floor(candidates.length / 2)]) => {
      const scores = [...new Set(candidates)].filter((c) => c >= 0 && c <= LAST).map((c) => [c, rectDiff(stage, of(c), rect)]);
      const sorted = [...scores].sort((x, y) => x[1].mean - y[1].mean);
      const own = scores.find(([c]) => c === self) ?? sorted[0];
      const others = sorted.filter(([c]) => c !== own[0]);
      const wins = own[1].mean <= sorted[0][1].mean + tieOf(own[1].mean);
      return { best: wins ? own[0] : sorted[0][0], mean: round2(own[1].mean), bad: round2(own[1].bad * 100), runnerUp: others[0] ? round2(others[0][1].mean) : null,
        tie: wins && !!others[0] && others[0][1].mean <= own[1].mean + tieOf(own[1].mean), scores: scores.map(([c, d]) => [c, round2(d.mean)]) };
    };

    /* ---------- B. 平面挂在哪 */
    {
      const f = Math.min(TLAST - 3, FIRST + 41);
      await seekTo(f);
      const dom = await frameA().evaluate((id) => {
        const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
        const plane = document.querySelector(`canvas[data-pc-group-plane][data-pc-stream-group="${id}"]`);
        const stage = wrap?.closest('.pc-stage') ?? null;
        const live = wrap ? [...wrap.children].filter((el) => !el.hasAttribute('data-pc-placeholder-slot')) : [];
        const cs = plane ? getComputedStyle(plane) : null;
        return {
          wrapper: !!wrap, cls: wrap?.className ?? null, member: !!wrap?.hasAttribute('data-pc-stream-member'),
          canvasInWrapper: !!wrap?.querySelector(':scope > canvas[data-pc-stream-plane]'),
          plane: !!plane, planeInSameStage: !!plane && plane.parentElement === stage, planeInsideWrapper: !!plane && !!wrap?.contains(plane),
          planeDisplay: cs?.display ?? null, planeZ: cs?.zIndex ?? null, wrapperZ: wrap ? getComputedStyle(wrap).zIndex : null, pointerEvents: cs?.pointerEvents ?? null,
          planeBox: plane ? { left: plane.style.left, top: plane.style.top, width: plane.style.width, height: plane.style.height, w: plane.width, h: plane.height } : null,
          liveHidden: live.length > 0 && live.every((el) => getComputedStyle(el).display === 'none'),
          planes: document.querySelectorAll(`canvas[data-pc-group-plane][data-pc-stream-group="${id}"]`).length,
        };
      }, target);
      const d = await diagA();
      const track = d.tracks.find((t) => t.id === target);
      run.dom = { frame: f, ...dom, track: track && { plane: track.plane, kind: track.kind, fits: track.fits, picture: track.picture }, sentPlane: d.planes.find((p) => p.clipIds[0] === target) };
      say('B-dom', { scene: tag, ...run.dom });
      const b = manifest.bound;
      check(dom.wrapper && !dom.canvasInWrapper && dom.plane && dom.planes === 1 && dom.planeInSameStage && !dom.planeInsideWrapper, `${tag}:流平面的画布在舞台根下(和包裹层同一个舞台),不在包裹层里`, dom);
      check(dom.planeDisplay !== 'none' && dom.planeZ === dom.wrapperZ && dom.pointerEvents === 'none', `${tag}:平面露着、层序和这张卡那一层相同、不接指针事件`, dom);
      check(dom.planeBox && dom.planeBox.left === `${b.x}px` && dom.planeBox.top === `${b.y}px` && dom.planeBox.w === b.w && dom.planeBox.h === b.h, `${tag}:平面按清单的舞台坐标摆`, { planeBox: dom.planeBox, bound: b });
      check(/pc-suppressed/.test(dom.cls ?? '') && dom.liveHidden && dom.member, `${tag}:目标卡的包裹层抑制着(子树藏着),点它退回包裹层的框`, dom);
      check(track?.plane === 'stage' && track.kind === 'below' && track.fits === true && run.dom.sentPlane?.plane === 'stage', `${tag}:播放器认这是按舞台坐标的流`, run.dom);
      if (sc.tilted) {
        // 平面本身不带变形(舞台的透视只作用在带三维变形的直接子元素上):它在屏幕上的框就是清单的矩形;包裹层带着三维矩阵
        const flat = await frameA().evaluate((id) => {
          const wrap = document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`);
          const plane = document.querySelector(`canvas[data-pc-group-plane][data-pc-stream-group="${id}"]`);
          const root = plane?.parentElement?.getBoundingClientRect();
          const box = plane?.getBoundingClientRect();
          return { planeTransform: plane ? getComputedStyle(plane).transform : null, wrapperTransform: wrap ? getComputedStyle(wrap).transform.slice(0, 9) : null,
            // 透视挂在包裹层的父元素上(`Stage.tsx` 的 AnimClock 那一层);流平面在舞台根下,不是它的子元素
            perspective: wrap?.parentElement ? getComputedStyle(wrap.parentElement).perspective : null, planeUnderPerspective: !!plane && !!wrap?.parentElement && plane.parentElement === wrap.parentElement,
            screen: box && root ? { x: box.left - root.left, y: box.top - root.top, w: box.width, h: box.height } : null, css: plane ? { w: parseFloat(plane.style.width), h: parseFloat(plane.style.height), l: parseFloat(plane.style.left), t: parseFloat(plane.style.top) } : null };
        }, target);
        run.dom.tilt = flat;
        check(flat.planeTransform === 'none' && flat.wrapperTransform === 'matrix3d(' && flat.perspective && flat.perspective !== 'none', `${tag}:包裹层带三维矩阵、舞台有透视,流平面自己不带变形`, flat);
        check(flat.screen && flat.css && Math.abs(flat.screen.x - flat.css.l) < 0.51 && Math.abs(flat.screen.y - flat.css.t) < 0.51 && Math.abs(flat.screen.w - flat.css.w) < 0.51 && Math.abs(flat.screen.h - flat.css.h) < 0.51, `${tag}:流平面在屏幕上的框就是它样式里的框(没有被透视变形)`, flat);
      }
    }

    /* ---------- C. 满密度:暂停着跳到任意一帧,逐帧比 */
    {
      const rec = { frames: 0, wrong: [], notDrawn: [], placeholders: [], same: 0, next: 0, n: 0, sameBad: 0, ms: [], above: 0, aboveN: 0, aboveWrong: [], notDense: [], ties: 0 };
      // 压在上面的药丸和目标卡改动过的那一块的交集(药丸 0.5 秒才进场)
      const pillBox = await (async () => {
        await seekTo(Math.min(TLAST - 2, 60));
        const r = await frameA().evaluate(() => { const el = document.querySelector('[data-pc-clip="clip-above"] canvas[data-pc-stream-plane]'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
        return r ? clampRect(r) : null;
      })();
      const overlap = pillBox ? intersect(pillBox, tight) : { w: 0, h: 0 };
      run.above = { pillBox, overlap };
      check(overlap.w > 20 && overlap.h > 10, `${tag}:压在上面的药丸确实落在目标卡改动过的那一块里(这个场景摆对了)`, run.above);
      for (const f of shuffled(FIRST, TLAST)) {
        const { got } = await seekTo(f);
        if (got.ms === null) { rec.notDrawn.push({ frame: f, ...got }); continue; }
        rec.ms.push(got.ms);
        if (got.placeholders.length) rec.placeholders.push({ frame: f, placeholders: got.placeholders });
        if (got.levels[target] !== 'dense') rec.notDense.push({ frame: f, level: got.levels[target] });
        const stage = await shotStage();
        const r = score(stage, tight, [f - 2, f - 1, f, f + 1, f + 2]);
        if (r.best !== f) rec.wrong.push({ frame: f, ...r });
        if (r.tie) rec.ties++;
        rec.same += r.mean; rec.next += r.runnerUp ?? 0; rec.n++;
        rec.sameBad = Math.max(rec.sameBad, r.best === f ? r.bad : 0);
        if (f >= 20 && overlap.w > 20 && overlap.h > 10) {
          const a = score(stage, overlap, [f - 1, f, f + 1]);
          rec.above += a.mean; rec.aboveN++;
          if (a.best !== f || a.mean > 8) rec.aboveWrong.push({ frame: f, ...a });
        }
        rec.frames++;
        if (f === FIRST + 41 || f === FIRST + 2) { await fs.writeFile(path.join(OUT, `${kind}-stage-${f}.png`), toPng(stage)); await fs.writeFile(path.join(OUT, `${kind}-export-${f}.png`), toPng(exportOf(f))); }
      }
      const sorted = [...rec.ms].sort((x, y) => x - y);
      run.dense = { frames: rec.frames, wrongCount: rec.wrong.length, wrong: rec.wrong.slice(0, 5), notDrawn: rec.notDrawn.slice(0, 3), placeholdersLeft: rec.placeholders.slice(0, 3), notDense: rec.notDense.slice(0, 3),
        对导出同一帧_平均差: round2(rec.same / Math.max(1, rec.n)), 对前后帧里最像的那一帧: round2(rec.next / Math.max(1, rec.n)), 同一帧里差超过48的像素_最多百分之: rec.sameBad,
        画面静止分不出先后的帧: rec.ties,
        上面那枚药丸那一块_对同一帧: rec.aboveN ? round2(rec.above / rec.aboveN) : null, 药丸那一块对不上的帧: rec.aboveWrong.slice(0, 3),
        跳帧毫秒: sorted.length ? { n: sorted.length, median: sorted[sorted.length >> 1], max: sorted.at(-1) } : null };
      say('C-dense', { scene: tag, ...run.dense });
      check(rec.notDrawn.length === 0 && rec.frames === TLAST - FIRST + 1, `${tag}:第 ${FIRST}～${TLAST} 帧每一帧都贴出了这一帧`, { frames: rec.frames, notDrawn: rec.notDrawn.slice(0, 2) });
      check(rec.notDense.length === 0, `${tag}:贴的都是满密度的那一级`, rec.notDense.slice(0, 3));
      check(rec.wrong.length === 0, `${tag}:暂停着跳到任意一帧,和下层合成出来的画面最像的都是导出页的同一帧`, { wrong: rec.wrong.length, first: rec.wrong.slice(0, 3) });
      check(run.dense.对导出同一帧_平均差 < 4, `${tag}:和导出页同一帧的差在编码误差的量级(平均差小于 4,满分 255)`, run.dense);
      check(rec.aboveWrong.length === 0, `${tag}:上面的层照常盖在流平面上面(药丸那一块和导出页同一帧对得上)`, rec.aboveWrong.slice(0, 3));
      check(rec.placeholders.length === 0, `${tag}:画出来的那一刻没有占位符挂着`, rec.placeholders.slice(0, 3));
    }

    /* ---------- D. 拖动:每 16 毫秒一步,不等画出来 */
    {
      const span = TLAST - FIRST;
      const path16 = [...Array.from({ length: 14 }, (_, i) => FIRST + 1 + Math.round((i * (span - 4)) / 13)), ...Array.from({ length: 10 }, (_, i) => TLAST - 2 - Math.round((i * (span - 6)) / 9)), FIRST + 23, FIRST + 4, TLAST - 9, FIRST + 31];
      await seekTo(path16[0]);
      await rpc('setScrubbing', true);
      const fast = await frameA().evaluate(async (steps, fps, id) => {
        const now = window.__pcRealNow ?? (() => performance.now());
        const wait = (ms) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, ms));
        const track = () => window.__pcStageDiag().streams.tracks.find((t) => t.id.split('#')[0] === id);
        const seen = new Set();
        let empty = 0;
        for (const f of steps) {
          void window.__pcStage.setTime(f / fps + 1e-4);
          await wait(16);
          const t = track();
          if (t && t.lastDrawn !== null) seen.add(t.lastDrawn); else empty++;
        }
        const last = steps[steps.length - 1];
        const t0 = now();
        let settleMs = null;
        for (;;) {
          const t = track();
          if (t && t.lastDrawn === last && !t.stale) { settleMs = +(now() - t0).toFixed(1); break; }
          if (now() - t0 > 8000) break;
          await wait(2);
        }
        return { steps: steps.length, distinctDrawn: seen.size, emptySamples: empty, settleMs, placeholders: window.__pcStageDiag().placeholders };
      }, path16, FPS, target);
      await rpc('setScrubbing', false);
      const last = path16.at(-1);
      await seekTo(last);   // 别的层(各自的流、视频)也到这一帧
      const r = score(await shotStage(), tight, [last - 2, last - 1, last, last + 1, last + 2]);
      run.drag = { ...fast, last, best: r.best, mean: r.mean, runnerUp: r.runnerUp };
      say('D-drag', { scene: tag, ...run.drag });
      check(fast.settleMs !== null && r.best === last, `${tag}:拖动:停住以后画的是最后那一帧`, run.drag);
      check(fast.distinctDrawn >= 5 && fast.emptySamples === 0 && fast.placeholders.length === 0, `${tag}:拖动:画面一路跟着走,没有空着的时刻、没有占位符`, run.drag);
    }

    /* ---------- E. 播放;播放中暂停 */
    {
      const f0 = FIRST + 9;
      await seekTo(f0);
      await frameA().evaluate(() => { window.__pcFallbackTrace = []; });
      await page.evaluate(() => { window.__frames = []; });
      await rpc('setStreamPlanes', planesAt(f0));
      await rpc('setSuppressed', cards);
      await rpc('setPlaying', true);
      await rpc('play', f0 / FPS + 1e-4);
      await sleep(700);
      const stop = await rpc('pause');
      await rpc('setPlaying', false);
      const stopped = Math.round(stop.stoppedAt * FPS);
      const trace = await frameA().evaluate(() => { const t = window.__pcFallbackTrace.splice(0); delete window.__pcFallbackTrace; return t; });
      const beats = trace.map((b) => ({ frame: Math.round(b.sec * 30), level: b.levels[target] ?? null }));
      const bad = beats.filter((b) => b.frame >= FIRST && b.frame <= TLAST && b.level !== 'dense');
      await until(`${tag}:暂停的那一帧画出来`, async () => { const d = await diagA(); const t = d.tracks.find((x) => x.id === target); return t && t.lastDrawn === stopped ? d : null; }, 5000, 50);
      await seekTo(stopped);
      const frames = await page.evaluate(() => window.__frames);
      const steps = frames.slice(1).map((x, i) => +(x.sec - frames[i].sec).toFixed(6));
      const r = score(await shotStage(), tight, [stopped - 2, stopped - 1, stopped, stopped + 1, stopped + 2]);
      run.play = { from: f0, stoppedAt: stopped, beats: beats.length, firstBeat: beats[0] ?? null, notDense: bad.slice(0, 5), noSkip: steps.every((s) => Math.abs(s - 1 / FPS) < 1e-6), best: r.best, mean: r.mean, runnerUp: r.runnerUp };
      say('E-play', { scene: tag, ...run.play });
      check(beats.length >= 5 && bad.length === 0, `${tag}:播放:头一拍起每一拍目标卡都是满密度流的画面(没有空拍)`, { beats: beats.length, first: beats[0], bad: bad.slice(0, 3) });
      check(run.play.noSkip && stopped > f0 + 3 && stopped <= TLAST, `${tag}:播放:不跳帧,停在目标卡在场的一帧上`, run.play);
      check(r.best === stopped, `${tag}:播放中暂停:停住的那一帧贴的是这一帧`, r);
    }

    /* ---------- F. 下层改一处:旧流过期、重产、再对 */
    {
      const ed = scene(kind, { mediaUrl, edited: true });
      const sig1 = streamInputSig(ed.project, { clipIds: [target], kind: 'below' });
      const key0 = spec0.streamKey;
      const rec = { oldSig: layer0.inputSig, newPageSig: sig1, staleOld: streamSigStale(layer0.inputSig, sig1) };
      check(rec.staleOld === true, `${tag}:下层改了一处:旧的那一层带的签名和按新项目算的对不上(父页据此不贴旧流)`, rec);
      const mark = layerLog.length;
      const t2 = Date.now();
      await pipeline.preload(ed.project);
      const again = await until(`${tag}:新流满密度`, () => {
        const s = stateOf(target);
        return s && s.spec.streamKey !== key0 && idle() && cards.every((id) => stridesOf(id).length && stridesOf(id).every((x) => x === 1)) ? s : null;
      }, 900_000, 500);
      if (!again) throw new Error(`${tag}:改了下层以后新流没产出来`);
      rec.reproduceMs = Date.now() - t2;
      const layer1 = layerByClip.get(target);
      const since = layerLog.slice(mark);
      rec.newKey = again.spec.streamKey.slice(0, 12); rec.oldKey = key0.slice(0, 12);
      rec.newLayer = { key: layer1?.key.slice(0, 12), streamKind: layer1?.streamKind ?? null, inputSig: layer1?.inputSig ?? null };
      rec.oldKeySentAfterReset = (() => { const at = since.findIndex((e) => e.type === 'reset'); return since.slice(Math.max(0, at)).some((e) => e.type === 'layer' && e.clipId === target && e.key === key0); })();
      check(again.spec.streamKey !== key0 && layer1?.key === again.spec.streamKey, `${tag}:下层改了以后流键变了,发给页面的是新键`, rec);
      check(layer1?.streamKind === 'below' && layer1.inputSig === sig1 && !streamSigStale(layer1.inputSig, sig1), `${tag}:新的那一层带着按新项目算的签名(父页认它)`, rec.newLayer);
      check(since.some((e) => e.type === 'reset') && !rec.oldKeySentAfterReset, `${tag}:预渲染进程换版本以后清了表,旧键不再发`, { events: since.slice(0, 8) });
      // 贴新流,和新项目的导出页比;对照:拿旧项目的导出页比要明显更差
      const exported1 = await exportAll(ed.project, `${kind}-edited`);
      const cache1 = new Map();
      const exportOf1 = (f) => exportOf(f, exported1, cache1);
      const tight1 = clampRect(again.manifest.tight ?? again.manifest.bound);
      await rpc('setStreamPlanes', []);
      await rpc('setSuppressed', []);
      await rpc('setProject', ed.project, { reset: true });
      const list = [FIRST, FIRST + 3, FIRST + 17, FIRST + 30, FIRST + 44, TLAST - 20, TLAST - 1].filter((f) => f >= FIRST && f <= TLAST);
      const rows = [];
      for (const f of list) {
        const { got } = await seekTo(f);
        if (got.ms === null) { rows.push({ frame: f, notDrawn: got }); continue; }
        const stage = await shotStage();
        const r = score(stage, tight1, [f - 2, f - 1, f, f + 1, f + 2], exportOf1);
        const vsOld = round2(rectDiff(stage, exportOf(f), tight1).mean);
        rows.push({ frame: f, best: r.best, mean: r.mean, runnerUp: r.runnerUp, 对旧项目同一帧: vsOld });
        if (f === FIRST + 30) { await fs.writeFile(path.join(OUT, `${kind}-edited-stage-${f}.png`), toPng(stage)); await fs.writeFile(path.join(OUT, `${kind}-edited-export-${f}.png`), toPng(exportOf1(f))); }
      }
      rec.frames = rows;
      run.edit = rec;
      say('F-edit', { scene: tag, ...rec });
      check(rows.every((x) => x.best === x.frame), `${tag}:重产以后贴新流,和新项目的导出页同一帧最像`, rows.filter((x) => x.best !== x.frame).slice(0, 3));
      check(rows.every((x) => x.mean < 4), `${tag}:重产以后和新项目同一帧的差在编码误差的量级`, rows.map((x) => x.mean));
      const mid = rows.filter((x) => x.frame >= FIRST + 15);
      check(mid.length > 0 && mid.every((x) => x.对旧项目同一帧 > x.mean * 1.3 + 0.3), `${tag}:对照:同一幅画面拿旧项目的导出页比明显更差(这套比法分得出下层变没变)`, mid);
    }

    /* ---------- G. 两个舞台互换那一下:先发流平面、后发抑制 */
    {
      // 这一版(改过下层的那一版)的流平面;目标卡在场的一帧
      const f0 = FIRST + 20;
      const dress = async (order) => {
        await rpc('setSuppressed', []);
        await rpc('setStreamPlanes', []);
        await rpc('setTime', f0 / FPS + 1e-4);
        slot++;
        await frameA().evaluate((b) => { window.__pcStreamBase = b; }, `${base}/d${slot}`);
        await sleep(150);
        const sampler = frameA().evaluate(async (id, ms) => {
          const now = window.__pcRealNow ?? (() => performance.now());
          const wait = (n) => new Promise((r) => (window.__pcRealSetTimeout ?? setTimeout)(r, n));
          const t0 = now();
          const log = [];
          let last = '', emptyMs = 0, emptySince = null, firstHidden = null, firstShowing = null;
          for (;;) {
            const d = window.__pcStageDiag();
            const at = now() - t0;
            const showing = d.streams.tracks.some((t) => t.id.split('#')[0] === id && t.lastDrawn !== null);
            const hidden = !!document.querySelector(`[data-pc-clip="${id}"]:not([data-pc-media])`)?.classList.contains('pc-suppressed');
            const empty = hidden && !showing;
            if (empty && emptySince === null) emptySince = at;
            if (!empty && emptySince !== null) { emptyMs += at - emptySince; emptySince = null; }
            if (hidden && firstHidden === null) firstHidden = Math.round(at);
            if (showing && firstShowing === null) firstShowing = Math.round(at);
            const key = `${d.parentSuppressed.includes(id) ? 'named' : '-'}|${d.streamWaiting.includes(id) ? 'wait' : '-'}|${hidden ? 'hidden' : 'live'}|${showing ? 'stream' : '-'}|${d.placeholders.includes(id) ? 'ph' : '-'}`;
            if (key !== last) { last = key; log.push(`${Math.round(at)}ms ${key}`); }
            if (at > ms) { if (emptySince !== null) emptyMs += at - emptySince; return { log, emptyMs: Math.round(emptyMs), firstHidden, firstShowing, placeholder: log.some((l) => l.endsWith('|ph')) }; }
            await wait(2);
          }
        }, target, 600);   // 只看起播后的 0.6 秒:丙的目标卡 1.66 秒长,采久了会采到它出场以后
        await sleep(40);
        const planes = planesAt(f0);
        if (order === 'planes-first') { await rpc('setStreamPlanes', planes); await rpc('setSuppressed', cards); }
        else { await rpc('setSuppressed', cards); await rpc('setStreamPlanes', planes); }
        await rpc('setPlaying', true);
        await rpc('play', f0 / FPS + 1e-4);
        const seen = await sampler;
        await rpc('pause');
        await rpc('setPlaying', false);
        return seen;
      };
      const fixed = await dress('planes-first');
      const old = await dress('suppress-first');
      run.swapDress = { frame: f0, 先发流平面后发抑制: fixed, 对照_先发抑制后发流平面: old };
      say('G-swap-dress', { scene: tag, ...run.swapDress });
      check(fixed.emptyMs === 0 && !fixed.placeholder, `${tag}:互换后摆平面:先发流平面、后发抑制,全程没有「活子树藏着、流又没有画面」的时刻,也没有占位符`, fixed);
      check(fixed.firstHidden !== null && fixed.firstShowing !== null && fixed.firstHidden >= fixed.firstShowing, `${tag}:互换后摆平面:流画出第一帧的那一刻才藏原来的画面`, fixed);
      check(old.emptyMs > 20, `${tag}:对照:照原来的顺序(先抑制、后流平面)这一层确实会空一段(这把尺子量得出空拍)`, old);
      slot++;
      await frameA().evaluate((b) => { window.__pcStreamBase = b; }, `${base}/s${slot}`);
    }

    await rpc('setStreamPlanes', []);
    await rpc('setSuppressed', []);
    current.producer = null;
    try { await pipeline.close(); } catch { /* ignore */ }
    pipelines.pop();
  }
  await rpc('setRole', 'back', { job: 'probe' });
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await browser?.close(); } catch { /* ignore */ }
  try { hostServer?.close(); hostServer?.closeAllConnections?.(); } catch { /* ignore */ }
  for (const p of pipelines) { try { await p.close(); } catch { /* ignore */ } }
  try { await bakery?.close(); } catch { /* ignore */ }
  try { await media?.close(); } catch { /* ignore */ }
  dropStreamEncoderSpares();
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) {
    try {
      for (const name of await fs.readdir(OUT)) if (!/\.(json|png)$/.test(name)) await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
