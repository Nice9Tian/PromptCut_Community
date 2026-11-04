/**
 * For testing and in-process integration only; production code must not import this.
 *
 * In-process loopback transport (contract `docs/plan/render-queue-contract.md` D.3): connects a
 * `createRenderQueue` instance with several "endpoints" (one connection each for page and local
 * node), replacing WebSocket from M5 onward.
 *
 * - Messages in both directions enter the same FIFO queue: `in` (endpoint → queue) is delivered to
 *   `queue.handle`, `out` (queue → endpoint) is delivered to the endpoint's handler;
 * - Never invokes synchronous callbacks directly: `send` only enqueues, and all delivery goes
 *   through `flush`, with deterministic order and no reentrancy;
 * - When `serialize` is enabled, performs a JSON round-trip before enqueuing so the recipient gets
 *   the wire shape; additionally, every message is checked before enqueuing for "whether it can
 *   round-trip through JSON", and those that cannot are recorded in `nonJson()` (asserted empty in
 *   tests);
 * - During `partition(connId)`, messages in both directions on this connection are dropped (checked
 *   both at enqueue time and delivery time); restored by `heal`;
 * - Exceptions thrown by endpoint handlers (and `queue.handle`) are not rethrown, but recorded in
 *   `errors()` (asserted empty in tests).
 *
 * Usage:
 *
 *   const lb = createLoopback();
 *   const queue = createRenderQueue({ now, send: lb.queueSend });
 *   lb.attach(queue);
 *   const ep = lb.connect('conn-1', { userId: 'u1', tenantId: 't1' });
 *   ep.onMessage(m => …); ep.send({ type: 'publisher.hello', publisherId: 'P' });
 *   lb.flush();
 */

/**
 * Finds places in a value that change after a JSON round-trip; returns `null` if none found.
 * An object property value of `undefined` is treated as "field does not exist" (JSON drops it,
 * semantics unchanged) and is not considered an issue; `undefined` in arrays (becomes `null`),
 * functions, Symbols, BigInts, non-finite numbers, `-0`, non-plain objects such as Map / Set /
 * Date, and circular references are all considered issues.
 */
export function jsonProblem(value, path = '$', seen = new Set()) {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return null;
    case 'number':
      if (!Number.isFinite(value)) return `${path} is a non-finite number ${value}`;
      if (Object.is(value, -0)) return `${path} is -0`;
      return null;
    case 'undefined':
      return `${path} is undefined`;
    case 'object':
      break;
    default:
      return `${path} has type ${typeof value}`;
  }
  if (seen.has(value)) return `${path} has a circular reference`;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const p = jsonProblem(value[i], `${path}[${i}]`, seen);
        if (p) return p;
      }
      return null;
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return `${path} is not a plain object (${value?.constructor?.name ?? 'no constructor'})`;
    for (const key of Object.keys(value)) {
      if (value[key] === undefined) continue;
      const p = jsonProblem(value[key], `${path}.${key}`, seen);
      if (p) return p;
    }
    return null;
  } finally {
    seen.delete(value);
  }
}

export function createLoopback({ serialize = true } = {}) {
  let queue = null;
  /** Pending delivery: { dir, connId, endpoint, message }; endpoint is the endpoint object corresponding to this connId at enqueue time */
  let items = [];
  /** connId → current endpoint (the one from the most recent connect) */
  const endpoints = new Map();
  const partitioned = new Set();
  const delivered = [];
  const errors = [];
  const nonJson = [];

  function prepare(dir, connId, message) {
    const problem = jsonProblem(message);
    if (problem) nonJson.push({ dir, connId, type: message?.type, problem });
    if (!serialize) return message;
    try {
      return JSON.parse(JSON.stringify(message));
    } catch (error) {
      // Cannot even pass stringify (BigInt, circular reference): record it and deliver as is to avoid hiding the issue
      nonJson.push({ dir, connId, type: message?.type, problem: `JSON.stringify threw: ${error.message}` });
      return message;
    }
  }

  /** Passed in as `send` for `createRenderQueue`: queue → endpoint */
  function queueSend(connId, message) {
    const endpoint = endpoints.get(connId);
    // Connection does not exist, endpoint closed, or partitioned: drop (would not arrive over a real WebSocket either)
    if (!endpoint || endpoint.closed || partitioned.has(connId)) return;
    items.push({ dir: 'out', connId, endpoint, message: prepare('out', connId, message) });
  }

  function attach(q) {
    if (queue && queue !== q) {
      // Changing queue = queue restart: invalidate all connections on the old queue and drop pending messages
      for (const ep of endpoints.values()) ep._kill();
      items = [];
    }
    queue = q;
  }

  function connect(connId, principal) {
    if (!queue) throw new Error('createLoopback: call attach(queue) before connect');
    const old = endpoints.get(connId);
    if (old && !old.closed) old._kill();
    // A duplicate connect with the same connId on the queue side will first handle the old one as disconnected (contract A.3)
    queue.connect(connId, principal);
    const handlers = [];
    let closed = false;
    const endpoint = {
      connId,
      send(message) {
        if (closed || partitioned.has(connId)) return;
        items.push({ dir: 'in', connId, endpoint, message: prepare('in', connId, message) });
      },
      onMessage(handler) {
        if (typeof handler !== 'function') throw new TypeError('onMessage: handler must be a function');
        handlers.push(handler);
      },
      /** Disconnect: calls `queue.disconnect`, and drops undelivered messages on this connection (in both directions) */
      close() {
        if (closed) return;
        closed = true;
        items = items.filter(item => item.endpoint !== endpoint);
        if (endpoints.get(connId) === endpoint) queue.disconnect(connId);
      },
      get closed() { return closed; },
      /** Internal: connection replaced or queue restarted, no longer notifies queue */
      _kill() {
        closed = true;
        items = items.filter(item => item.endpoint !== endpoint);
      },
      _deliver(message) {
        for (const handler of handlers) {
          try { handler(message); } catch (error) { errors.push(error); }
        }
      },
    };
    endpoints.set(connId, endpoint);
    return endpoint;
  }

  /** Delivers all pending messages in enqueue order (including newly produced ones during delivery); throws if exceeding `max` items (livelock prevention). Returns delivered count. */
  function flush(max = 100_000) {
    let count = 0;
    while (items.length > 0) {
      const item = items.shift();
      const { dir, connId, endpoint, message } = item;
      // Check again before delivery: messages that were partitioned, closed, or replaced after enqueueing will likewise not arrive
      if (endpoint.closed || partitioned.has(connId) || endpoints.get(connId) !== endpoint) continue;
      if (++count > max) {
        items.unshift(item);
        throw new Error(`loopback.flush: still not converged after delivering more than ${max} messages (suspected livelock)`);
      }
      delivered.push({ dir, connId, message });
      if (dir === 'in') {
        try { queue.handle(connId, message); } catch (error) { errors.push(error); }
      } else {
        endpoint._deliver(message);
      }
    }
    return count;
  }

  return {
    queueSend,
    attach,
    connect,
    flush,
    pending: () => items.length,
    partition(connId) { partitioned.add(connId); },
    heal(connId) { partitioned.delete(connId); },
    /** Delivered records (in delivery order): `[{ dir: 'in' | 'out', connId, message }]` */
    log: () => delivered.slice(),
    /** Exceptions thrown by endpoint handlers or `queue.handle` */
    errors: () => errors.slice(),
    /** Messages that cannot round-trip through JSON: `[{ dir, connId, type, problem }]` */
    nonJson: () => nonJson.slice(),
  };
}
