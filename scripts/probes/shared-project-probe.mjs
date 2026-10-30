/**
 * 共享项目接入的探针（SP，契约 `docs/plan/shared-project-contract.md` 第 6 节、第 7 节 SP1 / SP7）。
 * 结果最后一行打一行 JSON；`ok` 为假时退出码 1，连不上或参数不对退出码 2。只用 Node 内置模块与仓库里的服务端模块。
 *
 * `--mode internet` 的 creator / member、`--role migrate-check`、`--role coord` 在本文件；`--mode lan` 的全部逻辑在
 * `shared-project-lan.mjs`（本文件只分派，用法见那个文件头）。互联网模式新建走 `server/auth/route.mjs` 的
 * `createSharedProject({ where: 'hosted' })`。协调口是 `probe-coord.mjs`，与 `render-host-probe.mjs` 跨机模式同一个形状
 * （同一个口可以同时给两个探针用）。
 *
 * ## --mode internet --role creator --hosted <url>
 *
 *   node scripts/probes/shared-project-probe.mjs --mode internet --role creator --hosted http://127.0.0.1:8790
 *        (--coord-port 8799 [--coord-host 127.0.0.1] | --coord <url>) [--name <项目名>] [--tasks 6] [--task-ms 600]
 *        [--creator-delay-ms 1000] [--media-kb 256] [--timeout-ms 180000]
 *
 *   1. 在托管端建一个自由进入的共享项目（`POST shared/create`，口令随机生成）；
 *   2. 以创建者身份（`as: 'creator'`，`role: 'render'`，节点 profile `pc`）连文档服务：从 `service.endpoints` 拿素材服务地址，
 *      经 `auth.ticket` 取素材票据；把一份项目快照（`project.announce` + `project.snapshot.put`）、一条内容库条目、
 *      一个素材（`media`，带票据分片上传）传上去；
 *   3. 写出成员配置交给协调口（`member-config`），等成员报「起来了」（`member-ready`）；
 *   4. 以本机 PC 节点身份（节点自己就是发布方）发布 `--tasks` 个细任务（与 `render-queue-e2e.mjs` 相同的假细任务：
 *      kind snapshot、tier shared；真正的 plan 切分要编辑器，这里不跑），自己的节点晚 `--creator-delay-ms` 才开始认领，
 *      保证成员先认领到；产物（每段一个小文件）带票据写进 `px`；等全部 `task.done`；
 *   5. 写 `creator-done`，等成员的结果（`member-result`），一起输出。
 *
 * ## --mode internet --role member --hosted <url> --coord <url>
 *
 *   node scripts/probes/shared-project-probe.mjs --mode internet --role member --hosted http://127.0.0.1:8790 --coord http://127.0.0.1:8799
 *        [--expect-tasks 1] [--task-ms 600] [--max-concurrent 2] [--timeout-ms 180000] [--assert-no-lan <PC 局域网地址>]
 *
 *   `--assert-no-lan`（M8「异地接入」，`m8-plan.md` 第 2.3 节）：从拿到配置到收尾，每 2 s 只读地跑一次 `netstat -an`，
 *   数本机到这个地址的 TCP 连接：开始时先记一次基线（上一项留下的 TIME_WAIT 等），之后新出现的不论状态都算，要全程 0；收尾前做一次 3 s 的局域网发现（要 0 条）。两项分开判，结果行 `noLan`。
 *   不改防火墙、代理、路由（约束「不动宿主机的网络」），公共件 `scripts/probes/m8/no-lan.mjs`。
 *
 *   不设集群令牌（设了就判失败），只凭协调口给的项目凭证进入（`role: 'render'`，节点 profile `host`）：
 *   从 `service.endpoints` 拿素材服务地址；读项目快照（逐片取回、核摘要）、内容库条目、带票据读素材
 *   （Bearer 与查询串只读票据各一次，Range）；不带票据读一次（回环被当自己人时记 `loopbackTrusted`，不判）；
 *   认领并完成至少 `--expect-tasks` 个任务（产物带 rw 票据写进 `px`）。`--expect-tasks 0` 只验进入与读取（迁移后抽查用）。
 *   `--hosted` 覆盖成员配置里的文档服务地址（迁移后连新地址）。
 *
 * ## --role coord --port <n> [--host 127.0.0.1]
 *
 *   单独起协调口（creator 用 `--coord <url>` 指过来）。形状见 `probe-coord.mjs`：`PUT /kv/<键>`（JSON）、
 *   `GET /kv/<键>?wait=<毫秒>`（没有就等，等不到 404）。`render-host-probe.mjs` 跨机模式的协调口也答这两条，
 *   所以也可以直接用它的口（`--coord http://<creator IP>:5409`）。键：`member-config`、`member-ready`、`creator-done`、
 *   `member-result`（互联网模式），`lan-member`、`lan-member-result`（局域网模式）。
 *   成员配置里有项目口令（探针自建的一次性项目），协调口只该绑在可信的网段上。
 *
 * ## --role migrate-check --from <url> --to <url>
 *
 *   node scripts/probes/shared-project-probe.mjs --role migrate-check --from http://127.0.0.1:8790 --to http://127.0.0.1:8794
 *        [--from-asset <url>] [--to-asset <url>] [--sample 100]
 *
 *   `--from` / `--to` 是两份托管组合的文档服务 http 地址（契约第 11 节裁定；ws 也收）。素材服务地址不给时从各自的
 *   `service.endpoints` 取（顺带核对新实例已向文档服务登记了自己的地址）。项目数经管理接口（`GET /admin/inventory`、
 *   `/admin/blob/<ns>/<hash>`）列出，带集群令牌（管理用途）：先取环境变量 `PROMPTCUT_CLUSTER_TOKEN`，没有再读
 *   `<数据目录>/secrets/cluster-token`（数据目录取 `--data-dir`，否则环境变量 `PROMPTCUT_DATA_DIR`）；都没有时只能在
 *   服务器本机回环上跑。输出的 `admin` 是 `token` 或 `loopback`，`tokenFrom` 是 `env` / `file` / null。逐项核对（`hosting-migration.md` 第 6、7 步）：
 *   两边 `/healthz`；共享项目数与各项目的名字、模式；每个空间里每个项目的 `projectRev`、项目快照数、内容库条目数；
 *   三个命名空间的哈希集合与字节数；再从新实例按哈希抽取至多 `--sample` 个（缺省 100，不足就全部；`all` 全部），
 *   经管理接口取回、重算 sha256，相符比例必须 100%。`projectRev` 另分「相等 / 归零 / 落后 / 超前」计数（输出 `revs`）。
 *   全部通过才 `ok: true`。
 *
 *   `--from-inventory <库存文件>` 代替 `--from`（M8，`m8-plan.md` 第 2.5 节第 6、7 步）：旧实例已停写、不在线，
 *   旧的一边读 `--role inventory` 写下的文件；比法同上。另可给：
 *   - `--seed <种子文件>`（`m8-migrate-probe.mjs --step seed` 写的，含探针自建项目的口令）：以创建者身份进新实例上的
 *     每个种子项目，核 `projectRev` 与摘要和库存一致、两类清单（`snapshot-manifest` / `render-manifest`，含层表
 *     `layers:<项目 id>`）的键与哈希一致，清单引用的每个块经**数据面**（新实例登记的素材地址、带只读票据）取回、
 *     重算 sha256 全部相符；
 *   - `--scan-dir <新实例的数据目录>`：库存里带 `readyLayers`（盘点时给了 `--scan-dir`）时，逐空间逐键比就绪层；
 *   - `--to-asset <url>`：管理接口改走这个源（阿里云上经 SSH 转发的回环端口，令牌不上公网）。
 *
 * ## --role inventory --hosted <url> --out <库存文件>
 *
 *   node scripts/probes/shared-project-probe.mjs --role inventory --hosted http://127.0.0.1:8790 --out inv.json
 *        [--asset <url>] [--seed <种子文件>] [--scan-dir <数据目录>] [--data-dir <目录>]
 *
 *   迁移前的库存（`hosting-migration.md` 第 6 步「停写前记下的」）：两个 `/healthz`、`service.endpoints` 里登记的素材地址、
 *   管理盘点 `GET /admin/inventory` 原样（共享项目、各空间各项目的 `projectRev`、快照数、内容库条目数、三个命名空间的
 *   哈希清单与字节数）。给了 `--seed`：种子项目的 `projectRev`、摘要、两类清单的键与哈希，并经数据面把清单引用的块
 *   全部取回核一遍（源上本来就得是好的）。给了 `--scan-dir`：只读扫数据目录里各空间的就绪层（两类清单每个键最后一条的哈希），
 *   能覆盖探针进不去的项目（例如编辑器建的项目）；只给 `--scan-dir` 不给 `--hosted` 也行（停写后在服务器上扫）。
 *   令牌、口令不写进库存文件；有失败时不写文件。
 *
 * ## 传输（creator、member）
 *
 *   到文档服务的连接是一个会话（`server/render-node/session-link.mjs` 的 `createDocEndpoint`，HT-a）。`--transport auto|ws`
 *   是开发者强制参数：缺省自动（先读环境变量 `PROMPTCUT_TRANSPORT`，再缺省自动；HT-a 的自动就是 WebSocket），`ws`
 *   只走 WebSocket，`http` 在 HT-a 未启用（退出码 2）。成员配置里没有传输字段。输出的 `session` 记实际用的传输、
 *   接续次数、是否对着没有会话层的旧服务端。
 *
 * 凭证（口令、K、票据）不打到输出里。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { startCoordServer, coordClient } from './probe-coord.mjs';
import { startNoLanWatch } from './m8/no-lan.mjs';

const USAGE = `用法：
  node scripts/probes/shared-project-probe.mjs --mode internet --role creator --hosted <url> (--coord-port <n> | --coord <url>) [--tasks 6] [--transport auto|ws]
  node scripts/probes/shared-project-probe.mjs --mode internet --role member --hosted <url> --coord <url> [--expect-tasks 1] [--transport auto|ws] [--assert-no-lan <PC 局域网地址>]
  node scripts/probes/shared-project-probe.mjs --role coord --port <n> [--host 127.0.0.1]
  node scripts/probes/shared-project-probe.mjs --role inventory --hosted <url> [--asset <url>] [--seed <种子文件>] [--scan-dir <数据目录>] --out <库存文件> [--data-dir <目录>]
  node scripts/probes/shared-project-probe.mjs --role migrate-check (--from <url> | --from-inventory <库存文件>) --to <url> [--to-asset <url>] [--seed <种子文件>] [--scan-dir <新数据目录>] [--data-dir <目录>] [--sample 100|all]
  node scripts/probes/shared-project-probe.mjs --mode lan --role creator|member ...（见 shared-project-lan.mjs）`;

const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const intArg = (name, fallback, min = 0) => {
  const raw = arg(name, undefined);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) usage(`${name} 要是不小于 ${min} 的整数`);
  return n;
};
function usage(msg) {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

const ROLE = arg('--role', null);
const MODE = arg('--mode', null);
const TIMEOUT_MS = intArg('--timeout-ms', 180_000, 1000);
const started = Date.now();
const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;

const here = new URL('.', import.meta.url);
const mod = (rel) => import(new URL(`../../${rel}`, here));

const log = (event, fields = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

const fails = [];
const check = (cond, label, extra) => {
  if (!cond) fails.push(label + (extra === undefined ? '' : ` :: ${JSON.stringify(extra).slice(0, 400)}`));
  return !!cond;
};

/* ------------------------------------------------------------------ 共用小件 */

