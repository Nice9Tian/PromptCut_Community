/**
 * 片段速度(`TrackClip.speed`,`src/kernel/clipTime.mjs`)的导出端到端探针:**逐帧**核变速段的画面取的是素材的哪一帧,
 * 再核变速段的原声在成片里确实不出(〔裁〕第一版变速段原声静音),音画分离出来的变速声音段在两条混音路里随倍率变调、两路对得上。
 *
 *   node scripts/probes/clip-speed-export-probe.mjs --port 5920 [--tree <检出根>] [--out <目录>] [--skip-audio]
 *
 * `--tree` 缺省是本探针所在的检出;给开工提交解出来的树(如 `out/base-5a8f375a`)就是「改之前」的对照,用的是那棵树自己的
 * 开发服务器与导出脚本。素材目录、数据目录、卡片改动层都建在 `--out` 下,检出目录一个文件都不写;开发服务器用完按进程号收掉,
 * 不写端口文件(`PROMPTCUT_NO_PORT_FILE=1`)。
 *
 * 素材:20 秒、30 帧每秒、320×180 的视频,第 N 帧整幅涂成一种颜色 —— r = 8 × (N mod 32)、g = 8 × ⌊N / 32⌋、b = 128,
 * 解码时由颜色反推 N(每档隔 8,编码误差远小于半档);另带一条 440 Hz 的正弦声。
 *
 * 项目(640×360,30 帧每秒,16 秒),主序列上一段接一段,全都铺满画面:
 *
 *   A  0～2 秒   1×     从素材第 1 秒起                      对照组(缺省 1,不写 speed)
 *   B  2～4 秒   2×     从第 0.5 秒起
 *   C  4～6 秒   0.5×   从第 3 秒起
 *   D  6～8 秒   剪辑段:引用剪辑「内」,从它的第 0.5 秒起;那条剪辑里是一段 2× 的视频,从素材第 1 秒起
 *   E  8～10 秒  4×     从第 2 秒起
 *   F  10～12 秒 0.25×  从第 5 秒起
 *   G  12～14 秒 2×     从第 6 秒起,套一张素材效果卡(反色,取帧走素材节点的 `rate`)
 *   H  14～16 秒 1×     从第 9 秒起                          对照组
 *
 * 核对:
 *   1. 画面:整段 480 帧 PNG(`--workers 1 --no-video`),每帧取画面中心解出素材帧号,和
 *      `⌊(素材时刻 + 2 ms) × 30⌋` 比(素材时刻 = mediaOffset + (t − start) × speed;导出取帧 seek 到素材时刻 + 2 ms、
 *      显示时间戳不晚于它的最后一帧)。要求 480/480 逐帧一致。
 *   2. 声音:同一项目导出成片两次 —— 缺省的 Chrome 离线混音(`src/audio/renderMix.ts`)与 `--audio ffmpeg`
 *      (`server/bakery/mux-audio.mjs`)—— 各段中间 1.4 秒的响度:A、H 有声(高于 −30 dBFS),B～G 无声(低于 −70 dBFS)。
 *
 * 输出 JSON 结论;任何一条不过以非零退出。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { PNG } from 'pngjs';

const execFileAsync = promisify(execFile);
setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 40 * 60_000).unref();

const HERE = path.resolve(fileURLToPath(import.meta.url), '../../..');
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const TREE = path.resolve(arg('tree', HERE));
const PORT = Number(arg('port', 0)) || undefined;
const OUT = path.resolve(arg('out', path.join(HERE, 'out', 'clip-speed-export', path.basename(TREE))));
const SKIP_AUDIO = argv.includes('--skip-audio');
/** 排查用:G 段(套素材效果卡的那段)的速度,缺省 2 */
const G_SPEED = Number(arg('g-speed', 2));
const FPS = 30, W = 640, H = 360, SRC_SECONDS = 20, DURATION = 16;
const WORK = path.join(OUT, 'work');
const MEDIA_DIR = path.join(WORK, 'media');
const OVERRIDES = path.join(WORK, 'card-overrides');
const TINT = 'probe-speed-tint';
const say = (m) => console.error(`[speed-probe] ${m}`);

