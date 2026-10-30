/**
 * 队列模式的端到端探针(契约 `docs/plan/render-queue-contract.md` J.7 末段,设计附件第 0 节第 1 条)。
 *
 * 同一个探针项目、同一台机器,前后各起一套编辑器进程 + 预渲染进程,各用一个空帧库:
 *
 *   1. **普通模式**:preload,等后台那一趟跑完(`status === 'ready'`);
 *   2. **队列模式**(`PROMPTCUT_QUEUE_NODE=1`):等本机节点报到(诊断里 `queue.active`),preload,
 *      等后台那一趟跑完、`plan` 被切分、所有细任务都 `task.done`(或 `task.failed`)。
 *
 * 然后逐个比较两边帧库里的快照文件(`controls-html/**`、`controls-local/**` 的 `<帧>.html`)与 `index.json`。
 * 普通模式下同一帧可能先后被写三遍(锚帧那一趟、`fillCardControls` / `renderLocalSnapshots`、B 趟),
 * 后写的赢;队列模式下非锚帧只由执行器写一遍。两边有差异时 **`ok` 仍为真**、`identical: false`,
 * 差异逐帧列出来,由主 Agent 判断是不是 preload 本身三写造成的(契约 J.7)。每一帧另标 `styleOrderOnly`:
 * 只差 `style` 属性里声明的先后(实测两趟普通模式之间也是这样,是进程之间的差异),`identicalIgnoringStyleOrder`
 * 是「按声明排序之后是否全同」。
 *
 * **文档服务**:每一趟各起一个独立的文档服务(`server/docservice/main.mjs`,数据目录是新建的临时目录),
 * 经 `PROMPTCUT_DOCSERVICE_URL` 交给编辑器。不用编辑器里挂的那一份:它的内容库落在工作副本的
 * `out/docservice`,两趟共用 —— 后一趟的 preload 会按清单把前一趟推上去的段整段拉回来(C6.4 的换机取用),
 * 队列的细任务也会按清单去重完成,两边就「一定相同」,比较没有意义。`--docservice-url <ws://…>` 可以改用
 * 外面现成的一个(两趟共用,自己负责它是空的)。
 *
 * 轨道流缺省关掉(`PROMPTCUT_STREAMS=0`):这时不发布流任务(M6c X1 的开关,行为与 M5b 相同),探针断言流任务条数为 0。
 * `--streams` 开流(`PROMPTCUT_STREAMS=1`,M6c X1):流任务经队列完成,断言
 *   - 切出了流任务,全部 `done`,由节点的执行器产出(不是去重);
 *   - 每个节点对每个流任务恰好收到一次 `task.done`(诊断 `queue.doneCounts`)。
 *
 * **`--peer`(M6c X1)**:队列模式那一趟另起第二台编辑器(`--peer-port`,缺省队列端口 +3;三个连号都要空着),
 * 自己的空帧库、同一个文档服务、也是队列模式;两台同时 preload 同一个项目,两个节点抢同一批细任务。
 * 开着 `--streams` 时,等两边的流库都齐,逐段比 sha256(分段文件与它用的 init):另一节点经 `task.done` 的
 * `applyResult` → `adoptSegments` 取用的段必须与产出方逐字节相同(输出 `streamCompare`)。
 *
 *   node scripts/probes/queue-mode-probe.mjs [--queue-port 5516] [--normal-port 5513] [--docservice-port 5519]
 *        [--docservice-url ws://…] [--streams] [--peer] [--peer-port N] [--only queue|normal] [--timeout-min 20] [--keep]
 *        [--lan] [--hold-min N]
 *
 * **局域网模式(`--lan`,W4 跨机用)**:
 *   - 队列模式那一趟的编辑器改绑 `0.0.0.0`;探针自己的检查仍然走 `127.0.0.1`。预渲染进程照旧只绑回环(它由编辑器拉起)。
 *   - 编辑器的素材服务按 C5 自动登记局域网地址(`server/vite-plugin-media.ts`:要求 `PROMPTCUT_DOCSERVICE_URL`
 *     已设、绑的不是回环地址)。探针从编辑器输出里的 `[asset-announce] asset-announce.announced` 取登记的地址,
 *     放进输出的 `announcedAsset`(没登记上是 `null`,例如本机没有私有网段的 IPv4)。
 *   - **凭证**(M6a,`docs/plan/auth-contract.md` 第 11 节):集群令牌已退出数据面,只剩素材地址登记这一个管理用途。
 *     探针自己起文档服务(没给 `--docservice-url`)时从编辑器的环境里删掉 `PROMPTCUT_CLUSTER_TOKEN`
 *     —— 自起的那一份绑回环,编辑器与预渲染进程连它是本机身份。给了 `--docservice-url` 连远端控制面时,
 *     预渲染进程要凭共享项目进入:在跑探针的环境里设好 `PROMPTCUT_SHARED_CONFIG`(原样传给编辑器与预渲染进程);
 *     令牌原样保留,只给素材登记用。`--lan` 不改这一条。
 *   - 不给 `--docservice-url` 时自起的文档服务仍只绑回环,别的机器连不上;跨机要配合 `--docservice-url`。
 *     给了 `--docservice-url` 时,不再要求「细任务都由本机节点完成」(别的机器也在取活)。
 *
 * **`--hold-min N`**:队列模式那一趟跑完、比较也做完之后,不马上关进程,再保持 N 分钟,让别的机器上的节点
 * 继续取活、拉取。期间每 30 秒打一行 `[hold] {…}`(`tasks`、`done`、就绪层数 `readyLayers`)。
 * 输出的 `nodes` 取自保持结束时的诊断。
 *
 * 输出另带:
 *   - `nodes`:本机诊断里的节点信息(诊断 `queue.local`):`nodeId`,本机节点认领 / 完成 / 去重完成 / 失败的任务 id 列表,和 `stats`;
 *   - `announcedAsset`:本机登记的素材服务地址(列表);
 *   - `x5`(M6c X5 的证据,队列模式那一趟另打一行 `[x5] {…}`):preload 到 ready 用了多久、第一次认领 plan /
 *     细任务在 preload 开跑后多久、那一刻 preload 各代际的状态、等 ready 期间读到的认领数,
 *     `fineClaimedBeforeReady` 为真就是「preload 未 ready 时本机节点已开始认领细任务」。只记录,不判失败。
 *
 * 端口:每台编辑器另占「端口 +1」「端口 +2」当舞台端口,三个连号都要空着;文档服务一个端口。
 * `--keep` 不删两边的临时帧库(调试用)。输出最后一行是一行 JSON:
 * `{ ok, tasks, done, identical, differentFrames: [...], fails }`,另带一些诊断字段;`ok` 为假时退出码 1。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { anchorFrames } from '../../src/render/snapshotPick.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const QUEUE_PORT = Number(arg('--queue-port', 5516));
const NORMAL_PORT = Number(arg('--normal-port', 5513));
const DOC_PORT = Number(arg('--docservice-port', 5519));
const DOC_URL = arg('--docservice-url', null);
const STREAMS = args.includes('--streams');
/** M6c X1:`--peer` 队列模式另起第二个队列节点(第二台编辑器,自己的空帧库,同一个文档服务) */
const PEER = args.includes('--peer');
const PEER_PORT = Number(arg('--peer-port', QUEUE_PORT + 3));
const KEEP = args.includes('--keep');
const ONLY = arg('--only', null);
const TIMEOUT_MS = Number(arg('--timeout-min', 20)) * 60_000;
/** `--salt <s>`:写进每张卡的 params(卡片内容键含 params),让结果键全新、不会被别处已有的清单去重掉(W4 用) */
const SALT = arg('--salt', null);
const LAN = args.includes('--lan');
const HOLD_MS = Math.max(0, Number(arg('--hold-min', 0)) || 0) * 60_000;
const EDITOR_HOST = LAN ? '0.0.0.0' : '127.0.0.1';

