/**
 * 仅供测试，生产代码不得引用。
 *
 * HT-a（文档服务的会话模型 + 序号确认 + WebSocket 传输接会话层 + 本机信任开关）测试（`ht*.test.mjs`）的公共件。
 * 依据只有 `docs/plan/http-transport-contract.md` 第 2 版（含文件头「2026-09-27 拆分」）、语义
 * `docs/semantics/product/document-service.md` 与 `docs/semantics/mechanism/document-service.md` 的「会话与传输」；
 * 测试方没看实现（`claude/http-transport`、`claude/ht-client`）。HTTP 长轮询是 HT-b，本组测试一条都不测。
 *
 * 契约没写死的模块路径、选项名、回包形状全部集中在本文件，集成时对账只改这里。
 * 每一处假设用「假设 H<n>」标出，报告 `docs/archive/agent-reports/AGENT-ht-tests.md` 按同样的编号列出。
 *
 *   H1  服务端会话层在 `server/docservice/session.mjs`（契约第 2 节、第 15 节点名）。本组测试不直接调它的导出，
 *       全部经 `createDocService` 测：**这个文件在不在**就是「服务端会话层到位没有」的探测；在而行为不对，用例报错。
 *   H2  `createDocService` 新增选项 `retainMs`（保留时限，缺省 60 000，契约第 4.2 节）；`session.welcome.retainMs`
 *       等于它。其余选项（`heartbeatMs`、`maxPendingBytes`、`highWaterBytes`、`log`、`authenticate`）沿用现有名字。
 *   H3  会话项（契约第 4.1 节）：新会话 `promptcut.session.new`，与鉴权项同列；接续 `promptcut.session.<sid>.<ack>`，
 *       列表里只有 `promptcut.v1` 与它。会话项由会话层处理：新会话照常调 `authenticate(req)`；**接续不调**
 *       `authenticate`（会话号就是凭证，身份沿用建会话时的）。
 *   H4  建会话 / 接续成功后第一条出站消息 `{ type: 'session.welcome', sid, resumed, ack, retainMs, transport: 'ws' }`；
 *       `sid` 是 32 字节的 base64url（43 个字符，不带填充）。
 *   H5  接续失败（契约第 16 节第 1 条改了第 4.1 节）：服务端先接受升级（101），紧接着以关闭码告知——会话不存在
 *       4404 `no-session`，已结束（墓碑 2 分钟内）4410 `session-closed <原关闭码>[ <原原因>]`。`resumeStatus` 把 4404
 *       折算成 404、4410 折算成 410，握手就被拒的照回状态码，所以用例的判据（不存在 → 404、已结束 → 410）不变。
 *       〔集成对账 2026-09-27：原写「在握手里回 404 / 410」，写于第 16 节之前，按实现改〕
 *   H6  关闭码与原因：跳号 / 越界 ack → 1002 `bad-seq`（第 3.5 节）；半开的旧连接被替换 → 4009 `superseded`（第 3.1 节）；
 *       背压 → 1013 `backpressure`（H.2 原样）。
 *   H7  `/healthz.sessions`（第 8 节）：键 `total ws http detached legacy opened resumed expired fallbacks list`；
 *       `list[i]` 恰好是 `connId transport fallback detached legacy` 五个键；脱开时 `transport: null`。
 *       测试按契约里的例子读：`total === list.length`，`ws` = list 里 `transport === 'ws'` 的条数（旧客户端也走 ws、也计入），
 *       `detached` = list 里 `detached` 的条数，`legacy` = list 里 `legacy` 的条数。第 1 版的 `transports` 字段不再有。
 *       〔集成对账 2026-09-27：与实现一致；实现的 `opened` 连旧客户端一起累计（旧客户端也是会话）〕
 *   H8  `describe().conns[i]` 多 `transport`、`fallback`、`detached`、`resumes`（第 8 节）。
 *   H9  日志经 `createDocService` 的 `log(event, fields)` 出：`session.detach`、`session.resume { connId, transport, gapMs }`、
 *       保留期满 `conn.timeout`（第 4.2、8 节）；会话号不进任何日志。
 *   H10 客户端会话层 `server/render-node/session-link.mjs` 导出 `createDocEndpoint`（第 9 节）；`server/render-node/index.mjs`
 *       同名再导出。**这个文件在不在**就是「客户端会话层到位没有」的探测；文件在而没有这个导出，用例报错。
 *       选项（第 9 节）：`url`、`protocols`（函数，回鉴权列表，**不含**会话项，会话项由端点自己加）、`WebSocket`、`fetch`、
 *       `setTimeout`、`clearTimeout`、`random`、`backoff`（同 `BACKOFF_DEFAULTS` 的键）、`log`、`now`；
 *       另认 `transport: 'ws' | 'http'`（第 9 节「浏览器由调用方传 transport」）。返回值：`send`、`onMessage`、`onOpen`、
 *       `onResume`、`onClose`、`close`、`connected`、`closed`、`stats()`；`stats()` 至少有 `transport`、`fallbacks`、
 *       `resumes`、`pendingBytes`、`dropped`。
 *   H11 客户端在 HT-a 里读不到 WebSocket 握手的状态码（浏览器与 Node 内置 `WebSocket` 都读不到，第 4.3 节注），
 *       所以接续握不上时它分不出 404 / 410 与网络故障：**从脱开起过了 `welcome.retainMs` 还没接续上，就当会话已结束**，
 *       报 `onClose`，下一次重新建会话（重新调 `protocols()`）。实现若另有更快的办法（例如服务端先接受升级再以关闭码告知），
 *       这组用例照样通过：它们只要求「保留时限加几秒之内重建」。
 *       〔集成对账 2026-09-27：实现两条都做——收到 4404 / 4410（H5）立刻重建；握不上时脱开超过 `welcome.retainMs` 也重建〕
 *   H12 端点的 `close()` 先发 `{ type: 'session.close', … }` 再关（第 4.2 节「主动结束」由客户端发起）。
 *   H13 本机信任开关（第 10 节）：`server/hosted/main.mjs` 读 `PROMPTCUT_TRUST_LOOPBACK`；`0` 而没有集群令牌时拒绝启动，
 *       打 `config.error { reason: 'cluster-token-required' }`、退出码 1。探测：`server/hosted/` 下的 `.mjs` 里出现
 *       `PROMPTCUT_TRUST_LOOPBACK` 这个名字就算到位（只看名字在不在，不看写法）。
 *   H14 探针：`scripts/probes/shared-project-probe.mjs` 成员角色在 `PROMPTCUT_TRANSPORT=ws` 与 `--transport ws` 下只走 WebSocket，
 *       不带时自动（第 4.3 节第 6 条、第 14 节「探针的 --transport」）；强制 ws 时输出里不出现 `session.fallback`。
 *
 * 只引 Node 内置模块与同目录的 `fake-ws-kit.mjs`、`fake-raw-ws.mjs`。
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { wsClient, rawHandshake, waitFor, sleep } from './fake-ws-kit.mjs';

export { wsClient, rawHandshake, waitFor, sleep };

export const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
export const PROTOCOL = 'promptcut.v1';
export const SESSION_NEW = 'promptcut.session.new';
export const resumeItem = (sid, ack) => `promptcut.session.${sid}.${ack}`;
/** 32 字节 base64url：43 个字符 */
export const SID_RE = /^[A-Za-z0-9_-]{43}$/;

