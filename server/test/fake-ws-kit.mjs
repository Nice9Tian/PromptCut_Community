/**
 * 仅供测试与探针，生产代码不得引用。
 *
 * M5a 网络层测试（契约 `docs/plan/render-queue-contract.md` G.9）与探针（G.8）共用的小工具：
 *
 *   wsClient(url, protocols?)        Node 内置 WebSocket 客户端，收到的消息排队，按条件等
 *   rawHandshake(port, { protocols, path })   原始 TCP 握手，拿到状态码和响应头（测 401 / 子协议回显）
 *   createTcpProxy({ target })       可控的 TCP 代理：cutAll() 强行断开、mode = 'pass' | 'reject'、retarget()
 *   createSleepExecutor({ taskMs })  用真实计时器睡眠的执行器（契约 D.1 的 executor 形状）
 *   refusingPort()                   测试自己占着、连上就 RST 的端口（「连不上」的地址），用完 close
 *   waitFor(pred, ms)                轮询等条件成立
 *   randomToken()                    32 字节随机 base64url（G.5 的令牌格式），测试里现生成，不写死
 *   snapshotTaskInput(...)           造一个合法的 snapshot 细任务（契约 A.4）
 *
 * 只引 Node 内置模块。
 */
import { connect as netConnect, createServer as netCreateServer } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';

export const randomToken = () => randomBytes(32).toString('base64url');

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** 轮询等 pred() 返回真值；超时抛错（带 what 说明）。 */
export async function waitFor(pred, ms = 3000, what = '条件') {
  const until = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > until) throw new Error(`等${what}超时（${ms} ms）`);
    await sleep(5);
  }
}

/** 用 Node 内置 WebSocket 连上，收到的消息排进队列，按条件等。 */
export function wsClient(url, protocols) {
  const ws = protocols === undefined ? new WebSocket(url) : new WebSocket(url, protocols);
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
    ws.addEventListener('error', () => reject(new Error('连接失败')), { once: true });
  });
  opened.catch(() => {});
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e), { once: true }));
  return {
    ws, opened, closed,
    /** 收到过的全部消息（含已被 next 取走的） */
    all,
    /** 还没被 next 取走的消息 */
    inbox,
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    next(match = () => true, ms = 2000) {
      const i = inbox.findIndex(match);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) { waiters.splice(k, 1); reject(new Error(`等消息超时；已收到：${JSON.stringify(all).slice(0, 800)}`)); }
        }, ms);
      });
    },
    /** 等 ms 毫秒，返回这段时间里新进 inbox 且匹配的消息（用来断言「收不到」） */
    async quiet(match = () => true, ms = 150) {
      const before = all.length;
      await sleep(ms);
      return all.slice(before).filter(match);
    },
    close() { try { ws.close(); } catch { /* 已关 */ } },
  };
}

export const byType = (type) => (m) => m?.type === type;
export const byReq = (reqId) => (m) => m?.reqId === reqId;

/**
 * 原始 TCP 握手：发 Upgrade 请求（可带 Sec-WebSocket-Protocol），读到响应头为止。
 * → { status, headers: { 小写名: 值 }, rawHead, sock }。调用方负责 sock.destroy()。
 */
