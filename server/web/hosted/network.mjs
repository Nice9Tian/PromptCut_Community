/**
 * 云端 Agent 的浏览器怎么出网(计划 `docs/plan/cloud-agent-tools-implementation.md` 的 W1 包;契约 `docs/plan/cloud-agent-contract.md` 第 9.6 节)。
 *
 * 浏览器是模型在开:它去哪由网页决定,网页不可信。所以浏览器的**一切**出网只留一条路——本文件起的、只绑回环的正向代理,
 * 代理对每个目标过出网闸(`server/agent/service/egress.mjs` 的 `admit` / `admitUrl`)并连到核过的那个地址上。
 * 其余的路在启动参数里逐条堵上(`hostedNetworkArgs`),每条在 `server/test/cloud-tools-w1-egress.test.mjs` 里有一条测试:
 *
 *   | 绕过代理的途径                         | 怎么堵                                                                 |
 *   |----------------------------------------|------------------------------------------------------------------------|
 *   | 回环、链路本地地址(含 169.254.169.254) | Chrome 对这两类地址**缺省不走代理**;`--proxy-bypass-list=<-loopback>` 去掉这条缺省,代理再拒 |
 *   | 内网、IPv6 的对应范围、内嵌 IPv4 的前缀 | 都到代理,出网闸的黑名单拒                                              |
 *   | 浏览器自己解析主机名(含 DNS 预取)    | `--host-resolver-rules=MAP * ~NOTFOUND`:浏览器一个名字都解析不了,名字只交给代理解析 |
 *   | DNS 重绑定                             | 代理每个请求(明文)/每条隧道(CONNECT)重新解析、核对、连到核过的地址;浏览器不解析,没有第二次解析可骗 |
 *   | 跳转到内网                             | 浏览器跟的每一跳都是一个新的代理请求,同样被拒                         |
 *   | WebSocket                              | 经代理的 CONNECT,同样过闸                                              |
 *   | WebRTC(UDP 直连、泄露本机地址)       | `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`:不走代理的 UDP 一律不发,也不收集本机地址 |
 *   | QUIC / HTTP3(UDP)                    | `--disable-quic`                                                       |
 *   | `file:` 等非 http(s) 协议              | 工具入口只收 http(s);页面里的请求由 `session.mjs` 的请求拦截按协议掐掉;落地后的地址再核一次 |
 *   | 下载                                   | `session.mjs` 用 `Browser.setDownloadBehavior { behavior: 'deny' }`,不落盘 |
 *   | 调试端口                               | 用管道(`pipe: true`)连浏览器,不开任何调试端口,网页连不到             |
 *
 * 代码这一层管的是「经它出去的」;浏览器进程若有本文件没堵到的直连途径,靠节点上的系统级出站限制兜底(部署说明里写,同 9.4d 的残余面)。
 * 卡片里的外链不经这里:那是渲染服务与在线舞台的事。
 *
 * 纯 Node,不引用 `src/`,不引第三方包。
 */
import http from 'node:http';
import net from 'node:net';

/** 浏览器地址栏与页面请求里许出现的协议。`about:`、`data:`、`blob:` 不出网,留给页面自己用 */
const PAGE_SCHEMES = new Set(['http:', 'https:', 'about:', 'data:', 'blob:']);

/** 明文代理转发时不往上游带的头 */
const HOP_HEADERS = /^(proxy-.*|connection|keep-alive|te|trailer|upgrade)$/i;

/** 页面里的一个请求按协议许不许发 */
export function pageRequestAllowed(url) {
  const m = /^([a-z][a-z0-9+.-]*:)/i.exec(String(url ?? ''));
  return !!m && PAGE_SCHEMES.has(m[1].toLowerCase());
}

/** 一个地址是不是 http(s) 的(落地后的地址用它核) */
export function isWebUrl(url) {
  return /^https?:\/\//i.test(String(url ?? ''));
}

