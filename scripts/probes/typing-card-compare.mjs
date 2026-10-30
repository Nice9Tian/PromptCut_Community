/**
 * 打字动画卡(mu-typing)与打字机部件(text-typing)的改前改后逐帧比对。
 *
 * 背景:0.5 期声音把 `src/cards/magicui/typing-animation.card.tsx`、`vendor/typing-animation.tsx` 重写成「按字素事件表、
 * 舞台传 t 时按 t 取字」。像素基线的演示项目里没有这张卡,全量比对测不到它,所以单独比。
 *
 *   node scripts/probes/typing-card-compare.mjs --main <main 的 worktree> [--out <目录>] [--port 5714] [--passes 2] [--reuse]
 *
 * 做法:同一份项目 JSON(下面的用例各占一段时间轴),分别用「改前」和「改后」两棵代码树的 `scripts/export-e2e.mjs`
 * 走真实导出路径(自起 dev server、逐帧截图,只有卡片层、透明底),把两边的 PNG 逐帧比像素。
 *   - 改前 = --main 给的目录(main 的提交 3da0aa0e,建议 `git worktree add --detach` 出来用完删)
 *   - 改后 = 本脚本所在的代码树
 * 每边导 --passes 趟,比对只拿最后一趟(第一趟含字体预热,见 docs/guides/compare-pitfalls.md);也报两趟之间自己和自己的差,当噪声底。
 * 一边占 3 个连号端口(编辑器 + 两个舞台):改前 --port、改后 --port+3。
 *
 * 验收标准(退出码 0 当且仅当全部成立):
 *   1. 「默认参数、普通文字」的用例(标 expect=same):改前改后逐帧逐像素相同,差异帧数 0。
 *      含:空文本、拉丁文、中文、含换行、不同的每字毫秒(含整帧边界上的 100 ms)、打字机部件(text-typing,经组合卡)。
 *   2. 「应当不同」的用例(标 expect=differs)只做报告,不判对错,由人看图解释:
 *      emoji / 组合字符 / 国旗(改前按 UTF-16 码元计时,改后按字素计时,这是用户认可的修正);
 *      带停顿等新参数(改前没有这些参数,忽略它们);片段从中间裁切(改前每次挂载从头打,改后接着打)。
 *      脚本另按文字模型逐帧推「改前该显示的字」与「改后该显示的字」,要求「文字不同的帧集合」恰好等于「像素不同的帧集合」(否则退出码 1);
 *      并为每个这样的用例列出首个差异帧,并拼「改前 | 改后 | 差异×8」三联图(只裁有差异的区域)到 <out>/sheets/。
 *   3. 两边都导出成功、帧数一致。
 *   4. **两种项目格式各跑一遍**(2026-10-07 补):上面的用例是 Project 格式(有 `tracks`,导出页经 FrameScene,卡片在片段起点才挂)。
 *      另有一组 Timeline 格式的用例(平铺 `clips`、没有 `tracks`,名字以 `tl-` 开头):导出页直接渲 Stage,卡片提前
 *      CARD_MOUNT_LEAD(30 fps 下一帧)挂载,旧打字卡从挂载那一帧起计时。默认演示项目(导出像素基线)走的就是这条路径,
 *      只测 Project 格式时漏掉过「每个字晚一帧」。含:演示项目里那一个 mu-4(6～8 秒、参数为空)、起点为 0(没有提前量)、
 *      拉丁文、中文、整帧边界、打字机部件;应当不同的有 emoji 与带源偏移的片段(Timeline 的 `sourceOffset`)。
 *      `export-e2e.mjs` 只收 Project 格式,所以这一组自己起 dev server、直接跑各棵树的 `scripts/export-frames.mjs`。
 *
 * 比对陷阱:见 docs/guides/compare-pitfalls.md。程序报不同先看图——所以脚本会把每个有差异的用例出图。
 * 不碰用户在跑的东西:端口自选(默认 5714、5717),导出目录临时;不继承 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR。
 * 输出:过程写 stdout;最后一行 JSON `{ ok, cases: [...] }`;完整结果写 <out>/result.json。
 */