/** 文档服务地址 → { http, ws }（`http://h:p` ↔ `ws://h:p`，路径保留） */
function docUrls(url) {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, '');
  if (u.protocol === 'ws:' || u.protocol === 'http:') return { http: `http://${u.host}${path}`, ws: `ws://${u.host}${path}` };
  if (u.protocol === 'wss:' || u.protocol === 'https:') return { http: `https://${u.host}${path}`, ws: `wss://${u.host}${path}` };
  throw new Error(`不认识的地址：${url}`);
}

async function getJson(url, { headers = {}, timeoutMs = 15_000 } = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

/** 一条 WebSocket 端点上的请求 / 回包：按 reqId 配对；`until` 给了就收集到它为真的那条为止 */
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
    const reqId = `sp-${++seq}-${randomBytes(3).toString('hex')}`;
    const timer = setTimeout(() => {
      waiting.delete(reqId);
      reject(new Error(`等 ${message.type} 的回包超时`));
    }, timeoutMs);
    waiting.set(reqId, { resolve, until, got: [], timer });
    if (!ep.send({ ...message, reqId })) {
      waiting.delete(reqId);
      clearTimeout(timer);
      reject(new Error(`${message.type} 没发出去（连接不在）`));
    }
  });
}

/**
 * `--transport`（开发者强制，契约 `docs/plan/http-transport-contract.md` 第 4.3 节第 6 条）：不给就不传，由
 * `createDocEndpoint` 读 `PROMPTCUT_TRANSPORT`，再缺省自动；给了就照它（`ws` 只走 WebSocket；`http` 在 HT-a
 * 未启用，按参数不对退出 2）。
 */
function transportOption(transportOf) {
  const raw = arg('--transport', undefined);
  if (raw === undefined) return {};
  try {
    return { transport: transportOf(raw, undefined) };
  } catch (err) {
    usage(`--transport ${raw}：${err?.message ?? err}`);
    return {};
  }
}

/** 输出里的会话诊断：实际用的传输、接续次数、是否对着没有会话层的旧服务端（不含会话号） */
function sessionOf(ep) {
  if (!ep || typeof ep.stats !== 'function') return null;
  const s = ep.stats();
  return { mode: s.mode ?? null, transport: s.transport ?? null, resumes: s.resumes ?? 0, fallbacks: s.fallbacks ?? 0, legacy: s.legacy === true, opens: s.opens ?? 0 };
}

function waitOpen(ep, ms = 15_000) {
  return new Promise((resolve) => {
    if (ep.connected) return resolve(true);
    const t = setTimeout(() => resolve(false), ms);
    ep.onOpen(() => { clearTimeout(t); resolve(true); });
  });
}

/** 从 `service.endpoints` 取第一个素材服务地址 */
function waitAssetUrl(ep, watchServiceEndpoints, ms = 10_000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { stop(); resolve(null); }, ms);
    const stop = watchServiceEndpoints(ep, ['asset'], (list) => {
      const url = list.find((e) => e.kind === 'asset' && Array.isArray(e.urls) && e.urls.length)?.urls[0];
      if (url) { clearTimeout(t); stop(); resolve(url); }
    });
  });
}

/** 关掉连接，等 onClose 最多 3 s（Windows 上关闭握手没完成就退出会崩，同 render-queue-e2e） */
async function closeAll(eps) {
  const waits = [];
  for (const ep of eps) {
    if (ep.connected) waits.push(new Promise((resolve) => ep.onClose(resolve)));
    try { ep.close(); } catch { /* 已关 */ }
  }
  await Promise.race([Promise.all(waits), new Promise((resolve) => setTimeout(resolve, 3000).unref())]);
}

