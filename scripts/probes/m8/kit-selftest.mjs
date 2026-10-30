/**
 * m8 公共件的本机替身自检（计划 `docs/plan/m8-plan.md` 第 3 节第 1 步「各本机替身跑通」）：用公共件拼一轮最小的多角色联调，
 * 证明角色与协调口 KV 的约定、进程起停、旁观节点、假节点 / 假发布方、代理的受扰与 stall / resume、J 判据、结果形状能跑通。
 * 不是 E1～E6 的用例（那些在 `m8-e-probe.mjs`，分支 `claude/m8-e2e`）。
 *
 *   node scripts/probes/m8/kit-selftest.mjs [--role all]            本机替身：起临时托管组合与协调口，三个角色各一个子进程
 *   node scripts/probes/m8/kit-selftest.mjs --role creator | node  --coord <url> [--run <id>] …   单个角色（跨机也能跑，参数同下）
 *
 *   --role all 专用：
 *     [--real-host]          另起一个真的独立渲染主机（`cloud/scripts/render-host.mjs`，端口 5737～5739），核它起得来、
 *                            真实指纹与假任务的两种指纹都不同所以认领 0、IPC shutdown 正常退出（退出码 0）
 *     [--queue-editor]       另起一个桌面编辑器队列节点（编辑器 vite，端口 5734～5736），核队列节点报到、结束进程树
 *     [--keep-temp]          留下临时目录（日志在里面）
 *   各角色：
 *     [--layers 4] [--segments 5]   假任务：layers 层、每层 segments 段（每段 60 帧）；前一半层要求指纹 X、后一半要求 Y
 *     [--task-ms 300]               假节点做一段睡多久
 *     [--stall-s 3]                 node-b（经代理）第一次持有任务后，让代理 stall 这么多秒再 resume（0 不做）
 *     [--stall-prob 0.1]            node-b 的代理每块受扰的概率（扣住 200～600 ms 再按序发；不是丢包）
 *     [--timeout-min 6]
 *   node 角色另要：--name node-a | node-b，--fingerprint <16 位十六进制>，[--via-proxy <监听端口>]
 *
 * 角色（KV 前缀 `m8kit`，键名约定见 `kv.mjs`）：
 *   creator  建项目（托管端，自由进入）、写 config；起旁观节点；等 ready.node-a / ready.node-b；发布假任务；
 *            等全部完成；写 done；等两个节点的 result；判：J-全完、J-恰一（按 epoch）、J-纯层（任务要求的指纹与完成它的节点的指纹逐层同一）、
 *            各节点都干了活且完成数之和等于任务数、旁观节点看到每个任务最后是 done、协调口没有 401；收尾删项目。
 *   node-a   假节点，指纹 X，直连文档服务。
 *   node-b   假节点，指纹 Y，经 `render-queue-proxy.mjs`（受扰 + 一次 stall / resume）连文档服务。
 *
 * 端口：本分支分到 5730～5739。托管组合与协调口用端口 0；代理 5733；--queue-editor 5734～5736；--real-host 5737～5739。
 * 令牌：集群令牌与协调口令牌现场生成，只进子进程环境，不打印。
 * 输出：过程写 stderr；stdout 最后一行是结果行（`lib.mjs` 的形状），ok 为假退出码 1，参数不对 2。
 */
import '../../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  argsOf, createResult, mergeRoleResults, sayer, newRunId, fingerprintOf, fakeLayerTasks, judgeAllDone, judgeExactlyOnce,
  judgePureLayers, layerObservations, judgeEachWorked, summarizeTimeline, placeParams,
} from './lib.mjs';
import { roleKv, resolveRun } from './kv.mjs';
import { startHostedCombo, startCoord, startProxy, startRenderHost, startQueueEditor, runRole, until } from './procs.mjs';
import { sharedEntry, createProbeProject, deleteProbeProject, startWatcher, startFakeNode, startFakePublisher } from './conn.mjs';

const SELF = fileURLToPath(import.meta.url);
const PREFIX = 'm8kit';
const PROBE = 'm8-kit-selftest';
/** 队列里任务的项目 id（共享项目空间里 `source.projectId`） */
const QUEUE_PROJECT = 'm8-kit-selftest';
const BAND = [5730, 5739];
const PORTS = { proxy: 5733, editor: 5734, host: 5737 };

