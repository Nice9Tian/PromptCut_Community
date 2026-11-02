/**
 * End-to-end probe for custom measurement (measure_audio_js) (plan `docs/plan/agent-workflow-plan.md`
 * A6; report `docs/archive/agent-reports/AGENT-custom-measure.md`).
 *
 *   node scripts/probes/custom-measure-probe.mjs [--port 5860] [--keep]   (port range is allocated by dispatcher, e.g. 5860, 5920)
 *
 * Start an editor dev server itself (`--port`, defaults to 5860, stage occupies additional +1, +2;
 * with PROMPTCUT_NO_PORT_FILE=1, does not write shared port.json), artifacts and assets land in newly
 * created temporary directory (PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR), then open editor with
 * puppeteer, in sequence:
 *   M1 ffmpeg lavfi generates a sine wave of 1 kHz and amplitude 0.5 (48 kHz stereo, 3 seconds),
 *      places it into this asset directory, adds it to project, and puts it on timeline (2 seconds
 *      starting at second 1);
 *   M2 Using a chat registered as "high" (actually POST /api/ai/chat, provider intentionally given
 *      nonexistent name: registered before launching model, spends no quota), call measure_audio_js
 *      via POST /api/mcp/call to measure entire asset: RMS and peak match theoretical values (-9.03 /
 *      -6.02 dBFS); also measure clip tier (clipId) and timeline mix tier once each;
 *   M3 Re-register same chat as "low" and "medium": calls rejected, returns A1 unified format
 *      tier-exceeded error (creativity.current / required = high);
 *   M4 Switch back to "high": infinite loop terminates within time limit, error specifies timeout;
 *      network attempts (fetch local / external network) fail, error specifies "no network access
 *      inside sandbox"; thrown exceptions include error message; afterward editor responds normally,
 *      normal measurements proceed as usual.
 * On exit, stop only processes started by itself (editor process tree, including prerender process
 * and sandboxed Chrome it started; probe's own puppeteer Chrome); `--keep` does not shut down or
 * delete temporary directory.
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR, and set PROMPTCUT_NO_PORT_FILE=1
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import puppeteer from 'puppeteer';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import { createTimings } from './probe-timings.mjs';
import { findFfmpeg } from '../../server/ai-visual.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 5860);
const KEEP = args.includes('--keep');
// Editor + two stage ports occupy PORT to PORT+2, which must fall into the same 10-port block; user resident 5190-5192 and 5580-5599 are not used
const clashes = (p) => (p >= 5190 && p <= 5192) || (p >= 5580 && p <= 5599);
if (!(PORT >= 1024 && PORT % 10 <= 7) || [PORT, PORT + 1, PORT + 2].some(clashes)) throw new Error(`--port ${PORT} is not allowed: it must be among the first 8 ports of a 10-port block (using PORT to PORT+2), and must not touch 5190-5192 or 5580-5599`);
const EDITOR = `http://127.0.0.1:${PORT}`;
const EXPORT_DIR = path.join(os.tmpdir(), `pc-custom-measure-probe-${Date.now().toString(36)}`);
const DATA_DIR = path.join(EXPORT_DIR, 'data');
const MEDIA_DIR = path.join(EXPORT_DIR, 'media');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(MEDIA_DIR, { recursive: true });

const fails = [];
/** Elapsed time is only recorded (docs/semantics/guide_files/verification.md "Elapsed time is only recorded, not used as a gate"): how long the infinite loop script took to terminate is only written into the TIMINGS line, not deciding whether it passes */
const timingLog = createTimings('custom-measure-probe');
const passes = [];
const out = { port: PORT, exportDir: EXPORT_DIR };
const check = (cond, label, extra) => {
  (cond ? passes : fails).push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600)));
  return cond;
};

async function until(label, fn, timeoutMs = 120000, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`Timeout: ${label}`); return null; }
    await delay(everyMs);
  }
}

function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

let editor = null;
const editorLog = [];
async function startEditor() {
  editor = spawn(process.execPath, [viteBin(), '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
      env: { ...process.env, PROMPTCUT_EXPORT_DIR: EXPORT_DIR, PROMPTCUT_DATA_DIR: DATA_DIR, PROMPTCUT_NO_PORT_FILE: '1' } });
  const keep = (c) => { editorLog.push(c.toString()); if (editorLog.length > 400) editorLog.shift(); };
  editor.stdout.on('data', keep);
  editor.stderr.on('data', keep);
  return until('editor process is up', async () => (await fetch(EDITOR + '/api/prerender/info').then((r) => r.ok, () => false)) || null, 120000);
}
function stopEditor() {
  if (!editor || editor.exitCode !== null || !editor.pid) return;
  // Entire process tree: prerender process and sandboxed Chrome spawned by the editor are its descendants
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else editor.kill('SIGKILL');
}

