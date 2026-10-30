/**
 * 仅供测试，生产代码不得引用。
 *
 * M6b 独立渲染主机契约测试（`docs/plan/render-host-contract.md`，用例 RHC*）共用的工具。只照契约写，不看实现。
 *
 * # 假设的实现接口（契约没写死，主会话集成时对账；对不上只改本文件的 `loadHostModule` 与 `startHost` 两处）
 *
 *   server/render-host/index.mjs
 *
 *     parseHostConfig(raw, { device? }) → { entries, maxConcurrent }
 *       raw       配置文件解析后的 JSON：单个对象，或对象组成的数组（契约第 2 节，沿用 M6a 契约第 11 节的形状）
 *                 每项 { url, projectId, username, deviceId, deviceName, as: 'member', password | key, role: 'render' }
 *                 另可给 maxConcurrent（缺省 1，上限 4）。本测试假设它写在配置项里：单个对象就写在对象上，
 *                 数组时写在任何一项上都算全局值（测试只在一项上给）
 *       device    缺省设备信息（与 M6a `normalizeEntry` 的第二个参数相同），可不给
 *       entries   每项规整后的配置（字段名同上），顺序与输入相同
 *       不合格    抛 Error，`err.code` 为 'bad-host-config' 或 'bad-shared-config'（沿用 M6a）；信息里不带口令与 K
 *
 *     loadHostConfig(file) → 同 parseHostConfig，读文件；读不了、不是 JSON 同样抛上面的错
 *
 *     createRenderHost(options) → host
 *       options.entries        parseHostConfig 的 entries
 *       options.maxConcurrent  所有节点合计的并发上限
 *       options.codeVersion    本机 frameCode（node.hello 的 codeVersions 只有它）
 *       options.envFingerprint 本机探测到的指纹
 *       options.executor       契约 D.1 的执行器 { plan, render }，所有节点共用这一个
 *       options.sinkFor        ({ projectId, entry, endpoint }) → 契约 D.1 的产物库 { has, put, resultFor? }；
 *                              每个项目一个。生产里是「经 auth.ticket 取票据、推到 service.endpoints 的 asset」，
 *                              测试注入假的，不测真推送（探针测）
 *       options.tickMs         节点节拍（可选；测试给 20，缺省实现自定）
 *       options.log            (event, fields) => void（可选）
 *     host.start()             开连接、报到；可以返回 Promise
 *     host.stop()              让掉手里的认领、关连接；返回 Promise（契约第 2 节「退出」）
 *     host.describe()          契约第 3 节诊断的形状：
 *                              { nodes: [{ projectId, connected, claimed, completed, dedup, failed, lost }],
 *                                codeVersion, envFingerprint, maxConcurrent }
 *
 *   连接用 M5a 的 `createWsEndpoint`（缺省取全局 `WebSocket`），凭 M6a 的 `sharedProtocols(entry, { role: 'render' })`
 *   每次连前现取证明。测试在起主机前把全局 `WebSocket` 换成记录用的子类（`recordWebSocket`），据此看主机发出的
 *   `node.hello`，不要求实现多开注入口。
 *
 * # 用到的 M6a / M5 已有接口（真实存在，照用）
 *
 *   fake-shared-env.mjs     startSharedService / createProject / join（托管端，isLoopback 缺省全当远端）
 *   render-queue、render-node 的公共出口、fake-loopback-transport、fake-render-queue-env
 *   文档服务 `service.describe().modules['render-queue']`：有共享空间时带 `spaces: { <projectId>: 队列 describe }`
 *   （M6a 报告第 5 节第 18 条）
 */
import assert from 'node:assert/strict';
import { sleep, waitFor } from './fake-ws-kit.mjs';
import { startSharedService, createProject, deviceId as newDeviceId } from './fake-shared-env.mjs';
import { buildAuthProtocols } from '../auth/client.mjs';
import { wsClient } from './fake-ws-kit.mjs';

export { sleep, waitFor, startSharedService, createProject, newDeviceId, wsClient };

export const CODE_VERSION = 'cv-host-test-0001';
export const FINGERPRINT = 'fp-host-test-0001';
export const PROTOCOL = 'promptcut.v1';

// ------------------------------------------------------------------ 假设的实现接口

