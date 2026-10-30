/**
 * 经文档服务连接取素材票据（契约 `docs/plan/auth-contract.md` 第 8 节 `auth.ticket`、第 11 节）。
 *
 * `createTicketSource(endpoint, { access })` 回一个函数 `ticket({ refresh }?)`，直接交给素材客户端
 * （`server/asset-store/client.mjs` 的 `ticket` 选项）：
 * - 手里的票据剩余有效期不到 1/3 时换新的（计划第 12.2 节「客户端在剩 1/3 时经文档服务连接续签」）；
 * - `refresh: true`（素材服务回了 401）一律换新的；
 * - 连接没连上、服务端拒绝、超时：回 null（请求不带票据，由素材服务回 401）。
 *
 * `endpoint` 是 `createWsEndpoint` 的形状（`send`、`onMessage`），不引任何模块，浏览器也能用。
 */
import { TICKET_TTL } from './protocol.mjs';

let seq = 0;

/**
 * @param {{ send(message: object): boolean, onMessage(handler: (message: object) => void): void }} endpoint
 * @param {object} [options]
 * @param {'r' | 'rw'} [options.access] 缺省 `rw`
 * @param {() => number} [options.now]
 * @param {number} [options.timeoutMs] 等回包的上限，缺省 10 s
 */
export function createTicketSource(endpoint, { access = 'rw', now = Date.now, timeoutMs = 10_000 } = {}) {
  /** reqId → { resolve, timer } */
  const waiting = new Map();
  let current = null; // { ticket, exp }
  let inflight = null;

  endpoint.onMessage((message) => {
    const w = typeof message?.reqId === 'string' ? waiting.get(message.reqId) : undefined;
    if (!w) return;
    waiting.delete(message.reqId);
    clearTimeout(w.timer);
    if (message.type === 'auth.ticket.ok' && typeof message.ticket === 'string' && Number.isFinite(message.exp)) {
      w.resolve({ ticket: message.ticket, exp: message.exp });
    } else {
      w.resolve(null);
    }
  });

  function fetchTicket() {
    const reqId = `ticket-${++seq}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(reqId);
        resolve(null);
      }, timeoutMs);
      timer.unref?.();
      waiting.set(reqId, { resolve, timer });
      if (!endpoint.send({ type: 'auth.ticket', reqId, kind: 'asset', access })) {
        waiting.delete(reqId);
        clearTimeout(timer);
        resolve(null);
      }
    });
  }

  const fresh = (t) => t && t.exp - now() > TICKET_TTL.asset / 3;

  return async function ticket(opts) {
    if (!opts?.refresh && fresh(current)) return current.ticket;
    inflight ??= fetchTicket().then((t) => {
      inflight = null;
      if (t) current = t;
      return t;
    });
    const t = await inflight;
    return t ? t.ticket : null;
  };
}
