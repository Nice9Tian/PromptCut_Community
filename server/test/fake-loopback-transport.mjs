/**
 * 仅供测试与进程内集成，生产代码不得引用。
 *
 * 进程内的环回传输（契约 `docs/plan/render-queue-contract.md` D.3）：把一个 `createRenderQueue` 实例和若干
 * 「端点」（页面、本机节点各一条连接）接在一起，代替 M5 起的 WebSocket。
 *
 * - 两个方向的消息进同一个先进先出队列：`in`（端点 → 队列）投给 `queue.handle`，`out`（队列 → 端点）投给
 *   端点的处理器；
 * - 从不直接同步回调：`send` 只入队，全部经 `flush` 投递，顺序确定、不重入；
 * - `serialize` 时入队前做一次 JSON 往返，收件方拿到的是线上形状；另外每条消息入队前都检查一遍
 *   「能不能 JSON 往返」，不能的记进 `nonJson()`（测试断言为空）；
 * - `partition(connId)` 期间这条连接双向的消息都丢弃（入队时和投递时都判），`heal` 恢复；
 * - 端点处理器（以及 `queue.handle`）抛出的异常不往外抛，记进 `errors()`，测试断言为空。
 *
 * 用法：
 *
 *   const lb = createLoopback();
 *   const queue = createRenderQueue({ now, send: lb.queueSend });
 *   lb.attach(queue);
 *   const ep = lb.connect('conn-1', { userId: 'u1', tenantId: 't1' });
 *   ep.onMessage(m => …); ep.send({ type: 'publisher.hello', publisherId: 'P' });
 *   lb.flush();
 */

/**
 * 找出一个值里 JSON 往返后会变样的地方，找不到回 `null`。
 * 对象属性值为 `undefined` 视为「没有这个字段」（JSON 丢掉它，语义不变），不算问题；
 * 数组里的 `undefined`（会变 `null`）、函数、Symbol、BigInt、非有限数、`-0`、Map / Set / Date 之类的
 * 非普通对象、循环引用都算问题。
 */
export function jsonProblem(value, path = '$', seen = new Set()) {
  if (value === null) return null;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return null;
    case 'number':
      if (!Number.isFinite(value)) return `${path} 是非有限数 ${value}`;
      if (Object.is(value, -0)) return `${path} 是 -0`;
      return null;
    case 'undefined':
      return `${path} 是 undefined`;
    case 'object':
      break;
    default:
      return `${path} 的类型是 ${typeof value}`;
  }
  if (seen.has(value)) return `${path} 有循环引用`;
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
    if (proto !== Object.prototype && proto !== null) return `${path} 不是普通对象（${value?.constructor?.name ?? '无构造器'}）`;
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
  /** 待投递：{ dir, connId, endpoint, message }；endpoint 是入队那一刻这条 connId 对应的端点对象 */
  let items = [];
  /** connId → 当前端点（最近一次 connect 的那个） */
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
      // 连 stringify 都过不了（BigInt、循环引用）：记下来，原样投递，免得把问题藏起来
      nonJson.push({ dir, connId, type: message?.type, problem: `JSON.stringify 抛出：${error.message}` });
      return message;
    }
  }

  /** 作为 `createRenderQueue` 的 `send` 传入：队列 → 端点 */
  function queueSend(connId, message) {
    const endpoint = endpoints.get(connId);
    // 没有这条连接、端点已关、或分区中：丢弃（真的 WebSocket 上也到不了）
    if (!endpoint || endpoint.closed || partitioned.has(connId)) return;
    items.push({ dir: 'out', connId, endpoint, message: prepare('out', connId, message) });
  }

  function attach(q) {
    if (queue && queue !== q) {
      // 换队列 = 队列重启：旧队列上的连接全部作废，待投的消息丢弃
      for (const ep of endpoints.values()) ep._kill();
      items = [];
    }
    queue = q;
  }

  function connect(connId, principal) {
    if (!queue) throw new Error('createLoopback: 先 attach(queue) 再 connect');
    const old = endpoints.get(connId);
    if (old && !old.closed) old._kill();
    // 队列那边同一 connId 重复 connect 会先按断开处理旧的（契约 A.3）
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
        if (typeof handler !== 'function') throw new TypeError('onMessage: handler 必须是函数');
        handlers.push(handler);
      },
      /** 断开：调 `queue.disconnect`，并丢弃这条连接还没投递的消息（两个方向都丢） */
      close() {
        if (closed) return;
        closed = true;
        items = items.filter(item => item.endpoint !== endpoint);
        if (endpoints.get(connId) === endpoint) queue.disconnect(connId);
      },
      get closed() { return closed; },
      /** 内部：连接被取代或队列重启，不再通知队列 */
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

  /** 按入队顺序投递所有待投消息（含投递中新产生的）；超过 `max` 条抛错（防活锁）。返回投递条数。 */
  function flush(max = 100_000) {
    let count = 0;
    while (items.length > 0) {
      const item = items.shift();
      const { dir, connId, endpoint, message } = item;
      // 投递前再判一次：入队之后才分区、关闭或被取代的，同样到不了
      if (endpoint.closed || partitioned.has(connId) || endpoints.get(connId) !== endpoint) continue;
      if (++count > max) {
        items.unshift(item);
        throw new Error(`loopback.flush：投递超过 ${max} 条仍未收敛（疑似活锁）`);
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
    /** 已投递的记录（按投递顺序）：`[{ dir: 'in' | 'out', connId, message }]` */
    log: () => delivered.slice(),
    /** 端点处理器、`queue.handle` 抛出的异常 */
    errors: () => errors.slice(),
    /** 不能 JSON 往返的消息：`[{ dir, connId, type, problem }]` */
    nonJson: () => nonJson.slice(),
  };
}
