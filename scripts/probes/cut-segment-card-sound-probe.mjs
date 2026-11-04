/**
 * Audio motion cards in cut segments: automatically generate audio recursively into cut segments
 * before export, audible in the final video, and processed according to cut segment volume,
 * fade-in/fade-out, and mute (item 3 of cut segment initial version limitation followups,
 * `docs/archive/agent-reports/AGENT-cut-segment-followups.md`).
 *
 *   node scripts/probes/cut-segment-card-sound-probe.mjs [--port 5373] [--out <dir>]
 *
 * Method: this probe starts a dev server from this tree itself (port `--port` and +1, +2 must be
 * free, not touching 5190-5192; export and data directories are under `--out`), headless Chrome
 * (`--mute-audio`, no sound to speakers) opens the editor, setting up this project (no audio has
 * been generated):
 *   Cut 2 (2 seconds): built-in audio card av-pulse placed at 0.5-1.1 seconds (880 Hz notification
 *     sound, 0.3 seconds);
 *   Cut 3 (2 seconds): a cut segment referencing cut 2 at 0-2 seconds (two levels of nesting);
 *   Cut 1 (active, 16 seconds):
 *     S1 1-3 seconds references cut 2, volume 1        → notification sound at 1.5 seconds;
 *     S2 4-6 seconds references cut 2, volume 0.5      → 4.5 seconds, 6 dB lower than S1;
 *     S3 7-9 seconds references cut 2, muted          → no sound at 7.5 seconds;
 *     S4 10-12 seconds references cut 2, 1-second fade-in → 10.5 seconds, falls in the middle of
 *       fade-in (gain 0.5-0.8), lower than S1;
 *     S5 13-15 seconds references cut 3             → 13.5 seconds, as loud as S1.
 * Run each of the two export paths once, restoring the project to "no audio has been generated"
 * before each run:
 *   B Browser path (similarly generates audio first like `exportVideoBrowser({ sounds: true })`,
 *     then offline mixes into WAV in Chrome following `browserExport.encodeAudio`; skips the video
 *     encoding step: on local dev server, exportVideoBrowser hangs and does not return even on empty
 *     projects, identical on the pre-work commit);
 *   D Desktop export (`window.__pcIo.exportVideo()`: generates audio first, then hands off to
 *     prerender process for export, mixing with ffmpeg).
 *
 * Assertions (one line PASS/FAIL per item, the last line prints a JSON line, exits with code 1 on
 * failure):
 *   N  The manifest before export has only one item: that audio card in cut 2 (with cutId; listed
 *      only once even when referenced 5 times across two levels of nesting); before the change,
 *      export directly reported missing
 *   G  After export, audio is recorded on cut 2's original clip (parked cut), while the active cut's
 *      track remains untouched; listing the manifest again is empty
 *   Final video (ffmpeg astats measuring RMS dB in each window): S1 has sound (> -45 dB); S2 is 6 dB
 *     lower than S1 (+-1.5); S3 has no sound (< -60 dB); S4 is 1-8 dB lower than S1; S5 differs
 *     from S1 by less than 1.5 dB; silence between segments (< -60 dB)
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { startDevServer, REPO } from '../lib/dev-server.mjs';

setTimeout(() => { console.error('SCRIPT_TIMEOUT'); process.exit(124); }, 40 * 60_000).unref();
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 5373));
const OUT = path.resolve(arg('--out', path.join(REPO, 'out', 'cut-segment-card-sound')));
const dirs = { exportDir: path.join(OUT, 'export'), dataDir: path.join(OUT, 'data'), projectsDir: path.join(OUT, 'projects') };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const fails = [];
const check = (key, cond, note, extra) => {
  results[key] = { ok: !!cond, note, ...(extra !== undefined ? { extra } : {}) };
  if (!cond) fails.push(`${key}: ${note}`);
  console.log(`${cond ? 'PASS' : 'FAIL'} ${key} ${note} ${extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ''}`);
};
/** Overall RMS (dB) of a file for [from, to) seconds; null when no audio samples, -200 for all zeros */
function rmsOf(file, from, to) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-ss', String(from), '-t', String(to - from), '-i', file, '-vn', '-af', 'astats=metadata=0:reset=0', '-f', 'null', '-'], { encoding: 'utf8', windowsHide: true });
  const m = /Overall[\s\S]*?RMS level dB:\s*(-?inf|-?[\d.]+)/.exec(r.stderr);
  return m ? (m[1].includes('inf') ? -200 : Number(m[1])) : null;
}
const quiet = (v) => v === null || v < -60;

