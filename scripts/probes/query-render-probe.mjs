/**
 * End-to-end probe for query render scheduling (`docs/semantics/product/rendering.md` "Agent Priority
 * Is Just Queue Jumping", "Operation Preview in AI Panel Can Jump the Queue",
 * `docs/semantics/mechanism/rendering.md` "Query Render and Prerender Process"; report
 * `docs/archive/agent-reports/AGENT-query-render.md`).
 * Start editor process + prerender process (real Chrome), read `scheduler` from prerender process
 * `GET /api/frames/diagnostics` (`FramePipeline.noteSched`: count of which instance each task type
 * starts on) to verify item by item:
 *
 *   ① Animated GIF opened by user in AI panel (`GET /api/ai/visual/gif/<key>.gif`) renders on
 *      prerender room in `'queue'` lane (`preview@queue` +1), Agent dedicated instance is untouched
 *      (`agent@agent` unchanged); returns a GIF;
 *   ② Model's `see_frames` (`POST /api/vision/snapshot`) goes through Agent dedicated instance as
 *      usual (`agent@agent` increases), without touching `preview`;
 *   ③ Model's `get_gif` (`POST /api/ai/visual` writes spec + `POST /api/ai/visual/render`) goes
 *      through Agent dedicated instance as usual;
 *   ④ Background prerender in progress (Agent dedicated instance was just used, running, idle):
 *      dedicated instance picks up card batch of background pass (`card-batch@agent` ≥ 1);
 *   ⑤ User opens another animated GIF while background prerender is in progress: does not wait for
 *      background pass (that pass is not finished when this completes), stays on `'queue'` lane;
 *   ⑥ Model views another frame while background prerender is in progress: returns as usual (its
 *      turn comes once dedicated instance finishes current card batch; `agentWaitMs` records how
 *      long each Agent task waited);
 *   ⑦ That pass completes at last (`status: 'ready'`, no errors).
 *
 *   node scripts/probes/query-render-probe.mjs [--port 5756] [--keep]
 *
 * Port: editor `--port` (stage occupies +1, +2 additionally); prerender process port is picked from
 * free ports by editor process itself (`freePort` in `vite-plugin-prerender.ts`).
 * Artifacts land in newly created temp directory (`PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR`),
 * deleted after run; `--keep` neither closes nor deletes.
 * Cards used are `r6-stateful` / `r6-canvas` from `src/cards/_probe/r6.tsx` (same as
 * `ready-index-probe.mjs`).
 */
import '../lib/no-user-dirs.mjs'; // First import: do not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const PORT = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 5756);
const KEEP = args.includes('--keep');
const EDITOR = `http://127.0.0.1:${PORT}`;
const EXPORT_DIR = path.join(os.tmpdir(), `pc-query-render-probe-${Date.now().toString(36)}`);
const DATA_DIR = path.join(EXPORT_DIR, 'data');
fsSync.mkdirSync(DATA_DIR, { recursive: true });

const fails = [];
const out = { port: PORT, exportDir: EXPORT_DIR };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra))); return cond; };

const SESSION = `qr-${Date.now().toString(36)}`;
const FPS = 30;
const clip = (id, cardId, start, end, params = {}) => ({ id, kind: 'card', cardId, start, end, params });
/** 6 seconds: background pass must be long enough so ④⑤⑥ fall while it is in progress */
const PROJECT = {
  id: `qr-probe-${SESSION}`, name: 'Query render scheduling probe', width: 1920, height: 1080, fps: FPS, duration: 6,
  themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-1', name: 'tr-1', hidden: false, clips: [clip('clip-stateful', 'r6-stateful', 0, 6)] },
    { id: 'tr-2', name: 'tr-2', hidden: false, clips: [clip('clip-canvas', 'r6-canvas', 0, 6)] },
  ],
};