import '../lib/no-user-dirs.mjs';
import '../../src/testing/registerTs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AFTER = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const BEFORE = path.resolve(arg('main', path.join(AFTER, '..', 'sound-verify-main')));
const OUT = path.resolve(arg('out', path.join(AFTER, '..', '..', 'work', 'four-stage', 'sound', 'typing-compare')));
const PORT = Number(arg('port', 5714));
const PASSES = Number(arg('passes', 2));
const REUSE = argv.includes('--reuse');
const FPS = 30, W = 1280, H = 720;
const require = createRequire(path.join(AFTER, 'package.json'));
const { PNG } = require('pngjs');

/** 用例:name、expect(same / differs)、clip 的卡与参数 */
const CASES = [
  { name: 'empty', expect: 'same', dur: 1.5, params: { text: '' } },
  { name: 'latin-default', expect: 'same', dur: 3.6, params: { text: 'Hello, PromptCut typing!' } },
  { name: 'card-default-text', expect: 'same', dur: 2.2, params: {} },
  { name: 'chinese-default', expect: 'same', dur: 2.8, params: { text: '这是一段打字机测试文字，含标点。' } },
  { name: 'multiline-default', expect: 'same', dur: 2.6, params: { text: 'Line one\nLine two' } },
  { name: 'slow-duration-200', expect: 'same', dur: 3.0, params: { text: 'Slow typing', duration: 200 } },
  { name: 'duration-100-frame-boundaries', expect: 'same', dur: 3.0, params: { text: 'Boundary at exact frames', duration: 100 } },
  { name: 'part-text-typing-default', expect: 'same', dur: 3.2, part: { text: 'Part typing, default.', size: 0, duration: 120 } },
  { name: 'part-text-typing-chinese', expect: 'same', dur: 2.6, part: { text: '部件里的中文打字。', size: 0, duration: 120 } },
  { name: 'emoji-zwj-default', expect: 'differs', dur: 3.0, params: { text: 'Hi 👩🏽‍💻🎉 ok' } },
  { name: 'combining-and-flag', expect: 'differs', dur: 3.0, params: { text: 'école 🇯🇵 été' } },
  { name: 'part-text-typing-emoji', expect: 'differs', dur: 3.0, part: { text: 'Go 👩🏽‍💻 now', size: 0, duration: 120 } },
  { name: 'pause-params', expect: 'differs', dur: 5.0, params: { text: 'Wait, what? Yes.\nOK', duration: 100, delayMs: 300, punctuationPauseMs: 400, newlinePauseMs: 300, jitterMs: 30, seed: 7, pauses: [{ afterIndex: 3, durationMs: 500 }] } },
  { name: 'crop-from-middle', expect: 'differs', dur: 3.0, mediaOffset: 0.6, params: { text: 'Cropped from the middle of typing' } },
];

/**
 * Timeline 格式的用例(平铺 clips):at 给了就钉在那个起点(演示项目的 mu-4 必须在 6～8 秒),否则接在上一个后面。
 * sourceOffset 是 Timeline 上的源偏移(Project 的 mediaOffset 经 flattenOverlay 变成它)。
 */