// ================================================================== 到位探测（H1、H10、H13）

const exists = (rel) => existsSync(path.join(ROOT, rel));

export const HAS_SERVER_SESSION = exists('server/docservice/session.mjs');
export const HAS_CLIENT_SESSION = exists('server/render-node/session-link.mjs');
export const HAS_TRUST_SWITCH = (() => {
  const dir = path.join(ROOT, 'cloud', 'server', 'hosted');
  try {
    return readdirSync(dir).filter((f) => f.endsWith('.mjs')).some((f) => readFileSync(path.join(dir, f), 'utf8').includes('PROMPTCUT_TRUST_LOOPBACK'));
  } catch {
    return false;
  }
})();

/** `test(name, { skip }, fn)` 用：到位就是 false（真跑），没到位就是写明原因的字符串 */
export const SKIP_SERVER = HAS_SERVER_SESSION ? false : '服务端会话层未到位：server/docservice/session.mjs 不存在（HT-a 集成后自动转为真跑，假设 H1）';
export const SKIP_CLIENT = HAS_CLIENT_SESSION ? false : '客户端会话层未到位：server/render-node/session-link.mjs 不存在（HT-a 集成后自动转为真跑，假设 H10）';
export const SKIP_BOTH = SKIP_SERVER || SKIP_CLIENT;
export const SKIP_TRUST = HAS_TRUST_SWITCH ? false : '本机信任开关未到位：server/hosted/*.mjs 里没有 PROMPTCUT_TRUST_LOOPBACK（HT-a 集成后自动转为真跑，假设 H13）';

