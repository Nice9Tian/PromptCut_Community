/**
 * 队列模式认领闸的端到端探针(`docs/semantics/mechanism/rendering.md`「Agent 优先只是插队」;
 * 认领闸见 `server/queue-agent-spare.mjs`,报告 `docs/archive/agent-reports/AGENT-query-render-2.md` 第 4 节、第 7 节「没跑的」;
 * 本探针出自 `docs/archive/agent-reports/AGENT-maint-3.md` 第 4 项)。
 *
 * 前后两趟,各起一个独立的文档服务(临时数据目录,只绑回环)和一台队列模式的编辑器(`PROMPTCUT_QUEUE_NODE=1`,
 * 它拉起自己的预渲染进程、本机节点),各用一个空帧库、同一个探针项目(6 秒、三张卡,切出十来个快照细任务):
 *
 *   趟 1「专用实例没开」:不碰 Agent,直接 preload,等后台那一趟 ready、所有细任务落定。一路每 150 ms 采一次诊断,判:
 *     - 本机节点的持有数(`queue.held`)从没超过 1(`maxConcurrent: 1`,不多认领);
 *     - 多出的那一格(`queue.spare.spare`)从没开;Agent 专用实例从没开过(`scheduler.agentOpen`);
 *     - 专用实例上一项队列任务都没做(`scheduler.counts['queue@agent']` 为 0)。
 *   趟 2「专用实例开着」:先让模型看一帧(`POST /api/vision/snapshot`),专用实例开着、空闲;再 preload。判:
 *     - 见过持有两项(`queue.held` 长度 2)、见过多出的那一格开;
 *     - 专用实例上做过快照任务(`queue@agent >= 1`):多认领的那一项交给了它;
 *     - **Agent 任务不排在它后面**:看到专用实例正做着一项队列任务(`scheduler.agentUnit === 'queue'`)时,模型再看一帧;
 *       这次请求的第一个 Agent 任务开工之前,专用实例上不许再开工新的普通预渲染(`claim-gate-judge.mjs` 的 `judgeAgentOrder`),
 *       它只等手里那一批(4 帧)做完:专用实例上的队列任务按批让路(AGENT-maint-3 第 5 项)。输出 `agentWaitMs`,
 *       判它不超过「一批加一次切换」的量级(`--agent-wait-limit-ms`,缺省 15000;改前整项 60 帧要等约 38 s);
 *       诊断 `scheduler.yields` 记过让路。
 *   两趟都要:后台那一趟以 ready 结束、细任务全部 done、没有失败。
 *
 *   node scripts/probes/claim-gate-probe.mjs [--port 5990] [--doc-port 5993] [--only off|on] [--timeout-min 20] [--keep]
 *
 * 端口:趟 1 编辑器 `--port`(另占 +1、+2 当舞台端口),文档服务 `--doc-port`;趟 2 各自 +4(编辑器 +4..+6,文档服务 +4)。
 * 编辑器带 `PROMPTCUT_NO_PORT_FILE=1`,不写端口文件;轨道流关掉(`PROMPTCUT_STREAMS=0`,流任务不走认领闸的那一格)。
 * 产物落新建的临时目录,跑完删掉;`--keep` 不删。输出最后是一段 JSON:`{ ok, runs: { off, on }, fails }`,`ok` 为假时退出码 1。
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
import { summarizeSamples, judgeAgentOrder, judgeAgentWait, judgeRun } from './claim-gate-judge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const PORT = Number(arg('--port', 5990));
const DOC_PORT = Number(arg('--doc-port', 5993));
const ONLY = arg('--only', null);
const KEEP = args.includes('--keep');
const TIMEOUT_MS = Number(arg('--timeout-min', 20)) * 60_000;
const AGENT_WAIT_LIMIT_MS = Number(arg('--agent-wait-limit-ms', 15000));
const STAMP = Date.now().toString(36);

const fails = [];
const out = { port: PORT, docPort: DOC_PORT, runs: {} };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 800))); return cond; };

const FPS = 30;
/** 6 秒 = 180 帧:两张共享档的卡各切三段(0～59、60～119、120～179),本地档的卡从 1 秒起;一段约几十秒,够探针看清楚 */
const projectOf = id => ({
  id, name: '认领闸探针', width: 1920, height: 1080, fps: FPS, duration: 6,
  themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-1', name: 'tr-1', hidden: false, clips: [{ id: 'clip-stateful', kind: 'card', cardId: 'r6-stateful', start: 0, end: 6, params: {} }] },
    { id: 'tr-2', name: 'tr-2', hidden: false, clips: [{ id: 'clip-canvas', kind: 'card', cardId: 'r6-canvas', start: 0, end: 6, params: {} }] },
    { id: 'tr-3', name: 'tr-3', hidden: false, clips: [{ id: 'clip-unknown', kind: 'card', cardId: 'r6-unknown', start: 1, end: 6, params: {} }] },
  ],
});

