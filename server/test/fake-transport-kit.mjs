/**
 * 仅供测试，生产代码不得引用。
 *
 * 文档服务两种传输（WebSocket 与 HTTP 长轮询，`docs/plan/http-transport-contract.md`）的测试共用件：
 *
 *   transportClient(kind, url, protocols?)  kind 为 'ws' 用 Node 内置 WebSocket，'http' 用 `HttpWebSocket`；
 *                                           回的对象与 fake-ws-kit 的 wsClient 同形（opened / closed / send / next / quiet / close）。
 *                                           注意：`HttpWebSocket` 还是第 1 版的长轮询协议（批次号、`{ seq, data }` 外包），
 *                                           与第 2 版的服务端（会话层下的 `docservice/http-transport.mjs`）不通，HT-b 改客户端时一并改
 *   authByProtocols(req)                    按子协议列表里的 `x-user.<名>`、`x-role.<角色>`、`x-conv.<号>`、`x-dev.<设备>` 定 principal；
 *                                           `x-user.deny` 拒绝。两种传输都经 `sec-websocket-protocol` 交给它
 *   protocolsOf({ user, role, conv, dev })  拼上面那种列表（第一项 promptcut.v1）
 *   lp(base)                                直接打长轮询端点的原始客户端（契约第 2 版第 6 节）：open / send / recv / close / options，
 *                                           回 { status, body, headers }。open 的列表里要自己带会话项
 *   recvUntil(client, sid, match, opts)     反复 GET 收帧（帧是带 seq 的消息文本），直到 match 为真或带 closed
 *
 * 只引 Node 内置模块与被测的 `render-node/http-transport.mjs`。
 */
import { HttpWebSocket } from '../render-node/http-transport.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 子协议列表（`sec-websocket-protocol` 头） */
function offered(req) {
  const raw = req?.headers?.['sec-websocket-protocol'];
  if (raw === undefined) return [];
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

export function authByProtocols(req) {
  const list = offered(req);
  const pick = (prefix) => list.find((p) => p.startsWith(prefix))?.slice(prefix.length) ?? null;
  const user = pick('x-user.') ?? 'u-default';
  if (user === 'deny') return null;
  const role = pick('x-role.');
  if (!role) return { userId: user, tenantId: 't-test' };
  const dev = pick('x-dev.') ?? 'dev-1';
  const conv = pick('x-conv.');
  return {
    userId: `${user}@${dev}`, tenantId: 't-test', scope: 'member', username: user, deviceId: dev, deviceName: dev,
    creator: false, role, conversation: conv ? Number(conv) : null, owner: null,
  };
}

export function protocolsOf({ user, role, conv, dev } = {}) {
  const out = ['promptcut.v1'];
  if (user) out.push(`x-user.${user}`);
  if (role) out.push(`x-role.${role}`);
  if (conv) out.push(`x-conv.${conv}`);
  if (dev) out.push(`x-dev.${dev}`);
  return out;
}

export function transportClient(kind, url, protocols) {
  const Impl = kind === 'http' ? HttpWebSocket : WebSocket;
  const ws = protocols === undefined ? new Impl(url) : new Impl(url, protocols);
  const inbox = [];
  const all = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { msg = { __raw: String(e.data) }; }
    all.push(msg);
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error(`${kind} 连接失败`)), { once: true });
  });
  opened.catch(() => {});
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e), { once: true }));
  return {
    kind, ws, opened, closed, all, inbox,
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    next(match = () => true, ms = 3000) {
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) { waiters.splice(k, 1); reject(new Error(`[${kind}] 等消息超时；已收到：${JSON.stringify(all).slice(0, 800)}`)); }
        }, ms);
      });
    },
    async quiet(match = () => true, ms = 150) {
      const before = all.length;
      await sleep(ms);
      return all.slice(before).filter(match);
    },
    close() { try { ws.close(); } catch { /* 已关 */ } },
  };
}

/** 长轮询端点的原始客户端（测服务端协议本身） */
export function lp(base) {
  const root = base.replace(/\/+$/, '');
  const call = async (method, route, { headers = {}, body, query = '' } = {}) => {
    const res = await fetch(`${root}/lp/${route}${query}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { __raw: text }; }
    return { status: res.status, body: parsed, headers: res.headers };
  };
  const bearer = (sid) => ({ authorization: `Bearer ${sid}` });
  return {
    open(protocols = ['promptcut.v1', 'promptcut.session.new'], headers = {}) {
      const h = { ...headers };
      if (protocols !== null) h['x-promptcut-protocols'] = [].concat(protocols).join(', ');
      return call('POST', 'open', { headers: h, body: '{}' });
    },
    /** `frames`：对象（自己带 seq）或已序列化的文本 */
    send(sid, frames) {
      return call('POST', 'send', { headers: { ...bearer(sid), 'content-type': 'application/json' }, body: JSON.stringify({ frames: frames.map((f) => (typeof f === 'string' ? f : JSON.stringify(f))) }) });
    },
    sendRaw(sid, body) {
      return call('POST', 'send', { headers: { ...bearer(sid), 'content-type': 'application/json' }, body });
    },
    recv(sid, ack = 0, wait = 0) {
      return call('GET', 'recv', { headers: bearer(sid), query: `?ack=${ack}&wait=${wait}` });
    },
    close(sid, body = {}) {
      return call('POST', 'close', { headers: { ...bearer(sid), 'content-type': 'application/json' }, body: JSON.stringify(body) });
    },
    options(route, headers = {}) {
      return call('OPTIONS', route, { headers });
    },
    call,
  };
}

/** 收帧直到 match 为真（长轮询），回 { frames: 收到的消息对象（按 seq 去重）, ack } */
export async function recvUntil(client, sid, match, { ack = 0, ms = 3000, wait = 500 } = {}) {
  const until = Date.now() + ms;
  const got = [];
  let last = ack;
  while (Date.now() < until) {
    const r = await client.recv(sid, last, wait);
    if (r.status !== 200) throw new Error(`recv ${r.status} ${JSON.stringify(r.body)}`);
    for (const text of r.body.frames) {
      const m = JSON.parse(text);
      if (!(m.seq > last)) continue;
      last = m.seq;
      got.push(m);
    }
    if (r.body.closed || got.some(match)) return { frames: got, ack: last, closed: r.body.closed };
  }
  throw new Error(`等帧超时；已收到：${JSON.stringify(got).slice(0, 800)}`);
}