const { arg, flag } = argsOf();
const ROLE = arg('--role', 'all');
const say = sayer(PROBE, ROLE === 'node' ? arg('--name', 'node') : ROLE);
const TIMEOUT_MS = Number(arg('--timeout-min', 6)) * 60_000;
const deadline = Date.now() + TIMEOUT_MS;
const LAYERS = Number(arg('--layers', 4));
const SEGMENTS = Number(arg('--segments', 5));
const TASK_MS = Number(arg('--task-ms', 300));
const STALL_S = Number(arg('--stall-s', 3));
const STALL_PROB = Number(arg('--stall-prob', 0.1));
const FP = { X: fingerprintOf('m8-kit-X'), Y: fingerprintOf('m8-kit-Y') };

/* ================================================================== creator */

async function runCreator(r) {
  const coord = arg('--coord');
  if (!coord || !arg('--hosted')) { r.fail('要给 --coord 与 --hosted'); process.exitCode = 2; return; }
  const P = placeParams('local', { hosted: arg('--hosted'), coord });
  const run = await resolveRun({ coord, prefix: PREFIX, run: arg('--run'), isCreator: true, newRun: newRunId, deadline, log: say });
  r.set({ run });
  const kv = roleKv({ coord, prefix: PREFIX, run, role: 'creator', log: say });
  let project = null;
  let watcher = null;
  let publisher = null;
  try {
    project = await createProbeProject({ where: 'hosted', ws: P.ws, name: `m8kit-${run}` });
    r.set({ projectId: project.projectId });
    await kv.config({ run, ws: P.ws, docPlain: P.docPlain, projectId: project.projectId, member: { username: 'member', password: project.projectPassword },
      queueProject: QUEUE_PROJECT, fingerprints: FP, taskMs: TASK_MS, stallS: STALL_S, stallProb: STALL_PROB, at: Date.now() });
    say('config', { projectId: project.projectId });

    const member = (tag) => sharedEntry({ url: P.ws, projectId: project.projectId, username: 'member', password: project.projectPassword, run, tag });
    watcher = await startWatcher({ entry: member('watcher'), projects: [QUEUE_PROJECT], nodeId: `m8kit-watcher-${run}`, log: say });
    r.check('watcher-watching', watcher.first.watch === 'queue.snapshot', watcher.first);

    const readyA = await kv.takeReady('node-a', deadline);
    const readyB = await kv.takeReady('node-b', deadline);
    if (!r.check('nodes-ready', !!readyA && !!readyB, { a: !!readyA, b: !!readyB })) { await kv.abort('nodes not ready'); return; }
    r.set({ nodes: { 'node-a': { fingerprint: readyA.fingerprint, viaProxy: readyA.viaProxy }, 'node-b': { fingerprint: readyB.fingerprint, viaProxy: readyB.viaProxy } } });

    // 可选：真的独立渲染主机 / 桌面编辑器队列节点（起停与指纹过滤的冒烟）
    const extras = await startExtras(r, { P, project, run });

    const half = Math.ceil(LAYERS / 2);
    const tasks = fakeLayerTasks({ run, projectId: QUEUE_PROJECT, layers: Array.from({ length: LAYERS }, (_, i) => ({ fingerprint: i < half ? FP.X : FP.Y, segments: SEGMENTS })) });
    const ids = tasks.map((t) => t.id);
    publisher = await startFakePublisher({ entry: sharedEntry({ url: P.ws, projectId: project.projectId, username: 'creator', password: project.creatorPassword, as: 'creator', role: 'page', run, tag: 'publisher' }),
      publisherId: `m8kit-pub-${run}`, tasks, log: say });
    say('published', { tasks: ids.length });
    const allDone = await publisher.whenAllDone(Math.max(1000, deadline - Date.now() - 60_000));
    r.set({ tasks: ids.length, publishToDoneMs: allDone && publisher.publishedAt ? Math.max(...publisher.doneEvents.map((e) => e.at)) - publisher.publishedAt : null });
    await delay(1000); // 让旁观节点收齐最后几条 task.closed
    await kv.done({ tasks: ids.length });

    const resA = await kv.takeResult('node-a', deadline);
    const resB = await kv.takeResult('node-b', deadline);
    r.check('node-results', !!resA && !!resB, { a: !!resA, b: !!resB });
    const completedBy = {};
    for (const [name, res] of [['node-a', resA], ['node-b', resB]]) for (const id of [...(res?.completed ?? []), ...(res?.dedup ?? [])]) completedBy[id] ??= name;
    const fps = { 'node-a': readyA.fingerprint, 'node-b': readyB.fingerprint };

    r.judge('J-all-done', judgeAllDone(ids, publisher.states));
    r.judge('J-exactly-once', judgeExactlyOnce(ids, publisher.doneEvents));
    r.judge('J-pure-layers', judgePureLayers(layerObservations(tasks, completedBy, fps)));
    const work = { 'node-a': (resA?.completed?.length ?? 0) + (resA?.dedup?.length ?? 0), 'node-b': (resB?.completed?.length ?? 0) + (resB?.dedup?.length ?? 0) };
    r.judge('each-node-worked', judgeEachWorked(work, { total: ids.length }));
    const watched = ids.map((id) => ({ id, ...summarizeTimeline(watcher.events(id)) }));
    const notClosedDone = watched.filter((w) => w.closed.at(-1) !== 'done').map((w) => w.id);
    r.check('watcher-saw-done', notClosedDone.length === 0, { tasks: ids.length, notClosedDone: notClosedDone.slice(0, 5) });
    r.set({ epochs: publisher.doneEvents.map((e) => e.epoch).filter((v, i, a) => a.indexOf(v) === i), publisherErrors: publisher.errors.slice(0, 5),
      watcher: { tasks: watcher.ids().length, maxTaken: Math.max(0, ...watched.map((w) => w.taken)), reopened: watched.reduce((s, w) => s + w.reopenedAfterTaken, 0) } });
    r.count('doneEvents', publisher.doneEvents.length);
    await finishExtras(r, extras);
    r.check('kv-no-401', kv.client.stats.unauthorized === 0, kv.client.stats);
  } catch (error) {
    r.fail(`creator 出错：${String(error?.message ?? error).slice(0, 600)}`);
    say('error', { stack: String(error?.stack ?? error).slice(0, 1500) });
    await kv.abort(error?.message ?? error);
  } finally {
    if (r.fails.length) await kv.abort(`creator: ${r.fails[0].slice(0, 160)}`);
    await publisher?.close();
    await watcher?.close();
    if (project) {
      const del = await deleteProbeProject({ ws: P.ws, projectId: project.projectId, creatorPassword: project.creatorPassword, run });
      r.check('project-deleted', del.deleted, del.error);
    }
    await kv.result(r.toJSON());
  }
}