const TIMELINE_CASES = [
  { name: 'tl-start-at-zero', expect: 'same', at: 0, dur: 2.2, params: {} },
  { name: 'tl-latin-default', expect: 'same', dur: 3.4, params: { text: 'Hello, PromptCut typing!' } },
  { name: 'tl-demo-mu-4', expect: 'same', id: 'mu-4', at: 6, dur: 2, params: {} },
  { name: 'tl-chinese-default', expect: 'same', dur: 2.8, params: { text: '这是一段打字机测试文字，含标点。' } },
  { name: 'tl-duration-100-frame-boundaries', expect: 'same', dur: 3.0, params: { text: 'Boundary at exact frames', duration: 100 } },
  { name: 'tl-part-text-typing-default', expect: 'same', dur: 3.2, part: { text: 'Part typing, default.', size: 0, duration: 120 } },
  { name: 'tl-emoji-zwj-default', expect: 'differs', dur: 3.0, params: { text: 'Hi 👩🏽‍💻🎉 ok' } },
  { name: 'tl-crop-from-middle', expect: 'differs', dur: 3.0, sourceOffset: 0.6, params: { text: 'Cropped from the middle of typing' } },
];

async function buildTimeline() {
  const { mountFrameOf } = await import('../../src/render/frameWindow.mjs');
  const clips = [];
  const windows = [];
  let at = 0;
  TIMELINE_CASES.forEach((c, i) => {
    const from = c.at ?? at;
    if (from < at - 1e-9) throw new Error(`Timeline 用例 ${c.name} 的起点 ${from} 压到上一个用例了`);
    const start = Math.round(from * FPS) / FPS, end = Math.round((from + c.dur) * FPS) / FPS;
    const common = { id: c.id ?? `tl-${i}`, start, end };
    if (c.part) {
      clips.push({ ...common, cardId: 'composite', params: {}, parts: [{ id: `tp-${i}`, partId: 'text-typing', params: c.part, frame: { x: 200, y: 440, w: 1520, h: 200 } }] });
    } else {
      clips.push({ ...common, cardId: 'mu-typing', params: { ...c.params }, ...(c.sourceOffset ? { sourceOffset: c.sourceOffset } : {}) });
    }
    // 这条路径上卡片提前挂载,挂上那一帧就在画面里:用例的帧段从挂载帧算起(留白帧的比对不含它)
    const mountFrame = mountFrameOf({ start, end }, FPS);
    windows.push({ ...c, timeline: true, clipStartFrame: Math.round(start * FPS), mountFrame, startFrame: mountFrame, endFrame: Math.round(end * FPS) });
    at = end + 0.2;
  });
  const duration = Math.ceil(at * FPS) / FPS;
  return { project: { width: W, height: H, fps: FPS, duration, clips }, windows, frames: Math.round(duration * FPS) };
}