const mcpCall = async (tool, callArgs, agent) => {
  const res = await fetch(`${EDITOR}/api/mcp/call`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tool, args: callArgs, ...(agent ? { agent } : {}) }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await res.json().catch(() => null);
  return body?.result ?? body;
};
/** Register this chat's tier: actually hits /api/ai/chat; provider does not exist, so starting model right after registration directly throws error without spending quota */
const register = (conv, creativity) => fetch(`${EDITOR}/api/ai/chat`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ provider: 'probe-none', prompt: 'x', conversationId: conv, creativity, projectCreativity: 'high' }),
}).then((r) => r.text()).catch(() => '');

const RMS_PEAK = [
  'const out = [];',
  'for (const x of input.channels) {',
  '  let s = 0, pk = 0;',
  '  for (let i = 0; i < x.length; i++) { s += x[i] * x[i]; const a = Math.abs(x[i]); if (a > pk) pk = a; }',
  '  out.push({ rmsDb: 10 * Math.log10(s / x.length), peakDb: 20 * Math.log10(pk) });',
  '}',
  'return { channels: out, frames: input.frames, sampleRate: input.sampleRate };',
].join('\n');
const RMS = 20 * Math.log10(0.5 / Math.SQRT2); // -9.031
const PEAK = 20 * Math.log10(0.5); // -6.021
const near = (a, b, tol) => typeof a === 'number' && Math.abs(a - b) < tol;

