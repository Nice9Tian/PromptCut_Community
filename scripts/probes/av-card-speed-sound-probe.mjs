/**
 * 声画一体卡挂在变速素材段上照常出声(2026-10-23 用户定「出声。」,推翻〔裁〕V21-28)的导出端到端探针:
 * 成片里那几段的主频按倍率变,且「先生成声音、再切开变速段」之后已生成的声音照旧对位、不用重新生成。
 *
 *   node scripts/probes/av-card-speed-sound-probe.mjs --port 5940 [--out <目录>]
 *
 * 本探针自己起一台本树的 dev server(端口 --port 与 +1、+2 要空着,不碰 5190～5192;导出、数据、改动层都在 --out 下,
 * 不写端口文件),无头 Chrome(`--mute-audio`,不向扬声器出声)打开编辑台。
 *
 * 素材:20 秒的视频,带一条 440 Hz 正弦声。卡:临时写进改动层的声画一体卡 `probe-av-pass`(有画面组件、有 `audio()`,
 * 声音把输入 `source` 的采样原样交出去;和 apply_card 之后一样,片段带 cardId / mediaId / nodeId,节点输入是这段自己的素材)。
 * 项目 10 秒,一条序列:
 *
 *     A 0～2 秒   1×    从素材第 1 秒起      期望 440 Hz
 *     B 2～4 秒   2×    从第 0.5 秒起         期望 880 Hz
 *     C 4～6 秒   0.5×  从第 3 秒起           期望 220 Hz
 *     D 6～10 秒  2×    从第 4 秒起           期望 880 Hz;**先生成声音,再在 8 秒处切开**(store 的 splitClip)
 *
 * 步骤与断言(每条一行 PASS/FAIL,最后一行打一行 JSON,有失败退出码 1):
 *   N0  导出前清单:四段都要生成(ungenerated);改动前的 assertProjectCardAudio 只点名 A(变速段被跳过、不出声)在这里看不到
 *   G   prepareExportSounds 生成四段的声音
 *   S   在 8 秒处切开 D:切开后清单为空(已生成的声音两半都还覆盖、不判过期);后半段的播放偏移 = 前半段 + 2 秒(时间轴秒)
 *   E   桌面导出(`window.__pcIo.exportVideo()`)成功,且没有再生成声音
 *   A/B/C/D1/D2  成片各段中间(去掉两头 0.3 秒)有声(高于 −30 dBFS),主频(过零点与 DFT 峰)在期望值 ±2% 内
 *   DX  跨切点的窗口(7.5～8.5 秒)同样 880 Hz、响度与 D1 差不到 1 dB(切开处没有断档)
 *   V   画面:卡的红条宽 = 卡片时钟 ÷ 10 秒 × 画宽。切点前一帧(第 239 帧,前半段片段内 1.967 秒)与切点那一帧(第 240 帧,后半段 0 秒)
 *       红条宽度差不到 4 像素,且都约为 0.4 × 640 = 256 像素(卡片时钟 = mediaOffset ÷ 倍率 + 片段内时间 = 4/2 + 2 = 4 秒);
 *       改前卡片时钟起点是 mediaOffset(素材秒),前一帧约 382 像素、切点那一帧跳到 512 像素。两帧存成 PNG 在 --out 下
 *   E0  页面零报错
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startDevServer, REPO } from '../lib/dev-server.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 40 * 60_000).unref();
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 5940));
const OUT = path.resolve(arg('--out', path.join(REPO, 'out', 'av-card-speed-sound')));
const FPS = 30, W = 640, H = 360, SRC_SECONDS = 20, DURATION = 10, SR = 48000;
const PASS = 'probe-av-pass';
fs.rmSync(OUT, { recursive: true, force: true });
const dirs = { exportDir: path.join(OUT, 'export'), dataDir: path.join(OUT, 'data'), projectsDir: path.join(OUT, 'projects'), overrides: path.join(OUT, 'card-overrides') };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
const MEDIA_DIR = path.join(dirs.exportDir, 'media');
fs.mkdirSync(MEDIA_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const fails = [];
const check = (key, cond, note, extra) => {
  results[key] = { ok: !!cond, note, ...(extra !== undefined ? { extra } : {}) };
  if (!cond) fails.push(`${key}: ${note}`);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${key} ${note} ${extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ''}`);
};

function makeVideo() {
  const tmp = path.join(OUT, 'tone.mp4');
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', `color=c=gray:s=320x180:r=${FPS}:d=${SRC_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${SRC_SECONDS}`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', String(FPS),
    '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', tmp], { windowsHide: true });
  const hash = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
  fs.renameSync(tmp, path.join(MEDIA_DIR, `${hash}.mp4`));
  return { id: 'm-tone', kind: 'video', name: 'tone.mp4', url: `/@media/${hash}`, hash, duration: SRC_SECONDS, width: 320, height: 180, fps: FPS };
}

const CARD_SOURCE = [
  'import type { CardDef, CardProps } from "../../kernel/types";',
  '',
  '/** 探针用(av-card-speed-sound-probe.mjs 临时写进改动层):声画一体卡,声音把输入的声音原样交出去;画面是一根红条,宽 = 卡片时钟 ÷ 10 秒 */',
  'function Frame({ t = 0 }: CardProps<{ gain: number }>) {',
  '  return <div style={{ position: "absolute", left: 0, top: 0, height: "100%", width: `${Math.min(1, Math.max(0, t / 10)) * 100}%`, background: "#ff0000" }} />;',
  '}',
  'export const probeAvPass: CardDef<{ gain: number }> = {',
  `  id: "${PASS}",`,
  '  name: "速度探针:声画直通",',
  '  description: "画面画卡片时钟,声音把输入原样输出",',
  '  source: "user",',
  '  kind: "animation",',
  '  frameMode: "direct",',
  '  inputs: { source: { description: "输入素材" } },',
  '  defaults: { gain: 1 },',
  '  controls: [],',
  '  Component: Frame,',
  '  audio: async (sources, range, params) => {',
  '    const block = await sources.source.block(range.start, range.count);',
  '    const out = new Float32Array(block.length);',
  '    for (let i = 0; i < block.length; i++) out[i] = block[i] * params.gain;',
  '    return out;',
  '  },',
  '};',
  '',
].join('\n');

