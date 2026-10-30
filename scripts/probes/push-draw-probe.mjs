/**
 * 「只推帧不截图时,中途挂载的 motion 式卡在画面上不往前走」——导出和抽帧的各条路中不中(`server/bakery/bake.mjs` 文件头「推帧补画」)。
 *
 *   node scripts/probes/push-draw-probe.mjs (--origin http://127.0.0.1:<dev server> | --port 27140)
 *        [--variants glass,user,plain,alone] [--paths range,targets,see,layout,stream,shards] [--legacy]
 *        [--cost] [--out <目录>] [--json <文件>] [--keep]
 *
 * 项目(960×540,30 帧每秒,5 秒):一枚 `punch-pill` 在 1 秒进场;另有一张更早挂载、要回放的卡(`rank-bars`,0.2 秒进场,在最下面);
 * 3 秒时再进场第二枚药丸 —— 它前面有一段画面静止的帧(静止的帧不补画,见 `bake.mjs` 的 `pushDrawNeeded`),核对「静止一段以后
 * 再挂载的卡」也对。四档:
 *   glass  药丸上面压一张毛玻璃卡(里程表 `odometer`,0.2 秒进场)
 *   user   药丸上面压一张用框架写的用户卡(remotion 式,探针经真的 `/api/cards/create` 建;只有探针自己起的开发服务器、
 *          或者加了 `--with-user` 才做:它往那台开发服务器的数据目录里写一张卡)
 *   plain  药丸上面什么都不压(更早挂载的那张卡在它下面)
 *   alone  只有第一枚药丸一张卡(对照:页面上没有更早挂载的卡)
 *
 * 参照:同一个项目从第 0 帧起每帧都截的整段导出(`bakeFrames`,`frames: 0-149`)。
 *
 * 逐条查产品里「推过去不截图」的路,每条路给结论:取到的那一帧和参照的同一帧差多少(RGBA 四个通道的平均绝对差,满分 255)、
 * 最像参照的哪一帧(落后几帧):
 *   range    只导一段:`exportUnified({ frames: '51-70' })`、`'100-104'`(从第 0 帧推过去,只截这一段)
 *   targets  只取几帧的导出:`exportUnified({ targetFrames: [51, 52, 80, 100, 101] })`
 *   see      抽帧:`FramePipeline.see_frames`(Agent 的 see_frames;get_gif 走同一条,只是时刻多几个)
 *   layout   `FramePipeline.layout`(Agent 的 get_layout):药丸的实体框,和只有药丸的项目同一时刻的框比
 *   stream   流的推帧(`bakeStream`,一页上两张卡 = 组流的页面形状;alone 档是单卡流的形状):断了租约从挂载帧回放过来的分段、
 *            稀疏那一趟(每个分段只截第一帧),各自和接着租约一路产下来的满密度逐帧比
 *   shards   并行导出(另一个项目,6 秒,几张卡前后接着):`exportUnified({ workers: 3 })` 的每一帧和整段导出比
 *
 * 开窗取帧(targets / see / layout):修了 FrameScene 中按 clipFrameMode 分流直接求值与时间卡之后,
 * 开窗取帧不再早一帧挂载,取到的第 f 帧与参照的第 f 帧逐像素相同(ahead = 0)。
 *
 * `--legacy`:把推帧补画关掉(`PROMPTCUT_PUSH_DRAW=0`)跑同一套,复现修之前的样子;这时探针核对的是「该中的路都中了、对照档不中」。
 * `--cost`:另量代价(960×540 和 1920×1080):每推一帧多花多少毫秒、并行导出的总耗时变化。耗时只记录。
 *
 * 输出 JSON 结论,过程写 stderr;不合预期就以非零退出。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { flagArg } from './probe-connect.mjs';
import { startDevServer, sleep, round2 } from './below-stream-common.mjs';

const args = process.argv.slice(2);
const ORIGIN = flagArg('origin', null, args);
const PORT = Number(flagArg('port', '0', args));
const KEEP = args.includes('--keep');
const LEGACY = args.includes('--legacy');
const COST = args.includes('--cost');
const WITH_USER = args.includes('--with-user');
const JSON_OUT = flagArg('json', null, args);
if (!ORIGIN && !PORT) { console.error('要给 --origin <dev server> 或 --port <自己起一台>'); process.exit(2); }
const OUT = path.resolve(flagArg('out', null, args) || path.join(os.tmpdir(), `pc-push-draw-${Date.now().toString(36)}`));
// 必须在引入 bake.mjs 之前定下来(它每次调用时读,这里早设只是为了一目了然)
if (LEGACY) process.env.PROMPTCUT_PUSH_DRAW = '0'; else delete process.env.PROMPTCUT_PUSH_DRAW;
process.env.PROMPTCUT_EXPORT_DIR = path.join(OUT, 'export');

const { FramePipeline } = await import('../../server/frame-pipeline.mjs');
const { openBakery } = await import('../../server/bakery/chrome.mjs');
const { bakeFrames, bakeStream } = await import('../../server/bakery/bake.mjs');
const { exportUnified } = await import('../../server/bakery/export-unified.mjs');
const { decodePngRgba } = await import('../../server/bakery/capture-canvas.mjs');
const { mountFrameOf } = await import('../../src/render/frameWindow.mjs');

const W = 960, H = 540, FPS = 30, SECONDS = 5, N = SECONDS * FPS;
const RUN = Date.now().toString(36);
const USER_CARD = `pd-cover-${RUN}`;
const ownServer = !ORIGIN;
const VARIANTS = String(flagArg('variants', ownServer || WITH_USER ? 'glass,user,plain,alone' : 'glass,plain,alone', args)).split(',').filter(Boolean);
const PATHS = new Set(String(flagArg('paths', 'range,targets,see,layout,stream,shards', args)).split(',').filter(Boolean));
/** 取帧的那几帧:药丸 30 帧进场,51 帧时入场动画正在半路上(弹簧还没停、光晕还在散) */
const RANGES = [[51, 70], [100, 104]];
const TARGETS = [51, 52, 80, 100, 101];
const SEE = [35, 51, 80, 100];
/** 问实体框的那一帧(不在 `SEE` 里;药丸的光晕这时还在放大,框逐帧在变) */
const LAYOUT_FRAME = 57;
/** 差到这个数以内算相同(同一条路上逐字节相同就是 0;留一点余量给 see_frames 那条路可能的再编码) */
const TOL = 0.05;

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => { if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 700))); say('FAIL', { label, extra }); } return !!cond; };
const quiet = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