const json = async (url, init) => {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, body };
};
const postJson = (url, body) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

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
  if (fsSync.existsSync(local)) return local;
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
  const keep = c => { editorLog.push(c.toString()); if (editorLog.length > 400) editorLog.shift(); };
  editor.stdout.on('data', keep);
  editor.stderr.on('data', keep);
  return until('editor process is up', async () => (await fetch(EDITOR + '/api/prerender/info').then(r => r.ok, () => false)) || null, 120000);
}
function stopEditor() {
  if (!editor || editor.exitCode !== null || !editor.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(editor.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else editor.kill('SIGKILL');
}
const prerenderUrl = async () => {
  const info = await json(EDITOR + '/api/prerender/info');
  return info.body?.ready && info.body.url ? info.body.url : null;
};

try {
  await startEditor();
  const base = await until('prerender process ready', prerenderUrl, 180000);
  out.prerender = base;
  if (!base) throw new Error('The prerender process did not start');
  const sched = async () => (await json(`${base}/api/frames/diagnostics`)).body?.scheduler ?? null;
  const count = (s, key) => s?.counts?.[key] ?? 0;
  const s0 = await sched();
  check(!!s0, 'Diagnostics include scheduler', s0);

  /* ---- ① User-opened animated GIF ---- */
  const spec1 = await postJson(`${base}/api/ai/visual`, { tool: 'get_gif', clipId: 'clip-stateful', after: PROJECT });
  check(spec1.ok && spec1.body?.gifUrl, 'Animated-image spec written', spec1.body);
  let t0 = Date.now();
  const gif1 = await fetch(`${base}${spec1.body.gifUrl}`);
  const gif1Bytes = Buffer.from(await gif1.arrayBuffer());
  out.userGif = { status: gif1.status, type: gif1.headers.get('content-type'), bytes: gif1Bytes.length, ms: Date.now() - t0, magic: gif1Bytes.subarray(0, 6).toString('latin1') };
  const s1 = await sched();
  out.afterUserGif = s1?.counts;
  check(gif1.ok && out.userGif.magic.startsWith('GIF8'), '① the animated image the user opens returns a GIF', out.userGif);
  check(count(s1, 'preview@queue') === count(s0, 'preview@queue') + 1, '① the animated image the user opens renders on the queue lane (preview@queue +1)', s1?.counts);
  check(count(s1, 'agent@agent') === count(s0, 'agent@agent'), '① dedicated Agent instance not used at all (agent@agent unchanged)', s1?.counts);
  check(count(s1, 'preview@agent') === 0, '① preview did not enter the dedicated Agent instance', s1?.counts);

  /* ---- ② Model's see_frames ---- */
  t0 = Date.now();
  const see = await postJson(`${base}/api/vision/snapshot`, { project: PROJECT, t: 1 });
  out.modelSee = { status: see.status, ms: Date.now() - t0, ok: see.body?.ok };
  const s2 = await sched();
  out.afterModelSee = s2?.counts;
  check(see.ok && see.body?.ok !== false, '② the model\'s see_frames returned', out.modelSee);
  check(count(s2, 'agent@agent') > count(s1, 'agent@agent'), '② the model\'s see_frames goes through the dedicated Agent instance (agent@agent increased)', s2?.counts);
  check(count(s2, 'preview@queue') === count(s1, 'preview@queue'), '② the model\'s see_frames does not go through preview', s2?.counts);

  /* ---- ③ Model's get_gif ---- */
  const spec2 = await postJson(`${base}/api/ai/visual`, { tool: 'get_gif', clipId: 'clip-canvas', after: PROJECT });
  const rendered = await postJson(`${base}/api/ai/visual/render`, { key: spec2.body?.gifKey });
  const s3 = await sched();
  out.afterModelGif = s3?.counts;
  check(rendered.ok && typeof rendered.body?.grid === 'string' && rendered.body.grid.length > 0, '③ the model\'s get_gif returned a frame grid', { status: rendered.status, error: rendered.body?.error });
  check(count(s3, 'agent@agent') === count(s2, 'agent@agent') + 1, '③ the model\'s get_gif goes through the dedicated Agent instance (agent@agent +1)', s3?.counts);
  check(count(s3, 'preview@queue') === count(s2, 'preview@queue'), '③ the model\'s get_gif does not go through preview', s3?.counts);
  check(s3?.agentOpen === true, '③ afterwards the dedicated Agent instance\'s prerender room stays open (idle, not yet closed)', s3);

  /* ---- Background prerender starts running ---- */
  const pushed = await postJson(EDITOR + '/api/data/project', { session: SESSION, localRev: 1, project: PROJECT });
  check(pushed.ok, 'Project pushed to the mirror', pushed.body);
  await until('Prerender process holds this version of the project', async () => (await json(`${base}/api/data/project?session=${SESSION}&localRev=1`)).ok || null, 30000);
  const preload = await postJson(`${base}/api/frames/preload`, { session: SESSION, localRev: 1 });
  check(preload.ok, 'Prerender started', preload.body);
  const status = async () => (await postJson(`${base}/api/frames/status`, { session: SESSION, localRev: 1 })).body;

  /* ---- ④ Dedicated instance picks up card batch from background pass ---- */
  const stole = await until('Dedicated Agent instance took a background card batch', async () => {
    const s = await sched();
    return count(s, 'card-batch@agent') >= 1 ? s : null;
  }, 300000, 200);
  out.cardBatches = stole?.counts?.['card-batch@agent'] ?? 0;
  check(!!stole, '④ while background prerender is running, the idle dedicated Agent instance took a card batch (card-batch@agent ≥ 1)', stole?.counts);

  /* ---- ⑤ User opens another animated GIF while background is in progress ---- */
  const PROJECT_B = { ...PROJECT, tracks: PROJECT.tracks.map(t => ({ ...t, clips: t.clips.map(c => c.id === 'clip-stateful' ? { ...c, params: { variant: 'b' } } : c) })) };
  const spec3 = await postJson(`${base}/api/ai/visual`, { tool: 'get_gif', clipId: 'clip-stateful', after: PROJECT_B });
  const s4 = await sched();
  t0 = Date.now();
  const gif3 = await fetch(`${base}${spec3.body?.gifUrl}`);
  const gif3Bytes = Buffer.from(await gif3.arrayBuffer());
  const st5 = await status();
  const s5 = await sched();
  out.userGifDuringPrerender = { status: gif3.status, ms: Date.now() - t0, bytes: gif3Bytes.length, prerenderStatus: st5?.status,
    waitMs: (s5?.recent ?? []).filter(r => r.kind === 'preview' && r.at >= t0).map(r => r.waitMs) };
  check(gif3.ok && gif3Bytes.subarray(0, 4).toString('latin1') === 'GIF8', '⑤ while the background run is in progress, the animated image the user opens still returns a GIF', out.userGifDuringPrerender);
  check(count(s5, 'preview@queue') === count(s4, 'preview@queue') + 1, '⑤ on the queue lane (preview@queue +1)', s5?.counts);
  check(st5?.status && st5.status !== 'ready', '⑤ the background run was not finished when the animated image came back (it was not queued behind it)', st5);

  /* ---- ⑥ Model views another frame while background is in progress ---- */
  t0 = Date.now();
  const see2 = await postJson(`${base}/api/vision/snapshot`, { project: PROJECT, t: 2.5 });
  const s6 = await sched();
  out.modelSeeDuringPrerender = { status: see2.status, ms: Date.now() - t0, prerenderStatus: (await status())?.status,
    // How long each Agent task (a batch of see_frames, measuring entity box) waited from being queued to starting in this query: waiting for card batch held by dedicated instance
    agentWaitMs: (s6?.recent ?? []).filter(r => r.kind === 'agent' && r.at >= t0).map(r => r.waitMs) };
  check(see2.ok && see2.body?.ok !== false, '⑥ while the background run is in progress, the model\'s see_frames returns as usual', out.modelSeeDuringPrerender);

  /* ---- ⑦ That pass completes ---- */
  const done = await until('Background run finishes', async () => {
    const s = await status();
    return s && ['ready', 'error', 'cancelled'].includes(s.status) ? s : null;
  }, 600000, 1000);
  out.final = { status: done?.status, error: done?.error ?? null, scheduler: (await sched())?.counts };
  check(done?.status === 'ready' && !done?.error, '⑦ the background run finished with no error', out.final);
} catch (error) {
  fails.push('exception: ' + (error?.stack || error));
} finally {
  if (!KEEP) stopEditor();
  if (KEEP) out.kept = EXPORT_DIR;
  else { await delay(800); await fs.rm(EXPORT_DIR, { recursive: true, force: true }).catch(() => {}); }
}

if (fails.length) out.editorLogTail = editorLog.slice(-30).join('').slice(-4000);
out.fails = fails;
console.log(JSON.stringify(out, null, 2));
process.exit(fails.length ? 1 : 0);
