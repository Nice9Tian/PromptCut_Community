/**
 * 渲染任务队列的端到端探针：经真 WebSocket 接文档服务，按发布方、渲染节点或两者的身份跑一轮假任务。
 * 能在两台机器上各跑一半（一台 --role publisher，另一台 --role node）。
 * 依据：`docs/plan/render-queue-contract.md` G.8。
 *
 * 跑：
 *   node scripts/probes/render-queue-e2e.mjs --url <ws://…> --role publisher|node|both
 *     [--tasks 50] [--project <id>] [--node-id <id>] [--task-ms 200] [--max-concurrent 2]
 *     [--exit-after-claim] [--announce <http-url>] [--watch-endpoints] [--timeout-ms 120000] [--transport auto|ws]
 *
 * 凭证（M6a，`docs/plan/auth-contract.md` 第 5、11 节；集群令牌已退出数据面，本探针不再读它）：
 * - 设了环境变量 PROMPTCUT_SHARED_CONFIG（共享项目配置 JSON）：取第一项，凭项目证明进入，节点连接用 `render` 角色、
 *   发布方连接用 `page` 角色；每次（重）连前现取挑战。任务都在这个共享项目的空间里；
 * - 没设：不带凭证，连本机回环时是本机身份（`local` 空间），连别的机器会被 401。
 * `--announce` 是管理接口（服务地址登记）：本机身份能登记，共享项目的成员会被拒（forbidden）。
 * 配置里的口令、派生密钥与证明都不打印。
 *
 * - node 角色：createLocalNode + createDocEndpoint（会话，HT-a）；执行器按 --task-ms 睡眠，产物库用内存版
 *   （复用 server/test/ 的假件：探针不是生产代码）。同时 queue.watch：看到别人认领某任务（task.taken）的
 *   时刻 t1、自己认领到同一任务的时刻 t2，takeovers 记 t2 − t1（两个时刻都是本机时钟）。
 *   --exit-after-claim：第一次认领成功后立刻退出，退出码 3（测「干净断开」）。
 *   --announce：连上后以本节点身份登记这个地址（service.announce，kind 为 render-node）。
 *   --watch-endpoints：订阅全部服务地址，最后输出 endpoints。
 *   单独跑 node 角色时一直干到 --timeout-ms 或 Ctrl+C，然后输出结果。
 * - publisher 角色：publisher.hello，发布 --tasks 个假细任务（kind snapshot、tier shared，结果键随机、带运行 id），
 *   数 task.done（每个 id 第一次记完成，再来的记重复）；看到 epoch 变了、或重连上，就把没完成的重新发布（发布是幂等的）。
 *   全部完成就结束；到 --timeout-ms 还没完成算失败。
 * - both：同一进程两者都跑（两条连接）。
 *
 * 输出：最后一行 JSON
 *   { ok, role, url, epochs, published, completed, duplicateDone, claims, claimsById,
 *     doneLatencyMs: { p50, p95 }, takeovers: [{ id, ms }], endpoints?, sessions, fails }
 *   `sessions`：每条连接实际用的传输、接续次数、是否对着没有会话层的旧服务端（不含会话号）。
 *
 * 传输（契约 `docs/plan/http-transport-contract.md` 第 4.3 节第 6 条）：连接是一个会话（`createDocEndpoint`）。
 * `--transport` 是开发者强制参数，不给时读环境变量 `PROMPTCUT_TRANSPORT`，再缺省自动（HT-a 的自动就是 WebSocket）；
 * `ws` 只走 WebSocket；`http` 在 HT-a 未启用（退出码 2）。`--url` 收 ws(s):// 或 http(s)://。
 * 退出码：0 全过；1 有断言失败；2 连不上（或参数不对）；3 --exit-after-claim 的预期退出。
 */
import { randomBytes } from 'node:crypto';