/**
 * 打结果行、定退出码，然后让进程自然退出（不调 process.exit）：连接、协调口都已关，剩下的只有 fetch 的空闲长连接，
 * 到点自己关。Windows 上有句柄还在关闭中就 process.exit，libuv 会断言崩掉（退出码 0xC0000409 = 3221226505，
 * 同 render-queue-e2e.mjs 的注释）。万一 10 s 后还有东西挂着，才强制退出。
 */
function finish(result, code) {
  result.fails = fails;
  result.ms = Date.now() - started;
  if (code === undefined) code = fails.length === 0 ? 0 : 1;
  result.ok = code === 0;
  process.exitCode = code;
  process.stdout.write(`${JSON.stringify(result)}\n`);
  setTimeout(() => process.exit(code), 10_000).unref();
}

/* ------------------------------------------------------------------ 渲染节点的小件 */

/** 假细任务（与 `render-queue-e2e.mjs` 用的相同形状，契约 A.4） */
function fineTask({ resultKey, from, to, projectId, projectRev }) {
  return {
    id: `snapshot:${resultKey}:${from}-${to}`,
    kind: 'snapshot',
    tier: 'shared',
    resultKey,
    range: { unit: 'localFrame', from, to },
    source: { projectId, projectRev },
    input: {},
    weight: { class: 'light', estMs: null, frames: to - from + 1 },
    requires: {},
    priority: 0,
  };
}

/** 睡 taskMs 的执行器 */
function sleepExecutor(taskMs) {
  return {
    plan: async () => { throw Object.assign(new Error('探针不算计划'), { retryable: false }); },
    render(task, { signal }) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve({ frames: task.range.to - task.range.from + 1 }), taskMs);
        signal?.addEventListener('abort', () => { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
      });
    },
  };
}

/** 每段一个小产物：内容由结果键与范围决定（按内容寻址，同一段再推一次是同一个哈希） */
const artifactBytes = (resultKey, range) => Buffer.from(`promptcut-sp-probe-artifact\n${resultKey}\n${range.from}-${range.to}\n`, 'utf8');

/** 产物库：带票据推进素材服务的 `px` 命名空间 */
function assetSink(client, counters) {
  return {
    async has({ resultKey, range }) {
      return client.has('px', sha256(artifactBytes(resultKey, range)));
    },
    async put({ resultKey, range }) {
      const bytes = artifactBytes(resultKey, range);
      const r = await client.put('px', bytes, {});
      counters.artifactsWritten += 1;
      return { complete: true, result: { px: [r.hash ?? sha256(bytes)] } };
    },
  };
}

/* ================================================================== creator */

async function runCreator() {
  const hosted = arg('--hosted', null);
  if (!hosted) usage('缺 --hosted');
  const coordPort = arg('--coord-port', null);
  const coordArg = arg('--coord', null);
  if (!coordPort && !coordArg) usage('要 --coord-port（本进程起协调口）或 --coord（已有的协调口）');
  const taskCount = intArg('--tasks', 6, 1);
  const taskMs = intArg('--task-ms', 600, 0);
  const creatorDelayMs = intArg('--creator-delay-ms', 1000, 0);
  const mediaKb = intArg('--media-kb', 256, 1);
  const name = arg('--name', `sp-probe-${runId}`);
  const urls = docUrls(hosted);
  const deadline = started + TIMEOUT_MS;

  const [{ createSharedProject }, { buildAuthProtocols }, { createDocEndpoint, transportOf }, { watchServiceEndpoints }, { createLocalNode }, { createTicketSource }, { createAssetClient }] = await Promise.all([
    mod('server/auth/route.mjs'), mod('server/auth/client.mjs'), mod('server/render-node/session-link.mjs'), mod('server/render-node/endpoint.mjs'),
    mod('server/render-node/local-node.mjs'), mod('server/auth/ticket-source.mjs'), mod('server/asset-store/client.mjs'),
  ]);

  const result = {
    ok: false, mode: 'internet', role: 'creator', hosted: urls.http, runId, name, projectId: null, assetUrl: null,
    snapshot: null, content: null, media: null,
    tasks: { published: 0, completed: 0, duplicateDone: 0, byCreatorNode: 0 }, artifactsWritten: 0, member: null, coord: null,
  };
  const eps = [];
  let coordServer = null;
  const done = async (code) => {
    result.session = sessionOf(eps[0]);
    await closeAll(eps);
    await coordServer?.close();
    finish(result, code);
  };

  // 协调口
  let coordUrl = coordArg;
  if (coordPort) {
    const host = arg('--coord-host', '127.0.0.1');
    try {
      coordServer = await startCoordServer({ port: Number(coordPort), host });
    } catch (err) {
      fails.push(`起协调口失败：${err?.code ?? err?.message}`);
      return done(2);
    }
    coordUrl = coordServer.url;
  }
  result.coord = coordUrl;
  const coord = coordClient(coordUrl);

  // 1. 建项目
  const creator = { username: 'creator', password: randomBytes(12).toString('base64url') };
  const projectPassword = randomBytes(12).toString('base64url');
  let created;
  try {
    created = await createSharedProject({ where: 'hosted', hostedUrl: urls.http, name, mode: 'free', creator, password: projectPassword });
  } catch (err) {
    fails.push(`建项目失败：${err?.status ?? ''} ${err?.reason ?? err?.message}`);
    return done(err?.status ? 1 : 2);
  }
  result.projectId = created.projectId;
  log('creator.created', { projectId: created.projectId, name });

  // 2. 以创建者身份连上
  const deviceId = `probe-creator-${randomBytes(6).toString('hex')}`;
  let key = null;
  const protocols = () => buildAuthProtocols({
    base: urls.http, projectId: created.projectId, username: creator.username, deviceId, deviceName: 'sp-probe-creator', as: 'creator',
    ...(key ? { key } : { password: creator.password }), role: 'render', onKey: (k) => { key = k; },
  });
  const ep = createDocEndpoint({ url: urls.ws, protocols, ...transportOption(transportOf), log: (event, fields) => log(`creator.${event}`, fields) });
  eps.push(ep);
  const rpc = rpcOn(ep);
  if (!check(await waitOpen(ep), '创建者连上文档服务')) return done(2);

  const assetUrl = await waitAssetUrl(ep, watchServiceEndpoints);
  result.assetUrl = assetUrl;
  if (!check(assetUrl, '从 service.endpoints 拿到素材服务地址')) return done();
  const ticket = createTicketSource(ep, { access: 'rw' });
  const client = createAssetClient({ base: assetUrl, ticket });

  // 项目快照
  const localProjectId = 'sp-probe-project';
  const snapshotText = JSON.stringify({ id: localProjectId, name, runId, tracks: [], fps: 30, duration: 3, note: 'shared-project-probe' });
  const digest = sha256(snapshotText);
  try {
    const ann = await rpc({ type: 'project.announce', projectId: localProjectId, digest });
    check(ann.type === 'project.announced', 'project.announce', ann);
    const projectRev = ann.projectRev;
    const put = await rpc({ type: 'project.snapshot.put', projectId: localProjectId, projectRev, digest, index: 0, count: 1, data: snapshotText });
    check(put.type === 'project.snapshot.stored' && put.complete === true, '项目快照存好', put);
    result.snapshot = { projectId: localProjectId, projectRev, digest, bytes: Buffer.byteLength(snapshotText) };
  } catch (err) {
    fails.push(`项目快照：${err.message}`);
  }
  // 内容库条目
  const contentKey = `sp-probe/${runId}`;
  const contentBody = { runId, note: 'shared-project-probe', at: Date.now() };
  try {
    const st = await rpc({ type: 'content.put', kind: 'snapshot-manifest', key: contentKey, body: contentBody });
    check(st.type === 'content.stored', 'content.put', st);
    result.content = { kind: 'snapshot-manifest', key: contentKey, hash: st.hash ?? null };
  } catch (err) {
    fails.push(`内容库：${err.message}`);
  }
  // 素材
  const media = randomBytes(mediaKb * 1024);
  try {
    const r = await client.put('media', media, { ext: 'bin' });
    const hash = sha256(media);
    check((r.hash ?? hash) === hash, '素材上传回的哈希对得上', r);
    result.media = { hash, bytes: media.length };
  } catch (err) {
    fails.push(`素材上传：${err.message}`);
  }
  if (fails.length) return done();

  // 3. 成员配置交给协调口
  const memberConfig = {
    url: urls.ws, projectId: created.projectId, username: `member-${randomBytes(3).toString('hex')}`, password: projectPassword,
    as: 'member', role: 'render', deviceId: `probe-member-${randomBytes(6).toString('hex')}`, deviceName: 'sp-probe-member',
  };
  await coord.put('member-config', {
    config: memberConfig,
    expect: { snapshot: result.snapshot, content: { kind: 'snapshot-manifest', key: contentKey, bodyHash: sha256(JSON.stringify(contentBody)) }, media: result.media },
    runId,
  });
  log('creator.member-config', { coord: coordUrl });
  const ready = await coord.take('member-ready', deadline);
  if (!check(ready, '等到成员报 member-ready')) return done();

  // 4. 本机 PC 节点：发布细任务，晚一点才自己认领
  const counters = { artifactsWritten: 0 };
  const nodeId = `sp-probe-pc-${runId}`;
  const claimAt = { at: Infinity };
  const node = createLocalNode({
    nodeId,
    node: { profile: 'pc', envFingerprint: 'sp-probe-env', codeVersions: [], capabilities: {} },
    endpoint: ep,
    now: Date.now,
    maxConcurrent: 1,
    isIdle: () => Date.now() >= claimAt.at,
    executor: sleepExecutor(taskMs),
    sink: assetSink(client, counters),
    onEvent: (e) => {
      if (e.type === 'completed' || e.type === 'dedup') result.tasks.byCreatorNode += 1;
      if (e.type === 'failed') fails.push(`创建者节点 ${e.id} 失败：${e.error}`);
    },
  });
  const tasks = Array.from({ length: taskCount }, (_, i) => fineTask({
    resultKey: `${localProjectId}@${result.snapshot.projectRev}`, from: i * 30, to: i * 30 + 29, projectId: localProjectId, projectRev: result.snapshot.projectRev,
  }));
  const ids = new Set(tasks.map((t) => t.id));
  const doneIds = new Set();
  const allDone = new Promise((resolve) => {
    ep.onMessage((m) => {
      if (m?.type === 'task.done' && ids.has(m.id)) {
        if (doneIds.has(m.id)) result.tasks.duplicateDone += 1;
        doneIds.add(m.id);
        result.tasks.completed = doneIds.size;
        if (doneIds.size === ids.size) resolve(true);
      } else if (m?.type === 'task.failed' && ids.has(m.id)) {
        fails.push(`task.failed ${m.id}: ${m.error}`);
      }
    });
  });
  node.start();
  const timer = setInterval(() => { try { node.tick(); } catch (err) { log('creator.tick-error', { message: String(err?.message ?? err) }); } }, 50);
  const pub = await rpc({ type: 'task.publish', tasks }).catch((err) => ({ type: 'error', detail: err.message }));
  check(pub.type === 'task.published' && (pub.results ?? []).every((r) => !r.error), 'task.publish', pub);
  result.tasks.published = tasks.length;
  claimAt.at = Date.now() + creatorDelayMs;
  const finished = await Promise.race([allDone, sleep(Math.max(1, deadline - Date.now())).then(() => false)]);
  clearInterval(timer);
  node.stop();
  check(finished, `全部 task.done（${doneIds.size}/${tasks.length}）`);
  check(result.tasks.duplicateDone === 0, '没有重复的 task.done', result.tasks.duplicateDone);
  result.artifactsWritten = counters.artifactsWritten;

  // 5. 收尾：通知成员，等它的结果
  await coord.put('creator-done', { completed: doneIds.size, published: tasks.length });
  const memberResult = await coord.take('member-result', Math.min(deadline, Date.now() + 60_000));
  result.member = memberResult;
  check(memberResult?.ok === true, '成员结果 ok', memberResult?.fails);
  return done();
}