function audit(tag, file) {
  const w = (at) => rmsOf(file, at + 0.02, at + 0.28);
  const lv = { S1: w(1.5), S2: w(4.5), S3: w(7.5), S4: w(10.5), S5: w(13.5) };
  const gaps = { g0: rmsOf(file, 0, 1.45), g1: rmsOf(file, 2.0, 4.45), g2: rmsOf(file, 5.0, 10.45), g3: rmsOf(file, 11.0, 13.45), g4: rmsOf(file, 14.0, 15.9) };
  check(`${tag}-S1`, lv.S1 !== null && lv.S1 > -45, `The notification sound is audible in cut segment S1 (volume 1): ${lv.S1} dB`, lv);
  check(`${tag}-S2`, lv.S2 !== null && Math.abs(lv.S1 - lv.S2 - 6.02) < 1.5, `S2 volume 0.5: ${(lv.S1 - lv.S2).toFixed(2)} dB lower than S1 (should be about 6.02)`);
  check(`${tag}-S3`, quiet(lv.S3), `S3 muted: ${lv.S3} dB`);
  check(`${tag}-S4`, lv.S4 !== null && lv.S1 - lv.S4 > 1 && lv.S1 - lv.S4 < 8, `S4 midway through the fade-in: ${(lv.S1 - lv.S4).toFixed(2)} dB lower than S1`);
  check(`${tag}-S5`, lv.S5 !== null && Math.abs(lv.S1 - lv.S5) < 1.5, `S5 two-level nesting: differs from S1 by ${(lv.S1 - lv.S5).toFixed(2)} dB`);
  check(`${tag}-gaps`, Object.values(gaps).every(quiet), 'silence between segments', gaps);
  return { levels: lv, gaps };
}

const server = await startDevServer({ port: PORT, logFile: path.join(OUT, 'vite.log'), log: (m) => console.log('[dev]', m),
  env: { PROMPTCUT_EXPORT_DIR: dirs.exportDir, PROMPTCUT_DATA_DIR: dirs.dataDir, PROMPTCUT_PROJECTS_DIR: dirs.projectsDir, PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_PUSH: '0' } });
