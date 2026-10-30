/**
 * 云端 Agent 的出网闸(任务书 `docs/plan/cloud-agent-task.md` J;契约 `docs/plan/cloud-agent-contract.md` 第 9.6 节)。
 *
 * 凡是按模型给的地址发请求的工具(网页采集、下载、按地址导入素材、网页接管),在托管档一律经这一处:
 *
 *   - 只许 http / https;地址里不许带用户名口令;端口只许清单里的;
 *   - 主机名先解析,**解析出的每一个地址**都要过黑名单:回环、链路本地(含 169.254.169.254)、私有网段、运营商级 NAT、
 *     组播与保留段、本机各网卡的地址,以及 IPv6 的对应范围(含 IPv4 映射、NAT64、6to4、Teredo 这些能把内网地址包进去的前缀)。
 *     有一个不过就整个拒绝(一个名字同时指着外网与内网的,不赌它这次连哪个);
 *   - **按解析结果连接,不二次解析**:连接时的 `lookup` 钉死在刚核过的那个地址上,防 DNS 重绑定;
 *   - 重定向不交给底层跟:每一跳都重新走上面全部检查,最多 `maxRedirects` 跳;跨源的跳不带鉴权头;
 *   - 响应体有上限,超了当场断开;整体有时限。
 *
 * 两种用法:进程内的 `request()`;子进程(下载器、浏览器)经 `startProxy()` 起的一个只绑回环的正向代理出网,
 * 代理对每个目标做同样的检查——子进程自己解析、自己连的,靠部署时的系统级限制兜底(部署说明里写)。
 *
 * 测试例外:`testAllow` 是一组「IP:端口」,只有探针与单测给;给了就在日志里打一行 `agent.egress.test-allow`,
 * 状态口也报。生产不设这个环境变量(`PROMPTCUT_AGENT_EGRESS_TEST_ALLOW`),缺省为空。
 *
 * 纯 Node,不引用 `src/`,不引第三方包。
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';

export const EGRESS_DEFAULTS = Object.freeze({
  /** 许连的端口 */
  ports: Object.freeze([80, 443, 8080, 8443]),
  maxRedirects: 5,
  /** 单个响应体的上限 */
  maxBytes: 512 * 1024 * 1024,
  /** 一次请求(含各跳)的时限 */
  timeoutMs: 60_000,
  /** 本机网卡地址缓存多久 */
  interfaceTtlMs: 30_000,
});

export class EgressError extends Error {
  /** @param {string} code `protocol` / `credentials` / `port` / `blocked-address` / `unresolved` / `redirects` / `too-large` / `timeout` / `network` */
  constructor(code, message) {
    super(message);
    this.code = code;
    this.egress = true;
  }
}

const V4_BLOCKED = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
];
const V6_BLOCKED = [
  ['::', 127], // :: 与 ::1
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], // NAT64:后 32 位是 IPv4,整段不许
  ['100::', 64], ['2001::', 32], // 丢弃段、Teredo
  ['2001:db8::', 32], ['2002::', 16], // 文档段、6to4
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];

function buildBlockList() {
  const list = new net.BlockList();
  for (const [a, p] of V4_BLOCKED) list.addSubnet(a, p, 'ipv4');
  for (const [a, p] of V6_BLOCKED) list.addSubnet(a, p, 'ipv6');
  return list;
}
const STATIC_BLOCK = buildBlockList();

