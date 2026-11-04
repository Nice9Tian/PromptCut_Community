/**
 * Explicit `--media=ffmpeg` export encounters video/image inside a cut segment: falls back to
 * default full whole-frame route, so they can be rendered in final video (cut segment initial
 * version limitations follow-up item 4, `docs/archive/agent-reports/AGENT-cut-segment-followups.md`;
 * `cutSegmentsHaveVisualMedia` in `server/bakery/export.mjs`).
 *
 *   node scripts/probes/cut-segment-ffmpeg-media-probe.mjs [--port 5376] [--out <dir>]
 *
 * Procedure: use ffmpeg under <dir>/export/media to generate a 4-second pure red video `red.mp4`,
 * start a dev server in this checkout (PROMPTCUT_EXPORT_DIR pointing to <dir>/export,
 * ports --port, +1, and +2 must be free, avoiding 5190-5192), and export this project:
 *   Cut 2: one track, red.mp4 0-4s;
 *   Cut 1 (active, 5s): one text card 0-5s; one cut segment 1-4s referencing Cut 2,
 *   frame scale 0.5, top-left corner (top-left quadrant of video).
 * Two passes: `--media ffmpeg` and default. Assertions:
 *   F1 The `--media ffmpeg` pass explicitly logs switching to the full whole-frame route;
 *   F2 In both passes, the center of top-left quadrant at 2s in final video is red
 *      (video in cut segment was rendered), and center of bottom-right quadrant is not red;
 *   F3 In both passes, the center of top-left quadrant at 0.5s in final video
 *      (before cut segment) is not red.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
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
if (ff.status !== 0) throw new Error('ffmpeg failed to generate the red video:' + ff.stderr);

const W = 640, H = 360;
const project = {
  version: 1, id: 'p-cut-ffmpeg-media', name: 'cut-ffmpeg-media', width: W, height: H, fps: 30, duration: 5, themeId: 'midnight',
  media: [{ id: 'm-red', kind: 'video', name: 'red.mp4', url: '/@media/red.mp4', duration: 4, width: 320, height: 180 }],
  tracks: [
    { id: 't1', name: 'Track 1', clips: [{ id: 's1', cardId: '', cutId: 'cut-2', start: 1, end: 4, frame: { x: 0, y: 0, scale: 0.5 }, params: {} }] },
    { id: 't0', name: 'Track 2', clips: [{ id: 'k1', cardId: 'punch-pill', start: 0, end: 5, params: { text: '底下的卡' } }] },
  ],
  cuts: [
    { id: 'cut-1', name: 'Cut 1' },
    { id: 'cut-2', name: 'Cut 2', tracks: [{ id: 't2', name: 'Track 1', clips: [{ id: 'v1', cardId: '', mediaId: 'm-red', mediaOffset: 0, start: 0, end: 4, params: {} }] }], duration: 4, transitions: [] },
  ],
  activeCutId: 'cut-1',
};

/** RGB at (x, y) of the frame at t seconds in the final video */
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
    check(`${mode}-export`, code === 0 && fs.existsSync(file), `${mode} export succeeded (exit code ${code})`);
    if (!fs.existsSync(file)) continue;
    if (mode === 'ffmpeg') check('F1', /cut segment contains video or images/.test(log), '--media ffmpeg: the log states that it switches to the full whole-frame route');
    const inSeg = pixelAt(file, 2, W / 4, H / 4), outside = pixelAt(file, 2, (3 * W) / 4, (3 * H) / 4), before = pixelAt(file, 0.5, W / 4, H / 4);
    check(`F2-${mode}`, isRed(inSeg) && !isRed(outside), `${mode}: at 2 seconds the top-left quarter is the red video in the cut segment, the bottom-right is not`, { inSeg, outside });
    check(`F3-${mode}`, !!before && !isRed(before), `${mode}: at 0.5 seconds (before the cut segment) the top-left is not red`, { before });
    spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-ss', '2', '-i', file, '-frames:v', '1', path.join(OUT, `${mode}-2s.png`)], { windowsHide: true });
  }
} finally {
  server.stop();
}
console.log(JSON.stringify({ ok: fails.length === 0, fails, results }));
process.exit(fails.length ? 1 : 0);