/*
 * 集成对账（2026-09-26，claude/m6-integ2）：实际接口在 `server/render-node/host.mjs`，与上面的假设对不上的地方由下面的
 * 胶水 `adaptHostModule` 接上，用例与断言不动：
 *   - parseHostConfig(raw, { device? })  实际同名同形，直接用；
 *   - loadHostConfig(file)               实际是 loadHostConfig(env)，读 env.PROMPTCUT_SHARED_CONFIG；胶水把文件路径放进
 *                                         环境变量对象，并清掉 PROMPTCUT_HOST_MAX_CONCURRENT（只测文件里的值）；
 *   - createRenderHost(options)          实际不自己开连接、不开计时器：`connect(entry, index)` 回 { endpoint, executor, sink }，
 *                                         调用方按节拍调 `tick()`，退出是 `shutdown()` + `settled()` + 调用方关连接，诊断是 `nodes()`。
 *                                         胶水照预渲染进程里的接线（`vite-plugin-frames.ts` 的 `startHostNode`）拼：
 *                                         每项一个 `createWsEndpoint`（凭 `sharedProtocols(entry, { role: 'render' })`），
 *                                         执行器共用测试给的那一个，产物库 `sinkFor({ projectId, entry, endpoint })`；
 *                                         start = host.start() + 每 tickMs 调 host.tick()；
 *                                         stop = host.shutdown() → 等 settled（最多 5 s）→ 关全部连接；
 *                                         describe = { nodes: host.nodes(), codeVersion, envFingerprint, maxConcurrent }
 *                                         （nodes 每项原样带实现多给的字段，与 HTTP 诊断口同源）。
 */
async function adaptHostModule() {
  const real = await import('../render-node/host.mjs');
  const { createWsEndpoint } = await import('../render-node/ws-transport.mjs');
  const { sharedProtocols } = await import('../auth/shared-config.mjs');
  return {
    parseHostConfig: real.parseHostConfig,
    loadHostConfig: (file) => real.loadHostConfig({ ...process.env, PROMPTCUT_SHARED_CONFIG: file, PROMPTCUT_HOST_MAX_CONCURRENT: '' }),
    createRenderHost({ entries, maxConcurrent, codeVersion, envFingerprint, executor, sinkFor, tickMs = 250, log = () => {} }) {
      const endpoints = [];
      const host = real.createRenderHost({
        entries,
        maxConcurrent,
        codeVersion,
        envFingerprint,
        now: Date.now,
        nodeIdOf: (_entry, index) => `host:rhc/p${index}`,
        connect: (entry) => {
          // 连接层的事件（ws.open / ws.error / ws.connect-failed / ws.retry）也记进 logs，用例等不到报到时能看出卡在哪
          const endpoint = createWsEndpoint({ url: entry.url, protocols: sharedProtocols(entry, { role: 'render' }), log });
          endpoints.push(endpoint);
          return { endpoint, executor, sink: sinkFor({ projectId: entry.projectId, entry, endpoint }) };
        },
        onEvent: (event) => log(`node.${event?.type}`, event),
      });
      let timer = null;
      return {
        start() {
          host.start();
          timer = setInterval(() => host.tick(), tickMs);
        },
        async stop() {
          clearInterval(timer);
          host.shutdown('shutdown');
          await Promise.race([host.settled(), sleep(5000)]);
          for (const endpoint of endpoints) endpoint.close();
        },
        describe() {
          return { nodes: host.nodes(), codeVersion: host.codeVersion, envFingerprint, maxConcurrent: host.maxConcurrent };
        },
      };
    },
  };
}

let hostModPromise = null;
/** 载入主机模块（经上面的胶水）；缺模块、缺导出时断言失败（只让用到它的用例失败） */
export async function loadHostModule() {
  hostModPromise ??= adaptHostModule();
  let mod;
  try {
    mod = await hostModPromise;
  } catch (error) {
    hostModPromise = null;
    assert.fail(`载入 server/render-node/host.mjs 失败（见 render-host-kit.mjs 文件头的对账说明）：${error?.message ?? error}`);
  }
  for (const name of ['parseHostConfig', 'loadHostConfig', 'createRenderHost']) {
    assert.equal(typeof mod[name], 'function', `主机模块要有 ${name}；实际：${Object.keys(mod).join(', ')}`);
  }
  return mod;
}

/** 配置项里给 maxConcurrent 的假设写法：给在第一项上 */
export function withMaxConcurrent(entries, maxConcurrent) {
  if (maxConcurrent === undefined) return entries;
  return entries.map((e, i) => (i === 0 ? { ...e, maxConcurrent } : e));
}

/**
 * 起一个主机（进程内），用例结束时 stop。
 * @param {import('node:test').TestContext} t
 * @param {{ entries: object[], maxConcurrent?: number, codeVersion?: string, envFingerprint?: string,
 *           executor: object, sinkFor?: Function, tickMs?: number }} o  entries 是原始配置项（先经 parseHostConfig）
 */
