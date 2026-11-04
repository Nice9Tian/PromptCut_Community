/**
 * Probe for directly opening `.proc` (not `.procp`) across machines (`docs/plan/TODO.md` "Asset paths
 * when opening projects across machines"):
 *
 *   1. **Instance A** (its own temporary data directory): create project: one imported video (with
 *      hash), one audio ingested via store API (with hash, 440 Hz), both on the timeline; save as
 *      `.proc` text. The `path` for both assets points to A's content store directory.
 *   2. **Instance B** (data directory is empty, but content store already has these two sets of
 *      bytes: before running, put A's bytes into B as-is via B's upload API: equivalent to "another
 *      machine's content store already has these hashes"): directly open this `.proc`. Assets are
 *      restored by hash and not marked "(missing)"; A's path cannot be read by path on B
 *      (`/api/media/file?path=…` returns non-2xx, showing reading by path before the change
 *      definitely failed); export final video: has video (video frame is not a solid color), has
 *      audio track, and the 440 Hz section is not silent.
 *   3. **Instance C** (data directory is empty, content store does not have these bytes either):
 *      open the same `.proc`; background check after opening marks both assets "(missing)" (adds
 *      marker to name, writes "confirmed missing" record; address and hash are retained).
 *   4. **Instance C, missing legacy video outputs placeholder in original position when exporting**
 *      (since 0.7.18; previously this section was skipped,
 *      `docs/archive/agent-reports/AGENT-maint-4.md` item 3): create new project, place one video
 *      imported in C (0-3 s), one 660 Hz audio stored into C (0.5-2.5 s), then place one video of
 *      **legacy format with only `path`** (A's file path, no hash, 1-2 s); wait for background
 *      check to mark it "(missing)" and write record. Export from top bar "Export video" (no Save As
 *      API, stays in artifact directory): export completes, does not report decode failure, no
 *      clips skipped; at 1.5 s in final video is "Asset not found" placeholder, surrounded by normal
 *      video; audio after 2 s is 660 Hz; clip referencing it in project.json used for export
 *      remains.
 *
 *   node scripts/probes/cross-machine-proc-probe.mjs [--port-a 6070] [--port-b 6075] [--port-c 6080] [--out <temp-dir>] [--keep]
 *
 * Ports: each editor additionally occupies "port +1" and "port +2" as stage ports; all three
 * consecutive numbers must be available (prerender process picks free ports by the editor itself).
 * Data directory, export directory, and project directory are all under `--out` (defaults to creating
 * a new one in system temporary directory), not touching the user's `Videos\PromptCut`.
 * The last line of output is a line of JSON: `{ ok, ..., fails }`, exit code 0 = all pass.
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startDevServer } from '../lib/dev-server.mjs';
import { findFfmpeg } from '../../server/bakery/ffmpeg.mjs';

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT_A = Number(arg('--port-a', 6070));
const PORT_B = Number(arg('--port-b', 6075));
const PORT_C = Number(arg('--port-c', 6080));
const RUN = Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
const OUT = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-cross-proc-${RUN}`)));
const KEEP = args.includes('--keep');

const fails = [];
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return !!cond; };
const log = (...a) => console.error('[cross-proc]', ...a);
/**
 * Wait for this instance's prerender process to be ready (`/api/prerender/info` returns ready). Export
 * requires it; when the instance just starts it might still be starting up, and the page side waits
 * only 10 seconds the first time (`src/render/prerender.ts`), which is not enough when this machine is
 * busy. The wait timeout is only to prevent hangs.
 */