/* ================================================================== member */

async function runMember() {
  const coordUrl = arg('--coord', null);
  if (!coordUrl) usage('缺 --coord');
  const expectTasks = intArg('--expect-tasks', 1, 0);
  const taskMs = intArg('--task-ms', 600, 0);
  const maxConcurrent = intArg('--max-concurrent', 2, 1);
  const deadline = started + TIMEOUT_MS;
  const coord = coordClient(coordUrl);

  const [{ normalizeEntry, sharedProtocols }, { createDocEndpoint, transportOf }, { watchServiceEndpoints }, { createLocalNode }, { createTicketSource }, { createAssetClient }] = await Promise.all([
    mod('server/auth/shared-config.mjs'), mod('server/render-node/session-link.mjs'), mod('server/render-node/endpoint.mjs'),
    mod('server/render-node/local-node.mjs'), mod('server/auth/ticket-source.mjs'), mod('server/asset-store/client.mjs'),
  ]);

  const result = {
    ok: false, mode: 'internet', role: 'member', hosted: null, projectId: null, clusterToken: process.env.PROMPTCUT_CLUSTER_TOKEN ? 'set' : 'unset',
    enter: null, assetUrl: null, snapshot: null, content: null, media: null, ticket: null,
    claims: 0, taskDone: 0, artifactsWritten: 0, expectTasks,
  };
  const eps = [];
  const done = async (code) => {
    result.session = sessionOf(eps[0]);
    await closeAll(eps);
    if (expectTasks > 0) {
      try { await coord.put('member-result', { ...result, fails, ok: fails.length === 0 }); } catch { /* 协调口已关 */ }
    }
    finish(result, code);
  };
  check(result.clusterToken === 'unset', '成员不设集群令牌（PROMPTCUT_CLUSTER_TOKEN 应为空）');
  // --assert-no-lan <PC 局域网地址>（m8-plan 第 2.3 节「异地接入」）：全程只读地数本机到这个地址、基线之外的 TCP 连接（不论状态），收尾前做一次 3 s 局域网发现
  const noLanIp = arg('--assert-no-lan', null);
  const noLan = noLanIp ? startNoLanWatch(noLanIp, { log }) : null;

  const handoff = await coord.take('member-config', deadline);
  if (!check(handoff?.config, '从协调口拿到成员配置')) return done(2);
  const raw = { ...handoff.config };
  const hostedArg = arg('--hosted', null);
  if (hostedArg) raw.url = docUrls(hostedArg).ws;
  const entry = normalizeEntry(raw);
  result.hosted = docUrls(entry.url).http;
  result.projectId = entry.projectId;
  const expect = handoff.expect;

  // 进入：只凭项目凭证
  const enterStart = Date.now();
  const ep = createDocEndpoint({ url: entry.url, protocols: sharedProtocols(entry, { role: 'render' }), ...transportOption(transportOf), log: (event, fields) => log(`member.${event}`, fields) });
  eps.push(ep);
  const rpc = rpcOn(ep);
  const opened = await waitOpen(ep);
  result.enter = { ok: opened, ms: Date.now() - enterStart };
  if (!check(opened, '成员凭项目凭证进入')) return done(2);

  const assetUrl = await waitAssetUrl(ep, watchServiceEndpoints);
  result.assetUrl = assetUrl;
  if (!check(assetUrl, '从 service.endpoints 拿到素材服务地址')) return done();

  // 项目快照
  try {
    const got = await rpc({ type: 'project.snapshot.get', projectId: expect.snapshot.projectId, projectRev: expect.snapshot.projectRev }, {
      until: (m) => m.type === 'project.snapshot.end' || m.missing === true,
    });
    const parts = got.filter((m) => m.type === 'project.snapshot.part' && typeof m.data === 'string').sort((a, b) => a.index - b.index);
    const text = parts.map((m) => m.data).join('');
    const ok = !got.some((m) => m.missing) && sha256(text) === expect.snapshot.digest;
    check(ok, '项目快照取回且摘要对得上', { parts: parts.length });
    result.snapshot = { ok, projectRev: expect.snapshot.projectRev, parts: parts.length, bytes: Buffer.byteLength(text) };
  } catch (err) {
    fails.push(`项目快照：${err.message}`);
  }
  // 内容库
  try {
    const item = await rpc({ type: 'content.get', kind: expect.content.kind, key: expect.content.key });
    const ok = item.type === 'content.item' && !item.missing && sha256(JSON.stringify(item.body)) === expect.content.bodyHash;
    check(ok, '内容库条目取回且内容对得上', item.type);
    result.content = { ok };
  } catch (err) {
    fails.push(`内容库：${err.message}`);
  }

  // 票据
  const rwTicket = createTicketSource(ep, { access: 'rw' });
  const rTicket = createTicketSource(ep, { access: 'r' });
  const [rw, r] = [await rwTicket(), await rTicket()];
  result.ticket = { rw: !!rw, r: !!r };
  check(rw && r, '经 auth.ticket 拿到 rw 与 r 两种素材票据');
  const client = createAssetClient({ base: assetUrl, ticket: rwTicket });
  const mediaUrl = `${assetUrl.replace(/\/+$/, '')}/media/${expect.media.hash}`;
  result.media = {};
  try {
    const bytes = await client.get('media', expect.media.hash);
    result.media.bearer = !!bytes && bytes.length === expect.media.bytes && sha256(bytes) === expect.media.hash;
    check(result.media.bearer, 'Bearer 票据读素材，全件 sha256 相符');
  } catch (err) {
    fails.push(`Bearer 读素材：${err.message}`);
  }
  try {
    const res = await fetch(`${mediaUrl}?t=${encodeURIComponent(r ?? '')}`, { headers: { Range: 'bytes=0-99' }, signal: AbortSignal.timeout(15_000) });
    const body = Buffer.from(await res.arrayBuffer());
    result.media.query = res.status === 206 && body.length === 100 && res.headers.get('cache-control') === 'no-store';
    check(result.media.query, '查询串只读票据 Range 读素材 206、no-store', { status: res.status, len: body.length });
  } catch (err) {
    fails.push(`查询串读素材：${err.message}`);
  }
  try {
    const res = await fetch(mediaUrl, { method: 'HEAD', signal: AbortSignal.timeout(15_000) });
    result.media.noTicket = res.status;
    // 本机跑且回环被当自己人时，不带票据也能读，这一项不判（非回环来源才要票据，auth-contract 第 8 节）
    result.media.loopbackTrusted = res.status === 200;
    if (res.status !== 200) check(res.status === 401, '不带票据读素材 401', res.status);
  } catch (err) {
    fails.push(`不带票据读素材：${err.message}`);
  }

  if (expectTasks === 0) return done();

  // 认领并完成任务
  const counters = { artifactsWritten: 0 };
  const node = createLocalNode({
    nodeId: `sp-probe-member-${runId}`,
    node: { profile: 'host', envFingerprint: 'sp-probe-env', codeVersions: [], capabilities: {} },
    endpoint: ep,
    now: Date.now,
    maxConcurrent,
    executor: sleepExecutor(taskMs),
    sink: assetSink(client, counters),
    onEvent: (e) => {
      if (e.type === 'completed' || e.type === 'dedup') result.taskDone += 1;
      if (e.type === 'failed') fails.push(`成员节点 ${e.id} 失败：${e.error}`);
    },
  });
  ep.onMessage((m) => { if (m?.type === 'task.claimed') result.claims += 1; });
  node.start();
  const timer = setInterval(() => { try { node.tick(); } catch (err) { log('member.tick-error', { message: String(err?.message ?? err) }); } }, 50);
  await coord.put('member-ready', { at: Date.now() });
  const creatorDone = await coord.take('creator-done', deadline);
  clearInterval(timer);
  await node.settled().catch(() => {});
  node.stop();
  check(creatorDone, '等到创建者报 creator-done');
  result.artifactsWritten = counters.artifactsWritten;
  check(result.taskDone >= expectTasks, `完成至少 ${expectTasks} 个任务（实际 ${result.taskDone}）`);
  if (noLan) {
    result.noLan = await noLan.stop();
    check(result.noLan.tcpOk, `全程没有新的到 ${noLanIp} 的 TCP 连接（基线之外、不论状态；基线 ${result.noLan.baseline?.length ?? 0} 条，采样 ${result.noLan.samples} 次，最多 ${result.noLan.maxTcp} 条）`);
    check(result.noLan.discoveryOk, `3 s 局域网发现 0 条（实际 ${result.noLan.discovery?.hosts ?? result.noLan.discovery?.error}）`);
  }
  return done();
}