const scaleOf = (w) => w / 1920;
const pillClip = (w = W) => ({ id: 'clip-p', kind: 'card', cardId: 'punch-pill', start: 1, end: SECONDS, params: { text: '对照卡' },
  frame: { x: Math.round(w / 3), y: Math.round(w * 150 / 960), w: 560, h: 200, anchor: [0.5, 0.5], scale: w / 960 } });
const fullFrame = (w) => ({ frame: { x: 0, y: 0, w: 1920, h: 1080, anchor: [0, 0], scale: scaleOf(w) } });
const secondPill = (w = W) => ({ ...pillClip(w), id: 'clip-q', start: 3, params: { text: '第二枚' }, frame: { ...pillClip(w).frame, x: Math.round(w * 0.7), y: Math.round(w * 400 / 960) } });
const earlyClip = (w = W) => ({ id: 'clip-e', kind: 'card', cardId: 'rank-bars', start: 0.2, end: SECONDS, params: {}, ...fullFrame(w) });
const glassClip = (w = W) => ({ id: 'clip-t', kind: 'card', cardId: 'odometer', start: 0.2, end: SECONDS, params: { position: 'left', value: 86420, label: 'x' }, ...fullFrame(w) });
const userClip = (w = W) => ({ id: 'clip-u', kind: 'card', cardId: USER_CARD, start: 0.2, end: SECONDS, params: { label: '框架卡' }, ...fullFrame(w) });
const track = (id, clips) => ({ id, name: id, hidden: false, clips });
const base = (id, w, h, seconds, tracks) => ({ id: `${id}-${RUN}`, name: `推帧补画探针 ${id}`, width: w, height: h, fps: FPS, duration: seconds,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {}, tracks });
/** 第一条序列在最上面 */
function variantProject(variant, w = W, h = H) {
  const tracks = variant === 'glass' ? [track('tr-t', [glassClip(w)]), track('tr-q', [secondPill(w)]), track('tr-p', [pillClip(w)]), track('tr-e', [earlyClip(w)])]
    : variant === 'user' ? [track('tr-u', [userClip(w)]), track('tr-q', [secondPill(w)]), track('tr-p', [pillClip(w)]), track('tr-e', [earlyClip(w)])]
      : variant === 'plain' ? [track('tr-q', [secondPill(w)]), track('tr-p', [pillClip(w)]), track('tr-e', [earlyClip(w)])]
        : [track('tr-p', [pillClip(w)])];
  return base(`pd-${variant}-${w}`, w, h, SECONDS, tracks);
}
/** 并行导出用的项目(6 秒):卡前后接着,中间留出能切的空当;切点后面的卡都在切点之后才挂载 */
function shardProject(w = W, h = H) {
  const pill = (id, text, start, end) => ({ ...pillClip(w), id, start, end, params: { text } });
  return base(`pd-shards-${w}`, w, h, 6, [
    track('tr-a', [pill('clip-a1', '第一枚', 0.2, 1.9), pill('clip-a2', '第二枚', 2.1, 3.9), pill('clip-a3', '第三枚', 4.1, 6)]),
    track('tr-b', [{ ...earlyClip(w), id: 'clip-b1', start: 0.3, end: 1.9 }, { ...glassClip(w), id: 'clip-b2', start: 2.2, end: 3.9 }, { ...earlyClip(w), id: 'clip-b3', start: 4.2, end: 6 }]),
    track('tr-c', [{ id: 'clip-c1', kind: 'card', cardId: 'particles', start: 0, end: 1.9, params: { quantity: 80, speed: 1.5, size: 4, links: 'yes', seed: 3 } },
      { id: 'clip-c3', kind: 'card', cardId: 'particles', start: 4.1, end: 6, params: { quantity: 80, speed: 1.5, size: 4, links: 'yes', seed: 5 } }]),
  ]);
}

