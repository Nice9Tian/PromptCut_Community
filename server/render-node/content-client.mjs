/**
 * Content store client (C6.4, Section 2 of contract `docs/plan/manifest-contract.md`;
 * see Section 2 of `docs/plan/docservice-contract.md` for server protocol).
 *
 * Shares the same M5a `WsEndpoint` (return value of `createWsEndpoint`) with the node,
 * sending `content.put` / `content.get` / `content.list` over it and matching responses by `reqId`:
 *   - Each request carries an instance-unique `reqId` (`content#<instanceId>-<seq>`, which will
 *     not collide with `<publisherId>#publish-<n>` from local-node); messages with other
 *     `reqId` values are ignored;
 *   - Rejects if the same `reqId` returns `error`, where the error carries `reason` (same as
 *     `code`) and `detail`;
 *   - Rejects if no response is received after `timeoutMs`, with `code: 'timeout'`, discarding
 *     late responses;
 *   - If unable to send (not connected) or connection is lost, in-flight requests fail immediately
 *     with `code: 'disconnected'` without replay.
 *
 * Relies only on Node built-in modules (gatekeeper test `render-node-deps` D1); timers can be
 * injected so tests do not need to wait in real time.
 */
import { randomUUID } from 'node:crypto';

export const CONTENT_CLIENT_DEFAULTS = Object.freeze({ timeoutMs: 10_000 });

/** Expected response type for each request */
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
 * @property {(kind: string, key: string) => Promise<{ body: any, hash: string, rev?: number } | null>} get  Returns null if not found
 * @property {(kind: string, prefix?: string) => Promise<{ items: Array<{ key: string, hash: string, rev?: number }>, truncated: boolean }>} list
 * @property {() => number} pending  In-flight request count (for diagnostics)
 */

/**
 * @param {import('./ws-transport.mjs').WsEndpoint} endpoint
 * @param {object} [options]
 * @param {number} [options.timeoutMs]  Maximum wait for a single request response, defaults to 10 s
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
    throw new TypeError('createContentClient: endpoint must have send and onMessage');
  }
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new TypeError('createContentClient: timeoutMs must be a positive number');
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
      entry.reject(clientError(reason, `Content store ${entry.type} failed: ${reason}`, { reason, detail: message.detail }));
      return;
    }
    if (message.type !== REPLY_TYPE[entry.type]) {
      entry.reject(clientError('bad-reply', `Content store ${entry.type} returned an unexpected ${String(message.type)}`));
      return;
    }
    entry.resolve(message);
  });

  if (typeof endpoint.onClose === 'function') {
    endpoint.onClose(() => {
      for (const reqId of [...inflight.keys()]) {
        const entry = settle(reqId);
        entry.reject(clientError('disconnected', `Content store ${entry.type}: connection closed`));
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
        reject(clientError('bad-message', `Content store ${type}: message cannot be serialized`));
        return;
      }
      const timer = setTimer(() => {
        const entry = settle(reqId);
        if (entry) entry.reject(clientError('timeout', `Content store ${type}: no reply within ${timeoutMs} ms`));
      }, timeoutMs);
      timer?.unref?.();
      inflight.set(reqId, { type, resolve, reject, timer });
      let sent = false;
      try {
        sent = endpoint.send(message) !== false;
      } catch {
        sent = false;
      }
      // Endpoint may receive a response synchronously inside send (test double); it has already settled by then
      if (!sent && inflight.has(reqId)) {
        settle(reqId);
        reject(clientError('disconnected', `Content store ${type}: connection not ready, nothing sent`));
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