// ================================================================== 服务端

/**
 * 测试用鉴权：列表里有 `promptcut.user.<id>` 就是这个用户，`promptcut.user.deny` 拒绝，都没有是 `u-default`。
 * 会话项、别的项一概不管（由会话层处理，H3）。`calls` 记被调了几次。
 */
export function testAuth() {
  const auth = {
    calls: 0,
    authenticate(req) {
      auth.calls += 1;
      const raw = String(req?.headers?.['sec-websocket-protocol'] ?? '');
      const items = raw.split(',').map((s) => s.trim()).filter(Boolean);
      const u = items.find((p) => p.startsWith('promptcut.user.'));
      const user = u ? u.slice('promptcut.user.'.length) : 'u-default';
      if (user === 'deny') return null;
      return { userId: user, tenantId: 't-ht' };
    },
  };
  return auth;
}

/**
 * 测试模块 `ht`：认领 `ht.` 前缀。
 *   ht.echo { n }           → 回 { type: 'ht.echoed', n }
 *   ht.sink                 → 不回（用来测「没有顺带的机会」时单发 session.ack）
 *   ht.burst { count, size, key? } → 连发 count 条 { type: 'ht.blob', i, pad }，key 给了就带合并键
 * `seen` 按到达顺序记模块看到的消息（原样，用来断言没有 seq / ack）；`connects` / `disconnects` 记生命周期；
 * `ctx` 是核心给的上下文（测试从外面往连接上发消息用）。
 */
export function htModule() {
  const mod = {
    name: 'ht',
    types: ['ht.'],
    seen: [],
    connects: [],
    disconnects: [],
    ctx: null,
    connect(ctx, connId, principal) { mod.ctx = ctx; mod.connects.push({ connId, principal, at: Date.now() }); },
    disconnect(ctx, connId) { mod.ctx = ctx; mod.disconnects.push({ connId, at: Date.now() }); },
    handle(ctx, connId, msg) {
      mod.ctx = ctx;
      mod.seen.push({ connId, msg });
      if (msg.type === 'ht.echo') ctx.send(connId, { type: 'ht.echoed', n: msg.n });
      else if (msg.type === 'ht.burst') {
        const pad = 'x'.repeat(msg.size ?? 1024);
        for (let i = 0; i < (msg.count ?? 1); i++) {
          ctx.send(connId, { type: 'ht.blob', i, pad }, typeof msg.key === 'string' ? { coalesceKey: msg.key } : undefined);
        }
      }
    },
  };
  return mod;
}

/**
 * 独立模式起服务（端口 0、只绑回环、`autoTick: false`），日志收进 `logs`。
 * `opts` 原样交给 `createDocService`（`retainMs` 见 H2）。
 */