/* ================================================================== inventory / migrate-check */

/**
 * 管理用途的集群令牌（契约第 11 节裁定）：环境变量 `PROMPTCUT_CLUSTER_TOKEN` → `<数据目录>/secrets/cluster-token`
 * （`--data-dir` 或环境变量 `PROMPTCUT_DATA_DIR`）。令牌本身不打到输出里。
 */
function adminToken() {
  const env = (process.env.PROMPTCUT_CLUSTER_TOKEN || '').trim();
  if (env) return { token: env, from: 'env' };
  const dir = arg('--data-dir', null) || process.env.PROMPTCUT_DATA_DIR || null;
  if (dir) {
    try {
      const t = fs.readFileSync(path.join(path.resolve(dir), 'secrets', 'cluster-token'), 'utf8').trim();
      if (t) return { token: t, from: 'file' };
    } catch { /* 没有这个文件 */ }
  }
  return { token: null, from: null };
}

/** 库存文件的格式标记（`--role inventory` 写、`--from-inventory` 读） */
const INVENTORY_KIND = 'promptcut-hosted-inventory';
/** 「已就绪的层」在内容库里的两类：段清单（快照 / 流）与层表（`layers:<项目 id>`，同在 `snapshot-manifest`） */
const READY_KINDS = Object.freeze(['snapshot-manifest', 'render-manifest']);
const HEX64 = /^[0-9a-f]{64}$/;
/** 清单正文里不是块哈希的字段（结果键、内容键、指纹可能也是 64 位十六进制） */
const NOT_BLOB_FIELDS = new Set(['resultKey', 'key', 'contentKey', 'snapshotKey', 'envFingerprint', 'dirKey', 'entryKey', 'digest']);

/** 清单正文引用的块哈希（快照的 frames / small、PNG 缓存、流的 segments / inits 里的 64 位十六进制串），去重、排序 */
function blobHashesOf(body) {
  const out = new Set();
  const walk = (v, field) => {
    if (NOT_BLOB_FIELDS.has(field)) return;
    if (typeof v === 'string') { if (HEX64.test(v)) out.add(v); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, null); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(body, null);
  return [...out].sort();
}

/** `--sample`：`all` 表示全部；否则不小于 1 的整数，缺省 100 */
function sampleArg() {
  const raw = arg('--sample', undefined);
  if (raw === undefined) return 100;
  if (raw === 'all') return Infinity;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) usage('--sample 要是 all 或不小于 1 的整数');
  return n;
}

