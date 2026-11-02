/**
 * Sound sample export (task brief "Part 1" item 8): produce one MP4 each for notification sound,
 * keyboard sound, and audio motion card.
 *
 *   node scripts/probes/sound-samples-probe.mjs [--out <sample-dir>] [--base-port 5710] [--keep-temp]
 *
 * Visuals are rendered by the real editor: on the local editor dev server (source tree where this
 * script resides, temporary data directory), generate sound using real buttons ("Add notification
 * sound", "Generate keyboard sound", "Generate sound"), then route through the real
 * `POST /api/export` (same backend as UI "Export video"), producing final video preview.mp4. Copy
 * the final video to --out (default work/four-stage/sound/samples/).
 *
 * Acceptance criteria (exit code 0 if and only if all pass; "voice" is not part of the acceptance
 * check, only verifying that audio exists, timing is correct, and visuals are not solid color):
 *   S1 ffprobe: final video contains video and audio streams, duration differs from project
 *      duration by at most 0.15 s;
 *   S2 Decode audio track: each event window ([event timestamp, +0.05 s]) has energy
 *      (RMS ≥ 5e-5), and sound start falls between 12 ms before and 1 frame (33 ms) after the
 *      event timestamp (start = first sample with |x| ≥ 0.002 in window [event-0.05, event+0.1]);
 *   S3 No sound before the first event (event-0.2 to event-0.05) (no premature sound);
 *   S4 Sample three frames and save as PNG: 0.1 s after the first event, 0.1 s after the last event,
 *      and a quiet moment (0.2 s before the first event, or before the end of the video if none);
 *      brightness standard deviation of the first two frames is > 2 (content is present on screen
 *      at the event moment, not solid color), and the three frames are not all identical (visual is
 *      moving).
 * No audio to speakers: headless Chrome runs with --mute-audio; ffmpeg only decodes to file.
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startDevServer } from '../lib/dev-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const BASE = Number(arg('base-port', 5710));
const OUT = path.resolve(arg('out', path.join(ROOT, '..', '..', 'work', 'four-stage', 'sound', 'samples')));
const KEEP = argv.includes('--keep-temp');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-sound-samples-'));
fs.mkdirSync(OUT, { recursive: true });
const SR = 48000;

const results = [], fails = [];
const check = (ok, name, evidence = {}) => { results.push({ ok: !!ok, name, evidence }); if (!ok) fails.push(name); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence).slice(0, 600)}`); return !!ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 60_000, every = 250) {
  const t0 = Date.now();
  for (;;) {
    let v = null;
    try { v = await fn(); } catch { v = null; }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`Timed out waiting for: ${what}`); console.log(`FAIL timed out waiting for: ${what}`); return null; }
    await sleep(every);
  }
}
const P = (page, fn, ...a) => page.evaluate(fn, ...a);
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const openEdit = (page) => P(page, () => { const b = document.querySelector('[data-pc-rail="edit"]'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); });

let dev = null, browser = null;
const dir = path.join(TMP, 'desktop');
async function main() {
  for (const d of ['data', 'card-overrides', 'projects', 'work', 'tmp']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  dev = await startDevServer({ env: { PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_EXPORT_DIR: dir, PROMPTCUT_DATA_DIR: path.join(dir, 'data'), PROMPTCUT_CARD_OVERRIDES: path.join(dir, 'card-overrides'),
    PROMPTCUT_PROJECTS_DIR: path.join(dir, 'projects'), PROMPTCUT_WORK_DIR: path.join(dir, 'work'), PROMPTCUT_STREAMS: '0', TEMP: path.join(dir, 'tmp'), TMP: path.join(dir, 'tmp'), TMPDIR: path.join(dir, 'tmp') },
    logFile: path.join(dir, 'vite.log'), port: BASE, log: (m) => console.log(`[dev] ${m}`) });
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  browser = await puppeteer.launch({ headless: true, protocolTimeout: 600_000, defaultViewport: { width: 1600, height: 900 }, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
  const page = await browser.newPage();
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${dev.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await until('Editor ready', () => P(page, () => !!window.__pcStore && !!document.querySelector('[data-pc="ruler"]')), 120_000, 300);

  const load = (name, duration) => P(page, async (n, d) => {
    const { createEmptyProject } = await import('/src/kernel/project.ts');
    window.__pcStore.actions.loadProject({ ...createEmptyProject(n), width: 1280, height: 720, fps: 30, duration: d, media: [], tracks: [{ id: 't-vis', name: 'Visual', clips: [] }] });
  }, name, duration);
  const clickBtn = async (sel) => { const el = await page.waitForSelector(sel, { visible: true, timeout: 20_000 }); await el.click(); };
  const mediaCount = () => P(page, () => window.__pcStore.getState().project.media.length);
  const clickText = (scope, text) => P(page, (sc, t) => { for (const b of document.querySelectorAll(`${sc} button`)) if (b.textContent.trim() === t) b.click(); }, scope, text);
  const events = () => P(page, () => {
    const p = window.__pcStore.getState().project;
    const out = [];
    for (const c of p.tracks.flatMap((t) => t.clips)) {
      const m = c.mediaId ? p.media.find((x) => x.id === c.mediaId) : null;
      if (m?.soundEffect?.recipe) for (const e of m.soundEffect.recipe.events) out.push(c.start - (c.mediaOffset ?? 0) + e.frame / 48000);
    }
    return out.sort((a, b) => a - b);
  });

  const samples = [];
  /* ---- Sample 1: Notification sound ---- */
  await load('Notification sound sample', 3);
  await P(page, () => { const S = window.__pcStore; S.actions.addCardClip('punch-pill', 0, { trackId: 't-vis', duration: 3 }); S.actions.seek(1.0); });
  await openEdit(page);
  await clickBtn('[data-pc="sound-notification"]');
  await until('Notification sound added to the library', async () => (await mediaCount()) >= 1);
  samples.push({ name: 'notification', file: 'sample-notification.mp4', duration: 3, events: await events(), project: await P(page, () => window.__pcStore.getState().project) });
  /* ---- Sample 2: Keyboard sound ---- */
  await load('Keyboard sound sample', 3);
  const typingId = await P(page, () => { const S = window.__pcStore; const c = S.actions.addCardClip('mu-typing', 0, { trackId: 't-vis', duration: 3, params: { text: 'Hello, PromptCut! 你好', duration: 110 } }); S.actions.select([c.id]); return c.id; });
  await openEdit(page);
  await clickBtn('[data-pc="sound-keyboard"]');
  await until('Keyboard sound added to the library', async () => (await mediaCount()) >= 1);
  samples.push({ name: 'keyboard', file: 'sample-keyboard.mp4', duration: 3, events: await events(), project: await P(page, () => window.__pcStore.getState().project) });
  /* ---- Sample 3: Audio motion card (three audio-visual card clips) ---- */
  await load('Audio motion card sample', 3.4);
  for (const at of [0.4, 1.4, 2.4]) {
    await P(page, (t) => { const S = window.__pcStore; const c = S.actions.addCardClip('av-pulse', t, { trackId: 't-vis', duration: 0.9 }); S.actions.select([c.id]); }, at);
    await openEdit(page);
    await page.waitForSelector('[data-pc="card-audio-controls"]', { visible: true, timeout: 20_000 });
    await clickText('[data-pc="card-audio-controls"]', 'Generate sound');
    await until(`Sound of audio-visual card ${at} added to the library`, () => P(page, (t) => window.__pcStore.getState().project.tracks.flatMap((x) => x.clips).some((c) => Math.abs(c.start - t) < 1e-6 && c.cardAudio), at), 60_000);
  }
  samples.push({ name: 'av-card', file: 'sample-av-card.mp4', duration: 3.4, events: [0.4, 1.4, 2.4], project: await P(page, () => window.__pcStore.getState().project), card: true });
  await page.close();

  /* ---- Export and verification ---- */
  for (const s of samples) {
    const post = await fetch(`${dev.origin}/api/export`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: s.project }) });
    const started = post.ok ? await post.json() : { error: await post.text() };
    if (!check(!!started.id, `${s.name}: start export`, { status: post.status, id: started.id, error: started.error?.slice?.(0, 200) })) continue;
    const job = await until(`${s.name} export finished`, async () => { const j = await fetch(`${dev.origin}/api/export/${started.id}`).then((r) => r.json()); if (j.status === 'error') throw new Error(j.message); return j.status === 'done' ? j : null; }, 600_000, 1000);
    const mp4 = path.join(dir, `export-${started.id}`, 'preview.mp4');
    if (!job || !fs.existsSync(mp4)) { check(false, `${s.name}: final video exists`, { job }); continue; }
    const dest = path.join(OUT, s.file);
    fs.copyFileSync(mp4, dest);
    const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', dest]).stdout);
    const v = probe.streams.find((x) => x.codec_type === 'video'), a = probe.streams.find((x) => x.codec_type === 'audio');
    const dur = Number(probe.format.duration);
    check(!!v && !!a && Math.abs(dur - s.project.duration) <= 0.15, `${s.name} S1: has a video stream and an audio stream, duration correct`, { video: v && `${v.codec_name} ${v.width}x${v.height}`, audio: a && `${a.codec_name} ${a.sample_rate}Hz ${a.channels}ch`, duration: dur, expected: s.project.duration, bytes: fs.statSync(dest).size });
    const raw = path.join(dir, `${s.name}.f32`);
    run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', dest, '-vn', '-ar', String(SR), '-ac', '2', '-f', 'f32le', raw]);
    const buf = fs.readFileSync(raw);
    const pcm = new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
    const rows = s.events.map((at) => {
      const from = Math.max(0, Math.round(at * SR)), until2 = Math.min(pcm.length / 2, from + Math.round(0.05 * SR));
      let e = 0; for (let i = from; i < until2; i++) e += pcm[i * 2] ** 2;
      const rms = Math.sqrt(e / Math.max(1, until2 - from));
      let onset = null;
      for (let i = Math.max(0, Math.round((at - 0.05) * SR)); i < Math.min(pcm.length / 2, Math.round((at + 0.1) * SR)); i++) if (Math.abs(pcm[i * 2]) >= 0.002) { onset = i / SR; break; }
      return { at: +at.toFixed(3), rms: +rms.toFixed(5), onsetErrMs: onset === null ? null : +((onset - at) * 1000).toFixed(1) };
    });
    check(rows.length > 0 && rows.every((r) => r.rms >= 5e-5 && r.onsetErrMs !== null && r.onsetErrMs >= -12 && r.onsetErrMs <= 33.4), `${s.name} S2: every event window has energy and the onset is aligned (${rows.length} events)`, { worst: rows.reduce((w, r) => (Math.abs(r.onsetErrMs ?? 999) > Math.abs(w.onsetErrMs ?? 0) ? r : w), rows[0]), minRms: Math.min(...rows.map((r) => r.rms)) });
    const first = s.events[0];
    let lead = 0, n = 0;
    for (let i = Math.max(0, Math.round((first - 0.2) * SR)); i < Math.round((first - 0.05) * SR); i++) { lead += pcm[i * 2] ** 2; n++; }
    check(n === 0 || Math.sqrt(lead / n) < 5e-4, `${s.name} S3: no sound before the first event`, { leadRms: n ? +Math.sqrt(lead / n).toFixed(6) : null });
    const stats = [];
    const last = s.events[s.events.length - 1], endAt = s.project.duration - 0.06;
    for (const [label, t] of [['event', Math.min(first + 0.1, endAt)], ['last', Math.min(last + 0.1, endAt)], ['quiet', first > 0.3 ? first - 0.2 : endAt]]) {
      const png = path.join(OUT, `${s.file.replace('.mp4', '')}-${label}.png`);
      run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(t), '-i', dest, '-frames:v', '1', png]);
      const raw8 = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 64 * 1024 * 1024, windowsHide: true }).stdout;
      let sum = 0, sq = 0; for (const b of raw8) { sum += b; sq += b * b; }
      const mean = sum / raw8.length, std = Math.sqrt(sq / raw8.length - mean * mean);
      stats.push({ label, t: +t.toFixed(2), std: +std.toFixed(2), png, sum });
    }
    check(stats[0].std > 2 && stats[1].std > 2 && !(stats[0].sum === stats[1].sum && stats[1].sum === stats[2].sum), `${s.name} S4: the frame at event times is not a solid color and the picture is moving`, { std: stats.map((x) => `${x.label}=${x.std}`), frames: stats.map((x) => x.png) });
    s.result = { file: dest, duration: dur, events: rows.length };
  }
}
try { await main(); } catch (e) { fails.push(`Aborted: ${String(e?.message ?? e).slice(0, 300)}`); console.error(e); }
finally {
  try { await browser?.close(); } catch { /* Closed */ }
  try { dev?.stop(); } catch { /* Closed */ }
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* Keep */ } }
}
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ ok: fails.length === 0, fails, results }, null, 2));
console.log(JSON.stringify({ ok: fails.length === 0, checks: results.length, fails }));
process.exit(fails.length === 0 ? 0 : 1);