export async function startService({ modules, ...opts } = {}) {
  const { createDocService } = await import(pathToFileURL(path.join(ROOT, 'server', 'docservice', 'service.mjs')).href);
  const logs = [];
  const auth = testAuth();
  const mod = htModule();
  const service = createDocService({
    log: (event, fields) => logs.push({ event, ...fields }),
    autoTick: false,
    authenticate: auth.authenticate,
    modules: modules ?? [mod],
    ...opts,
  });
  const { port } = await service.listen(0, '127.0.0.1');
  const clients = [];
  let closed = false;
  const env = {
    service, port, logs, auth, mod,
    url: `ws://127.0.0.1:${port}/`,
    health: async () => (await fetch(`http://127.0.0.1:${port}/healthz`)).json(),
    track(c) { clients.push(c); return c; },
    async cleanup() {
      if (closed) return;
      closed = true;
      for (const c of clients) { try { c.close(); } catch { /* 已关 */ } }
      await service.close();
    },
  };
  return env;
}

/**
 * 讲会话的测试客户端（Node 内置 WebSocket）：
 *   - 新会话：列表 `[promptcut.v1, promptcut.user.<user>, promptcut.session.new]`；
 *   - 接续：`[promptcut.v1, promptcut.session.<sid>.<ack>]`（H3）。
 * 等到 `session.welcome` 才返回。返回的对象在 `wsClient` 之上加：
 *   `welcome`、`sid`、`sendSeq(msg)`（自动编 seq，从 `startSeq + 1` 起）、`sendRaw(msg)`、`bizSeqs()`（收到的业务消息的 seq）、
 *   `ackOf()`（按序收全的服务端最大 seq）、`closeEvent`（Promise → { code, reason }）。
 * 本客户端不自动确认、不自动补发：测试逐条控制。
 */
export async function openSession(env, { user = 'alice', resume = null, startSeq = 0, extraProtocols = [] } = {}) {
  const protocols = resume
    ? [PROTOCOL, resumeItem(resume.sid, resume.ack ?? 0), ...extraProtocols]
    : [PROTOCOL, `promptcut.user.${user}`, SESSION_NEW, ...extraProtocols];
  const c = env.track(wsClient(env.url, protocols));
  try {
    await c.opened;
  } catch (err) {
    throw new Error(`会话握手失败（${resume ? '接续' : '新建'}）：${err.message}`);
  }
  const welcome = await c.next((m) => m?.type === 'session.welcome', 3000);
  return decorate(c, welcome, startSeq);
}

function decorate(c, welcome, startSeq) {
  let seq = startSeq;
  c.welcome = welcome;
  c.sid = welcome?.sid;
  c.sendSeq = (msg) => { seq += 1; c.send({ ...msg, seq }); return seq; };
  c.sendRaw = (msg) => c.send(msg);
  c.setSeq = (n) => { seq = n; };
  c.bizSeqs = () => c.all.filter((m) => typeof m?.type === 'string' && !m.type.startsWith('session.')).map((m) => m.seq);
  c.ackOf = () => {
    const got = new Set(c.bizSeqs().filter((n) => Number.isInteger(n)));
    let n = 0;
    while (got.has(n + 1)) n += 1;
    return n;
  };
  addEnded(c);
  return c;
}

/** `c.ended(ms)`：等这条连接关上，回 { code, reason }；超时抛错（免得用例挂死） */
function addEnded(c) {
  c.closeEvent = c.closed.then((e) => ({ code: e.code, reason: e.reason }));
  c.ended = (ms = 3000) => Promise.race([
    c.closeEvent,
    new Promise((_, reject) => { setTimeout(() => reject(new Error(`等连接关闭超时（${ms} ms）`)), ms).unref?.(); }),
  ]);
}

/** 旧客户端：不带会话项（契约第 3.6 节） */
export async function openLegacy(env, { user = 'alice' } = {}) {
  const c = env.track(wsClient(env.url, [PROTOCOL, `promptcut.user.${user}`]));
  await c.opened;
  addEnded(c);
  return c;
}