const full = { x: 0, y: 0, w: W, h: H, anchor: [0, 0], scale: 1, rotate: 0 };
const SEGMENTS = [
  { id: 'A', start: 0, end: 2, mediaOffset: 1, hz: 440 },
  { id: 'B', start: 2, end: 4, mediaOffset: 0.5, speed: 2, hz: 880 },
  { id: 'C', start: 4, end: 6, mediaOffset: 3, speed: 0.5, hz: 220 },
  { id: 'D', start: 6, end: 10, mediaOffset: 4, speed: 2, hz: 880 },
];
const SPLIT_AT = 8;

function projectOf(media) {
  const clips = [], cardNodes = [];
  for (const s of SEGMENTS) {
    cardNodes.push({ id: `n-${s.id}`, adapter: 'card', cardId: PASS, kind: 'animation', embeddedAudio: true, params: { gain: 1 }, inputs: { source: { nodeId: `@clip/${s.id}/source` } } });
    clips.push({ id: s.id, cardId: PASS, mediaId: media.id, nodeId: `n-${s.id}`, embeddedAudio: true, mediaOffset: s.mediaOffset, start: s.start, end: s.end,
      params: { gain: 1 }, frame: full, ...(s.speed ? { speed: s.speed } : {}) });
  }
  return { version: 1, id: 'p-av-card-speed', name: 'av-card-speed-sound', width: W, height: H, fps: FPS, duration: DURATION, themeId: 'midnight',
    media: [media], filters: [], audioFx: [], cardNodes, tracks: [{ id: 't-main', name: '序列 1', clips }] };
}

/** 成片第 n 帧(rgb24),量第 y 行最左边连续红色像素的个数 */
function redBar(file, n, png) {
  // 滤镜参数里的逗号要转义成「\,」(不经 shell,原样交给 ffmpeg)
  const vf = `select=eq(n\\,${n})`;
  const buf = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', vf, '-vframes', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { windowsHide: true, maxBuffer: 1 << 26 });
  execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', file, '-vf', vf, '-vframes', '1', png], { windowsHide: true });
  const y = Math.floor(H / 2);
  let w = 0;
  for (let x = 0; x < W; x++) { const i = (y * W + x) * 3; if (buf[i] > 180 && buf[i + 1] < 90 && buf[i + 2] < 90) w = x + 1; else if (w) break; }
  return w;
}

