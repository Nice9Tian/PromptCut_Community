/**
 * M8「换机迁移演练」的探针（`docs/plan/m8-plan.md` 第 2.5 节；步骤照 `docs/plan/hosting-migration.md` 第 2 节）。
 * 判据（主执行计划第 7 节 M8「换机迁移」）：`projectRev` 连续、不归零；素材与产物按哈希逐个取回、校验通过 100%；
 * 已就绪的层不重新预渲染。
 *
 * 每一步可以单独跑（`--step`）。本探针**不连远端**：阿里云上要在服务器里执行的部分由 `--step remote-plan` 打印成命令清单，
 * 由主会话照着做；PC 上的部分（种子、库存、核对、客户端）照常连托管端的地址（可以是 SSH 转发出来的回环端口）。
 * 结果最后一行打一行 JSON；`ok` 为假时退出码 1，参数不对或连不上退出码 2。口令、令牌不打到输出里。
 *
 * ## --step seed --hosted <源文档服务> --seed <种子文件>
 *
 *   node scripts/probes/m8-migrate-probe.mjs --step seed --hosted http://127.0.0.1:5760 --seed <种子文件>
 *        [--tasks 4] [--frames 3] [--task-ms 200] [--media-kb 256] [--name <项目名>]
 *
 *   在源实例上建一个自由进入的探针项目，并把它做成「有素材、有已就绪的层」的样子：
 *   1. 页面角色的创建者连接：`project.op` 根替换写入一份空项目（与编辑器 `createEmptyProject` 同形），`projectRev` 从 0 变 1；
 *   2. 渲染角色的创建者连接当节点：发布 `--tasks` 个细任务（kind snapshot、tier shared），本节点认领，执行器睡 `--task-ms`，
 *      产物库把每段 `--frames` 帧的快照（小 HTML）推进素材服务的 `snap`，再把段清单写进内容库
 *      （`snapshot-manifest`，键 `<resultKey>:<from>-<to>`，形状同 `server/artifact-transfer.mjs`）——与真实节点的
 *      「已就绪的层」同一种落法；最后写层表 `layers:<项目 id>`；
 *   3. 传一个素材（`media`）；
 *   4. 写种子文件（0600）：项目 id、创建者与项目口令、细任务的范围、素材哈希、种完时的 `projectRev`。**种子文件含口令，
 *      放临时目录，不进仓库、不贴进报告**。
 *
 * ## --step client --hosted <新文档服务> --seed <种子文件> --inventory <库存文件>
 *
 *   node scripts/probes/m8-migrate-probe.mjs --step client --hosted http://127.0.0.1:5762 --seed <种子文件> --inventory <库存文件>
 *        [--no-edit] [--ui --old-hosted <旧地址> [--editor-port 5766] [--shots <截图目录>]] [--forbid-host 203.0.113.16]
 *
 *   迁移后的客户端（`m8-plan.md` 第 2.5 节第 8、9 步）。以**成员**身份（项目口令、自报一个新用户名）进新实例：
 *   1. 登记的素材服务地址是新实例自己的（与库存里旧实例的不同）；
 *   2. **不重新预渲染**：渲染角色的连接当节点，重发种子里的同一批细任务；执行器的 `render` 被调用即记一次并失败。
 *      判据：`render` 0 次、全部细任务 `task.done`；每个 `task.done` 带回的清单与内容库里的一致。去重来自本节点
 *      （`dedup`，产物库查到清单与块都在）或队列里已有的完成（第二台客户端再跑时）；
 *   3. **rev 连续**：页面角色的连接 `project.open` 读到的 `projectRev` 等于库存里的；改一处（项目名加「（迁移后）」）后
 *      `projectRev` = 库存 + 1。`--no-edit`（第二台客户端）只核 `projectRev` 不小于库存、不归零；
 *   4. `--ui`：起一台桌面编辑器（`vite --port <editor-port> --strictPort`，另占 +1、+2 两个舞台端口；数据目录临时），
 *      开始页「加入别人的项目」先把托管地址记成 `--old-hosted`（模拟迁移前的设置），再在「服务器地址」里改成新地址，
 *      填项目名、用户名、项目密码加入；进了编辑器（顶栏出现成员按钮）、页面里的项目名是第 3 步改后的、本机记下的托管地址
 *      是新地址。截图 `client-0-old-address.png`、`client-1-new-address.png`、`client-2-entered.png`。`--forbid-host` 给了时，
 *      页面发往这个主机的请求记为失败（本机替身演练给 203.0.113.16，保证不碰真托管端）。
 *
 * ## --step remote-plan [--public-host 203.0.113.16] [--tunnel-base 18700] [--stamp 20260928]
 *
 *   打印阿里云上的演练命令清单（备份、演练实例部署、UFW 临时放行与收回、停写、拷数据、核对、切客户端、收尾），不连远端。
 *   同一份清单写在 `docs/archive/agent-reports/AGENT-m8-migrate.md`。
 *
 * ## --step local [--ui] [--shots <目录>] [--keep]
 *
 *   本机替身，全流程演一遍：两份托管组合都是本机的子进程（`server/hosted/main.mjs`，绑 127.0.0.1，关本机信任、集群令牌放
 *   `<数据目录>/secrets/cluster-token`，同阿里云的部署），数据目录在系统临时目录。
 *   源 5760 / 5761 → seed → `shared-project-probe.mjs --role inventory`（带 `--seed`、`--scan-dir`）→ 停源（停写）→
 *   整个数据目录拷到目标的数据目录，核两边文件数与总字节数 → 起目标 5762 / 5763（公网地址换成目标的）→
 *   `shared-project-probe.mjs --role migrate-check --from-inventory … --sample all --seed … --scan-dir …` → client（`--ui` 时带界面一段，
 *   编辑器 5766～5768）。端口可用 `--src-port`、`--dst-port`（各占两个连号）、`--editor-port` 改。`--keep` 不删临时目录。
 *   `--tamper`：拷完后在目标数据目录里删一个快照块、改坏一个，证明核对与客户端会失败（自检用，期望退出码 1）。
 *
 * 只用 Node 内置模块、puppeteer（`--ui`）与仓库里的服务端模块。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR,产物不落进用户的 Videos\PromptCut
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const intArg = (name, fallback, min = 0) => {
  const raw = arg(name, undefined);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) usage(`${name} 要是不小于 ${min} 的整数`);
  return n;
};
const USAGE = `用法：
  node scripts/probes/m8-migrate-probe.mjs --step seed --hosted <源> --seed <种子文件> [--tasks 4] [--frames 3]
  node scripts/probes/m8-migrate-probe.mjs --step client --hosted <新> --seed <种子文件> --inventory <库存文件> [--no-edit] [--ui --old-hosted <旧> --editor-port 5766 --shots <目录>] [--forbid-host <主机>]
  node scripts/probes/m8-migrate-probe.mjs --step remote-plan [--public-host 203.0.113.16] [--tunnel-base 18700] [--stamp 20260928]
  node scripts/probes/m8-migrate-probe.mjs --step local [--ui] [--shots <目录>] [--src-port 5760] [--dst-port 5762] [--editor-port 5766] [--keep]
  库存与核对：scripts/probes/shared-project-probe.mjs --role inventory / --role migrate-check --from-inventory（用法见那个文件头）`;
function usage(msg) {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

const STEP = arg('--step', null);
const started = Date.now();
const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const mod = (rel) => import(new URL(`../../${rel}`, import.meta.url));
const log = (event, fields = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const fails = [];
const check = (cond, label, extra) => {
  if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 400)}`));
  log('check', { ok: !!cond, label });
  return !!cond;
};

/* ------------------------------------------------------------------ 共用小件（同 shared-project-probe.mjs） */

