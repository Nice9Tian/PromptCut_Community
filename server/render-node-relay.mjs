/**
 * 桌面应用自动成为共享项目的渲染节点 —— 编辑器进程一侧的中转(预渲染进程一侧见 `auto-render-node.mjs`)。
 *
 * 预渲染进程不在页面的 HMR 通道上,也没有项目凭证。编辑器进程替它做两件事:
 *   1. **记住并转交共享配置**:页面进入共享项目时 `POST /api/render-node/bind { url, projectId, assetBase?, contentId?, ticket? }`,
 *      编辑器进程记下(票据不记)并转给预渲染进程(`POST <预渲染>/api/frames/render-node`);预渲染进程崩溃重启后照记下的再转一次
 *      (不带票据,它建会话时自己来要)。页面离开项目或取消协作时 `POST /api/render-node/unbind { projectId }`,转过去撤掉。
 *   2. **票据往返**:预渲染进程每次建新会话要一张新的 render 连接票据:`POST /api/render-node/ticket-request { projectId }`
 *      (只认不带 Origin 的本机请求),编辑器进程经 HMR 发 `pc:render-node { type: 'ticket', reqId, projectId }`,
 *      页面在自己的共享项目连接上签好 `POST /api/render-node/ticket { reqId, ticket | error }` 交回,编辑器进程再回给预渲染进程。
 *      没有页面连着 HMR 时立即回「没有页面」,不空等;页面 10 秒内没交回也回失败。照卡片源码同步的做法(`vite-plugin-cards.ts`)。
 * 票据不进日志、不进诊断。
 */

export const TICKET_WAIT_MS = 10_000;
const REQ_ID_MAX = 64;

/**
 * @param {object} deps
 * @param {(data: object) => void} deps.send  经 HMR 发给页面(`pc:render-node` 的 data)
 * @param {() => boolean} [deps.hasPage]  此刻有没有页面连着 HMR;没给当作有
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
      return Promise.reject(Object.assign(new Error('没有页面连着编辑器,要不到连接票据'), { code: 'no-page' }));
    }
    return new Promise((resolve, reject) => {
      const reqId = `rn${++seq}`;
      const timer = setTimer(() => {
        if (!waiting.delete(reqId)) return;
        counters.timeouts++;
        reject(Object.assign(new Error(`页面 ${Math.round(timeoutMs / 1000)} 秒内没有交回连接票据`), { code: 'timeout' }));
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

  /** 页面交回:回 true = 有人在等这张 */
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
      w.reject(Object.assign(new Error(typeof input.error === 'string' ? `页面没签出票据:${input.error.slice(0, 200)}` : '页面交回的票据不合格'), { code: 'page-refused' }));
    }
    return true;
  }

  return { request, answer, pending: () => waiting.size, stats: () => ({ ...counters, pending: waiting.size }) };
}

/**
 * 编辑器进程记着的共享配置(票据不记)。`bind` 回规整后的配置;`unbind` 给了 projectId 时只撤同一个项目的。
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