const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--no-first-run', '--mute-audio', '--force-device-scale-factor=1'], protocolTimeout: 15 * 60_000 });
const report = {};
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('dialog', (d) => { void d.dismiss(); });
  await page.goto(`${server.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await page.waitForFunction(() => !!window.__pcStore && !!window.__pcIo, { timeout: 120_000 });
  await sleep(5000);

  /* Set up project, save an intact copy of "no audio has been generated",
   * each of the two paths starts from it */
  const setup = await page.evaluate(() => {
    const a = window.__pcStore.actions;
    a.newProject('Audio cards inside a cut segment');
    a.setProjectMeta({ width: 480, height: 270, fps: 15 });
    const c2 = a.addCut('Cut 2', { switchTo: true });
    const card = a.addCardClip('av-pulse', 0.5, { duration: 0.6, params: { frequency: 880, gain: 0.3, duration: 0.3 } });
    a.setProjectMeta({ duration: 2 });
    const c3 = a.addCut('Cut 3', { switchTo: true });
    a.addCutSegment(c2.id, 0, { duration: 2 });
    a.setProjectMeta({ duration: 2 });
    const root = window.__pcStore.getState().project.cuts[0].id;
    a.switchCut(root);
    const s1 = a.addCutSegment(c2.id, 1, { duration: 2 });
    const s2 = a.addCutSegment(c2.id, 4, { duration: 2 });
    a.setClipVolume(s2.id, 0.5);
    const s3 = a.addCutSegment(c2.id, 7, { duration: 2 });
    a.setClipMuted(s3.id, true);
    const s4 = a.addCutSegment(c2.id, 10, { duration: 2 });
    a.updateClip(s4.id, { fadeIn: 1 });
    const s5 = a.addCutSegment(c3.id, 13, { duration: 2 });
    a.setProjectMeta({ duration: 16 });
    const p = window.__pcStore.getState().project;
    return { project: JSON.parse(JSON.stringify(p)), ids: { root, c2: c2.id, c3: c3.id, card: card.id, segs: [s1.id, s2.id, s3.id, s4.id, s5.id] } };
  });
  report.ids = setup.ids;
  const fresh = setup.project;

  for (const mode of ['browser', 'desktop']) {
    const tag = mode === 'browser' ? 'B' : 'D';
    await page.evaluate((p) => window.__pcStore.actions.loadProject(JSON.parse(JSON.stringify(p))), fresh);
    await sleep(500);
    const pre = await page.evaluate(async () => {
      const sound = await window.__pcIo.sound();
      const needs = await sound.listExportSoundNeeds(new AbortController().signal);
      const { assertProjectCardAudio } = await import('/src/audio/cardAudio.ts');
      let err = null;
      try { assertProjectCardAudio(window.__pcStore.getState().project); } catch (e) { err = String(e?.message ?? e); }
      return { needs: needs.map((n) => ({ clipId: n.clipId, cutId: n.cutId, kind: n.kind, reason: n.reason, label: n.label })), err };
    });
    check(`${tag}-N`, pre.needs.length === 1 && pre.needs[0].clipId === setup.ids.card && pre.needs[0].cutId === setup.ids.c2 && pre.needs[0].reason === 'ungenerated' && /not yet generated/.test(pre.err ?? ''),
      'The pre-export list contains only the audio card in Cut 2 (with its cutId), and the check before the change names the original clip', pre);
    const activeBefore = await page.evaluate(() => JSON.stringify(window.__pcStore.getState().project.tracks));

    const file = path.join(OUT, mode === 'browser' ? 'browser.wav' : 'desktop.mp4');
    if (mode === 'browser') {
      // Browser path: similarly calls prepareExportSounds first like exportVideoBrowser({ sounds: true }),
      // then follows browserExport.encodeAudio (audioPlanOf → slice per item → renderMix, Chrome offline
      // mixing with gainCurve envelope) to mix into WAV. Skips the video encoding step: on local dev
      // server, exportVideoBrowser hangs and does not return even on empty projects without cut segments,
      // identical on pre-work commit a55d8199 (see report "What didn't work")
      const r = await page.evaluate(async () => {
        try {
          const { prepareExportSounds } = await import('/src/editor/io/exportSounds.ts');
          const { audioPlanOf } = await import('/src/kernel/audioPlan.mjs');
          const { renderMix, encodeWavFloat32 } = await import('/src/audio/renderMix.ts');
          const { assertProjectCardAudio } = await import('/src/audio/cardAudio.ts');
          const progress = [];
          await prepareExportSounds({ signal: new AbortController().signal, onProgress: (d, t) => progress.push([d, t]) });
          const p = window.__pcStore.getState().project;
          assertProjectCardAudio(p);
          const plan = audioPlanOf(p);
          const ctx = new OfflineAudioContext(2, 1, 48000);
          const decoded = new Map();
          const slices = new Map();
          const clips = [];
          for (const [i, e] of plan.entries()) {
            const m = p.media.find((x) => x.id === e.mediaId);
            if (!decoded.has(m.id)) decoded.set(m.id, await ctx.decodeAudioData(await (await fetch(m.url)).arrayBuffer()));
            const src = decoded.get(m.id), from = Math.round(e.offset * 48000), n = Math.max(1, Math.round(e.dur * 48000));
            const chans = [0, 1].map((c) => { const out = new Float32Array(n); const d = src.getChannelData(Math.min(c, src.numberOfChannels - 1)); out.set(d.subarray(from, Math.min(d.length, from + n))); return out; });
            slices.set(`s${i}`, encodeWavFloat32({ numberOfChannels: 2, length: n, sampleRate: 48000, getChannelData: (c) => chans[c] }));
            clips.push({ clipId: e.clipId, url: `s${i}`, start: e.start, dur: e.dur, volume: e.volume, fadeIn: e.fadeIn, fadeOut: e.fadeOut, fx: e.fx, ...(e.env ? { env: e.env } : null) });
          }
          const { buffer } = await renderMix({ sampleRate: 48000, duration: p.duration, clips }, async (u) => new Response(slices.get(String(u))));
          const bytes = new Uint8Array(encodeWavFloat32(buffer));
          let bin = '';
          for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
          return { base64: btoa(bin), entries: plan.length, envs: plan.filter((e) => e.env).length, progress: progress.slice(-1)[0] ?? null };
        } catch (e) { return { error: String(e?.message ?? e) }; }
      });
      check(`${tag}-export`, !r.error && r.base64 && r.entries === 4, 'Browser path: generate the sound first, then Chrome offline mixdown (4 entries in the mix plan, muted S3 is not included)', { error: r.error, entries: r.entries, envs: r.envs, progress: r.progress });
      if (r.base64) fs.writeFileSync(file.replace(/\.mp4$/, '.wav'), Buffer.from(r.base64, 'base64'));
    } else {
      const r = await page.evaluate(async () => {
        const progress = [];
        try {
          const out = await window.__pcIo.exportVideo({ onProgress: (d, t, stage) => progress.push([stage ?? 'render', d, t]) });
          return { ok: true, outDir: out.outDir, sound: progress.filter((x) => x[0] === 'sound').slice(-1)[0] ?? null };
        } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
      });
      check(`${tag}-export`, r.ok && fs.existsSync(path.join(r.outDir ?? '', 'preview.mp4')), 'Desktop export succeeded (progress includes a sound generation stage)', r);
      if (r.ok) fs.copyFileSync(path.join(r.outDir, 'preview.mp4'), file);
    }
    const post = await page.evaluate(async (ids) => {
      const p = window.__pcStore.getState().project;
      const clip = p.cuts.find((c) => c.id === ids.c2)?.tracks?.flatMap((t) => t.clips).find((c) => c.id === ids.card);
      const sound = await window.__pcIo.sound();
      return { hasAudio: !!clip?.cardAudio, mediaId: clip?.cardAudio?.mediaId ?? null, active: JSON.stringify(p.tracks), needs: (await sound.listExportSoundNeeds(new AbortController().signal)).length };
    }, setup.ids);
    check(`${tag}-G`, post.hasAudio && post.active === activeBefore && post.needs === 0, 'The sound is recorded on the original clip in Cut 2, the active cut\'s tracks are untouched, and the list is empty when listed again', { hasAudio: post.hasAudio, activeSame: post.active === activeBefore, needs: post.needs });
    if (fs.existsSync(file)) report[mode] = audit(tag, file);
  }
  check('E0', errors.length === 0, 'Page has zero errors', errors);
} finally {
  await browser.close();
  server.stop();
}
console.log(JSON.stringify({ ok: fails.length === 0, results, report, fails }));
process.exit(fails.length ? 1 : 0);
