/** Isolated real MOV/Chrome regression. node scripts/verify-playback.mjs */
import './lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { PNG } from 'pngjs';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { PlaybackMovStore } from '../server/frame-mov.mjs';
import { framesPlugin, frameService } from '../server/vite-plugin-frames.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(repo, 'out', `playback-check-${Date.now()}`);
const app = path.join(out, 'app');
process.env.PUPPETEER_CACHE_DIR ||= path.join(repo, 'desktop/src-tauri/runtime/chrome');
process.env.PROMPTCUT_EXPORT_DIR = path.join(out, 'exports');
const { findFfmpeg } = await import('../server/bakery/index.mjs');
const ffmpeg = await findFfmpeg();
const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
await fs.mkdir(app, { recursive: true });
const movie = new PlaybackMovStore({ dir: out, width: 16, height: 8, fps: 3, count: 6 });
await movie.ready;
const probe = () => JSON.parse(execFileSync(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_name,nb_frames,duration', '-of', 'json', movie.movieFile], { windowsHide: true }).toString());
const decode = () => execFileSync(ffmpeg, ['-v', 'error', '-i', movie.movieFile, '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], { windowsHide: true });
assert.equal(probe().streams[0].nb_frames, '6');
assert.equal(Number(probe().streams[0].duration), 2);
assert.ok(decode().every(n => n === 0));
for (const frame of [5, 0, 3]) {
  const image = new PNG({ width: 16, height: 8 }); image.data.fill(frame + 10);
  await movie.put(frame, PNG.sync.write(image));
}
const pixels = decode();
for (let n = 0; n < 6; n++) assert.ok(pixels.subarray(n * 512, (n + 1) * 512).every(v => v === ([0, 3, 5].includes(n) ? n + 10 : 0)), `MOV frame ${n}`);
await movie.close();
console.log('PASS: ffprobe full duration / ffmpeg transparent and out-of-order samples');

await fs.cp(path.join(repo, 'src'), path.join(app, 'src'), { recursive: true });
await fs.copyFile(path.join(repo, 'index.html'), path.join(app, 'index.html'));
await fs.symlink(path.join(repo, 'node_modules'), path.join(app, 'node_modules'), 'junction');
await fs.symlink(path.join(repo, 'public'), path.join(app, 'public'), 'junction');
await fs.symlink(path.join(repo, 'server'), path.join(app, 'server'), 'junction');
await fs.symlink(path.join(repo, 'scripts'), path.join(app, 'scripts'), 'junction');
await fs.writeFile(path.join(app, 'src/main.tsx'), `import './render/stageClockEntry'; import {createRoot} from 'react-dom/client'; import './index.css'; import './skins/skins.css'; import ExportView from './ExportView'; createRoot(document.getElementById('root')).render(<ExportView/>);`);
await fs.writeFile(path.join(app, 'src/cards/user/playback-test.tsx'), `export const test = { id: 'playback-test', name: 'test', defaults: {}, controls: [], frameMode: 'direct',
 Component: ({t}) => <div style={{position:'absolute',inset:0,background:'rgb('+Math.round(t*20)+',80,130)'}}/> };`);
const server = await createServer({ configFile: false, root: app, cacheDir: path.join(out, 'vite'),
  plugins: [framesPlugin(), { name: 'player-test', configureServer(server) {
    server.middlewares.use('/retry-test', async (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(await server.transformIndexHtml('/retry-test', `<html><head></head><body><div id="root"></div><script type="module">
        import React from 'react'; import {createRoot} from 'react-dom/client';
        import {UnifiedPreview} from '/src/editor/preview/UnifiedPreview.tsx';
        const original=window.fetch; window.seeAttempts=0;
        window.fetch=(url,opts)=>{if(url==='/api/frames/see' && ++window.seeAttempts===1) return Promise.reject(new TypeError('test backend offline')); return original(url,opts);};
        createRoot(document.getElementById('root')).render(React.createElement(UnifiedPreview,{project:${JSON.stringify(project)},t:0,playing:false}));
      </script></body></html>`));
    });
    server.middlewares.use('/player-test', (_req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<canvas id="player" width="160" height="90"></canvas><script type="module">import {MovPlayer} from '/src/render/movPlayer.ts'; window.errors=[]; window.player=new MovPlayer(document.querySelector('canvas'),e=>errors.push(e));</script>`);
    });
  } }, react(), tailwindcss()], server: { host: '127.0.0.1', port: 49162, hmr: false, watch: null, fs: { allow: [repo] } } });
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const pipeline = frameService(app, origin);
const project = { id: 'playback-check', width: 160, height: 90, fps: 10, duration: 6, media: [], tracks: [
  { id: 'cards', clips: [{ id: 'test', cardId: 'playback-test', start: 0, end: 6, params: {} }] },
] };
let browser;
try {
  const entry = await pipeline.entry(project);
  const streamed = [];
  const batch = await pipeline.see_frames(project, [0, .1, .2, .3], { lane: 'playback', onFrame: (frame, value) => { streamed.push(frame); assert.ok(value.buf.length); } });
  assert.deepEqual(streamed, [0, 1, 2, 3]);
  assert.equal(batch.size, 4);
  for (const [frame, value] of batch) {
    const pixels = PNG.sync.read(value.buf);
    const center = (45 * pixels.width + 80) * 4;
    assert.deepEqual([...pixels.data.subarray(center, center + 4)], [frame * 2, 80, 130, 255], `timeline pixels of frame ${frame}`);
  }
  console.log('PASS: real Chrome see_frames one forward batch, four streamed screenshots');
  const status = await pipeline.updatePlayback(project, { owner: 'test', sequence: 1, t: 0, playing: false });
  await entry.playbackMovie.put(0, batch.get(0).buf);
  await entry.playbackMovie.put(1, batch.get(1).buf);
  await entry.playbackMovie.put(3, batch.get(3).buf);
  const puppeteer = (await import('puppeteer')).default;
  browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', error => console.error('PAGE ERROR:', error.message));
  await page.goto(origin + '/player-test');
  await page.waitForFunction(() => !!window.player);
  const ready = { ...status, ...entry.playbackMovie.index(0, 59), movie: origin + status.movie, metrics: { stride: 1 } };
  await page.evaluate(s => window.player.update(s), ready);
  const show = async (time, frame) => {
    await page.evaluate(t => window.player.draw(t), time);
    await page.waitForFunction(([t, frame]) => { window.player.draw(t); return Number(document.querySelector('canvas').dataset.frame) === frame; }, {}, [time, frame]);
  };
  await show(0, 0); await show(.1, 1);
  await page.evaluate(() => window.player.draw(.2));
  assert.equal(await page.$eval('canvas', c => Number(c.dataset.frame)), -1, 'missing sample is not an old frame');
  await show(.3, 3);
  await page.evaluate(() => window.player.draw(.4)); // Evict frame 3 with stride 1.
  await page.evaluate(s => window.player.update(s), { ...ready, metrics: { stride: 10 } });
  // A wider sampling interval can finish decoding older samples after a blank.
  // They must not make forward playback go backwards, even for one RAF.
  for (let n = 0; n < 12; n++) {
    const shown = await page.evaluate(() => { window.player.draw(.4); return Number(document.querySelector('canvas').dataset.frame); });
    assert.ok(shown === -1 || shown >= 3, `late decoded frame regressed to ${shown}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  for (let n = 0; n < 12; n++) {
    const shown = await page.evaluate(() => { window.player.draw(.8); return Number(document.querySelector('canvas').dataset.frame); });
    assert.ok(shown === -1 || shown >= 3, `RAF stall regressed to ${shown}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await show(0, 0);
  assert.deepEqual(await page.evaluate(() => window.errors), []);
  console.log('PASS: browser reads HTTP 206 ranges from MOV; clock selects exact frames; missing frame / backward seek are clean');
  // Repeated heartbeats must not cancel peers or restart completed work.
  for (let n = 1; n <= 12; n++) {
    const response = await fetch(origin + '/api/frames/playback', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project, owner: 'test', sequence: n + 1, t: n / 10, playing: true }) });
    assert.equal(response.status, 200);
    const current = await response.json();
    await page.evaluate(s => window.player.update(s), { ...current, movie: origin + current.movie });
    await page.evaluate(t => window.player.draw(t), n / 10);
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await pipeline.updatePlayback(project, { owner: 'test', sequence: 99, t: 1.2, playing: false });
  assert.equal(pipeline.playback.playing, false);
  assert.ok(pipeline.playback.epoch <= 3, 'ordinary heartbeats cannot cause seek storms');
  assert.ok(pipeline.playback.rendered > 0, 'HTTP heartbeats and the renderer must share one service');
  console.log('PASS: live scheduler heartbeat / pause', pipeline.playback.status().metrics);
  await page.goto(origin + '/retry-test');
  await page.waitForFunction(() => window.seeAttempts >= 2 && [...document.images].some(img => img.complete && img.naturalWidth === 160), { timeout: 15000 });
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('[role="status"]')].some(el => el.textContent.includes('连接中断'))), false);
  console.log('PASS: paused preview retries a backend outage without a seek or reload');
  await fs.writeFile(path.join(out, 'result.json'), JSON.stringify({ probe: probe(), streamed, metrics: pipeline.playback.status().metrics }, null, 2));
} finally {
  await browser?.close(); await pipeline.close(); await server.close();
}
console.log(`Playback regression artifacts: ${out}`);
