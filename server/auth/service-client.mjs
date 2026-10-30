/**
 * 托管方服务一侧的客户端：凭服务私钥连文档服务的**控制连接**，看目录、核验委托、换票据
 * （契约 `docs/plan/hosted-render-contract.md` 第 1.2、1.3 节，`docs/plan/cloud-agent-contract.md` 第 4.3、16 节；
 * 写进了 `docs/plan/auth-contract.md` 第 17 节）。云端 Agent 服务用它；别的托管方服务（服务名不同）同样能用。
 *
 * ```js
 * const client = createServiceClient({ base: 'ws://127.0.0.1:8787', key: readServiceKeyFile(dir), log });
 * await client.ready();                                   // 控制连接连上（断了自己重连）
 * client.watch({ onProjects, onProject });                // 目录：完整清单与之后的每次变化（重连后自动重订）
 * const who = await client.verifyDelegation(委托票据);     // { ok: true, projectId, userId, username, acc, ownerKey, … } | { ok: false, reason }
 * const t = await client.memberTicket({ projectId, conversation, conversationId, delegation: 对话委托 });
 * const protocols = client.dataProtocols(t.ticket);       // 交给数据连接（`promptcut.ticket.<票据>`）
 * const p = await client.publishTicket(projectId);        // 只用来发布预渲染重试计划的连接票据
 * await client.demand(projectId, holdMs);                 // 声明「这个项目有活要别的托管方服务做」
 * client.close();
 * ```
 *
 * - 控制连接只认本机发起（文档服务那一侧判），所以 `base` 是同机回环地址。
 * - 每次建连取一次挑战、签一次（`nonce` 只能用一次）；连接断了按 `reconnectMs` 退避重连。断开期间的请求立刻回
 *   `{ ok: false, reason: 'unavailable' }`，不排队：调用方（Agent 服务）据此不接新对话。
 * - 请求按 `reqId` 配对；超时回 `{ ok: false, reason: 'timeout' }`。回包里的 `error { reason }` 原样带回，不抛错。
 * - 私钥、签名、`nonce`、委托、票据的原文不进日志：日志只有事件名、服务名、原因码、项目 id。
 *
 * 只用 Node 内置能力（全局 `WebSocket`、`fetch`），可注入。
 */
import { PROTOCOL, TICKET_PREFIX } from './protocol.mjs';
import { buildServiceProtocols, readServiceKeyFile } from './service-identity.mjs';

export const SERVICE_CLIENT_DEFAULTS = Object.freeze({
  requestTimeoutMs: 10_000,
  connectTimeoutMs: 10_000,
  reconnectMs: [200, 500, 1000, 2000, 5000],
});

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `http(s)://…` → `ws(s)://…`；已经是 ws 的原样 */
function wsUrlOf(base) {
  const u = new URL(base);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  return u.toString();
}

/** 数据连接握手用的子协议 */
export const ticketProtocols = (ticket) => [PROTOCOL, TICKET_PREFIX + ticket];

/**
 * @param {object} options
 * @param {string} options.base 文档服务地址（`ws://127.0.0.1:8787` 或 `http://…`）
 * @param {{ service, kid, priv, instanceId, instanceName }} [options.key] `readServiceKeyFile` 的结果
 * @param {string} [options.keyFile] 私钥文件或它所在的目录（没给 `key` 时读它）
 * @param {typeof globalThis.WebSocket} [options.WebSocketImpl]
 * @param {typeof globalThis.fetch} [options.fetch]
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {number} [options.requestTimeoutMs]
 * @param {number} [options.connectTimeoutMs]
 * @param {number[]} [options.reconnectMs] 逐次加长，封顶最后一个
 * @param {boolean} [options.autoReconnect] 缺省 true
 */