/** `::ffff:a.b.c.d`、`::a.b.c.d` 这类把 IPv4 包在 IPv6 里的写法 → 里面的 IPv4;不是就回 null */
export function embeddedV4(ip) {
  if (net.isIP(ip) !== 6) return null;
  const lower = ip.toLowerCase();
  const dotted = /^(?:::ffff:|::ffff:0:|::)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return net.isIP(dotted[1]) === 4 ? dotted[1] : null;
  const hex = /^(?:::ffff:|::ffff:0:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** 主机名去掉 IPv6 的方括号与结尾的点 */
const bareHost = (h) => String(h ?? '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

/**
 * @param {object} [o]
 * @param {readonly number[]} [o.ports]
 * @param {readonly string[]} [o.testAllow] 「IP:端口」;只给测试
 * @param {(hostname: string) => Promise<Array<{ address: string, family: number }>>} [o.resolve] 解析(测试可换)
 * @param {() => string[]} [o.localAddresses] 本机各网卡的地址(测试可换)
 * @param {(event: string, fields?: object) => void} [o.log]
 */
export function createEgressGate({
  ports = EGRESS_DEFAULTS.ports,
  testAllow = [],
  resolve = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true }),
  localAddresses = null,
  maxRedirects = EGRESS_DEFAULTS.maxRedirects,
  maxBytes = EGRESS_DEFAULTS.maxBytes,
  timeoutMs = EGRESS_DEFAULTS.timeoutMs,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* 日志失败不影响判定 */ } };
  const portSet = new Set(ports);
  const allow = new Set((testAllow ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean));
  if (allow.size) say('agent.egress.test-allow', { count: allow.size });
  const stats = { allowed: 0, refused: 0 };

  let ifaceAt = -Infinity;
  let ifaceSet = new Set();
  function interfaces() {
    const at = now();
    if (at - ifaceAt < EGRESS_DEFAULTS.interfaceTtlMs) return ifaceSet;
    ifaceAt = at;
    const out = new Set();
    try {
      const list = typeof localAddresses === 'function'
        ? localAddresses()
        : Object.values(os.networkInterfaces()).flat().map((i) => i?.address);
      for (const a of list) if (typeof a === 'string' && a) out.add(a.split('%')[0].toLowerCase());
    } catch { /* 读不到网卡就只靠静态表 */ }
    ifaceSet = out;
    return out;
  }

  /** 一个 IP 能不能连;不能回原因,能回 null */
  function addressRefusal(ip) {
    const family = net.isIP(ip);
    if (!family) return 'not-ip';
    const inner = embeddedV4(ip);
    if (inner) return addressRefusal(inner) ?? null;
    if (STATIC_BLOCK.check(ip, family === 6 ? 'ipv6' : 'ipv4')) return 'blocked-address';
    if (interfaces().has(ip.toLowerCase())) return 'blocked-address';
    return null;
  }

  const refuse = (code, message, fields = {}) => {
    stats.refused += 1;
    say('agent.egress.refused', { code, ...fields });
    return new EgressError(code, message);
  };

  /**
   * 核一个目标(主机 + 端口),回钉死的连接地址 `{ address, family, hostname, port }`;不许就抛 `EgressError`。
   * 日志里只有原因码与端口,不记地址原文以外的东西(主机名是模型给的,可能带用户的东西,只记长度)。
   */
  async function admit(hostnameIn, port) {
    const hostname = bareHost(hostnameIn);
    if (!hostname) throw refuse('unresolved', '地址里没有主机名');
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw refuse('port', `端口 ${port} 不合法`);
    let addrs;
    if (net.isIP(hostname)) addrs = [{ address: hostname, family: net.isIP(hostname) }];
    else {
      try { addrs = await resolve(hostname); } catch { addrs = []; }
      addrs = (Array.isArray(addrs) ? addrs : []).filter((a) => a && net.isIP(a.address));
      if (!addrs.length) throw refuse('unresolved', `解析不了这个主机名`, { port });
    }
    // 测试例外:每一个解析结果都在例外表里才算(只给探针在本机回环上起的「测试专用外部地址」)
    if (allow.size && addrs.every((a) => allow.has(`${a.address.toLowerCase()}:${port}`))) {
      stats.allowed += 1;
      return { address: addrs[0].address, family: addrs[0].family, hostname, port, testAllowed: true };
    }
    if (!portSet.has(port)) throw refuse('port', `云端 Agent 不许访问 ${port} 端口`, { port });
    for (const a of addrs) {
      if (addressRefusal(a.address)) {
        throw refuse('blocked-address', '云端 Agent 不许访问节点本机、内网与保留地址', { port });
      }
    }
    stats.allowed += 1;
    return { address: addrs[0].address, family: addrs[0].family, hostname, port, testAllowed: false };
  }

  /** 核一个地址(字符串或 URL);回 `{ url, target }` */
  async function admitUrl(input) {
    let url;
    try { url = input instanceof URL ? input : new URL(String(input)); } catch { throw refuse('protocol', '地址不合法'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refuse('protocol', '云端 Agent 只许访问 http / https 地址');
    if (url.username || url.password) throw refuse('credentials', '地址里不许带用户名口令');
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
    const target = await admit(url.hostname, port);
    return { url, target };
  }

  /** 钉死解析结果的 `lookup`(Node 新旧两种回调形状都认) */
  const pinnedLookup = (target) => (_hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const all = typeof options === 'object' && options?.all === true;
    if (all) cb(null, [{ address: target.address, family: target.family }]);
    else cb(null, target.address, target.family);
  };

  /** 发一跳,不跟重定向。回 `{ res, req }`,`res` 是还没读的响应流 */
  function hop(url, target, { method = 'GET', headers = {}, body = null, signal } = {}) {
    return new Promise((resolvePromise, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request({
        protocol: url.protocol,
        // 主机名原样给(TLS 的 SNI 与证书核对用它);真正连哪里由 lookup 钉死。IP 字面量不经 lookup,它已经核过
        host: target.hostname,
        port: target.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers: { ...headers, host: url.host },
        lookup: pinnedLookup(target),
        agent: false,
        signal,
      });
      req.once('response', (res) => resolvePromise({ res, req }));
      req.once('error', (err) => reject(err?.egress ? err : new EgressError(err?.name === 'AbortError' ? 'timeout' : 'network', `连不上:${String(err?.code ?? err?.message ?? err).slice(0, 120)}`)));
      if (body !== null && body !== undefined) req.end(body); else req.end();
    });
  }

  /**
   * 进程内发请求。跟重定向(每一跳重查)、限大小、限时。
   * @param {string | URL} input
   * @param {object} [o]
   * @param {string} [o.method]
   * @param {Record<string, string>} [o.headers]
   * @param {Buffer | string | null} [o.body]
   * @param {number} [o.maxBytes] 这次的响应体上限(不超过闸的上限)
   * @param {number} [o.timeoutMs]
   * @param {(chunk: Buffer) => void | Promise<void>} [o.onChunk] 给了就不攒在内存里,逐块交出去(下载落盘用)
   * @param {AbortSignal} [o.signal]
   * @returns {Promise<{ status: number, headers: object, url: string, body: Buffer | null, bytes: number, hops: number }>}
   */
  async function request(input, o = {}) {
    const cap = Math.min(Number(o.maxBytes) > 0 ? Number(o.maxBytes) : maxBytes, maxBytes);
    const limitMs = Number(o.timeoutMs) > 0 ? Number(o.timeoutMs) : timeoutMs;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), limitMs);
    timer.unref?.();
    const onOuterAbort = () => ctl.abort();
    o.signal?.addEventListener?.('abort', onOuterAbort, { once: true });
    let method = String(o.method ?? 'GET').toUpperCase();
    let headers = { ...(o.headers ?? {}) };
    let body = o.body ?? null;
    let current = input;
    try {
      for (let hops = 0; ; hops += 1) {
        const { url, target } = await admitUrl(current);
        const { res } = await hop(url, target, { method, headers, body, signal: ctl.signal });
        const status = res.statusCode ?? 0;
        if ([301, 302, 303, 307, 308].includes(status) && typeof res.headers.location === 'string') {
          res.resume();
          if (hops >= maxRedirects) throw refuse('redirects', `重定向超过 ${maxRedirects} 次`);
          let next;
          try { next = new URL(res.headers.location, url); } catch { throw refuse('protocol', '重定向的地址不合法'); }
          if (next.origin !== url.origin) {
            headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|cookie|proxy-authorization)$/i.test(k)));
          }
          if (status === 303 || ((status === 301 || status === 302) && method === 'POST')) { method = 'GET'; body = null; }
          current = next;
          continue;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > cap) {
          res.destroy();
          throw refuse('too-large', `响应体超过上限(${cap} 字节)`);
        }
        const chunks = [];
        let bytes = 0;
        for await (const chunk of res) {
          bytes += chunk.length;
          if (bytes > cap) {
            res.destroy();
            throw refuse('too-large', `响应体超过上限(${cap} 字节)`);
          }
          if (typeof o.onChunk === 'function') await o.onChunk(chunk);
          else chunks.push(chunk);
        }
        return { status, headers: res.headers, url: url.href, body: typeof o.onChunk === 'function' ? null : Buffer.concat(chunks), bytes, hops };
      }
    } catch (err) {
      if (err?.egress) throw err;
      if (ctl.signal.aborted) throw new EgressError('timeout', `请求超过 ${Math.round(limitMs / 1000)} 秒没有完成`);
      throw new EgressError('network', `请求失败:${String(err?.code ?? err?.message ?? err).slice(0, 120)}`);
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener?.('abort', onOuterAbort);
    }
  }

  /**
   * 给子进程用的正向代理(只绑回环、随机端口)。CONNECT 与明文 HTTP 的每个目标都过 `admit`,连到钉死的地址上。
   * 回 `{ url, port, close }`。
   */
  async function startProxy({ host = '127.0.0.1' } = {}) {
    const sockets = new Set();
    const server = http.createServer((req, res) => {
      // 明文 HTTP:请求行里是绝对地址
      void (async () => {
        try {
          const { url, target } = await admitUrl(req.url ?? '');
          if (url.protocol !== 'http:') throw refuse('protocol', '代理的明文通道只接 http 地址');
          const headers = { ...req.headers };
          for (const k of Object.keys(headers)) if (/^proxy-/i.test(k)) delete headers[k];
          const up = http.request({
            host: target.hostname, port: target.port, path: `${url.pathname}${url.search}`, method: req.method,
            headers: { ...headers, host: url.host }, lookup: pinnedLookup(target), agent: false,
          });
          up.once('response', (r) => { res.writeHead(r.statusCode ?? 502, r.headers); r.pipe(res); });
          up.once('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
          req.pipe(up);
        } catch (err) {
          res.writeHead(err?.egress ? 403 : 502, { 'content-type': 'text/plain; charset=utf-8', 'x-egress-refused': String(err?.code ?? 'error') });
          res.end(`egress refused: ${err?.code ?? 'error'}`);
        }
      })();
    });
    server.on('connect', (req, client, head) => {
      sockets.add(client);
      client.once('close', () => sockets.delete(client));
      client.on('error', () => {});
      void (async () => {
        try {
          const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(String(req.url ?? ''));
          if (!m) throw refuse('protocol', 'CONNECT 的目标不合法');
          const target = await admit(m[1], Number(m[2]));
          const up = net.connect({ host: target.address, port: target.port, family: target.family });
          sockets.add(up);
          up.once('close', () => sockets.delete(up));
          up.once('connect', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            if (head?.length) up.write(head);
            up.pipe(client);
            client.pipe(up);
          });
          up.once('error', () => { try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* 已经断了 */ } });
          client.once('close', () => up.destroy());
        } catch (err) {
          try { client.end(`HTTP/1.1 403 Forbidden\r\nx-egress-refused: ${String(err?.code ?? 'error')}\r\n\r\n`); } catch { /* 已经断了 */ }
        }
      })();
    });
    await new Promise((resolvePromise, reject) => {
      server.once('error', reject);
      server.listen(0, host, resolvePromise);
    });
    const port = server.address().port;
    return {
      port,
      url: `http://${host}:${port}`,
      close() {
        for (const s of sockets) { try { s.destroy(); } catch { /* 已经关了 */ } }
        return new Promise((resolvePromise) => { server.closeAllConnections?.(); server.close(() => resolvePromise()); });
      },
    };
  }

  return {
    admit,
    admitUrl,
    addressRefusal,
    request,
    startProxy,
    /** 测试例外开没开(状态口报它;生产必须是 false) */
    testAllowActive: allow.size > 0,
    describe: () => ({ ...stats, testAllow: allow.size > 0, ports: [...portSet] }),
  };
}

/** 环境变量里的测试例外:逗号分隔的「IP:端口」。只认字面 IP */
export function parseTestAllow(text) {
  return String(text ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => {
    const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(s);
    return !!m && net.isIP(m[1].replace(/^\[|\]$/g, '')) !== 0;
  }).map((s) => s.replace(/^\[([^\]]+)\]:/, '$1:'));
}
