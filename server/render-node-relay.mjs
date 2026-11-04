/**
 * The desktop app automatically becomes a render node for shared projects: relay on the editor
 * process side (for the prerender process side, see `auto-render-node.mjs`).
 *
 * The prerender process is not on the page's HMR channel and has no project credentials.
 * The editor process does two things for it:
 *   1. **Remember and forward shared configuration**: When the page enters a shared project:
 *      `POST /api/render-node/bind { url, projectId, assetBase?, contentId?, ticket? }`,
 *      the editor process records it (tickets are not recorded) and forwards it to the
 *      prerender process (`POST <prerender>/api/frames/render-node`); after the prerender
 *      process crashes and restarts, it forwards what was recorded again (without tickets;
 *      it requests them itself when creating a session). When the page leaves the project or
 *      cancels collaboration: `POST /api/render-node/unbind { projectId }`, forwarded to tear down.
 *   2. **Ticket round-trip**: Each time the prerender process creates a new session, it requests
 *      a new render connection ticket: `POST /api/render-node/ticket-request { projectId }`
 *      (only local requests without Origin are accepted); the editor process sends
 *      `pc:render-node { type: 'ticket', reqId, projectId }` via HMR, the page signs and
 *      returns `POST /api/render-node/ticket { reqId, ticket | error }` over its shared project
 *      connection, and the editor process returns it to the prerender process. When no page is
 *      connected to HMR, it immediately returns "no page" without waiting; if the page does not
 *      return within 10 seconds, it also returns failure. Following the card source sync
 *      approach (`vite-plugin-cards.ts`).
 * Tickets do not enter logs or diagnostics.
 */

export const TICKET_WAIT_MS = 10_000;
const REQ_ID_MAX = 64;

/**
 * @param {object} deps
 * @param {(data: object) => void} deps.send  Sent to page via HMR (`pc:render-node` data)
 * @param {() => boolean} [deps.hasPage]  Whether a page is connected to HMR right now; assumed true if omitted
 * @param {number} [deps.timeoutMs]
 * @param {Function} [deps.setTimer]
 * @param {Function} [deps.clearTimer]
 */
export function createTicketRelay({ send, hasPage = () => true, timeoutMs = TICKET_WAIT_MS, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let seq = 0;
  const waiting = new Map();
  const counters = { requests: 0, answered: 0, failed: 0, noPage: 0, timeouts: 0 };

  function request(projectId) {
    counters.requests++;
    if (!hasPage()) {
      counters.noPage++;
      return Promise.reject(Object.assign(new Error('No page is connected to the editor, so a connection ticket cannot be obtained'), { code: 'no-page' }));
    }
    return new Promise((resolve, reject) => {
      const reqId = `rn${++seq}`;
      const timer = setTimer(() => {
        if (!waiting.delete(reqId)) return;
        counters.timeouts++;
        reject(Object.assign(new Error(`The page did not return a connection ticket within ${Math.round(timeoutMs / 1000)} seconds`), { code: 'timeout' }));
      }, timeoutMs);
      timer?.unref?.();
      waiting.set(reqId, { resolve, reject, timer, projectId });
      try {
        send({ type: 'ticket', reqId, projectId });
      } catch (error) {
        waiting.delete(reqId);
        clearTimer(timer);
        reject(error);
      }
    });
  }

  /** Page submitted back: returns true = someone is waiting for this ticket */
  function answer(input) {
    const reqId = typeof input?.reqId === 'string' && input.reqId.length <= REQ_ID_MAX ? input.reqId : null;
    const w = reqId ? waiting.get(reqId) : undefined;
    if (!w) return false;
    waiting.delete(reqId);
    clearTimer(w.timer);
    const t = input.ticket;
    if (typeof t === 'string' && t.length > 0 && t.length <= 2048 && !/\s/.test(t)) {
      counters.answered++;
      w.resolve(t);
    } else {
      counters.failed++;
      w.reject(Object.assign(new Error(typeof input.error === 'string' ? `Page failed to sign a ticket: ${input.error.slice(0, 200)}` : 'The ticket returned by the page is invalid'), { code: 'page-refused' }));
    }
    return true;
  }

  return { request, answer, pending: () => waiting.size, stats: () => ({ ...counters, pending: waiting.size }) };
}

/**
 * Shared configuration remembered by editor process (tickets not stored). `bind` returns normalized
 * configuration; `unbind` only removes the same project when projectId is provided.
 */
export function createBindingMemory() {
  let binding = null;
  return {
    set(b) { binding = b ? { url: b.url, projectId: b.projectId, assetBase: b.assetBase ?? null, contentId: b.contentId ?? null } : null; return binding; },
    clear(projectId = null) {
      if (!binding) return false;
      if (projectId !== null && projectId !== binding.projectId) return false;
      binding = null;
      return true;
    },
    get: () => (binding ? { ...binding } : null),
  };
}
