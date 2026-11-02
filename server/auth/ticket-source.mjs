/**
 * Obtains asset tickets over document service connection (contract `docs/plan/auth-contract.md`
 * Section 8 `auth.ticket`, Section 11).
 *
 * `createTicketSource(endpoint, { access })` returns a function `ticket({ refresh }?)`, passed
 * directly to the asset client (`ticket` option in `server/asset-store/client.mjs`):
 * - Renew ticket when less than 1/3 validity remains (plan Section 12.2: "client renews via document
 *   service connection when 1/3 remains");
 * - `refresh: true` (asset service returned 401): always fetch a new one;
 * - Connection not established, server rejected, or timeout: returns null (request carries no ticket,
 *   asset service returns 401).
 *
 * `endpoint` has the shape of `createWsEndpoint` (`send`, `onMessage`), imports no modules, and
 * works in browsers too.
 */
import { TICKET_TTL } from './protocol.mjs';

let seq = 0;

/**
 * @param {{ send(message: object): boolean, onMessage(handler: (message: object) => void): void }} endpoint
 * @param {object} [options]
 * @param {'r' | 'rw'} [options.access] Defaults to `rw`
 * @param {() => number} [options.now]
 * @param {number} [options.timeoutMs] Maximum wait time for response, defaults to 10 s
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