function pcmOf(file) {
  const buf = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'],
    { windowsHide: true, maxBuffer: 1 << 28 });
  const out = new Float32Array(buf.length / 4);
  for (let i = 0; i < out.length; i++) out[i] = buf.readFloatLE(i * 4);
  return out;
}
const win = (pcm, a, b) => pcm.subarray(Math.round(a * SR), Math.round(b * SR));
function loudness(pcm, a, b) {
  const x = win(pcm, a, b);
  if (!x.length) return -Infinity;
  let sum = 0;
  for (const v of x) sum += v * v;
  return 10 * Math.log10(sum / x.length + 1e-20);
}
/** 过零点数 / 2 / 时长(speed-audio-input-probe.mjs 同一个做法) */
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
    const w = 2 * Math.PI * hz / SR;
    for (let i = 0; i < x.length; i += 2) { re += x[i] * Math.cos(w * i); im += x[i] * Math.sin(w * i); }
    const p = re * re + im * im;
    if (p > best) { best = p; bestHz = hz; }
  }
  return bestHz;
}

fs.mkdirSync(path.join(dirs.overrides, 'src', 'cards', 'user'), { recursive: true });
fs.writeFileSync(path.join(dirs.overrides, 'src', 'cards', 'user', `${PASS}.tsx`), CARD_SOURCE);
const media = makeVideo();
const project = projectOf(media);
fs.writeFileSync(path.join(OUT, 'project.json'), JSON.stringify(project, null, 1));

const server = await startDevServer({ port: PORT, logFile: path.join(OUT, 'vite.log'), log: (m) => console.log('[dev]', m),
  env: { PROMPTCUT_EXPORT_DIR: dirs.exportDir, PROMPTCUT_DATA_DIR: dirs.dataDir, PROMPTCUT_PROJECTS_DIR: dirs.projectsDir, PROMPTCUT_CARD_OVERRIDES: dirs.overrides,
    PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_PUSH: '0', PROMPTCUT_CARD_SYNC: '0', PROMPTCUT_LAN_HOST: '' } });
