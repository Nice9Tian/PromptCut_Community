/**
 * 用 remotion 式框架写的用户卡，经真的预渲染管线和导出管线跑一遍
 * （任务书 `docs/plan/render-refactor-task.md`「乙」框架、「丙」建卡指南；丙的报告 `docs/archive/agent-reports/AGENT-rr-guide.md`
 * 只验到：指南例子过建卡检查、在线页面的卡片运行时、托管渲染的隔离工作进程。本探针补验：这种卡经**桌面的预渲染进程**产轨道流、
 * 经**导出页**导出、再和**编辑器预览**对上）。
 *
 *   node scripts/probes/framework-card-pipeline-probe.mjs [--port 27780] [--out <目录>] [--json <文件>] [--keep]
 *        [--only create,export,prerender,preview] [--origin http://127.0.0.1:27780] [--default-review]
 *
 * 端口：编辑器用 --port，另占 +1、+2 当舞台端口，三个连号都要空着（缺省 27780～27782）。自己起一台隔离的编辑器
 * （`scripts/lib/dev-server.mjs` 的 `startDevServer`；`no-user-dirs.mjs` 已设 `PROMPTCUT_NO_PORT_FILE=1`；数据目录、导出目录、
 * 卡片改动层都在临时目录里，检出目录里一个文件都不多），做完连子进程一起收掉。`--origin` 接一台已经起好的（只给调试用；
 * 建的卡带本次运行的随机后缀，不会和已有的撞）。`--only` 只跑其中几步（调试用；缺省全跑，验收口径是全跑）。
 * `--default-review`：第 4 步只做 4a（不在探针进程里改计划能力），等默认就有的三条流（两张用户卡各一条依赖下层的流、punch-pill 一条单卡流）
 * 产完就收，记下用了多久（只记录）。
 *
 * 做什么（每步的判据写在后面；耗时只记录，不当通过条件）：
 *
 *   1. create     经真的 `POST /api/cards/create` 建三张用户卡，都声明 `frameMode: "direct"`（remotion 式）、都引用框架：
 *                   fw-title    DOM 卡：用 interpolate、Easing、spring、stagger、random、tween；
 *                   fw-colors   DOM 卡：用 interpolateColors、noise、loop、pingPong、randomRange、tween；
 *                   fw-bad      对照：remotion 式里用了 useState，必须被拒（HTTP 400），报错带行号，说的是记状态的 hook，
 *                               且没有落进改动层（证明走的是真的检查）。
 *                 前两张必须回 200、源码落进改动层、检出目录不多文件。
 *   2. 项目       1280×720、30 fps、9 秒。fw-title 0.7～4.9 秒，fw-colors 3.3～7.6 秒（起点都不在整秒上，各 4 秒以上），
 *                 内置 motion 式卡 punch-pill（`frameMode: "stateful"`）6.0～9.0 秒作对照。
 *   3. export     同一个项目（数据 URL 放进导出页地址，同 `export-baseline-compare.mjs`）：
 *                   a. 单路（--workers 1）全长导一遍，再导一遍；
 *                   b. 分 4 路（--workers 4）导一遍，再导一遍；切口取自导出输出的「分片导出」一行，**每张用户卡的片段里至少要落一个切口**
 *                      （片段中间；motion 式的 punch-pill 不许被切）；
 *                   c. 只导抽出来的若干帧（--target-frames；含切口前一帧、切口、切口后一帧、各卡首帧）。
 *                 判据：单路两遍、4 路两遍、单路对 4 路、单路对抽帧——每一帧字节相同；字节不同时再比像素，像素也不同才算不过。
 *                 不空洞：用户卡的片段里每一帧都有内容（不透明度大于 0 的像素），且不同时刻的画面不同；总帧数是 270。
 *   4. prerender  进程内起一个 `FramePipeline`（同预渲染进程的代码，`interactive: true`，库根放临时目录），把三张卡钉成重卡
 *                 （`streamPicked` 钉成全选；remotion 式的卡声明上是轻卡，不钉就没有流）。分两小步：
 *                 4a 默认行为：用户卡不在审阅表（`src/cards/capabilities.json`）里，计划里 `compositing` 是 unknown，按下层依赖卡处理，
 *                    **不进单卡流**（`docs/semantics/mechanism/cards.md`「分类以审阅表为准」）——照默认，两张用户卡判重时各有一条
 *                    **依赖下层的流**（连同下面的层一起渲，流里只存这张卡改动的那一层，按舞台坐标贴回去）。探针用没改过的计划算一遍
 *                    `planStreams`，核对这个事实（用户卡有依赖下层的流、没有单卡流；punch-pill 有单卡流）。贴得对不对由
 *                    `stream-below-stage-probe.mjs` 的场景丙（也是一张用框架写的用户卡）用像素核对；
 *                 4b 在**探针进程的内存里**把两张用户卡在计划里的 `compositing` 改成 independent（等于「审阅表登记了它们」；产品代码一个字不动），
 *                    验这种卡的流产出来以后不回放、与回放着产逐帧相同。预渲染完：
 *                   - 三张卡各有一条轨道流；两张用户卡的流 `replay` 是 false，`replayedFrames` 是 0；punch-pill 的流 `replay` 是 true；
 *                   - 把每条流中间的两个分段作废再产（每段都断租约），两张用户卡的流 `replayedFrames` 仍是 0，punch-pill 的 > 0；
 *                   - 每条用户卡的流取三个分段，A 路「不回放直接产」对 B 路「从挂载帧回放着产」逐帧比像素，必须一张不差；
 *                     punch-pill 的流是对照：两路必须比出差别（证明这套比法测得出「该回放而没回放」）；
 *                   - 流库里不回放产出的那一段，和 B 路的 PNG 用同一个编码器编出来的逐字节相同（不同再解码逐像素比）。
 *   5. preview    编辑器页（双舞台，`?editor&nosetup=1&preview=stage`）载入同一个项目，暂停着在时间轴上点十个时刻（前进、往回、
 *                 同一帧到达两次），每次等它回到精确活渲（父页发的 setTime 带 settle、可见舞台的 t 对上、卡没有在落定 / 抑制 /
 *                 等快照 / 追帧）、画面连着三次采样不变，取可见舞台里这张卡的**DOM**（包裹层的 innerHTML）。导出一侧：
 *                 同一个项目在导出页走导出的 `bakeFrames`（targetFrames、fullFrame，和第 3 步 c 同一条路），每一帧截完后取同一张卡的 DOM。
 *                 判据（DOM 逐字符相同，不设容差——卡是 t 和参数的纯函数，两边同一个 t 就该渲出同一份 DOM）：
 *                   - 预览里每个到达的时刻，每张在场的用户卡的 DOM 与导出同一帧的 DOM 相同；
 *                   - 往回点（80、45 第二次到达）与第一次往前到达的同一帧 DOM 相同；
 *                   - 对照：两个不同的帧（45 与 80）的 DOM 不同，且在场的卡 DOM 都不空。
 *                 不比截图像素的原因：预览里舞台是按编辑台的缩放显示的（缩放后重新光栅化，且叠在主题底上），导出是 1:1 的透明层，
 *                 两者的像素本来就不可比；DOM 逐字符相同加上第 3 步「导出帧在各路之间字节相同」，已经把「画面由 t 决定」两头都钉住。
 *                 预览与导出各存几张图在 `--out/shots/` 里供人看。
 *   6. 输出一份 JSON（`ok`、`fails`、每一步的关键数）：过程写 stderr，stdout 最后一行是 JSON，也写进 `--out/result.json`（和 `--json`）。
 *
 * 通过标准：fails 为空，退出码 0；有不过的退出码 1；用法不对或起不来退出码 2（输出里 fails 写原因）。
 * 不改任何产品代码（src/、server/）。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import：不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR，并设 PROMPTCUT_NO_PORT_FILE=1
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { flagArg } from './probe-connect.mjs';
import { startDevServer } from '../lib/dev-server.mjs';
import { exportUrlOf } from './export-baseline-compare.mjs';
import { openEditorPage } from './preview-stop-lib.mjs';
import { FramePipeline } from '../../server/frame-pipeline.mjs';
import { SEGMENT_FRAMES, planStreams, splitFmp4 } from '../../server/frame-stream.mjs';
import { streamSegmentFirstFrame, streamSegmentLastFrame } from '../../src/render/streamSegments.mjs';
import { bakeFrames, bakeStream } from '../../server/bakery/bake.mjs';
import { openBakery } from '../../server/bakery/chrome.mjs';
import { openStreamSegmentEncoder } from '../../server/bakery/ffmpeg.mjs';

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const PORT = Number(flagArg('port', '27780', args)) || 27780;
const GIVEN_ORIGIN = flagArg('origin', null, args);
const KEEP = args.includes('--keep');
/** 只看默认行为（不在探针进程里改计划能力）：第 4 步只做 4a，等 punch-pill 的流出来就收，记下用了多久 */
const DEFAULT_REVIEW = args.includes('--default-review');
const JSON_OUT = flagArg('json', null, args);
const OUT = path.resolve(flagArg('out', null, args) || path.join(ROOT, 'out', 'framework-card-pipeline-probe'));
const ONLY = new Set((flagArg('only', 'create,export,prerender,preview', args) || '').split(',').map((s) => s.trim()).filter(Boolean));
const want = (step) => ONLY.has(step);
const RUN = Date.now().toString(36);
const FPS = 30;
const WIDTH = 1280;
const HEIGHT = 720;
const SECONDS = 9;
const TOTAL_FRAMES = SECONDS * FPS;