const USAGE = `用法：node scripts/probes/render-queue-e2e.mjs --url <ws://…> --role publisher|node|both
  [--tasks 50] [--project <id>] [--node-id <id>] [--task-ms 200] [--max-concurrent 2]
  [--exit-after-claim] [--announce <http-url>] [--watch-endpoints] [--timeout-ms 120000] [--transport auto|ws]
凭证从环境变量 PROMPTCUT_SHARED_CONFIG 指向的共享项目配置读；不设就是本机身份（只能连本机回环）。`;

function usage(msg) {
  if (msg) console.error(msg);
  console.error(USAGE);
  process.exit(2);
}

const FLAGS = new Set(['--exit-after-claim', '--watch-endpoints']);
const VALUED = new Set(['--url', '--role', '--tasks', '--project', '--node-id', '--task-ms', '--max-concurrent', '--announce', '--timeout-ms', '--transport']);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (FLAGS.has(a)) { out[a.slice(2)] = true; continue; }
    if (VALUED.has(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) usage(`${a} 缺值`);
      out[a.slice(2)] = v;
      continue;
    }
    if (a === '--token') usage('集群令牌不再用于数据面；共享项目的凭证从环境变量 PROMPTCUT_SHARED_CONFIG 读');
    usage(`不认识的参数：${a}`);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.url || !args.role) usage(process.argv.length > 2 ? '缺 --url 或 --role' : undefined);