/** Timeline 格式:在 tree 这棵树上自起 dev server(用它自己的 scripts/lib/dev-server.mjs),跑它自己的 export-frames.mjs。帧落在 <work>/export-e2e/frames,与 export-e2e 同一个布局。 */
async function runTimelineExport(label, tree, port, timeline, work) {
  fs.mkdirSync(work, { recursive: true });
  const { startDevServer, tripleFree, sleep } = await import(pathToFileURL(path.join(tree, 'scripts', 'lib', 'dev-server.mjs')).href);
  // 上一趟的 dev server 是整棵进程树被结束的,三个连号端口要等一会儿才放出来
  const portsFree = async () => { for (let i = 0; i < 60 && !(await tripleFree(port)); i++) await sleep(500); };
  await portsFree();
  const env = { PROMPTCUT_EXPORT_DIR: work };
  let server = null;
  try {
    server = await startDevServer({ env, logFile: path.join(work, 'vite.log'), port });
    const url = `${server.origin}/?export=1&timeline=${encodeURIComponent('data:application/json,' + encodeURIComponent(JSON.stringify(timeline)))}`;
    const code = await new Promise((resolve) => {
      const log = fs.createWriteStream(path.join(work, 'export-frames.log'), { flags: 'a' });
      const child = spawn(process.execPath, [path.join(tree, 'scripts', 'export-frames.mjs'), '--url', url, '--out', path.join(work, 'export-e2e'), '--fps', String(FPS), '--workers', '1', '--no-video'],
        { cwd: tree, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      child.stdout.pipe(log, { end: false });
      child.stderr.pipe(log, { end: false });
      child.on('exit', (c) => { log.end(); resolve(c ?? 1); });
    });
    console.log(`[${label}] 退出码 ${code}`);
    return code;
  } catch (e) {
    console.log(`[${label}] 失败:${e.message}`);
    return 1;
  } finally {
    server?.stop();
    if (server) await portsFree();
  }
}

function buildProject() {
  const clips = [];
  const windows = [];
  let at = 0;
  CASES.forEach((c, i) => {
    const start = Math.round(at * FPS) / FPS, end = Math.round((at + c.dur) * FPS) / FPS;
    const common = { id: `clip-${i}`, start, end };
    if (c.part) {
      clips.push({ ...common, cardId: 'composite', params: {}, parts: [{ id: `p-${i}`, partId: 'text-typing', params: c.part, frame: { x: 200, y: 440, w: 1520, h: 200 } }] });
    } else {
      clips.push({ ...common, cardId: 'mu-typing', params: { ...c.params }, ...(c.mediaOffset ? { mediaOffset: c.mediaOffset } : {}) });
    }
    windows.push({ ...c, startFrame: Math.round(start * FPS), endFrame: Math.round(end * FPS) });
    at = end + 0.2;
  });
  const duration = Math.ceil(at * FPS) / FPS;
  return { project: { version: 1, id: 'typing-compare', name: 'typing compare', width: W, height: H, fps: FPS, duration, themeId: 'midnight', media: [], tracks: [{ id: 't-1', name: '序列 1', clips }] }, windows, frames: Math.round(duration * FPS) };
}

function runExport(label, tree, port, projectFile, work) {
  return new Promise((resolve) => {
    fs.mkdirSync(work, { recursive: true });
    const log = fs.createWriteStream(path.join(work, 'export-e2e.log'), { flags: 'a' });
    const child = spawn(process.execPath, [path.join(tree, 'scripts', 'export-e2e.mjs'), '--project', projectFile, '--work', work, '--port', String(port), '--', '--workers', '1'],
      { cwd: tree, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('exit', (code) => { log.end(); console.log(`[${label}] 退出码 ${code}`); resolve(code ?? 1); });
  });
}

const framePath = (work, f) => path.join(work, 'export-e2e', 'frames', `${String(f).padStart(6, "0")}.png`);
function listFrames(work) {
  const dir = path.join(work, 'export-e2e', 'frames');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith('.png')).sort() : [];
}
function readPng(file) { return PNG.sync.read(fs.readFileSync(file)); }
function diffPng(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { differing: -1, max: 255, box: null };
  let differing = 0, max = 0, x0 = a.width, y0 = a.height, x1 = -1, y1 = -1;
  for (let i = 0, n = a.width * a.height; i < n; i++) {
    const o = i * 4;
    let d = 0;
    for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(a.data[o + k] - b.data[o + k]));
    if (d) {
      differing++; max = Math.max(max, d);
      const x = i % a.width, y = (i / a.width) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  return { differing, max, box: differing ? [x0, y0, x1, y1] : null };
}
const frameFiles = (work) => listFrames(work);
function compareDirs(wa, wb, from, to) {
  const out = { frames: 0, diffFrames: 0, first: null, maxChannel: 0, maxPixels: 0, list: [] };
  for (let f = from; f < to; f++) {
    const pa = framePath(wa, f), pb = framePath(wb, f);
    if (!fs.existsSync(pa) || !fs.existsSync(pb)) { out.frames++; out.diffFrames++; out.list.push({ frame: f, missing: true }); out.first ??= f; continue; }
    out.frames++;
    const ba = fs.readFileSync(pa), bb = fs.readFileSync(pb);
    if (ba.equals(bb)) continue;
    const d = diffPng(PNG.sync.read(ba), PNG.sync.read(bb));
    if (!d.differing) continue; // 文件字节不同、像素全同(压缩差异)
    out.diffFrames++; out.first ??= f; out.maxChannel = Math.max(out.maxChannel, d.max); out.maxPixels = Math.max(out.maxPixels, d.differing);
    if (out.list.length < 400) out.list.push({ frame: f, pixels: d.differing, max: d.max, box: d.box });
  }
  return out;
}

/** 三联图:改前 | 改后 | 差异×8,只裁差异外框(外扩 24px),放大到 2x 以内。写成 PNG。 */
function sheet(wa, wb, f, box, file) {
  const a = readPng(framePath(wa, f)), b = readPng(framePath(wb, f));
  const pad = 24;
  const x0 = Math.max(0, box[0] - pad), y0 = Math.max(0, box[1] - pad), x1 = Math.min(a.width - 1, box[2] + pad), y1 = Math.min(a.height - 1, box[3] + pad);
  const w = x1 - x0 + 1, h = y1 - y0 + 1, gap = 8;
  const out = new PNG({ width: w * 3 + gap * 2, height: h });
  out.data.fill(60);
  const put = (src, ox, mode) => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * src.width + x0 + x) * 4, di = (y * out.width + ox + x) * 4;
      const bi = ((y0 + y) * b.width + x0 + x) * 4, ai = ((y0 + y) * a.width + x0 + x) * 4;
      if (mode === 'diff') {
        for (let k = 0; k < 3; k++) out.data[di + k] = Math.min(255, Math.abs(a.data[ai + k] - b.data[bi + k]) * 8);
        out.data[di + 3] = 255;
      } else {
        // 透明底铺深灰棋盘,文字才看得见
        const al = src.data[si + 3] / 255, bg = ((x >> 4) + (y >> 4)) & 1 ? 40 : 56;
        for (let k = 0; k < 3; k++) out.data[di + k] = Math.round(src.data[si + k] * al + bg * (1 - al));
        out.data[di + 3] = 255;
      }
    }
  };
  put(a, 0, 'img'); put(b, w + gap, 'img'); put(a, (w + gap) * 2, 'diff');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, PNG.sync.write(out));
}