async function findFfmpeg() {
  const { findFfmpeg: f } = await import(pathToFileURL(path.join(TREE, 'server/bakery/ffmpeg.mjs')).href);
  return f();
}

/** 第 N 帧整幅一种颜色 + 440 Hz 正弦声 */
async function makeVideo(ffmpeg) {
  const tmp = path.join(WORK, 'coded.mp4');
  await execFileAsync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=black:s=320x180:r=${FPS}:d=${SRC_SECONDS},format=rgb24,geq=r='8*mod(N\\,32)':g='8*floor(N/32)':b='128'`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${SRC_SECONDS}`,
    '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '4', '-g', String(FPS),
    '-c:a', 'aac', '-b:a', '128k', '-shortest', '-movflags', '+faststart', tmp], { windowsHide: true });
  const bytes = await fs.readFile(tmp);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.rename(tmp, path.join(MEDIA_DIR, `${hash}.mp4`));
  return { id: 'm-coded', kind: 'video', name: 'coded.mp4', url: `/@media/${hash}`, hash, duration: SRC_SECONDS, width: 320, height: 180, fps: FPS };
}

async function writeCard() {
  const dir = path.join(OVERRIDES, 'src', 'cards', 'user');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${TINT}.tsx`), `import "../../kernel/remotionStyle";
import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

/** 探针用(clip-speed-export-probe.mjs 临时写进改动层):输入画面取反色 */
export const probeSpeedTint: CardDef<{ amount: number }> = {
  id: "${TINT}",
  name: "速度探针:反色",
  description: "输入画面取反色",
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
}

const full = { x: 0, y: 0, w: W, h: H, anchor: [0, 0], scale: 1, rotate: 0 };
const SEGMENTS = [
  { id: 'A', start: 0, end: 2, mediaOffset: 1, audible: true, hz: 440 },
  // B、C 两段的视频原声不出;下面「声音」序列上各有一段音画分离出来的声音段(同速度),随倍率变调出声
  { id: 'B', start: 2, end: 4, mediaOffset: 0.5, speed: 2, audible: true, hz: 880 },
  { id: 'C', start: 4, end: 6, mediaOffset: 3, speed: 0.5, audible: true, hz: 220 },
  { id: 'D', start: 6, end: 8, cut: { cutOffset: 0.5, inner: { mediaOffset: 1, speed: 2, start: 0 } } },
  { id: 'E', start: 8, end: 10, mediaOffset: 2, speed: 4 },
  { id: 'F', start: 10, end: 12, mediaOffset: 5, speed: 0.25 },
  { id: 'G', start: 12, end: 14, mediaOffset: 6, speed: G_SPEED === 1 ? undefined : G_SPEED, tint: true },
  { id: 'H', start: 14, end: 16, mediaOffset: 9, audible: true, hz: 440 },
];

function projectOf(media) {
  const clips = SEGMENTS.map((s) => s.cut
    ? { id: s.id, cardId: '', cutId: 'inner', cutOffset: s.cut.cutOffset, start: s.start, end: s.end, params: {}, frame: full }
    // 套素材效果卡的段(G):和 apply_card 挂上之后的样子一样,片段带着卡(cardId)、素材(mediaId)和节点(nodeId)
    : { id: s.id, cardId: s.tint ? TINT : '', mediaId: media.id, mediaOffset: s.mediaOffset, start: s.start, end: s.end, params: s.tint ? { amount: 1 } : {}, frame: full, label: s.id,
      ...(s.speed ? { speed: s.speed } : {}), ...(s.tint ? { nodeId: 'n-tint' } : {}) });
  const inner = SEGMENTS.find((s) => s.cut).cut.inner;
  return {
    version: 1, id: 'p-speed-probe', name: 'speed-probe', width: W, height: H, fps: FPS, duration: DURATION, themeId: 'midnight',
    // 音画分离出来的声音素材(和视频共用同一个文件,kind 为 audio,同 store 的 soundAssetFrom)
    media: [media, { ...media, id: 'm-coded-sound', kind: 'audio', name: 'coded.mp4 的声音', soundOf: media.id }], filters: [], audioFx: [],
    cardNodes: [{ id: 'n-tint', adapter: 'card', cardId: TINT, kind: 'filter', params: { amount: 1 }, inputs: { source: '@clip/G/source' } }],
    tracks: [{ id: 't-main', name: '序列 1', clips: clips.map((c) => (c.id === 'B' || c.id === 'C' ? { ...c, audioMuted: true } : c)) },
      { id: 't-sound', name: '声音', clips: SEGMENTS.filter((x) => x.id === 'B' || x.id === 'C').map((x) => ({ id: `${x.id}-sound`, cardId: '', mediaId: 'm-coded-sound', mediaOffset: x.mediaOffset, start: x.start, end: x.end, speed: x.speed, params: {} })) }],
    cuts: [{ id: 'outer', name: '剪辑1' }, { id: 'inner', name: '内', duration: 8, transitions: [], tracks: [{ id: 't-in', name: '序列 1', clips: [
      { id: 'b1', cardId: '', mediaId: media.id, mediaOffset: inner.mediaOffset, speed: inner.speed, start: inner.start, end: 8, params: {}, frame: full },
    ] }] }],
    activeCutId: 'outer',
  };
}

/** 第 i 帧(t = i / fps)该显示素材的第几帧 */
function expectedFrame(i) {
  const t = i / FPS;
  const s = SEGMENTS.find((x) => t >= x.start - 1e-9 && t < x.end - 1e-9);
  let m;
  if (s.cut) {
    const u = s.cut.cutOffset + (t - s.start); // 被引用剪辑里的时刻
    m = s.cut.inner.mediaOffset + (u - s.cut.inner.start) * s.cut.inner.speed;
  } else m = s.mediaOffset + (t - s.start) * (s.speed ?? 1);
  return { seg: s.id, media: m, frame: Math.floor((m + 0.002) * FPS + 1e-6), tint: !!s.tint };
}

function decodeFrame(file, tint) {
  const png = PNG.sync.read(fsSync.readFileSync(file));
  const sample = (x, y) => { const o = (y * png.width + x) * 4; return [png.data[o], png.data[o + 1], png.data[o + 2]]; };
  const acc = [0, 0, 0];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const p = sample((png.width >> 1) + dx, (png.height >> 1) + dy); for (let k = 0; k < 3; k++) acc[k] += p[k]; }
  let [r, g, b] = acc.map((v) => v / 25);
  if (tint) [r, g, b] = [255 - r, 255 - g, 255 - b];
  return { frame: Math.round(r / 8) + 32 * Math.round(g / 8), rgb: [r, g, b].map((v) => Math.round(v)) };
}