/** --real-host / --queue-editor：起来、核对、（发布后）收尾 */
async function startExtras(r, { P, project, run }) {
  const extras = {};
  const dir = arg('--out');
  if (flag('--real-host')) {
    const hdir = path.join(dir, 'real-host');
    fs.mkdirSync(hdir, { recursive: true });
    const config = path.join(hdir, 'host.json');
    sharedEntry({ url: P.ws, projectId: project.projectId, username: 'member', password: project.projectPassword, run, tag: 'real-host', file: config });
    try {
      const t0 = Date.now();
      extras.host = await startRenderHost({ port: PORTS.host, dir: hdir, config, maxConcurrent: 1, band: BAND });
      const q = await extras.host.queue();
      r.check('real-host-ready', !!q?.envFingerprint, { readyMs: Date.now() - t0, envFingerprint: q?.envFingerprint ?? null, nodes: q?.nodes?.length ?? null });
      r.check('real-host-fingerprint-differs', q?.envFingerprint !== FP.X && q?.envFingerprint !== FP.Y, { envFingerprint: q?.envFingerprint ?? null });
    } catch (error) {
      r.check('real-host-ready', false, String(error?.message ?? error).slice(0, 400));
    }
  }
  if (flag('--queue-editor')) {
    const edir = path.join(dir, 'queue-editor');
    fs.mkdirSync(edir, { recursive: true });
    const config = path.join(edir, 'editor.json');
    sharedEntry({ url: P.ws, projectId: project.projectId, username: 'creator', password: project.creatorPassword, as: 'creator', role: 'render', run, tag: 'queue-editor', file: config });
    try {
      const t0 = Date.now();
      extras.editor = await startQueueEditor({ port: PORTS.editor, dir: edir, sharedConfig: config, band: BAND });
      const q = await extras.editor.waitActive();
      r.check('queue-editor-active', q.active === true && q.connected !== false, { activeMs: Date.now() - t0, envFingerprint: q.envFingerprint ?? null, transport: q.transport ?? null });
    } catch (error) {
      r.check('queue-editor-active', false, String(error?.message ?? error).slice(0, 400));
    }
  }
  return extras;
}