/**
 * 解释差异:不靠人眼,逐帧推「改前该显示什么字」与「改后该显示什么字」,
 * 看「文字不同的帧集合」是否恰好等于「像素不同的帧集合」。
 *   改前:text.substring(0, floor(经过毫秒 / 每字毫秒)),按 UTF-16 码元,忽略一切新参数、忽略 mediaOffset(每次挂载从头打)
 *   改后:字素事件表(typingTextAt),经过毫秒 = 局部时间 + mediaOffset
 * 两边都只在「默认参数的普通文字」用例里已被像素证明与实际一致(expect=same 全 0 差异),这里把同一个模型外推到 differs 用例。
 *
 * Timeline 格式(w.timeline):卡片在 w.mountFrame 挂上(比片段起点早),两边都从挂载那一帧起计时 ——
 *   改前:同上,只是起算帧换成挂载帧,忽略 sourceOffset;
 *   改后:同一个经过毫秒(挂载钟,不加边界容差)加 sourceOffset,按字素事件表取字。
 */
async function analyticTextDiff(w) {
  const { createTypingSchedule, typingTextAt, typingScheduleOptionsFromParams } = await import('../../src/kernel/typingEvents.ts');
  const p = w.part ?? w.params;
  const text = p.text ?? '这是一段打字机测试文字', duration = p.duration ?? 120;
  const schedule = createTypingSchedule(w.part ? { text, duration } : typingScheduleOptionsFromParams({ text, ...p }));
  const frames = [];
  for (let f = w.startFrame; f < w.endFrame; f++) {
    if (w.timeline) {
      const elapsed = (f / FPS) * 1000 - (w.mountFrame / FPS) * 1000;
      const before = duration === 0 ? text : text.substring(0, Math.floor(elapsed / duration));
      const after = w.mountFrame < w.clipStartFrame
        ? typingTextAt(schedule, elapsed + (w.sourceOffset ?? 0) * 1000, 0)
        : typingTextAt(schedule, (Math.max(0, f - w.clipStartFrame) / FPS + (w.sourceOffset ?? 0)) * 1000);
      const visible = (x) => x.replace(/\s+/g, ' ').trimEnd();
      if (visible(before) !== visible(after)) frames.push(f);
      continue;
    }
    const local = ((f - w.startFrame) / FPS) * 1000;
    // 旧实现读的是被钉住的页面时钟(帧毫秒,浮点),elapsed = 当前帧毫秒 - 挂载那一帧的毫秒,整帧边界上带着自己的浮点误差,这里照样减
    const oldElapsed = (f * 1000) / FPS - (w.startFrame * 1000) / FPS;
    const oldText = duration === 0 ? text : text.substring(0, Math.floor(oldElapsed / duration));
    const newText = typingTextAt(schedule, local + (w.mediaOffset ?? 0) * 1000);
    // 排版会折叠空白、末尾空白不占位,所以「肉眼可见的文字」先按空白折叠并去掉尾部空白再比
    const seen = (x) => x.replace(/s+/g, ' ').trimEnd();
    if (seen(oldText) !== seen(newText)) frames.push(f);
  }
  return frames;
}