const say = (step, fields = {}) => process.stderr.write(`${JSON.stringify({ step, t: Date.now(), ...fields })}\n`);
const fails = [];
const check = (cond, label, extra) => {
  if (!cond) { fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 900))); say('FAIL', { label, extra }); }
  return !!cond;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const done = (code, out) => {
  const text = JSON.stringify(out);
  process.stdout.write(`${text}\n`);
  process.exit(code);
};
if (!GIVEN_ORIGIN && [5190, 5191, 5192].some((p) => p >= PORT && p <= PORT + 2)) done(2, { ok: false, fails: ['这一段端口是用户常驻的开发服务器的，换一个'] });

/* ------------------------------------------------------------------ 卡片源码 */

const ID = { title: `fw-title-${RUN}`, colors: `fw-colors-${RUN}`, bad: `fw-bad-${RUN}` };

const TITLE_SOURCE = `import type { CardDef, CardProps } from "../../kernel/types";
import { Easing, interpolate, random, spring, springDuration, stagger, staggerDuration, tween } from "../../kernel/remotionStyle";

interface Params { text: string; seed: number; accent: string }

const POP = { stiffness: 190, damping: 13 };
const SWEEP = Easing.bezier(0.16, 1, 0.3, 1);

function FwTitle({ params, t = 0 }: CardProps<Params>) {
  const chars = [...params.text];
  const lineStart = staggerDuration(chars.length, { each: 0.09 }, 0.2);
  const line = interpolate(t, [lineStart, lineStart + 0.7], [0, 1], { easing: SWEEP });
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", fontFamily: "sans-serif" }}>
      <div style={{ display: "flex", fontSize: 92, fontWeight: 800 }}>
        {chars.map((ch, i) => {
          const local = stagger(t, i, { each: 0.09 });
          const tilt = (random(params.seed, i, "rot") - 0.5) * 24 * (1 - tween(local, { duration: 0.5 }));
          const lift = Math.round(random(params.seed, i, "lift") * 10);
          return (
            <span
              key={i}
              style={{
                display: "inline-block",
                whiteSpace: "pre",
                opacity: tween(local, { duration: 0.25 }),
                transform: \`translateY(\${spring(local, { ...POP, from: 70, to: lift })}px) rotate(\${tilt}deg) scale(\${spring(local, { ...POP, from: 0.5, to: 1 })})\`,
                color: i % 2 ? "#4cc9f0" : params.accent,
              }}
            >
              {ch}
            </span>
          );
        })}
      </div>
      <div style={{ marginTop: 20, height: 8, width: 640 * line, borderRadius: 4, background: params.accent, opacity: line }} />
    </div>
  );
}

export const fwTitle: CardDef<Params> = {
  id: "${ID.title}",
  name: "框架探针：逐字弹入",
  description: "探针用的 remotion 式 DOM 卡：标题逐字弹入（弹簧、错开进场、带种子的随机），随后一条线展开",
  source: "user",
  useWhen: "探针用，不用于真实项目。",
  tags: ["探针"],
  frameMode: "direct",
  defaults: { text: "框架卡走真管线", seed: 7, accent: "#ffd166" },
  controls: [
    { key: "text", label: "文字", type: "text" },
    { key: "seed", label: "随机种子", type: "number", min: 0, max: 9999, step: 1 },
    { key: "accent", label: "主色", type: "color" },
  ],
  Component: FwTitle,
  timing: (p) => ({ settleMs: Math.round((staggerDuration([...p.text].length, { each: 0.09 }, springDuration(POP)) + 0.8) * 1000) }),
  lifecycle: { settleMs: 2000, after: "hold", exit: ["fade"] },
};
`;

const COLORS_SOURCE = `import type { CardDef, CardProps } from "../../kernel/types";
import { Easing, interpolateColors, loop, noise, pingPong, randomRange, tween } from "../../kernel/remotionStyle";

interface Params { count: number; seed: number }

const PALETTE = ["#ff4d6d", "#ffd166", "#06d6a0", "#4cc9f0"];
const STOPS = [0, 1, 2, 3];
const RISE = Easing.out(Easing.cubic);

function FwColors({ params, t = 0 }: CardProps<Params>) {
  const count = Math.max(1, Math.min(24, Math.round(params.count)));
  const sweep = interpolateColors(loop(t, 3), STOPS, PALETTE);
  const ring = 1 + pingPong(t, 0.75) * 0.25;
  return (
    <div style={{ position: "absolute", inset: 0, fontFamily: "sans-serif" }}>
      <div style={{ position: "absolute", left: 80, top: 70, width: 96, height: 96, borderRadius: 48, border: "10px solid " + sweep, transform: \`scale(\${ring})\`, opacity: tween(t, { duration: 0.4 }) }} />
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 70, display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 14 }}>
        {Array.from({ length: count }, (_, i) => {
          const grown = tween(t, { delay: i * 0.05, duration: 0.6, easing: RISE });
          const target = randomRange(70, 260, params.seed, i);
          const sway = 1 + noise(t * 1.2, params.seed, i, "sway") * 0.12;
          return (
            <div
              key={i}
              style={{
                width: 38,
                height: target * grown * sway,
                borderRadius: 8,
                background: interpolateColors(loop(t + i * 0.25, 3), STOPS, PALETTE),
                opacity: 0.9,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

export const fwColors: CardDef<Params> = {
  id: "${ID.colors}",
  name: "框架探针：变色柱子",
  description: "探针用的 remotion 式 DOM 卡：一排柱子颜色随时间循环变化、高度带噪声起伏，左上角一个来回脉动的圆环",
  source: "user",
  useWhen: "探针用，不用于真实项目。",
  tags: ["探针"],
  frameMode: "direct",
  defaults: { count: 12, seed: 3 },
  controls: [
    { key: "count", label: "柱子个数", type: "number", min: 1, max: 24, step: 1 },
    { key: "seed", label: "随机种子", type: "number", min: 0, max: 9999, step: 1 },
  ],
  Component: FwColors,
  lifecycle: { settleMs: 1500, after: "evolve", exit: ["fade"] },
};
`;

