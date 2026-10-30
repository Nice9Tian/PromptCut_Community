/**
 * 变速的素材段当音频素材效果卡的声音输入(2026-10-23 用户定「放开。」)的导出端到端探针:成片里那几段的主频按倍率变。
 *
 *   node scripts/probes/speed-audio-input-probe.mjs --port 6480 [--tree <检出根>] [--out <目录>]
 *
 * 素材:20 秒的视频,带一条 440 Hz 正弦声(画面无所谓)。卡:临时写进改动层的音频素材效果卡 `probe-audio-pass`
 * (`kind: "audio"`,把输入 `source` 的采样原样交出去)。项目 8 秒,两种接法各来几段:
 *
 *   主序列(卡挂在片段自己身上,和 apply_card 之后一样:片段带 cardId / mediaId / nodeId,节点输入是这段自己的素材)
 *     A 0～2 秒 1×    从素材第 1 秒起      期望 440 Hz
 *     B 2～4 秒 2×    从第 0.5 秒起         期望 880 Hz
 *     C 4～6 秒 0.5×  从第 3 秒起           期望 220 Hz
 *   主序列 V 6～8 秒 2× 的普通视频段(原声不出);另一条序列上 6～8 秒一段卡片段,节点输入接 `@clip/V/source`
 *     D                                      期望 880 Hz
 *
 * 只导缺省的 Chrome 离线混音一路:`--audio ffmpeg` 那条老路明确拒绝音频素材效果卡(`mux-audio.mjs` 的 buildAudioPlan 注释),
 * 1 倍时也一样,与变速无关。核对:各段中间 1.4 秒有声(高于 −30 dBFS)、主频(过零点与 DFT 峰)在期望值 ±2% 内。
 * 输出 JSON;任何一条不过以非零退出。素材、数据、改动层都建在 `--out` 下;开发服务器用完收掉,不写端口文件。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 40 * 60_000).unref();

const HERE = path.resolve(fileURLToPath(import.meta.url), '../../..');
const argv = process.argv.slice(2);
const arg = (name, dflt = null) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const TREE = path.resolve(arg('tree', HERE));
const PORT = Number(arg('port', 0)) || undefined;
const OUT = path.resolve(arg('out', path.join(HERE, 'out', 'speed-audio-input', path.basename(TREE))));
const FPS = 30, W = 640, H = 360, SRC_SECONDS = 20, DURATION = 8;
const WORK = path.join(OUT, 'work');
const MEDIA_DIR = path.join(WORK, 'media');
const OVERRIDES = path.join(WORK, 'card-overrides');
const PASS = 'probe-audio-pass';
const say = (m) => console.error(`[speed-audio-input] ${m}`);

async function findFfmpeg() {
  const { findFfmpeg: f } = await import(pathToFileURL(path.join(TREE, 'server/bakery/ffmpeg.mjs')).href);
  return f();
}

async function makeVideo(ffmpeg) {
  const tmp = path.join(WORK, 'tone.mp4');
  await execFileAsync(ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=gray:s=320x180:r=${FPS}:d=${SRC_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${SRC_SECONDS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', tmp], { windowsHide: true });
  const bytes = await fs.readFile(tmp);
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  await fs.rename(tmp, path.join(MEDIA_DIR, `${hash}.mp4`));
  return { id: 'm-tone', kind: 'video', name: 'tone.mp4', url: `/@media/${hash}`, hash, duration: SRC_SECONDS, width: 320, height: 180, fps: FPS };
}

const CARD_SOURCE = [
  'import type { CardDef } from "../../kernel/types";',
  '',
  '/** 探针用(speed-audio-input-probe.mjs 临时写进改动层):把输入的声音原样交出去 */',
  'export const probeAudioPass: CardDef<{ gain: number }> = {',
  `  id: "${PASS}",`,
  '  name: "速度探针:直通",',
  '  description: "输入的声音原样输出",',
  '  source: "user",',
  '  kind: "audio",',
  '  frameMode: "direct",',
  '  inputs: { source: { description: "输入声音" } },',
  '  defaults: { gain: 1 },',
  '  controls: [],',
  '  audio: async (sources, range, params) => {',
  '    const block = await sources.source.block(range.start, range.count);',
  '    const out = new Float32Array(block.length);',
  '    for (let i = 0; i < block.length; i++) out[i] = block[i] * params.gain;',
  '    return out;',
  '  },',
  '};',
  '',
].join('\n');

async function writeCard() {
  const dir = path.join(OVERRIDES, 'src', 'cards', 'user');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, `${PASS}.tsx`), CARD_SOURCE);
}

const full = { x: 0, y: 0, w: W, h: H, anchor: [0, 0], scale: 1, rotate: 0 };
const SEGMENTS = [
  { id: 'A', start: 0, end: 2, mediaOffset: 1, hz: 440 },
  { id: 'B', start: 2, end: 4, mediaOffset: 0.5, speed: 2, hz: 880 },
  { id: 'C', start: 4, end: 6, mediaOffset: 3, speed: 0.5, hz: 220 },
  { id: 'D', start: 6, end: 8, hz: 880, external: { mediaOffset: 2, speed: 2 } },
];