/** 接续失败折算成的状态码（H5）：4404 → 404、4410 → 410、真接续上 → 101；握手就被拒的照回状态码。不留连接 */
export async function resumeStatus(env, sid, ack = 0) {
  const { rawWsClient } = await import('./fake-raw-ws.mjs');
  let c;
  try {
    c = await rawWsClient(env.port, { protocols: [PROTOCOL, resumeItem(sid, ack)] });
  } catch (err) {
    const m = /HTTP\/1\.1 (\d{3})/.exec(String(err?.message));
    return m ? Number(m[1]) : -1;
  }
  // 握手成功：等服务端的关闭帧（契约第 16 节第 1 条）；3 s 内没关就是真接续上了
  const ended = await Promise.race([c.ended, new Promise((r) => { setTimeout(() => r(null), 3000).unref?.(); })]);
  c.destroy();
  const code = ended?.closeFrame?.code ?? c.closeFrame?.code;
  return code === 4404 ? 404 : code === 4410 ? 410 : 101;
}

/** `/healthz.sessions` 的形状（H7），返回 sessions */
export function checkSessionsShape(h) {
  assert.ok(h && typeof h.sessions === 'object' && h.sessions !== null, `/healthz 要有 sessions 字段：${JSON.stringify(h).slice(0, 600)}`);
  assert.ok(!Object.hasOwn(h, 'transports'), '第 1 版的 transports 字段不再有（契约第 8 节、第 14 节）');
  const s = h.sessions;
  for (const k of ['total', 'ws', 'http', 'detached', 'legacy', 'opened', 'resumed', 'expired', 'fallbacks']) {
    assert.ok(Number.isInteger(s[k]) && s[k] >= 0, `sessions.${k} 要是非负整数：${JSON.stringify(s)}`);
  }
  assert.ok(Array.isArray(s.list), `sessions.list 要是数组：${JSON.stringify(s)}`);
  for (const item of s.list) {
    assert.deepEqual(Object.keys(item).sort(), ['connId', 'detached', 'fallback', 'legacy', 'transport'],
      `sessions.list 每项恰好五个键（不含身份、地址与会话号）：${JSON.stringify(item)}`);
    assert.ok(item.transport === 'ws' || item.transport === 'http' || item.transport === null, `transport 取值：${JSON.stringify(item)}`);
    if (item.detached) assert.equal(item.transport, null, `脱开时 transport 为 null：${JSON.stringify(item)}`);
  }
  assert.equal(s.total, s.list.length, `total 等于 list 的条数：${JSON.stringify(s)}`);
  assert.equal(s.ws, s.list.filter((i) => i.transport === 'ws').length, `ws 与 list 对得上：${JSON.stringify(s)}`);
  assert.equal(s.http, s.list.filter((i) => i.transport === 'http').length, `http 与 list 对得上：${JSON.stringify(s)}`);
  assert.equal(s.detached, s.list.filter((i) => i.detached).length, `detached 与 list 对得上：${JSON.stringify(s)}`);
  assert.equal(s.legacy, s.list.filter((i) => i.legacy).length, `legacy 与 list 对得上：${JSON.stringify(s)}`);
  return s;
}

/** 断言一段文本里没有会话号 */
export function assertNoSid(text, sid, where) {
  assert.ok(typeof sid === 'string' && sid.length > 10, '会话号要是字符串');
  assert.ok(!String(text).includes(sid), `会话号不许出现在${where}里`);
}

// ================================================================== 客户端（H10）

let clientMod = null;
/** 载入 `session-link.mjs` 取 `createDocEndpoint`；文件在而导出不对就失败（不跳过） */
export async function loadDocEndpoint() {
  if (clientMod) return clientMod;
  let mod;
  try {
    mod = await import(pathToFileURL(path.join(ROOT, 'server', 'render-node', 'session-link.mjs')).href);
  } catch (err) {
    assert.fail(`载不进 server/render-node/session-link.mjs：${err?.message ?? err}`);
  }
  assert.equal(typeof mod.createDocEndpoint, 'function', `session-link.mjs 要导出 createDocEndpoint；实际导出：${Object.keys(mod).join(', ')}`);
  clientMod = mod;
  return mod;
}