export async function rawHandshake(port, { protocols, path = '/', host = '127.0.0.1' } = {}) {
  const sock = netConnect(port, host);
  sock.on('error', () => {});
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject); });
  let buf = Buffer.alloc(0);
  const key = randomBytes(16).toString('base64');
  const lines = [
    `GET ${path} HTTP/1.1`, `Host: ${host}:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13',
  ];
  if (protocols !== undefined) lines.push(`Sec-WebSocket-Protocol: ${[].concat(protocols).join(', ')}`);
  sock.write(`${lines.join('\r\n')}\r\n\r\n`);
  const head = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('等握手响应超时')), 3000);
    const onData = (d) => {
      buf = Buffer.concat([buf, d]);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) return;
      clearTimeout(t);
      sock.off('data', onData);
      resolve(buf.subarray(0, end).toString('latin1'));
    };
    sock.on('data', onData);
    sock.once('close', () => { clearTimeout(t); resolve(buf.toString('latin1')); });
  });
  const [statusLine, ...rest] = head.split('\r\n');
  const headers = {};
  for (const line of rest) {
    const i = line.indexOf(':');
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
  return { status: Number(statusLine.split(' ')[1]), headers, rawHead: head, sock, acceptOk: headers['sec-websocket-accept'] === accept };
}

/**
 * 可控的 TCP 代理（测试用，不解析 WebSocket）：
 *   mode = 'pass'    正常转发
 *   mode = 'reject'  新连接一接上就断（模拟连不上）
 *   cutAll()         把现有连接两头都断掉（模拟服务端强行断开 / 网络断）
 *   retarget(port)   之后的新连接转到另一个端口
 *   accepted         累计接受过的连接数（含被 reject 的）
 */
export async function createTcpProxy({ target, host = '127.0.0.1' }) {
  let targetPort = target;
  const pairs = new Set();
  const proxy = {
    mode: 'pass',
    accepted: 0,
    port: 0,
    cutAll() {
      for (const p of pairs) { p.a.destroy(); p.b.destroy(); }
      pairs.clear();
    },
    retarget(port) { targetPort = port; },
    live: () => pairs.size,
    close() {
      proxy.cutAll();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  const server = netCreateServer((a) => {
    proxy.accepted += 1;
    a.on('error', () => {});
    if (proxy.mode === 'reject') { a.destroy(); return; }
    const b = netConnect(targetPort, host);
    b.on('error', () => {});
    const pair = { a, b };
    pairs.add(pair);
    a.pipe(b);
    b.pipe(a);
    const drop = () => { pairs.delete(pair); a.destroy(); b.destroy(); };
    a.on('close', drop);
    b.on('close', drop);
  });
  await new Promise((resolve) => server.listen(0, host, resolve));
  proxy.port = server.address().port;
  return proxy;
}

/** 起一个只回固定 /healthz 的 HTTP 服务（T6 用）。body 为 null 时永不回应（测超时）。 */
export async function healthServer(body) {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    if (body === null) return; // 挂住
    if (req.url?.startsWith('/healthz')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

/**
 * 一个「连不上」的端口：由测试自己占着，连上就立刻 RST（`{ port, close }`，用完 close）。
 *
 * 不用「先占一个空闲端口再关掉、假定它没人监听」：全量测试几十个进程并行，关掉的端口随时可能被别的进程
 * 拿去（Windows 顺序发号，绕一圈就回来；别的系统随机发号），「应当连不上」就连上了别人的服务。
 * 占着不放就不会；对调用方来说效果和被拒一样（fetch / http.request / WebSocket 都立刻报错）。
 */
export async function refusingPort() {
  const server = netCreateServer((socket) => {
    socket.on('error', () => {});
    if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
    else socket.destroy();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return { port, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/**
 * 用真实计时器睡眠的执行器（契约 D.1）。render 睡 taskMs（按 50 ms 一步报进度），可被 signal 中止。
 * plan 不支持（这些测试和探针只发细任务）。calls 记下每次 render 的任务 id。
 */
export function createSleepExecutor({ taskMs = 50 } = {}) {
  const calls = [];
  return {
    calls,
    plan: async () => { throw Object.assign(new Error('sleep-executor 不算计划'), { retryable: false }); },
    render(task, { signal, progress }) {
      calls.push(task.id);
      return new Promise((resolve, reject) => {
        let done = 0;
        const step = Math.min(50, taskMs);
        const iv = setInterval(() => { done += 1; try { progress?.(done); } catch { /* 忽略 */ } }, step);
        const t = setTimeout(() => { clearInterval(iv); resolve({ frames: task.range ? task.range.to - task.range.from + 1 : 0 }); }, taskMs);
        signal?.addEventListener('abort', () => {
          clearTimeout(t);
          clearInterval(iv);
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        }, { once: true });
      });
    },
  };
}

/** 造一个合法的 snapshot 细任务（契约 A.4：id = `snapshot:${resultKey}:${from}-${to}`）。 */
export function snapshotTaskInput({ resultKey, from = 0, to = 29, projectId = 'probe-project', projectRev = 1, weight = 'light' }) {
  return {
    id: `snapshot:${resultKey}:${from}-${to}`,
    kind: 'snapshot',
    tier: 'shared',
    resultKey,
    range: { unit: 'localFrame', from, to },
    source: { projectId, projectRev },
    input: {},
    weight: { class: weight, estMs: null, frames: to - from + 1 },
    requires: {},
    priority: 0,
  };
}