async function finishExtras(r, extras) {
  if (extras.host) {
    const n = await extras.host.node().catch(() => null);
    r.check('real-host-claimed-none', (n?.claimed ?? 0) === 0, { claimed: n?.claimed ?? null, connected: n?.connected ?? null });
    const exitLine = await extras.host.stop();
    r.check('real-host-exit', extras.host.child.exitCode === 0, { exitCode: extras.host.child.exitCode, released: exitLine?.released ?? null });
  }
  if (extras.editor) {
    await extras.editor.stop();
    r.check('queue-editor-stopped', extras.editor.child.exitCode !== null || extras.editor.child.signalCode !== null, { exitCode: extras.editor.child.exitCode });
  }
}

/* ================================================================== node */

async function runNode(r) {
  const coord = arg('--coord');
  const name = arg('--name');
  const fingerprint = arg('--fingerprint');
  if (!coord || !name || !fingerprint) { r.fail('node 要给 --coord、--name、--fingerprint'); process.exitCode = 2; return; }
  const run = await resolveRun({ coord, prefix: PREFIX, run: arg('--run'), isCreator: false, newRun: newRunId, deadline, log: say });
  r.set({ run, name, fingerprint });
  const kv = roleKv({ coord, prefix: PREFIX, run, role: name, log: say });
  let node = null;
  let proxy = null;
  try {
    const cfg = await kv.takeConfig(deadline);
    if (!r.check('config', !!cfg)) return;
    let url = cfg.ws;
    const viaProxy = arg('--via-proxy');
    if (viaProxy) {
      proxy = await startProxy({ listen: `127.0.0.1:${viaProxy}`, target: cfg.docPlain, stallProb: cfg.stallProb, stallMs: '200..600', dir: arg('--out') });
      url = proxy.url;
      r.set({ proxy: { port: proxy.port, target: cfg.docPlain, stallProb: cfg.stallProb, meaning: proxy.listen.meaning } });
    }
    const entry = sharedEntry({ url, projectId: cfg.projectId, username: cfg.member.username, password: cfg.member.password, run, tag: name });
    node = await startFakeNode({ entry, nodeId: `m8kit-${name}-${run}`, fingerprint, taskMs: cfg.taskMs, maxConcurrent: 2, projects: [cfg.queueProject], log: say });
    const opened = await until(() => node.rec.opens > 0, 20_000, 100);
    if (!r.check('node-connected', !!opened, node.stats())) { await kv.abort(`${name} 连不上`); return; }
    await kv.ready({ fingerprint, viaProxy: !!proxy });
    say('ready', { viaProxy: !!proxy });

    // 经代理的节点：第一次持有任务后 stall 一下再 resume（按需半开的冒烟；时长短于租约，会话应当接续、任务照常完成）
    if (proxy && cfg.stallS > 0) {
      const holding = await until(async () => (node.held().length > 0 ? true : ((await kv.get('done', 0).catch(() => null)) ? 'done' : null)), Math.max(1000, deadline - Date.now()), 50);
      if (holding === true) {
        const held = node.held();
        const stalled = await proxy.stall();
        const t0 = Date.now();
        await delay(cfg.stallS * 1000);
        const resumed = await proxy.resume();
        r.check('proxy-stall-resume', !!stalled && !!resumed, { held, stall: stalled, resume: resumed, ms: Date.now() - t0 });
      } else {
        r.check('proxy-stall-resume', false, { reason: 'never-held', holding });
      }
    }

    const done = await until(async () => (await kv.get('done', 0).catch(() => null)) ?? ((await kv.aborted()) ? { aborted: true } : null), Math.max(1000, deadline - Date.now()), 300);
    r.check('creator-done', !!done && !done.aborted, done);
    r.set({ completed: [...node.completed], dedup: [...node.dedup], lost: node.lost.slice(0, 10), failedTasks: node.failed.slice(0, 5), stats: node.stats() });
    r.check('node-no-failed', node.failed.length === 0, node.failed.slice(0, 3));
  } catch (error) {
    r.fail(`${name} 出错：${String(error?.message ?? error).slice(0, 600)}`);
    await kv.abort(`${name}: ${error?.message ?? error}`);
  } finally {
    await node?.stop();
    if (proxy) {
      const summary = await proxy.stop();
      r.set({ proxySummary: summary ? { conns: summary.conns, chunks: summary.chunks, held: summary.held, stalledConns: summary.stalledConns, stallCommands: summary.stallCommands, resumeCommands: summary.resumeCommands, randomCloses: summary.randomCloses } : null });
    }
    await kv.result(r.toJSON());
  }
}