const USER_SOURCE = `import type { CardDef, CardProps } from "../../kernel/types";
import { interpolate, tween } from "../../kernel/remotionStyle";

interface Params { label: string }

function PdCover({ params, t = 0 }: CardProps<Params>) {
  const x = interpolate(t, [0, 3], [0, 900]);
  return (
    <div style={{ position: "absolute", inset: 0, fontFamily: "sans-serif" }}>
      <div style={{ position: "absolute", inset: 0, background: "rgba(40, 90, 200, 0.25)", opacity: tween(t, { duration: 0.4 }) }} />
      <div style={{ position: "absolute", left: 120 + x, top: 90, width: 220, height: 36, borderRadius: 18, background: "#ffd166" }} />
      <div style={{ position: "absolute", left: 120, bottom: 90, fontSize: 72, color: "#ffffff" }}>{params.label}</div>
    </div>
  );
}

export const pdCover: CardDef<Params> = {
  id: "${USER_CARD}",
  name: "推帧补画探针：盖在上面的框架卡",
  description: "探针用的 remotion 式 DOM 卡：半透明的一层盖住整个画面，一条横杠匀速右移",
  source: "user",
  useWhen: "探针用，不用于真实项目。",
  tags: ["探针"],
  frameMode: "direct",
  defaults: { label: "框架卡" },
  controls: [{ key: "label", label: "文字", type: "text" }],
  Component: PdCover,
  lifecycle: { settleMs: 400, after: "hold", exit: ["fade"] },
};
`;