function docUrls(url) {
  const u = new URL(url);
  const p = u.pathname.replace(/\/+$/, '');
  if (u.protocol === 'ws:' || u.protocol === 'http:') return { http: `http://${u.host}${p}`, ws: `ws://${u.host}${p}` };
  if (u.protocol === 'wss:' || u.protocol === 'https:') return { http: `https://${u.host}${p}`, ws: `wss://${u.host}${p}` };
  throw new Error(`不认识的地址：${url}`);
}

function rpcOn(ep) {
  const waiting = new Map();
  let seq = 0;
  ep.onMessage((m) => {
    const w = m?.reqId !== undefined ? waiting.get(m.reqId) : undefined;
    if (!w) return;
    w.got.push(m);
    if (m.type === 'error' || !w.until || w.until(m)) {
      waiting.delete(m.reqId);
      clearTimeout(w.timer);
      w.resolve(w.until ? w.got : m);
    }
  });
  return (message, { until, timeoutMs = 20_000 } = {}) => new Promise((resolve, reject) => {
    const reqId = `m8-${++seq}-${randomBytes(3).toString('hex')}`;
    const timer = setTimeout(() => { waiting.delete(reqId); reject(new Error(`等 ${message.type} 的回包超时`)); }, timeoutMs);
    waiting.set(reqId, { resolve, until, got: [], timer });
    if (!ep.send({ ...message, reqId })) {
      waiting.delete(reqId);
      clearTimeout(timer);
      reject(new Error(`${message.type} 没发出去（连接不在）`));
    }
  });
}

function waitOpen(ep, ms = 15_000) {
  return new Promise((resolve) => {
    if (ep.connected) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    ep.onOpen(() => { clearTimeout(t); resolve(true); });
  });
}

function waitAssetUrl(ep, watchServiceEndpoints, ms = 10_000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { stop(); resolve(null); }, ms);
    const stop = watchServiceEndpoints(ep, ['asset'], (list) => {
      const url = list.find((e) => e.kind === 'asset' && Array.isArray(e.urls) && e.urls.length)?.urls[0];
      if (url) { clearTimeout(t); stop(); resolve(url); }
    });
  });
}

