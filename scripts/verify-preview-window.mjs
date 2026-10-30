/** Real Chrome regression: windowed random access must match full history.
 * Optional: node scripts/verify-preview-window.mjs --project "...project.proc"
 * All custom sources/cache/output are isolated under out; input stays read-only.
 */
import './lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { PNG } from 'pngjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(repo, 'out', `preview-window-${Date.now()}`);
const app = path.join(out, 'app');
process.env.PUPPETEER_CACHE_DIR ||= path.join(repo, 'desktop/src-tauri/runtime/chrome');
process.env.PROMPTCUT_DATA_DIR = path.join(out, 'data');
const testFont = await fs.readFile(path.join(process.env.WINDIR || 'C:/Windows', 'Fonts/arial.ttf')).catch(() => null);
const { FramePipeline } = await import('../server/frame-pipeline.mjs');
const { bakeFrames, findFfmpeg } = await import('../server/bakery/index.mjs');
const arg = process.argv.indexOf('--project');
const document = arg < 0 ? null : JSON.parse(await fs.readFile(process.argv[arg + 1], 'utf8'));
await fs.mkdir(app, { recursive: true });
await fs.cp(path.join(repo, 'src'), path.join(app, 'src'), { recursive: true });
await fs.copyFile(path.join(repo, 'index.html'), path.join(app, 'index.html'));
await fs.symlink(path.join(repo, 'node_modules'), path.join(app, 'node_modules'), 'junction');
await fs.symlink(path.join(repo, 'public'), path.join(app, 'public'), 'junction');
await fs.symlink(path.join(repo, 'server'), path.join(app, 'server'), 'junction');
await fs.writeFile(path.join(app, 'src/main.tsx'), `
import './render/stageClockEntry';
import { createRoot } from 'react-dom/client';
import './index.css';
import './skins/skins.css';
import ExportView from './ExportView';
createRoot(document.getElementById('root')!).render(<ExportView />);
`);
for (const card of document?.cards || []) {
  assert.match(card.id, /^[\w-]+$/);
  await fs.writeFile(path.join(app, 'src/cards/user', card.id + '.tsx'), card.source);
}
// A genuinely static full-length overlay must not force replay from frame 0.
await fs.writeFile(path.join(app, 'src/cards/user/preview-static.tsx'), `
export const previewStatic = { id: 'preview-static', name: 'test', defaults: {}, controls: [],
  lifecycle: { after: 'hold', settleMs: 0 },
  Component: () => <div style={{position:'absolute',inset:0,border:'4px solid #136'}} /> };
`);
await fs.writeFile(path.join(app, 'src/cards/user/preview-direct.tsx'), `
import { useEffect, useState } from 'react';
import { beginFrameWork } from '../../kernel/frameReady';
export const direct = { id: 'preview-direct', name: 'direct', defaults: {}, controls: [], frameMode: 'direct',
  Component: ({t}) => { (window.__directTimes ||= []).push(t); return <div style={{width:100+t*10,height:30,background:'#f70'}} />; } };
export const delayed = { id: 'preview-delayed', name: 'delayed', defaults: {}, controls: [], frameMode: 'direct',
  Component: () => {
    const [loaded, setLoaded] = useState(false);
    useEffect(() => {
      const ready = beginFrameWork('delayed test control');
      let raf;
      const timer = setTimeout(() => { setLoaded(true); raf = requestAnimationFrame(() => ready.ready()); }, 180);
      return () => { clearTimeout(timer); cancelAnimationFrame(raf); ready.dispose(); };
    }, []);
    return <div data-delayed={loaded} style={{position:'absolute',inset:0,background:loaded?'#008800':'#880000'}} />;
  } };
export const font = { id: 'preview-font', name: 'font', defaults: {}, controls: [], frameMode: 'direct',
  Component: () => <div><style>{'@font-face{font-family:PreviewTestFont;src:url(/test-delayed-font)}'}</style><div style={{fontFamily:'PreviewTestFont',fontSize:48,color:'white'}}>Font Ready</div></div> };
`);
// Start in the high port range; Vite can choose the next free port.
// Port 0 previously resolved to 6000, which Chrome blocks as unsafe.
const server = await createServer({ configFile: false, root: app, cacheDir: path.join(out, 'vite'),
  plugins: [{ name: 'delayed-test-font', configureServer(server) {
    server.middlewares.use('/test-delayed-font', (_req, res) => {
      setTimeout(() => { res.setHeader('Content-Type', 'font/ttf'); res.end(testFont); }, 200);
    });
  } }, react(), tailwindcss()], server: { host: '127.0.0.1', port: 49152, hmr: false, watch: null,
    fs: { allow: [repo, ...new Set((document?.project.media || []).filter(m => m.path).map(m => path.dirname(m.path)))] } },
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const service = new FramePipeline({ root: path.join(out, 'cache'), origin: () => origin });
const results = [];
let bakery;
const base = { id: 'preview-test', width: 640, height: 360, fps: 30, duration: 20, media: [], tracks: [] };
const clip = (id, cardId, start, end, params = {}) => ({ id, cardId, start, end, params });
const track = (...clips) => ({ id: 'cards', clips });
async function render(project, frames, reference = false) {
  if (!bakery) bakery = await service.bakery(project);
  else await bakery.reset(project, service.emptyUrl(project), { deferCards: true });
  const images = new Map();
  const before = performance.now();
  const baked = await bakeFrames(bakery, { out, targetFrames: frames, fullFrame: true,
    seekFromActiveClips: !reference, writeFrames: false,
    onFrame: (n, buf) => images.set(n, buf),
  });
  return { images, start: baked.advanceStartFrame, steps: baked.advancedFrames, ms: Math.round(performance.now() - before),
    directTimes: await bakery.page.evaluate(() => window.__directTimes || []) };
}
async function compare(name, project, frames) {
  const reference = await render(project, frames, true);
  for (const frame of frames) {
    const current = await render(project, [frame]);
    const actual = PNG.sync.read(current.images.get(frame)).data;
    const expected = PNG.sync.read(reference.images.get(frame)).data;
    let changed = 0, maxDiff = 0;
    for (let i = 0; i < actual.length; i++) if (actual[i] !== expected[i]) { changed++; maxDiff = Math.max(maxDiff, Math.abs(actual[i] - expected[i])); }
    const item = { name, frame, start: current.start, steps: current.steps, baselineSteps: frame + 1, ms: current.ms, changed, maxDiff };
    results.push(item); console.log('CHECK', JSON.stringify(item));
    if (changed) {
      await fs.writeFile(path.join(out, `${name}-${frame}-reference.png`), reference.images.get(frame));
      await fs.writeFile(path.join(out, `${name}-${frame}-actual.png`), current.images.get(frame));
      const singleReference = await render(project, [frame], true);
      console.log('SINGLE REFERENCE MATCH', PNG.sync.read(singleReference.images.get(frame)).data.equals(actual));
    }
    assert.equal(changed, 0, `${name} frame ${frame}: ${changed} channels differ (max ${maxDiff})`);
  }
}
try {
  await compare('motion', { ...base, tracks: [track(
    clip('expired', 'punch-pill', 0, 4, { text: 'Old' }),
    clip('first', 'punch-pill', 5.05, 9, { text: 'Preview' }),
    clip('second', 'blur-text', 5.4, 9, { text: 'Later' }),
    clip('static', 'preview-static', 0, 20),
  )] }, [150, 151, 154, 162, 163, 175, 190]);
  const captions = { ...base, tracks: [track(clip('captions', 'caption-track', 0, 20, {
    lines: '0|5|First // 5|8|Second // 9|10|After gap // 10|10.1|Quick1 // 10.1|10.2|Quick2 // 10.2|10.3|Quick3 // 10.3|18|Last',
  }))] };
  await compare('captions', captions, [149, 150, 151, 155, 156, 159, 162, 164, 239, 240, 269, 270, 271, 299, 300, 306, 309, 312, 320, 539]);
  assert.ok(results.filter(r => r.name === 'captions').every(r => r.steps === 1), 'Direct captions must have no history frames');
  const directOnly = { ...base, duration: 620, tracks: [track(clip('direct', 'preview-direct', 0, 620), clip('paper', 'preview-static', 0, 620))] };
  const directBatch = await render(directOnly, [3, 18015, 1000]);
  assert.equal(directBatch.steps, 3, 'direct-evaluation batch must visit only its three target frames');
  assert.ok(directBatch.directTimes.every(t => [0.1, 18015/30, 1000/30].includes(t)));
  const mixedDirect = { ...directOnly, tracks: [track(...directOnly.tracks[0].clips, clip('motion', 'punch-pill', 599, 605, { text: 'History' }))] };
  const mixedFrame = await render(mixedDirect, [18015]);
  assert.ok(mixedFrame.steps > 1);
  assert.ok(mixedFrame.directTimes.length > 0 && mixedFrame.directTimes.every(t => t === 600.5), 'Direct cards must not see any stateful history times');
  const delayedFrame = await render({ ...base, tracks: [track(clip('delayed', 'preview-delayed', 0, 20))] }, [300]);
  assert.equal(delayedFrame.steps, 1);
  assert.equal(await bakery.page.$eval('[data-delayed]', e => e.dataset.delayed), 'true', 'capture must await async control initialization');
  assert.deepEqual(await bakery.page.evaluate(() => window.__pcFrameWorkStatus()), []);
  const delayedPixels = PNG.sync.read(delayedFrame.images.get(300)).data;
  assert.deepEqual([...delayedPixels.subarray(0, 4)], [0, 136, 0, 255], 'capture must contain the committed ready state, not the loading state');
  results.push({ name: 'direct-evaluation-and-delayed-control', batchSteps: directBatch.steps, mixedSteps: mixedFrame.steps, delayedMs: delayedFrame.ms });
  if (testFont) {
    const fontFrame = await render({ ...base, tracks: [track(clip('font', 'preview-font', 0, 20))] }, [300]);
    assert.equal(fontFrame.steps, 1);
    assert.equal(await bakery.page.evaluate(() => document.fonts.check('48px PreviewTestFont')), true, 'capture must wait for the delayed webfont');
    results.push({ name: 'delayed-font', ms: fontFrame.ms });
  }
  await compare('lottie-ready', { ...base, tracks: [track(clip('lottie', 'lottie', 2, 4))] }, [65, 72]);
  await compare('particles-ready', { ...base, tracks: [track(clip('particles', 'particles', 2, 4, { quantity: 8, seed: 123 }))] }, [65, 72]);
  await render({ ...base, tracks: [track(clip('three', 'scene-3d', 0, 4))] }, [15]);
  assert.equal(await bakery.page.$eval('canvas', c => c.width > 0 && c.height > 0), true);
  assert.deepEqual(await bakery.page.evaluate(() => window.__pcFrameWorkStatus()), []);
  results.push({ name: 'three-ready', passed: true });
  const near = { ...base, tracks: [track(clip('card', 'punch-pill', 5, 9, { text: 'Shift' }))] };
  const far = { ...near, duration: 620, tracks: [track(clip('card', 'punch-pill', 605, 609, { text: 'Shift' }))] };
  const a = await render(near, [159]), b = await render(far, [18159]);
  assert.equal(a.steps, b.steps);
  assert.deepEqual(PNG.sync.read(a.images.get(159)).data, PNG.sync.read(b.images.get(18159)).data);
  results.push({ name: 'shift-600s', steps: b.steps, ms: b.ms });
  const mediaFile = path.join(out, 'seek.webm');
  execFileSync(await findFfmpeg(), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=2', '-c:v', 'libvpx-vp9', '-y', mediaFile], { windowsHide: true });
  const media = { ...base, duration: 610, media: [{ id: 'v', kind: 'video', url: '/@fs/' + mediaFile.replaceAll('\\', '/') }],
    tracks: [track({ id: 'video', mediaId: 'v', start: 600, end: 602, mediaOffset: 0, params: {} })] };
  const movie = await render(media, [18015]);
  assert.equal(movie.steps, 1, 'media must directly seek; no animation history');
  assert.ok(PNG.sync.read(movie.images.get(18015)).data.some(v => v > 0));
  results.push({ name: 'video-600s', steps: movie.steps, ms: movie.ms });
  const imageFile = path.join(out, 'image.png');
  const png = new PNG({ width: 640, height: 360 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set([60, 120, 180, 255], i);
  await fs.writeFile(imageFile, PNG.sync.write(png));
  const imageProject = { ...base, duration: 1,
    media: [{ id: 'image', kind: 'image', url: '/@fs/' + imageFile.replaceAll('\\', '/') }],
    tracks: [track({ id: 'image-clip', mediaId: 'image', start: 0, end: 1, params: {} })] };
  await bakery.reset(imageProject, service.emptyUrl(imageProject), { deferCards: true });
  let imageRequests = 0;
  bakery.page.on('request', req => { if (req.url().includes('/image.png')) imageRequests++; });
  await bakeFrames(bakery, { out, frames: '0-2', snapshotOnly: true, onSnapshot: () => {} });
  assert.equal(imageRequests, 0, 'HTML advancement must not request timeline images');
  await bakeFrames(bakery, { out, targetFrames: [2], fullFrame: true, writeFrames: false });
  assert.ok(imageRequests > 0, 'capture must load the image');
  const mapped = { ...imageProject, pixelMaps: [{ id: 'map', name: 'Solid', source: { stage: 'origin' },
    mode: 'continuous', where: '1', to: { kind: 'color', value: '#ff6600' } }],
    tracks: [track({ ...imageProject.tracks[0].clips[0], pixelMap: { id: 'map' } })] };
  const mappedImage = await render(mapped, [2]);
  const mappedPixels = PNG.sync.read(mappedImage.images.get(2)).data;
  assert.deepEqual([...mappedPixels.subarray((180 * 640 + 320) * 4, (180 * 640 + 320) * 4 + 4)], [255, 102, 0, 255], 'pixel map must draw after media decoding and before capture');
  assert.deepEqual(await bakery.page.$$eval('[data-pc-media-hidden]', els => els.map(el => getComputedStyle(el).visibility)), ['hidden']);
  results.push({ name: 'deferred-images-and-pixel-map', passed: true });
  if (document) {
    const project = structuredClone(document.project);
    project.media = project.media.map(m => m.path ? { ...m, url: '/@fs/' + m.path.replaceAll('\\', '/') } : m);
    await compare('real', project, [2400, 2481, 2487, 2592, 2640]);
    await bakery.close(); bakery = null;
    await service.prewarmUser(project);
    const pids = service.userPool.map(s => s.bakery.browser.process().pid);
    for (const t of [80.1, 86.5, 52.8, 83.3, 88.1, 65.6, 76.5]) {
      const before = performance.now();
      const frames = await service.see_frames(project, [t], { lane: 'inter_face' });
      assert.ok(frames.get(Math.round(t * project.fps))?.buf.length);
      assert.deepEqual(service.userPool.map(s => s.bakery.browser.process().pid), pids, 'hot Chrome must not restart');
      const item = { name: 'real-inter_face', time: t, ms: Math.round(performance.now() - before), pids };
      results.push(item); console.log('CHECK', JSON.stringify(item));
    }
    // Real simultaneous lanes, not mocked: the 60 UI pointer events collapse
    // to the last one, while all 60 Agent calls finish on their own Chrome.
    let seed = 7;
    const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const agentRequests = Array.from({ length: 60 }, () => service.see_frames(project, [random() * 88], { lane: 'agent' }));
    const allAgents = Promise.allSettled(agentRequests);
    const old = service.see_frames(project, [50.3], { lane: 'inter_face' });
    const oldResult = Promise.allSettled([old]);
    await new Promise(resolve => setTimeout(resolve, 35));
    const beforeBurst = performance.now();
    const userRequests = Array.from({ length: 60 }, (_, i) => service.see_frames(project, [i === 59 ? 88.2 : random() * 88], { lane: 'inter_face' }));
    const burst = await Promise.allSettled(userRequests);
    assert.equal(burst.at(-1).status, 'fulfilled');
    assert.ok(burst.at(-1).value.get(2646)?.buf.length);
    assert.ok(burst.slice(0, -1).every(r => r.status === 'rejected' && r.reason.cancelled));
    assert.deepEqual(service.userPool.map(s => s.bakery.browser.process().pid), pids);
    const burstMs = Math.round(performance.now() - beforeBurst);
    console.log('CHECK', JSON.stringify({ name: '60-user-latest-with-60-agent', ms: burstMs, lastFrame: 2646 }));
    await oldResult;
    const agents = await allAgents;
    assert.ok(agents.every(r => r.status === 'fulfilled'), agents.find(r => r.status === 'rejected')?.reason?.stack);
    const agentPid = service.lanes.get('agent').bakery.browser.process().pid;
    assert.ok(!pids.includes(agentPid));
    results.push({ name: '60-user-with-60-agent', userLatestMs: burstMs, userLastFrame: 2646, completedAgents: agents.length, userPids: pids, agentPid });
  }
  console.log('PASS: active-card windows, subtitle transitions, shifted timeline, direct media seek, real user lane.');
} finally {
  await fs.writeFile(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
  console.log('Artifacts:', out);
  await bakery?.close(); await service.close(); await server.close();
}
