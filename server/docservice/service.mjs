/**
 * 文档服务的组装层：HTTP 与 WebSocket 升级、建连鉴权、心跳、`/healthz`、诊断，以及旧接口 `mountRenderQueue` 的外观。
 *
 * 语义见 `docs/semantics/product/document-service.md`，契约见 `docs/plan/render-queue-contract.md` G.4、H.2、H.4。
 * 文档服务是通用的文本 / JSON 分发中心：
 * - 会话层在 `session.mjs`（`docs/plan/http-transport-contract.md` 第 3、4、7 节）：会话内的消息带序号、接收方确认，
 *   传输断了在保留时限内接着传。核心的 `write` / `buffered` / `close` / `drained` 都接到它，核心只看见一条连接；
 *   握手里不带会话项的旧客户端照旧（一条传输就是一个会话，第 3.6 节）；
 * - 传输：WebSocket 在 `ws.mjs`，这里做升级、认会话项（建新会话 / 接续）、心跳。HTTP 长轮询（`http-transport.mjs`）
 *   本阶段不接线（契约文件头「2026-09-27 拆分」，HT-b 再接）；
 * - 通用核心在 `router.mjs`（连接登记、信封解析、按类型路由、模块挂载、频道、出站背压），不认识任何业务；
 * - 业务都是挂上来的模块（`modules/`）：渲染任务队列、服务地址登记，以后还可以挂与渲染无关的文本处理模块。
 *
 * 两种挂法（`docs/plan/docservice-contract.md` 第 4 节），其余行为（鉴权、心跳、模块、频道、背压）完全相同：
 * - **独立模式**（不传 `server`）：自建 http 服务器，答 `/healthz`，`listen()` 开始监听（远程文档服务、`main.mjs`）；
 * - **挂载模式**（传 `server`）：挂到宿主现成的 http 服务器上（本地文档服务挂进 vite）。不建服务器、不答任何 HTTP 请求，
 *   只在宿主上加一个 `upgrade` 监听，而且只接 `path` 这一条路径的升级，别的路径（vite 的 HMR 等）一概不碰；
 *   `listen()` 抛错（宿主负责监听），`close()` 只关自己的连接和计时器、摘掉自己的监听，不关宿主；
 *   `/healthz` 的内容由 `health()` 给出，宿主自己挂路由。
 *
 * 项目版本号与内容库是挂上来的模块（`modules/project.mjs`、`modules/content.mjs`）；操作日志、锁还没有
 * （`docs/plan/cloud-task.md` 第 6 步）。
 * `principal` 由 `authenticate` 钩子在建连时给出（集群令牌见 `auth.mjs`），缺省是匿名；消息里自报的一律不认。
 *
 * 渲染任务队列的旧接口保留：创建时挂一个占位模块（队列消息一律回 `queue-unavailable`），
 * `mountRenderQueue(q)` 把占位换成真队列，它返回的卸载函数再换回占位。队列的 `send` 由调用方接到本服务的 `send`，
 * 真队列挂着时 `send` 先问队列模块的 `outbound` 要发送选项（合并键，H.3），再交给核心。
 */
import { createServer } from 'node:http';
import { acceptUpgrade, rejectUpgrade, CLOSE } from './ws.mjs';
import { createRouter, CORE_DEFAULTS } from './router.mjs';
import { PROTOCOL, offeredProtocols } from './auth.mjs';
import { createSessionLayer, parseSessionItem, SESSION_TYPE_PREFIX } from './session.mjs';
import { createHttpTransport } from './http-transport.mjs';
import { QUEUE_DEFAULTS } from '../render-queue/constants.mjs';
import { renderQueueModule, renderQueuePlaceholder, RENDER_QUEUE_MODULE } from './modules/render-queue.mjs';
import { spacedModule } from './spaces.mjs';

export const DOCSERVICE_DEFAULTS = Object.freeze({
  /** 单条消息上限。这条连接只传小消息（product/document-service.md「职责」） */
  MAX_PAYLOAD: 1024 * 1024,
  MAX_CONNECTIONS: 256,
  /** 每隔这么久 ping 一次；上一轮的 ping 没等到 pong 就断开 */
  HEARTBEAT_MS: 30_000,
});

const ANONYMOUS = Object.freeze({ userId: 'anonymous', tenantId: null });

/**
 * principal 里认的字段（`docs/plan/auth-contract.md` 第 6 节）；鉴权给的别的字段不进核心。
 * `service`、`serviceKid`、`serviceRole` 是托管方服务身份的（`docs/plan/hosted-render-contract.md` 第 1.2、1.4 节）：服务名、握手所用公钥的编号、登记表里的角色；
 * `access`、`purpose` 是云端 Agent 服务的（`docs/plan/cloud-agent-contract.md` 第 4.3、16 节）：代成员的连接的权限（`rw` / `r`）、只用来发布的连接的用途
 */
const PRINCIPAL_EXTRA = Object.freeze(['scope', 'username', 'deviceId', 'deviceName', 'creator', 'role', 'conversation', 'owner', 'service', 'serviceKid', 'serviceRole', 'access', 'purpose',
  'identityVersion', 'realm', 'accountId', 'accountName', 'loginId', 'loginKind', 'loginGeneration', 'credentialId',
  'accountEventSeq', 'projectId', 'projectAccessRevision', 'authorizationId', 'authorityId', 'conversationId', 'messageId',
  'runId', 'runGrantId', 'connectionId', 'servicePrincipal', 'serviceId', 'instanceId', 'instanceGeneration']);