/** 一律失败的 fetch（「HTTP 也连不上」）：HT-a 不接 HTTP，实现若去试也只会得到网络错误 */
export function refusingFetch() {
  const f = async () => { f.calls += 1; throw new TypeError('fetch failed (ht-kit: 测试里 HTTP 一律连不上)'); };
  f.calls = 0;
  return f;
}

/** 在环境变量里临时设（或删）一项，返回还原函数 */
export function withEnv(name, value) {
  const had = Object.hasOwn(process.env, name);
  const old = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  return () => {
    if (had) process.env[name] = old;
    else delete process.env[name];
  };
}

/**
 * 可控的假 WebSocket（浏览器 / Node 内置 `WebSocket` 的形状：`new WebSocket(url, protocols)`、`readyState`、`protocol`、
 * `send`、`close`、`addEventListener` 与 `on<事件>` 两种监听都支持）。每次构造记进 `sockets`。
 *
 * 测试侧的控制（在 socket 上）：
 *   accept(welcome?)   触发 open；给了 welcome 就紧接着发 `session.welcome`（缺的字段补默认）
 *   push(msg)          服务端发一条消息（对象，按 JSON 发）
 *   fail({ errorOnly }) 握手失败：触发 error；errorOnly 为真时**不**触发 close（2026-09-27 云端实测的 Node 行为）
 *   drop(code, reason) 服务端断开：触发 close
 *   sent               客户端发出的消息（解析后的对象）
 */
export function fakeWebSocketEnv() {
  const sockets = [];
  const waiters = [];
  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url, protocols) {
      this.url = String(url);
      this.protocols = protocols === undefined ? [] : [].concat(protocols);
      this.readyState = 0;
      this.protocol = '';
      this.bufferedAmount = 0;
      this.sent = [];
      this.listeners = { open: [], message: [], error: [], close: [] };
      this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
      this.closedByClient = null;
      sockets.push(this);
      for (const w of waiters.splice(0)) w();
    }
    addEventListener(type, fn) { this.listeners[type]?.push(fn); }
    removeEventListener(type, fn) { const l = this.listeners[type]; if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); } }
    emit(type, event) {
      for (const fn of [...(this.listeners[type] ?? [])]) fn(event);
      const prop = this[`on${type}`];
      if (typeof prop === 'function') prop.call(this, event);
    }
    send(text) {
      if (this.readyState !== 1) throw new Error('InvalidStateError: not open');
      let msg;
      try { msg = JSON.parse(text); } catch { msg = { __raw: String(text) }; }
      this.sent.push(msg);
    }
    close(code = 1000, reason = '') {
      if (this.readyState >= 2) return;
      const wasOpen = this.readyState === 1;
      this.readyState = 2;
      this.closedByClient = { code, reason };
      setImmediate(() => {
        this.readyState = 3;
        this.emit('close', { type: 'close', code: wasOpen ? code : 1006, reason: wasOpen ? reason : '', wasClean: wasOpen });
      });
    }
    // ---- 测试侧控制
    accept(welcome) {
      this.readyState = 1;
      this.protocol = 'promptcut.v1';
      this.emit('open', { type: 'open' });
      if (welcome) this.push({ type: 'session.welcome', sid: 'S'.repeat(43), resumed: false, ack: 0, retainMs: 60_000, transport: 'ws', ...welcome });
    }
    push(msg) {
      if (this.readyState !== 1) return;
      this.emit('message', { type: 'message', data: JSON.stringify(msg) });
    }
    fail({ errorOnly = false } = {}) {
      this.emit('error', { type: 'error', message: 'Unexpected server response: 401' });
      if (!errorOnly) {
        this.readyState = 3;
        this.emit('close', { type: 'close', code: 1006, reason: '', wasClean: false });
      }
    }
    drop(code = 1006, reason = '') {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit('close', { type: 'close', code, reason, wasClean: code !== 1006 });
    }
    /** 客户端发出的业务消息（不含 session.* 控制消息） */
    biz() { return this.sent.filter((m) => typeof m?.type === 'string' && !m.type.startsWith('session.')); }
    control(type) { return this.sent.filter((m) => m?.type === type); }
  }
  return {
    WebSocket: FakeWebSocket,
    sockets,
    last: () => sockets.at(-1),
    /** 等第 n 个（从 1 起）socket 被构造出来 */
    async nth(n, ms = 3000) {
      const until = Date.now() + ms;
      while (sockets.length < n) {
        if (Date.now() > until) throw new Error(`等第 ${n} 次 WebSocket 构造超时（${ms} ms），目前 ${sockets.length} 次`);
        await new Promise((resolve) => { waiters.push(resolve); setTimeout(resolve, 20); });
      }
      return sockets[n - 1];
    },
  };
}

