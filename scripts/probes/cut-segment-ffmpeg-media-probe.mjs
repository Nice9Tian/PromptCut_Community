/**
 * 显式 `--media=ffmpeg` 导出遇到剪辑段里的视频 / 图片:改走缺省的完整整帧路线,成片里画得出它们
 * (剪辑段首版局限补齐第 4 项,`docs/archive/agent-reports/AGENT-cut-segment-followups.md`;`server/bakery/export.mjs` 的 `cutSegmentsHaveVisualMedia`)。
 *
 *   node scripts/probes/cut-segment-ffmpeg-media-probe.mjs [--port 5376] [--out <目录>]
 *
 * 做法:在 <目录>/export/media 下用 ffmpeg 生成一段 4 秒纯红视频 `red.mp4`,起一台本树 dev server(PROMPTCUT_EXPORT_DIR 指到
 * <目录>/export,端口 --port 与 +1、+2 要空着,不碰 5190～5192),导出这个项目:
 *   剪辑2:一条序列,red.mp4 0～4 秒;
 *   剪辑1(激活,5 秒):一张文字卡 0～5 秒;一个剪辑段 1～4 秒引用剪辑2,框缩放 0.5、左上角(画面左上四分之一)。
 * 两遍:`--media ffmpeg` 与缺省。断言:
 *   F1 `--media ffmpeg` 那一遍日志里写明改走完整整帧路线;
 *   F2 两遍成片 2 秒处左上四分之一中心是红色(剪辑段里的视频画出来了),右下四分之一中心不是红色;
 *   F3 两遍成片 0.5 秒处(剪辑段之前)左上四分之一中心不是红色。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { startDevServer, REPO } from '../lib/dev-server.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 20 * 60_000).unref();
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 5376));
const OUT = path.resolve(arg('--out', path.join(REPO, 'out', 'cut-segment-ffmpeg-media')));
const exportDir = path.join(OUT, 'export');
fs.mkdirSync(path.join(exportDir, 'media'), { recursive: true });
const red = path.join(exportDir, 'media', 'red.mp4');
const ff = spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=30:d=4', '-pix_fmt', 'yuv420p', red], { windowsHide: true });
if (ff.status !== 0) throw new Error('ffmpeg 生成红色视频失败:' + ff.stderr);

const W = 640, H = 360;
const project = {
  version: 1, id: 'p-cut-ffmpeg-media', name: 'cut-ffmpeg-media', width: W, height: H, fps: 30, duration: 5, themeId: 'midnight',
  media: [{ id: 'm-red', kind: 'video', name: 'red.mp4', url: '/@media/red.mp4', duration: 4, width: 320, height: 180 }],
  tracks: [
    { id: 't1', name: '序列 1', clips: [{ id: 's1', cardId: '', cutId: 'cut-2', start: 1, end: 4, frame: { x: 0, y: 0, scale: 0.5 }, params: {} }] },
    { id: 't0', name: '序列 2', clips: [{ id: 'k1', cardId: 'punch-pill', start: 0, end: 5, params: { text: '底下的卡' } }] },
  ],
  cuts: [
    { id: 'cut-1', name: '剪辑1' },
    { id: 'cut-2', name: '剪辑2', tracks: [{ id: 't2', name: '序列 1', clips: [{ id: 'v1', cardId: '', mediaId: 'm-red', mediaOffset: 0, start: 0, end: 4, params: {} }] }], duration: 4, transitions: [] },
  ],
  activeCutId: 'cut-1',
};

/** 成片 t 秒那一帧,(x, y) 处的 RGB */
function pixelAt(file, t, x, y) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(t), '-i', file, '-frames:v', '1', '-vf', `format=rgb24,crop=1:1:${x}:${y}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { windowsHide: true });
  const b = r.stdout;
  return b && b.length >= 3 ? [b[0], b[1], b[2]] : null;
}
const isRed = (p) => !!p && p[0] > 180 && p[1] < 80 && p[2] < 80;

const server = await startDevServer({ env: { PROMPTCUT_EXPORT_DIR: exportDir }, logFile: path.join(OUT, 'vite.log'), port: PORT, log: (m) => console.log('[dev]', m) });
const fails = [];
const results = {};
const check = (key, cond, note, extra) => {
  results[key] = { ok: !!cond, note, ...(extra !== undefined ? { extra } : {}) };
  if (!cond) fails.push(`${key}: ${note}`);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${key} ${note} ${extra !== undefined ? JSON.stringify(extra) : ''}`);
};
try {
  for (const mode of ['ffmpeg', 'chrome']) {
    const out = path.join(OUT, mode);
    fs.rmSync(out, { recursive: true, force: true });
    const timeline = 'data:application/json,' + encodeURIComponent(JSON.stringify(project));
    const url = `${server.origin}/?export=1&timeline=${encodeURIComponent(timeline)}`;
    const args = ['scripts/export-frames.mjs', '--url', url, '--out', out, '--fps', '30', '--workers', '1', ...(mode === 'ffmpeg' ? ['--media', 'ffmpeg'] : [])];
    let log = '';
    const code = await new Promise((resolve) => {
      const p = spawn(process.execPath, args, { cwd: REPO, env: { ...process.env, PROMPTCUT_EXPORT_DIR: exportDir }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      p.stdout.on('data', (d) => { log += d; });
      p.stderr.on('data', (d) => { log += d; });
      p.on('close', resolve);
    });
    fs.writeFileSync(path.join(OUT, `${mode}.log`), log);
    const file = path.join(out, 'preview.mp4');
    check(`${mode}-export`, code === 0 && fs.existsSync(file), `${mode} 导出成功(退出码 ${code})`);
    if (!fs.existsSync(file)) continue;
    if (mode === 'ffmpeg') check('F1', /剪辑段里有视频或图片/.test(log), '--media ffmpeg:日志写明改走完整整帧路线');
    const inSeg = pixelAt(file, 2, W / 4, H / 4), outside = pixelAt(file, 2, (3 * W) / 4, (3 * H) / 4), before = pixelAt(file, 0.5, W / 4, H / 4);
    check(`F2-${mode}`, isRed(inSeg) && !isRed(outside), `${mode}:2 秒处左上四分之一是剪辑段里的红色视频,右下不是`, { inSeg, outside });
    check(`F3-${mode}`, !!before && !isRed(before), `${mode}:0.5 秒(剪辑段之前)左上不是红色`, { before });
    spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '2', '-i', file, '-frames:v', '1', path.join(OUT, `${mode}-2s.png`)], { windowsHide: true });
  }
} finally {
  server.stop();
}
console.log(JSON.stringify({ ok: fails.length === 0, fails, results }));
process.exit(fails.length ? 1 : 0);