const fails = [];
const out = { root: ROOT, queuePort: QUEUE_PORT, normalPort: NORMAL_PORT, docservice: DOC_URL ?? `standalone:${DOC_PORT}`, streams: STREAMS, peer: PEER ? PEER_PORT : null,
  lan: LAN, editorHost: EDITOR_HOST, holdMin: HOLD_MS / 60_000 };
const check = (cond, label, extra) => { if (!cond) fails.push(label + (extra === undefined ? '' : ' :: ' + JSON.stringify(extra).slice(0, 600))); return cond; };

const FPS = 30;
const STAMP = Date.now().toString(36);
/**
 * 3 秒 = 90 帧:共享档的两张卡各切两段(0～59、60～89);`unknown` 卡(本地档)从 1 秒起,
 * 它的挂载帧(`mountFrameOf`,实测 29)在另两张卡中间切出一个锚帧。项目 id 固定,两趟算出同一组键(帧库是空的)。
 */
const PROJECT = {
  id: 'queue-mode-probe', name: '队列模式探针', width: 1920, height: 1080, fps: FPS, duration: 3,
  themeId: 'dark', camera3dFov: 50, media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-1', name: 'tr-1', hidden: false, clips: [{ id: 'clip-stateful', kind: 'card', cardId: 'r6-stateful', start: 0, end: 3, params: {} }] },
    { id: 'tr-2', name: 'tr-2', hidden: false, clips: [{ id: 'clip-canvas', kind: 'card', cardId: 'r6-canvas', start: 0, end: 3, params: SALT ? { probeSalt: SALT } : {} }] },
    { id: 'tr-3', name: 'tr-3', hidden: false, clips: [{ id: 'clip-unknown', kind: 'card', cardId: 'r6-unknown', start: 1, end: 3, params: SALT ? { probeSalt: SALT } : {} }] },
  ],
};
const ANCHORS = anchorFrames(PROJECT.tracks.flatMap(t => t.clips), FPS).filter(n => n >= 0 && n < PROJECT.duration * FPS);
out.anchors = ANCHORS;

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