async function closeAll(eps) {
  const waits = [];
  for (const ep of eps) {
    if (ep.connected) waits.push(new Promise((resolve) => ep.onClose(resolve)));
    try { ep.close(); } catch { /* 已关 */ }
  }
  eps.length = 0;
  await Promise.race([Promise.all(waits), new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
}

/** 打结果行、定退出码，让进程自然退出（Windows 上有句柄在关就 process.exit 会断言崩，同 shared-project-probe） */
function finish(result, code) {
  result.fails = fails;
  result.ms = Date.now() - started;
  if (code === undefined) code = fails.length === 0 ? 0 : 1;
  result.ok = code === 0;
  process.exitCode = code;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  setTimeout(() => process.exit(code), 10_000).unref();
}

/* ------------------------------------------------------------------ 种子项目的「已就绪的层」 */

const SEED_KIND = 'promptcut-m8-seed';
const LAYER_MAP_PREFIX = 'layers:';

/** 与编辑器 `createEmptyProject`（`src/kernel/project.ts`）同形的空项目 */
function emptyProject(name) {
  return {
    version: 1, id: `m8-${runId}`, name, width: 1920, height: 1080, fps: 30, duration: 30, themeId: 'midnight', media: [],
    tracks: [{ id: 't-1', name: '序列 1', clips: [] }, { id: 't-2', name: '序列 2', clips: [] }],
  };
}

/** 细任务（与 render-queue-e2e / shared-project-probe 同形） */
function fineTask({ resultKey, from, to, projectId, projectRev }) {
  return {
    id: `snapshot:${resultKey}:${from}-${to}`, kind: 'snapshot', tier: 'shared', resultKey,
    range: { unit: 'localFrame', from, to }, source: { projectId, projectRev }, input: {},
    weight: { class: 'light', estMs: null, frames: to - from + 1 }, requires: {}, priority: 0,
  };
}

/** 一帧快照（小 HTML）：内容由结果键与帧号决定，按内容寻址 */
const frameBytes = (resultKey, frame) => Buffer.from(`<!doctype html><!-- promptcut m8-migrate probe -->\n<div data-key="${resultKey}" data-frame="${frame}"></div>\n`, 'utf8');
const manifestKey = (resultKey, range) => `${resultKey}:${range.from}-${range.to}`;

/**
 * 读内容库里这一段的清单，核它引用的块都在素材服务里（与真实节点 sink 的去重同一条判据：清单在、块齐）。
 * 回清单正文或 null。
 */
async function readyManifest(rpc, client, ref) {
  const item = await rpc({ type: 'content.get', kind: 'snapshot-manifest', key: manifestKey(ref.resultKey, ref.range) });
  if (item.type !== 'content.item' || item.missing || !item.body) return null;
  const body = item.body;
  if (body.v !== 1 || body.kind !== 'snapshot' || body.resultKey !== ref.resultKey || body.range?.from !== ref.range.from || body.range?.to !== ref.range.to) return null;
  for (const [, hash] of body.frames ?? []) if (!(await client.has('snap', hash))) return null;
  return body;
}

/** 渲染节点的连接与本机节点的几件套 */
async function renderLink(urls, protocols, label) {
  const [{ createDocEndpoint }, { watchServiceEndpoints }, { createTicketSource }, { createAssetClient }] = await Promise.all([
    mod('server/render-node/session-link.mjs'), mod('server/render-node/endpoint.mjs'), mod('server/auth/ticket-source.mjs'), mod('server/asset-store/client.mjs'),
  ]);
  const ep = createDocEndpoint({ url: urls.ws, protocols, log: (event, fields) => { if (!/^(send|recv)/.test(event)) log(`${label}.${event}`, fields); } });
  const rpc = rpcOn(ep);
  const opened = await waitOpen(ep);
  const assetUrl = opened ? await waitAssetUrl(ep, watchServiceEndpoints) : null;
  const client = assetUrl ? createAssetClient({ base: assetUrl, ticket: createTicketSource(ep, { access: 'rw' }) }) : null;
  return { ep, rpc, opened, assetUrl, client };
}

/**
 * 在一条渲染连接上跑一个节点，发布 `tasks`，等全部 `task.done`（或失败 / 超时）。
 * `render` 是执行器的渲染函数；`sink` 是产物库。回计数与每个任务 `task.done` 带回的结果。
 */
async function runNode({ link, tasks, render, sink, nodeId, timeoutMs }) {
  const { createLocalNode } = await mod('server/render-node/local-node.mjs');
  const counters = { claimed: 0, completed: 0, dedup: 0, failed: 0, doneMsgs: 0 };
  const results = new Map();
  const ids = new Set(tasks.map((t) => t.id));
  let resolveAll;
  const allDone = new Promise((resolve) => { resolveAll = resolve; });
  link.ep.onMessage((m) => {
    if (m?.type === 'task.claimed' && ids.has(m.id)) counters.claimed += 1;
    if (m?.type === 'task.done' && ids.has(m.id)) {
      counters.doneMsgs += 1;
      if (!results.has(m.id)) results.set(m.id, m.result ?? null);
      if (results.size === ids.size) resolveAll(true);
    } else if (m?.type === 'task.failed' && ids.has(m.id)) {
      fails.push(`task.failed ${m.id}: ${m.error}`);
    }
  });
  const node = createLocalNode({
    nodeId,
    node: { profile: 'pc', envFingerprint: 'm8-migrate-probe-env', codeVersions: [], capabilities: {} },
    endpoint: link.ep,
    now: Date.now,
    maxConcurrent: 2,
    executor: { plan: async () => { throw Object.assign(new Error('探针不算计划'), { retryable: false }); }, render },
    sink,
    onEvent: (e) => {
      if (e.type === 'completed') counters.completed += 1;
      if (e.type === 'dedup') counters.dedup += 1;
      if (e.type === 'failed') counters.failed += 1;
    },
  });
  node.start();
  const timer = setInterval(() => { try { node.tick(); } catch (err) { log('node.tick-error', { message: String(err?.message ?? err) }); } }, 50);
  const pub = await link.rpc({ type: 'task.publish', tasks }).catch((err) => ({ type: 'error', detail: err.message }));
  check(pub.type === 'task.published' && (pub.results ?? []).every((r) => !r.error), 'task.publish', pub);
  const finished = await Promise.race([allDone, sleep(timeoutMs).then(() => false)]);
  clearInterval(timer);
  await node.settled?.().catch(() => {});
  node.stop();
  return { finished, counters, results, published: pub.results ?? [] };
}

/* ================================================================== seed */

async function stepSeed({ hosted, seedFile, name = arg('--name', `m8迁移探针-${runId}`) } = {}) {
  hosted ??= arg('--hosted', null);
  seedFile ??= arg('--seed', null);
  if (!hosted || !seedFile) usage('seed 要 --hosted 与 --seed');
  const taskCount = intArg('--tasks', 4, 1);
  const frames = intArg('--frames', 3, 1);
  const taskMs = intArg('--task-ms', 200, 0);
  const mediaKb = intArg('--media-kb', 256, 1);
  const urls = docUrls(hosted);
  const [{ createSharedProject }, { buildAuthProtocols }, { createDocEndpoint }] = await Promise.all([
    mod('server/auth/route.mjs'), mod('server/auth/client.mjs'), mod('server/render-node/session-link.mjs'),
  ]);
  const out = { step: 'seed', hosted: urls.http, projectId: null, name, projectRev: null, tasks: null, layers: 0, frames: 0, media: null, seed: null };
  const eps = [];
  try {
    const creator = { username: 'm8-creator', password: randomBytes(12).toString('base64url') };
    const projectPassword = randomBytes(12).toString('base64url');
    let created;
    try {
      created = await createSharedProject({ where: 'hosted', hostedUrl: urls.http, name, mode: 'free', creator, password: projectPassword });
    } catch (err) {
      fails.push(`建项目失败：${err?.status ?? ''} ${err?.reason ?? err?.message}`);
      return out;
    }
    const projectId = created.projectId;
    out.projectId = projectId;
    const deviceId = `m8-seed-${randomBytes(6).toString('hex')}`;
    let key = null;
    const protocolsAs = (role) => () => buildAuthProtocols({
      base: urls.http, projectId, username: creator.username, deviceId, deviceName: 'm8-migrate-seed', as: 'creator',
      ...(key ? { key } : { password: creator.password }), role, onKey: (k) => { key = k; },
    });

    // 1. 页面角色：写项目真身
    const page = createDocEndpoint({ url: urls.ws, protocols: protocolsAs('page'), log: () => {} });
    eps.push(page);
    const prpc = rpcOn(page);
    if (!check(await waitOpen(page), 'seed：创建者（页面）连上')) return out;
    await prpc({ type: 'project.open', projectId }, { until: (m) => m.type === 'project.state' });
    const op = await prpc({ type: 'project.op', projectId, opId: `m8-seed-${runId}`, expectRev: 0, ops: [{ op: 'set', path: '', value: emptyProject(name) }] });
    check(op.type === 'project.op.ok', 'seed：写入项目（根替换）', op);
    const projectRev = op.rev ?? null;

    // 2. 渲染角色：本节点发布并完成细任务，产物进 snap，段清单进内容库
    const link = await renderLink(urls, protocolsAs('render'), 'seed');
    eps.push(link.ep);
    if (!check(link.opened && link.client, 'seed：创建者（渲染节点）连上、拿到素材服务地址', { assetUrl: link.assetUrl })) return out;
    const resultKey = `m8seed-${randomBytes(8).toString('hex')}`;
    const ranges = Array.from({ length: taskCount }, (_, i) => ({ from: i * frames, to: i * frames + frames - 1 }));
    const tasks = ranges.map((r) => fineTask({ resultKey, ...r, projectId, projectRev }));
    let frameCount = 0;
    const sink = {
      async has(ref) { return !!(await readyManifest(link.rpc, link.client, ref)); },
      async resultFor(ref) { return readyManifest(link.rpc, link.client, ref); },
      async put(entry) {
        const list = [];
        for (let f = entry.range.from; f <= entry.range.to; f += 1) {
          const bytes = frameBytes(entry.resultKey, f);
          const r = await link.client.put('snap', bytes, { ext: 'html' });
          list.push([f, r.hash ?? sha256(bytes), bytes.length]);
          frameCount += 1;
        }
        const body = { v: 1, kind: 'snapshot', tier: 'shared', resultKey: entry.resultKey, range: { from: entry.range.from, to: entry.range.to }, frames: list };
        const st = await link.rpc({ type: 'content.put', kind: 'snapshot-manifest', key: manifestKey(entry.resultKey, entry.range), body });
        if (st.type !== 'content.stored') throw new Error(`段清单没写进去：${st.type}`);
        return { complete: true, result: body };
      },
    };
    const render = (task, { signal }) => new Promise((resolve, reject) => {
      const t = setTimeout(() => resolve({ frames: task.range.to - task.range.from + 1 }), taskMs);
      signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
    });
    const run = await runNode({ link, tasks, render, sink, nodeId: `m8-seed-node-${runId}`, timeoutMs: 120_000 });
    check(run.finished, `seed：细任务全部 task.done（${run.results.size}/${tasks.length}）`, run.counters);
    check(run.counters.completed === tasks.length, 'seed：细任务都由本节点渲染完成（不是去重）', run.counters);
    out.tasks = { published: tasks.length, ...run.counters };
    out.frames = frameCount;
    // 层表
    const layerBody = {
      v: 1, projectId, at: Date.now(),
      layers: [{ clipId: 'm8-probe-clip', kind: 'html', key: resultKey, tier: 'shared', resultKey, dirKey: resultKey, entryKey: null, firstFrame: 0, count: taskCount * frames }],
    };
    const lt = await link.rpc({ type: 'content.put', kind: 'snapshot-manifest', key: LAYER_MAP_PREFIX + projectId, body: layerBody });
    check(lt.type === 'content.stored', 'seed：层表写进内容库', lt.type);
    out.layers = tasks.length;
    // 3. 素材
    const media = randomBytes(mediaKb * 1024);
    const mr = await link.client.put('media', media, { ext: 'bin' });
    const mediaHash = sha256(media);
    check((mr.hash ?? mediaHash) === mediaHash, 'seed：素材上传回的哈希对得上');
    out.media = { hash: mediaHash, bytes: media.length };
    out.projectRev = projectRev;

    // 4. 种子文件（含口令，0600）
    const seed = {
      v: 1, kind: SEED_KIND, createdAt: new Date().toISOString(), hosted: urls.http,
      projects: [{
        projectId, name, mode: 'free', deviceId, creator, projectPassword, projectRev, resultKey, frames, ranges, media: out.media,
        assetUrl: link.assetUrl,
      }],
    };
    if (fails.length === 0) {
      const file = path.resolve(seedFile);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${JSON.stringify(seed, null, 1)}\n`, { mode: 0o600 });
      out.seed = file;
    }
    return out;
  } finally {
    await closeAll(eps);
  }
}

/* ================================================================== client */

function readJson(file, what) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  } catch (err) {
    usage(`读${what} ${file}：${err.message}`);
    return null;
  }
}

async function stepClient({ hosted, seedFile, inventoryFile, ui = has('--ui'), oldHosted = arg('--old-hosted', null), edit = !has('--no-edit') } = {}) {
  hosted ??= arg('--hosted', null);
  seedFile ??= arg('--seed', null);
  inventoryFile ??= arg('--inventory', null);
  if (!hosted || !seedFile || !inventoryFile) usage('client 要 --hosted、--seed、--inventory');
  const seed = readJson(seedFile, '种子文件');
  const inv = readJson(inventoryFile, '库存文件');
  if (seed?.kind !== SEED_KIND) usage(`${seedFile} 不是种子文件`);
  const p = seed.projects[0];
  const before = (inv.seeded ?? []).find((s) => s.projectId === p.projectId) ?? null;
  const urls = docUrls(hosted);
  const [{ buildAuthProtocols }, { createDocEndpoint }] = await Promise.all([mod('server/auth/client.mjs'), mod('server/render-node/session-link.mjs')]);
  const out = {
    step: 'client', hosted: urls.http, projectId: p.projectId, assetUrl: null, oldAssetUrl: inv.inventory?.assetPublicUrl ?? inv.source?.registeredAsset ?? null,
    rerender: null, rev: { inventory: before?.projectRev ?? null, open: null, afterEdit: null }, ui: null,
  };
  check(before, '库存里有这个种子项目（盘点时给了 --seed）');
  const eps = [];
  const member = { username: `m8-member-${randomBytes(3).toString('hex')}`, deviceId: `m8-client-${randomBytes(6).toString('hex')}` };
  let key = null;
  const protocolsAs = (role) => () => buildAuthProtocols({
    base: urls.http, projectId: p.projectId, username: member.username, deviceId: member.deviceId, deviceName: 'm8-migrate-client', as: 'member',
    ...(key ? { key } : { password: p.projectPassword }), role, onKey: (k) => { key = k; },
  });
  try {
    // 1 + 2. 渲染节点：重发同一批细任务，执行器一次都不该被调用
    const link = await renderLink(urls, protocolsAs('render'), 'client');
    eps.push(link.ep);
    if (!check(link.opened && link.client, 'client：成员（渲染节点）凭项目口令进新实例、拿到素材服务地址', { assetUrl: link.assetUrl })) return out;
    out.assetUrl = link.assetUrl;
    check(!out.oldAssetUrl || link.assetUrl !== out.oldAssetUrl, 'client：素材服务地址是新实例的（与库存里旧实例的不同）', { now: link.assetUrl, old: out.oldAssetUrl });
    const tasks = p.ranges.map((r) => fineTask({ resultKey: p.resultKey, ...r, projectId: p.projectId, projectRev: p.projectRev }));
    let renders = 0;
    const sink = {
      async has(ref) { return !!(await readyManifest(link.rpc, link.client, ref)); },
      async resultFor(ref) { return readyManifest(link.rpc, link.client, ref); },
      async put() { throw Object.assign(new Error('迁移后不该再推产物'), { retryable: false }); },
    };
    const render = async () => { renders += 1; throw Object.assign(new Error('迁移后不该重新预渲染'), { retryable: false }); };
    const run = await runNode({ link, tasks, render, sink, nodeId: `m8-client-node-${runId}`, timeoutMs: 60_000 });
    let manifestsMatch = 0;
    for (const t of tasks) {
      const got = run.results.get(t.id);
      const want = await readyManifest(link.rpc, link.client, t);
      if (got && want && JSON.stringify(got.frames) === JSON.stringify(want.frames)) manifestsMatch += 1;
    }
    out.rerender = { tasks: tasks.length, done: run.results.size, renders, ...run.counters, manifestsMatch, created: run.published.filter((r) => r.created).length };
    check(run.finished, `client：细任务全部 task.done（${run.results.size}/${tasks.length}）`, out.rerender);
    check(renders === 0 && run.counters.completed === 0, 'client：已就绪的层不重新预渲染（执行器 render 0 次）', out.rerender);
    check(manifestsMatch === tasks.length, 'client：task.done 带回的清单与内容库里的一致', out.rerender);

    // 3. 页面角色：rev 连续；改一处 rev + 1
    const page = createDocEndpoint({ url: urls.ws, protocols: protocolsAs('page'), log: () => {} });
    eps.push(page);
    const prpc = rpcOn(page);
    if (check(await waitOpen(page), 'client：成员（页面）连上')) {
      const st = (await prpc({ type: 'project.open', projectId: p.projectId }, { until: (m) => m.type === 'project.state' })).find((m) => m.type === 'project.state');
      out.rev.open = st?.projectRev ?? st?.rev ?? null;
      if (edit) {
        check(out.rev.open === out.rev.inventory, 'client：新实例上的 projectRev 等于迁移前库存（连续、不归零）', out.rev);
        const newName = `${p.name}（迁移后）`;
        const op = await prpc({ type: 'project.op', projectId: p.projectId, opId: `m8-edit-${runId}`, expectRev: out.rev.open, ops: [{ op: 'set', path: '/name', value: newName }] });
        out.rev.afterEdit = op.rev ?? null;
        check(op.type === 'project.op.ok' && op.rev === (out.rev.inventory ?? NaN) + 1, 'client：改一处后 projectRev = 迁移前 + 1', { ...out.rev, reply: op.type });
        out.editedName = newName;
      } else {
        check(Number.isInteger(out.rev.open) && out.rev.open >= (out.rev.inventory ?? 0) && out.rev.open > 0, 'client：projectRev 不小于迁移前库存、不归零', out.rev);
      }
    }
  } finally {
    await closeAll(eps);
  }

  // 4. 界面：开始页改托管地址、加入
  if (ui) out.ui = await clientUi({ hosted: urls.http, oldHosted, project: p, expectName: out.editedName ?? null });
  return out;
}

/** worktree 没有自己的 node_modules：按模块解析 vite，再回到包根找 bin（同 online-join-probe） */
function viteBin() {
  const local = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  if (fs.existsSync(local)) return local;
  const main = createRequire(import.meta.url).resolve('vite');
  const at = main.lastIndexOf(`${path.sep}vite${path.sep}`);
  return path.join(main.slice(0, at + 6), 'bin', 'vite.js');
}

function killTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return Promise.resolve();
  const exited = new Promise((resolve) => child.once('exit', resolve));
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  else child.kill('SIGKILL');
  return Promise.race([exited, sleep(10_000)]);
}

async function waitFor(fn, ms, what) {
  const t0 = Date.now();
  let last;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时${last instanceof Error ? `：${last.message}` : ''}`);
    await sleep(200);
  }
}

async function clientUi({ hosted, oldHosted, project, expectName }) {
  const port = intArg('--editor-port', 5766, 1);
  const shots = path.resolve(arg('--shots', path.join(os.tmpdir(), `m8-migrate-shots-${runId}`)));
  const forbid = arg('--forbid-host', null);
  fs.mkdirSync(shots, { recursive: true });
  const editorData = fs.mkdtempSync(path.join(os.tmpdir(), 'm8-migrate-editor-'));
  const DESKTOP = `http://127.0.0.1:${port}`;
  const out = { editor: DESKTOP, shots, oldHosted, enterMs: null, storedHostedUrl: null, projectName: null, forbiddenRequests: 0 };
  const env = {
    ...process.env, PROMPTCUT_PUSH: '0', PROMPTCUT_DATA_DIR: editorData, PROMPTCUT_EXPORT_DIR: path.join(editorData, 'out'),
    PROMPTCUT_DEVICE_ID: 'm8-migrate-probe-desk-01', PROMPTCUT_DEVICE_NAME: 'M8Desk',
  };
  for (const k of ['PROMPTCUT_LAN_HOST', 'PROMPTCUT_DOCSERVICE_URL', 'PROMPTCUT_CLUSTER_TOKEN', 'PROMPTCUT_SHARED_CONFIG', 'PROMPTCUT_QUEUE_NODE']) delete env[k];
  // 服务端缺省托管地址也指到旧地址（本机替身时就是本机的源），保证编辑器进程不去碰内置的缺省地址
  if (oldHosted) env.PROMPTCUT_HOSTED_URL = oldHosted;
  const editorLog = [];
  const editor = spawn(process.execPath, [viteBin(), '--port', String(port), '--strictPort', '--host', '127.0.0.1'], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  const keep = (c) => { editorLog.push(c.toString()); if (editorLog.length > 300) editorLog.shift(); };
  editor.stdout.on('data', keep);
  editor.stderr.on('data', keep);
  let browser = null;
  try {
    await waitFor(async () => {
      if (editor.exitCode !== null) throw new Error(`编辑器退出了：${editorLog.join('').slice(-600)}`);
      return fetch(`${DESKTOP}/`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
    }, 240_000, '桌面编辑器起来');
    log('ui.editor-up', { url: DESKTOP, pid: editor.pid });
    const { default: puppeteer } = await import('puppeteer');
    const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
    browser = await puppeteer.launch({ headless: true, defaultViewport: { width: 1440, height: 900 }, args: [...PROBE_CHROME_ARGS, '--window-position=-32000,-32000', '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1'] });
    const page = await browser.newPage();
    const requests = [];
    page.on('request', (r) => requests.push(r.url()));
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e?.message ?? e)));
    const shot = async (name) => { await page.screenshot({ path: path.join(shots, `${name}.png`) }); log('ui.shot', { file: path.join(shots, `${name}.png`) }); };
    const typeInto = async (sel, text) => {
      await page.waitForSelector(sel, { visible: true, timeout: 15_000 });
      await page.click(sel);
      await page.$eval(sel, (el) => el.select());
      await page.keyboard.press('Backspace');
      if (text) await page.type(sel, text, { delay: 5 });
    };
    const dismissAiSetup = async () => {
      const t0 = Date.now();
      while (Date.now() - t0 < 6000) {
        const closed = await page.evaluate(() => {
          const dlg = [...document.querySelectorAll('[role="dialog"], .pc-dialog')].find((d) => /选择 AI 助手的驱动方式/.test(d.textContent ?? ''));
          const btn = dlg ? [...dlg.querySelectorAll('button')].find((b) => b.textContent?.trim() === '关闭') : null;
          btn?.click();
          return !!btn;
        }).catch(() => false);
        if (closed) return;
        await sleep(250);
      }
    };

    // 迁移前的设置：本机记的托管地址是旧地址
    await page.goto(`${DESKTOP}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 90_000 });
    if (oldHosted) {
      await page.evaluate((u) => localStorage.setItem('pc.shared.hostedUrl', u), oldHosted);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-pc="join-form"]', { visible: true, timeout: 90_000 });
    }
    await dismissAiSetup();
    await page.click('::-p-text(服务器地址)');
    await page.waitForSelector('#pc-join-server', { visible: true, timeout: 15_000 });
    const shown = await page.$eval('#pc-join-server', (i) => i.value);
    if (oldHosted) check(shown === oldHosted.replace(/\/+$/, '') || shown === oldHosted, 'ui：加入表单里的托管地址原先是旧地址', { shown });
    await shot('client-0-old-address');
    await typeInto('#pc-join-server', hosted);
    await typeInto('[data-pc="join-name"]', project.name);
    await typeInto('[data-pc="join-username"]', `M8界面-${randomBytes(2).toString('hex')}`);
    await typeInto('[data-pc="join-password"]', project.projectPassword);
    await shot('client-1-new-address');
    const t0 = Date.now();
    await page.click('[data-pc="join-submit"]');
    try {
      await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 90_000 });
      out.enterMs = Date.now() - t0;
      check(true, 'ui：改托管地址后加入、进了编辑器');
    } catch (e) {
      const msg = await page.$eval('[data-pc="join-message"]', (el) => el.textContent ?? '').catch(() => '');
      check(false, 'ui：改托管地址后加入、进了编辑器', { error: String(e.message), message: msg, pageErrors: pageErrors.slice(-5) });
    }
    out.storedHostedUrl = await page.evaluate(() => localStorage.getItem('pc.shared.hostedUrl'));
    check(out.storedHostedUrl === hosted, 'ui：本机记下的托管地址换成了新地址', { stored: out.storedHostedUrl, want: hosted });
    if (expectName) {
      out.projectName = await waitFor(async () => {
        const n = await page.evaluate(async () => (await import('/src/store/project.ts')).getState().project?.name ?? null);
        return n === expectName ? n : null;
      }, 30_000, '页面里的项目名换成迁移后改的').catch(async () => page.evaluate(async () => (await import('/src/store/project.ts')).getState().project?.name ?? null));
      check(out.projectName === expectName, 'ui：页面里的项目内容来自新实例（项目名是迁移后改的那一版）', { name: out.projectName, want: expectName });
    }
    await sleep(1000);
    await shot('client-2-entered');
    if (forbid) {
      const bad = requests.filter((u) => { try { return new URL(u).hostname === forbid; } catch { return false; } });
      out.forbiddenRequests = bad.length;
      check(bad.length === 0, `ui：页面没有请求 ${forbid}`, bad.slice(0, 3));
    }
    out.pageErrors = pageErrors.slice(-5);
  } catch (err) {
    fails.push(`ui：${err.message}`);
  } finally {
    try { await browser?.close(); } catch { /* 已关 */ }
    await killTree(editor);
    try { fs.rmSync(editorData, { recursive: true, force: true }); } catch { /* 句柄还没放 */ }
  }
  return out;
}

/* ================================================================== remote-plan */

/** 阿里云演练的命令清单（不连远端，只打印）。`R` 是 ssh 目标的占位 */
export function remotePlan({ host = '203.0.113.16', tunnelBase = 18700, stamp = '20260928' } = {}) {
  const t = (p) => tunnelBase + (p % 100);
  const bak = `bak-${stamp}-m8`;
  const R = 'ssh "$PROMPTCUT_REMOTE"';
  return [
    '# M8 换机迁移演练：阿里云命令清单（m8-migrate-probe.mjs --step remote-plan 生成；主会话执行，每步记时刻与输出）',
    '# 约定：PC 上 PROMPTCUT_REMOTE=<user@host>（本机信息见 docs/local.md），PROMPTCUT_CLUSTER_TOKEN 已设（不回显）；',
    `#       W=<PC 上放种子、库存、截图的临时目录（不进仓库）>；演练在 ${host} 上的第二份实例 promptcut-drill（8777 / 8778）。`,
    '',
    '## A. 备份（动 pm2 与 UFW 之前）',
    `${R} 'cp -a /opt/promptcut-hosted/pm2.config.cjs /opt/promptcut-hosted/pm2.config.cjs.${bak}; [ -f /opt/promptcut-drill/pm2.config.cjs ] && cp -a /opt/promptcut-drill/pm2.config.cjs /opt/promptcut-drill/pm2.config.cjs.${bak}; pm2 save && cp -a ~/.pm2/dump.pm2 ~/.pm2/dump.pm2.${bak}; ufw status numbered > /root/ufw-status.${bak}.txt; ls -la /opt/promptcut-hosted /opt/promptcut-drill 2>&1 | head -20'`,
    `${R} 'pm2 describe promptcut-drill | grep -E "status|script path" || echo "no drill"; du -sb /var/lib/promptcut/hosted /var/lib/promptcut/drill 2>/dev/null; df -h /var/lib/promptcut'`,
    '',
    '## B. 演练实例：删旧的 HT 第 1 版进程、旧数据挪开，部署当前 main',
    `${R} 'pm2 delete promptcut-drill || true; if [ -d /var/lib/promptcut/drill ]; then mv /var/lib/promptcut/drill /var/lib/promptcut/drill.old-${stamp}-m8; fi'`,
    `node cloud/scripts/remote/docservice.mjs deploy-hosted --instance drill --write-token --doc-public-url ws://${host}:8777 --asset-public-url http://${host}:8778/api/asset`,
    '#   （deploy-hosted 会 pm2 startOrReload 并查两个 /healthz；PROMPTCUT_TRUST_LOOPBACK=0 要令牌，所以带 --write-token。不加 --save）',
    'node cloud/scripts/remote/docservice.mjs status-hosted --instance drill',
    '#   演练实例先停，数据目录换成空的（部署时建的空目录与令牌文件挪开），等第 E 步拷数据',
    `${R} 'pm2 stop promptcut-drill && mv /var/lib/promptcut/drill /var/lib/promptcut/drill.deploy-${stamp}-m8 && install -d -m 700 /var/lib/promptcut/drill && ls -la /var/lib/promptcut/drill'`,
    '#   UFW 临时放行（D7：演练完收回）',
    `${R} 'ufw allow 8777/tcp comment "m8-drill ${stamp}"; ufw allow 8778/tcp comment "m8-drill ${stamp}"; ufw status | grep -E "8777|8778"'`,
    '',
    '## C. 停写之前：种子与库存（PC；管理接口经 SSH 转发，令牌不上公网）',
    `ssh -N -L ${t(87)}:127.0.0.1:8787 -L ${t(88)}:127.0.0.1:8788 -L ${t(77)}:127.0.0.1:8777 -L ${t(78)}:127.0.0.1:8778 "$PROMPTCUT_REMOTE"   # 另开一个终端挂着，演练完关掉`,
    `node scripts/probes/m8-migrate-probe.mjs --step seed --hosted http://127.0.0.1:${t(87)} --seed "$W/seed.json"`,
    `node scripts/probes/shared-project-probe.mjs --role inventory --hosted http://127.0.0.1:${t(87)} --asset http://127.0.0.1:${t(88)} --seed "$W/seed.json" --out "$W/inventory.json"`,
    '#   （E1 --keep 留下的项目、C10 页面建的项目：在库存的 inventory.spaces 里，按 projectRev 与哈希集合一起核；它们的层表在内容库条目数里）',
    '',
    '## D. 停写（此刻在线的成员会断开：先在对话里报时刻）',
    `${R} 'date -Is; pm2 stop promptcut-hosted; pm2 describe promptcut-hosted | grep status'`,
    '',
    '## E. 拷数据并核对文件数与总字节数',
    `${R} 'date -Is; time rsync -a /var/lib/promptcut/hosted/ /var/lib/promptcut/drill/; date -Is'`,
    `${R} 'for d in hosted drill; do echo "$d files=$(find /var/lib/promptcut/$d -type f | wc -l) bytes=$(du -sb /var/lib/promptcut/$d | cut -f1)"; done'`,
    '',
    '## F. 启动演练实例并自检',
    `${R} 'pm2 start promptcut-drill && sleep 2 && pm2 describe promptcut-drill | grep -E "status|restarts"'`,
    'node cloud/scripts/remote/docservice.mjs status-hosted --instance drill',
    '',
    '## G. 核对（PC）：rev、哈希全部取回、种子项目的就绪层',
    `node scripts/probes/shared-project-probe.mjs --role migrate-check --from-inventory "$W/inventory.json" --to http://127.0.0.1:${t(77)} --to-asset http://127.0.0.1:${t(78)} --seed "$W/seed.json" --sample all`,
    '',
    '## H. 切客户端（PC 界面改地址；笔记本当第二成员）',
    `node scripts/probes/m8-migrate-probe.mjs --step client --hosted http://${host}:8777 --seed "$W/seed.json" --inventory "$W/inventory.json" --ui --old-hosted <PC 桌面版原来的托管地址> --editor-port <主会话端口段> --shots "$W/shots"`,
    `#   笔记本（种子文件经协调口或 scp 带过去，用完删）：PROMPTCUT_HOSTED_URL=ws://${host}:8777 node scripts/probes/m8-migrate-probe.mjs --step client --hosted http://${host}:8777 --seed <种子文件> --inventory <库存文件> --no-edit`,
    '#   PC、笔记本的真实编辑器进 E1 留下的项目、preload：诊断 queue.stats 里 completed 0、dedup = 细任务数（第 2.5 节第 9 步，手工看）',
    '',
    '## I. 收尾：主实例回来，演练实例停，UFW 收回',
    `${R} 'date -Is; pm2 stop promptcut-drill; pm2 start promptcut-hosted; sleep 2; pm2 describe promptcut-hosted | grep -E "status|restarts"'`,
    'node cloud/scripts/remote/docservice.mjs status-hosted',
    `${R} 'ufw delete allow 8777/tcp; ufw delete allow 8778/tcp; ufw status | grep -E "8777|8778" || echo "8777/8778 已收回"'`,
    `${R} 'pm2 list'`,
    `#   确认 promptcut-hosted online、promptcut-drill stopped 后再 pm2 save（开机自启按这份）；演练前的 dump 在 ~/.pm2/dump.pm2.${bak}`,
    '#   演练实例的数据目录 /var/lib/promptcut/drill 与 drill.deploy-* / drill.old-* 保留到 M8 报告写完再删；',
    '#   真正换机时旧服务器保留只读 7 天（D7），下线前核新数据目录文件数不少于旧的。',
    '#   演练期间演练实例上的写（client 的改名）不回流主实例；种子项目留在主实例里，报告写完后由创建者删除。',
  ];
}

/* ================================================================== local */

function newToken() {
  return randomBytes(32).toString('base64url');
}

/** 起一份托管组合子进程（与 PM2 跑的同一个入口），等 `listen` 一行 */
async function startCombo(label, { dataDir, docPort, assetPort }) {
  const env = {
    ...process.env,
    PROMPTCUT_DATA_DIR: dataDir,
    PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1',
    PROMPTCUT_DOCSERVICE_PORT: String(docPort),
    PROMPTCUT_ASSET_PORT: String(assetPort),
    PROMPTCUT_DOCSERVICE_PUBLIC_URL: `ws://127.0.0.1:${docPort}`,
    PROMPTCUT_ASSET_PUBLIC_URL: `http://127.0.0.1:${assetPort}/api/asset`,
    PROMPTCUT_TRUST_LOOPBACK: '0',
    PROMPTCUT_DEVICE_ID: `m8-${label}-01`,
    PROMPTCUT_DEVICE_NAME: `M8${label}`,
  };
  delete env.PROMPTCUT_CLUSTER_TOKEN;
  const child = spawn(process.execPath, [path.join(ROOT, 'cloud', 'server', 'hosted', 'main.mjs')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
  const lines = [];
  let listen = null;
  let configError = null;
  const onData = (c) => {
    for (const line of c.toString().split('\n')) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length > 200) lines.shift();
      try {
        const j = JSON.parse(line);
        if (j.event === 'listen') listen = j;
        if (j.event === 'config.error') configError = j;
      } catch { /* 不是 JSON */ }
    }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  await waitFor(() => {
    if (configError) throw new Error(`${label} 起不来：${JSON.stringify(configError)}`);
    if (child.exitCode !== null) throw new Error(`${label} 退出了：${lines.slice(-5).join(' | ')}`);
    return listen;
  }, 60_000, `${label} 托管组合起来`);
  log('local.combo-up', { label, pid: child.pid, docPort, assetPort, admin: listen.admin, loopbackTrust: listen.loopbackTrust, announced: listen.asset?.announced });
  return { child, doc: `http://127.0.0.1:${docPort}`, listen, stop: () => killTree(child) };
}

/** 跑另一个探针，原样转出它的输出，回最后一行 JSON 与退出码 */
function runProbe(script, args) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.PROMPTCUT_CLUSTER_TOKEN; // 本机替身的令牌在各自数据目录的 secrets/ 里，经 --data-dir 读
    const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'probes', script), ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true, env });
    let buf = '';
    child.stdout.on('data', (c) => { buf += c.toString(); process.stdout.write(c); });
    child.on('exit', (code) => {
      const last = buf.trim().split('\n').pop();
      let result = null;
      try { result = JSON.parse(last); } catch { /* 没有结果行 */ }
      resolve({ code, result });
    });
  });
}