export function createServiceClient({
  base,
  key: givenKey,
  keyFile,
  WebSocketImpl = globalThis.WebSocket,
  fetch: fetchImpl = globalThis.fetch,
  log = () => {},
  requestTimeoutMs = SERVICE_CLIENT_DEFAULTS.requestTimeoutMs,
  connectTimeoutMs = SERVICE_CLIENT_DEFAULTS.connectTimeoutMs,
  reconnectMs = SERVICE_CLIENT_DEFAULTS.reconnectMs,
  autoReconnect = true,
} = {}) {
  if (typeof base !== 'string' || base === '') throw new TypeError('createServiceClient: base 必须是非空字符串');
  if (typeof WebSocketImpl !== 'function') throw new TypeError('createServiceClient: 没有可用的 WebSocket 实现');
  const key = givenKey ?? readServiceKeyFile(keyFile);
  const url = wsUrlOf(base);
  const say = (event, fields = {}) => {
    try { log(event, { service: key.service, ...fields }); } catch { /* 日志不该影响连接 */ }
  };

  let ws = null;
  let open = false;
  let closed = false;
  let attempt = 0;
  let connecting = null;
  let retryTimer = null;
  let seq = 0;
  /** reqId → { resolve, timer } */
  const waiting = new Map();
  /** 订阅目录的回调；重连后自动重订 */
  let watcher = null;
  const stateListeners = new Set();

  const emitState = (state, info = {}) => {
    for (const fn of [...stateListeners]) {
      try { fn(state, info); } catch { /* 监听方的错不影响连接 */ }
    }
  };

  function failAll(reason) {
    for (const [reqId, w] of [...waiting]) {
      waiting.delete(reqId);
      clearTimeout(w.timer);
      w.resolve({ ok: false, reason });
    }
  }

  function onMessage(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (!isObj(m)) return;
    if (m.reqId !== undefined && waiting.has(m.reqId)) {
      const w = waiting.get(m.reqId);
      waiting.delete(m.reqId);
      clearTimeout(w.timer);
      if (m.type === 'error') w.resolve({ ok: false, reason: typeof m.reason === 'string' ? m.reason : 'error' });
      else w.resolve({ ok: true, message: m });
      return;
    }
    if (m.type === 'hosted.project' && watcher?.onProject) {
      const { type: _t, ...item } = m;
      try { watcher.onProject(item); } catch (err) { say('service-client.watcher-error', { message: String(err?.message ?? err) }); }
    }
  }

  function scheduleReconnect() {
    if (closed || !autoReconnect || retryTimer) return;
    const wait = reconnectMs[Math.min(attempt, reconnectMs.length - 1)] ?? 1000;
    attempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void connect().catch(() => {});
    }, wait);
    retryTimer.unref?.();
  }

  /** 建一次控制连接；已连上直接回。失败抛错（并按退避安排下一次） */
  function connect() {
    if (closed) return Promise.reject(Object.assign(new Error('服务客户端已关闭'), { code: 'closed' }));
    if (open) return Promise.resolve();
    connecting ??= (async () => {
      try {
        const protocols = await buildServiceProtocols({ base, key, fetch: fetchImpl });
        if (closed) throw Object.assign(new Error('服务客户端已关闭'), { code: 'closed' });
        await new Promise((resolve, reject) => {
          const sock = new WebSocketImpl(url, protocols);
          let settled = false;
          const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            try { sock.close(); } catch { /* 还没连上 */ }
            reject(Object.assign(new Error('控制连接超时'), { code: 'timeout' }));
          }, connectTimeoutMs);
          timer.unref?.();
          sock.addEventListener('open', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            ws = sock;
            open = true;
            attempt = 0;
            resolve();
          });
          sock.addEventListener('message', (ev) => { if (typeof ev.data === 'string') onMessage(ev.data); });
          sock.addEventListener('error', () => { /* 紧跟着会有 close */ });
          sock.addEventListener('close', (ev) => {
            const wasOpen = ws === sock && open;
            if (ws === sock) {
              ws = null;
              open = false;
            }
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              reject(Object.assign(new Error(`控制连接没建成（${ev.code ?? 0}）`), { code: 'refused', closeCode: ev.code ?? null }));
              return;
            }
            if (wasOpen) {
              failAll('unavailable');
              say('service-client.down', { code: ev.code ?? null, reason: String(ev.reason ?? '') });
              emitState('down', { code: ev.code ?? null, reason: String(ev.reason ?? '') });
              scheduleReconnect();
            }
          });
        });
        say('service-client.up', {});
        emitState('up', {});
        if (watcher) void rewatch();
      } catch (err) {
        say('service-client.connect-failed', { reason: String(err?.code ?? 'error') });
        scheduleReconnect();
        throw err;
      } finally {
        connecting = null;
      }
    })();
    return connecting;
  }

  /** 发一条请求，回 `{ ok: true, message }` 或 `{ ok: false, reason }`；不抛错 */
  function request(message) {
    if (closed) return Promise.resolve({ ok: false, reason: 'closed' });
    if (!open || !ws) return Promise.resolve({ ok: false, reason: 'unavailable' });
    const reqId = `sc-${(seq += 1)}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        waiting.delete(reqId);
        resolve({ ok: false, reason: 'timeout' });
      }, requestTimeoutMs);
      timer.unref?.();
      waiting.set(reqId, { resolve, timer });
      try {
        ws.send(JSON.stringify({ ...message, reqId }));
      } catch {
        waiting.delete(reqId);
        clearTimeout(timer);
        resolve({ ok: false, reason: 'unavailable' });
      }
    });
  }

  const strip = (r, type) => {
    if (!r.ok) return r;
    if (r.message.type !== type) return { ok: false, reason: 'bad-reply' };
    const { type: _t, reqId: _r, ...rest } = r.message;
    return { ok: true, ...rest };
  };

  async function rewatch() {
    const r = strip(await request({ type: 'hosted.watch' }), 'hosted.projects');
    if (!r.ok) {
      say('service-client.watch-failed', { reason: r.reason });
      return r;
    }
    try { watcher?.onProjects?.(Array.isArray(r.projects) ? r.projects : []); } catch (err) { say('service-client.watcher-error', { message: String(err?.message ?? err) }); }
    return r;
  }

  const api = {
    /** 这个客户端代表哪个服务 */
    service: key.service,
    instanceId: key.instanceId,
    get connected() { return open; },

    /** 等控制连接连上（没在连就发起一次）；连不上抛错 */
    ready: connect,

    /** 连接状态变化：`fn('up' | 'down', { code?, reason? })`；回取消函数 */
    onState(fn) {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },

    /**
     * 订阅目录。`onProjects(完整清单)` 在订阅成功与每次重连后各调一次，`onProject(条目)` 在之后每次变化时调
     * （条目 `{ projectId, enabled, active, members, hosted }` 或 `{ projectId, removed: true }`；`enabled` 是这个服务自己的开关）。
     * @returns {Promise<{ ok: true, projects: object[] } | { ok: false, reason: string }>}
     */
    watch({ onProjects, onProject } = {}) {
      watcher = { onProjects, onProject };
      return rewatch();
    },

    /**
     * 核验一张委托票据或对话委托（不签任何东西）。
     * @returns {Promise<{ ok: true, projectId, userId, username, deviceId, deviceName, creator, mode, acc, exp, ownerKey, grant, conversationId? } | { ok: false, reason }>}
     */
    async verifyDelegation(delegation) {
      return strip(await request({ type: 'hosted.delegate.verify', delegation }), 'hosted.delegate.ok');
    },

    /**
     * 凭对话委托换一张代那位成员的连接票据（2 分钟，只在握手时用）。
     * @param {{ projectId: string, conversation: number, conversationId: string, delegation: string }} fields
     * @returns {Promise<{ ok: true, ticket, exp, userId, username, access, ownerKey, conversation, conversationId } | { ok: false, reason }>}
     */
    async memberTicket({ projectId, conversation, conversationId, delegation }) {
      return strip(await request({ type: 'hosted.ticket', projectId, conversation, conversationId, delegation }), 'hosted.ticket.ok');
    },

    /** 只用来发布预渲染重试计划的连接票据（服务自己的身份，不带任何成员的权限） */
    async publishTicket(projectId) {
      return strip(await request({ type: 'hosted.ticket', projectId, purpose: 'publish' }), 'hosted.ticket.ok');
    },

    /** 以服务自己的身份进项目的票据（`actsFor: 'self'` 的服务，如渲染服务，才要得到） */
    async serviceTicket(projectId) {
      return strip(await request({ type: 'hosted.ticket', projectId }), 'hosted.ticket.ok');
    },

    /** 声明「这个项目有活要别的托管方服务做」；`holdMs: 0` 撤回 */
    async demand(projectId, holdMs) {
      return strip(await request({ type: 'hosted.demand', projectId, ...(holdMs === undefined ? {} : { holdMs }) }), 'hosted.demand.ok');
    },

    /** 数据连接握手用的子协议 `[promptcut.v1, promptcut.ticket.<票据>]` */
    dataProtocols: ticketProtocols,

    /**
     * 给 `server/agent/doc-link.mjs` 的 `createAgentLink({ protocolsFor })` 用：按对话号现换票据、拼子协议。
     * 每次调用（首次连接、会话接续、断线重连）都拿手里那张对话委托重新换，所以不需要页面在场；
     * 换不出来抛错，`code` 是文档服务给的原因（`expired`、`generation`、`service-disabled`、`banned`、`not-listed`、`unavailable`……）。
     * @param {{ projectId: string, conversationId: string, delegation: string | (() => string) }} fields
     * @returns {(conversation: number) => Promise<string[]>}
     */
    protocolsForConversation({ projectId, conversationId, delegation }) {
      return async (conversation) => {
        const grant = typeof delegation === 'function' ? delegation() : delegation;
        const r = await api.memberTicket({ projectId, conversation, conversationId, delegation: grant });
        if (!r.ok) throw Object.assign(new Error(`换不出连接票据（${r.reason}）`), { code: r.reason });
        return ticketProtocols(r.ticket);
      };
    },

    /** 关掉控制连接，不再重连 */
    close() {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
      failAll('closed');
      const sock = ws;
      ws = null;
      open = false;
      try { sock?.close(1000, 'client-close'); } catch { /* 已经断了 */ }
    },
  };
  return api;
}