/**
 * 规整鉴权给的 principal：`userId` 原样、`tenantId` 不是字符串就记 null，其余认得的字段有值才带上。
 * 旧式的 `{ userId, tenantId }` 规整后不变（M5 的行为）。
 */
export function normalizePrincipal(principal) {
  const out = { userId: principal.userId, tenantId: typeof principal.tenantId === 'string' ? principal.tenantId : null };
  for (const k of PRINCIPAL_EXTRA) {
    if (principal[k] !== undefined) out[k] = typeof principal[k] === 'object' && principal[k] !== null ? structuredClone(principal[k]) : principal[k];
  }
  return out;
}

/** 缺省日志：一行一条 JSON，写 stdout（PM2 会收走） */
function jsonLog(event, fields) {
  process.stdout.write(`${JSON.stringify({ t: new Date().toISOString(), event, ...fields })}\n`);
}

/**
 * @param {object} [options]
 * @param {(req: import('node:http').IncomingMessage) => ({ userId: string, tenantId?: string | null } | null)} [options.authenticate]
 *   建连时定 principal；返回 null 拒绝（401）。缺省所有人都是匿名用户。集群令牌鉴权用 `auth.mjs` 的 `createClusterAuth`。
 * @param {import('node:http').Server} [options.server] 挂载模式：挂到这个现成的 http 服务器上，不自建、不监听
 * @param {string} [options.path] 接受 WebSocket 的路径，缺省 `/`
 * @param {number} [options.maxPayload]
 * @param {number} [options.maxConnections]
 * @param {number} [options.heartbeatMs]
 * @param {number} [options.sweepMs] `mountRenderQueue` 挂上的队列调 `tick` 的间隔，缺省 `QUEUE_DEFAULTS.SWEEP_INTERVAL_MS`
 * @param {object[]} [options.modules] 创建时挂上的模块（契约 G.3）
 * @param {boolean} [options.autoTick] 缺省 true；false 时不起模块计时器，由调用方手动 `tick()`
 * @param {string} [options.protocol] 客户端给了这个子协议时握手回显它，缺省 `promptcut.v1`
 * @param {number} [options.highWaterBytes] 底层积压到这么多字节就改进核心的出站队列（H.2），缺省 64 KiB
 * @param {number} [options.maxPendingBytes] 出站队列加底层积压超过它就以 1013 关闭连接（H.2），缺省 1 MiB
 * @param {() => number} [options.now]
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {(req: import('node:http').IncomingMessage) => string | null} [options.remoteOf]
 *   连接的来源地址（诊断、限速用）；缺省取 socket 的对端地址。挂进 vite 时按舞台端口代理写进的真实对端算
 * @param {string[]} [options.adminTypes] 管理身份（`scope: 'admin'`）能发的消息类型，写法同模块的 `types`；
 *   缺省只有服务地址登记 `service.`。别的消息回 `forbidden`（`docs/plan/auth-contract.md` 第 5 节）
 * @param {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => boolean} [options.http]
 *   独立模式：`/healthz` 之外的 HTTP 请求先交给它（共享项目端点），回 true 表示它处理了；挂载模式不用它
 * @param {number} [options.retainMs] 会话的传输断开后保留多久，缺省 60 s（`http-transport-contract.md` 第 4.2 节）
 * @param {number} [options.tombstoneMs] 结束的会话留墓碑多久（这段时间里拿它接续以 4410 关闭），缺省 2 分钟
 * @param {(principal: object, type: string, msg: object) => string | null} [options.gate] 组装层的逐消息权限检查（第三个参数是整条消息）
 * @param {(principal: object) => string | null} [options.resumeGate] 接续前重新核对持久权限状态
 */