/** 目录里的文件数与总字节数（对应远端的 `find -type f | wc -l` 与 `du -sb`） */
function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) { files += 1; bytes += fs.statSync(p).size; }
    }
  };
  walk(dir);
  return { files, bytes };
}

/**
 * `--tamper`（只用来证明探针不是空转）：拷完之后在目标的数据目录里删掉一个快照块、改坏另一个快照块的一个字节。
 * 这时核对与客户端都应当失败（库存对不上、取回的 sha256 不符、那两段要重新渲染）。
 */
function tamper(dataDir) {
  const files = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.isFile()) files.push(p); } };
  walk(path.join(dataDir, 'assets', 'snap'));
  const blobs = files.filter((p) => /[0-9a-f]{64}/.test(path.basename(p))).sort();
  if (blobs.length < 2) return { error: '快照块不足两个', blobs: blobs.length };
  fs.rmSync(blobs[0]);
  const buf = fs.readFileSync(blobs[1]);
  buf[0] ^= 0xff;
  fs.writeFileSync(blobs[1], buf);
  log('local.tampered', { removed: path.basename(blobs[0]), corrupted: path.basename(blobs[1]) });
  return { removed: path.basename(blobs[0]), corrupted: path.basename(blobs[1]) };
}

async function stepLocal() {
  const srcPort = intArg('--src-port', 5760, 1);
  const dstPort = intArg('--dst-port', 5762, 1);
  const keepTmp = has('--keep');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'm8-migrate-local-'));
  const srcData = path.join(work, 'hosted');
  const dstData = path.join(work, 'drill');
  const seedFile = path.join(work, 'seed.json');
  const invFile = path.join(work, 'inventory.json');
  const out = { step: 'local', work, source: null, target: null, seed: null, inventory: null, copy: null, check: null, client: null, timeline: [] };
  const mark = (what) => { out.timeline.push({ what, at: new Date().toISOString(), ms: Date.now() - started }); log('local.mark', { what }); };
  let src = null;
  let dst = null;
  try {
    // 源：数据目录与集群令牌（令牌随数据目录走，hosting-migration.md 第 1 节）
    fs.mkdirSync(path.join(srcData, 'secrets'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(srcData, 'secrets', 'cluster-token'), `${newToken()}\n`, { mode: 0o600 });
    src = await startCombo('source', { dataDir: srcData, docPort: srcPort, assetPort: srcPort + 1 });
    out.source = src.doc;
    mark('源起来');

    // 0. 种子（有素材、有已就绪的层）
    out.seed = await stepSeed({ hosted: src.doc, seedFile });
    mark('种子');
    if (!out.seed.seed) return out;

    // 1. 库存（停写之前）
    const inv = await runProbe('shared-project-probe.mjs', ['--role', 'inventory', '--hosted', src.doc, '--data-dir', srcData, '--seed', seedFile, '--scan-dir', srcData, '--out', invFile]);
    out.inventory = inv.result ? { ok: inv.result.ok, summary: inv.result.summary, fails: inv.result.fails } : { code: inv.code };
    if (!check(inv.code === 0 && inv.result?.ok, 'local：源上的库存')) return out;
    mark('库存');

    // 3. 停写
    await src.stop();
    src = null;
    mark('源停写');

    // 4. 拷数据目录（本机替身用 fs.cpSync；远端是 rsync -a），核两边文件数与总字节数
    const t0 = Date.now();
    fs.cpSync(srcData, dstData, { recursive: true, preserveTimestamps: true });
    const a = dirStats(srcData);
    const b = dirStats(dstData);
    out.copy = { ms: Date.now() - t0, source: a, target: b };
    check(a.files === b.files && a.bytes === b.bytes, 'local：两边文件数与总字节数一致', out.copy);
    if (has('--tamper')) out.tampered = tamper(dstData);
    mark('拷数据');

    // 5 + 6. 目标起来（公网地址换成目标的；令牌是拷过来的那一份）
    dst = await startCombo('target', { dataDir: dstData, docPort: dstPort, assetPort: dstPort + 1 });
    out.target = dst.doc;
    mark('目标起来');

    // 6 + 7. 按库存核对
    const chk = await runProbe('shared-project-probe.mjs', ['--role', 'migrate-check', '--from-inventory', invFile, '--to', dst.doc, '--data-dir', dstData, '--seed', seedFile, '--scan-dir', dstData, '--sample', 'all']);
    out.check = chk.result ? { ok: chk.result.ok, revs: chk.result.revs, assets: chk.result.assets, sample: chk.result.sample, seeded: chk.result.seeded, readyLayers: chk.result.readyLayers, assetUrls: chk.result.assetUrls, registeredAssetTo: chk.result.registeredAssetTo, fails: chk.result.fails } : { code: chk.code };
    check(chk.code === 0 && chk.result?.ok, 'local：migrate-check --from-inventory 全过');
    mark('核对');

    // 8 + 9. 客户端
    out.client = await stepClient({ hosted: dst.doc, seedFile, inventoryFile: invFile, oldHosted: out.source, ui: has('--ui'), edit: true });
    mark('客户端');
    return out;
  } finally {
    if (src) await src.stop();
    if (dst) await dst.stop();
    if (!keepTmp) { try { fs.rmSync(work, { recursive: true, force: true }); } catch { /* 句柄还没放 */ } } else log('local.kept', { work });
  }
}

/* ================================================================== 主流程 */

let result;
if (STEP === 'seed') result = await stepSeed();
else if (STEP === 'client') result = await stepClient();
else if (STEP === 'local') result = await stepLocal();
else if (STEP === 'remote-plan') {
  const lines = remotePlan({ host: arg('--public-host', '203.0.113.16'), tunnelBase: intArg('--tunnel-base', 18700, 1024), stamp: arg('--stamp', new Date().toISOString().slice(0, 10).replace(/-/g, '')) });
  console.log(lines.join('\n'));
  result = { step: 'remote-plan', lines: lines.length };
} else usage(argv.length ? '参数不对' : undefined);
finish(result);
