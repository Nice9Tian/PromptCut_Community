/**
 * 仅供测试。M6c 契约测试（`docs/plan/m6c-contract.md` X1～X5）用的假件与**接口假设**。
 *
 * 测试方只照契约写，不看实现（`claude/m6c-stream`、`claude/m6c-queue`）。契约没写死的接口名一律集中在本文件，
 * 每一条标 `〔假设 A-…〕`，主会话集成时对账：实现的名字不同，只改这里，用例不动。
 *
 * 契约写死、直接在用例里用的：
 *   - 流任务 `requires.capabilities.streams === true`，节点 `node.hello` 的 `capabilities.streams`（X1）；
 *   - 细任务 `requires.localMedia = <发布方 nodeId>`（X2）；
 *   - `watch: 'all'` 的 `profile` 限制、`host` 只收摘要（X3，摘要格式见 render-queue-contract H.3 的 `queue.summary`）；
 *   - `plan` 的 `requires.preferNode`、常量 `PLAN_PREFER_MS`（缺省 5000，进 `constants.mjs`）（X4）；
 *   - 闲时门槛：执行器有空位且 500 ms 内没有交互帧请求（X5）。
 */
import { createRenderQueue, QUEUE_DEFAULTS } from '../render-queue/index.mjs';
import { createRouter } from '../docservice/router.mjs';
import { renderQueueModule } from '../docservice/modules/render-queue.mjs';
import { makeTaskInput } from './fake-render-queue-env.mjs';
import { createQueueIdleGate } from '../queue-idle.mjs';

export const FP = 'aaaaaaaaaaaaaaaa';

/* ================================================================== 假设清单（报告里照抄） */

export const ASSUMPTIONS = Object.freeze({
  'A-X1-1': '执行器的流路径仍经 createPrerenderExecutor({ pipeline, projects, prepareProject, log }).render(task, { signal, progress })；'
    + '流任务不再以 code "stream-not-supported" 拒绝。烟测只断言这一点（真产流要 ffmpeg，归 queue-mode-probe / stream-produce-probe）',
  'A-X1-2': '流任务的 StreamResult 经 sink.put 回的 { complete: true, result } 进 task.complete（C6.2 / J.3 的既有路径），'
    + 'local-node 不改签名',
  'A-X2-1': 'filter.mjs 的 checkClaimable(task, node) 从 node.nodeId 取本节点 id 比对 requires.localMedia'
    + '（会话层用例另走 createNodeSession({ nodeId })，不依赖这一条）',
  'A-X3-1': 'X3 的判定可以落在队列（onWatch）或文档服务的队列模块（modules/render-queue.mjs）任一层；'
    + '用例经 createRouter + renderQueueModule + createRenderQueue 的组合驱动，两层都覆盖',
  'A-X3-2': 'host 发 queue.watch { projects: "all" }（不带 mode 或 mode: "full"）也按摘要处理，至少收到一条 queue.summary',
  'A-X3-3': 'browser 的 watch all 回 { type: "error", reason: "forbidden" }（与 H.3 摘要订阅的拒绝同形）',
  'A-X4-1': 'QUEUE_DEFAULTS.PLAN_PREFER_MS 缺省 5000，可经 createRenderQueue({ constants: { PLAN_PREFER_MS } }) 覆盖；窗口从发布时刻起算',
  'A-X4-2': 'planTaskOf({ projectId, projectRev, preferNode }) 把 preferNode 写进 requires.preferNode',
  'A-X4-3': '窗口内非 preferNode 认领、以及 host / browser 认领 plan 回 task.claim-rejected（原因名不限），任务保持 open',
  'A-X5-1': '「preload 未 ready」用 FramePipeline 内部的 generations / entries 模拟：一个未中止的代际指向 status 为 "html" 的 entry',
  'A-X5-2': '「交互帧请求（拖动、播放）」用构造 FramePipeline 时注入的 playhead() 模拟：拖动 = { at: 最近一次, playing: false }，'
    + '播放 = { at, playing: true }；Date 由 mock.timers 接管，实现读 Date.now() 或用传入的 now 都一致',
  'A-X5-3': '〔集成对账改〕本机队列节点的闲时门槛是 queue-idle.mjs 的 createQueueIdleGate({ pipeline, lastInteractionAt }).idle(now)'
    + '（vite-plugin-frames 里 isIdle: () => idleGate.idle()）；执行器不再有 isIdle。用例传管线本身',
});

/* ================================================================== 任务 */

/** 一段轨道流细任务（X1）：`requires.capabilities.streams = true`，另带 M5b 的 `transcode: true`。 */
export function streamTask({ projectId = 'p1', seg = 0, key = 'stream-rk', requires = {} } = {}) {
  const from = seg * 8;
  return makeTaskInput({
    projectId, kind: 'stream', resultKey: key, range: [from, from + 7],
    input: { clipId: 'clip-bg', cardId: null, entryKey: null, contentKey: `${key}-ck` },
    requires: { envFingerprint: FP, transcode: true, capabilities: { streams: true }, ...requires },
    weight: { class: 'medium', estMs: null, frames: 120 },
  });
}

/** 一段快照细任务；`localMedia` 给了就写进 `requires.localMedia`（X2）。 */
export function snapTask({ projectId = 'p1', seg = 0, key = 'snap-rk', localMedia, requires = {} } = {}) {
  const from = seg * 60;
  return makeTaskInput({
    projectId, kind: 'snapshot', tier: 'local', resultKey: key, range: [from, from + 59],
    input: { clipId: 'clip-1', cardId: 'demo', entryKey: 'e1', contentKey: `e1/${key}-ck`, canvasHeavy: false },
    requires: { envFingerprint: FP, ...(localMedia !== undefined ? { localMedia } : {}), ...requires },
    weight: { class: 'light', estMs: null, frames: 60 },
  });
}