const diff = (a, b) => { if (!a || !b || a.length !== b.length) return Infinity; let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
const rgba = (buf) => decodePngRgba(Buffer.from(buf)).data;

const out = { out: OUT, legacy: LEGACY, pushDraw: LEGACY ? '关(复现修之前)' : '开', variants: {}, };
await fs.mkdir(path.join(OUT, 'export'), { recursive: true });
await fs.mkdir(path.join(OUT, 'shots'), { recursive: true });
let dev = null, bakery = null, pipeline = null;
const started = Date.now();
try {
  let origin = ORIGIN;
  if (!origin) {
    dev = await startDevServer({ port: PORT, dataDir: path.join(OUT, 'dev-data'), tag: 'pushdraw' });
    origin = dev.origin;
    say('spawn', { pid: dev.pid, port: PORT });
  }
  origin = origin.replace(/\/+$/, '');
  out.origin = origin;
  const emptyUrl = (w = W, h = H) => `${origin}/?export=1&timeline=${encodeURIComponent(`data:application/json,${encodeURIComponent(JSON.stringify({ width: w, height: h, fps: FPS, duration: 1, tracks: [], media: [] }))}`)}`;
  const exportUrl = (project) => `${origin}/?export=1&timeline=${encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(project)))}`;

  if (VARIANTS.includes('user')) {
    const r = await fetch(`${origin}/api/cards/create`, { method: 'POST', headers: { 'content-type': 'application/json', origin }, signal: AbortSignal.timeout(60_000),
      body: JSON.stringify({ id: USER_CARD, source: USER_SOURCE, projectId: variantProject('user').id }) });
    const body = await r.json().catch(() => null);
    out.userCard = { id: USER_CARD, status: r.status, ok: body?.ok === true, errors: r.status === 200 ? undefined : (body?.errors ?? [body?.error]) };
    say('user-card', out.userCard);
    if (!check(r.status === 200 && body?.ok === true, '建用户卡(/api/cards/create)回 200', out.userCard)) VARIANTS.splice(VARIANTS.indexOf('user'), 1);
    else await sleep(1500); // 开发服务器把这张卡的模块编出来
  }

  bakery = await quiet(() => openBakery({ url: emptyUrl() }));
  /** 在共用的那一页上跑一趟 `bakeFrames`,回 帧号 → RGBA */
  const bake = async (project, opts) => {
    await bakery.reset(project, emptyUrl(project.width, project.height));
    bakery.streamLease = null;
    const frames = new Map();
    const pngs = new Map();
    const t0 = Date.now();
    const result = await quiet(() => bakeFrames(bakery, { out: path.join(OUT, 'scratch'), fps: FPS, fullFrame: true, format: 'png', warm: 3, staticSkip: false, quiet: true, writeFrames: false, ...opts,
      onFrame: async (i, buf) => { if (opts.timingOnly) return; frames.set(i, rgba(buf)); if (opts.keepFrames?.includes(i)) pngs.set(i, Buffer.from(buf)); } }));
    return { frames, pngs, ms: Date.now() - t0, result };
  };
  /** 取到的每一帧:和参照同一帧的差、最像参照的哪一帧 */
  const judge = (got, ref) => [...got].sort((a, b) => a[0] - b[0]).map(([f, picture]) => {
    const same = diff(picture, ref.get(f));
    let bestFrame = f, bestD = same;
    for (let g = Math.max(0, f - 40); g <= Math.min(ref.size - 1, f + 3); g++) { const d = diff(picture, ref.get(g)); if (d < bestD) { bestD = d; bestFrame = g; } }
    return { 帧: f, 对同一帧: round2(same), 最像第几帧: bestFrame, 那一帧的差: round2(bestD), 落后几帧: f - bestFrame };
  });
  /** 一条路中不中:`ahead` 是这条路本来就超前的帧数(开窗取帧是 1,见文件头) */
  const verdict = (rows, ahead = 0) => {
    const ok = rows.length > 0 && rows.every((r) => r.那一帧的差 <= TOL && (r.落后几帧 === 0 || r.落后几帧 === -ahead));
    const worst = rows.reduce((a, b) => (Math.abs(b.落后几帧) > Math.abs(a.落后几帧) || (Math.abs(b.落后几帧) === Math.abs(a.落后几帧) && b.对同一帧 > a.对同一帧) ? b : a), rows[0] ?? {});
    return { 中: !ok, 最差的一帧: worst, 各帧: rows };
  };
  /** 该不该中:修了以后都不中;`--legacy` 下页面上有更早挂载的卡的三档该中,只有药丸的对照档不中 */
  const expectHit = (variant) => LEGACY && variant !== 'alone';
  const settle = (variant, name, v, note) => {
    const want = expectHit(variant);
    say('path', { variant, path: name, 中: v.中, 该中: want, 最差的一帧: v.最差的一帧 });
    check(v.中 === want, `${variant} / ${name}:${want ? '关掉推帧补画时该中' : '不该中'}`, { 最差的一帧: v.最差的一帧, note });
    return { ...v, 该中: want };
  };

  pipeline = new FramePipeline({ root: path.join(OUT, 'lib'), origin: () => origin });
  let aloneLayout = null;
  const layoutOf = async (project) => {
    // 问的是 `see_frames` 没取过的一帧:取过的帧 `layout` 会直接拿它记下的快照(开窗取的,早一帧挂载;帧库按项目内容认,换项目号没用),这里要它自己推一遍
    const got = await quiet(() => pipeline.layout(project, { t: LAYOUT_FRAME / FPS, clipIds: ['clip-p'] }));
    return got?.clips?.['clip-p']?.contentBox ?? null;
  };

  for (const variant of VARIANTS) {
    const project = variantProject(variant);
    const row = out.variants[variant] = { project: project.id, 卡: project.tracks.map((t) => t.clips.map((c) => `${c.cardId}@${c.start}s`).join('+')).join(' / ') };
    const reference = await bake(project, { frames: `0-${N - 1}`, keepFrames: [35, 51] });
    const ref = reference.frames;
    say('reference', { variant, frames: ref.size });
    // 看图用:参照的第 35、51 帧,和下面两条路取到的同一帧(`--legacy` 的另存一份)
    const shot = (name, buf) => fs.writeFile(path.join(OUT, 'shots', `${variant}-${name}${LEGACY ? '-legacy' : ''}.png`), buf);
    if (variant !== 'alone') for (const [f, buf] of reference.pngs) await shot(`ref-f${f}`, buf);
    if (variant === VARIANTS[0]) {
      // 参照自己可不可靠:再导一遍,逐帧相同(头几十帧的老问题只在演示项目上见过,这里顺带记一下)
      const again = (await bake(project, { frames: `0-${N - 1}` })).frames;
      row.参照导两遍不同的帧 = [...ref].filter(([f, a]) => diff(a, again.get(f)) > 0).map(([f]) => f);
      check(row.参照导两遍不同的帧.length === 0, `${variant}:参照导两遍逐帧相同`, row.参照导两遍不同的帧.slice(0, 20));
    }

    if (PATHS.has('range')) {
      const got = new Map();
      const pushes = [];
      for (const [a, b] of RANGES) {
        const result = await quiet(() => exportUnified(project, { url: exportUrl(project), out: path.join(OUT, 'scratch', `range-${variant}-${a}`), frames: `${a}-${b}`, workers: 1, noVideo: true, writeFrames: false,
          onFrame: async (i, buf) => { got.set(i, rgba(buf)); if (i === 51 && variant !== 'alone') await shot('range-f51', Buffer.from(buf)); } }));
        pushes.push({ 段: `${a}-${b}`, 推过去的帧数: a, 补画的拍数: result.pushDrawn ?? null });
      }
      row.只导一段 = { ...settle(variant, 'range 只导一段', verdict(judge(got, ref))), 推帧: pushes };
      row.只导一段.各帧 = row.只导一段.各帧.filter((r, k) => k < 3 || r.对同一帧 > TOL).slice(0, 6);
      // 静止的帧不补画:补画的拍数比推过去的帧数少(只有药丸的那一档,药丸进场以前整个画面都是空的)
      if (!LEGACY) check(pushes.every((x) => x.补画的拍数 > 0 && x.补画的拍数 < x.推过去的帧数 + 2), `${variant}:只导一段时静止的帧没有补画`, pushes);
      else check(pushes.every((x) => x.补画的拍数 === 0), `${variant}:关掉以后一拍都不补`, pushes);
    }
    if (PATHS.has('targets')) {
      const got = new Map();
      await quiet(() => exportUnified(project, { url: exportUrl(project), out: path.join(OUT, 'scratch', `targets-${variant}`), targetFrames: TARGETS, noVideo: true, writeFrames: false,
        onFrame: async (i, buf) => { got.set(i, rgba(buf)); } }));
      row.只取几帧的导出 = settle(variant, 'targets 只取几帧的导出', verdict(judge(got, ref), 0));
    }
    if (PATHS.has('see')) {
      const frames = await quiet(() => pipeline.see_frames(project, SEE.map((f) => f / FPS), { lane: 'agent' }));
      const got = new Map([...frames].map(([f, value]) => [f, rgba(value.buf)]));
      row.抽帧 = settle(variant, 'see_frames 抽帧', verdict(judge(got, ref), 0), { sources: [...frames].map(([f, v]) => `${f}:${v.source}`) });
      if (variant !== 'alone') await shot('see-f35', frames.get(35).buf);
    }
    if (PATHS.has('layout')) {
      // 药丸的实体框只取决于药丸自己:和只有药丸的项目同一时刻(同一条开窗取帧的路)的框比
      aloneLayout ??= await layoutOf(variantProject('alone'));
      const box = variant === 'alone' ? aloneLayout : await layoutOf(project);
      const same = JSON.stringify(box) === JSON.stringify(aloneLayout);
      const want = expectHit(variant);
      row.get_layout = { 药丸的实体框: box, 只有药丸时: aloneLayout, 中: !same, 该中: want };
      say('path', { variant, path: 'layout', ...row.get_layout });
      check(box && !same === want, `${variant} / get_layout:${want ? '关掉推帧补画时该中' : '不该中'}`, row.get_layout);
    }
    if (PATHS.has('stream') && (variant === 'plain' || variant === 'alone')) {
      // 流的推帧:这一页上的卡就是这条流的成员(plain = 两张卡的组流页面,alone = 单卡流页面);不裁矩形
      const mountFrame = Math.min(...project.tracks.flatMap((t) => t.clips.map((c) => mountFrameOf(c, FPS))));
      const first = Math.min(...project.tracks.flatMap((t) => t.clips.map((c) => Math.ceil(c.start * FPS - 1e-9))));
      const stream = async (calls) => {
        await bakery.reset(project, emptyUrl(), { deferCards: true });
        bakery.streamLease = null;
        const frames = new Map();
        const stats = [];
        for (const call of calls) stats.push(await quiet(() => bakeStream(bakery, { streamSignature: `pd-${variant}`, fps: FPS, mountFrame, ...call, onFrame: async (f, png) => { frames.set(f, rgba(png)); } })));
        return { frames, stats };
      };
      const dense = await stream([{ fromFrame: first, toFrame: N - 1, stride: 1 }]);
      const replay = await stream([{ fromFrame: first + 60, toFrame: first + 74, stride: 1 }]);
      // 再回放一段更晚的:第二枚药丸在静止了一段以后才挂载,这一段正在它的入场动画里
      const replayLate = await stream([{ fromFrame: first + 90, toFrame: first + 104, stride: 1 }]);
      const segments = [];
      for (let a = first; a < N; a += 15) segments.push({ fromFrame: a, toFrame: Math.min(N - 1, a + 14), stride: 15 });
      const sparse = await stream(segments);
      const page = variant === 'plain' ? '两张卡的页面' : '只有药丸的页面';
      const a = verdict(judge(new Map([...replay.frames, ...replayLate.frames]), dense.frames));
      const b = verdict(judge(sparse.frames, dense.frames));
      a.各帧 = a.各帧.filter((r, k) => k < 2 || r.对同一帧 > TOL).slice(0, 5);
      b.各帧 = b.各帧.filter((r, k) => k < 2 || r.对同一帧 > TOL).slice(0, 8);
      row.流_断租约回放的分段 = { ...settle(variant, `stream 回放的分段(${page})`, a), 回放了几帧: [replay.stats[0].replayed, replayLate.stats[0].replayed], 补画的拍数: [replay.stats[0].pushDrawn, replayLate.stats[0].pushDrawn] };
      row.流_稀疏那一趟 = { ...settle(variant, `stream 稀疏那一趟(${page})`, b), 分段数: segments.length, 补画的拍数: sparse.stats.reduce((s, x) => s + x.pushDrawn, 0),
        补画一共毫秒: sparse.stats.reduce((s, x) => s + x.pushDrawMs, 0), 推帧一共毫秒: sparse.stats.reduce((s, x) => s + x.stepMs, 0) };
    }
  }

  if (PATHS.has('shards')) {
    const project = shardProject();
    const total = 6 * FPS;
    const ref = (await bake(project, { frames: `0-${total - 1}` })).frames;
    const got = new Map();
    const lines = [];
    const log = console.log;
    console.log = (...a) => { const s = a.join(' '); if (s.startsWith('分片导出')) lines.push(s); };
    let result;
    try {
      result = await exportUnified(project, { url: exportUrl(project), out: path.join(OUT, 'scratch', 'shards'), workers: 3, noVideo: true, writeFrames: false,
        onFrame: async (i, buf) => { got.set(i, rgba(buf)); } });
    } finally { console.log = log; }
    const rows = judge(got, ref);
    const bad = rows.filter((r) => r.对同一帧 > 0);
    out.并行导出 = { project: project.id, 切法: lines[0] ?? null, parts: result.parts?.map((p) => `${p.startFrame}-${p.endFrame}`), 帧数: rows.length, 和整段导出不同的帧: bad.length, 样例: bad.slice(0, 6), 中: bad.length > 0, 该中: false };
    say('shards', out.并行导出);
    check(rows.length === total && (result.parts?.length ?? 0) > 1, '并行导出真的切成了几片', out.并行导出);
    check(bad.length === 0, '并行导出的每一帧和整段导出逐像素相同', out.并行导出);
  }

  if (COST) {
    out.代价 = {};
    for (const [w, h] of [[960, 540], [1920, 1080]]) {
      const project = variantProject('plain', w, h);
      await quiet(async () => { await bakery.close(); bakery = await openBakery({ url: emptyUrl(w, h) }); });
      const timeOf = async (pushDraw) => {
        const runs = [];
        for (let k = 0; k < 3; k++) runs.push((await bake(project, { frames: `${N - 10}-${N - 1}`, pushDraw, timingOnly: true })).ms);
        return runs.sort((a, b) => a - b)[1];
      };
      const off = await timeOf(false), on = await timeOf(true);
      const pushed = N - 10;
      // 单拍:同一个静止的页面上各发 60 拍
      await bakery.reset(project, emptyUrl(w, h));
      const beat = async (extra) => { const t0 = performance.now(); for (let k = 0; k < 60; k++) await bakery.beginFrame(extra); return (performance.now() - t0) / 60; };
      await beat({ screenshot: { format: 'jpeg', quality: 0 } });
      const plain = await beat(), jpeg0 = await beat({ screenshot: { format: 'jpeg', quality: 0 } }), png = await beat({ screenshot: { format: 'png', optimizeForSpeed: true } });
      // 并行导出的总耗时
      const shards = shardProject(w, h);
      const whole = async (pushDraw, workers) => { const t0 = Date.now(); await quiet(() => exportUnified(shards, { url: exportUrl(shards), out: path.join(OUT, 'scratch', `cost-${w}-${pushDraw}-${workers}`), workers, noVideo: true, writeFrames: false, ...(pushDraw === undefined ? {} : { pushDraw }), onFrame: async () => {} })); return Date.now() - t0; };
      // 缺省:第二片起不补(`export-unified.mjs`);「都补」是硬传 pushDraw: true 的对照(要是分片也补会多花多少)
      const single = await whole(undefined, 1), parOff = await whole(false, 3), parDefault = await whole(undefined, 3), parAll = await whole(true, 3);
      out.代价[`${w}x${h}`] = { 推过去的帧数: pushed, 只导末尾十帧_关: off, 只导末尾十帧_开: on, 每推一帧多花毫秒: round2((on - off) / pushed),
        单拍毫秒: { 不带截图: round2(plain), 丢掉的JPEG: round2(jpeg0), PNG: round2(png) },
        六秒项目整段导出毫秒: { 单进程: single, 三片_关: parOff, 三片_缺省: parDefault, 三片_每片都补: parAll, 每片都补多花百分比: round2((parAll - parOff) / parOff * 100) } };
      say('cost', { size: `${w}x${h}`, ...out.代价[`${w}x${h}`] });
    }
  }
} catch (error) {
  fails.push(`异常:${error?.stack || error}`);
  say('ERROR', { error: String(error?.stack || error) });
} finally {
  try { await pipeline?.close(); } catch { /* ignore */ }
  try { await bakery?.close(); } catch { /* ignore */ }
  try { await dev?.stop(); } catch { /* ignore */ }
  if (!KEEP) { try { for (const name of await fs.readdir(OUT)) if (!/\.json$/.test(name) && name !== 'shots') await fs.rm(path.join(OUT, name), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* ignore */ } }
}
out.elapsedMs = Date.now() - started;
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
console.log(out.ok ? 'PASS' : `FAIL ${fails.length}`);
process.exit(out.ok ? 0 : 1);