/* ================================================================== all */

async function runAll() {
  const out = path.resolve(arg('--out', path.join(os.tmpdir(), `pc-m8kit-${Date.now().toString(36)}`)));
  fs.mkdirSync(out, { recursive: true });
  const head = { probe: PROBE, place: 'local', startedAt: Date.now() };
  let hosted = null;
  let coord = null;
  try {
    // 协调口开信箱（KV 也要令牌）：证 401 路径不会误报；令牌只进环境
    process.env.PROBE_MAIL_TOKEN = randomBytes(24).toString('base64url');
    hosted = await startHostedCombo({ dir: out });
    coord = await startCoord({ mailToken: process.env.PROBE_MAIL_TOKEN });
    say('infra', { hosted: hosted.hosted, coord: coord.url });
    const run = newRunId();
    const common = ['--coord', coord.url, '--run', run, '--out', out, '--timeout-min', String(TIMEOUT_MS / 60_000),
      '--layers', String(LAYERS), '--segments', String(SEGMENTS), '--task-ms', String(TASK_MS), '--stall-s', String(STALL_S), '--stall-prob', String(STALL_PROB)];
    const results = await Promise.all([
      runRole(SELF, 'creator', [...common, '--hosted', hosted.hosted, ...(flag('--real-host') ? ['--real-host'] : []), ...(flag('--queue-editor') ? ['--queue-editor'] : [])]),
      runRole(SELF, 'node', [...common, '--name', 'node-a', '--fingerprint', FP.X]),
      runRole(SELF, 'node', [...common, '--name', 'node-b', '--fingerprint', FP.Y, '--via-proxy', String(PORTS.proxy)]),
    ]);
    const merged = mergeRoleResults({ ...head, run }, results.map((x, i) => ({ ...x, role: ['creator', 'node-a', 'node-b'][i] })));
    merged.set({ out, hostedHealthz: await hosted.healthz().then((h) => ({ connections: h?.connections ?? null, sessions: h?.sessions ?? null })).catch(() => null) });
    return merged;
  } catch (error) {
    const r = createResult({ ...head, role: 'all' });
    r.fail(`all 出错：${String(error?.message ?? error).slice(0, 600)}`);
    return r;
  } finally {
    await coord?.stop();
    await hosted?.stop();
    if (!flag('--keep-temp')) { try { fs.rmSync(out, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* Windows 句柄没放 */ } }
  }
}

/* ================================================================== 入口 */

let result;
if (ROLE === 'all') result = await runAll();
else if (ROLE === 'creator' || ROLE === 'node') {
  result = createResult({ probe: PROBE, role: ROLE === 'node' ? arg('--name', 'node') : ROLE, place: 'local' });
  try { await (ROLE === 'creator' ? runCreator(result) : runNode(result)); } catch (error) { result.fail(`出错：${String(error?.message ?? error).slice(0, 600)}`); }
} else {
  result = createResult({ probe: PROBE, role: String(ROLE) });
  result.fail('--role 取 all | creator | node');
  process.exitCode = 2;
}
process.stdout.write(`${JSON.stringify(result.toJSON())}\n`);
if (process.exitCode !== 2) process.exitCode = result.ok ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 10_000).unref();