export async function startHost(t, { entries, maxConcurrent, codeVersion = CODE_VERSION, envFingerprint = FINGERPRINT, executor, sinkFor, tickMs = 20 }) {
  const { parseHostConfig, createRenderHost } = await loadHostModule();
  const parsed = parseHostConfig(withMaxConcurrent(entries, maxConcurrent));
  const logs = [];
  const host = createRenderHost({
    entries: parsed.entries,
    maxConcurrent: parsed.maxConcurrent,
    codeVersion,
    envFingerprint,
    executor,
    sinkFor: sinkFor ?? (() => createFakeSink()),
    tickMs,
    log: (event, fields) => logs.push({ event, ...fields }),
  });
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await host.stop();
  };
  t.after(stop);
  await host.start();
  return { host, stop, logs, parsed };
}

// ------------------------------------------------------------------ 执行器与产物库（契约 D.1 的形状）

/**
 * 可控的执行器：每次 render 进来就挂起，等测试放行（`releaseAll` / `releaseOne`），或 `autoMs` 后自己完成。
 * 记录同时在跑的最大数、render 过的任务 id、plan 被调用的次数。中止信号到了就立即拒绝。
 */
export function createGateExecutor({ autoMs = null } = {}) {
  const waiting = [];
  const stats = { running: 0, maxRunning: 0, rendered: [], planCalls: 0, aborted: 0 };
  return {
    stats,
    waiting,
    async plan(task) {
      stats.planCalls += 1;
      throw Object.assign(new Error(`主机不该算 plan：${task?.id}`), { retryable: false });
    },
    render(task, { signal }) {
      stats.running += 1;
      stats.maxRunning = Math.max(stats.maxRunning, stats.running);
      stats.rendered.push(task.id);
      return new Promise((resolve, reject) => {
        let done = false;
        const finish = (fn) => {
          if (done) return;
          done = true;
          stats.running -= 1;
          const i = waiting.indexOf(entry);
          if (i >= 0) waiting.splice(i, 1);
          fn();
        };
        const entry = { id: task.id, release: () => finish(() => resolve({ frames: task.range })) };
        waiting.push(entry);
        signal?.addEventListener('abort', () => { stats.aborted += 1; finish(() => reject(new Error('aborted'))); }, { once: true });
        if (autoMs !== null) setTimeout(entry.release, autoMs);
      });
    },
    releaseOne() { waiting[0]?.release(); },
    releaseAll() { for (const w of [...waiting]) w.release(); },
  };
}

/** 假产物库：`has` 按 `dedupKeys` 回 true，`put` 一律收全 */
export function createFakeSink({ dedupKeys = new Set() } = {}) {
  const puts = [];
  return {
    puts,
    async has(ref) { return dedupKeys.has(ref.resultKey); },
    async put(entry) { puts.push(entry.meta?.taskId ?? entry.resultKey); return { complete: true, result: {} }; },
    async resultFor() { return {}; },
  };
}

// ------------------------------------------------------------------ 共享项目的文档服务

/** 起托管端文档服务（全当远端来源），建若干自由进入的项目。用例结束时关掉 */
export async function sharedService(t, { projects = 1 } = {}) {
  const s = await startSharedService({ mode: 'hosted' });
  t.after(() => s.close());
  const list = [];
  for (let i = 0; i < projects; i++) {
    const password = `project-pw-${i}`;
    const p = await createProject(s.base, { password });
    list.push({ ...p, password });
  }
  return { s, projects: list };
}

/** 主机配置项（契约第 2 节字段） */
export function hostEntry(s, project, { username = 'rig', deviceId = 'render-host-device-0001', deviceName = 'RenderHost', password = project.password } = {}) {
  return { url: s.url, projectId: project.projectId, username, deviceId, deviceName, as: 'member', password, role: 'render' };
}

let reqSeq = 0;
/** 发带 reqId 的消息，等同 reqId 的回包（或不带 reqId、类型在 types 里的） */
export async function ask(c, message, types = null, ms = 3000) {
  const reqId = `rhc-${++reqSeq}`;
  c.send({ ...message, reqId });
  const list = types ? [].concat(types, 'error') : null;
  return c.next((m) => m?.reqId === reqId || (list !== null && m?.reqId === undefined && list.includes(m?.type)), ms);
}