/** 工作副本没有自己的 node_modules(往上走到主仓库那一份),所以按模块解析 vite 的 bin */
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

/** 队列诊断里本机节点那一份(`queue.local`) */
const nodesOf = q => q ? {
  nodeId: q.local?.nodeId ?? q.nodeId ?? null,
  claimed: q.local?.claimed ?? null, completed: q.local?.completed ?? null, dedup: q.local?.dedup ?? null, failed: q.local?.failed ?? null,
  stats: q.stats ?? null,
} : null;

/**
 * 起一台编辑器(它会拉起自己的预渲染进程),等预渲染进程就绪。`sink` 收编辑器的输出(按行扫素材登记)。
 * 回 `{ label, port, exportDir, library, EDITOR, base, diagnostics }`;预渲染进程没起来时 `base` 为 null。
 */
async function startEditor(run, children, { label, port, exportDir, docUrl, queue, host, sink }) {
  await fs.mkdir(path.join(exportDir, 'data'), { recursive: true });
  const env = { ...process.env, PROMPTCUT_EXPORT_DIR: exportDir, PROMPTCUT_DATA_DIR: path.join(exportDir, 'data'), PROMPTCUT_DOCSERVICE_URL: docUrl };
  delete env.PROMPTCUT_QUEUE_NODE;
  if (!DOC_URL) delete env.PROMPTCUT_CLUSTER_TOKEN;
  if (queue) env.PROMPTCUT_QUEUE_NODE = '1';
  // M6c X1:`--streams` 显式开流(PROMPTCUT_STREAMS=1);不给时关掉,与 M5b 相同
  env.PROMPTCUT_STREAMS = STREAMS ? '1' : '0';
  const editor = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', host],
    { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  children.push(editor);
  editor.stdout.on('data', sink);
  editor.stderr.on('data', sink);
  const EDITOR = `http://127.0.0.1:${port}`;
  const inst = { label, port, exportDir, library: path.join(exportDir, 'frame-library'), EDITOR, base: null, diagnostics: async () => ({}) };
  await until(`[${label}] 编辑器进程起来`, async () => (await fetch(EDITOR + '/api/prerender/info').then(r => r.ok, () => false)) || null, 120000);
  const base = await until(`[${label}] 预渲染进程就绪`, async () => {
    const info = await json(EDITOR + '/api/prerender/info');
    return info.body?.ready && info.body.url ? info.body.url : null;
  }, 180000);
  if (!base) return inst;
  inst.base = base;
  inst.diagnostics = async () => (await json(`${base}/api/frames/diagnostics`)).body ?? {};
  return inst;
}

/** 队列模式:等本机节点报到(诊断里 `queue.active`)。回 true / false */
async function waitActive(run, inst) {
  const active = await until(`[${inst.label}] 本机节点报到(诊断里 queue.active)`, async () => (await inst.diagnostics()).queue?.active === true || null, 180000, 1000);
  const d = await inst.diagnostics();
  const start = d.queue ? { mode: d.queue.mode, url: d.queue.url, nodeId: d.queue.nodeId, envFingerprint: d.queue.envFingerprint } : null;
  if (inst.label === 'queue') run.queueStart = start;
  else (run.peer ??= {}).queueStart = start;
  return !!active;
}

/** 推项目、preload、等后台那一趟跑完。回 `{ session, key, ready }` */
async function preloadOn(run, inst, mode) {
  const SESSION = `qmp-${inst.label}-${STAMP}`;
  const pushed = await postJson(inst.EDITOR + '/api/data/project', { session: SESSION, localRev: 1, project: PROJECT });
  check(pushed.ok, `[${inst.label}] 项目推进镜像`, pushed.body);
  await until(`[${inst.label}] 预渲染进程手里有这一版项目`, async () => (await json(`${inst.base}/api/data/project?session=${SESSION}&localRev=1`)).ok || null, 30000);
  const preload = await postJson(`${inst.base}/api/frames/preload`, { session: SESSION, localRev: 1 });
  check(preload.ok, `[${inst.label}] preload 开跑`, preload.body);
  const key = preload.body?.key;
  // M6c X5 的证据:preload 还没到 ready 时,本机节点已经认领了几次(每次轮询时读诊断里的认领数)
  let claimedWhileNotReady = 0;
  const ready = await until(`[${inst.label}] 后台那一趟跑完`, async () => {
    // 页面每 2 秒重发一次 preload 保活,这里照做(同一版直接返回)
    const status = await postJson(`${inst.base}/api/frames/preload`, { session: SESSION, localRev: 1 });
    if (mode === 'queue' && status.body?.status !== 'ready') {
      const claimed = (await inst.diagnostics()).queue?.stats?.claimed;
      if (Number.isFinite(claimed)) claimedWhileNotReady = Math.max(claimedWhileNotReady, claimed);
    }
    return status.body?.status === 'ready' ? status.body : status.body?.status === 'error' ? status.body : null;
  }, TIMEOUT_MS, 2000);
  check(ready?.status === 'ready', `[${inst.label}] 后台那一趟以 ready 结束`, ready);
  return { session: SESSION, key, ready, claimedWhileNotReady };
}

/** 队列模式:plan 切分完、所有细任务落定(按这一个节点的诊断看)。回 `{ plan, derived, states, q }` 或 null */
async function settledOn(inst) {
  return until(`[${inst.label}] plan 切分完、所有细任务落定`, async () => {
    const q = (await inst.diagnostics()).queue;
    const plan = q?.published?.[0]?.planId;
    const derived = plan ? q.plans?.[plan] : null;
    if (!Array.isArray(derived)) return null;
    const states = derived.map(id => q.tasks?.[id]?.state ?? 'pending');
    return states.every(s => s === 'done' || s === 'failed') ? { plan, derived, states, q } : null;
  }, TIMEOUT_MS, 2000);
}

/**
 * 一趟:起文档服务(独立模式)和编辑器,preload 探针项目,等它产完,收帧库。
 * `hold` 为真时不关进程,返回的 run 带 `release()`(关进程)和 `diagnostics()`,由调用方保持完再关。
 * 队列模式加 `--peer` 时另起一台编辑器(第二个队列节点,自己的空帧库,连同一个文档服务),两边同时 preload 同一个项目:
 * 两个节点抢同一批细任务,各自订阅了 plan,细任务的 `task.done` 两边都收到,另一边产的段经 `applyResult` 拉进来。
 */
async function runOnce(mode, { hold = false } = {}) {
  const port = mode === 'queue' ? QUEUE_PORT : NORMAL_PORT;
  const exportDir = path.join(os.tmpdir(), `pc-queue-probe-${mode}-${STAMP}`);
  const withPeer = mode === 'queue' && PEER;
  const run = { mode, port, exportDir, log: [] };
  const children = [];
  let kept = false;
  try {
    const ports = [port, port + 1, port + 2, ...(withPeer ? [PEER_PORT, PEER_PORT + 1, PEER_PORT + 2] : []), ...(DOC_URL ? [] : [DOC_PORT])];
    for (const p of ports) check(await portFree(p), `[${mode}] 端口 ${p} 空着`);
    if (fails.length) return run;
    await fs.mkdir(path.join(exportDir, 'data'), { recursive: true });
    let docUrl = DOC_URL;
    if (!docUrl) {
      const docData = path.join(exportDir, 'docservice');
      // 只绑回环:编辑器、预渲染进程连它是本机身份,不带任何凭证(main.mjs 文件头)
      const docEnv = { ...process.env, PROMPTCUT_DOCSERVICE_PORT: String(DOC_PORT), PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_DATA: docData };
      delete docEnv.PROMPTCUT_CLUSTER_TOKEN;
      const doc = spawn(process.execPath, [path.join(ROOT, 'server', 'docservice', 'main.mjs')], {
        cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: docEnv,
      });
      doc.stdout.resume(); doc.stderr.resume();
      children.push(doc);
      docUrl = `ws://127.0.0.1:${DOC_PORT}`;
      await until(`[${mode}] 文档服务起来`, async () => (await json(`http://127.0.0.1:${DOC_PORT}/healthz`)).body?.ok === true || null, 30000);
    }
    // 素材服务登记(C5):编辑器输出里 `[asset-announce] asset-announce.announced {json}` 那一行
    run.announcedAsset = null;
    let lineTail = '';
    const scanAnnounce = text => {
      const lines = (lineTail + text).split('\n');
      lineTail = lines.pop() ?? '';
      for (const line of lines) {
        const m = /\[asset-announce\] asset-announce\.(announced|skip|error) (\{.*\})\s*$/.exec(line);
        if (!m) continue;
        let fields = null;
        try { fields = JSON.parse(m[2]); } catch { /* 不是整行 JSON 就不认 */ }
        if (m[1] === 'announced' && Array.isArray(fields?.urls)) run.announcedAsset = fields.urls;
        else (run.announceIssues ??= []).push({ event: m[1], ...(fields ?? {}) });
      }
    };
    const keep = c => { const text = c.toString(); scanAnnounce(text); run.log.push(text); if (run.log.length > 400) run.log.shift(); };
    const main = await startEditor(run, children, { label: mode, port, exportDir, docUrl, queue: mode === 'queue', host: mode === 'queue' ? EDITOR_HOST : '127.0.0.1', sink: keep });
    if (!main.base) return run;
    run.prerender = main.base;
    const diagnostics = main.diagnostics;
    let peer = null;
    if (withPeer) {
      const peerLog = [];
      peer = await startEditor(run, children, { label: 'peer', port: PEER_PORT, exportDir: `${exportDir}-peer`, docUrl, queue: true, host: '127.0.0.1',
        sink: c => { peerLog.push(c.toString()); if (peerLog.length > 400) peerLog.shift(); } });
      run.peer = { port: PEER_PORT, exportDir: peer.exportDir, prerender: peer.base };
      run.peerLog = peerLog;
      if (!peer.base) return run;
    }

    if (mode === 'queue') {
      // 第一次打 /api/frames/* 才建管线、起本机节点;等它连上文档服务、报到
      const actives = await Promise.all([main, ...(peer ? [peer] : [])].map(inst => waitActive(run, inst)));
      if (!actives.every(Boolean)) {
        run.queueLog = run.log.join('').split('\n').filter(line => line.includes('[queue-node]')).slice(-10);
        return run;
      }
    } else {
      const d = await diagnostics();
      check(d.queue === undefined, '[normal] 开关关着时诊断里没有 queue 键', Object.keys(d));
    }

    const started = Date.now();
    // 两台同时 preload(发布方身份各自发布同一个 plan,两边都订阅上;谁先闲谁先认领)
    const loads = await Promise.all([main, ...(peer ? [peer] : [])].map(inst => preloadOn(run, inst, mode)));
    run.entryKey = loads[0]?.key;
    if (peer) run.peer.entryKey = loads[1]?.key;
    if (peer) check(loads[0]?.key && loads[0].key === loads[1]?.key, '[peer] 两台算出同一个 entry.key', { main: loads[0]?.key, peer: loads[1]?.key });
    const claimedWhileNotReady = loads[0]?.claimedWhileNotReady ?? 0;
    run.preloadMs = Date.now() - started;
    if (mode === 'queue') {
      // 诊断 queue.firstClaims(vite-plugin-frames.ts):第一次认领 plan / 细任务的时刻与那一刻 preload 各代际的状态
      const q = (await diagnostics()).queue ?? {};
      const brief = c => c ? { id: c.id, afterPreloadMs: c.at - started, preload: (c.preload ?? []).map(p => p.status) } : null;
      run.x5 = {
        readyAfterMs: run.preloadMs,
        firstPlanClaim: brief(q.firstClaims?.plan), firstFineClaim: brief(q.firstClaims?.fine),
        claimedWhileNotReady,
        fineClaimedBeforeReady: !!q.firstClaims?.fine && (q.firstClaims.fine.preload ?? []).some(p => !p.aborted && p.status !== 'ready'),
      };
      console.log(`[x5] ${JSON.stringify(run.x5)}`);
    }

    if (mode === 'queue') {
      const settled = await settledOn(main);
      if (settled) {
        const { q } = settled;
        run.plan = settled.plan;
        run.tasks = settled.derived.length;
        run.done = settled.states.filter(s => s === 'done').length;
        run.failedTasks = settled.derived.filter((id, i) => settled.states[i] === 'failed').map(id => ({ id, error: q.tasks[id]?.error ?? null }));
        run.queueStats = q.stats;
        run.queueEvents = q.events.filter(e => /failed|lost|discarded|mismatch|skip|offline|error/.test(e.event)).slice(-20);
        check(run.failedTasks.length === 0, '[queue] 没有细任务失败', run.failedTasks);
        let peerQ = null;
        if (peer) {
          const peerSettled = await settledOn(peer);
          peerQ = peerSettled?.q ?? null;
          check(peerSettled?.plan === settled.plan, '[peer] 两台发布的是同一个 plan', { main: settled.plan, peer: peerSettled?.plan });
          check(JSON.stringify([...(peerSettled?.derived ?? [])].sort()) === JSON.stringify([...settled.derived].sort()), '[peer] 两台看到的细任务相同',
            { main: settled.derived.length, peer: peerSettled?.derived?.length ?? null });
          run.peer.queueStats = peerQ?.stats ?? null;
          run.peer.queueEvents = (peerQ?.events ?? []).filter(e => /failed|lost|discarded|mismatch|skip|offline|error/.test(e.event)).slice(-20);
        }
        // 单机时本机节点应当包办(有 --peer 时两台合起来);连远端控制面(别的机器也在取活)时不一定
        const byNodes = q.stats.completed + q.stats.dedup + (peerQ ? peerQ.stats.completed + peerQ.stats.dedup : 0);
        if (!DOC_URL) check(byNodes >= run.done, '[queue] 细任务都由节点完成(completed + dedup)', { main: q.stats, peer: peerQ?.stats ?? null });
        // M6c X1:轨道流任务
        const streamIds = settled.derived.filter(id => id.startsWith('stream:'));
        run.streamTasks = streamIds.length;
        run.streamDone = streamIds.filter(id => q.tasks?.[id]?.state === 'done').length;
        const doneCounts = [['main', q], ...(peerQ ? [['peer', peerQ]] : [])].map(([who, qq]) => [who, Object.fromEntries(streamIds.map(id => [id, qq.doneCounts?.[id] ?? 0]))]);
        run.streamDoneCounts = Object.fromEntries(doneCounts);
        const local = qq => new Set([...(qq?.local?.completed ?? [])]);
        const dedup = qq => new Set([...(qq?.local?.dedup ?? [])]);
        run.streamBy = Object.fromEntries(streamIds.map(id => [id, local(q).has(id) ? 'main' : peerQ && local(peerQ).has(id) ? 'peer'
          : dedup(q).has(id) ? 'main-dedup' : peerQ && dedup(peerQ).has(id) ? 'peer-dedup' : 'other']));
        if (STREAMS) {
          check(run.streamTasks > 0, '[streams] 切出了流任务', run.streamTasks);
          check(run.streamDone === run.streamTasks, '[streams] 流任务全部经队列完成(done)', { tasks: run.streamTasks, done: run.streamDone });
          for (const [who, counts] of doneCounts) {
            const bad = Object.entries(counts).filter(([, n]) => n !== 1);
            check(bad.length === 0, `[streams] ${who} 每个流任务恰好收到一次 task.done`, bad);
          }
          const rendered = Object.values(run.streamBy).filter(v => v === 'main' || v === 'peer').length;
          check(rendered === run.streamTasks, '[streams] 流任务都由节点执行器产出(不是去重)', run.streamBy);
        } else {
          check(run.streamTasks === 0, '[streams] 关着(PROMPTCUT_STREAMS=0)时不发布流任务', run.streamTasks);
        }
      }
      run.queueMs = Date.now() - started;
      await delay(3000);   // task.done 的 applyResult 在后台串行跑,留一点时间
      if (peer && STREAMS && run.streamTasks > 0) {
        // 另一节点取用的段与产出方逐段一致:等两边的流库都齐,再逐段比 sha256
        const compare = await until('[streams] 两边的流库都齐', async () => {
          const c = await compareStreams(main.library, peer.library);
          return c.missing.length === 0 && c.segments > 0 ? c : null;
        }, 120000, 2000);
        run.streamCompare = compare ?? await compareStreams(main.library, peer.library);
        check(!!compare, '[streams] 两边都有全部分段', { missing: run.streamCompare.missing.slice(0, 10) });
        check(run.streamCompare.mismatched.length === 0, '[streams] 另一节点取用的段与产出方 sha256 逐段一致', run.streamCompare.mismatched.slice(0, 10));
      }
    }
    const d = await diagnostics();
    run.plans = (d.plans ?? []).map(p => ({ key: p.key, controls: p.controls.map(c => ({ clipId: c.clipId, tier: c.tier, snapshotKey: c.snapshotKey, picked: c.picked })) }));
    run.library = main.library;
    if (mode === 'queue') run.nodes = nodesOf(d.queue);
    if (peer) run.peer.nodes = nodesOf((await peer.diagnostics()).queue);
    if (hold) {
      kept = true;
      run.session = `qmp-${mode}-${STAMP}`;
      run.diagnostics = diagnostics;
      run.release = async () => {
        for (const child of children.reverse()) killTree(child);
        await Promise.all(children.map(exited));
      };
    }
    return run;
  } finally {
    if (!kept) {
      for (const child of children.reverse()) killTree(child);
      await Promise.all(children.map(exited));
    }
  }
}

/**
 * M6c X1:两个帧库的流库逐段对账。`streams/<流键>/stream.json` 里列的每个分段(两边的并集):两边都要有,
 * 分段文件与它用的 init 的 sha256 都相同。回 `{ streams, segments, missing: [...], mismatched: [...], perStream }`。
 */
async function compareStreams(libA, libB) {
  const sha = buf => createHash('sha256').update(buf).digest('hex');
  const manifestIn = async (lib, key) => { try { return JSON.parse(await fs.readFile(path.join(lib, 'streams', key, 'stream.json'), 'utf8')); } catch { return null; } };
  const blobOf = async (lib, key, manifest, n) => {
    const seg = manifest?.segments?.[n];
    if (!seg) return null;
    try {
      const segBytes = await fs.readFile(path.join(lib, 'streams', key, seg.file));
      const initBytes = await fs.readFile(path.join(lib, 'streams', key, `init-${seg.init}.mp4`));
      return { seg: sha(segBytes), init: sha(initBytes), stride: seg.stride, adopted: seg.adopted === true, encoder: seg.encoder ?? manifest.inits?.[seg.init]?.encoder ?? null };
    } catch { return null; }
  };
  const keys = new Set();
  for (const lib of [libA, libB]) for (const item of await fs.readdir(path.join(lib, 'streams'), { withFileTypes: true }).catch(() => [])) {
    if (item.isDirectory() && /^[a-f0-9]{64}$/.test(item.name)) keys.add(item.name);
  }
  const out = { streams: 0, segments: 0, missing: [], mismatched: [], perStream: {} };
  for (const key of [...keys].sort()) {
    const a = await manifestIn(libA, key), b = await manifestIn(libB, key);
    const numbers = [...new Set([...Object.keys(a?.segments ?? {}), ...Object.keys(b?.segments ?? {})])].map(Number).sort((x, y) => x - y);
    if (!numbers.length) continue;
    out.streams++;
    const per = { segments: numbers.length, adoptedByMain: 0, adoptedByPeer: 0 };
    for (const n of numbers) {
      out.segments++;
      const x = await blobOf(libA, key, a, n), y = await blobOf(libB, key, b, n);
      if (!x || !y) { out.missing.push({ stream: key.slice(0, 12), segment: n, main: !!x, peer: !!y }); continue; }
      if (x.adopted) per.adoptedByMain++;
      if (y.adopted) per.adoptedByPeer++;
      if (x.seg !== y.seg || x.init !== y.init) out.mismatched.push({ stream: key.slice(0, 12), segment: n, main: x, peer: y });
    }
    out.perStream[key.slice(0, 12)] = per;
  }
  return out;
}

/** 保持 `HOLD_MS`:每 30 秒打一行进度,每次刷新 `run.nodes` */
async function holdOpen(run) {
  const deadline = Date.now() + HOLD_MS;
  const progress = async () => {
    let d = {};
    try { d = await run.diagnostics(); } catch { /* 进程没了就打空的 */ }
    const q = d.queue;
    const derived = run.plan ? q?.plans?.[run.plan] : null;
    const states = Array.isArray(derived) ? derived.map(id => q.tasks?.[id]?.state ?? 'pending') : [];
    const layers = (Array.isArray(d.ready) ? d.ready : []).filter(r => r.session === run.session).reduce((n, r) => n + (r.layers ?? 0), 0);
    const line = { tasks: states.length, done: states.filter(s => s === 'done').length, readyLayers: layers,
      localCompleted: q?.local?.completed?.length ?? null, connected: q?.connected ?? null, leftSec: Math.max(0, Math.round((deadline - Date.now()) / 1000)) };
    console.log(`[hold] ${JSON.stringify(line)}`);
    if (q) run.nodes = nodesOf(q);
  };
  await progress();
  while (Date.now() < deadline) {
    await delay(Math.min(30_000, Math.max(0, deadline - Date.now())));
    await progress();
  }
}

/** 帧库里全部快照:`<相对路径>` → 字节。`controls-html/<键>/…`、`controls-local/<entry.key>/<键>/…` */
async function snapshotTree(library) {
  const files = new Map();
  const walk = async (dir) => {
    for (const item of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, item.name);
      if (item.isDirectory()) await walk(file);
      else if (/\.(html|json)$/.test(item.name)) files.set(path.relative(library, file).replaceAll('\\', '/'), await fs.readFile(file));
    }
  };
  await walk(path.join(library, 'controls-html'));
  await walk(path.join(library, 'controls-local'));
  return files;
}

