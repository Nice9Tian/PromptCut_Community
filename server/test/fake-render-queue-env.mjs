/**
 * 渲染任务队列（M1）测试用的假件。契约：`docs/plan/render-queue-contract.md` C 节。
 *
 * - 假时钟：`now()`、`advance(ms)`、`set(t)`；
 * - 消息收集器：按 `connId` 分桶、按 `type` 过滤、`clear()`；另有 `mark()` / `since()` 取某一步发出的消息；
 * - 造 `TaskInput` 的助手：给 `projectId`、`projectRev`、`kind`、`range` 生成合法的任务输入；
 * - `createQueueHarness`：把上面三样和 `createRenderQueue` 拼起来，外加连接、报到、发消息的小工具。
 *
 * 本文件不引实现：`createQueueHarness` 的第一个参数由调用方传入 `createRenderQueue`，
 * 所以节点会话的测试也可以拿它对着真队列或别的假队列跑。
 * 任务 id 在这里按契约 A.4 自己算（`expectedTaskId`），不借实现的 `taskIdOf`，免得两边一起错。
 */
import assert from 'node:assert/strict';

/** 测试的起始时刻。不从 0 起，免得实现里 `if (t)` 这类写法把 0 当成「没有」而误判。 */
export const T0 = 1_000_000;

/* ------------------------------------------------------------ 假时钟 */

export function createFakeClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; return t; },
    set(v) { t = v; return t; },
  };
}

/* ------------------------------------------------------------ 消息收集器 */

/** 线上传输的形状：出站消息要能过 JSON。这里按 JSON 往返一次存下，值为 `undefined` 的字段随之消失。 */
const wire = message => JSON.parse(JSON.stringify(message));

const matchType = (type, message) => type === undefined
  || (Array.isArray(type) ? type.includes(message?.type) : message?.type === type);

/** 对一组 `{ seq, connId, message }` 的只读视图。 */
function viewOf(entries) {
  const of = (connId, type) => entries.filter(e => e.connId === connId && matchType(type, e.message)).map(e => e.message);
  return {
    entries,
    get count() { return entries.length; },
    messages: () => entries.map(e => e.message),
    /** 发给 `connId` 的消息（可按 `type` 过滤，`type` 可以是数组）。 */
    of,
    /** 发给 `connId` 的消息类型，按发出顺序。 */
    types: connId => of(connId).map(m => m.type),
    /** 发给 `connId` 的消息类型，排好序（契约没规定同一步里几条消息的先后时用它比）。 */
    sortedTypes: connId => of(connId).map(m => m.type).sort(),
    /** 收到过消息的连接。 */
    conns: () => [...new Set(entries.map(e => e.connId))].sort(),
    /** 某种类型的全部消息，跨连接：`[{ connId, message }]`。 */
    ofType: type => entries.filter(e => matchType(type, e.message)).map(e => ({ connId: e.connId, message: e.message })),
    last: (connId, type) => of(connId, type).at(-1),
    /** 发给 `connId` 的 `type` 消息恰好一条，返回它。 */
    one(connId, type) {
      const list = of(connId, type);
      assert.equal(list.length, 1, `期望给 ${connId} 恰好一条 ${type}，实际 ${list.length} 条；这一步发出的全部消息：${JSON.stringify(entries.map(e => [e.connId, e.message]))}`);
      return list[0];
    },
    /** 这一步什么都没发。 */
    assertSilent(what = '这一步') {
      assert.equal(entries.length, 0, `${what}不应发任何消息，实际：${JSON.stringify(entries.map(e => [e.connId, e.message]))}`);
    },
  };
}

export function createMessageCollector() {
  let log = [];
  let seq = 0;
  const send = (connId, message) => { log.push({ seq: seq++, connId, message: wire(message) }); };
  const collector = {
    send,
    /** 当前游标；配合 `since` 取之后发出的消息。 */
    mark: () => seq,
    since: mark => viewOf(log.filter(e => e.seq >= mark)),
    all: () => viewOf(log.slice()),
    clear() { log = []; },
  };
  // 收集器本身也有视图上的方法（作用于全部未清空的消息）
  for (const k of ['of', 'types', 'sortedTypes', 'conns', 'ofType', 'last', 'one']) {
    collector[k] = (...args) => viewOf(log)[k](...args);
  }
  Object.defineProperty(collector, 'count', { get: () => log.length });
  return collector;
}

/* ------------------------------------------------------------ 造任务输入 */

/** 契约 A.4 的任务 id，测试自己算。 */
export function expectedTaskId({ kind, resultKey, range }) {
  return kind === 'plan' ? `plan:${resultKey}` : `${kind}:${resultKey}:${range.from}-${range.to}`;
}

/**
 * 生成一个合法的 `TaskInput`（契约 A.4）。
 * `range` 可以给 `{ from, to }` 或 `[from, to]`；`plan` 任务的 `resultKey` 与 `range` 忽略入参，按契约算。
 */
