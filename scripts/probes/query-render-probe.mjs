/**
 * 查询渲染调度的端到端探针(`docs/semantics/product/rendering.md`「Agent 优先只是插队」「AI 栏的操作预览可以插队」,
 * `docs/semantics/mechanism/rendering.md`「查询渲染与预渲染进程」;报告 `docs/archive/agent-reports/AGENT-query-render.md`)。
 * 起编辑器进程 + 预渲染进程(真 Chrome),读预渲染进程 `GET /api/frames/diagnostics` 的 `scheduler`
 * (`FramePipeline.noteSched`:每类活在哪个实例上开工的计数)逐条核对:
 *
 *   ① 用户在 AI 栏点开的动图(`GET /api/ai/visual/gif/<key>.gif`)在 `'queue'` lane 的预渲染间上渲(`preview@queue` +1),
 *      Agent 专用实例一次没动(`agent@agent` 不变);回的是一张 GIF;
 *   ② 模型的 `see_frames`(`POST /api/vision/snapshot`)照常走 Agent 专用实例(`agent@agent` 增加),不碰 `preview`;
 *   ③ 模型的 `get_gif`(`POST /api/ai/visual` 写规格 + `POST /api/ai/visual/render`)照常走 Agent 专用实例;
 *   ④ 后台预渲染进行中(Agent 专用实例刚用过、开着、空闲):专用实例接了后台那一趟的卡批(`card-batch@agent` ≥ 1);
 *   ⑤ 后台预渲染进行中用户点开另一张动图:它不等后台那一趟(完成时那一趟还没做完),照样在 `'queue'` lane 上;
 *   ⑥ 后台预渲染进行中模型再看一帧:照常返回(Agent 专用实例手里那一批做完就轮到它;`agentWaitMs` 记每个 Agent 任务等了多久);
 *   ⑦ 那一趟最后做完(`status: 'ready'`,没有 error)。
 *
 *   node scripts/probes/query-render-probe.mjs [--port 5756] [--keep]
 *
 * 端口:编辑器 `--port`(舞台另占 +1、+2);预渲染进程的端口由编辑器进程自己挑空闲端口(`vite-plugin-prerender.ts` 的 `freePort`)。
 * 产物落在新建的临时目录(`PROMPTCUT_EXPORT_DIR` / `PROMPTCUT_DATA_DIR`),跑完删掉;`--keep` 不关、不删。
 * 用的卡是 `src/cards/_probe/r6.tsx` 的 `r6-stateful` / `r6-canvas`(同 `ready-index-probe.mjs`)。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
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
/** 6 秒:后台那一趟要够长,④⑤⑥ 才落在它进行中 */
const PROJECT = {
  id: `qr-probe-${SESSION}`, name: '查询渲染调度探针', width: 1920, height: 1080, fps: FPS, duration: 6,
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
    if (Date.now() > deadline) { fails.push(`超时:${label}`); return null; }
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
  return until('编辑器进程起来', async () => (await fetch(EDITOR + '/api/prerender/info').then(r => r.ok, () => false)) || null, 120000);
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
  const base = await until('预渲染进程就绪', prerenderUrl, 180000);
  out.prerender = base;
  if (!base) throw new Error('预渲染进程没起来');
  const sched = async () => (await json(`${base}/api/frames/diagnostics`)).body?.scheduler ?? null;
  const count = (s, key) => s?.counts?.[key] ?? 0;
  const s0 = await sched();
  check(!!s0, '诊断里有 scheduler', s0);

  /* ---- ① 用户点开的动图 ---- */
  const spec1 = await postJson(`${base}/api/ai/visual`, { tool: 'get_gif', clipId: 'clip-stateful', after: PROJECT });
  check(spec1.ok && spec1.body?.gifUrl, '写下动图规格', spec1.body);
  let t0 = Date.now();
  const gif1 = await fetch(`${base}${spec1.body.gifUrl}`);
  const gif1Bytes = Buffer.from(await gif1.arrayBuffer());
  out.userGif = { status: gif1.status, type: gif1.headers.get('content-type'), bytes: gif1Bytes.length, ms: Date.now() - t0, magic: gif1Bytes.subarray(0, 6).toString('latin1') };
  const s1 = await sched();
  out.afterUserGif = s1?.counts;
  check(gif1.ok && out.userGif.magic.startsWith('GIF8'), '① 用户点开的动图回的是一张 GIF', out.userGif);
  check(count(s1, 'preview@queue') === count(s0, 'preview@queue') + 1, '① 用户点开的动图在 queue lane 上渲(preview@queue +1)', s1?.counts);
  check(count(s1, 'agent@agent') === count(s0, 'agent@agent'), '① Agent 专用实例一次没动(agent@agent 不变)', s1?.counts);
  check(count(s1, 'preview@agent') === 0, '① 预览没进 Agent 专用实例', s1?.counts);

  /* ---- ② 模型的 see_frames ---- */
  t0 = Date.now();
  const see = await postJson(`${base}/api/vision/snapshot`, { project: PROJECT, t: 1 });
  out.modelSee = { status: see.status, ms: Date.now() - t0, ok: see.body?.ok };
  const s2 = await sched();
  out.afterModelSee = s2?.counts;
  check(see.ok && see.body?.ok !== false, '② 模型的 see_frames 返回了', out.modelSee);
  check(count(s2, 'agent@agent') > count(s1, 'agent@agent'), '② 模型的 see_frames 走 Agent 专用实例(agent@agent 增加)', s2?.counts);
  check(count(s2, 'preview@queue') === count(s1, 'preview@queue'), '② 模型的 see_frames 不走 preview', s2?.counts);

  /* ---- ③ 模型的 get_gif ---- */
  const spec2 = await postJson(`${base}/api/ai/visual`, { tool: 'get_gif', clipId: 'clip-canvas', after: PROJECT });
  const rendered = await postJson(`${base}/api/ai/visual/render`, { key: spec2.body?.gifKey });
  const s3 = await sched();
  out.afterModelGif = s3?.counts;
  check(rendered.ok && typeof rendered.body?.grid === 'string' && rendered.body.grid.length > 0, '③ 模型的 get_gif 回了拼图', { status: rendered.status, error: rendered.body?.error });
  check(count(s3, 'agent@agent') === count(s2, 'agent@agent') + 1, '③ 模型的 get_gif 走 Agent 专用实例(agent@agent +1)', s3?.counts);
  check(count(s3, 'preview@queue') === count(s2, 'preview@queue'), '③ 模型的 get_gif 不走 preview', s3?.counts);
  check(s3?.agentOpen === true, '③ 之后 Agent 专用实例的预渲染间开着(空闲、未到关闭)', s3);

  /* ---- 后台预渲染开跑 ---- */
  const pushed = await postJson(EDITOR + '/api/data/project', { session: SESSION, localRev: 1, project: PROJECT });
  check(pushed.ok, '项目推进镜像', pushed.body);
  await until('预渲染进程手里有这一版项目', async () => (await json(`${base}/api/data/project?session=${SESSION}&localRev=1`)).ok || null, 30000);
  const preload = await postJson(`${base}/api/frames/preload`, { session: SESSION, localRev: 1 });
  check(preload.ok, '预渲染开跑', preload.body);
  const status = async () => (await postJson(`${base}/api/frames/status`, { session: SESSION, localRev: 1 })).body;

  /* ---- ④ 专用实例接后台那一趟的卡批 ---- */
  const stole = await until('Agent 专用实例接了后台的卡批', async () => {
    const s = await sched();
    return count(s, 'card-batch@agent') >= 1 ? s : null;
  }, 300000, 200);
  out.cardBatches = stole?.counts?.['card-batch@agent'] ?? 0;
  check(!!stole, '④ 后台预渲染进行中,空闲的 Agent 专用实例接了卡批(card-batch@agent ≥ 1)', stole?.counts);

  /* ---- ⑤ 后台进行中用户点开另一张动图 ---- */
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
  check(gif3.ok && gif3Bytes.subarray(0, 4).toString('latin1') === 'GIF8', '⑤ 后台进行中用户点开的动图照样回 GIF', out.userGifDuringPrerender);
  check(count(s5, 'preview@queue') === count(s4, 'preview@queue') + 1, '⑤ 在 queue lane 上(preview@queue +1)', s5?.counts);
  check(st5?.status && st5.status !== 'ready', '⑤ 动图回来时后台那一趟还没做完(没排在它后面)', st5);

  /* ---- ⑥ 后台进行中模型再看一帧 ---- */
  t0 = Date.now();
  const see2 = await postJson(`${base}/api/vision/snapshot`, { project: PROJECT, t: 2.5 });
  const s6 = await sched();
  out.modelSeeDuringPrerender = { status: see2.status, ms: Date.now() - t0, prerenderStatus: (await status())?.status,
    // 这次查询里每个 Agent 任务(see_frames 的一批、量实体框)从排进来到开工等了多久:等的是专用实例手里那一批卡批
    agentWaitMs: (s6?.recent ?? []).filter(r => r.kind === 'agent' && r.at >= t0).map(r => r.waitMs) };
  check(see2.ok && see2.body?.ok !== false, '⑥ 后台进行中模型的 see_frames 照常返回', out.modelSeeDuringPrerender);

  /* ---- ⑦ 那一趟做完 ---- */
  const done = await until('后台那一趟做完', async () => {
    const s = await status();
    return s && ['ready', 'error', 'cancelled'].includes(s.status) ? s : null;
  }, 600000, 1000);
  out.final = { status: done?.status, error: done?.error ?? null, scheduler: (await sched())?.counts };
  check(done?.status === 'ready' && !done?.error, '⑦ 后台那一趟做完、没有 error', out.final);
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