async function main() {
  if (!fs.existsSync(path.join(BEFORE, 'scripts', 'export-e2e.mjs'))) throw new Error(`--main 不是一棵代码树:${BEFORE}`);
  fs.mkdirSync(OUT, { recursive: true });
  const suites = [];
  {
    const built = buildProject();
    const projectFile = path.join(OUT, 'project.json');
    fs.writeFileSync(projectFile, JSON.stringify(built.project));
    suites.push({ label: 'Project 格式', prefix: '', ...built, run: (tag, tree, port, work) => runExport(tag, tree, port, projectFile, work) });
  }
  {
    const built = await buildTimeline();
    fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify(built.project));
    suites.push({ label: 'Timeline 格式', prefix: 'tl-', ...built, run: (tag, tree, port, work) => runTimelineExport(tag, tree, port, built.project, work) });
  }
  const summary = { ok: true, suites: [], cases: [] };
  for (const suite of suites) {
    const r = await compareSuite(suite);
    summary.suites.push({ label: suite.label, ...r });
    summary.cases.push(...r.cases);
    if (!r.ok) summary.ok = false;
  }
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ ok: summary.ok, cases: summary.cases.map((c) => ({ name: c.name, expect: c.expect, frames: c.frames, diffFrames: c.diffFrames })) }));
  return summary.ok ? 0 : 1;
}