/**
 * 一份在线的托管组合：`/healthz` 两个、`service.endpoints` 里登记的素材服务地址、管理盘点。
 * `assetArg`（`--asset` / `--to-asset` / `--from-asset`）给了就用它的源调管理接口（阿里云上经 SSH 转发的回环端口），
 * 登记的地址仍从文档服务取（带令牌以管理身份握手；取不到只记 null）。
 */
async function liveSide(label, url, { assetArg, token, headers, eps, createWsEndpoint, watchServiceEndpoints }) {
  const u = docUrls(url);
  const side = { label, doc: u.http, ws: u.ws, registeredAsset: null, adminOrigin: null, healthz: { docservice: 0, asset: 0 }, inv: null };
  let doc;
  try { doc = await getJson(`${u.http}/healthz`); } catch { doc = { status: 0 }; }
  side.healthz.docservice = doc.status;
  check(doc.status === 200 && doc.body?.ok, `${label}：文档服务 /healthz`, doc.status);
  const ep = createWsEndpoint({ url: u.ws, ...(token ? { token } : {}), log: () => {} });
  eps.push(ep);
  if (await waitOpen(ep, 10_000)) side.registeredAsset = await waitAssetUrl(ep, watchServiceEndpoints);
  const adminBase = assetArg || side.registeredAsset;
  if (!check(adminBase, `${label}：拿到素材服务地址（service.endpoints 登记了，或给了 --asset）`)) return side;
  side.adminOrigin = new URL(adminBase).origin;
  let asset;
  try { asset = await getJson(`${side.adminOrigin}/healthz`); } catch { asset = { status: 0 }; }
  side.healthz.asset = asset.status;
  check(asset.status === 200 && asset.body?.ok, `${label}：素材服务 /healthz`, asset.status);
  let inv;
  try { inv = await getJson(`${side.adminOrigin}/admin/inventory`, { headers, timeoutMs: 60_000 }); } catch (err) { inv = { status: 0, error: err.message }; }
  if (check(inv.status === 200 && inv.body?.ok, `${label}：GET /admin/inventory`, inv.status)) side.inv = inv.body;
  return side;
}

/**
 * 读数据目录里各空间的「已就绪的层」（`--scan-dir`，只读）：`docservice/` 与 `docservice/tenants/<id>/` 下
 * `content/*.ndjson` 里 `snapshot-manifest` / `render-manifest` 两类，每个键取最后一条的 `hash`（后写的赢，同内容库回放）。
 * 回 `{ spaces: { <空间>: { <kind>: { <key>: <hash> } } }, count }`。
 */
function scanReadyLayers(dataDir) {
  const root = path.join(path.resolve(dataDir), 'docservice');
  const dirs = [['local', root]];
  let tenants = [];
  try { tenants = fs.readdirSync(path.join(root, 'tenants'), { withFileTypes: true }); } catch { /* 没有租户 */ }
  for (const ent of tenants) if (ent.isDirectory()) dirs.push([ent.name, path.join(root, 'tenants', ent.name)]);
  const spaces = {};
  let count = 0;
  for (const [name, dir] of dirs.sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const kinds = {};
    let files = [];
    try { files = fs.readdirSync(path.join(dir, 'content')).filter((f) => f.endsWith('.ndjson')); } catch { /* 这个空间没有内容库 */ }
    for (const f of files) {
      let text = '';
      try { text = fs.readFileSync(path.join(dir, 'content', f), 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!READY_KINDS.includes(rec?.kind) || typeof rec.key !== 'string' || typeof rec.hash !== 'string') continue;
        (kinds[rec.kind] ??= {})[rec.key] = rec.hash;
      }
    }
    const sorted = {};
    for (const k of Object.keys(kinds).sort()) {
      sorted[k] = Object.fromEntries(Object.keys(kinds[k]).sort().map((key) => [key, kinds[k][key]]));
      count += Object.keys(kinds[k]).length;
    }
    if (Object.keys(sorted).length) spaces[name] = sorted;
  }
  return { spaces, count };
}

/** 读种子文件（`m8-migrate-probe.mjs --step seed` 写的，含探针自建项目的口令；不打印） */
function readSeed(file) {
  const seed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (seed?.kind !== 'promptcut-m8-seed' || !Array.isArray(seed.projects)) throw new Error(`${file} 不是种子文件`);
  return seed;
}

/**
 * 以创建者身份（渲染角色，不改项目）进种子里的每个项目，记下：当前 `projectRev` 与摘要（`project.open`）、
 * 内容库里两类清单的键与哈希（`content.list`）、每条段清单引用的块哈希。`verifyBlobs` 为真时另经数据面
 * （素材服务地址取自这个实例的 `service.endpoints`，带票据）逐个取回、重算 sha256。
 */
async function seededLayers(docUrl, seed, { verifyBlobs = false, eps, labelPrefix }) {
  const [{ buildAuthProtocols }, { createDocEndpoint }, { watchServiceEndpoints }, { createTicketSource }, { createAssetClient }] = await Promise.all([
    mod('server/auth/client.mjs'), mod('server/render-node/session-link.mjs'), mod('server/render-node/endpoint.mjs'),
    mod('server/auth/ticket-source.mjs'), mod('server/asset-store/client.mjs'),
  ]);
  const urls = docUrls(docUrl);
  const out = [];
  for (const p of seed.projects) {
    const label = `${labelPrefix}：种子项目 ${p.name}`;
    const row = { projectId: p.projectId, name: p.name, projectRev: null, digest: null, layers: {}, truncated: false, blobs: 0, assetUrl: null, verified: null };
    out.push(row);
    let key = null;
    const protocols = () => buildAuthProtocols({
      base: urls.http, projectId: p.projectId, username: p.creator.username, deviceId: p.deviceId, deviceName: 'm8-migrate-inventory', as: 'creator',
      ...(key ? { key } : { password: p.creator.password }), role: 'render', onKey: (k) => { key = k; },
    });
    const ep = createDocEndpoint({ url: urls.ws, protocols, log: () => {} });
    eps.push(ep);
    const rpc = rpcOn(ep);
    if (!check(await waitOpen(ep), `${label}：凭创建者口令进入`)) continue;
    try {
      const st = await rpc({ type: 'project.open', projectId: p.projectId }, { until: (m) => m.type === 'project.state' || m.type === 'project.state.end' });
      const head = st.find((m) => m.type === 'project.state');
      row.projectRev = head?.projectRev ?? head?.rev ?? null;
      row.digest = head?.digest ?? null;
      await rpc({ type: 'project.close', projectId: p.projectId }).catch(() => {});
    } catch (err) {
      fails.push(`${label}：project.open ${err.message}`);
    }
    const all = new Map();
    for (const kind of READY_KINDS) {
      try {
        const listing = await rpc({ type: 'content.list', kind });
        if (listing.truncated) row.truncated = true;
        row.layers[kind] = Object.fromEntries((listing.items ?? []).map((it) => [it.key, it.hash]));
      } catch (err) {
        fails.push(`${label}：content.list ${kind} ${err.message}`);
      }
      for (const k of Object.keys(row.layers[kind] ?? {})) {
        try {
          const item = await rpc({ type: 'content.get', kind, key: k });
          for (const h of blobHashesOf(item.body)) all.set(h, k);
        } catch (err) {
          fails.push(`${label}：content.get ${kind} ${k} ${err.message}`);
        }
      }
    }
    check(!row.truncated, `${label}：清单没被截断（不超过 1000 条）`);
    row.blobs = all.size;
    if (!verifyBlobs) continue;
    const assetUrl = await waitAssetUrl(ep, watchServiceEndpoints);
    row.assetUrl = assetUrl;
    if (!check(assetUrl, `${label}：从 service.endpoints 拿到素材服务地址`)) continue;
    const client = createAssetClient({ base: assetUrl, ticket: createTicketSource(ep, { access: 'r' }) });
    let ok = 0;
    const bad = [];
    for (const h of all.keys()) {
      let got = null;
      for (const ns of ['snap', 'px', 'media']) {
        try {
          got = await client.get(ns, h);
        } catch (err) {
          got = null;
          bad.push({ ns, hash: h, error: err.code ?? err.message });
        }
        if (got) break;
      }
      if (got && sha256(got) === h) ok += 1;
      else if (!got && !bad.some((b) => b.hash === h)) bad.push({ hash: h, missing: true });
    }
    row.verified = { total: all.size, ok, ratio: all.size ? ok / all.size : 1, bad: bad.slice(0, 5) };
    check(ok === all.size, `${label}：清单引用的块经数据面带票据全部取回、sha256 相符（${ok}/${all.size}）`, row.verified.bad);
  }
  return out;
}