export class WebTargetError extends Error {
  /** @param {string} code `protocol` / `empty` / `too-long` */
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * 模型给的地址 → 要打开的 http(s) 地址。不带协议的按 https 补(与桌面版一致);
 * 带了别的协议的(`file:`、`chrome:`、`view-source:`、`data:`、`javascript:` 等)一律拒,不补、不猜。
 */
export function normalizeWebTarget(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new WebTargetError('empty', '要给 url');
  if (raw.length > 4096) throw new WebTargetError('too-long', '地址太长');
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new WebTargetError('protocol', '地址里有非法字符');
  if (/^https?:\/\//i.test(raw)) return raw;
  // 「名字:端口/路径」不是协议:名字里有点(或就是 localhost)、冒号后面紧跟数字。`tel:123` 这类不算。其余带「协议:」前缀的都不是 http(s)
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (scheme && !/^([^/:]+\.[^/:]+|localhost):\d{1,5}(\/|$|\?|#)/i.test(raw)) {
    throw new WebTargetError('protocol', `云端 Agent 的浏览器只打开 http / https 地址,不打开 ${scheme[1].toLowerCase()}: 地址。`);
  }
  if (raw.startsWith('//') || raw.startsWith('\\\\')) throw new WebTargetError('protocol', '云端 Agent 的浏览器只打开 http / https 地址。');
  return `https://${raw}`;
}

/** 出网闸的原因码 → 给模型看的一句话 */
export function egressRefusalText(code) {
  switch (code) {
    case 'blocked-address': return '这个地址指向云节点本机、内网或保留地址,云端 Agent 的浏览器不许访问。';
    case 'port': return '云端 Agent 的浏览器只许访问 80、443、8080、8443 端口。';
    case 'protocol': return '云端 Agent 的浏览器只打开 http / https 地址。';
    case 'credentials': return '地址里不许带用户名口令。';
    case 'unresolved': return '这个主机名解析不了。';
    default: return '这个地址被云端的出网限制拒绝了。';
  }
}

/**
 * 模型给的地址能不能打开:先按字面只收 http(s),再过一遍出网闸。
 * 回 `{ ok: true, target }`,或 `{ ok: false, result }`(`result` 就是回给模型的那份拒绝)。出网闸以外的错照常抛。
 */
export async function admitWebTarget(gate, input) {
  let target;
  try { target = normalizeWebTarget(input); } catch (err) {
    if (!(err instanceof WebTargetError)) throw err;
    return { ok: false, result: { ok: false, error: err.code === 'empty' ? err.message : `没有打开:${err.message}`, refused: err.code } };
  }
  try {
    // 交给浏览器的是出网闸解析、规范化之后的那个地址(主机名小写、十进制 IP 还原成点分等),不是模型给的原字符串:核的和开的是同一个
    const { url } = await gate.admitUrl(target);
    return { ok: true, target: url.href };
  } catch (err) {
    if (!err?.egress) throw err;
    return { ok: false, result: { ok: false, error: `没有打开:${egressRefusalText(err.code)}`, egress: err.code } };
  }
}

/**
 * 浏览器的启动参数里和出网有关的那一组。`proxyUrl` 是 `startBrowserProxy` 回的地址。
 * 顺序无关;调用方把它们放在自己的参数之后、部署者追加的参数之前。
 */
export function hostedNetworkArgs(proxyUrl) {
  return [
    `--proxy-server=${proxyUrl}`,
    // Chrome 缺省对回环与链路本地地址不走代理。去掉这条缺省,它们才会到代理并被拒;169.254.169.254 就在链路本地里
    '--proxy-bypass-list=<-loopback>',
    // 浏览器自己一个主机名都解析不了(DNS 预取、任何没走代理的请求都落空);代理的地址是字面 IP,不受影响
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-quic',
    // 浏览器自己发起的后台请求(组件更新、同步、安全浏览、统计):关掉,关不干净的也只能经代理
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-domain-reliability',
    '--disable-client-side-phishing-detection',
    '--no-pings',
  ];
}

/**
 * 部署者能追加的启动参数:**白名单,整条相等才留**。只列确有部署需要、而且不碰出网与隔离的几个:
 *
 *   - `--no-sandbox`、`--disable-setuid-sandbox`:节点上以 root 跑、或内核不许非特权用户建命名空间时,浏览器自己的沙箱起不来;
 *   - `--no-zygote`:某些容器里 zygote 起不来(只能和 `--no-sandbox` 一起用);
 *   - `--disable-dev-shm-usage`:容器的 /dev/shm 太小时,共享内存改放临时目录;
 *   - `--disable-gpu`、`--disable-software-rasterizer`:没有显卡的节点上省掉 GPU 进程;
 *   - `--disable-field-trial-config`:本机 Chrome for Testing 打头的那一个(见 `session.mjs` 的 `HOSTED_BROWSER_ARG_PREFIX`)。
 *
 * 用黑名单挡不住:浏览器有上千个开关,能改代理、换缓存目录、放宽证书校验、关站点隔离、往盘上记网络日志与 TLS 密钥的不止一二十个,
 * 还会随版本增加。名单外的一律丢掉(记一行日志,只记个数)。
 */
export const ALLOWED_EXTRA_ARGS = Object.freeze([
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--no-zygote',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-field-trial-config',
]);

/** 追加的启动参数(部署者给的、以及打头的那几个):留下白名单里的,回 `{ args, dropped }` */
export function filterExtraArgs(extra) {
  const args = [];
  const dropped = [];
  for (const a of Array.isArray(extra) ? extra : []) {
    if (typeof a === 'string' && ALLOWED_EXTRA_ARGS.includes(a)) { if (!args.includes(a)) args.push(a); } else dropped.push(String(a));
  }
  return { args, dropped };
}

/**
 * 给一个浏览器用的正向代理(只绑回环、随机端口)。每个目标过出网闸,连到核过的地址。
 *
 * 与 `egress.mjs` 的 `startProxy` 做同一件事,另外多三样浏览器要的:逐条的连接记录(给拒绝说明、探针与测试取证)、
 * 同时开着的隧道数上限、关闭时回「连接是不是都断了」。
 *
 * @param {object} o
 * @param {{ admit(hostname: string, port: number): Promise<{ address: string, family: number, port: number }>, admitUrl(input: string): Promise<{ url: URL, target: { address: string, family: number, port: number } }> }} o.gate
 * @param {number} [o.maxTunnels] 同时开着的隧道(CONNECT)上限
 * @param {number} [o.maxJournal] 连接记录留多少条
 * @param {(event: string, fields?: object) => void} [o.log] 服务日志:只有原因码与端口,不记主机名
 * @returns {Promise<{ url: string, port: number, journal(): object[], stats(): object, close(): Promise<{ closed: boolean }> }>}
 */
export async function startBrowserProxy({ gate, host = '127.0.0.1', maxTunnels = 64, maxJournal = 400, log = () => {}, now = () => Date.now() } = {}) {
  if (typeof gate?.admit !== 'function' || typeof gate?.admitUrl !== 'function') throw new Error('browser proxy needs an egress gate');
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响判定 */ } };
  const sockets = new Set();
  const entries = [];
  const counts = { allowed: 0, refused: 0, tunnels: 0 };
  let seq = 0;

  /** 记一条:主机名只留在内存里的这份记录里(给模型解释、给测试取证),服务日志里不出现 */
  function record(kind, hostname, port, outcome) {
    seq += 1;
    const entry = { seq, at: now(), kind, host: String(hostname ?? '').replace(/^\[|\]$/g, '').slice(0, 255), port, ...outcome };
    entries.push(entry);
    if (entries.length > maxJournal) entries.splice(0, entries.length - maxJournal);
    if (outcome.ok) counts.allowed += 1;
    else { counts.refused += 1; say('agent.web.egress-refused', { kind, code: outcome.code, port }); }
    return entry;
  }

  const track = (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => {});
  };

