/**
 * Fakes for testing render queue (M1). Contract: `docs/plan/render-queue-contract.md` Section C.
 *
 * - Fake clock: `now()`, `advance(ms)`, `set(t)`;
 * - Message collector: bucketed by `connId`, filtered by `type`, `clear()`; also `mark()` / `since()`
 *   to retrieve messages sent during a specific step;
 * - Helper for building `TaskInput`: generates valid task input given `projectId`, `projectRev`,
 *   `kind`, `range`;
 * - `createQueueHarness`: combines the three above with `createRenderQueue`, plus utilities for
 *   connecting, checking in, and sending messages.
 *
 * This file does not import implementations: the first argument of `createQueueHarness` is passed
 * `createRenderQueue` by the caller, so node session tests can also run it against real queues or
 * other fake queues. Task ids are calculated here on its own per contract A.4 (`expectedTaskId`)
 * without relying on the implementation's `taskIdOf`, avoiding correlated errors on both sides.
 */
import assert from 'node:assert/strict';

/** Starting time for tests. Does not start from 0 to prevent implementations with constructs like `if (t)` from misinterpreting 0 as "absent". */
export const T0 = 1_000_000;

/* ------------------------------------------------------------ Fake clock */

export function createFakeClock(start = T0) {
  let t = start;
  return {
    now: () => t,
    advance(ms) { t += ms; return t; },
    set(v) { t = v; return t; },
  };
}

/* ------------------------------------------------------------ Message collector */

/** Wire transport shape: outbound messages must pass JSON. Stored via a JSON round-trip here; fields with `undefined` values disappear. */
const wire = message => JSON.parse(JSON.stringify(message));

const matchType = (type, message) => type === undefined
  || (Array.isArray(type) ? type.includes(message?.type) : message?.type === type);

/** Read-only view over a set of `{ seq, connId, message }`. */
function viewOf(entries) {
  const of = (connId, type) => entries.filter(e => e.connId === connId && matchType(type, e.message)).map(e => e.message);
  return {
    entries,
    get count() { return entries.length; },
    messages: () => entries.map(e => e.message),
    /** Messages sent to `connId` (filterable by `type`; `type` can be an array). */
    of,
    /** Message types sent to `connId`, in send order. */
    types: connId => of(connId).map(m => m.type),
    /** Message types sent to `connId`, sorted (used when contract specifies no order within the same step). */
    sortedTypes: connId => of(connId).map(m => m.type).sort(),
    /** Connections that have received messages. */
    conns: () => [...new Set(entries.map(e => e.connId))].sort(),
    /** All messages of a given type, across connections: `[{ connId, message }]`. */
    ofType: type => entries.filter(e => matchType(type, e.message)).map(e => ({ connId: e.connId, message: e.message })),
    last: (connId, type) => of(connId, type).at(-1),
    /** Exactly one `type` message was sent to `connId`; returns it. */
    one(connId, type) {
      const list = of(connId, type);
      assert.equal(list.length, 1, `expected exactly one ${type} for ${connId}, got ${list.length}; all messages sent in this step: ${JSON.stringify(entries.map(e => [e.connId, e.message]))}`);
      return list[0];
    },
    /** Nothing was sent in this step. */
    assertSilent(what = 'this step') {
      assert.equal(entries.length, 0, `${what}: expected no messages to be sent, got: ${JSON.stringify(entries.map(e => [e.connId, e.message]))}`);
    },
  };
}

export function createMessageCollector() {
  let log = [];
  let seq = 0;
  const send = (connId, message) => { log.push({ seq: seq++, connId, message: wire(message) }); };
  const collector = {
    send,
    /** Current cursor; used with `since` to retrieve messages sent afterward. */
    mark: () => seq,
    since: mark => viewOf(log.filter(e => e.seq >= mark)),
    all: () => viewOf(log.slice()),
    clear() { log = []; },
  };
  // Collector itself also has view methods (operating on all uncleared messages)
  for (const k of ['of', 'types', 'sortedTypes', 'conns', 'ofType', 'last', 'one']) {
    collector[k] = (...args) => viewOf(log)[k](...args);
  }
  Object.defineProperty(collector, 'count', { get: () => log.length });
  return collector;
}

/* ------------------------------------------------------------ Build task input */

/** Task id per contract A.4, calculated by the test itself. */
export function expectedTaskId({ kind, resultKey, range }) {
  return kind === 'plan' ? `plan:${resultKey}` : `${kind}:${resultKey}:${range.from}-${range.to}`;
}

/**
 * Generates a valid `TaskInput` (contract A.4).
 * `range` can be `{ from, to }` or `[from, to]`; for `plan` tasks, `resultKey` and `range` ignore
 * input parameters and are computed per contract.
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

/* ------------------------------------------------------------ Assembly */

/**
 * Fake clock + collector + a queue instance, plus common utilities.
 * Each message-sending helper returns a view of "messages sent in this step" (see `viewOf`).
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
    /** Advances the clock by `ms`, then calls `tick()` once. */
    advance(ms) { clock.advance(ms); return h.tick(); },
    /** Sets the clock to `t`, then calls `tick()` once. */
    at(t) { clock.set(t); return h.tick(); },

    /** Connects and checks in as a node; if `watch` is not `null`, sends `queue.watch`. Returns messages from hello (and watch). */
    node(connId, nodeId, { profile = 'pc', userId = 'u1', tenantId = 't1', resume, watch = 'all', hello = {} } = {}) {
      return h.act(() => {
        q.connect(connId, { userId, tenantId });
        q.handle(connId, { type: 'node.hello', nodeId, profile, ...(resume ? { resume } : {}), ...hello });
        if (watch !== null) q.handle(connId, { type: 'queue.watch', projects: watch });
      });
    },
    /** Sends `node.hello` again on an existing connection (use `node()` to reconnect to a new connection). */
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
    /** A task in `describe()`, or `null` if none. */
    task: id => q.describe().tasks.find(t => t.id === id) ?? null,
    nodeInfo: nodeId => q.describe().nodes.find(n => n.nodeId === nodeId) ?? null,
    publisherInfo: publisherId => q.describe().publishers.find(p => p.publisherId === publisherId) ?? null,
  };
  return h;
}