const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--mute-audio', '--force-device-scale-factor=1'], protocolTimeout: 15 * 60_000 });
const report = { out: OUT };
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { void d.dismiss(); });
  await page.goto(`${server.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => !!window.__pcStore && !!window.__pcIo, { timeout: 120_000 });
  await page.waitForFunction(async (id) => { const { getCard } = await import('/src/kernel/registry.ts'); return !!getCard(id); }, { timeout: 120_000, polling: 1000 }, PASS);
  await sleep(3000);
  await page.evaluate((p) => window.__pcStore.actions.loadProject(JSON.parse(JSON.stringify(p))), project);
  await sleep(500);

  const pre = await page.evaluate(async () => {
    const sound = await window.__pcIo.sound();
    const needs = await sound.listExportSoundNeeds(new AbortController().signal);
    return needs.map((n) => ({ clipId: n.clipId, reason: n.reason }));
  });
  check('N0', pre.length === 4 && pre.every((n) => n.reason === 'ungenerated'), '导出前四段都要生成声音', pre);

  const gen = await page.evaluate(async () => {
    try {
      const { prepareExportSounds } = await import('/src/editor/io/exportSounds.ts');
      await prepareExportSounds({ signal: new AbortController().signal, onProgress: () => {} });
      const p = window.__pcStore.getState().project;
      return { ok: true, generated: p.tracks[0].clips.filter((c) => c.cardAudio).map((c) => c.id) };
    } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  });
  check('G', gen.ok && gen.generated?.length === 4, '先生成四段的声音', gen);

  const split = await page.evaluate(async (at) => {
    const a = window.__pcStore.actions;
    const right = a.splitClip('D', at);
    const p = window.__pcStore.getState().project;
    const sound = await window.__pcIo.sound();
    const needs = await sound.listExportSoundNeeds(new AbortController().signal);
    const { persistentCardAudio } = await import('/src/audio/cardAudio.ts');
    const left = p.tracks[0].clips.find((c) => c.id === 'D'), r = right && p.tracks[0].clips.find((c) => c.id === right.id);
    let offsets = null, error = null;
    try { offsets = { left: persistentCardAudio(p, left).offset, right: persistentCardAudio(p, r).offset, sameWav: left.cardAudio?.mediaId === r.cardAudio?.mediaId }; } catch (e) { error = String(e?.message ?? e); }
    return { rightId: right?.id ?? null, rightMediaOffset: r?.mediaOffset, needs: needs.map((n) => ({ clipId: n.clipId, reason: n.reason, detail: n.detail })), offsets, error };
  }, SPLIT_AT);
  check('S', split.rightId && split.needs.length === 0 && split.offsets?.sameWav && Math.abs(split.offsets.right - split.offsets.left - (SPLIT_AT - 6)) < 1e-6,
    `切开 D 之后清单为空,两半共用同一份 WAV,后半段偏移 = 前半段 + ${SPLIT_AT - 6} 秒`, split);

  const exp = await page.evaluate(async () => {
    const progress = [];
    try {
      const out = await window.__pcIo.exportVideo({ onProgress: (d, t, stage) => progress.push([stage ?? 'render', d, t]) });
      return { ok: true, outDir: out.outDir, soundSteps: progress.filter((x) => x[0] === 'sound').length };
    } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  });
  const file = exp.outDir ? path.join(exp.outDir, 'preview.mp4') : '';
  check('E', exp.ok && fs.existsSync(file), '桌面导出成功', exp);
  if (exp.ok && fs.existsSync(file)) {
    const mp4 = path.join(OUT, 'export.mp4');
    fs.copyFileSync(file, mp4);
    report.file = mp4;
    const pcm = pcmOf(mp4);
    report.segs = {};
    const windows = [
      { id: 'A', a: 0, b: 2, hz: 440, speed: 1 }, { id: 'B', a: 2, b: 4, hz: 880, speed: 2 }, { id: 'C', a: 4, b: 6, hz: 220, speed: 0.5 },
      { id: 'D1', a: 6, b: SPLIT_AT, hz: 880, speed: 2 }, { id: 'D2', a: SPLIT_AT, b: 10, hz: 880, speed: 2 },
    ];
    for (const s of windows) {
      const a = s.a + 0.3, b = s.b - 0.3;
      const db = loudness(pcm, a, b), hz = pitch(pcm, a, b), peak = peakHz(pcm, a, b);
      const ok = db > -30 && Math.abs(hz - s.hz) <= s.hz * 0.02 && Math.abs(peak - s.hz) <= s.hz * 0.02;
      report.segs[s.id] = { speed: s.speed, expectHz: s.hz, zeroCrossHz: +hz.toFixed(1), dftPeakHz: peak, dBFS: +db.toFixed(1) };
      check(s.id, ok, `${s.id} 段 ${s.speed}× 应为 ${s.hz} Hz 有声:过零 ${hz.toFixed(1)} Hz、DFT 峰 ${peak} Hz、${db.toFixed(1)} dBFS`);
    }
    const dx = { hz: pitch(pcm, SPLIT_AT - 0.5, SPLIT_AT + 0.5), peak: peakHz(pcm, SPLIT_AT - 0.5, SPLIT_AT + 0.5), db: loudness(pcm, SPLIT_AT - 0.5, SPLIT_AT + 0.5) };
    report.segs.DX = { zeroCrossHz: +dx.hz.toFixed(1), dftPeakHz: dx.peak, dBFS: +dx.db.toFixed(1) };
    check('DX', Math.abs(dx.hz - 880) <= 880 * 0.02 && Math.abs(dx.peak - 880) <= 880 * 0.02 && Math.abs(dx.db - report.segs.D1.dBFS) < 1,
      `跨切点 ${SPLIT_AT - 0.5}～${SPLIT_AT + 0.5} 秒:过零 ${dx.hz.toFixed(1)} Hz、DFT 峰 ${dx.peak} Hz、${dx.db.toFixed(1)} dBFS(D1 ${report.segs.D1.dBFS})`);
    const before = redBar(mp4, SPLIT_AT * FPS - 1, path.join(OUT, `frame-${SPLIT_AT * FPS - 1}.png`)), at = redBar(mp4, SPLIT_AT * FPS, path.join(OUT, `frame-${SPLIT_AT * FPS}.png`));
    report.bar = { before, at, expect: 0.4 * W };
    check('V', Math.abs(at - before) < 4 && Math.abs(at - 0.4 * W) < 6, `画面:切点前一帧红条 ${before} 像素、切点那一帧 ${at} 像素(应都约 ${0.4 * W})`);
  }
  check('E0', errors.length === 0, '页面零报错', errors);
} catch (error) {
  check('X', false, `探针异常:${String(error?.stack || error)}`);
} finally {
  await browser.close();
  server.stop();
}
console.log(JSON.stringify({ ok: fails.length === 0, results, report, fails }));
process.exit(fails.length ? 1 : 0);
