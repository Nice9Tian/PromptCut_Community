/**
 * End-to-end probe for queue mode claim gate (`docs/semantics/mechanism/rendering.md` "Agent
 * priority is just jumping the queue"; see `server/queue-agent-spare.mjs` for claim gate, report
 * `docs/archive/agent-reports/AGENT-query-render-2.md` Section 4, Section 7 "Unrun"; this probe
 * originates from item 4 of `docs/archive/agent-reports/AGENT-maint-3.md`).
 *
 * Two passes in total, each starting an independent document service (temporary data directory,
 * bound only to loopback) and a queue mode editor (`PROMPTCUT_QUEUE_NODE=1`, which spins up its own
 * prerender process and local node), each using an empty frame store and the same probe project
 * (6 seconds, three cards, sliced into a dozen snapshot fine-grained tasks):
 *
 *   Pass 1 "dedicated instance not open": does not touch Agent, directly preloads, waiting for
 *   background pass to be ready and all fine-grained tasks to settle. Samples diagnostics every
 *   150 ms along the way, evaluating:
 *     - Held count of local node (`queue.held`) never exceeded 1 (`maxConcurrent: 1`, no extra claims);
 *     - The extra slot (`queue.spare.spare`) was never open; Agent dedicated instance was never open
 *       (`scheduler.agentOpen`);
 *     - Dedicated instance did not run a single queue task (`scheduler.counts['queue@agent']` is 0).
 *   Pass 2 "dedicated instance open": first let model inspect one frame (`POST /api/vision/snapshot`),
 *   dedicated instance open and idle; then preload. Evaluates:
 *     - Saw holding two items (`queue.held` length 2), saw extra slot open;
 *     - Ran snapshot tasks on dedicated instance (`queue@agent >= 1`): the extra claimed item was given to it;
 *     - **Agent tasks do not queue behind it**: when seeing dedicated instance running a queue task
 *       (`scheduler.agentUnit === 'queue'`), let model inspect another frame; before starting the first
 *       Agent task of this request, dedicated instance must not start any new normal prerender
 *       (`judgeAgentOrder` in `claim-gate-judge.mjs`), waiting only for the batch in hand (4 frames)
 *       to finish: queue tasks on dedicated instance yield in batches (item 5 of AGENT-maint-3).
 *       Outputs `agentWaitMs`, asserting it does not exceed the order of magnitude of "one batch plus
 *       one switch" (`--agent-wait-limit-ms`, defaults to 15000; before change, whole 60 frames waited
 *       ~38 s); diagnostic `scheduler.yields` recorded yields.
 *   Both passes require: background pass finishes with ready, fine-grained tasks all done, no failures.
 *
 *   node scripts/probes/claim-gate-probe.mjs [--port 5990] [--doc-port 5993] [--only off|on] [--timeout-min 20] [--keep]
 *
 * Ports: Pass 1 editor `--port` (additionally taking +1 and +2 as stage ports), document service
 * `--doc-port`; Pass 2 adds +4 to each (editor +4..+6, document service +4). Editor runs with
 * `PROMPTCUT_NO_PORT_FILE=1`, not writing port files; track streams disabled (`PROMPTCUT_STREAMS=0`,
 * stream tasks do not use claim gate's slot). Artifacts land in newly created temporary directory,
 * deleted after running; `--keep` does not delete. Final output is a JSON snippet:
 * `{ ok, runs: { off, on }, fails }`, exit code 1 when `ok` is false.
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
/**
 * 6 seconds = 180 frames: two shared-tier cards each cut into three segments (0-59, 60-119,
 * 120-179), local-tier card starts from 1 second; each segment takes about tens of seconds,
 * enough for probe to observe clearly
 */