if (!['publisher', 'node', 'both'].includes(args.role)) usage(`--role 只能是 publisher、node、both，收到 ${args.role}`);
const intArg = (name, dflt, min = 0) => {
  if (args[name] === undefined) return dflt;
  const n = Number(args[name]);
  if (!Number.isInteger(n) || n < min) usage(`--${name} 要是不小于 ${min} 的整数`);
  return n;
};
const url = args.url;
if (!/^(wss?|https?):\/\//.test(url)) usage('--url 要是 ws(s):// 或 http(s)://');
const role = args.role;
const taskCount = intArg('tasks', 50, 1);
const taskMs = intArg('task-ms', 200, 0);
const maxConcurrent = intArg('max-concurrent', 2, 1);
const timeoutMs = intArg('timeout-ms', 120_000, 1);
const runId = `${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
const projectId = args.project ?? `probe-${runId}`;
const nodeId = args['node-id'] ?? `probe-node-${process.pid}`;
let sharedEntry = null;
let sharedProtocols = null;
if (process.env.PROMPTCUT_SHARED_CONFIG) {
  try {
    const mod = await import(new URL('../../server/auth/shared-config.mjs', import.meta.url));
    [sharedEntry] = mod.loadSharedConfig();
    sharedProtocols = mod.sharedProtocols;
  } catch (error) {
    usage(String(error?.message ?? error));
  }
}
if (args.announce !== undefined) {
  try { new URL(args.announce); } catch { usage('--announce 要是 http(s):// 地址'); }
}

// 被测模块和假件按需动态引入：参数不对时只打用法，不因模块缺失而崩
const here = new URL('.', import.meta.url);
const [{ createDocEndpoint, transportOf }, { watchServiceEndpoints }, { createLocalNode }, { createArtifactSink }, { createSleepExecutor, snapshotTaskInput }] = await Promise.all([
  import(new URL('../../server/render-node/session-link.mjs', here)),
  import(new URL('../../server/render-node/endpoint.mjs', here)),
  import(new URL('../../server/render-node/local-node.mjs', here)),
  import(new URL('../../server/test/fake-artifact-sink.mjs', here)),
  import(new URL('../../server/test/fake-ws-kit.mjs', here)),
]);

let transportOption = {};
if (args.transport !== undefined) {
  try { transportOption = { transport: transportOf(args.transport, undefined) }; } catch (error) { usage(`--transport ${args.transport}：${error?.message ?? error}`); }
}

const log = (event, fields = {}) => console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
const result = {
  ok: false, role, url, epochs: [], published: 0, completed: 0, duplicateDone: 0,
  claims: 0, claimsById: {}, doneLatencyMs: { p50: null, p95: null }, takeovers: [], fails: [],
};
if (args['watch-endpoints']) result.endpoints = [];
const latencies = [];
const endpoints = [];
const timers = [];
let finished = false;

function noteEpoch(message) {
  if (typeof message?.epoch === 'string' && result.epochs.at(-1) !== message.epoch && !result.epochs.includes(message.epoch)) {
    result.epochs.push(message.epoch);
    return true;
  }
  return false;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function finish(code) {
  if (finished) return;
  finished = true;
  for (const t of timers) clearInterval(t);
  const sorted = [...latencies].sort((a, b) => a - b);
  result.doneLatencyMs = { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
  if (code === undefined) code = result.fails.length === 0 ? 0 : 1;
  result.ok = code === 0;
  process.exitCode = code;
  result.sessions = endpoints.map((ep) => {
    const s = ep.stats();
    return { mode: s.mode ?? null, transport: s.transport ?? null, resumes: s.resumes ?? 0, fallbacks: s.fallbacks ?? 0, legacy: s.legacy === true, opens: s.opens ?? 0 };
  });
  // 先等连着的连接关干净（最多 CLOSE_WAIT_MS）再退出：关闭握手没完成就 process.exit，
  // Windows 上 libuv 会断言 UV_HANDLE_CLOSING 崩掉（对远端必现）
  closeEndpoints().then(() => {
    process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(code));
  });
}

const CLOSE_WAIT_MS = 3_000;
/** 关掉全部连接；连着的等到 onClose，最多 CLOSE_WAIT_MS */
function closeEndpoints() {
  const waits = [];
  for (const ep of endpoints) {
    if (ep.connected) waits.push(new Promise((resolve) => ep.onClose(resolve)));
    try { ep.close(); } catch { /* 已关 */ }
  }
  if (waits.length === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, CLOSE_WAIT_MS);
    Promise.all(waits).then(() => { clearTimeout(t); resolve(); });
  });
}

function openEndpoint(label) {
  // 共享项目：节点连接是 render，发布方连接是 page（node.hello 只许 render 连接）
  const protocols = sharedEntry ? sharedProtocols(sharedEntry, { role: label === 'node' ? 'render' : 'page' }) : undefined;
  const ep = createDocEndpoint({ url, ...(protocols ? { protocols } : {}), ...transportOption, log: (event, fields) => log(`${label}.${event}`, fields) });
  endpoints.push(ep);
  ep.onOpen(() => log(`${label}.open`, { opens: ep.stats().opens }));
  ep.onClose((info) => log(`${label}.close`, info));
  return ep;
}

// ---------------------------------------------------------------- 发布方

function runPublisher() {
  const ep = openEndpoint('publisher');
  const publisherId = `probe-pub-${runId}`;
  const tasks = Array.from({ length: taskCount }, (_, i) => snapshotTaskInput({
    resultKey: `probe-${runId}-${i}`, from: 0, to: 29, projectId, weight: 'light',
  }));
  const firstPublishAt = new Map();
  const doneAt = new Map();
  let seq = 0;

  function publishPending(why) {
    const pending = tasks.filter((t) => !doneAt.has(t.id));
    if (pending.length === 0) return;
    const at = Date.now();
    for (const t of pending) if (!firstPublishAt.has(t.id)) firstPublishAt.set(t.id, at);
    result.published = firstPublishAt.size;
    ep.send({ type: 'task.publish', reqId: `pub-${++seq}`, tasks: pending });
    log('publisher.publish', { why, count: pending.length });
  }

  ep.onOpen(() => {
    ep.send({ type: 'publisher.hello', reqId: `hello-${seq}`, publisherId });
    publishPending('open');
  });
  let lastEpoch = null;
  ep.onMessage((m) => {
    noteEpoch(m);
    if (typeof m.epoch === 'string' && m.epoch !== lastEpoch) {
      const changed = lastEpoch !== null;
      lastEpoch = m.epoch;
      if (changed) {
        log('publisher.epoch-changed', { epoch: m.epoch });
        publishPending('epoch');
      }
    }
    if (m.type === 'task.published') {
      for (const r of m.results ?? []) if (r.error) result.fails.push(`publish ${r.id}: ${r.error}`);
    } else if (m.type === 'task.done') {
      if (!firstPublishAt.has(m.id)) return; // 不是本轮的
      if (doneAt.has(m.id)) { result.duplicateDone += 1; return; }
      doneAt.set(m.id, Date.now());
      result.completed = doneAt.size;
      latencies.push(Date.now() - firstPublishAt.get(m.id));
      if (doneAt.size === tasks.length) {
        log('publisher.all-done', { completed: doneAt.size });
        // 稍等一下再收尾，好数到迟到的重复完成
        setTimeout(() => finish(), 300);
      }
    } else if (m.type === 'task.failed') {
      result.fails.push(`task.failed ${m.id}: ${m.error}`);
    } else if (m.type === 'error') {
      result.fails.push(`error ${m.reason}: ${m.detail ?? ''}`);
    }
  });
  return ep;
}

// ---------------------------------------------------------------- 渲染节点

function runNode() {
  const ep = openEndpoint('node');
  const takenAt = new Map();
  const node = createLocalNode({
    nodeId,
    node: { profile: 'host', envFingerprint: 'probe-env', codeVersions: [], capabilities: {} },
    endpoint: ep,
    now: Date.now,
    maxConcurrent,
    executor: createSleepExecutor({ taskMs }),
    sink: createArtifactSink(),
    onEvent: (e) => {
      if (e.type === 'failed') result.fails.push(`node failed ${e.id}: ${e.error}`);
      if (e.type === 'lost' || e.type === 'failed' || e.type === 'completed' || e.type === 'dedup') log(`node.${e.type}`, { id: e.id, reason: e.reason });
    },
  });
  ep.onOpen(() => {
    node.start(node.session.held().map(({ id, token: tk }) => ({ id, token: tk })));
    if (args.announce) ep.send({ type: 'service.announce', announcerId: nodeId, kind: 'render-node', urls: [args.announce] });
  });
  ep.onMessage((m) => {
    noteEpoch(m);
    if (m.type === 'task.taken') {
      takenAt.set(m.id, Date.now());
    } else if (m.type === 'task.claimed') {
      const at = Date.now();
      result.claims += 1;
      result.claimsById[m.id] = (result.claimsById[m.id] ?? 0) + 1;
      if (takenAt.has(m.id)) {
        result.takeovers.push({ id: m.id, ms: at - takenAt.get(m.id) });
        takenAt.delete(m.id);
      }
      if (args['exit-after-claim']) {
        log('node.exit-after-claim', { id: m.id });
        finish(3);
      }
    } else if (m.type === 'error' && m.reason !== 'not-registered') {
      result.fails.push(`error ${m.reason}: ${m.detail ?? ''}`);
    }
  });
  if (args['watch-endpoints']) watchServiceEndpoints(ep, 'all', (list) => { result.endpoints = list; });
  timers.push(setInterval(() => { try { node.tick(); } catch (err) { log('node.tick-error', { message: String(err?.message ?? err) }); } }, 50));
  return ep;
}

// ---------------------------------------------------------------- 主流程

log('start', { role, url, runId, projectId, nodeId, tasks: taskCount, credential: sharedEntry ? 'shared-project' : 'none' });
const eps = [];
if (role === 'publisher' || role === 'both') eps.push(runPublisher());
if (role === 'node' || role === 'both') eps.push(runNode());

const connectDeadline = Math.min(timeoutMs, 15_000);
const connectCheck = setTimeout(() => {
  if (eps.some((ep) => ep.stats().opens === 0)) {
    result.fails.push(`${connectDeadline} ms 内没连上 ${url}`);
    finish(2);
  }
}, connectDeadline);
connectCheck.unref?.();

setTimeout(() => {
  if (role !== 'node') result.fails.push(`${timeoutMs} ms 内没全部完成（完成 ${result.completed}/${taskCount}）`);
  finish();
}, timeoutMs).unref?.();
timers.push(setInterval(() => {}, 1 << 30)); // 保持进程存活，直到 finish

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    if (role !== 'node') result.fails.push(`被 ${sig} 中断（完成 ${result.completed}/${taskCount}）`);
    finish();
  });
}
