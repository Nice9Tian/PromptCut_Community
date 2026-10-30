/**
 * 剪辑段的声音进导出成片(Chrome 混音与 ffmpeg 两条路)的端到端探针。
 *
 *   node scripts/probes/cut-segment-audio-probe.mjs --port 5353 --out <目录>
 *
 * 做法:在 <目录>/export/media 下用 ffmpeg 生成一段 6 秒 440 Hz 正弦波 `tone.wav`,起一台本树的 dev server
 * (PROMPTCUT_EXPORT_DIR 指到 <目录>/export,端口 --port 与 +1、+2 要空着,不碰 5190～5192),导出下面这个项目(带声音):
 *   剪辑2:一条序列,tone 0～6 秒;
 *   剪辑1(激活):一个剪辑段,起点 2 秒、终点 7 秒、cutOffset 1、淡入 1 秒,引用剪辑2;总时长 9 秒。
 * 期望成片的声音:0～2 秒静音;2～3 秒淡入;3～7 秒是正弦波(取自 tone 的 1～5 秒);7～9 秒静音。
 * 断言:用 ffmpeg 的 astats 量各段的 RMS(dB):段前 < -60 dB;3～7 秒和原素材 1～5 秒的电平差不到 1 dB;段后静音或没有声音样本;
 * 淡入段 2.0～2.5 秒的 RMS 比 3～3.5 秒低 6 dB 以上。
 * 两条路各导一遍(缺省 Chrome 混音;`--audio ffmpeg`)。最后一行打一行 JSON。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startDevServer, REPO } from '../lib/dev-server.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 15 * 60_000).unref();
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 5353));
const OUT = path.resolve(arg('--out', path.join(REPO, 'out', 'cut-segment-audio')));
const exportDir = path.join(OUT, 'export');
fs.mkdirSync(path.join(exportDir, 'media'), { recursive: true });
const tone = path.join(exportDir, 'media', 'tone.wav');
const ff = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6', '-ac', '2', tone], { windowsHide: true });
if (ff.status !== 0) throw new Error('ffmpeg 生成正弦波失败:' + ff.stderr);

const project = {
  version: 1, id: 'p-cut-audio', name: 'cut-audio', width: 640, height: 360, fps: 30, duration: 9, themeId: 'midnight',
  media: [{ id: 'm-tone', kind: 'audio', name: 'tone.wav', url: '/@media/tone.wav', duration: 6 }],
  tracks: [{ id: 't1', name: '序列 1', clips: [{ id: 's1', cardId: '', cutId: 'cut-2', cutOffset: 1, start: 2, end: 7, fadeIn: 1, params: {} }] }],
  cuts: [
    { id: 'cut-1', name: '剪辑1' },
    { id: 'cut-2', name: '剪辑2', tracks: [{ id: 't2', name: '序列 1', clips: [{ id: 'a1', cardId: '', mediaId: 'm-tone', mediaOffset: 0, start: 0, end: 6, params: {} }] }], duration: 6, transitions: [] },
  ],
  activeCutId: 'cut-1',
};

const server = await startDevServer({ env: { PROMPTCUT_EXPORT_DIR: exportDir }, logFile: path.join(OUT, 'vite.log'), port: PORT, log: (m) => console.log('[dev]', m) });
/** 一个文件 [from, to) 秒的整体 RMS(dB);没有声音样本时 null */
function rmsOf(file, from, to) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(from), '-t', String(to - from), '-i', file, '-vn', '-af', 'astats=metadata=0:reset=0', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  const m = /Overall[\s\S]*?RMS level dB:\s*(-?inf|-?[\d.]+)/.exec(r.stderr);
  return m ? (m[1].includes('inf') ? -200 : Number(m[1])) : null;
}
const results = {};
const fails = [];
try {
  for (const mode of ['chrome', 'ffmpeg']) {
    const out = path.join(OUT, mode);
    fs.rmSync(out, { recursive: true, force: true });
    const timeline = 'data:application/json,' + encodeURIComponent(JSON.stringify(project));
    const url = `${server.origin}/?export=1&timeline=${encodeURIComponent(timeline)}`;
    const args = ['scripts/export-frames.mjs', '--url', url, '--out', out, '--fps', '30', '--workers', '1', ...(mode === 'ffmpeg' ? ['--audio', 'ffmpeg'] : [])];
    const code = await new Promise((resolve) => {
      // 导出进程自己按 PROMPTCUT_EXPORT_DIR 找素材文件(server/bakery/media.mjs 的 mediaRootDir),和 dev server 指到同一处
      const p = spawn(process.execPath, args, { cwd: REPO, env: { ...process.env, PROMPTCUT_EXPORT_DIR: exportDir }, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
      p.on('close', resolve);
    });
    // 带声音的是 preview.mp4(overlay.mov 只是透明的画面层)
    const video = fs.readdirSync(out).find((f) => f === 'preview.mp4') ?? fs.readdirSync(out).find((f) => /\.mp4$/i.test(f));
    if (code !== 0 || !video) { fails.push(`${mode}: 导出失败(退出码 ${code})`); continue; }
    const file = path.join(out, video);
    const rms = (from, to) => rmsOf(file, from, to);
    const w = { pre: rms(0.1, 1.9), fadeHead: rms(2.0, 2.5), fadeTail: rms(3.0, 3.5), body: rms(3.5, 6.9), post: rms(7.1, 8.9) };
    results[mode] = { file, ...w };
    // 有声段的电平要和原素材一样(段音量 1);段尾之后成片里没有声音样本(astats 量不到)或是静音都算对
    const ref = rmsOf(tone, 1, 5);
    const ok = w.pre !== null && w.pre < -60 && w.body !== null && Math.abs(w.body - ref) < 1 && Math.abs(w.fadeTail - ref) < 1
      && (w.post === null || w.post < -60) && w.fadeTail - w.fadeHead > 6;
    w.reference = ref;
    if (!ok) fails.push(`${mode}: 声音窗口不对 ${JSON.stringify(w)}`);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${mode}`, JSON.stringify(w));
  }
} finally {
  server.stop();
}
console.log(JSON.stringify({ ok: fails.length === 0, fails, results }));
process.exit(fails.length ? 1 : 0);