/** 每个 `style="…"` 里的声明排序:只用来判「是不是只差声明顺序」,比较本身仍按原字节 */
const sortStyles = html => html.replace(/style="([^"]*)"/g, (_, s) => 'style="' + s.split(';').map(x => x.trim()).filter(Boolean).sort().join(';') + '"');

/** 键 → 片段与档位(从 card plan 反查),差异列表里好认 */
function keyIndex(run) {
  const map = new Map();
  for (const plan of run?.plans ?? []) for (const c of plan.controls) if (c.snapshotKey) map.set(c.snapshotKey, { clipId: c.clipId, tier: c.tier });
  return map;
}

const runs = {};
try {
  if (ONLY !== 'queue') runs.normal = await runOnce('normal');
  if (ONLY !== 'normal' && !fails.some(f => f.includes('端口'))) runs.queue = await runOnce('queue', { hold: HOLD_MS > 0 });
  out.tasks = runs.queue?.tasks ?? 0;
  out.done = runs.queue?.done ?? 0;
  out.streamTasks = runs.queue?.streamTasks ?? null;
  out.streamDone = runs.queue?.streamDone ?? null;
  out.streamCompare = runs.queue?.streamCompare ? { streams: runs.queue.streamCompare.streams, segments: runs.queue.streamCompare.segments,
    missing: runs.queue.streamCompare.missing.length, mismatched: runs.queue.streamCompare.mismatched.length, perStream: runs.queue.streamCompare.perStream } : null;
  out.identical = null;
  out.differentFrames = [];
  if (runs.normal?.library && runs.queue?.library) {
    const a = await snapshotTree(runs.normal.library);
    const b = await snapshotTree(runs.queue.library);
    const keys = keyIndex(runs.normal);
    const clipStart = Object.fromEntries(PROJECT.tracks.flatMap(t => t.clips).map(c => [c.id, Math.round(c.start * FPS)]));
    const describe = rel => {
      const parts = rel.split('/');
      const tier = parts[0] === 'controls-local' ? 'local' : 'shared';
      const key = tier === 'local' ? parts[2] : parts[1];
      const name = parts[parts.length - 1];
      const hit = keys.get(key);
      const frame = /^\d+\.html$/.test(name) ? Number(name.slice(0, -5)) : null;
      const global = hit && frame !== null ? frame + (clipStart[hit.clipId] ?? 0) : null;
      return { file: rel, tier, clipId: hit?.clipId ?? null, localFrame: frame, anchor: global !== null ? ANCHORS.includes(global) : null };
    };
    for (const rel of [...new Set([...a.keys(), ...b.keys()])].sort()) {
      const x = a.get(rel), y = b.get(rel);
      if (x && y && x.equals(y)) continue;
      // 只差 style 属性里声明的先后(实测两趟普通模式之间也这样,见报告)的,单独标出来
      const styleOrderOnly = !!(x && y && rel.endsWith('.html') && sortStyles(x.toString('utf8')) === sortStyles(y.toString('utf8')));
      out.differentFrames.push({ ...describe(rel), reason: !x ? 'only-in-queue' : !y ? 'only-in-normal' : 'bytes', styleOrderOnly, normalBytes: x?.length ?? null, queueBytes: y?.length ?? null });
    }
    out.identicalIgnoringStyleOrder = out.differentFrames.every(d => d.styleOrderOnly);
    out.compared = { normalFiles: a.size, queueFiles: b.size, htmlFiles: [...a.keys()].filter(k => k.endsWith('.html')).length };
    out.identical = out.differentFrames.length === 0;
    check(out.compared.htmlFiles > 0, '普通模式的帧库里有快照', out.compared);
    check(out.tasks > 0, '队列模式切出了细任务', out.tasks);
    check(out.done === out.tasks, '队列模式的细任务全部 done', { tasks: out.tasks, done: out.done });
    const summary = {};
    for (const d of out.differentFrames) {
      const k = `${d.clipId ?? '?'}/${d.tier}/${d.reason}${d.styleOrderOnly ? '(style-order)' : ''}/${d.anchor ? 'anchor' : 'non-anchor'}`;
      summary[k] = (summary[k] ?? 0) + 1;
    }
    out.differenceSummary = summary;
  } else if (!ONLY) check(false, '两趟都要有帧库才能比较', Object.keys(runs));
  if (runs.queue?.release) await holdOpen(runs.queue);
} catch (error) {
  fails.push(`探针自己出错:${error?.stack || error}`);
} finally {
  if (runs.queue?.release) await runs.queue.release().catch(() => {});
  out.runs = Object.fromEntries(Object.entries(runs).map(([k, r]) => [k, { ...r, log: undefined, peerLog: undefined, library: undefined, release: undefined, diagnostics: undefined }]));
  out.nodes = runs.queue?.nodes ?? null;
  out.announcedAsset = runs.queue?.announcedAsset ?? null;
  out.x5 = runs.queue?.x5 ?? null;
  if (!KEEP) for (const run of Object.values(runs)) for (const dir of [run?.exportDir, run?.peer?.exportDir]) if (dir) await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
}

const result = { ok: fails.length === 0, tasks: out.tasks ?? 0, done: out.done ?? 0, identical: out.identical ?? null,
  differentFrames: out.differentFrames ?? [], fails, ...out };
console.log(JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ok: result.ok, tasks: result.tasks, done: result.done, identical: result.identical,
  differentFrames: result.differentFrames.length, identicalIgnoringStyleOrder: out.identicalIgnoringStyleOrder ?? null, differenceSummary: out.differenceSummary ?? null,
  streamTasks: out.streamTasks, streamDone: out.streamDone, streamCompare: out.streamCompare, x5: out.x5 ?? null, fails }));
process.exit(result.ok ? 0 : 1);