/** 对照：remotion 式里用了 useState（记状态的 hook）。第 11 行起 */
const BAD_SOURCE = `import { useEffect, useState } from "react";
import type { CardDef, CardProps } from "../../kernel/types";
import { tween } from "../../kernel/remotionStyle";

interface Params { text: string }

function FwBad({ params, t = 0 }: CardProps<Params>) {
  const [frames, setFrames] = useState(0);
  useEffect(() => { setFrames((n) => n + 1); }, [t]);
  return <div style={{ position: "absolute", inset: 0, opacity: tween(t, { duration: 0.4 }) }}>{params.text}{frames}</div>;
}

export const fwBad: CardDef<Params> = {
  id: "${ID.bad}",
  name: "框架探针：违规对照",
  description: "探针用的违规对照：remotion 式里用了记状态的 hook，必须被建卡检查拒绝",
  source: "user",
  frameMode: "direct",
  defaults: { text: "x" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: FwBad,
};
`;

/* ------------------------------------------------------------------ 项目 */

const PROJECT = {
  id: `fw-pipeline-${RUN}`, name: '框架卡进真管线', width: WIDTH, height: HEIGHT, fps: FPS, duration: SECONDS,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-title', name: 'title', hidden: false, clips: [
      { id: 'clip-title', kind: 'card', cardId: ID.title, start: 0.7, end: 4.9, params: { text: '框架卡走真管线', seed: 7, accent: '#ffd166' } },
    ] },
    { id: 'tr-colors', name: 'colors', hidden: false, clips: [
      { id: 'clip-colors', kind: 'card', cardId: ID.colors, start: 3.3, end: 7.6, params: { count: 12, seed: 3 } },
    ] },
    { id: 'tr-pill', name: 'pill', hidden: false, clips: [
      { id: 'clip-pill', kind: 'card', cardId: 'punch-pill', start: 6.0, end: 9.0, params: { text: '对照卡' }, frame: { x: 640, y: 150, w: 560, h: 200, anchor: [0.5, 0.5] } },
    ] },
  ],
};
const USER_CLIPS = ['clip-title', 'clip-colors'];
const clipOf = (id) => PROJECT.tracks.flatMap((t) => t.clips).find((c) => c.id === id);
/** 片段在场的帧 [first, last]（挂载提前量按「起点所在帧」算，只用来挑检查的帧；切口判据用导出自己的计划） */
const spanOf = (id) => { const c = clipOf(id); return [Math.ceil(c.start * FPS - 1e-9), Math.ceil(c.end * FPS - 1e-9) - 1]; };

/* ------------------------------------------------------------------ 工具 */

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** 两张 PNG 有多少个像素不同（RGBA 任一分量不等）；尺寸不同回 -1 */
function diffPixels(a, b) {
  const pa = PNG.sync.read(a), pb = PNG.sync.read(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return -1;
  let n = 0;
  for (let i = 0; i < pa.data.length; i += 4) {
    if (pa.data[i] !== pb.data[i] || pa.data[i + 1] !== pb.data[i + 1] || pa.data[i + 2] !== pb.data[i + 2] || pa.data[i + 3] !== pb.data[i + 3]) n++;
  }
  return n;
}
/** 有多少个不透明度大于 0 的像素（画面是不是空的） */
function inkPixels(png) {
  const p = PNG.sync.read(png);
  let n = 0;
  for (let i = 3; i < p.data.length; i += 4) if (p.data[i] > 0) n++;
  return n;
}

const out = { port: PORT, run: RUN, project: PROJECT.id, ids: ID, only: [...ONLY], steps: {} };
await fs.mkdir(OUT, { recursive: true });
const SHOTS = path.join(OUT, 'shots');
await fs.mkdir(SHOTS, { recursive: true });
const WORK = fsSync.mkdtempSync(path.join(os.tmpdir(), 'pc-fw-pipeline-'));
const OVERLAY = path.join(WORK, 'card-overrides');
const USER_DIR = path.join(ROOT, 'src', 'cards', 'user');
const userDirList = () => fsSync.readdirSync(USER_DIR).sort();
const userDirBefore = userDirList();
fsSync.mkdirSync(OVERLAY, { recursive: true });

let editor = null;
let origin = null;
let pipeline = null;
let editorPage = null;
let bakery = null;

/** 导出：起 `scripts/export-frames.mjs`（和桌面的导出同一个入口），回帧目录与「分片导出」那一行解出的切口 */
async function runExport(tag, { workers = 1, targetFrames = null } = {}) {
  const dir = path.join(WORK, `export-${tag}`);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  const cmd = ['scripts/export-frames.mjs', '--url', exportUrlOf(origin, PROJECT), '--out', dir, '--fps', String(FPS), '--workers', String(workers), '--no-video'];
  if (targetFrames) cmd.push('--target-frames', targetFrames.join(','));
  const t0 = Date.now();
  const log = [];
  const child = spawn(process.execPath, cmd, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const keep = (c) => { log.push(c.toString()); if (log.length > 600) log.shift(); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* 已经退了 */ } }, 30 * 60_000); // 只为防卡死
    child.on('close', (c) => { clearTimeout(timer); resolve(c); });
    child.on('error', () => { clearTimeout(timer); resolve(-1); });
  });
  const text = log.join('');
  const frames = path.join(dir, 'frames');
  const names = fsSync.existsSync(frames) ? (await fs.readdir(frames)).filter((f) => f.endsWith('.png')).sort() : [];
  const planLine = /分片导出:(\d+) 段 ([^\n]*)/.exec(text);
  const ranges = planLine ? planLine[2].trim().split(/\s+/).map((r) => r.split('-').map(Number)) : null;
  const info = { tag, workers, code, frames: names.length, ms: Date.now() - t0, ranges };
  say('export', info);
  if (code !== 0) say('export-log', { tail: text.slice(-1200) });
  return { ...info, dir: frames, names, tail: code !== 0 ? text.slice(-1200) : undefined };
}

/** 两个导出的逐帧比：先字节，字节不同再比像素。`names` 缺省取两边都有的 */
async function compareExports(a, b, names = null) {
  const shared = names ?? a.names.filter((n) => b.names.includes(n));
  const diffs = [];
  let byteSame = 0;
  for (const name of shared) {
    const [ba, bb] = await Promise.all([fs.readFile(path.join(a.dir, name)), fs.readFile(path.join(b.dir, name))]);
    if (ba.equals(bb)) { byteSame++; continue; }
    diffs.push({ name, pixels: diffPixels(ba, bb), shaA: sha256(ba).slice(0, 12), shaB: sha256(bb).slice(0, 12) });
  }
  const pixelDiff = diffs.filter((d) => d.pixels !== 0);
  return { compared: shared.length, byteSame, bytesDiffer: diffs.length, pixelsDiffer: pixelDiff.length, first: pixelDiff.slice(0, 5), bytesOnly: diffs.filter((d) => d.pixels === 0).length };
}