let browser = null;
try {
  /* ---- M1 Test audio ---- */
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error('ffmpeg not found (put it on PATH or set PROMPTCUT_FFMPEG)');
  const wav = path.join(MEDIA_DIR, 'probe-sine.wav');
  const wave = '0.5*sin(2*PI*1000*t)';
  const gen = spawnSync(ffmpeg, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${wave}|${wave}:s=48000:d=3`, '-c:a', 'pcm_s24le', wav], { windowsHide: true });
  check(gen.status === 0 && fs.existsSync(wav), 'M1 ffmpeg lavfi generated the sine wave', { status: gen.status, stderr: String(gen.stderr || '').slice(0, 200) });

  if (!(await startEditor())) throw new Error('The editor process did not start');
  browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run'] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(EDITOR + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(async () => { const m = await import('/src/store/project.ts'); return !!m.getState().project; }, { timeout: 180000, polling: 500 });
  const placed = await page.evaluate(async (file) => {
    const m = await import('/src/store/project.ts');
    m.actions.newProject?.();
    const media = m.actions.addMedia({ id: 'm-probe-sine', kind: 'audio', name: 'probe-sine.wav', url: '/@media/probe-sine.wav', path: file, duration: 3 });
    const clip = m.actions.addMediaClip(media.id, 1, { duration: 2 });
    return { mediaId: media.id, clipId: clip?.id ?? null };
  }, wav);
  out.placed = placed;
  check(!!placed.clipId, 'M1 the media got into the project and was placed on the timeline', placed);

  /* ---- M2 High tier normal measurement ---- */
  const conv = `cmprobe${Date.now().toString(36)}`;
  await register(conv, 'high');
  // Project takes a moment to reach server via page (or document service replica): wait until it is no longer "Asset not found"
  const media = await until('high tier measures the whole media', async () => {
    const r = await mcpCall('measure_audio_js', { mediaId: placed.mediaId, code: RMS_PEAK }, conv);
    return r && r.ok === true ? r : (r && !/media not found|no clip|editor is not open/.test(String(r.error || '')) ? r : null);
  }, 90000, 1000);
  out.media = media;
  check(media?.ok === true && media.value?.channels?.length === 2, 'M2 high tier: measure_audio_js measured the whole media successfully, two channels', media);
  for (const [i, ch] of (media?.value?.channels ?? []).entries()) {
    check(near(ch.rmsDb, RMS, 0.05), `M2 channel ${i} RMS matches the theoretical value (${RMS.toFixed(3)} dBFS)`, ch);
    check(near(ch.peakDb, PEAK, 0.1), `M2 channel ${i} peak matches the theoretical value (${PEAK.toFixed(3)} dBFS)`, ch);
  }
  check(media?.value?.sampleRate === 16000 && Math.abs((media?.value?.frames ?? 0) - 48000) <= 16, 'M2 default 16 kHz, 3 seconds = 48000 frames', media?.value && { sr: media.value.sampleRate, frames: media.value.frames });

  const clip = await mcpCall('measure_audio_js', { clipId: placed.clipId, mono: true, sampleRate: 48000, code: RMS_PEAK }, conv);
  out.clip = clip;
  check(clip?.ok === true && clip.value?.channels?.length === 1 && near(clip.value.channels[0].rmsDb, RMS, 0.05) && Math.abs(clip.value.frames - 96000) <= 48,
    'M2 clip mode: 2 seconds, mono, 48 kHz, RMS matches the theoretical value', clip);
  const tl = await mcpCall('measure_audio_js', { scope: 'timeline', start: 1, duration: 2, code: RMS_PEAK }, conv);
  out.timeline = tl;
  check(tl?.ok === true && near(tl.value?.channels?.[0]?.rmsDb, RMS, 0.1), 'M2 timeline mix mode: seconds 1 to 3 (where it sounds) RMS matches the theoretical value', tl);

  /* ---- M3 Low and medium tiers rejected ---- */
  for (const level of ['low', 'medium']) {
    await register(conv, level);
    const r = await mcpCall('measure_audio_js', { mediaId: placed.mediaId, code: RMS_PEAK }, conv);
    out[`denied_${level}`] = r;
    check(r?.ok === false && r.creativity?.current === level && r.creativity?.required === 'high' && /writing custom measurement code requires "High"/.test(String(r.error)),
      `M3 chat changed to "${level === 'low' ? 'Low' : 'Medium'}": measure_audio_js is rejected and returns the unified-format level-exceeded error`, r);
    const builtin = await mcpCall('measure_audio', { mediaId: placed.mediaId }, conv);
    check(builtin && !builtin.creativity && typeof builtin.integrated === 'number', `M3 the built-in measure_audio at the "${level === 'low' ? 'Low' : 'Medium'}" tier works as usual`, builtin && { integrated: builtin.integrated, error: builtin.error });
  }

  /* ---- M4 High tier error paths ---- */
  await register(conv, 'high');
  let t0 = Date.now();
  const loop = await mcpCall('measure_audio_js', { mediaId: placed.mediaId, sampleRate: 8000, code: 'while (true) {}', timeoutMs: 2000 }, conv);
  const loopMs = Date.now() - t0;
  out.loop = { ...loop, ms: loopMs };
  timingLog.record('M4 infinite-loop script, from call to termination', loopMs, { formerLimit: '< 17 seconds (script limit 2 seconds + 15 seconds margin)' });
  check(loop?.ok === false && loop.kind === 'timeout' && /exceeded 2 seconds, terminated/.test(String(loop.error)), 'M4 infinite loop is terminated, and the error states a timeout (duration is only recorded)', out.loop);
  t0 = Date.now();
  const alive = await fetch(EDITOR + '/api/prerender/info').then((r) => r.ok, () => false);
  check(alive && Date.now() - t0 < 5000, 'M4 the editor still responds normally after the infinite loop', { alive, ms: Date.now() - t0 });

  const net = await mcpCall('measure_audio_js', { mediaId: placed.mediaId, sampleRate: 8000, code: `return await fetch(${JSON.stringify(EDITOR + '/api/prerender/info')}).then((r) => r.status);` }, conv);
  out.netLocal = net;
  check(net?.ok === false && /cannot access the network in the sandbox/.test(String(net.error)), 'M4 network attempt (this machine\'s editor /api) fails, and the error states that network access is not allowed', net);
  const netOut = await mcpCall('measure_audio_js', { mediaId: placed.mediaId, sampleRate: 8000, code: "try { const r = await fetch('https://example.com/'); return 'leaked ' + r.status; } catch (e) { return 'blocked: ' + e.message; }" }, conv);
  out.netExternal = netOut;
  check(netOut?.ok === true && /^blocked/.test(String(netOut.value)), 'M4 network attempt (external network) fails, and even when the code catches it, it only gets an error', netOut);
  const thrown = await mcpCall('measure_audio_js', { mediaId: placed.mediaId, sampleRate: 8000, code: 'const x = 1;\nthrow new Error("deliberate probe error:" + x);' }, conv);
  out.thrown = thrown;
  check(thrown?.ok === false && /deliberate probe error:1/.test(String(thrown.error)) && /line 2/.test(String(thrown.error)), 'M4 a thrown exception carries the error text and the line number', thrown);
  const again = await mcpCall('measure_audio_js', { mediaId: placed.mediaId, code: RMS_PEAK }, conv);
  check(again?.ok === true && near(again.value?.channels?.[0]?.rmsDb, RMS, 0.05), 'M4 normal measurement still works afterwards', again && { ok: again.ok, error: again.error });
  check(pageErrors.length === 0, 'Page has no uncaught exceptions', pageErrors.slice(0, 5));
} catch (error) {
  fails.push('exception: ' + (error?.stack || error));
} finally {
  if (browser) await browser.close().catch(() => {});
  if (!KEEP) {
    stopEditor();
    await delay(500);
    fs.rmSync(EXPORT_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } else {
    out.kept = EXPORT_DIR;
  }
}
console.log(JSON.stringify(out, null, 1).slice(0, 6000));
for (const p of passes) console.log('PASS', p);
for (const f of fails) console.log('FAIL', f);
if (fails.length) console.log(editorLog.join('').slice(-3000));
console.log(fails.length ? `Probe failed: ${fails.length} failed, ${passes.length} passed` : `Probe passed: ${passes.length} checks`);
timingLog.print();
process.exit(fails.length ? 1 : 0);