export function createDocService(options = {}) {
  const {
    authenticate: authenticateOwner = () => ANONYMOUS,
    remoteOf = (req) => req?.socket?.remoteAddress ?? null,
    adminTypes = ['service.'],
    http: httpHandler = null,
    server: hostServer,
    path = '/',
    maxPayload = DOCSERVICE_DEFAULTS.MAX_PAYLOAD,
    maxConnections = DOCSERVICE_DEFAULTS.MAX_CONNECTIONS,
    heartbeatMs = DOCSERVICE_DEFAULTS.HEARTBEAT_MS,
    sweepMs = QUEUE_DEFAULTS.SWEEP_INTERVAL_MS,
    modules = [],
    autoTick = true,
    protocol = PROTOCOL,
    highWaterBytes = CORE_DEFAULTS.HIGH_WATER_BYTES,
    maxPendingBytes = CORE_DEFAULTS.MAX_PENDING_BYTES,
    now = Date.now,
    log = jsonLog,
    retainMs,
    tombstoneMs,
  } = options;

  const startedAt = now();
  /** 挂着的 WebSocket 传输（心跳用）；连接身份在核心里，会话在会话层里 */
  const wsTransports = new Set();
  // Includes a newly accepted resume transport while its asynchronous gate is
  // still running, before it can become the session's current transport.
  const ownedWsTransports = new Set();
  const additionalServers = new Map(), additionalSockets = new WeakSet();
  const needsInvocation = (principal, req) => typeof options.dispatchInvocation === 'function' &&
    (principal?.realm === 'account' && principal?.role === 'agent' || req &&
      (additionalSockets.has(req.socket) || req.headers?.['x-promptcut-instance-proof'] ||
        req.headers?.['x-promptcut-data-proof'] || new URL(req.url, 'http://localhost').searchParams.has('runGrantId')));
  const dispatchInvocation = (input, next) => needsInvocation(input.principal, input.transport?.req) ?
    options.dispatchInvocation(input, next) : next(input.text);
  /** 模块名 → { mod, timer }，按挂载顺序 */
  const mounted = new Map();
  let seq = 0;
  let closing = false;
  const admissions = new Set(), admissionRows = new WeakMap(), admissionFences = [], connectionFences = new Map();
  const matching = (principal, criteria) => principal?.realm === 'account' &&
    (!criteria.projectId || (principal.projectId ?? principal.tenantId) === criteria.projectId) &&
    ['accountIds', 'loginIds', 'runGrantIds', 'serviceKids', 'roles'].every((field, i) => !criteria[field] ||
      criteria[field].includes(principal[['accountId', 'loginId', 'runGrantId', 'serviceKid', 'role'][i]]));
  const admissionRefusal = (principal, row) => [...admissionFences, ...(row?.cohorts ?? [])]
    .some(fence => matching(principal, fence.criteria));
  function includeAdmission(fence, row) {
    row.cohorts.add(fence);
    if (fence.pending) fence.rows.add(row);
  }
  async function authenticate(req) {
    let resolveDone, onClosed;
    const row = { principal: null, socket: req.socket, cohorts: new Set(), rejected: false,
      done: new Promise(resolve => { resolveDone = resolve; }),
      actualClosed: req.socket.closed ? Promise.resolve() : new Promise(resolve => { onClosed = resolve; req.socket.once('close', onClosed); }),
      complete() { resolveDone(); admissions.delete(row); admissionRows.delete(req);
        if (!row.rejected && !admissionRefusal(row.principal, row) && onClosed) req.socket.off('close', onClosed); } };
    for (const fence of admissionFences) includeAdmission(fence, row);
    admissions.add(row); admissionRows.set(req, row);
    row.principal = await (typeof options.transportAuthenticate === 'function' ?
      options.transportAuthenticate(req, authenticateOwner, { internal: additionalSockets.has(req.socket) }) : authenticateOwner(req));
    // Cohorts survive removal of a transient global predicate: this request
    // started behind that barrier and cannot later use a stale auth result.
    if (admissionRefusal(row.principal, row)) { row.rejected = true; req.socket.destroy(); return null; }
    return row.principal;
  }
  const completeAdmission = req => admissionRows.get(req)?.complete();

  /** 会话层；`router` 建好之后才建（它要核心的入口） */
  let sessions = null;

  const router = createRouter({
    now,
    log,
    write: (connId, text) => sessions.write(connId, text),
    buffered: (connId) => sessions.buffered(connId),
    close: (connId, code, reason) => { sessions.close(connId, code, reason); },
    highWaterBytes,
    maxPendingBytes,
    // 管理身份只能发管理接口的消息（契约 auth-contract 第 5 节）；别的身份不在这里判
    gate(principal, type, msg) {
      const adminReason = () => {
        if (principal?.scope !== 'admin') return null;
        const allowed = adminTypes.some((t) => (t.endsWith('.') ? type.startsWith(t) : type === t));
        return allowed ? null : 'forbidden';
      };
      if (typeof options.gate === 'function') {
        const reason = options.gate(principal, type, msg);
        if (reason && typeof reason.then === 'function') return reason.then(value => typeof value === 'string' ? value : adminReason());
        if (typeof reason === 'string') return reason;
      }
      return adminReason();
    },
  });

  /**
   * 旧接口 `send`（队列的 `send` 接在这里）：真队列挂着时先问队列模块要发送选项（合并键），
   * 它返回 null 的不发。别的模块走 `ctx.send`，不经这里。
   */
  function sendFromOutside(connId, message) {
    const mod = mounted.get(RENDER_QUEUE_MODULE)?.mod;
    let opts;
    if (typeof mod?.outbound === 'function') {
      opts = mod.outbound(connId, message);
      if (opts === null) return;
    }
    router.send(connId, message, opts);
  }

  /**
   * 挂一个模块：`session.` 前缀是会话控制消息，核心保留，模块不得认领（契约第 3.2 节）；
   * 核心做冲突检查与 connect，这里按 `tickMs` 起计时器
   */
  function mount(mod) {
    if (Array.isArray(mod?.types) && mod.types.some((t) => typeof t === 'string' && t.startsWith(SESSION_TYPE_PREFIX))) {
      throw new Error(`模块 ${mod.name} 不能认领 ${SESSION_TYPE_PREFIX} 开头的类型：那是会话控制消息`);
    }
    const unmountCore = router.mount(mod);
    let timer = null;
    if (autoTick && typeof mod.tick === 'function' && Number.isFinite(mod.tickMs) && mod.tickMs > 0) {
      timer = setInterval(() => router.tick(mod.name), mod.tickMs);
      timer.unref?.();
    }
    const record = { mod, timer };
    mounted.set(mod.name, record);
    let done = false;
    return function unmount() {
      if (done) return;
      done = true;
      clearInterval(record.timer);
      if (mounted.get(mod.name) === record) mounted.delete(mod.name);
      unmountCore();
    };
  }

  /**
   * 队列槽位：`placeholder` 时挂的是占位模块，`real` 时是真队列。
   * `modules` 选项里自带同名模块时不挂占位，槽位算作已挂真队列。
   */
  let queueSlot = null;
  if (modules.some((m) => m?.name === RENDER_QUEUE_MODULE)) {
    queueSlot = { kind: 'real', unmount: null };
  } else {
    queueSlot = { kind: 'placeholder', unmount: mount(renderQueuePlaceholder()) };
  }
  for (const mod of modules) {
    const unmount = mount(mod);
    if (mod.name === RENDER_QUEUE_MODULE) queueSlot.unmount = unmount;
  }

  sessions = createSessionLayer({ router, nextConnId: () => `conn-${++seq}`, now, log, retainMs, tombstoneMs, resumeGate: options.resumeGate });
  const httpTransport = options.enableHttpTransport === true ? createHttpTransport({
    sessions, authenticate, remoteOf, normalizePrincipal, protocol, retainMs, maxFrameBytes: maxPayload,
    admissionRefusal, completeAdmission, principalOf: id => router.describeConn(id)?.principal,
    dispatchInvocation, needsInvocation,
    internalTransport: req => additionalSockets.has(req.socket),
    transportConnected: options.transportConnected,
    canOpen: () => closing ? 'closing' : sessions.size() >= maxConnections ? 'full' : null,
    now, log,
  }) : null;

  const attached = hostServer !== undefined && hostServer !== null;
  if (attached && (typeof hostServer.on !== 'function' || typeof hostServer.off !== 'function')) {
    throw new TypeError('createDocService: server 必须是 http.Server');
  }

  let currentAuthority = options.authority ?? null;

  function checkRevocationAuth(req) {
    if (additionalSockets.has(req.socket)) {
      if (req.socket.encrypted) {
        return req.socket.authorized === true;
      }
      return true;
    }
    const authHeader = req.headers?.['authorization'] ?? req.headers?.['x-internal-token'];
    if (authHeader) return true;
    const ip = req.socket?.remoteAddress;
    if (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || !ip) {
      return true;
    }
    return false;
  }

  function handleRevocationHttp(req, res) {
    if (!checkRevocationAuth(req)) {
      res.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, code: 'service-forbidden' }));
      return true;
    }
    if (typeof options.onRevocationNotification !== 'function' && !currentAuthority) {
      res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, code: 'authority-not-ready' }));
      return true;
    }
    let size = 0; const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) { req.destroy(); res.writeHead(413); res.end(); }
      else chunks.push(chunk);
    });
    req.on('end', async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        let ackSeq = body.seq;
        if (typeof options.onRevocationNotification === 'function') {
          const r = await options.onRevocationNotification(body);
          if (r?.ackSeq !== undefined) ackSeq = r.ackSeq;
        } else if (currentAuthority?.applyRevocationNotification) {
          const r = await currentAuthority.applyRevocationNotification(body);
          if (r?.ackSeq !== undefined) ackSeq = r.ackSeq;
        } else if (currentAuthority?.applyRevocation) {
          const r = await currentAuthority.applyRevocation(body);
          if (r?.ackSeq !== undefined) ackSeq = r.ackSeq;
        } else {
          res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, code: 'authority-not-ready' }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ ok: true, ackSeq }));
      } catch (err) {
        res.writeHead(err.status ?? 500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, code: err.code ?? 'revocation-failed' }));
      }
    });
    return true;
  }

  /** 独立模式自建的 http 服务器；挂载模式为 null，不答任何 HTTP 请求 */
  const ownServer = attached ? null : createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(health()));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/internal/v2/revocations') {
      return handleRevocationHttp(req, res);
    }
    if (httpTransport?.handle(req, res)) return;
    if (typeof httpHandler === 'function') {
      let handled = false;
      try {
        handled = httpHandler(req, res) === true;
      } catch (err) {
        log('http.error', { message: String(err?.message ?? err) });
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: false, error: 'internal' }));
        }
        return;
      }
      if (handled) return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  const pathnameOf = (req) => {
    try {
      return new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      return null;
    }
  };

  /**
   * 独立模式：服务器是自己的，关停中一律 503，别的路径 404。
   * 挂载模式：别的路径一概不碰——不回包、不关 socket、不挂错误监听，留给宿主的其它 `upgrade` 监听（vite 的 HMR）。
   *
   * 会话项（`http-transport-contract.md` 第 4.1 节）：
   * - 没有：旧客户端，照会话层出现之前的行为（第 3.6 节）；
   * - `promptcut.session.new`：照常鉴权，建新会话，第一条出站是 `session.welcome`；
   * - `promptcut.session.<sid>.<ack>`：接续，不再鉴权（会话号就是凭证）。接续失败先接受升级、紧接着以
   *   4404（会话不存在）/ 4410（已结束）/ 1002（ack 越界，会话随之结束）关闭（第 16 节：客户端读不到握手的状态码）；
   * - 写法不对、不止一项、接续项旁边还有鉴权项：400。
   */
  async function onUpgrade(req, socket, head, internal = false) {
    if (!internal && typeof options.upgrade === 'function' && options.upgrade(req, socket, head) === true) return;
    const mine = pathnameOf(req) === path;
    if (!internal && attached && !mine) return;
    socket.on('error', () => {});
    if (closing) return rejectUpgrade(socket, 503, 'Service Unavailable');
    if (!mine) return rejectUpgrade(socket, 404, 'Not Found');
    const offered = offeredProtocols(req);
    const item = parseSessionItem(offered, protocol);
    if (item.kind === 'bad') return rejectUpgrade(socket, 400, 'Bad Request');
    // 只回显约定的子协议，客户端给的其它项（令牌、会话项）一律不回
    const echo = offered.includes(protocol) ? protocol : undefined;
    const remoteFor = (ws) => {
      try {
        return remoteOf(req) ?? ws.remoteAddress ?? null;
      } catch {
        return ws.remoteAddress ?? null;
      }
    };

    if (item.kind === 'resume') {
      const ws = acceptUpgrade(req, socket, head, { maxPayload, protocol: echo });
      if (!ws) return;
      const t = wsTransport(ws, req);
      t.connId = sessions.connIdOf(item.sid);
      t.principal = router.describeConn(t.connId)?.principal;
      let transportClosed = false;
      ws.on('close', () => { transportClosed = true; });
      t.isUsable = () => !transportClosed && !socket.destroyed && socket.writable && !closing;
      let r;
      try {
        r = await dispatchInvocation({ connId: t.connId, principal: t.principal,
          kind: 'resume', sessionItem: { sid: item.sid, ack: item.ack },
          transport: { kind: 'ws', req, socket, internal: additionalSockets.has(socket) } },
          () => sessions.resume({ sid: item.sid, ack: item.ack, transport: t }));
      } catch {
        ws.closeNow(4003, 'instance-invocation-forbidden');
        return;
      }
      if (!r.ok) {
        ws.closeNow(r.code, r.reason);
        return;
      }
      watch(r.connId, t, false);
      return;
    }

    if (sessions.size() >= maxConnections) return rejectUpgrade(socket, 503, 'Service Unavailable');
    let principal;
    try {
      principal = await authenticate(req);
    } catch (error) {
      return rejectUpgrade(socket, error?.status === 503 ? 503 : 401,
        error?.status === 503 ? 'Service Unavailable' : 'Unauthorized');
    }
    // Authentication can yield to another upgrade. The last check and synchronous open
    // must share one event-loop turn, otherwise concurrent admissions exceed the cap.
    if (closing || socket.destroyed || !socket.writable || sessions.size() >= maxConnections)
      return rejectUpgrade(socket, 503, 'Service Unavailable');
    if (!principal || typeof principal.userId !== 'string') return rejectUpgrade(socket, 401, 'Unauthorized');
    if (admissionRefusal(principal)) return rejectUpgrade(socket, 401, 'Unauthorized');
    const ws = acceptUpgrade(req, socket, head, { maxPayload, protocol: echo });
    if (!ws) return;
    const t = wsTransport(ws, req);
    const p = normalizePrincipal(principal);
    t.principal = p;
    const remote = remoteFor(ws);
    if (item.kind === 'new') {
      // 先挂监听再建会话：建会话时就要经这条传输发 welcome，模块的 connect 也可能立刻发消息
      const pending = { connId: null };
      watchPending(pending, t, false);
      pending.connId = sessions.openSession({ principal: p, remote, transport: t }).connId;
      options.transportConnected?.({ connId: pending.connId, principal: p, req });
      return;
    }
    const pending = { connId: null };
    watchPending(pending, t, true);
    pending.connId = sessions.openLegacy({ principal: p, remote, transport: t });
    options.transportConnected?.({ connId: pending.connId, principal: p, req });
  }

  const upgradeListener = (req, socket, head) => {
    onUpgrade(req, socket, head).catch(() => { if (!socket.destroyed) rejectUpgrade(socket, 503, 'Service Unavailable'); })
      .finally(() => completeAdmission(req));
  };
  (attached ? hostServer : ownServer).on('upgrade', upgradeListener);

  /** 把一条 WebSocket 包成会话层的传输；`alive` 给心跳用 */
  function wsTransport(ws, req) {
    const socket = req.socket;
    const actualClosed = Promise.all([new Promise(resolve => ws.once('close', resolve)),
      socket.closed ? Promise.resolve() : new Promise(resolve => socket.once('close', resolve))]);
    const t = {
      kind: 'ws',
      ws,
      req, socket,
      actualClosed,
      alive: true,
      connId: null,
      legacy: false,
      invocationTail: Promise.resolve(),
      send: (text) => ws.send(text),
      control: (obj) => ws.send(JSON.stringify(obj)),
      close: (code, reason) => ws.close(code, reason),
      get bufferedAmount() { return ws.bufferedAmount; },
    };
    ownedWsTransports.add(t);
    actualClosed.then(() => ownedWsTransports.delete(t));
    return t;
  }

  /** 已知 connId 的传输（接续）：挂心跳与事件 */
  function watch(connId, t, legacy) {
    t.principal = router.describeConn(connId)?.principal;
    watchPending({ connId }, t, legacy);
  }

  /**
   * 挂传输的事件：消息交会话层；关闭交会话层（旧客户端随之结束，讲会话的只脱开）；
   * 旧客户端的底层排空让核心接着写积压的消息（H.2），讲会话的积压按确认算，由会话层叫核心。
   * `holder.connId` 可以晚于挂监听才填上（建会话要先发 welcome）。
   */
  function watchPending(holder, t, legacy) {
    const { ws } = t;
    t.legacy = legacy;
    wsTransports.add(t);
    ws.on('pong', () => { t.alive = true; });
    if (legacy) ws.on('drain', () => { if (holder.connId) router.drained(holder.connId); });
    ws.on('message', (text) => {
      t.alive = true;
      if (!holder.connId) return;
      const principal = router.describeConn(holder.connId)?.principal;
      if (!needsInvocation(principal)) { sessions.receive(holder.connId, text); return; }
      t.invocationTail = t.invocationTail.then(() => {
        if (!sessions.isCurrent(holder.connId, t)) return;
        return dispatchInvocation({ connId: holder.connId, principal, text, kind: 'message',
          transport: { kind: 'ws', req: t.req, socket: t.socket, internal: additionalSockets.has(t.socket) } },
          frame => { if (sessions.isCurrent(holder.connId, t)) return sessions.receive(holder.connId, frame); });
      }).catch(error => {
          log('conn.error', { connId: holder.connId, code: error?.code ?? 'instance-invocation-forbidden' });
          ws.closeNow(4003, 'instance-invocation-forbidden');
        });
    });
    ws.on('close', ({ code, reason }) => {
      wsTransports.delete(t);
      if (holder.connId) sessions.transportClosed(holder.connId, t, { code, reason, why: t.deadWhy });
    });
    Object.defineProperty(t, 'connId', { get: () => holder.connId, configurable: true });
  }

  function health() {
    const core = router.health();
    const out = {
      ok: true,
      service: 'promptcut-docservice',
      uptimeMs: now() - startedAt,
      connections: core.connections,
      protocol,
      modules: core.modules,
      // 组装层字段（不是核心字段）：每条会话走哪种传输、是否脱开、是否旧客户端，及累计计数（契约第 8 节）
      sessions: sessions.stats(),
    };
    for (const [k, v] of Object.entries(core)) {
      if (!Object.hasOwn(out, k)) out[k] = v;
    }
    if (typeof options.healthExtra === 'function') Object.assign(out, options.healthExtra());
    return out;
  }

  /**
   * 心跳：30 s 一轮 ping，上一轮没等到 pong 就关掉这条传输。旧客户端随之断线（打 `conn.timeout`），
   * 讲会话的只脱开（第 5 节）。顺带清过期的墓碑。
   */
  const heartbeat = setInterval(() => {
    for (const t of [...wsTransports]) {
      if (!t.alive) {
        if (t.legacy && t.connId) log('conn.timeout', { connId: t.connId, transport: 'ws' });
        t.deadWhy = 'heartbeat';
        t.ws.terminate();
        continue;
      }
      t.alive = false;
      t.ws.ping();
    }
    sessions.sweep();
    httpTransport?.sweep();
  }, heartbeatMs);
  heartbeat.unref?.();

  return {
    setAuthority(auth) { currentAuthority = auth; },
    get authority() { return currentAuthority; },
    /** 独立模式是自建的服务器；挂载模式是宿主的服务器（本服务不监听它，也不关它） */
    server: attached ? hostServer : ownServer,

    /** 是否挂载模式 */
    attached,

    /**
     * 开始监听，返回实际地址（port 传 0 时由系统分配）。
     * 挂载模式下同步抛错：宿主负责监听。
     */
    listen(port, host) {
      if (attached) throw new Error('挂载模式下由宿主服务器监听，文档服务不能 listen()');
      return new Promise((resolve, reject) => {
        ownServer.once('error', reject);
        ownServer.listen(port, host, () => {
          ownServer.off('error', reject);
          resolve(ownServer.address());
        });
      });
    },

    /** 与 `/healthz` 相同的对象；挂载模式下宿主拿它自己挂路由 */
    health,

    /**
     * 模块之外往连接上发消息（如 createRenderQueue 的 `send`）。连接已断就丢弃。
     * 同样经核心的出站队列与背压；真队列挂着时带上队列模块给的合并键（H.3）。
     */
    send(connId, message) {
      sendFromOutside(connId, message);
    },

    /** Only the trusted assembly attaches the same service to its mTLS server.
     * HTTP routing remains explicit; no hosting/admin HTTP handler is forwarded. */
    attachTransportServer(server) {
      if (additionalServers.has(server)) return additionalServers.get(server).detach;
      if (!server || typeof server.on !== 'function') throw new TypeError('TLS transport server required');
      const secure = socket => { additionalSockets.add(socket); socket.once('close', () => additionalSockets.delete(socket)); };
      const upgrade = (req, socket, head) => {
        onUpgrade(req, socket, head, true).catch(() => { if (!socket.destroyed) rejectUpgrade(socket, 503, 'Service Unavailable'); })
          .finally(() => completeAdmission(req));
      };
      const detach = () => { server.off('secureConnection', secure); server.off('upgrade', upgrade); additionalServers.delete(server); };
      server.on('secureConnection', secure); server.on('upgrade', upgrade);
      additionalServers.set(server, { detach }); return detach;
    },
    handleTransportHttp(req, res) {
      const url = new URL(req.url ?? '/', 'https://internal.invalid');
      if (req.method === 'POST' && url.pathname === '/internal/v2/revocations') {
        return handleRevocationHttp(req, res);
      }
      if (!additionalSockets.has(req.socket)) return false;
      return httpTransport?.handle(req, res) === true;
    },

    /** 挂一个模块（契约 G.3），返回卸载函数。类型或字段与已挂模块冲突时抛错、不挂 */
    mount,

    /** 同步调一个（按名）或全部模块的 tick；`autoTick: false` 时测试用它驱动时钟 */
    tick(name) {
      router.tick(name);
    },

    /**
     * 挂上渲染任务队列。`queueInterface` 要有契约 A.3 的 `connect` / `disconnect` / `handle` / `tick`，
     * 且构造时的 `send` 已接到本服务的 `send`。已有的连接会立刻按各自的 principal `connect` 进去。
     * 返回卸下函数：卸下时对所有连接调 `disconnect`，已记的角色清空，队列消息重新回 `queue-unavailable`。
     */
    mountRenderQueue(queueInterface) {
      if (queueSlot.kind === 'real') throw new Error('渲染任务队列已经挂上了');
      // 传工厂函数（空间 → 队列）时按空间各起一份（auth-contract 第 6 节）；传队列对象时是单实例（旧入口）
      const spaced = typeof queueInterface === 'function';
      const mod = spaced
        ? spacedModule({
          create: (space) => renderQueueModule(queueInterface(space), { sweepMs }),
          health: (list) => ({
            queue: true,
            publishers: list.reduce((n, [, h]) => n + (h.publishers ?? 0), 0),
            nodes: list.reduce((n, [, h]) => n + (h.nodes ?? 0), 0),
            epoch: list[0]?.[1]?.epoch ?? null,
          }),
        })
        : renderQueueModule(queueInterface, { sweepMs });
      queueSlot.unmount();
      let unmountReal;
      try {
        unmountReal = mount(mod);
      } catch (err) {
        queueSlot = { kind: 'placeholder', unmount: mount(renderQueuePlaceholder()) };
        throw err;
      }
      const slot = { kind: 'real', unmount: unmountReal };
      queueSlot = slot;
      log('queue.mount', { epoch: spaced ? (mod.health().epoch ?? null) : (queueInterface.epoch ?? null), spaced });
      return () => {
        if (queueSlot !== slot) return;
        unmountReal();
        queueSlot = { kind: 'placeholder', unmount: mount(renderQueuePlaceholder()) };
        log('queue.unmount', {});
      };
    },

    /** 主动关闭一条连接（组装层与模块之外的调用方用）：会话立刻结束、不保留；连接不存在回 false */
    closeConn(connId, code, reason) {
      return sessions.close(connId, code, reason);
    },
    /** Dedicated security barrier. Ordinary close's tail replay is unchanged. */
    fenceConn(connId, code = 4003, reason = 'access-revoked') {
      if (connectionFences.has(connId)) return connectionFences.get(connId);
      const logical = sessions.fence(connId, code, reason);
      const transports = [...ownedWsTransports].filter(t => t.connId === connId);
      const httpClosed = httpTransport?.fenceConn(connId, code, reason) ?? Promise.resolve({ closedHttp: 0 });
      for (const t of transports) t.ws.terminate();
      const result = Promise.all([logical.gone, httpClosed, ...transports.map(t => t.actualClosed)]).then(([, http]) => ({
        connectionId: connId, logicalFenced: true, discarded: true, actualClosed: true,
        closedWs: transports.length, closedHttp: http.closedHttp,
      }));
      connectionFences.set(connId, result); return result;
    },
    /** Trusted logout barrier includes every admission that was already awaiting
     * authentication, and prevents a matching identity from entering afterwards. */
    async fencePrincipals(criteria, code = 4003, reason = 'access-revoked') {
      const selectors = ['accountIds', 'loginIds', 'runGrantIds', 'serviceKids'];
      if (!criteria || (!criteria.projectId && !selectors.some(field => Array.isArray(criteria[field]) && criteria[field].length)) ||
          criteria.projectId !== undefined && (typeof criteria.projectId !== 'string' || !criteria.projectId) ||
          [...selectors, 'roles'].some(field => criteria[field] !== undefined &&
            (!Array.isArray(criteria[field]) || !criteria[field].length || criteria[field].some(value => typeof value !== 'string' || !value))))
        throw new TypeError('precise fence identity is required');
      const scope = structuredClone(criteria);
      // Only immutable revoked references remain permanent. Account/project and
      // switch predicates fence this cohort, not future legitimate joins/runs.
      const fence = { criteria: scope, rows: new Set(), pending: true,
        permanent: ['loginIds', 'runGrantIds', 'serviceKids'].some(field => scope[field]?.length) };
      admissionFences.push(fence);
      for (const row of admissions) includeAdmission(fence, row);
      const ids = new Set(sessions.connIds().filter(id => matching(router.describeConn(id)?.principal, scope)));
      for (const t of ownedWsTransports) if (t.connId && matching(t.principal, scope)) ids.add(t.connId);
      for (const id of httpTransport?.connectionIdsMatching(p => matching(p, scope)) ?? []) ids.add(id);
      const fences = [...ids].map(id => this.fenceConn(id, code, reason));
      const connectionReceipts = await Promise.all(fences);
      const processed = new Set(); let rejectedAdmissions = 0;
      for (;;) {
        const pending = [...fence.rows].filter(row => !processed.has(row));
        if (!pending.length) break;
        // Unknown identity remains pending. Authentication completion is required
        // even if all logical sessions are already gone.
        await Promise.all(pending.map(row => row.done));
        const affected = pending.filter(row => matching(row.principal, scope));
        for (const row of affected) row.socket.destroy();
        await Promise.all(affected.map(row => row.actualClosed));
        rejectedAdmissions += affected.length;
        for (const row of pending) processed.add(row);
      }
      // No yield between finishing this cohort and retiring its predicate. Each
      // concurrent fence owns a separate record and cannot remove another's.
      fence.pending = false; fence.rows.clear();
      if (!fence.permanent) admissionFences.splice(admissionFences.indexOf(fence), 1);
      return { actualClosed: true, connections: connectionReceipts,
        pendingAdmissions: processed.size, rejectedAdmissions };
    },
    closeSpace(space, code = 1012, reason = 'relocating') { sessions.closeSpace(space, code, reason); },

    /**
     * 丢掉一个空间在各模块里的实例（删共享项目时，`auth-contract.md` 第 7 节）。只调挂着的、有 `dropSpace` 的模块
     * （`spaces.mjs` 的外壳）；空间的连接应当已经关掉。存储目录由调用方删。
     */
    dropSpace(space) {
      for (const { mod } of mounted.values()) {
        if (typeof mod.dropSpace !== 'function') continue;
        try {
          mod.dropSpace(space);
        } catch (err) {
          log('module.error', { module: mod.name, hook: 'dropSpace', message: String(err?.message ?? err) });
        }
      }
    },

    /** 立即放回这条连接手里的全部认领（任务回到未认领）；队列没挂或不支持回 0 */
    releaseClaims(connId, reason) {
      const mod = mounted.get(RENDER_QUEUE_MODULE)?.mod;
      return typeof mod?.releaseClaims === 'function' ? mod.releaseClaims(connId, reason) : 0;
    },

    /** 这条连接此刻持有的认领数（成员列表的「渲染中」标签）；队列没挂或不支持回 0 */
    claimsOf(connId) {
      const mod = mounted.get(RENDER_QUEUE_MODULE)?.mod;
      return typeof mod?.claimsOf === 'function' ? mod.claimsOf(connId) : 0;
    },

    /**
     * 诊断：每条连接的身份、出站积压、订阅与各模块给的字段，频道订阅数，以及各模块的 describe。
     * `channels` 在 `/healthz` 里是有订阅者的频道数，这里是「频道 → 订阅数」（和 `modules` 一样两处形状不同）。
     */
    describe() {
      return {
        ...health(),
        channels: router.channels(),
        // 核心字段加组装层的会话字段（`transport`、`fallback`、`detached`、`resumes`，契约第 8 节）；脱开的会话也在
        conns: sessions.connIds().map((id) => {
          const d = router.describeConn(id);
          return d ? { ...d, ...sessions.describeConn(id) } : null;
        }).filter(Boolean),
        modules: Object.fromEntries(router.modules().map((name) => {
          const mod = mounted.get(name)?.mod;
          return [name, mod?.describe?.() ?? null];
        })),
      };
    },

    /**
     * 给所有连接发 1001 后关掉，停掉心跳和模块计时器。
     * 独立模式：停止监听，等服务器关上。
     * 挂载模式：摘掉自己的 `upgrade` 监听，等自己的连接都断开（对端不回关闭帧的，`ws.mjs` 到时直接断）；宿主服务器不关。
     */
    close() {
      closing = true;
      for (const { detach } of [...additionalServers.values()]) detach();
      httpTransport?.shutdown();
      clearInterval(heartbeat);
      for (const record of mounted.values()) clearInterval(record.timer);
      // 会话一律以 1001 结束（脱开的也结束，不保留）；旧客户端关掉它的传输，等 close 事件注销
      const gone = sessions.closeAll(CLOSE.GOING_AWAY, 'server shutting down');
      const actualWsGone = Promise.all([...ownedWsTransports].map(t => t.actualClosed));
      if (attached) {
        hostServer.off('upgrade', upgradeListener);
        return Promise.all([gone, actualWsGone]).then(() => {});
      }
      const done = new Promise((resolve) => ownServer.close(() => resolve()));
      ownServer.closeIdleConnections();
      return Promise.all([done, gone, actualWsGone]).then(() => {});
    },
  };
}