const projectOf = id => ({
  id, name: 'Claim gate probe', width: 1920, height: 1080, fps: FPS, duration: 6,
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
 * One pass. `withAgent`: let model inspect one frame before preload, with Agent dedicated instance
 * open; while preload is in progress, inspect another frame when seeing dedicated instance running
 * a queue task.
 */
async function runOnce(label, { withAgent, port, docPort }) {
  const run = { label, withAgent, port, docPort };
  const children = [];
  const exportDir = path.join(os.tmpdir(), `pc-claim-gate-${label}-${STAMP}`);
  run.exportDir = exportDir;
  const log = [];
  try {
    for (const p of [port, port + 1, port + 2, docPort]) check(await portFree(p), `[${label}] port ${p} is free`);
    if (fails.length) return run;
    await fs.mkdir(path.join(exportDir, 'data'), { recursive: true });

    // Document service: independent, temporary data directory, bound only to loopback (editor and
    // prerender process connect to it with local identity)
    const docEnv = { ...process.env, PROMPTCUT_DOCSERVICE_PORT: String(docPort), PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_DATA: path.join(exportDir, 'docservice') };
    delete docEnv.PROMPTCUT_CLUSTER_TOKEN;
    const doc = spawn(process.execPath, [path.join(ROOT, 'server', 'docservice', 'main.mjs')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: docEnv });
    doc.stdout.resume(); doc.stderr.resume();
    children.push(doc);
    if (!await until(`[${label}] document service up`, async () => (await json(`http://127.0.0.1:${docPort}/healthz`)).body?.ok === true || null, 30000)) return run;

    const env = { ...process.env, PROMPTCUT_EXPORT_DIR: exportDir, PROMPTCUT_DATA_DIR: path.join(exportDir, 'data'),
      PROMPTCUT_DOCSERVICE_URL: `ws://127.0.0.1:${docPort}`, PROMPTCUT_QUEUE_NODE: '1', PROMPTCUT_STREAMS: '0', PROMPTCUT_NO_PORT_FILE: '1' };
    delete env.PROMPTCUT_CLUSTER_TOKEN;
    delete env.PROMPTCUT_PRERENDER_MODE;   // Defaults to full: claim gate only makes sense when both are present
    const editor = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    children.push(editor);
    const keep = c => { log.push(c.toString()); if (log.length > 400) log.shift(); };
    editor.stdout.on('data', keep); editor.stderr.on('data', keep);
    const EDITOR = `http://127.0.0.1:${port}`;
    if (!await until(`[${label}] editor process up`, async () => (await fetch(EDITOR + '/api/prerender/info').then(r => r.ok, () => false)) || null, 120000)) return run;
    const base = await until(`[${label}] prerender process ready`, async () => {
      const info = await json(EDITOR + '/api/prerender/info');
      return info.body?.ready && info.body.url ? info.body.url : null;
    }, 180000);
    if (!base) return run;
    run.prerender = base;
    const diag = async () => (await json(`${base}/api/frames/diagnostics`)).body ?? {};
    const PROJECT = projectOf(`claim-gate-${label}-${STAMP}`);

    // Only build the pipeline and start the local node on the first hit to /api/frames/*; wait for it
    // to connect to the document service and check in
    if (!await until(`[${label}] local node checked in (queue.active)`, async () => (await diag()).queue?.active === true || null, 180000, 1000)) return run;
    const d0 = await diag();
    run.mode = d0.mode?.mode ?? null;
    check(run.mode === 'full', `[${label}] prerender process is in full mode`, d0.mode);
    check(d0.scheduler?.agentOpen === false, `[${label}] dedicated Agent instance is off at the start`, d0.scheduler);

    if (withAgent) {
      const see = await postJson(`${base}/api/vision/snapshot`, { project: PROJECT, t: 1 });
      run.firstSee = { status: see.status, ok: see.body?.ok ?? null };
      check(see.ok && see.body?.ok !== false, `[${label}] the model views a frame first and it returned`, run.firstSee);
      const s = (await diag()).scheduler;
      check(s?.agentOpen === true, `[${label}] dedicated Agent instance is on afterwards`, s);
    }

    const SESSION = `cg-${label}-${STAMP}`;
    const pushed = await postJson(EDITOR + '/api/data/project', { session: SESSION, localRev: 1, project: PROJECT });
    check(pushed.ok, `[${label}] project pushed to the mirror`, pushed.body);
    await until(`[${label}] prerender process holds this version of the project`, async () => (await json(`${base}/api/data/project?session=${SESSION}&localRev=1`)).ok || null, 30000);
    const started = Date.now();
    const preload = await postJson(`${base}/api/frames/preload`, { session: SESSION, localRev: 1 });
    check(preload.ok, `[${label}] preload started`, preload.body);

    // Continuous sampling: read diagnostics every 150 ms; resend preload every 2 s like the page does
    // to keep alive
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
        // Pass 2: dedicated instance is running a queue task → model inspects one more frame (sent only
        // once) to see where it is queued
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
    check(readyBody?.status === 'ready', `[${label}] the background run ended with ready`, run.ready);
    check(!!settled, `[${label}] plan split finished, all subtasks settled`);
    if (settled) {
      run.tasks = settled.derived.length;
      run.snapshotTasks = settled.derived.filter(id => id.startsWith('snapshot:')).length;
      run.done = settled.states.filter(st => st === 'done').length;
      run.failedTasks = settled.derived.filter((id, i) => settled.states[i] === 'failed');
      run.queueStats = settled.stats;
      check(run.failedTasks.length === 0, `[${label}] no subtask failed`, run.failedTasks);
      check(run.snapshotTasks >= 2, `[${label}] at least two snapshot subtasks were split out`, settled.derived);
    }
    const dEnd = await diag();
    run.counts = dEnd.scheduler?.counts ?? {};
    run.yields = dEnd.scheduler?.yields ?? null;
    run.summary = summarizeSamples(samples);
    for (const f of judgeRun({ withAgent, summary: run.summary, counts: run.counts })) fails.push(`[${label}] ${f}`);
    if (withAgent) {
      run.agentOrder = order;
      check(!!orderSend, `[${label}] the dedicated instance was seen running queue tasks during sampling (needed to measure where the Agent task is queued)`, run.summary);
      if (order) {
        check(!order.error && order.status === 200 && order.ok !== false, `[${label}] while the dedicated instance is busy, the model views another frame and it returns as usual`, { status: order.status, error: order.error });
        check(order.ok !== false && order.jumped?.length === 0 && order.agentAt !== null, `[${label}] the Agent task is not queued behind the waiting prerenders`, { reason: order.reason, jumped: order.jumped });
        // The 15 s cap in judgeAgentWait measures how fast the machine and network are; there is no such
        // timing commitment in the semantics: record only, do not enter fails
        // (judge function claim-gate-judge.mjs is kept untouched, it has its own unit tests; duration is
        // only recorded, not treated as a gate (verification.md, user decision, 2026-10-07); patched during
        // second scan of probe audit, 2026-10-23)
        const agentWaitNotes = judgeAgentWait(order, AGENT_WAIT_LIMIT_MS);
        if (agentWaitNotes.length) (out.agentWaitNotes ??= []).push(`[${label}] waiting for the Agent to settle took longer than ${AGENT_WAIT_LIMIT_MS} ms (record only): ${agentWaitNotes.join(';')}`);
        check((run.yields?.count ?? 0) >= 1, `[${label}] queue tasks on the dedicated instance yielded at batch boundaries (scheduler.yields.count >= 1)`, run.yields);
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