const json = async (url, init) => {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, body };
};
const postJson = (url, body) => json(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

async function until(label, fn, timeoutMs = 120000, everyMs = 500) {
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
function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGKILL');
}
const exited = child => new Promise(resolve => { if (!child || child.exitCode !== null) return resolve(); child.once('exit', () => resolve()); setTimeout(resolve, 15000).unref?.(); });
const portFree = async port => {
  const net = await import('node:net');
  return new Promise(resolve => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)));
  });
};

/**
 * 一趟。`withAgent`:preload 之前先让模型看一帧,Agent 专用实例开着;preload 进行中看到专用实例在做队列任务时再看一帧。
 */
async function runOnce(label, { withAgent, port, docPort }) {
  const run = { label, withAgent, port, docPort };
  const children = [];
  const exportDir = path.join(os.tmpdir(), `pc-claim-gate-${label}-${STAMP}`);
  run.exportDir = exportDir;
  const log = [];
  try {
    for (const p of [port, port + 1, port + 2, docPort]) check(await portFree(p), `[${label}] 端口 ${p} 空着`);
    if (fails.length) return run;
    await fs.mkdir(path.join(exportDir, 'data'), { recursive: true });

    // 文档服务:独立、临时数据目录、只绑回环(编辑器与预渲染进程连它是本机身份)
    const docEnv = { ...process.env, PROMPTCUT_DOCSERVICE_PORT: String(docPort), PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_DATA: path.join(exportDir, 'docservice') };
    delete docEnv.PROMPTCUT_CLUSTER_TOKEN;
    const doc = spawn(process.execPath, [path.join(ROOT, 'server', 'docservice', 'main.mjs')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: docEnv });
    doc.stdout.resume(); doc.stderr.resume();
    children.push(doc);
    if (!await until(`[${label}] 文档服务起来`, async () => (await json(`http://127.0.0.1:${docPort}/healthz`)).body?.ok === true || null, 30000)) return run;

    const env = { ...process.env, PROMPTCUT_EXPORT_DIR: exportDir, PROMPTCUT_DATA_DIR: path.join(exportDir, 'data'),
      PROMPTCUT_DOCSERVICE_URL: `ws://127.0.0.1:${docPort}`, PROMPTCUT_QUEUE_NODE: '1', PROMPTCUT_STREAMS: '0', PROMPTCUT_NO_PORT_FILE: '1' };
    delete env.PROMPTCUT_CLUSTER_TOKEN;
    delete env.PROMPTCUT_PRERENDER_MODE;   // 缺省 full:两样都有,认领闸才有意义
    const editor = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    children.push(editor);
    const keep = c => { log.push(c.toString()); if (log.length > 400) log.shift(); };
    editor.stdout.on('data', keep); editor.stderr.on('data', keep);
    const EDITOR = `http://127.0.0.1:${port}`;
    if (!await until(`[${label}] 编辑器进程起来`, async () => (await fetch(EDITOR + '/api/prerender/info').then(r => r.ok, () => false)) || null, 120000)) return run;
    const base = await until(`[${label}] 预渲染进程就绪`, async () => {
      const info = await json(EDITOR + '/api/prerender/info');
      return info.body?.ready && info.body.url ? info.body.url : null;
    }, 180000);
    if (!base) return run;
    run.prerender = base;
    const diag = async () => (await json(`${base}/api/frames/diagnostics`)).body ?? {};
    const PROJECT = projectOf(`claim-gate-${label}-${STAMP}`);

    // 第一次打 /api/frames/* 才建管线、起本机节点;等它连上文档服务、报到
    if (!await until(`[${label}] 本机节点报到(queue.active)`, async () => (await diag()).queue?.active === true || null, 180000, 1000)) return run;
    const d0 = await diag();
    run.mode = d0.mode?.mode ?? null;
    check(run.mode === 'full', `[${label}] 预渲染进程是 full 模式`, d0.mode);
    check(d0.scheduler?.agentOpen === false, `[${label}] 开始时 Agent 专用实例没开`, d0.scheduler);

    if (withAgent) {
      const see = await postJson(`${base}/api/vision/snapshot`, { project: PROJECT, t: 1 });
      run.firstSee = { status: see.status, ok: see.body?.ok ?? null };
      check(see.ok && see.body?.ok !== false, `[${label}] 模型先看一帧,返回了`, run.firstSee);
      const s = (await diag()).scheduler;
      check(s?.agentOpen === true, `[${label}] 之后 Agent 专用实例开着`, s);
    }

    const SESSION = `cg-${label}-${STAMP}`;
    const pushed = await postJson(EDITOR + '/api/data/project', { session: SESSION, localRev: 1, project: PROJECT });
    check(pushed.ok, `[${label}] 项目推进镜像`, pushed.body);
    await until(`[${label}] 预渲染进程手里有这一版项目`, async () => (await json(`${base}/api/data/project?session=${SESSION}&localRev=1`)).ok || null, 30000);
    const started = Date.now();
    const preload = await postJson(`${base}/api/frames/preload`, { session: SESSION, localRev: 1 });
    check(preload.ok, `[${label}] preload 开跑`, preload.body);

    // 一路采样:每 150 ms 读一次诊断;每 2 秒照页面那样重发 preload 保活
    const samples = [];
    let lastKeepAlive = 0, readyBody = null, settled = null, order = null, orderSend = null;
    const deadline = Date.now() + TIMEOUT_MS;
    while (Date.now() < deadline) {
      let d;
      try { d = await diag(); } catch { d = null; }
      if (d) {
        const q = d.queue ?? {}, s = d.scheduler ?? {};
        samples.push({ at: Date.now(), held: Array.isArray(q.held) ? q.held.length : 0, spare: q.spare?.spare ?? null,
          agentOpen: s.agentOpen ?? null, agentUnit: s.agentUnit ?? null, queueAtAgent: s.counts?.['queue@agent'] ?? 0 });
        // 趟 2:专用实例正做着一项队列任务 → 模型再看一帧(只发一次),看它排在哪
        if (withAgent && !orderSend && s.agentUnit === 'queue') {
          const sentAt = Date.now();
          orderSend = postJson(`${base}/api/vision/snapshot`, { project: PROJECT, t: 2.5 }).then(async see2 => {
            const after = (await diag()).scheduler ?? {};
            order = { sentAt, status: see2.status, ok: see2.body?.ok ?? null, ms: Date.now() - sentAt, ...judgeAgentOrder(after.recent, sentAt),
              recent: (after.recent ?? []).filter(r => r.at >= sentAt - 60_000).map(r => ({ ...r, at: r.at - sentAt })) };
          }, error => { order = { sentAt, error: String(error?.message || error) }; });
        }
        const planId = q.published?.[0]?.planId;
        const derived = planId ? q.plans?.[planId] : null;
        if (Array.isArray(derived) && derived.length) {
          const states = derived.map(id => q.tasks?.[id]?.state ?? 'pending');
          if (states.every(st => st === 'done' || st === 'failed')) settled = { planId, derived, states, stats: q.stats };
        }
      }
      if (Date.now() - lastKeepAlive >= 2000) {
        lastKeepAlive = Date.now();
        const st = await postJson(`${base}/api/frames/preload`, { session: SESSION, localRev: 1 }).catch(() => null);
        if (st?.body?.status === 'ready' || st?.body?.status === 'error') readyBody = st.body;
      }
      if (readyBody && settled && (!withAgent || !orderSend || order)) break;
      await delay(150);
    }
    if (orderSend) await orderSend;
    run.preloadMs = Date.now() - started;
    run.ready = readyBody ? { status: readyBody.status, error: readyBody.error ?? null } : null;
    check(readyBody?.status === 'ready', `[${label}] 后台那一趟以 ready 结束`, run.ready);
    check(!!settled, `[${label}] plan 切分完、细任务全部落定`);
    if (settled) {
      run.tasks = settled.derived.length;
      run.snapshotTasks = settled.derived.filter(id => id.startsWith('snapshot:')).length;
      run.done = settled.states.filter(st => st === 'done').length;
      run.failedTasks = settled.derived.filter((id, i) => settled.states[i] === 'failed');
      run.queueStats = settled.stats;
      check(run.failedTasks.length === 0, `[${label}] 没有细任务失败`, run.failedTasks);
      check(run.snapshotTasks >= 2, `[${label}] 切出了至少两个快照细任务`, settled.derived);
    }
    const dEnd = await diag();
    run.counts = dEnd.scheduler?.counts ?? {};
    run.yields = dEnd.scheduler?.yields ?? null;
    run.summary = summarizeSamples(samples);
    for (const f of judgeRun({ withAgent, summary: run.summary, counts: run.counts })) fails.push(`[${label}] ${f}`);
    if (withAgent) {
      run.agentOrder = order;
      check(!!orderSend, `[${label}] 采样期间见到过专用实例在做队列任务(才能测 Agent 任务排在哪)`, run.summary);
      if (order) {
        check(!order.error && order.status === 200 && order.ok !== false, `[${label}] 专用实例忙着时模型再看一帧,照常返回`, { status: order.status, error: order.error });
        check(order.ok !== false && order.jumped?.length === 0 && order.agentAt !== null, `[${label}] Agent 任务不排在排队中的预渲染后面`, { reason: order.reason, jumped: order.jumped });
        // judgeAgentWait 的 15 秒上限量的是机器与网络有多快，语义里没有这条时间承诺：只记录，不进 fails
        // （判据函数 claim-gate-judge.mjs 一字不动，它有自己的单测；耗时只记录,不当闸门(verification.md,2026-10-07 用户改定);2026-10-23 探针总审第二遍扫描补改）
        const agentWaitNotes = judgeAgentWait(order, AGENT_WAIT_LIMIT_MS);
        if (agentWaitNotes.length) (out.agentWaitNotes ??= []).push(`[${label}] 等 Agent 落定的用时超过 ${AGENT_WAIT_LIMIT_MS} ms（只记录）：${agentWaitNotes.join('；')}`);
        check((run.yields?.count ?? 0) >= 1, `[${label}] 专用实例上的队列任务在批边界让过路(scheduler.yields.count >= 1)`, run.yields);
      }
    }
    return run;
  } catch (error) {
    fails.push(`[${label}] exception: ${error?.stack || error}`);
    return run;
  } finally {
    if (fails.some(f => f.startsWith(`[${label}]`))) run.editorLogTail = log.join('').slice(-4000);
    for (const child of children.reverse()) killTree(child);
    await Promise.all(children.map(exited));
    if (!KEEP) { await delay(800); await fs.rm(exportDir, { recursive: true, force: true }).catch(() => {}); }
  }
}

if (ONLY !== 'on') out.runs.off = await runOnce('off', { withAgent: false, port: PORT, docPort: DOC_PORT });
if (ONLY !== 'off') out.runs.on = await runOnce('on', { withAgent: true, port: PORT + 4, docPort: DOC_PORT + 4 });
out.ok = fails.length === 0;
out.fails = fails;
console.log(JSON.stringify(out, null, 2));
process.exit(out.ok ? 0 : 1);