  const server = http.createServer((req, res) => {
    // 明文 HTTP:请求行里是绝对地址。每个请求各核一次(同一条到代理的连接上换目标也逃不过)
    void (async () => {
      let hostname = '';
      let port = 0;
      try {
        try { const u = new URL(req.url ?? ''); hostname = u.hostname; port = u.port ? Number(u.port) : 80; } catch { /* 交给 admitUrl 报 */ }
        const { url, target } = await gate.admitUrl(req.url ?? '');
        if (url.protocol !== 'http:') throw Object.assign(new Error('plain channel is http only'), { egress: true, code: 'protocol' });
        record('http', url.hostname, target.port, { ok: true, address: target.address });
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.test(k)) headers[k] = v;
        // 连核过的那个地址(明文没有证书要对名字,直接给 IP 就是「不二次解析」)
        const up = http.request({
          host: target.address, family: target.family, port: target.port, path: `${url.pathname}${url.search}`, method: req.method,
          headers: { ...headers, host: url.host }, agent: false,
        });
        up.once('socket', track);
        up.once('response', (r) => {
          const out = {};
          for (const [k, v] of Object.entries(r.headers)) if (!/^(connection|keep-alive|proxy-.*)$/i.test(k)) out[k] = v;
          res.writeHead(r.statusCode ?? 502, out);
          r.pipe(res);
        });
        up.once('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end(); });
        res.once('close', () => up.destroy());
        req.pipe(up);
      } catch (err) {
        const code = err?.egress ? String(err.code ?? 'error') : 'error';
        record('http', hostname, port, { ok: false, code });
        res.writeHead(err?.egress ? 403 : 502, { 'content-type': 'text/plain; charset=utf-8', 'x-egress-refused': code });
        res.end(`egress refused: ${code}`);
      }
    })();
  });
  server.on('connection', track);
  server.on('connect', (req, client, head) => {
    track(client);
    void (async () => {
      const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(String(req.url ?? ''));
      const hostname = m ? m[1].replace(/^\[|\]$/g, '') : '';
      const port = m ? Number(m[2]) : 0;
      try {
        if (!m) throw Object.assign(new Error('bad CONNECT target'), { egress: true, code: 'protocol' });
        if (counts.tunnels >= maxTunnels) throw Object.assign(new Error('too many tunnels'), { egress: true, code: 'busy' });
        const target = await gate.admit(m[1], port);
        record('connect', hostname, port, { ok: true, address: target.address });
        counts.tunnels += 1;
        const up = net.connect({ host: target.address, port: target.port, family: target.family });
        track(up);
        let counted = true;
        const release = () => { if (counted) { counted = false; counts.tunnels -= 1; } };
        up.once('connect', () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
          if (head?.length) up.write(head);
          up.pipe(client);
          client.pipe(up);
        });
        up.once('error', () => { try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* 已经断了 */ } });
        up.once('close', () => { release(); client.destroy(); });
        client.once('close', () => { release(); up.destroy(); });
      } catch (err) {
        const code = err?.egress ? String(err.code ?? 'error') : 'error';
        record('connect', hostname, port, { ok: false, code });
        try { client.end(`HTTP/1.1 403 Forbidden\r\nx-egress-refused: ${code}\r\ncontent-length: 0\r\n\r\n`); } catch { /* 已经断了 */ }
      }
    })();
  });
  server.on('clientError', (_err, socket) => {
    try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); else socket.destroy(); } catch { /* 已经断了 */ }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, resolve);
  });
  const port = server.address().port;
  let closing = null;

  return {
    port,
    url: `http://${host}:${port}`,
    /** 连接记录的副本(旧的在前) */
    journal: () => entries.map((e) => ({ ...e })),
    /** 序号大于 `after` 的拒绝记录 */
    refusedSince: (after) => entries.filter((e) => e.seq > after && !e.ok).map((e) => ({ ...e })),
    get seq() { return seq; },
    stats: () => ({ ...counts, open: sockets.size }),
    close() {
      closing ??= (async () => {
        for (const s of sockets) { try { s.destroy(); } catch { /* 已经关了 */ } }
        await new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
        // 等所有连接真的 close 掉(destroy 之后是异步的)
        const end = Date.now() + 3_000;
        while (sockets.size && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
        return { closed: sockets.size === 0 };
      })();
      return closing;
    },
  };
}
