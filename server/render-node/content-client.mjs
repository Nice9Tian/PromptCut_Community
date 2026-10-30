/**
 * 内容库客户端（C6.4，契约 `docs/plan/manifest-contract.md` 第 2 节；服务端协议见
 * `docs/plan/docservice-contract.md` 第 2 节）。
 *
 * 和节点共用同一条 M5a 的 `WsEndpoint`（`createWsEndpoint` 的返回值），在它上面发
 * `content.put` / `content.get` / `content.list`，按 `reqId` 配回包：
 *   - 每个请求带本实例唯一的 `reqId`（`content#<实例号>-<序号>`，不会和 local-node 的
 *     `<publisherId>#publish-<n>` 撞上）；别的 `reqId` 的消息一律不理；
 *   - 同一 `reqId` 回 `error` 就拒绝，错误带 `reason`（`code` 与它相同）与 `detail`；
 *   - 过了 `timeoutMs` 还没回包就拒绝，`code: 'timeout'`，迟到的回包丢弃；
 *   - 发不出去（未连上）或连接断开时，在途请求立即以 `code: 'disconnected'` 失败，不重放。
 *
 * 只依赖 Node 内置模块（守门测试 `render-node-deps` D1）；计时器可注入，测试不必真等。
 */
import { randomUUID } from 'node:crypto';

export const CONTENT_CLIENT_DEFAULTS = Object.freeze({ timeoutMs: 10_000 });

/** 每种请求期望的回包类型 */
const REPLY_TYPE = Object.freeze({
  'content.put': 'content.stored',
  'content.get': 'content.item',
  'content.list': 'content.listing',
});

/**
 * @param {string} code
 * @param {string} message
 * @param {object} [extra]
 */
function clientError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.reason = extra.reason ?? code;
  if (extra.detail !== undefined) error.detail = extra.detail;
  return error;
}

/**
 * @typedef {object} ContentClient
 * @property {(kind: string, key: string, body: any) => Promise<{ hash: string, rev?: number }>} put
 * @property {(kind: string, key: string) => Promise<{ body: any, hash: string, rev?: number } | null>} get  没有就回 null
 * @property {(kind: string, prefix?: string) => Promise<{ items: Array<{ key: string, hash: string, rev?: number }>, truncated: boolean }>} list
 * @property {() => number} pending  在途请求数（诊断用）
 */

/**
 * @param {import('./ws-transport.mjs').WsEndpoint} endpoint
 * @param {object} [options]
 * @param {number} [options.timeoutMs]  单个请求等回包的上限，缺省 10 s
 * @param {(fn: () => void, ms: number) => any} [options.setTimeout]
 * @param {(handle: any) => void} [options.clearTimeout]
 * @returns {ContentClient}
 */
export function createContentClient(endpoint, {
  timeoutMs = CONTENT_CLIENT_DEFAULTS.timeoutMs,
  setTimeout: setTimer = globalThis.setTimeout,
  clearTimeout: clearTimer = globalThis.clearTimeout,
} = {}) {
  if (!endpoint || typeof endpoint.send !== 'function' || typeof endpoint.onMessage !== 'function') {
    throw new TypeError('createContentClient：endpoint 必须有 send 与 onMessage');
  }
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new TypeError('createContentClient：timeoutMs 必须是正数');
  }

  const instance = randomUUID().slice(0, 8);
  let seq = 0;
  /** reqId → { type, resolve, reject, timer } */
  const inflight = new Map();

  function settle(reqId) {
    const entry = inflight.get(reqId);
    if (!entry) return null;
    inflight.delete(reqId);
    clearTimer(entry.timer);
    return entry;
  }

  endpoint.onMessage((message) => {
    const reqId = message?.reqId;
    if (typeof reqId !== 'string' || !inflight.has(reqId)) return;
    const entry = settle(reqId);
    if (message.type === 'error') {
      const reason = typeof message.reason === 'string' ? message.reason : 'error';
      entry.reject(clientError(reason, `内容库 ${entry.type} 失败：${reason}`, { reason, detail: message.detail }));
      return;
    }
    if (message.type !== REPLY_TYPE[entry.type]) {
      entry.reject(clientError('bad-reply', `内容库 ${entry.type} 回了意外的 ${String(message.type)}`));
      return;
    }
    entry.resolve(message);
  });

  if (typeof endpoint.onClose === 'function') {
    endpoint.onClose(() => {
      for (const reqId of [...inflight.keys()]) {
        const entry = settle(reqId);
        entry.reject(clientError('disconnected', `内容库 ${entry.type}：连接已断开`));
      }
    });
  }

  function request(type, fields) {
    return new Promise((resolve, reject) => {
      const reqId = `content#${instance}-${++seq}`;
      const message = { type, ...fields, reqId };
      try {
        JSON.stringify(message);
      } catch {
        reject(clientError('bad-message', `内容库 ${type}：消息无法序列化`));
        return;
      }
      const timer = setTimer(() => {
        const entry = settle(reqId);
        if (entry) entry.reject(clientError('timeout', `内容库 ${type}：${timeoutMs} ms 内没有回包`));
      }, timeoutMs);
      timer?.unref?.();
      inflight.set(reqId, { type, resolve, reject, timer });
      let sent = false;
      try {
        sent = endpoint.send(message) !== false;
      } catch {
        sent = false;
      }
      // 端点可能在 send 里同步收到回包（测试替身），这时已经 settle 过了
      if (!sent && inflight.has(reqId)) {
        settle(reqId);
        reject(clientError('disconnected', `内容库 ${type}：连接未就绪，没有发出`));
      }
    });
  }

  const withRev = (out, message) => {
    if (typeof message.rev === 'number') out.rev = message.rev;
    return out;
  };

  return {
    async put(kind, key, body) {
      const reply = await request('content.put', { kind, key, body });
      return withRev({ hash: reply.hash }, reply);
    },
    async get(kind, key) {
      const reply = await request('content.get', { kind, key });
      if (reply.missing === true) return null;
      return withRev({ body: reply.body, hash: reply.hash }, reply);
    },
    async list(kind, prefix) {
      const fields = { kind };
      if (prefix !== undefined) fields.prefix = prefix;
      const reply = await request('content.list', fields);
      return { items: Array.isArray(reply.items) ? reply.items : [], truncated: reply.truncated === true };
    },
    pending() {
      return inflight.size;
    },
  };
}