/** plan 任务（X4）：直接按契约字段造，`preferNode` 写进 `requires`。 */
export function planTask({ projectId = 'p1', projectRev = 1, preferNode } = {}) {
  return makeTaskInput({
    projectId, projectRev, kind: 'plan', input: {},
    requires: preferNode !== undefined ? { preferNode } : {},
    weight: { class: 'medium', estMs: null, frames: null },
  });
}

/** 〔假设 A-X4-2〕发布方经 `planTaskOf` 造 plan 时带上 `preferNode` */
export function planTaskViaSplit(planTaskOf, { projectId, projectRev, preferNode }) {
  return planTaskOf({ projectId, projectRev, preferNode });
}

/** 〔假设 A-X4-1〕 */
export const PLAN_PREFER_MS_DEFAULT = () => QUEUE_DEFAULTS.PLAN_PREFER_MS;

/** 〔假设 A-X2-1〕节点描述带 `nodeId` */
export function nodeDescriptor({ nodeId, profile = 'pc', userId = 'u1', capabilities = {}, ...rest }) {
  return {
    nodeId, profile, userId, envFingerprint: FP, codeVersions: [], cardSourceVersions: {},
    capabilities: { transcode: true, userCards: true, graphCards: true, memoryMB: 16_000, ...capabilities },
    ...rest,
  };
}

/* ================================================================== 文档服务 + 队列模块 + 队列（X3） */

/**
 * 〔假设 A-X3-1〕真路由 + 真队列模块 + 真队列，不起网络。`send` 的接法照 `service.mjs` 的 `sendFromOutside`：
 * 先问模块的 `outbound`，回 null 的不发。收件箱按 connId 分，存 JSON 往返后的消息。
 */
export function createDocQueueRig({ constants, start = 1_000_000 } = {}) {
  let t = start;
  const now = () => t;
  const inbox = new Map();
  const router = createRouter({
    now,
    write: (connId, text) => {
      if (!inbox.has(connId)) inbox.set(connId, []);
      inbox.get(connId).push(JSON.parse(text));
    },
  });
  let mod = null;
  const q = createRenderQueue({
    now,
    ...(constants ? { constants } : {}),
    send: (connId, message) => {
      let opts;
      if (typeof mod?.outbound === 'function') {
        opts = mod.outbound(connId, message);
        if (opts === null) return;
      }
      router.send(connId, message, opts);
    },
  });
  mod = renderQueueModule(q, {});
  router.mount(mod);

  const rig = {
    q, router, mod,
    now,
    advance(ms) { t += ms; },
    tick() { router.tick(); },
    connect(connId, principal = { userId: 'u1', tenantId: 't1' }) { router.connect(connId, principal); },
    send(connId, message) { router.dispatch(connId, JSON.stringify(message)); },
    node(connId, nodeId, { profile = 'pc', userId = 'u1', capabilities, watch } = {}) {
      rig.connect(connId, { userId, tenantId: 't1' });
      rig.send(connId, { type: 'node.hello', nodeId, profile, envFingerprint: FP, ...(capabilities ? { capabilities } : {}) });
      if (watch !== undefined) rig.send(connId, { type: 'queue.watch', projects: watch, reqId: `w-${connId}` });
    },
    publisher(connId, publisherId, { userId = 'u1' } = {}) {
      rig.connect(connId, { userId, tenantId: 't1' });
      rig.send(connId, { type: 'publisher.hello', publisherId });
    },
    publish(connId, tasks) { rig.send(connId, { type: 'task.publish', tasks }); },
    inbox: connId => inbox.get(connId) ?? [],
    of: (connId, type) => (inbox.get(connId) ?? []).filter(m => (Array.isArray(type) ? type.includes(m.type) : m.type === type)),
    clear(connId) { if (connId === undefined) inbox.clear(); else inbox.set(connId, []); },
  };
  return rig;
}

/* ================================================================== X5：预渲染管线的交互与 preload */

/**
 * 〔假设 A-X5-2〕可控的播放头：给 `FramePipeline({ playhead })` 用。
 * `drag(at)` 记一次拖动，`play(at)` 开始播放，`stop(at)` 停；`at` 缺省取 `Date.now()`（由 mock.timers 接管）。
 */
export function createPlayhead() {
  let head = null;
  const fn = () => (head ? { ...head } : null);
  fn.drag = (at = Date.now()) => { head = { at, playing: false, frame: 0 }; };
  fn.play = (at = Date.now()) => { head = { at, playing: true, frame: 0 }; };
  fn.stop = (at = Date.now()) => { head = { at, playing: false, frame: 0 }; };
  fn.clear = () => { head = null; };
  return fn;
}

/** 〔假设 A-X5-1〕模拟一个还在跑（没到 ready）的 preload 代际 */
export function simulatePreloadRunning(pipeline, { owner = 'page-1', key = 'entry-running', status = 'html' } = {}) {
  pipeline.entries.set(key, { key, status, stage: 'required' });
  pipeline.generations.set(owner, { key, controller: new AbortController(), seenAt: Date.now() });
  return () => {
    pipeline.generations.delete(owner);
    pipeline.entries.delete(key);
  };
}

/**
 * 〔假设 A-X5-3〕本机队列节点的闲时门槛。集成对账:实现是 `queue-idle.mjs` 的门槛,读管线身上的交互
 * (播放头、让路、热池在播);路由记的交互帧请求时刻在单测里没有,不给。参数是管线(原来是执行器)。
 */
export function queueIdle(pipeline, now = Date.now()) {
  return createQueueIdleGate({ pipeline }).idle(now);
}

/* ================================================================== 杂项 */

export const countBy = list => list.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