async function runInventory() {
  const hosted = arg('--hosted', null);
  const outFile = arg('--out', null);
  const scanDir = arg('--scan-dir', null);
  const seedFile = arg('--seed', null);
  if (!outFile) usage('inventory 要 --out <文件>');
  if (!hosted && !scanDir) usage('inventory 要 --hosted <文档服务地址>（在线盘点）或 --scan-dir <数据目录>（只读扫就绪层），或两个都给');
  const { token, from: tokenFrom } = adminToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const [{ createWsEndpoint }, { watchServiceEndpoints }] = await Promise.all([
    mod('server/render-node/ws-transport.mjs'), mod('server/render-node/endpoint.mjs'),
  ]);
  const result = { ok: false, role: 'inventory', out: path.resolve(outFile), admin: token ? 'token' : 'loopback', tokenFrom, source: null, summary: null };
  const eps = [];
  const done = async (code) => { await closeAll(eps); finish(result, code); };
  const file = { v: 1, kind: INVENTORY_KIND, takenAt: new Date().toISOString(), source: null, healthz: null, inventory: null, seeded: null, readyLayers: null };

  if (hosted) {
    const side = await liveSide('源', hosted, { assetArg: arg('--asset', null), token, headers, eps, createWsEndpoint, watchServiceEndpoints });
    file.source = { doc: side.doc, adminOrigin: side.adminOrigin, registeredAsset: side.registeredAsset, via: 'http' };
    file.healthz = side.healthz;
    file.inventory = side.inv;
    result.source = file.source;
    if (side.inv && seedFile) {
      let seed;
      try { seed = readSeed(seedFile); } catch (err) { fails.push(`读种子文件：${err.message}`); }
      if (seed) file.seeded = await seededLayers(hosted, seed, { verifyBlobs: true, eps, labelPrefix: '源' });
    }
  }
  if (scanDir) file.readyLayers = { dataDir: path.resolve(scanDir), ...scanReadyLayers(scanDir) };

  const inv = file.inventory;
  result.summary = {
    sharedProjects: inv?.sharedProjects?.length ?? null,
    spaces: inv ? Object.keys(inv.spaces ?? {}).length : null,
    projects: inv ? Object.values(inv.spaces ?? {}).reduce((n, s) => n + Object.keys(s.projects ?? {}).length, 0) : null,
    assets: inv ? Object.fromEntries(Object.entries(inv.assets ?? {}).map(([ns, a]) => [ns, { count: a.count, bytes: a.bytes }])) : null,
    seeded: file.seeded?.map((s) => ({ projectId: s.projectId, projectRev: s.projectRev, layers: Object.values(s.layers).reduce((n, m) => n + Object.keys(m).length, 0), blobs: s.blobs, verified: s.verified?.ratio ?? null })) ?? null,
    readyLayers: file.readyLayers?.count ?? null,
  };
  if (fails.length === 0) {
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(path.resolve(outFile), `${JSON.stringify(file, null, 1)}\n`);
  } else {
    result.out = null;
  }
  return done();
}

/**
 * 两份盘点逐项比（`hosting-migration.md` 第 6、7 步）：共享项目、各空间 `projectRev` / 快照数 / 内容库条目数、
 * 三个命名空间的哈希集合与字节数。回 `{ projects, revs, all }`，`all` 是新实例上全部 `[ns, hash]`（抽查用）。
 */
function compareInventories(a, b, result) {
  const shared = (inv) => JSON.stringify((inv.sharedProjects ?? []).map((p) => [p.projectId, p.name, p.mode]));
  result.sharedProjects = { from: a.sharedProjects?.length ?? null, to: b.sharedProjects?.length ?? null, equal: shared(a) === shared(b) };
  check(result.sharedProjects.equal, '共享项目（id、名字、模式）一致', result.sharedProjects);
  const spaceNames = [...new Set([...Object.keys(a.spaces ?? {}), ...Object.keys(b.spaces ?? {})])].sort();
  const revMismatch = [];
  const revs = { projects: 0, equal: 0, zeroed: 0, behind: 0, ahead: 0 };
  let contentItems = 0;
  let snapshots = 0;
  for (const s of spaceNames) {
    const x = a.spaces?.[s];
    const y = b.spaces?.[s];
    if (!x || !y) { revMismatch.push({ space: s, missing: !x ? 'from' : 'to' }); continue; }
    for (const pid of new Set([...Object.keys(x.projects), ...Object.keys(y.projects)])) {
      revs.projects += 1;
      const rf = x.projects[pid];
      const rt = y.projects[pid];
      if (rf === rt) { revs.equal += 1; continue; }
      if ((rt ?? 0) === 0 && (rf ?? 0) > 0) revs.zeroed += 1;
      else if ((rt ?? 0) < (rf ?? 0)) revs.behind += 1;
      else revs.ahead += 1;
      revMismatch.push({ space: s, projectId: pid, from: rf ?? null, to: rt ?? null });
    }
    if (x.snapshots !== y.snapshots) revMismatch.push({ space: s, snapshots: [x.snapshots, y.snapshots] });
    if (JSON.stringify(x.content) !== JSON.stringify(y.content)) revMismatch.push({ space: s, content: [x.content, y.content] });
    snapshots += x.snapshots;
    contentItems += Object.values(x.content).reduce((n, v) => n + v, 0);
  }
  result.spaces = { count: spaceNames.length, projects: revs.projects, snapshots, contentItems, mismatches: revMismatch };
  result.revs = revs;
  check(revs.zeroed === 0, 'projectRev 没有归零', revs);
  check(revMismatch.length === 0, '各空间的 projectRev、快照数、内容库条目数一致', revMismatch.slice(0, 5));
  const all = [];
  for (const ns of ['media', 'snap', 'px']) {
    const x = a.assets?.[ns] ?? { count: -1, bytes: -1, hashes: [] };
    const y = b.assets?.[ns] ?? { count: -1, bytes: -1, hashes: [] };
    const equal = x.count === y.count && x.bytes === y.bytes && JSON.stringify(x.hashes) === JSON.stringify(y.hashes);
    result.assets[ns] = { from: x.count, to: y.count, bytes: [x.bytes, y.bytes], equal };
    check(equal, `${ns}：哈希集合与字节数一致`, result.assets[ns]);
    for (const h of y.hashes) all.push([ns, h]);
  }
  return { projects: revs.projects, all };
}