async function compareSuite({ label, prefix, windows, frames, run }) {
  console.log(`—— ${label}:${frames} 帧,${windows.length} 个用例;改前 ${BEFORE};改后 ${AFTER}`);
  const works = { before: [], after: [] };
  for (let p = 1; p <= PASSES; p++) {
    for (const side of ['before', 'after']) works[side].push(path.join(OUT, `${prefix}${side}-pass${p}`));
  }
  if (!REUSE) {
    for (let p = 0; p < PASSES; p++) {
      for (const w of [works.before[p], works.after[p]]) fs.rmSync(w, { recursive: true, force: true });
      const codes = await Promise.all([
        run(`${prefix}before#${p + 1}`, BEFORE, PORT, works.before[p]),
        run(`${prefix}after#${p + 1}`, AFTER, PORT + 3, works.after[p]),
      ]);
      if (codes.some((c) => c !== 0)) throw new Error(`${label} 第 ${p + 1} 趟导出失败:退出码 ${codes.join('/')}`);
    }
  }
  const last = PASSES - 1;
  const nb = frameFiles(works.before[last]).length, na = frameFiles(works.after[last]).length;
  console.log(`帧数:改前 ${nb} 改后 ${na}(应为 ${frames})`);
  const result = { frames, frameCountBefore: nb, frameCountAfter: na, noise: {}, cases: [] };
  if (PASSES > 1) {
    result.noise.beforeSelf = compareDirs(works.before[0], works.before[last], 0, frames).diffFrames;
    result.noise.afterSelf = compareDirs(works.after[0], works.after[last], 0, frames).diffFrames;
    console.log(`两趟自己和自己:改前差 ${result.noise.beforeSelf} 帧,改后差 ${result.noise.afterSelf} 帧(含冷启动那一趟)`);
  }
  // 留白段(用例之间的 0.2 秒与片尾)也算:两边都应当是空画面
  const gaps = [];
  let prev = 0;
  for (const w of windows) { if (w.startFrame > prev) gaps.push([prev, w.startFrame]); prev = w.endFrame; }
  if (prev < frames) gaps.push([prev, frames]);
  let ok = nb === frames && na === frames;
  for (const w of windows) {
    const c = compareDirs(works.before[last], works.after[last], w.startFrame, w.endFrame);
    const row = { name: w.name, expect: w.expect, startFrame: w.startFrame, endFrame: w.endFrame, frames: c.frames, diffFrames: c.diffFrames, firstDiffFrame: c.first, maxChannelDiff: c.maxChannel, maxDiffPixels: c.maxPixels };
    if (w.expect === 'same' && c.diffFrames !== 0) ok = false;
    if (c.diffFrames && c.list.length) {
      const pick = c.list.find((x) => x.box) ?? null;
      if (pick) {
        const file = path.join(OUT, 'sheets', `${w.name}-frame${pick.frame}.png`);
        sheet(works.before[last], works.after[last], pick.frame, pick.box, file);
        row.sheet = file;
        // 差异最大的一帧也出图
        const big = c.list.filter((x) => x.box).sort((a, b) => b.pixels - a.pixels)[0];
        if (big && big.frame !== pick.frame) { const f2 = path.join(OUT, 'sheets', `${w.name}-frame${big.frame}-max.png`); sheet(works.before[last], works.after[last], big.frame, big.box, f2); row.sheetMax = f2; }
      }
      row.diffFramesList = c.list.map((x) => x.frame);
    }
    if (w.expect === 'differs') {
      const expectedFrames = await analyticTextDiff(w);
      const pixel = new Set(row.diffFramesList ?? []);
      row.analyticTextDiffFrames = expectedFrames.length;
      row.analyticMatchesPixels = expectedFrames.length === pixel.size && expectedFrames.every((x) => pixel.has(x));
      if (!row.analyticMatchesPixels) ok = false;
    }
    result.cases.push(row);
    console.log(`${w.expect === 'same' ? (c.diffFrames ? 'FAIL' : 'PASS') : 'INFO'} ${w.name} [${w.expect}] 帧 ${w.startFrame}-${w.endFrame - 1}:${c.frames} 帧,差异 ${c.diffFrames} 帧${c.first !== null ? `,首个差异帧 ${c.first},最大通道差 ${c.maxChannel}` : ''}${row.analyticMatchesPixels !== undefined ? `;按文字模型推的差异帧 ${row.analyticTextDiffFrames} 个,${row.analyticMatchesPixels ? '与像素差异的帧集合完全一致' : '与像素差异的帧集合不一致'}` : ''}`);
  }
  const gap = gaps.map(([a, b]) => compareDirs(works.before[last], works.after[last], a, b));
  result.gapDiffFrames = gap.reduce((s, g) => s + g.diffFrames, 0);
  console.log(`${result.gapDiffFrames ? 'FAIL' : 'PASS'} 用例之间的留白帧 ${gaps.reduce((s, [a, b]) => s + b - a, 0)} 帧,差异 ${result.gapDiffFrames} 帧`);
  if (result.gapDiffFrames) ok = false;
  result.ok = ok;
  return result;
}
main().then((code) => process.exit(code), (e) => { console.error(e); process.exit(1); });