function projectOf(media) {
  const node = (id, source) => ({ id, adapter: 'card', cardId: PASS, kind: 'audio', params: { gain: 1 }, inputs: { source: { nodeId: source } } });
  const main = [], fx = [], cardNodes = [];
  for (const s of SEGMENTS) {
    if (s.external) {
      main.push({ id: 'V', cardId: '', mediaId: media.id, mediaOffset: s.external.mediaOffset, speed: s.external.speed, start: s.start, end: s.end, params: {}, frame: full });
      cardNodes.push(node('n-D', '@clip/V/source'));
      fx.push({ id: 'D', cardId: PASS, nodeId: 'n-D', start: s.start, end: s.end, params: { gain: 1 } });
    } else {
      cardNodes.push(node(`n-${s.id}`, `@clip/${s.id}/source`));
      main.push({ id: s.id, cardId: PASS, mediaId: media.id, nodeId: `n-${s.id}`, mediaOffset: s.mediaOffset, start: s.start, end: s.end, params: { gain: 1 }, frame: full,
        ...(s.speed ? { speed: s.speed } : {}) });
    }
  }
  return {
    version: 1, id: 'p-speed-audio-input', name: 'speed-audio-input', width: W, height: H, fps: FPS, duration: DURATION, themeId: 'midnight',
    media: [media], filters: [], audioFx: [], cardNodes,
    tracks: [{ id: 't-main', name: '序列 1', clips: main }, { id: 't-fx', name: '卡', clips: fx }],
  };
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

async function pcmOf(ffmpeg, file) {
  const { stdout } = await execFileAsync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', '-'],
    { windowsHide: true, encoding: 'buffer', maxBuffer: 1 << 28 });
  const out = new Float32Array(stdout.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = stdout.readFloatLE(i * 4);
  return out;
}
const win = (pcm, a, b) => pcm.subarray(Math.round(a * 48000), Math.round(b * 48000));
function loudness(pcm, a, b) {
  const x = win(pcm, a, b);
  if (!x.length) return -Infinity;
  let sum = 0;
  for (const v of x) sum += v * v;
  return 10 * Math.log10(sum / x.length + 1e-20);
}
/** 过零点数 / 2 / 时长(clip-speed-export-probe.mjs 同一个做法) */
function pitch(pcm, a, b) {
  const x = win(pcm, a, b);
  let n = 0;
  for (let i = 1; i < x.length; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) n++;
  return n / 2 / ((b - a) || 1);
}
/** 单频 DFT 找峰(100～2000 Hz,1 Hz 一档),和过零点互相印证 */
function peakHz(pcm, a, b) {
  const x = win(pcm, a, b);
  let best = 0, bestHz = 0;
  for (let hz = 100; hz <= 2000; hz++) {
    let re = 0, im = 0;
    const w = 2 * Math.PI * hz / 48000;
    for (let i = 0; i < x.length; i += 2) { re += x[i] * Math.cos(w * i); im += x[i] * Math.sin(w * i); }
    const p = re * re + im * im;
    if (p > best) { best = p; bestHz = hz; }
  }
  return bestHz;
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
  const id = 'speed-audio-input';
  const outDir = path.join(WORK, `export-${id}`);
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(path.join(outDir, 'project.json'), JSON.stringify(project));
  const url = `${dev.origin}/?export=1&timeline=${encodeURIComponent(`/@export/${id}/project.json`)}`;
  let code = 1;
  for (let attempt = 1; attempt <= 3 && code !== 0; attempt++) {
    say(`导出成片第 ${attempt} 次`);
    code = await run(process.execPath, ['scripts/export-frames.mjs', '--url', url, '--out', outDir, '--fps', String(FPS), '--workers', '1'], env, path.join(OUT, 'export.log'));
  }
  if (code !== 0) throw new Error(`导出退出码 ${code}(日志 ${path.join(OUT, 'export.log')})`);
  const log = await fs.readFile(path.join(OUT, 'export.log'), 'utf8');
  result.mixedIn = /退回 ffmpeg/.test(log) ? 'ffmpeg(Chrome 失败后退回)' : /in Chrome/.test(log) ? 'chrome' : /Muxing .* with ffmpeg/.test(log) ? 'ffmpeg' : '不明';
  if (result.mixedIn !== 'chrome') result.fails.push(`实际在 ${result.mixedIn} 里混音`);
  const mp4 = (await fs.readdir(outDir)).find((f) => f.endsWith('.mp4'));
  if (!mp4) throw new Error('没有 mp4');
  result.file = path.join(outDir, mp4);
  const pcm = await pcmOf(ffmpeg, result.file);
  result.segs = {};
  for (const s of SEGMENTS) {
    const a = s.start + 0.3, b = s.end - 0.3;
    const db = loudness(pcm, a, b), hz = pitch(pcm, a, b), peak = peakHz(pcm, a, b);
    const ok = db > -30 && Math.abs(hz - s.hz) <= s.hz * 0.02 && Math.abs(peak - s.hz) <= s.hz * 0.02;
    result.segs[s.id] = { speed: s.speed ?? s.external?.speed ?? 1, expectHz: s.hz, zeroCrossHz: +hz.toFixed(1), dftPeakHz: peak, dBFS: +db.toFixed(1), ok };
    if (!ok) result.fails.push(`${s.id} 段应为 ${s.hz} Hz 有声,实测过零 ${hz.toFixed(1)} Hz、DFT 峰 ${peak} Hz、${db.toFixed(1)} dBFS`);
  }
  result.ok = result.fails.length === 0;
} catch (error) {
  result.fails.push(String(error?.stack || error));
} finally {
  try { dev?.stop(); } catch {}
}
console.log(JSON.stringify(result, null, 1));
process.exit(result.ok ? 0 : 1);