/** 从新实例按哈希取回（管理接口），重算 sha256；均匀取至多 `sample` 个（`Infinity` = 全部） */
async function sampleBlobs(origin, headers, all, sample) {
  const step = all.length <= sample ? 1 : all.length / sample;
  const picked = [];
  for (let i = 0; picked.length < Math.min(sample, all.length); i += 1) picked.push(all[Math.floor(i * step)]);
  let ok = 0;
  let bytes = 0;
  const bad = [];
  for (const [ns, h] of picked) {
    try {
      const res = await fetch(`${origin}/admin/blob/${ns}/${h}`, { headers, signal: AbortSignal.timeout(120_000) });
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status === 200 && sha256(buf) === h) { ok += 1; bytes += buf.length; } else bad.push({ ns, hash: h, status: res.status });
    } catch (err) {
      bad.push({ ns, hash: h, error: err.message });
    }
  }
  return { total: all.length, checked: picked.length, ok, bytes, ratio: picked.length ? ok / picked.length : 1, bad: bad.slice(0, 10) };
}

async function runMigrateCheck() {
  const from = arg('--from', null);
  const inventoryFile = arg('--from-inventory', null);
  const to = arg('--to', null);
  if (!to || (!from && !inventoryFile)) usage('migrate-check 要 --to，以及 --from（两边同时在线）或 --from-inventory（迁移前的库存文件）');
  if (from && inventoryFile) usage('--from 与 --from-inventory 只给一个');
  const sample = sampleArg();
  const { token, from: tokenFrom } = adminToken();
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const [{ createWsEndpoint }, { watchServiceEndpoints }] = await Promise.all([
    mod('server/render-node/ws-transport.mjs'), mod('server/render-node/endpoint.mjs'),
  ]);
  const result = {
    ok: false, role: 'migrate-check', from: null, to: null, fromInventory: inventoryFile ? path.resolve(inventoryFile) : null, inventoryTakenAt: null,
    admin: token ? 'token' : 'loopback', tokenFrom, healthz: {}, assetUrls: {}, sharedProjects: null, spaces: null, revs: null, assets: {}, sample: null,
    registeredAssetTo: null, seeded: null, readyLayers: null,
  };
  const eps = [];
  const done = async (code) => { await closeAll(eps); finish(result, code); };
  const ctx = { token, headers, eps, createWsEndpoint, watchServiceEndpoints };

  // 旧的一边：在线，或读库存文件
  let a = null;
  let file = null;
  if (inventoryFile) {
    try {
      file = JSON.parse(fs.readFileSync(path.resolve(inventoryFile), 'utf8'));
    } catch (err) {
      fails.push(`读库存文件：${err.message}`);
      return done(2);
    }
    if (!check(file?.kind === INVENTORY_KIND && file.inventory?.ok, '库存文件格式对、带在线盘点')) return done(2);
    a = file.inventory;
    result.from = file.source?.doc ?? null;
    result.inventoryTakenAt = file.takenAt ?? null;
    result.healthz.from = file.healthz ?? null;
    result.assetUrls.from = a.assetPublicUrl ?? file.source?.registeredAsset ?? null;
  } else {
    const side = await liveSide('from', from, { assetArg: arg('--from-asset', null), ...ctx });
    result.from = side.doc;
    result.healthz.from = side.healthz;
    result.assetUrls.from = side.inv?.assetPublicUrl ?? side.registeredAsset;
    a = side.inv;
  }
  const toSide = await liveSide('to', to, { assetArg: arg('--to-asset', null), ...ctx });
  result.to = toSide.doc;
  result.healthz.to = toSide.healthz;
  result.assetUrls.to = toSide.inv?.assetPublicUrl ?? toSide.registeredAsset;
  result.registeredAssetTo = toSide.registeredAsset;
  if (!a || !toSide.inv) return done();
  check(result.assetUrls.from !== result.assetUrls.to, '新实例登记的是自己的素材服务地址（与旧的不同）', result.assetUrls);
  if (toSide.registeredAsset) check(toSide.registeredAsset === toSide.inv.assetPublicUrl, '新实例 service.endpoints 里的素材地址就是它配置的公网地址', result.assetUrls);

  const { projects, all } = compareInventories(a, toSide.inv, result);
  result.sample = await sampleBlobs(toSide.adminOrigin, headers, all, sample);
  check(result.sample.bad.length === 0 && result.sample.ok === result.sample.checked, `按哈希取回的全部相符（${result.sample.ok}/${result.sample.checked}）`, result.sample);
  check(all.length > 0 || projects > 0, '有数据可比（空对空不算通过）');

  // 种子项目：进新实例，清单的键与哈希、projectRev 与库存一致；清单引用的块经数据面全部取回
  const seedFile = arg('--seed', null);
  if (seedFile) {
    let seed = null;
    try { seed = readSeed(seedFile); } catch (err) { fails.push(`读种子文件：${err.message}`); }
    if (seed) {
      const now = await seededLayers(to, seed, { verifyBlobs: true, eps, labelPrefix: '新实例' });
      const before = new Map((file?.seeded ?? []).map((s) => [s.projectId, s]));
      result.seeded = now.map((s) => {
        const b = before.get(s.projectId) ?? null;
        const row = { projectId: s.projectId, projectRev: [b?.projectRev ?? null, s.projectRev], layers: Object.values(s.layers).reduce((n, m) => n + Object.keys(m).length, 0), blobs: s.blobs, verified: s.verified };
        if (b) {
          check(b.projectRev === s.projectRev, `种子项目 ${s.name}：projectRev 与库存一致（连续、不归零）`, row.projectRev);
          check(b.digest === s.digest, `种子项目 ${s.name}：项目摘要与库存一致`);
          check(JSON.stringify(b.layers) === JSON.stringify(s.layers), `种子项目 ${s.name}：已就绪的层（清单的键与哈希）与库存一致`);
        } else if (file) {
          fails.push(`种子项目 ${s.name}：库存文件里没有它（盘点时没给 --seed）`);
        }
        return row;
      });
    }
  }
  // 数据目录里扫出来的就绪层：库存里有、且这次给了 --scan-dir（新实例的数据目录）时逐键比
  const scanDir = arg('--scan-dir', null);
  if (scanDir) {
    const now = scanReadyLayers(scanDir);
    const was = file?.readyLayers ?? null;
    result.readyLayers = { to: now.count, from: was?.count ?? null, equal: was ? JSON.stringify(was.spaces) === JSON.stringify(now.spaces) : null };
    if (was) check(result.readyLayers.equal, '数据目录里的就绪层（两类清单的键与哈希）与库存一致', result.readyLayers);
  }
  return done();
}

/* ================================================================== coord */

async function runCoord() {
  const port = intArg('--port', 0, 0);
  const host = arg('--host', '127.0.0.1');
  const coord = await startCoordServer({ port, host });
  log('coord.listen', { url: `http://${host}:${coord.port}`, host: os.hostname() });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { void coord.close().then(() => { process.exitCode = 0; }); });
}

/* ------------------------------------------------------------------ 主流程 */

if (ROLE === 'migrate-check') await runMigrateCheck();
else if (ROLE === 'inventory') await runInventory();
else if (ROLE === 'coord') await runCoord();
else if (MODE === 'internet' && ROLE === 'creator') await runCreator();
else if (MODE === 'internet' && ROLE === 'member') await runMember();
else if (MODE === 'lan') await (await import('./shared-project-lan.mjs')).runLan(ROLE, argv);
else usage(argv.length ? '参数不对' : undefined);