try {
  /* ---------- 0. 编辑器（隔离） */
  if (GIVEN_ORIGIN) {
    origin = GIVEN_ORIGIN.replace(/\/+$/, '');
  } else {
    const cacheDir = path.join(ROOT, 'out', 'probe-vite-cache', String(PORT));
    await fs.mkdir(cacheDir, { recursive: true });
    const exportDir = path.join(WORK, 'export-dir');
    const dataDir = path.join(WORK, 'data');
    await fs.mkdir(exportDir, { recursive: true });
    await fs.mkdir(dataDir, { recursive: true });
    let lastError = null;
    for (let attempt = 1; attempt <= 6 && !editor; attempt++) {
      try {
        editor = await startDevServer({
          port: PORT, logFile: path.join(WORK, 'vite.log'), log: (m) => say('dev-server', { m }),
          env: {
            PROMPTCUT_EXPORT_DIR: exportDir, PROMPTCUT_DATA_DIR: dataDir, PROMPTCUT_VITE_CACHE_DIR: cacheDir, PROMPTCUT_CARD_OVERRIDES: OVERLAY,
            PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '', PROMPTCUT_DEVICE_ID: `fwpipe-${RUN}`.padEnd(16, '0'), PROMPTCUT_DEVICE_NAME: 'framework-card-pipeline-probe',
          },
        });
      } catch (e) {
        lastError = e;
        if (!/没有全空着/.test(String(e?.message))) throw e; // 端口被占是暂时性故障：重试加退避；别的错照原样抛
        say('port-busy', { attempt, message: String(e.message) });
        await sleep(attempt * 3000);
      }
    }
    if (!editor) throw lastError;
    origin = editor.origin;
  }
  out.origin = origin;
  say('editor', { origin, own: !!editor });

  /* ---------- 1. 建卡（真的 /api/cards/create） */
  const post = async (url, body) => {
    const r = await fetch(origin + url, { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  // 需要卡的几步（export / prerender / preview）都得先建卡；只要用 --only 点名别的步，建卡照做
  {
    const create = { cards: [] };
    for (const [label, id, source] of [['title', ID.title, TITLE_SOURCE], ['colors', ID.colors, COLORS_SOURCE]]) {
      const r = await post('/api/cards/create', { id, source, projectId: PROJECT.id });
      const stored = path.join(OVERLAY, 'src', 'cards', 'user', `${id}.tsx`);
      const inOverlay = fsSync.existsSync(stored) && fsSync.readFileSync(stored, 'utf8') === (r.body?.source ?? source);
      const row = { label, id, status: r.status, ok: r.body?.ok, inOverlay, errors: r.status === 200 ? undefined : (r.body?.errors ?? [r.body?.error]).slice?.(0, 8) };
      create.cards.push(row);
      check(r.status === 200 && r.body?.ok === true, `建卡 ${label}：必须回 200`, row);
      check(inOverlay, `建卡 ${label}：源码落进了改动层`, row);
    }
    // 对照：违规的必须被拒，带行号，说的是记状态的 hook，没有落盘
    const bad = await post('/api/cards/create', { id: ID.bad, source: BAD_SOURCE, projectId: PROJECT.id });
    const badText = JSON.stringify(bad.body ?? {});
    const badFile = path.join(OVERLAY, 'src', 'cards', 'user', `${ID.bad}.tsx`);
    const badRow = { status: bad.status, ok: bad.body?.ok, mentionsLine: /第\s*\d+\s*行/.test(badText), mentionsHook: /useState|记状态/.test(badText), onDisk: fsSync.existsSync(badFile), sample: badText.slice(0, 400) };
    create.violation = badRow;
    check(bad.status === 400 && bad.body?.ok === false, '违规对照：remotion 式里用 useState 必须被拒（HTTP 400）', badRow);
    check(badRow.mentionsLine, '违规对照：报错带行号（第 N 行）', badRow);
    check(badRow.mentionsHook, '违规对照：报错说的是记状态的 hook（useState）', badRow);
    check(!badRow.onDisk, '违规对照：被拒的卡没有落进改动层', badRow);
    check(JSON.stringify(userDirList()) === JSON.stringify(userDirBefore), '建卡：检出目录里一个文件都没多', userDirList().filter((n) => !userDirBefore.includes(n)));
    out.steps.create = create;
    say('create', create);
  }

  /* ---------- 3. 导出 */
  if (want('export')) {
    const ex = { runs: {}, compares: {} };
    out.steps.export = ex;
    const brief = (r) => ({ code: r.code, frames: r.frames, ms: r.ms, ranges: r.ranges });
    const single1 = await runExport('single-1', { workers: 1 });
    ex.runs.single1 = brief(single1);
    check(single1.code === 0 && single1.frames === TOTAL_FRAMES, `单路第一遍：退出码 0、共 ${TOTAL_FRAMES} 帧`, brief(single1));
    if (single1.tail) ex.runs.single1.tail = single1.tail;

    const four1 = await runExport('four-1', { workers: 4 });
    ex.runs.four1 = brief(four1);
    check(four1.code === 0 && four1.frames === TOTAL_FRAMES, `4 路第一遍：退出码 0、共 ${TOTAL_FRAMES} 帧`, brief(four1));
    if (four1.tail) ex.runs.four1.tail = four1.tail;

    // 切口：每个分片的起点（除第 0 个）。要求 4 路 4 段，且每张用户卡的片段中间至少落一个切口，punch-pill（motion 式）不被切
    const ranges = four1.ranges ?? [];
    const cuts = ranges.slice(1).map((r) => r[0]);
    ex.cuts = cuts;
    ex.plan = ranges;
    check(ranges.length === 4, '4 路：分片计划是 4 段', ranges);
    const pillSpan = spanOf('clip-pill');
    for (const id of USER_CLIPS) {
      const [first, last] = spanOf(id);
      const inside = cuts.filter((c) => c > first && c <= last);
      ex[`cutsIn_${id}`] = inside;
      check(inside.length >= 1, `4 路：切口落在 ${id} 的片段中间（片段 ${first}～${last}）`, { cuts, span: [first, last] });
    }
    check(cuts.every((c) => !(c > pillSpan[0] + 1 && c <= pillSpan[1])), '4 路：motion 式的 punch-pill 片段中间没有切口', { cuts, span: pillSpan });

    if (single1.code === 0 && four1.code === 0) {
      ex.compares.single1VsFour1 = await compareExports(single1, four1);
      const c = ex.compares.single1VsFour1;
      check(c.compared === TOTAL_FRAMES && c.pixelsDiffer === 0, '单路对 4 路：每一帧像素相同', c);
      if (c.bytesOnly) say('note', { note: '单路对 4 路有帧字节不同但像素相同', bytesOnly: c.bytesOnly });
    }

    // 抽帧：各卡首帧、切口前一帧 / 切口 / 切口后一帧、两张卡片段里的几帧、末帧
    const picks = new Set([0, 269]);
    for (const id of [...USER_CLIPS, 'clip-pill']) { const [f, l] = spanOf(id); picks.add(f); picks.add(f + 20); picks.add(Math.floor((f + l) / 2)); picks.add(l); }
    for (const c of cuts) { picks.add(c - 1); picks.add(c); picks.add(c + 1); }
    const targets = [...picks].filter((n) => n >= 0 && n < TOTAL_FRAMES).sort((a, b) => a - b);
    ex.targets = targets;
    const target1 = await runExport('target-1', { workers: 1, targetFrames: targets });
    ex.runs.target1 = brief(target1);
    check(target1.code === 0 && target1.frames === targets.length, `抽帧：退出码 0、共 ${targets.length} 帧`, brief(target1));
    if (target1.tail) ex.runs.target1.tail = target1.tail;
    const targetNames = targets.map((n) => `${String(n).padStart(6, '0')}.png`);
    if (single1.code === 0 && target1.code === 0) {
      ex.compares.single1VsTarget = await compareExports(single1, target1, targetNames.filter((n) => target1.names.includes(n)));
      const c = ex.compares.single1VsTarget;
      check(c.compared === targets.length && c.pixelsDiffer === 0, '单路对抽帧：抽出来的每一帧像素相同', c);
    }

    // 同一路连导两遍
    const single2 = await runExport('single-2', { workers: 1 });
    ex.runs.single2 = brief(single2);
    check(single2.code === 0 && single2.frames === TOTAL_FRAMES, '单路第二遍：退出码 0、帧数对', brief(single2));
    if (single1.code === 0 && single2.code === 0) {
      ex.compares.single1VsSingle2 = await compareExports(single1, single2);
      const c = ex.compares.single1VsSingle2;
      check(c.compared === TOTAL_FRAMES && c.pixelsDiffer === 0, '单路连导两遍：每一帧像素相同', c);
    }
    const four2 = await runExport('four-2', { workers: 4 });
    ex.runs.four2 = brief(four2);
    check(four2.code === 0 && four2.frames === TOTAL_FRAMES, '4 路第二遍：退出码 0、帧数对', brief(four2));
    check(JSON.stringify(four2.ranges) === JSON.stringify(four1.ranges), '4 路两遍的分片计划相同', [four1.ranges, four2.ranges]);
    if (four1.code === 0 && four2.code === 0) {
      ex.compares.four1VsFour2 = await compareExports(four1, four2);
      const c = ex.compares.four1VsFour2;
      check(c.compared === TOTAL_FRAMES && c.pixelsDiffer === 0, '4 路连导两遍：每一帧像素相同', c);
    }

    // 不空洞：用户卡片段里每一帧都有内容，不同时刻的画面不同
    if (single1.code === 0) {
      ex.content = {};
      for (const id of USER_CLIPS) {
        const [first, last] = spanOf(id);
        const inks = [];
        const sample = [];
        for (let n = first + 2; n <= last - 2; n += 6) {
          const buf = await fs.readFile(path.join(single1.dir, `${String(n).padStart(6, '0')}.png`));
          inks.push(inkPixels(buf));
          sample.push({ n, buf });
        }
        let moving = 0;
        for (let i = 1; i < sample.length; i++) moving = Math.max(moving, diffPixels(sample[i - 1].buf, sample[i].buf));
        ex.content[id] = { framesChecked: inks.length, inkMin: Math.min(...inks), inkMax: Math.max(...inks), maxStepDiff: moving };
        check(inks.length >= 4 && Math.min(...inks) > 0, `${id}：片段里抽查的每一帧都有内容（不透明像素 > 0）`, ex.content[id]);
        check(moving > 300, `${id}：相邻抽查帧的画面不同（动起来了）`, ex.content[id]);
        const mid = Math.floor((first + last) / 2);
        await fs.copyFile(path.join(single1.dir, `${String(mid).padStart(6, '0')}.png`), path.join(SHOTS, `export-${id}-f${mid}.png`));
      }
      // 空白处：第 0 帧（谁都不在场）没有内容——证明上面的「有内容」不是整张都是脏的
      const blank = await fs.readFile(path.join(single1.dir, '000000.png'));
      ex.content.frame0Ink = inkPixels(blank);
      check(ex.content.frame0Ink === 0, '第 0 帧（没有卡在场）是透明的', ex.content.frame0Ink);
      // 对照卡也出画面
      const [pf, pl] = spanOf('clip-pill');
      const pillBuf = await fs.readFile(path.join(single1.dir, `${String(Math.floor((pf + pl) / 2)).padStart(6, '0')}.png`));
      ex.content.pillInk = inkPixels(pillBuf);
      check(ex.content.pillInk > 0, 'punch-pill（对照）片段里有内容', ex.content.pillInk);
    }
    // 留下单路的几帧给人看
    if (single1.code === 0) for (const n of [60, 120, 200]) await fs.copyFile(path.join(single1.dir, `${String(n).padStart(6, '0')}.png`), path.join(SHOTS, `export-single-f${n}.png`)).catch(() => {});
    out.exportDir = KEEP ? WORK : undefined;
    say('export-done', { compares: ex.compares });
  }

  /* ---------- 4. 预渲染 */
  if (want('prerender')) {
    const pr = { streams: {}, regen: {}, compare: [] };
    out.steps.prerender = pr;
    const PIPE_ROOT = path.join(WORK, 'pipeline');
    await fs.mkdir(PIPE_ROOT, { recursive: true });
    pipeline = new FramePipeline({ root: PIPE_ROOT, origin: () => origin, interactive: true, playhead: () => null });
    pipeline.streamPicked = () => true; // 钉成重卡：remotion 式的卡声明上是轻卡，不钉就没有流
    const producer = pipeline.streamProducer();
    producer.attachRoute();
    const dense = () => {
      const status = producer.status();
      if (!status.streams.length) return null;
      for (const s of status.streams) for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
      return !producer.workers.size && !producer.encoding.size ? status : null;
    };
    const until = async (label, fn, timeoutMs, everyMs = 500) => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        let v = null;
        try { v = await fn(); } catch { v = null; }
        if (v) return v;
        if (Date.now() > deadline) { check(false, `超时：${label}`); return null; }
        await sleep(everyMs);
      }
    };
    /*
     * 审阅表（`src/cards/capabilities.json`）里没有登记的卡，`compositing` 一律是 unknown，按下层依赖卡处理、不进单卡流
     * （`docs/semantics/mechanism/cards.md`「分类以审阅表为准」第 44 行）；用户卡永远不在审阅表里。所以**照默认**，两张用户卡判重时各有一条
     * 依赖下层的流（`kind: below`，按舞台坐标），没有单卡流。
     * 第 4a 步记下这个事实（用没改过的计划算一遍 `planStreams`）；第 4b 步在**本进程里**把这两张卡的计划能力改成 independent
     * （等于「审阅表登记了它们」），验这种卡的流产出来以后不回放、与回放着产逐帧相同。改的只是探针进程里的内存，产品代码一个字不动。
     */
    let unpatched = null;
    const originalPlan = pipeline.browserCardPlan.bind(pipeline);
    pipeline.browserCardPlan = async (b) => {
      const value = await originalPlan(b);
      if (!value) return value;
      unpatched = structuredClone(value);
      const graph = value.graph || value;
      if (!DEFAULT_REVIEW) for (const o of graph.outputs ?? []) if (USER_CLIPS.includes(o.clipId)) o.capabilities = { ...(o.capabilities ?? {}), compositing: 'independent', independentCache: true };
      return value;
    };
    const ALL = [...USER_CLIPS, 'clip-pill'];
    const t0 = Date.now();
    const entry = await pipeline.preload(PROJECT);
    const ready = await until('生产者起来、三条流到位', () => (pipeline._streams?.streams.size >= 3 ? pipeline._streams : null), 1_800_000);
    if (!ready) throw new Error('生产者没起来');
    // 4a：默认行为——没改过的计划
    {
      const controls = entry.cardCache.plan(unpatched);
      const compOf = (id) => controls.find((c) => c.clipId === id)?.compositing ?? null;
      const specs = planStreams({ project: entry.project, cardPlan: controls }, { picked: () => true, envFingerprint: controls[0]?.envFingerprint, codeVersion: '' });
      pr.defaultBehavior = {
        compositing: Object.fromEntries(ALL.map((id) => [id, compOf(id)])),
        streamClips: specs.map((s) => s.clipIds.join('+')),
        streams: specs.map((s) => ({ clip: s.clipIds.join('+'), kind: s.kind, plane: s.plane, replay: s.replay, belowClipIds: s.belowClipIds ?? null })),
        note: '审阅表没登记的卡 compositing 为 unknown，按下层依赖卡处理：不进单卡流，判重时走依赖下层的流（mechanism/cards.md「分类以审阅表为准」）；用户卡永远不在审阅表里',
      };
      const kindOf = (id) => specs.filter((s) => s.clipIds.includes(id)).map((s) => `${s.kind}/${s.plane}`);
      check(compOf('clip-title') === 'unknown' && compOf('clip-colors') === 'unknown', '默认行为：用框架写的用户卡在计划里 compositing 是 unknown（审阅表没登记）', pr.defaultBehavior.compositing);
      check(compOf('clip-pill') === 'independent', '默认行为：内置的 punch-pill 是 independent', pr.defaultBehavior.compositing);
      check(USER_CLIPS.every((id) => kindOf(id).length === 1 && kindOf(id)[0] === 'below/stage'),
        '默认行为：用户卡判重时各有一条依赖下层的流（按舞台坐标），没有单卡流', pr.defaultBehavior.streams);
      check(kindOf('clip-pill').length === 1 && kindOf('clip-pill')[0] === 'card/local', '默认行为：punch-pill 有单卡流', pr.defaultBehavior.streams);
      // remotion 式的目标卡自己不用回放；要不要回放看它和它下面的卡里有没有 motion 式的：
      // fw-title 下面只有 fw-colors（remotion 式）→ 不回放；fw-colors 下面是 punch-pill（motion 式，时间上有重叠）→ 要回放
      const specOf = (id) => specs.find((s) => s.clipIds.includes(id));
      check(specOf('clip-title')?.replay === false && JSON.stringify(specOf('clip-title')?.belowClipIds) === JSON.stringify(['clip-colors']),
        '默认行为：fw-title 的流不回放（它和它的下层 fw-colors 都是 remotion 式）', pr.defaultBehavior.streams);
      check(specOf('clip-colors')?.replay === true && JSON.stringify(specOf('clip-colors')?.belowClipIds) === JSON.stringify(['clip-pill']),
        '默认行为：fw-colors 的流要回放（它下面压着 motion 式的 punch-pill）', pr.defaultBehavior.streams);
    }
    if (DEFAULT_REVIEW) {
      pr.defaultOnly = true;
      pr.msToFirstStream = Date.now() - t0;
      // 等到每条流要么全部满密度,要么被差分取层的自检判死(`below.failed`:这条流不再产,这张卡照没有流时那样兜底)
      const settledAll = () => {
        const status = producer.status();
        if (status.streams.length < 3 || producer.workers.size || producer.encoding.size) return null;
        for (const s of status.streams) {
          if (s.below?.failed) continue;
          for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
        }
        return status;
      };
      const all = await until('默认就有的三条流产完(或被自检判死)', settledAll, 420_000, 1000);
      if (!all) {
        // 没产完:留下每条流此刻的样子(哪几段还没满密度、差分取层有没有判死、生产者最近的日志),好查原因
        const st = producer.status();
        pr.defaultStuck = { streams: st.streams.map((s) => ({ clipIds: s.clipIds, kind: s.kind, strides: Array.from({ length: s.lastSegment + 1 }, (_, n) => s.segments[n]?.stride ?? 0), below: s.below ?? null })), log: (st.log ?? []).slice(-12) };
        say('default-stuck', pr.defaultStuck);
      }
      pr.msToPillDense = Date.now() - t0;
      check(!!all, '默认行为：三条流产完');
      if (all) {
        pr.defaultStreams = all.streams.map((s) => ({ clipIds: s.clipIds, kind: s.kind, replay: s.replay, replayedFrames: s.replayedFrames, below: s.below ? { failed: s.below.failed ?? null, frames: s.below.frames, checks: s.below.checks } : null }));
        const rowOfClip = (id) => all.streams.find((s) => s.kind === 'below' && s.clipIds[0] === id);
        check(all.streams.length === 3 && !!rowOfClip('clip-title') && !rowOfClip('clip-title').below?.failed,
          '默认行为：fw-title 的依赖下层的流真的产出来了（差分取层没有判死）', pr.defaultStreams);
        // fw-colors 下面的 punch-pill 是中途进场的 motion 式卡:这种排法查出过「推过去不画的那几拍下层的动画不往前走、流被自检判死」
        // (`frame-stream.mjs` 的 `BELOW_DISCARD_SHOT`,复现与逐帧核对在 `below-late-lower-probe.mjs`);修了以后它必须产得出来
        check(!!rowOfClip('clip-colors') && !rowOfClip('clip-colors').below?.failed, '默认行为：fw-colors 的依赖下层的流真的产出来了（差分取层没有判死）', pr.defaultStreams);
        pr.colorsStream = rowOfClip('clip-colors')?.below?.failed ? `被差分取层的自检判死:${rowOfClip('clip-colors').below.failed}` : '产出来了';
        check(all.streams.find((s) => s.clipIds[0] === 'clip-title')?.replayedFrames === 0, '默认行为：fw-title 的流回放 0 帧', pr.defaultStreams);
      }
      out.steps.prerender = pr;
      throw Object.assign(new Error('default-review-done'), { done: true });
    }
    const first = await until('全部分段满密度', dense, 1_800_000, 1000);
    if (!first) throw new Error('第一轮生产没做完');
    pr.produceMs = Date.now() - t0;
    pr.encoder = first.encoder;
    const stateOf = (clipId) => [...producer.streams.values()].find((s) => s.spec.clipIds.length === 1 && s.spec.clipIds[0] === clipId);
    const rowOf = (status, clipId) => status.streams.find((s) => s.clipIds.length === 1 && s.clipIds[0] === clipId);
    check(producer.streams.size === 3, '预渲染：三条流（两张用户卡一张对照卡各一条）', producer.streams.size);
    for (const clipId of ALL) {
      const row = rowOf(first, clipId);
      const wantReplay = clipId === 'clip-pill';
      check(!!row, `${clipId}：有轨道流`);
      if (!row) continue;
      pr.streams[clipId] = { replay: row.replay, replayedFrames: row.replayedFrames, resets: row.resets, firstSegment: row.firstSegment, lastSegment: row.lastSegment, segments: row.lastSegment - row.firstSegment + 1 };
      check(row.replay === wantReplay, `${clipId}：流的 replay 应当是 ${wantReplay}`, row.replay);
      if (!wantReplay) check(row.replayedFrames === 0, `${clipId}：第一轮产完 replayedFrames 为 0`, row.replayedFrames);
    }
    say('first-round', pr.streams);

    // 中间两个分段作废再产：每段都断租约
    const regenOf = (row) => {
      const s = row.firstSegment, e = row.lastSegment;
      const picks = [e - 1, s + 1];
      return picks[0] - picks[1] >= 2 ? picks : [s + 1];
    };
    const before = {};
    const regenPlan = {};
    for (const clipId of ALL) {
      const r = rowOf(producer.status(), clipId);
      before[clipId] = { replayedFrames: r.replayedFrames, resets: (r.resets?.sparse ?? 0) + (r.resets?.dense ?? 0) };
      regenPlan[clipId] = regenOf(r);
      for (const n of regenPlan[clipId]) delete stateOf(clipId).manifest.segments[n];
    }
    producer.kick();
    const second = await until('作废的分段重新产完', () => {
      const status = dense();
      return status && ALL.every((id) => regenPlan[id].every((n) => rowOf(status, id).segments[n]?.stride === 1)) ? status : null;
    }, 900_000, 1000);
    if (!second) throw new Error('第二轮生产没做完');
    for (const clipId of ALL) {
      const row = rowOf(second, clipId);
      const delta = row.replayedFrames - before[clipId].replayedFrames;
      const resetsDelta = (row.resets?.sparse ?? 0) + (row.resets?.dense ?? 0) - before[clipId].resets;
      pr.regen[clipId] = { segments: regenPlan[clipId], replayedFramesDelta: delta, resetsDelta };
      check(resetsDelta >= regenPlan[clipId].length, `${clipId}：作废的 ${regenPlan[clipId].length} 段都断了租约`, resetsDelta);
      if (clipId === 'clip-pill') check(delta > 0, `${clipId}（motion 式）：断租约重产照旧从挂载帧回放`, delta);
      else check(delta === 0 && row.replayedFrames === 0, `${clipId}（remotion 式）：断租约重产以后 replayedFrames 仍是 0`, { delta, total: row.replayedFrames });
    }
    say('regen', pr.regen);

    // 逐帧比：A 路（不回放）对 B 路（从挂载帧回放着产）
    const lease = await pipeline.leaseStreamBakery();
    const cmpDir = path.join(WORK, 'cmp');
    await fs.mkdir(cmpDir, { recursive: true });
    const decodeSegment = async (init, seg, name) => {
      const file = path.join(cmpDir, `${name}.mp4`);
      await fs.writeFile(file, Buffer.concat([init, seg]));
      const { stdout } = await execFileAsync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'],
        { encoding: 'buffer', maxBuffer: 1 << 30, windowsHide: true });
      return stdout;
    };
    let pillDiffSum = 0;
    try {
      for (const clipId of ALL) {
        const state = stateOf(clipId);
        const { spec, manifest } = state;
        const rect = manifest.tight ?? manifest.bound;
        const clip = { x: rect.x + spec.offset.x, y: rect.y + spec.offset.y, w: rect.w, h: rect.h };
        const s = pr.streams[clipId].firstSegment, e = pr.streams[clipId].lastSegment;
        // 开头（动画在跑）、开头之后第三段（接近落定）、中间、倒数第二段（落定以后）；每条流五段以内
        const segs = [...new Set([s, s + 1, s + 3, Math.floor((s + e) / 2), e - 1])].filter((n) => n >= s && n <= e);
        const shoot = async (segment, replay) => {
          // 分段从这条流自己的第一帧起数(`streamSegments.mjs`),不是项目帧号 × 15
          const fromFrame = streamSegmentFirstFrame(segment, spec.originFrame), toFrame = streamSegmentLastFrame(segment, spec.originFrame, spec.lastFrame);
          await lease.reset(state.isolated, pipeline.emptyUrl(state.isolated), { deferCards: true });
          lease.streamLease = null;
          const pngs = [];
          const stats = await bakeStream(lease, {
            streamSignature: `${spec.streamKey}:${replay ? 'replay' : 'direct'}`, fromFrame, toFrame, stride: 1, fps: spec.fps,
            ...(replay ? { mountFrame: spec.mountFrame } : { warm: 0 }), clip, hasMedia: false,
            onFrame: async (_f, png) => { pngs.push(png); },
          });
          lease.streamLease = null;
          return { pngs, stats };
        };
        for (const segment of segs) {
          const direct = await shoot(segment, false); // A 路
          const replay = await shoot(segment, true); // B 路
          check(direct.stats.replayed === 0, `${clipId}#${segment}：A 路 bakeStream 的 replayed 为 0`, direct.stats.replayed);
          check(direct.pngs.length === replay.pngs.length && direct.pngs.length > 0, `${clipId}#${segment}：两路帧数相同`, [direct.pngs.length, replay.pngs.length]);
          const diffs = direct.pngs.map((png, i) => diffPixels(png, replay.pngs[i]));
          const ink = replay.pngs.map(inkPixels);
          const rec = { clipId, segment, mode: clipId === 'clip-pill' ? 'motion 式(对照)' : 'remotion 式', frames: direct.pngs.length, replayedB: replay.stats.replayed,
            diffPixelsMax: Math.max(...diffs), diffPixelsSum: diffs.reduce((a, b) => a + Math.max(0, b), 0), inkMin: Math.min(...ink), inkMax: Math.max(...ink) };
          pr.compare.push(rec);
          say('compare', rec);
          if (clipId !== 'clip-pill') {
            check(rec.diffPixelsMax === 0, `${clipId}#${segment}：不回放直接产和回放着产逐帧相同（像素）`, diffs);
            check(rec.inkMax > 0, `${clipId}#${segment}：画面不是空的`, ink);
            // 分段起点不在挂载帧之后（挂载帧就在这一段里）时，回放着产也没有可回放的帧
            if (spec.mountFrame < streamSegmentFirstFrame(segment, spec.originFrame)) check(replay.stats.replayed > 0, `${clipId}#${segment}：B 路确实回放了（replayed > 0；挂载帧 ${spec.mountFrame}）`, replay.stats.replayed);
            else check(replay.stats.replayed === 0, `${clipId}#${segment}：挂载帧 ${spec.mountFrame} 就在这一段里，B 路没有可回放的帧`, replay.stats.replayed);
            await fs.writeFile(path.join(SHOTS, `stream-${clipId}-seg${segment}-A-direct.png`), direct.pngs[Math.min(7, direct.pngs.length - 1)]);
            await fs.writeFile(path.join(SHOTS, `stream-${clipId}-seg${segment}-B-replay.png`), replay.pngs[Math.min(7, replay.pngs.length - 1)]);
            // 流库里 runSegment（不回放）产出的这一段，对 B 路 PNG 用同一个编码器编出来的
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
              const a = await decodeSegment(storedInit, stored, `stored-${clipId}-${segment}`);
              const b = await decodeSegment(refInit, refSegs[0], `ref-${clipId}-${segment}`);
              sameDecoded = Buffer.compare(a, b) === 0;
            }
            const row = { clipId, segment, kind: 'stream-vs-replay-encode', storedBytes: stored.length, refBytes: refSegs[0].length, sameBytes, sameDecoded, storedStride: seg.stride };
            pr.compare.push(row);
            check(seg.stride === 1, `${clipId}#${segment}：流库里这一段是满密度`, seg.stride);
            check(sameBytes || sameDecoded === true, `${clipId}#${segment}：流库里不回放产出的分段和回放着产的编码结果相同（字节或解码像素）`, row);
          } else {
            pillDiffSum += rec.diffPixelsSum;
          }
        }
      }
      check(pillDiffSum > 0, '对照：punch-pill（motion 式）不回放必须比出差别（这套比法测得出「该回放而没回放」）', pillDiffSum);
    } finally { pipeline.returnStreamBakery(lease); }
    const fin = producer.status();
    pr.final = fin.streams.map((s) => ({ clipIds: s.clipIds, replay: s.replay, replayedFrames: s.replayedFrames, resets: s.resets }));
    check(USER_CLIPS.every((id) => rowOf(fin, id).replayedFrames === 0), '两张用户卡的流 replayedFrames 恒为 0（收尾再看一次）');
    out.steps.prerender = pr;
  }

  /* ---------- 5. 预览对导出 */
  if (want('preview')) {
    const pv = { points: [], compare: [] };
    out.steps.preview = pv;
    const SEQUENCE = [45, 80, 110, 135, 80, 45, 200, 160, 120, 140]; // 前进、往回、同一帧到达两次
    const ed = await openEditorPage(origin, { viewport: { width: 2560, height: 1600 } });
    editorPage = ed;
    const { page, store, frontFrame, parentDiag } = ed;
    const loaded = await store(`actions.loadProject(args[0]); actions.select([]); actions.pause(); actions.seek(0); return getState().project.tracks.map(t => t.clips.map(c => c.id))`, PROJECT);
    check(JSON.stringify(loaded) === JSON.stringify(PROJECT.tracks.map((t) => t.clips.map((c) => c.id))), '预览：项目载进了编辑器', loaded);
    await sleep(1500);

    const stateAndDom = async (frame, ids) => {
      const f = await frontFrame();
      if (!f) return null;
      return f.evaluate((ids2) => {
        const cardDom = (wrap) => { const c = wrap.cloneNode(true); c.querySelectorAll('[data-pc-placeholder-slot],[data-pc-snapshot-plane],[data-pc-stream-plane],[data-pc-proxy-plane]').forEach((n) => n.remove()); return c.innerHTML; };
        const d = window.__pcStageDiag?.();
        if (!d) return null;
        return {
          role: d.role, t: d.t, catchUps: d.catchUps.length,
          clips: Object.fromEntries(ids2.map((id) => {
            const wrap = document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]:not([data-pc-media])`);
            return [id, wrap ? {
              cls: wrap.className, html: cardDom(wrap), local: wrap.getAttribute('data-pc-local-frame'),
              settling: d.settling.includes(id), suppressed: d.suppressed.includes(id), awaiting: d.awaiting.includes(id), snapshot: d.snapshots.includes(id),
            } : null];
          })),
        };
      }, ids).catch(() => null);
    };
    const ALL_IDS = ['clip-title', 'clip-colors', 'clip-pill'];
    /** 点到第 frame 帧，等回到精确活渲、画面连着三次采样相同；回这一刻各张卡的 DOM */
    const arrive = async (frame, label) => {
      const sec = frame / FPS;
      const started = Date.now();
      await store('actions.pause(); actions.seek(args[0]);', sec);
      const settled = async () => {
        const pd = await parentDiag();
        if (!pd || pd.swapInFlight) return null;
        const last = pd.setTimeLog?.[pd.setTimeLog.length - 1];
        if (!last || Math.abs(last.sec - sec) > 1e-6 || !last.settle) return null;
        const s = await stateAndDom(frame, ALL_IDS);
        if (!s || s.role !== 'front' || Math.abs(s.t - sec) > 1e-6 || s.catchUps) return null;
        for (const c of Object.values(s.clips)) {
          if (!c) continue;
          if (c.settling || c.suppressed || c.awaiting || c.snapshot) return null;
          if (/pc-(settling|suppressed|awaiting|snapshot)/.test(c.cls ?? '')) return null;
        }
        return { s, frontId: pd.frontId };
      };
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        const a = await settled();
        if (!a) { await sleep(50); continue; }
        await sleep(150);
        const b = await stateAndDom(frame, ALL_IDS);
        await sleep(250);
        const c = await stateAndDom(frame, ALL_IDS);
        const z = await settled();
        const same = (x, y) => JSON.stringify(Object.values(x?.clips ?? {}).map((k) => k?.html ?? null)) === JSON.stringify(Object.values(y?.clips ?? {}).map((k) => k?.html ?? null));
        if (!z || z.frontId !== a.frontId || !same(a.s, b) || !same(b, c)) continue;
        // 可见舞台截图留一张看（缩放过的，叠在主题底上）
        const shot = async () => {
          const handle = await page.$(`iframe[src*="stage=1"][src*="id=${z.frontId}"]`);
          return handle ? Buffer.from(await handle.screenshot({ type: 'png' })) : null;
        };
        const png = await shot().catch(() => null);
        return { frame, label, ms: Date.now() - started, frontId: z.frontId, dom: Object.fromEntries(Object.entries(z.s.clips).map(([id, k]) => [id, k ? k.html : null])), local: Object.fromEntries(Object.entries(z.s.clips).map(([id, k]) => [id, k ? k.local : null])), shot: png };
      }
      check(false, `预览：第 ${frame} 帧（${label}）没有回到精确活渲、画面稳不下来`, { states: await stateAndDom(frame, ALL_IDS).then((s) => s && { t: s.t, clips: Object.fromEntries(Object.entries(s.clips).map(([k, v]) => [k, v && { cls: v.cls }])) }) });
      return null;
    };
    const arrived = [];
    for (const [i, frame] of SEQUENCE.entries()) {
      const r = await arrive(frame, `p${i}`);
      if (!r) continue;
      arrived.push(r);
      pv.points.push({ label: r.label, frame, ms: r.ms, present: Object.fromEntries(Object.entries(r.dom).map(([id, h]) => [id, h ? h.length : null])) });
      if (r.shot) await fs.writeFile(path.join(SHOTS, `preview-f${String(frame).padStart(3, '0')}-${r.label}.png`), r.shot);
    }
    say('preview-arrived', pv.points);
    check(arrived.length === SEQUENCE.length, `预览：十个时刻都回到了精确活渲`, arrived.length);

    // 导出一侧：同一个项目走导出的 bakeFrames，每一帧截完后取同一批卡的 DOM
    const frames = [...new Set(SEQUENCE)].sort((a, b) => a - b);
    bakery = await openBakery({ url: exportUrlOf(origin, PROJECT) });
    const exportDom = new Map();
    const exportPng = new Map();
    await bakeFrames(bakery, {
      out: path.join(WORK, 'preview-bake'), fps: FPS, fullFrame: true, targetFrames: frames, writeFrames: false, quiet: true, onProgressLog: false, staticSkip: false,
      onFrame: async (n, buf) => {
        exportPng.set(n, buf);
        exportDom.set(n, await bakery.page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
          const wrap = document.querySelector(`[data-pc-clip="${CSS.escape(id)}"]:not([data-pc-media])`);
          if (!wrap) return [id, null];
          const c = wrap.cloneNode(true);
          c.querySelectorAll('[data-pc-placeholder-slot],[data-pc-snapshot-plane],[data-pc-stream-plane],[data-pc-proxy-plane]').forEach((n) => n.remove());
          return [id, c.innerHTML];
        })), ALL_IDS));
      },
    });
    pv.exportFrames = [...exportDom.keys()];
    check(exportDom.size === frames.length, `导出一侧：${frames.length} 个时刻都取到了 DOM`, [...exportDom.keys()]);
    // 导出页这一趟截出来的帧，和第 3 步整片导出的同一帧也比一下（证明这条取 DOM 的路走的就是导出的路）
    // （第 3 步没跑时跳过）

    const spanIn = (id, n) => { const [f, l] = spanOf(id); return n >= f && n <= l; };
    for (const r of arrived) {
      const exp = exportDom.get(r.frame);
      for (const id of USER_CLIPS) {
        const present = spanIn(id, r.frame);
        const pre = r.dom[id];
        const post = exp?.[id] ?? null;
        if (!present) { pv.compare.push({ frame: r.frame, label: r.label, clipId: id, present: false, preview: pre === null, export: post === null }); continue; }
        const same = pre !== null && post !== null && pre === post;
        pv.compare.push({ frame: r.frame, label: r.label, clipId: id, present: true, previewLen: pre?.length ?? null, exportLen: post?.length ?? null, same });
        check(pre !== null && pre.length > 0, `预览 ${r.label}（第 ${r.frame} 帧）：${id} 在场且 DOM 不空`, { previewLen: pre?.length ?? null });
        check(post !== null && post.length > 0, `导出 第 ${r.frame} 帧：${id} 在场且 DOM 不空`, { exportLen: post?.length ?? null });
        if (!same && pre && post) {
          let k = 0;
          while (k < pre.length && k < post.length && pre[k] === post[k]) k++;
          check(false, `预览 ${r.label}（第 ${r.frame} 帧）与导出同一帧：${id} 的 DOM 逐字符相同`, { firstDiffAt: k, preview: pre.slice(Math.max(0, k - 80), k + 120), export: post.slice(Math.max(0, k - 80), k + 120) });
        }
      }
    }
    // 往回点 / 同一帧两次到达
    const byFrame = new Map();
    for (const r of arrived) { if (!byFrame.has(r.frame)) byFrame.set(r.frame, []); byFrame.get(r.frame).push(r); }
    for (const [frame, list] of byFrame) {
      if (list.length < 2) continue;
      for (const id of USER_CLIPS) {
        if (!spanIn(id, frame)) continue;
        const same = list.every((r) => r.dom[id] === list[0].dom[id]);
        pv.compare.push({ frame, clipId: id, reached: list.map((r) => r.label), sameAcrossArrivals: same });
        check(same, `预览：第 ${frame} 帧两次到达（${list.map((r) => r.label).join('、')}，含往回点）${id} 的 DOM 相同`, list.map((r) => r.dom[id]?.length));
      }
    }
    // 对照：不同的帧 DOM 不同
    const a45 = arrived.find((r) => r.frame === 45), a80 = arrived.find((r) => r.frame === 80);
    if (a45 && a80) {
      pv.control = { title45vs80: a45.dom['clip-title'] !== a80.dom['clip-title'], len45: a45.dom['clip-title']?.length, len80: a80.dom['clip-title']?.length };
      check(pv.control.title45vs80, '对照：第 45 帧与第 80 帧 fw-title 的 DOM 不同（这把尺子量得出变化）', pv.control);
    }
    const a120 = arrived.find((r) => r.frame === 120), a140 = arrived.find((r) => r.frame === 140);
    if (a120 && a140) {
      const ctl = a120.dom['clip-colors'] !== a140.dom['clip-colors'];
      pv.control2 = { colors120vs140: ctl };
      check(ctl, '对照：第 120 帧与第 140 帧 fw-colors 的 DOM 不同', pv.control2);
    }
    // 留两张导出页这一趟的图
    for (const n of [80, 160]) if (exportPng.get(n)) await fs.writeFile(path.join(SHOTS, `export-bakery-f${n}.png`), exportPng.get(n));
  }
} catch (error) {
  if (error?.done) say('default-review-done', {}); // --default-review：做完 4a 主动收尾，不是异常
  else {
    check(false, `异常：${String(error?.stack || error).slice(0, 1500)}`);
    say('ERROR', { error: String(error?.stack || error) });
  }
} finally {
  try { await bakery?.close(); } catch { /* 已经关了 */ }
  try { await editorPage?.browser?.close(); } catch { /* 已经关了 */ }
  try { await pipeline?.close(); } catch { /* ignore */ }
  try { editor?.stop(); } catch { /* ignore */ }
  await sleep(800);
  if (KEEP) say('kept', { work: WORK });
  else { try { fsSync.rmSync(WORK, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* 留给系统清 */ } }
}
const userDirNow = userDirList();
if (JSON.stringify(userDirNow) !== JSON.stringify(userDirBefore)) { fails.push('检出目录 src/cards/user 多了文件：' + userDirNow.filter((n) => !userDirBefore.includes(n)).join(',')); }
out.fails = fails;
out.ok = fails.length === 0;
try { await fs.writeFile(path.join(OUT, 'result.json'), JSON.stringify(out, null, 2)); } catch { /* ignore */ }
if (JSON_OUT) await fs.writeFile(JSON_OUT, JSON.stringify(out, null, 2));
done(out.ok ? 0 : 1, out);