/** 列表里是不是新会话 / 接续（H3） */
export const isNewSessionList = (list) => list[0] === PROTOCOL && list.includes(SESSION_NEW);
export const resumeOf = (list) => {
  const item = list.find((p) => p.startsWith('promptcut.session.') && p !== SESSION_NEW);
  if (!item) return null;
  const rest = item.slice('promptcut.session.'.length);
  const i = rest.lastIndexOf('.');
  return { sid: rest.slice(0, i), ack: Number(rest.slice(i + 1)) };
};

/**
 * 建一个端点：缺省用假 WebSocket、一律失败的 fetch、很短的退避（抖动 0）。`overrides` 覆盖。
 * `protocolsCalls` 记 `protocols()` 被调的次数；每次回 `[promptcut.v1, promptcut.user.alice, promptcut.nonce.<n>]`。
 */
export async function makeEndpoint(overrides = {}) {
  const { createDocEndpoint } = await loadDocEndpoint();
  const fake = fakeWebSocketEnv();
  const fetchImpl = refusingFetch();
  const calls = { protocols: 0 };
  const opened = [];
  const resumed = [];
  const closes = [];
  const messages = [];
  const ep = createDocEndpoint({
    url: 'ws://doc.test/hosted',
    protocols: () => { calls.protocols += 1; return [PROTOCOL, 'promptcut.user.alice', `promptcut.nonce.${calls.protocols}`]; },
    WebSocket: fake.WebSocket,
    fetch: fetchImpl,
    backoff: { baseMs: 10, factor: 2, maxMs: 40, jitter: 0 },
    random: () => 0.5,
    log: () => {},
    ...overrides,
  });
  ep.onOpen(() => opened.push(Date.now()));
  if (typeof ep.onResume === 'function') ep.onResume(() => resumed.push(Date.now()));
  ep.onClose((info) => closes.push(info));
  ep.onMessage((m) => messages.push(m));
  return { ep, fake, fetch: fetchImpl, calls, opened, resumed, closes, messages };
}

// ================================================================== 托管组合子进程（HT6、HT7）

/** 起 main.mjs：等 `listen` 行（回端口）或退出（回退出码与输出）。PROMPTCUT_* 只用这里给的 */
export function runHostedMain(t, env) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith('PROMPTCUT_')) delete base[k];
  const child = spawn(process.execPath, [path.join(ROOT, 'cloud', 'server', 'hosted', 'main.mjs')], {
    env: { ...base, PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1', PROMPTCUT_DOCSERVICE_PORT: '0', PROMPTCUT_ASSET_PORT: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  t.after(() => { try { child.kill(); } catch { /* 已退 */ } });
  let out = '';
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ code: 'timeout', out }), 20_000);
    const onData = (d) => {
      out += d;
      for (const line of out.split('\n')) {
        if (!line.startsWith('{')) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.event === 'listen') {
          clearTimeout(timer);
          child.stdout.off('data', onData);
          resolve({ code: null, out, child, doc: j.docservice?.port, asset: j.asset?.port, listen: j });
          return;
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => { out += d; });
    child.once('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