export function makeTaskInput({
  projectId = 'proj-1', projectRev = 1, kind = 'snapshot', range, tier, resultKey,
  priority, weight, requires, input, derivedFrom, source: extraSource,
} = {}) {
  let r = null;
  let key = resultKey;
  if (kind === 'plan') {
    key = `${projectId}@${projectRev}`;
  } else {
    const unit = kind === 'stream' ? 'segment' : 'localFrame';
    const [from, to] = Array.isArray(range) ? range
      : range ? [range.from, range.to]
        : kind === 'stream' ? [0, 7] : [0, 59];
    r = { unit, from, to };
    key ??= `rk-${projectId}-${projectRev}`;
  }
  const task = {
    id: expectedTaskId({ kind, resultKey: key, range: r }),
    kind,
    resultKey: key,
    range: r,
    source: { projectId, projectRev, ...(derivedFrom !== undefined ? { derivedFrom } : {}), ...(extraSource ?? {}) },
    input: input ?? { clipId: 'clip-1' },
    weight: weight ?? { class: 'medium', estMs: null, frames: r ? r.to - r.from + 1 : null },
    requires: requires ?? {},
  };
  if (kind === 'snapshot') task.tier = tier ?? 'shared';
  else if (tier !== undefined) task.tier = tier;
  if (priority !== undefined) task.priority = priority;
  return task;
}

/* ------------------------------------------------------------ 拼装 */

/**
 * 假时钟 + 收集器 + 一个队列实例，外加常用的小工具。
 * 每个发消息的工具都返回「这一步发出的消息」视图（见 `viewOf`）。
 */
export function createQueueHarness(createRenderQueue, { constants, epoch, start = T0 } = {}) {
  const clock = createFakeClock(start);
  const bus = createMessageCollector();
  const options = { now: clock.now, send: bus.send };
  if (constants !== undefined) options.constants = constants;
  if (epoch !== undefined) options.epoch = epoch;
  const q = createRenderQueue(options);

  const h = {
    q, clock, bus,
    now: () => clock.now(),
    act(fn) { const m = bus.mark(); fn(); return bus.since(m); },
    connect: (connId, principal = { userId: 'u1', tenantId: 't1' }) => h.act(() => q.connect(connId, principal)),
    disconnect: connId => h.act(() => q.disconnect(connId)),
    handle: (connId, message) => h.act(() => q.handle(connId, message)),
    tick: () => h.act(() => q.tick()),
    /** 时钟推进 `ms` 后调一次 `tick()`。 */
    advance(ms) { clock.advance(ms); return h.tick(); },
    /** 时钟设到 `t` 后调一次 `tick()`。 */
    at(t) { clock.set(t); return h.tick(); },

    /** 连上并以节点身份报到；`watch` 不为 `null` 时接着发 `queue.watch`。返回 hello（和 watch）这两步的消息。 */
    node(connId, nodeId, { profile = 'pc', userId = 'u1', tenantId = 't1', resume, watch = 'all', hello = {} } = {}) {
      return h.act(() => {
        q.connect(connId, { userId, tenantId });
        q.handle(connId, { type: 'node.hello', nodeId, profile, ...(resume ? { resume } : {}), ...hello });
        if (watch !== null) q.handle(connId, { type: 'queue.watch', projects: watch });
      });
    },
    /** 已连上的连接再发一次 `node.hello`（重连到新连接用 `node()`）。 */
    hello: (connId, nodeId, { profile = 'pc', resume, ...rest } = {}) =>
      h.handle(connId, { type: 'node.hello', nodeId, profile, ...(resume ? { resume } : {}), ...rest }),
    watch: (connId, projects = 'all') => h.handle(connId, { type: 'queue.watch', projects }),
    publisher(connId, publisherId, { userId = 'u1', tenantId = 't1' } = {}) {
      return h.act(() => {
        q.connect(connId, { userId, tenantId });
        q.handle(connId, { type: 'publisher.hello', publisherId });
      });
    },
    publish: (connId, tasks, extra = {}) => h.handle(connId, { type: 'task.publish', tasks, ...extra }),
    unsubscribe: (connId, fields) => h.handle(connId, { type: 'task.unsubscribe', ...fields }),
    claim: (connId, id, expectVersion, extra = {}) => h.handle(connId, { type: 'task.claim', id, expectVersion, ...extra }),
    progress: (connId, id, token, done, extra = {}) => h.handle(connId, { type: 'task.progress', id, token, done, ...extra }),
    complete: (connId, id, token, result, extra = {}) =>
      h.handle(connId, { type: 'task.complete', id, token, ...(result !== undefined ? { result } : {}), ...extra }),
    release: (connId, id, token, reason, extra = {}) =>
      h.handle(connId, { type: 'task.release', id, token, ...(reason !== undefined ? { reason } : {}), ...extra }),
    fail: (connId, id, token, { error, retryable } = {}, extra = {}) =>
      h.handle(connId, {
        type: 'task.fail', id, token,
        ...(error !== undefined ? { error } : {}), ...(retryable !== undefined ? { retryable } : {}), ...extra,
      }),

    describe: () => q.describe(),
    /** `describe()` 里的某个任务，没有就 `null`。 */
    task: id => q.describe().tasks.find(t => t.id === id) ?? null,
    nodeInfo: nodeId => q.describe().nodes.find(n => n.nodeId === nodeId) ?? null,
    publisherInfo: publisherId => q.describe().publishers.find(p => p.publisherId === publisherId) ?? null,
  };
  return h;
}