async function waitPrerender(port, label) {
  const t0 = Date.now();
  for (;;) {
    const info = await fetch(`http://127.0.0.1:${port}/api/prerender/info`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (info?.ready && typeof info.url === 'string') { log(`${label}: prerender process ready, waited ${Date.now() - t0} ms`); return; }
    if (Date.now() - t0 > 180000) throw new Error(`${label}: prerender process not ready after 180 seconds`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const HASH = /^[0-9a-f]{64}$/;
const MISSING = '(missing) ';

const ffmpeg = await findFfmpeg();
const ffprobe = ffmpeg.replace(/ffmpeg(\.exe)?$/i, (m) => (m.toLowerCase().endsWith('.exe') ? 'ffprobe.exe' : 'ffprobe'));
function run(cmd, a) {
  const r = spawnSync(cmd, a, { encoding: 'buffer', windowsHide: true, maxBuffer: 1024 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} exit code ${r.status}: ${String(r.stderr).slice(-600)}`);
  return r.stdout;
}

/** RMS (dBFS) of an audio segment and frequency (Hz) converted from zero-crossing rate */
function audioStats(file, start, dur) {
  const pcm = run(ffmpeg, ['-v', 'error', '-ss', String(start), '-t', String(dur), '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-']);
  const n = Math.floor(pcm.length / 2);
  let sq = 0, crossings = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const v = pcm.readInt16LE(i * 2) / 32768;
    sq += v * v;
    if (i > 0 && ((prev < 0 && v >= 0) || (prev >= 0 && v < 0))) crossings++;
    prev = v;
  }
  const rms = n ? Math.sqrt(sq / n) : 0;
  return { samples: n, rmsDb: rms ? +(20 * Math.log10(rms)).toFixed(1) : -Infinity, hz: n ? Math.round(crossings / 2 / (n / 48000)) : 0 };
}

/** Scale video frame at a given moment to 64×36 grayscale: average brightness and standard deviation (testsrc2 is color bars plus moving graphics, standard deviation is large; no video is a solid color) */
function frameStats(file, at) {
  const raw = run(ffmpeg, ['-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-']);
  const n = raw.length;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += raw[i];
  const mean = n ? sum / n : 0;
  let v = 0;
  for (let i = 0; i < n; i++) v += (raw[i] - mean) ** 2;
  return { pixels: n, mean: +mean.toFixed(1), std: n ? +Math.sqrt(v / n).toFixed(1) : 0 };
}

const dirsOf = (name) => {
  const base = path.join(OUT, name);
  return { base, exportDir: path.join(base, 'out'), dataDir: path.join(base, 'data'), projectsDir: path.join(base, 'projects') };
};
const envOf = (d) => ({ PROMPTCUT_EXPORT_DIR: d.exportDir, PROMPTCUT_DATA_DIR: d.dataDir, PROMPTCUT_PROJECTS_DIR: d.projectsDir, PROMPTCUT_NO_PORT_FILE: '1' });
const isEmptyDir = async (d) => (await fs.readdir(d)).length === 0;

async function openEditor(browser, origin, events) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1600, height: 1000 });
  page.on('dialog', async (d) => { events.push({ type: d.type(), message: d.message() }); await d.accept().catch(() => {}); });
  page.on('pageerror', (e) => events.push({ type: 'pageerror', message: String(e?.message || e) }));
  await page.goto(origin + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => !!(await import('/src/editor/stageBridge.ts')).frontStage(), { timeout: 180000, polling: 500 });
  return page;
}

/** Directly open .proc text in the page (same loadProc as top bar "Open"), returns asset table */
async function openProc(page, text) {
  return page.evaluate(async (t) => {
    const { actions, getState } = await import('/src/store/project.ts');
    const { loadProc } = await import('/src/editor/io/proc.ts');
    actions.loadProject(loadProc(t), 'cross-machine.proc');
    return getState().project.media.map((m) => ({ id: m.id, kind: m.kind, name: m.name, hash: m.hash ?? null, url: m.url, path: m.path ?? null, record: m.missingMaterial?.reason ?? null }));
  }, text);
}

const mediaOf = (page) => page.evaluate(async () => {
  const { getState } = await import('/src/store/project.ts');
  return getState().project.media.map((m) => ({ id: m.id, kind: m.kind, name: m.name, hash: m.hash ?? null, url: m.url, path: m.path ?? null, record: m.missingMaterial?.reason ?? null }));
});

const out = { ok: false, run: RUN, out: OUT, ports: { a: PORT_A, b: PORT_B, c: PORT_C } };
const servers = [];
let browser = null;
try {
  await fs.mkdir(OUT, { recursive: true });
  const A = dirsOf('A');
  const B = dirsOf('B');
  const C = dirsOf('C');
  for (const d of [A, B, C]) for (const k of ['exportDir', 'dataDir', 'projectsDir']) await fs.mkdir(d[k], { recursive: true });

  // -- Assets: generated on the fly, metadata includes current random string, hash differs each time --
  const src = path.join(OUT, 'src');
  await fs.mkdir(src, { recursive: true });
  const video = path.join(src, `clip-${RUN}.mp4`);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-metadata', `comment=${RUN}`, video]);
  const voice = path.join(src, `voice-${RUN}.mp3`);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100', '-t', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', `comment=${RUN}`, voice]);

  browser = await puppeteer.launch({ headless: true, protocolTimeout: 900000, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required'] });

  // -- Instance A: create project, save as .proc --
  log(`Start instance A (${PORT_A})`);
  const srvA = await startDevServer({ port: PORT_A, env: envOf(A), logFile: path.join(OUT, 'vite-A.log'), log });
  servers.push(srvA);
  const eventsA = [];
  const pageA = await openEditor(browser, srvA.origin, eventsA);
  const setup = await pageA.evaluate(async (o) => {
    const b64ToFile = (b64, name, type) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new File([arr], name, { type });
    };
    const { actions, getState } = await import('/src/store/project.ts');
    const io = await import('/src/editor/io/index.ts');
    const { uploadMediaFile } = await import('/src/editor/io/mediaUpload.ts');
    const { serializeProc } = await import('/src/editor/io/proc.ts');
    actions.newProject('cross-machine-' + o.run);
    await io.importVideoFiles([b64ToFile(o.video, o.videoName, 'video/mp4')]);
    for (let i = 0; i < 150 && getState().project.media.some((m) => m.pending || !m.url); i++) await new Promise((r) => setTimeout(r, 200));
    const up = await uploadMediaFile(b64ToFile(o.voice, o.voiceName, 'audio/mpeg'));
    if (!up) throw new Error('The ingest endpoint did not accept the audio');
    const mVoice = actions.addMedia({ kind: 'audio', name: o.voiceName, url: up.url, hash: up.hash, ext: up.ext, size: up.bytes, path: up.path, duration: 2 });
    const track = actions.addTrack('Voiceover');
    if (!actions.addMediaClip(mVoice.id, 0.5, { trackId: track.id, duration: 2 })) throw new Error('The audio could not be placed on the timeline');
    const text = serializeProc();
    const saved = JSON.parse(text);
    return { text, media: (saved.project || saved).media.map((m) => ({ id: m.id, kind: m.kind, name: m.name, hash: m.hash ?? null, url: m.url, path: m.path ?? null })), clips: getState().project.tracks.reduce((n, t) => n + t.clips.length, 0) };
  }, {
    run: RUN,
    video: (await fs.readFile(video)).toString('base64'), videoName: path.basename(video),
    voice: (await fs.readFile(voice)).toString('base64'), voiceName: path.basename(voice),
  });
  const procFile = path.join(OUT, `cross-${RUN}.proc`);
  await fs.writeFile(procFile, setup.text);
  out.a = { media: setup.media, clips: setup.clips, proc: procFile };
  check(setup.media.length === 2, 'A: the media table has two entries', setup.media);
  check(setup.clips >= 2, 'A: both the video and the audio are on the timeline', setup.clips);
  for (const m of setup.media) {
    check(HASH.test(String(m.hash)), `A: ${m.kind} has a hash`, m);
    check(m.path && path.resolve(m.path).startsWith(path.resolve(A.base)), `A: the path of ${m.kind} points into A's directory`, m);
  }
  check(!eventsA.some((e) => e.type === 'pageerror'), 'A: no page errors', eventsA);

  // -- Instance B: data directory is empty, but content store already has these two sets of bytes --
  check(await isEmptyDir(B.exportDir) && await isEmptyDir(B.dataDir), 'B: the data directory and the export directory are empty before the run');
  log(`Start instance B (${PORT_B})`);
  const srvB = await startDevServer({ port: PORT_B, env: envOf(B), logFile: path.join(OUT, 'vite-B.log'), log });
  servers.push(srvB);
  // Retrieve A's bytes as-is, put into B's content store via B's upload API (without tiers, no remux): hash remains unchanged
  const seeded = [];
  for (const m of setup.media) {
    const bytes = Buffer.from(await (await fetch(`${srvA.origin}/@media/${m.hash}`)).arrayBuffer());
    const r = await fetch(`${srvB.origin}/api/media/upload/${encodeURIComponent(m.name)}`, { method: 'POST', body: bytes });
    const j = r.ok ? await r.json() : null;
    seeded.push({ name: m.name, bytes: bytes.length, hash: j?.hash ?? null, want: m.hash });
  }
  out.b = { seeded };
  for (const s of seeded) check(s.hash === s.want, `B: the content store holds the same bytes as ${s.name} (hashes match)`, s);
  const localB = await (await fetch(`${srvB.origin}/api/media/local?hashes=${setup.media.map((m) => m.hash).join(',')}`)).json();
  check(setup.media.every((m) => localB.hashes?.includes(m.hash)), 'B: /api/media/local reports both present', localB);
  // Export before the change read by path: A's path cannot be read on B
  const byPath = [];
  for (const m of setup.media) byPath.push({ kind: m.kind, status: (await fetch(`${srvB.origin}/api/media/file?path=${encodeURIComponent(m.path)}`)).status });
  out.b.byPath = byPath;
  check(byPath.every((x) => x.status >= 400), 'B: A\'s paths cannot be read by path on B (before the change, export reading by path always failed)', byPath);

  const eventsB = [];
  const pageB = await openEditor(browser, srvB.origin, eventsB);
  const openedB = await openProc(pageB, setup.text);
  out.b.opened = openedB;
  for (const m of openedB) {
    check(HASH.test(String(m.hash)) && m.url === `/@media/${m.hash}`, `B: ${m.kind} is restored by hash`, m);
    check(m.path && path.resolve(m.path).startsWith(path.resolve(A.base)), `B: the path of ${m.kind} is still A's (export would read the wrong file if it read by path)`, m);
  }
  // Wait for background check after opening (after 1.5 s) to finish: items present in content store are not marked
  await new Promise((r) => setTimeout(r, 4000));
  const afterB = await mediaOf(pageB);
  out.b.afterCheck = afterB;
  check(afterB.every((m) => !String(m.name).startsWith(MISSING) && m.url === `/@media/${m.hash}`), 'B: media present in the content store is not marked "(missing)"', afterB);

  log('B: export');
  await waitPrerender(PORT_B, 'B');
  const exp = await pageB.evaluate(async () => {
    const io = await import('/src/editor/io/index.ts');
    const r = await io.exportVideo();
    return { outDir: r.outDir, id: r.id };
  });
  const mp4 = path.join(exp.outDir, 'preview.mp4');
  const kept = path.join(OUT, `B-export-${RUN}.mp4`);
  await fs.copyFile(mp4, kept);
  const projectJson = JSON.parse(await fs.readFile(path.join(exp.outDir, 'project.json'), 'utf8'));
  const exportUrls = (projectJson.media || []).map((m) => ({ kind: m.kind, url: m.url }));
  const streams = JSON.parse(String(run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration', '-of', 'json', kept]))).streams;
  const frames = [0.5, 1.5, 2.5].map((t) => ({ t, ...frameStats(kept, t) }));
  const seg = audioStats(kept, 0.7, 1.5);
  const silentHead = audioStats(kept, 0.0, 0.4);
  out.b.export = { file: kept, exportUrls, streams, frames, seg, silentHead };
  for (const m of setup.media) check(exportUrls.some((x) => x.url === `/@media/${m.hash}`), `B export: the ${m.kind} URL obtained by the export page is hash-based`, exportUrls);
  check(streams.some((s) => s.codec_type === 'video'), 'B export: has a video stream', streams);
  check(frames.every((f) => f.std > 20), 'B export: the frames at all three moments are not a flat solid color (the video layer was drawn)', frames);
  check(streams.some((s) => s.codec_type === 'audio'), 'B export: has an audio track', streams);
  check(seg.rmsDb > -40, 'B export: the audio segment (0.7-2.2 s) is not silent', seg);
  check(Math.abs(seg.hz - 440) <= 30, 'B export: that segment is 440 Hz (it really is that audio)', seg);
  check(!eventsB.some((e) => e.type === 'pageerror'), 'B: no page errors', eventsB);

  // -- Instance C: data directory is empty, content store does not have them either --
  check(await isEmptyDir(C.exportDir) && await isEmptyDir(C.dataDir), 'C: the data directory and the export directory are empty before the run');
  log(`Start instance C (${PORT_C})`);
  const srvC = await startDevServer({ port: PORT_C, env: envOf(C), logFile: path.join(OUT, 'vite-C.log'), log });
  servers.push(srvC);
  const eventsC = [];
  const pageC = await openEditor(browser, srvC.origin, eventsC);
  const openedC = await openProc(pageC, setup.text);
  let afterC = openedC;
  for (let i = 0; i < 60 && !afterC.every((m) => String(m.name).startsWith(MISSING)); i++) {
    await new Promise((r) => setTimeout(r, 250));
    afterC = await mediaOf(pageC);
  }
  out.c = { opened: openedC, afterCheck: afterC };
  for (const m of afterC) {
    check(String(m.name).startsWith(MISSING), `C: ${m.kind} is marked "(missing)"`, m);
    check(m.url === `/@media/${m.hash}` && m.record === 'confirmed-missing', `C: the ${m.kind} URL is kept and a "confirmed missing" record is written (preview and export show a placeholder)`, m);
    check(HASH.test(String(m.hash)), `C: the ${m.kind} hash is kept`, m);
  }
  check(!eventsC.some((e) => e.type === 'pageerror'), 'C: no page errors', eventsC);

  // -- Instance C: skip this segment when exporting missing legacy video, remaining video and audio tracks normal, listed in completion dialog --
  const video2 = path.join(src, `clip2-${RUN}.mp4`);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', '-metadata', `comment=d-${RUN}`, video2]);
  const voice2 = path.join(src, `voice2-${RUN}.mp3`);
  run(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=44100', '-t', '2', '-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', `comment=d-${RUN}`, voice2]);
  const oldVideo = setup.media.find((m) => m.kind === 'video');
  const oldName = `old-${path.basename(video)}`;
  const setupD = await pageC.evaluate(async (o) => {
    const b64ToFile = (b64, name, type) => {
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new File([arr], name, { type });
    };
    const { actions, getState } = await import('/src/store/project.ts');
    const io = await import('/src/editor/io/index.ts');
    const { uploadMediaFile } = await import('/src/editor/io/mediaUpload.ts');
    actions.newProject('cross-missing-' + o.run);
    actions.seek(0);
    await io.importVideoFiles([b64ToFile(o.video, o.videoName, 'video/mp4')]);
    for (let i = 0; i < 150 && getState().project.media.some((m) => m.pending || !m.url); i++) await new Promise((r) => setTimeout(r, 200));
    const up = await uploadMediaFile(b64ToFile(o.voice, o.voiceName, 'audio/mpeg'));
    if (!up) throw new Error('The ingest endpoint did not accept the audio');
    const mVoice = actions.addMedia({ kind: 'audio', name: o.voiceName, url: up.url, hash: up.hash, ext: up.ext, size: up.bytes, path: up.path, duration: 2 });
    const ta = actions.addTrack('Voiceover');
    if (!actions.addMediaClip(mVoice.id, 0.5, { trackId: ta.id, duration: 2 })) throw new Error('The audio could not be placed on the timeline');
    // Legacy format: only path (file from another machine A), no hash; address is path-based address restored when opening legacy project
    const mOld = actions.addMedia({ kind: 'video', name: o.oldName, url: '/api/media/file?path=' + encodeURIComponent(o.oldPath), path: o.oldPath, duration: 3, width: 640, height: 360 });
    // Placed on top track: its placeholder must overlay video below to be visible (blocked by video above when placed at bottom, just like when asset was present)
    const tv = actions.addTrack('Old video', { index: 0 });
    if (!actions.addMediaClip(mOld.id, 1, { trackId: tv.id, duration: 1 })) throw new Error('The old video could not be placed on the timeline');
    const p = getState().project;
    return { oldId: mOld.id, tracks: p.tracks.map((t) => ({ id: t.id, clips: t.clips.map((c) => ({ id: c.id, mediaId: c.mediaId ?? null, start: c.start, end: c.end })) })), duration: p.duration };
  }, {
    run: RUN,
    video: (await fs.readFile(video2)).toString('base64'), videoName: path.basename(video2),
    voice: (await fs.readFile(voice2)).toString('base64'), voiceName: path.basename(voice2),
    oldName, oldPath: oldVideo.path,
  });
  out.d = { setup: setupD };
  let oldD = null;
  for (let i = 0; i < 80; i++) {
    oldD = (await mediaOf(pageC)).find((m) => m.id === setupD.oldId);
    if (oldD && String(oldD.name).startsWith(MISSING) && oldD.record === 'confirmed-missing') break;
    await new Promise((r) => setTimeout(r, 250));
  }
  out.d.old = oldD;
  check(oldD && String(oldD.name).startsWith(MISSING) && oldD.record === 'confirmed-missing' && oldD.url && !oldD.hash, 'D: an old video with only a path is marked "(missing)", gets a "confirmed missing" record, keeps its URL, and has no hash', oldD);
  log('C: export the project with the missing old video from the top bar');
  await waitPrerender(PORT_C, 'C');
  const exportsBefore = new Set(await fs.readdir(C.exportDir));
  /*
   * When an instance just started exports for the first time, the prerender process or export page
   * might not be ready yet (a known legacy issue, classified as a transient failure):
   * Retry only if the error reports "not ready", back off 10, 20 seconds, at most three times;
   * record the error each time. Do not retry other failures.
   */
  const attempts = [];
  let dialog, note;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await pageC.evaluate(() => {
      window.showSaveFilePicker = undefined; // No Save As: final video remains in artifact directory (top bar fallback path)
      window.dispatchEvent(new CustomEvent('pc-titlebar-command', { detail: 'export-video' }));
    });
    dialog = await pageC.waitForFunction(() => {
      const t = document.querySelector('.pc-export-dialog .pc-export-title')?.textContent?.trim();
      return t === 'Export complete' || t === 'Export failed' || t === 'Export canceled' ? t : null;
    }, { timeout: 900000, polling: 1000 }).then((h) => h.jsonValue()).catch((e) => `Timed out waiting for a result: ${e.message}`);
    note = await pageC.evaluate(() => ({
      skipped: document.querySelector('[data-pc="export-skipped"]')?.textContent ?? null,
      err: document.querySelector('.pc-export-dialog .pc-export-err')?.textContent ?? null,
    }));
    attempts.push({ attempt, dialog, err: note.err });
    if (dialog !== 'Export failed' || !/not ready/.test(note.err || '') || attempt === 3) break;
    log(`C: export attempt ${attempt} reported not ready, retrying in ${attempt * 10} seconds`, note.err?.slice(0, 80));
    await pageC.evaluate(() => document.querySelector('.pc-export-dialog .pc-export-primary')?.click());
    await new Promise((r) => setTimeout(r, attempt * 10000));
  }
  out.d = { ...out.d, exportAttempts: attempts };
  const shot = path.join(OUT, `D-export-dialog-${RUN}.png`);
  await pageC.screenshot({ path: shot }).catch(() => {});
  out.d.dialog = { title: dialog, ...note, shot };
  check(dialog === 'Export complete', 'D: export completes (no decode failure from the missing old video)', { dialog, err: note.err });
  check(!note.skipped, 'D: no media was skipped (the missing old video shows a placeholder at its original position)', note);
  const newDirs = (await fs.readdir(C.exportDir)).filter((d) => d.startsWith('export-') && !exportsBefore.has(d));
  const expDir = newDirs.length ? path.join(C.exportDir, newDirs.sort().pop()) : null;
  if (check(expDir, 'D: the output directory contains this export', newDirs)) {
    const keptD = path.join(OUT, `D-export-${RUN}.mp4`);
    await fs.copyFile(path.join(expDir, 'preview.mp4'), keptD);
    const pj = JSON.parse(await fs.readFile(path.join(expDir, 'project.json'), 'utf8'));
    const clipsOfOld = (pj.tracks || []).flatMap((t) => t.clips || []).filter((c) => c.mediaId === setupD.oldId);
    const oldInJson = (pj.media || []).find((m) => m.id === setupD.oldId);
    const streamsD = JSON.parse(String(run(ffprobe, ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,duration', '-of', 'json', keptD]))).streams;
    const framesD = [0.5, 1.5, 2.5].map((t) => ({ t, ...frameStats(keptD, t) }));
    const segD = audioStats(keptD, 2.05, 0.4); // The 1-2 s section is overlaid with "Asset not found" voice; measure the portion after it
    out.d.export = { file: keptD, streams: streamsD, frames: framesD, seg: segD, clipsOfOld: clipsOfOld.length, oldUrl: oldInJson?.url ?? null };
    check(clipsOfOld.length === 1, 'D: the clip that references the missing old video is still in the export\'s project.json (position and arrangement are preserved)', clipsOfOld);
    check(oldInJson && oldInJson.missingMaterial?.reason === 'confirmed-missing' && oldInJson.url === oldD.url, 'D: in the export\'s project.json the missing old video carries a record and its URL was not rewritten', oldInJson);
    check(streamsD.some((x) => x.codec_type === 'video'), 'D: has a video stream', streamsD);
    check(framesD[0].std > 20 && framesD[2].std > 20, 'D: the frames at 0.5 s and 2.5 s are normal', framesD);
    check(framesD[1].mean > 25 && framesD[1].mean < 80 && framesD[1].std > 2 && framesD[1].std < 60, 'D: at 1.5 s there is a "Media not found" placeholder (dark background with white text)', framesD[1]);
    check(streamsD.some((x) => x.codec_type === 'audio'), 'D: has an audio track', streamsD);
    check(segD.rmsDb > -40 && Math.abs(segD.hz - 660) <= 40, 'D: the audio segment is not silent and is 660 Hz', segD);
  }
  check(!eventsC.some((e) => e.type === 'pageerror'), 'D: no page errors', eventsC);
} catch (e) {
  fails.push('Probe exception:' + (e?.stack || e));
} finally {
  await browser?.close().catch(() => {});
  for (const s of servers) s.stop();
  if (!KEEP && fails.length === 0) await fs.rm(OUT, { recursive: true, force: true }).catch(() => {});
}
out.fails = fails;
out.ok = fails.length === 0;
console.log(JSON.stringify(out));
process.exit(out.ok ? 0 : 1);