function run(cmd, args, env, logFile) {
  return new Promise((resolve) => {
    const log = fsSync.createWriteStream(logFile, { flags: 'a' });
    const p = spawn(cmd, args, { cwd: TREE, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    p.stdout.pipe(log); p.stderr.pipe(log);
    p.on('close', (code) => { log.end(); resolve(code); });
    p.on('error', () => resolve(1));
  });
}

/** 成片的声音解成 48 kHz 单声道 float(整条) */
async function pcmOf(ffmpeg, file) {
  const { stdout } = await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
    { windowsHide: true, encoding: 'buffer', maxBuffer: 1 << 28 });
  const out = new Float32Array(stdout.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = stdout.readFloatLE(i * 4);
  return out;
}
const win = (pcm, a, b) => pcm.subarray(Math.round(a * 48000), Math.round(b * 48000));
/** [a, b) 秒的响度(dBFS,RMS) */
function loudness(pcm, a, b) {
  const x = win(pcm, a, b);
  if (!x.length) return -Infinity;
  let sum = 0;
  for (const v of x) sum += v * v;
  return 10 * Math.log10(sum / x.length + 1e-20);
}
/** [a, b) 秒的主频(过零点数 / 2 / 时长) */
function pitch(pcm, a, b) {
  const x = win(pcm, a, b);
  let n = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++;
  return n / 2 / ((b - a) || 1);
}
/** 两条路同一窗口的差:差信号的响度减去信号的响度(dB,越低越像) */
function diffDb(p1, p2, a, b) {
  const x = win(p1, a, b), y = win(p2, a, b);
  const n = Math.min(x.length, y.length);
  let d = 0, e = 0;
  for (let i = 0; i < n; i++) { d += (x[i] - y[i]) ** 2; e += x[i] * x[i]; }
  return 10 * Math.log10((d + 1e-20) / (e + 1e-20));
}

const result = { tree: TREE, out: OUT, ok: false, fails: [] };
let dev = null;
try {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  await fs.mkdir(path.join(WORK, 'data'), { recursive: true });
  const ffmpeg = await findFfmpeg();
  const media = await makeVideo(ffmpeg);
  await writeCard();
  const project = projectOf(media);
  await fs.writeFile(path.join(OUT, 'project.json'), JSON.stringify(project, null, 1));
  const env = { PROMPTCUT_EXPORT_DIR: WORK, PROMPTCUT_DATA_DIR: path.join(WORK, 'data'), PROMPTCUT_CARD_OVERRIDES: OVERRIDES, PROMPTCUT_NO_PORT_FILE: '1',
    PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_PUSH: '0', PROMPTCUT_LAN_HOST: '' };
  Object.assign(process.env, env);
  const { startDevServer } = await import(pathToFileURL(path.join(TREE, 'scripts/lib/dev-server.mjs')).href);
  dev = await startDevServer({ env, port: PORT, logFile: path.join(OUT, 'vite.log'), log: say });
  say(`dev server ${dev.origin}(pid ${dev.pid})`);
  const timeline = 'data:application/json,' + encodeURIComponent(JSON.stringify(project));
  const url = `${dev.origin}/?export=1&timeline=${encodeURIComponent(timeline)}`;

  // 1. 画面:逐帧
  let code = 1;
  for (let attempt = 1; attempt <= 3 && code !== 0; attempt++) {
    say(`导出 PNG 第 ${attempt} 次`);
    code = await run(process.execPath, ['scripts/export-frames.mjs', '--url', url, '--out', path.join(OUT, 'frames-run'), '--fps', String(FPS), '--workers', '1', '--no-video'], env, path.join(OUT, 'export-frames.log'));
  }
  if (code !== 0) throw new Error(`PNG 导出退出码 ${code}(日志 ${path.join(OUT, 'export-frames.log')})`);
  const dir = path.join(OUT, 'frames-run', 'frames');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.png')).sort();
  const rows = [];
  for (let i = 0; i < files.length; i++) {
    const want = expectedFrame(i);
    const got = decodeFrame(path.join(dir, files[i]), want.tint);
    rows.push({ i, seg: want.seg, media: +want.media.toFixed(4), want: want.frame, got: got.frame, rgb: got.rgb });
  }
  const bySeg = {};
  for (const r of rows) {
    const s = (bySeg[r.seg] ??= { frames: 0, match: 0, firstMismatch: null });
    s.frames++;
    if (r.want === r.got) s.match++;
    else s.firstMismatch ??= { frame: r.i, mediaTime: r.media, want: r.want, got: r.got };
  }
  const match = rows.filter((r) => r.want === r.got).length;
  result.frames = { total: rows.length, expected: DURATION * FPS, match, bySeg };
  await fs.writeFile(path.join(OUT, 'frames.json'), JSON.stringify(rows));
  if (rows.length !== DURATION * FPS) result.fails.push(`导出了 ${rows.length} 帧,应为 ${DURATION * FPS}`);
  if (match !== rows.length) result.fails.push(`画面逐帧:${match}/${rows.length} 帧取到了该取的素材帧`);

  // 2. 声音:两条混音路各导一次成片
  if (!SKIP_AUDIO) {
    result.audio = {};
    const pcms = {};
    for (const [name, extra] of [['chrome', []], ['ffmpeg', ['--audio', 'ffmpeg']]]) {
      // Chrome 离线混音要页面地址是 /@export/<id>/project.json(裁好的 wav 按这个 id 取,server/bakery/audio-mix.mjs);
      // 用 data: 地址会「Chrome 混音失败,退回 ffmpeg」——两条路就成了同一条。所以按产品导出的摆法放:<导出目录>/export-<id>/
      const id = `speed-${name}`;
      const outDir = path.join(WORK, `export-${id}`);
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(path.join(outDir, 'project.json'), JSON.stringify(project));
      const url = `${dev.origin}/?export=1&timeline=${encodeURIComponent(`/@export/${id}/project.json`)}`;
      let c = 1;
      for (let attempt = 1; attempt <= 3 && c !== 0; attempt++) {
        say(`导出成片(${name} 混音)第 ${attempt} 次`);
        c = await run(process.execPath, ['scripts/export-frames.mjs', '--url', url, '--out', outDir, '--fps', String(FPS), '--workers', '1', ...extra], env, path.join(OUT, `export-${name}.log`));
      }
      if (c !== 0) { result.fails.push(`成片(${name} 混音)导出退出码 ${c}`); continue; }
      // 核实两条路真的各走各的:Chrome 那一次必须真在 Chrome 里混、没有退回 ffmpeg
      const log = await fs.readFile(path.join(OUT, `export-${name}.log`), 'utf8');
      const mixedIn = /退回 ffmpeg/.test(log) ? 'ffmpeg(Chrome 失败后退回)' : /in Chrome/.test(log) ? 'chrome' : /Muxing .* with ffmpeg/.test(log) ? 'ffmpeg' : '不明';
      if (mixedIn !== name) result.fails.push(`${name} 那一次实际在 ${mixedIn} 里混音`);
      const mp4 = (await fs.readdir(outDir)).find((f) => f.endsWith('.mp4'));
      if (!mp4) { result.fails.push(`成片(${name} 混音)没有 mp4`); continue; }
      const file = path.join(outDir, mp4);
      const pcm = await pcmOf(ffmpeg, file);
      pcms[name] = pcm;
      const segs = {};
      for (const s of SEGMENTS) {
        const db = loudness(pcm, s.start + 0.3, s.end - 0.3);
        const hz = pitch(pcm, s.start + 0.3, s.end - 0.3);
        const okDb = s.audible ? db > -30 : db < -70;
        const okHz = !s.hz || Math.abs(hz - s.hz) <= s.hz * 0.02;
        segs[s.id] = { dBFS: Number.isFinite(db) ? +db.toFixed(1) : null, hz: s.audible ? +hz.toFixed(1) : null, expect: s.audible ? `有声 ${s.hz} Hz` : '无声', ok: okDb && okHz };
        if (!okDb) result.fails.push(`${name} 混音:${s.id} 段 ${s.start}～${s.end} 秒应${s.audible ? '有声' : '无声'},实测 ${db.toFixed(1)} dBFS`);
        if (s.audible && !okHz) result.fails.push(`${name} 混音:${s.id} 段主频应为 ${s.hz} Hz,实测 ${hz.toFixed(1)} Hz`);
      }
      result.audio[name] = { file, mixedIn, segs };
    }
    // 两条混音路逐段比:有声的段,差信号比信号本身低多少 dB
    if (pcms.chrome && pcms.ffmpeg) {
      result.audio.chromeVsFfmpeg = {};
      for (const s of SEGMENTS.filter((x) => x.audible)) {
        const d = diffDb(pcms.chrome, pcms.ffmpeg, s.start + 0.3, s.end - 0.3);
        result.audio.chromeVsFfmpeg[s.id] = +d.toFixed(1);
      }
      // 尺子:两条路本来就不是逐采样相同(Chrome 离线混音 + 编码 与 ffmpeg 混音 + 编码),1 倍段的差就是这把尺子的底;
      // 变速的声音段(B、C)两条路的差不能比 1 倍段(A、H)里差得最多的那段还大
      const floor = Math.max(...SEGMENTS.filter((x) => x.audible && !x.speed).map((x) => result.audio.chromeVsFfmpeg[x.id]));
      result.audio.oneXFloor = floor;
      for (const s of SEGMENTS.filter((x) => x.audible && x.speed)) {
        const d = result.audio.chromeVsFfmpeg[s.id];
        if (!(d <= floor + 1e-9)) result.fails.push(`两条混音路 ${s.id} 段(${s.speed}×)差 ${d} dB,比 1 倍段的 ${floor} dB 还大`);
      }
    }
  }
  result.ok = result.fails.length === 0;
} catch (error) {
  result.fails.push(String(error?.stack || error));
} finally {
  try { dev?.stop(); } catch {}
}
console.log(JSON.stringify(result, null, 1));
process.exit(result.ok ? 0 : 1);