/** 以成员身份连上（证明由 M6a 的 client.mjs 拼） */
export async function member(s, project, { username, role = 'page', deviceId = newDeviceId(username) } = {}) {
  const protocols = await buildAuthProtocols({
    base: s.base, projectId: project.projectId, username, deviceId, deviceName: `${username}-pc`, as: 'member', password: project.password, role,
  });
  const c = wsClient(s.url, protocols);
  await c.opened;
  return c;
}

/** 以 page 成员身份发布细任务；回 task.published */
export async function publishAs(s, project, username, tasks) {
  const c = await member(s, project, { username });
  const w = await ask(c, { type: 'publisher.hello', publisherId: `pub-${username}-${project.projectId}` }, 'publisher.welcome');
  assert.equal(w.type, 'publisher.welcome', JSON.stringify(w));
  const r = await ask(c, { type: 'task.publish', tasks }, 'task.published');
  assert.equal(r.type, 'task.published', JSON.stringify(r));
  for (const item of r.results ?? []) assert.equal(item.error ?? null, null, `发布失败：${JSON.stringify(item)}`);
  return { conn: c, published: r };
}

/** 文档服务里某个共享空间的队列 describe（M6a：`modules['render-queue'].spaces[projectId]`） */
export function queueOf(s, projectId) {
  const d = s.service.describe().modules?.['render-queue'];
  assert.ok(d && typeof d === 'object', `文档服务 describe 里没有 render-queue 模块：${JSON.stringify(Object.keys(s.service.describe().modules ?? {}))}`);
  const q = d.spaces?.[projectId];
  return q ?? { tasks: [], nodes: [], publishers: [] };
}

/** 全部共享空间里 state 为 claimed 的任务数 */
export function claimedCount(s, projectIds) {
  let n = 0;
  for (const pid of projectIds) n += queueOf(s, pid).tasks.filter((x) => x.state === 'claimed').length;
  return n;
}

/** 某个空间里各状态的任务数 */
export function statesOf(s, projectId) {
  const out = {};
  for (const x of queueOf(s, projectId).tasks) out[x.state] = (out[x.state] ?? 0) + 1;
  return out;
}

// ------------------------------------------------------------------ 细任务

/** 一个合法的 snapshot 细任务（契约 A.4），requires 带代码版本与指纹 */
export function fineTask({ tag, from = 0, to = 29, projectId = 'demo', projectRev = 1, codeVersion = CODE_VERSION, envFingerprint = FINGERPRINT, weight = 'light' }) {
  const resultKey = `rk-${tag}`;
  return {
    id: `snapshot:${resultKey}:${from}-${to}`,
    kind: 'snapshot',
    tier: 'shared',
    resultKey,
    range: { unit: 'localFrame', from, to },
    source: { projectId, projectRev },
    input: {},
    weight: { class: weight, estMs: null, frames: to - from + 1 },
    requires: { codeVersion, envFingerprint },
    priority: 0,
  };
}

// ------------------------------------------------------------------ 记录主机发出的 WebSocket 消息

/** 从子协议里解出证明 JSON（`promptcut.auth.<b64url(JSON)>`）；没有回 null */
export function proofOf(protocols) {
  const list = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
  const item = list.find((p) => typeof p === 'string' && p.startsWith('promptcut.auth.'));
  if (!item) return null;
  try { return JSON.parse(Buffer.from(item.slice('promptcut.auth.'.length), 'base64url').toString('utf8')); } catch { return null; }
}

/**
 * 把全局 WebSocket 换成记录用的子类，用例结束时换回。记下每条连接的证明（项目、角色）与发出的每条 JSON 消息。
 * @returns {{ sockets: Array<{ url, proof, sent: object[] }>, sentBy(role): Array<{ projectId, message }> }}
 */
export function recordWebSocket(t) {
  const Original = globalThis.WebSocket;
  const sockets = [];
  class Recording extends Original {
    constructor(url, protocols) {
      super(url, protocols);
      this.__rec = { url: String(url), proof: proofOf(protocols), sent: [] };
      sockets.push(this.__rec);
    }
    send(data) {
      try { this.__rec.sent.push(JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))); } catch { /* 不是 JSON */ }
      return super.send(data);
    }
  }
  globalThis.WebSocket = Recording;
  t.after(() => { globalThis.WebSocket = Original; });
  return {
    sockets,
    sentBy(role) {
      const out = [];
      for (const s of sockets) {
        if (s.proof?.r !== role) continue;
        for (const m of s.sent) out.push({ projectId: s.proof.p, message: m });
      }
      return out;
    },
  };
}
