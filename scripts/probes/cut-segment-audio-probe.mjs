/**
 * End-to-end probe for cut segment audio entering exported final video (two paths: Chrome mix and
 * ffmpeg).
 *
 *   node scripts/probes/cut-segment-audio-probe.mjs --port 5353 --out <dir>
 *
 * Method: generate a 6-second 440 Hz sine wave `tone.wav` under <dir>/export/media using ffmpeg,
 * start a dev server from this tree (with PROMPTCUT_EXPORT_DIR pointing to <dir>/export, port
 * `--port` and +1, +2 free, not touching 5190-5192), export the following project (with audio):
 *   Cut 2: one track, tone 0-6 seconds;
 *   Cut 1 (active): one cut segment, start at 2 seconds, end at 7 seconds, `cutOffset` 1, fade-in
 *     1 second, referencing cut 2; total duration 9 seconds.
 * Expected final video audio: silence for 0-2 seconds; fade-in for 2-3 seconds; sine wave for 3-7
 * seconds (taken from seconds 1-5 of tone); silence for 7-9 seconds.
 * Assertions: measure RMS (dB) of each segment using ffmpeg astats: before segment < -60 dB; level
 * difference between seconds 3-7 and original asset seconds 1-5 is less than 1 dB; silence or no
 * audio samples after segment; fade-in segment 2.0-2.5 seconds RMS is more than 6 dB lower than
 * 3-3.5 seconds.
 * Export once via each of the two paths (default Chrome mix; `--audio ffmpeg`). The last line
 * prints a JSON line.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
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
if (ff.status !== 0) throw new Error('ffmpeg failed to generate the sine wave:' + ff.stderr);

const project = {
  version: 1, id: 'p-cut-audio', name: 'cut-audio', width: 640, height: 360, fps: 30, duration: 9, themeId: 'midnight',
  media: [{ id: 'm-tone', kind: 'audio', name: 'tone.wav', url: '/@media/tone.wav', duration: 6 }],
  tracks: [{ id: 't1', name: 'Track 1', clips: [{ id: 's1', cardId: '', cutId: 'cut-2', cutOffset: 1, start: 2, end: 7, fadeIn: 1, params: {} }] }],
  cuts: [
    { id: 'cut-1', name: 'Cut 1' },
    { id: 'cut-2', name: 'Cut 2', tracks: [{ id: 't2', name: 'Track 1', clips: [{ id: 'a1', cardId: '', mediaId: 'm-tone', mediaOffset: 0, start: 0, end: 6, params: {} }] }], duration: 6, transitions: [] },
  ],
  activeCutId: 'cut-1',
};

const server = await startDevServer({ env: { PROMPTCUT_EXPORT_DIR: exportDir }, logFile: path.join(OUT, 'vite.log'), port: PORT, log: (m) => console.log('[dev]', m) });
/** Overall RMS (dB) of a file for [from, to) seconds; null when there are no audio samples */
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
      // The export process locates asset files by PROMPTCUT_EXPORT_DIR itself (mediaRootDir in
      // server/bakery/media.mjs), pointing to the same location as the dev server
      const p = spawn(process.execPath, args, { cwd: REPO, env: { ...process.env, PROMPTCUT_EXPORT_DIR: exportDir }, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
      p.on('close', resolve);
    });
    // The one with audio is preview.mp4 (overlay.mov is only a transparent video layer)
    const video = fs.readdirSync(out).find((f) => f === 'preview.mp4') ?? fs.readdirSync(out).find((f) => /\.mp4$/i.test(f));
    if (code !== 0 || !video) { fails.push(`${mode}: export failed (exit code ${code})`); continue; }
    const file = path.join(out, video);
    const rms = (from, to) => rmsOf(file, from, to);
    const w = { pre: rms(0.1, 1.9), fadeHead: rms(2.0, 2.5), fadeTail: rms(3.0, 3.5), body: rms(3.5, 6.9), post: rms(7.1, 8.9) };
    results[mode] = { file, ...w };
    // The level of the audio segment must match original asset (segment volume 1); no audio samples
    // in the final video after segment end (astats cannot measure) or silence is considered correct
    const ref = rmsOf(tone, 1, 5);
    const ok = w.pre !== null && w.pre < -60 && w.body !== null && Math.abs(w.body - ref) < 1 && Math.abs(w.fadeTail - ref) < 1
      && (w.post === null || w.post < -60) && w.fadeTail - w.fadeHead > 6;
    w.reference = ref;
    if (!ok) fails.push(`${mode}: wrong sound window ${JSON.stringify(w)}`);
    console.log(`${ok ? 'PASS' : 'FAIL'} ${mode}`, JSON.stringify(w));
  }
} finally {
  server.stop();
}
console.log(JSON.stringify({ ok: fails.length === 0, fails, results }));
process.exit(fails.length ? 1 : 0);
