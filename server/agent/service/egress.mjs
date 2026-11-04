/**
 * Cloud Agent egress gate (task brief `docs/plan/cloud-agent-task.md` J;
 * contract `docs/plan/cloud-agent-contract.md` Section 9.6).
 *
 * All tools that send requests to model-provided addresses (web collection, downloads, importing
 * media by URL, web handoff) must go through here in the hosted tier:
 *
 *   - Only http / https permitted; URLs must not contain username or password; ports must be in
 *     the allowlist;
 *   - Hostnames are resolved first, and **every resolved address** must pass the blacklist:
 *     loopback, link-local (including 169.254.169.254), private subnets, carrier-grade NAT,
 *     multicast and reserved ranges, addresses of local network interfaces, and corresponding
 *     IPv6 ranges (including prefixes that can enclose intranet addresses, such as IPv4-mapped,
 *     NAT64, 6to4, and Teredo). If any fails, reject entirely (if a hostname points to both external
 *     and internal networks, do not gamble on which one it connects to);
 *   - **Connect using resolved results without re-resolving**: pin the connection's `lookup` to the
 *     just-verified address to prevent DNS rebinding;
 *   - Do not delegate redirects to the underlying layer: every hop reruns all checks above, up to
 *     `maxRedirects` hops; cross-origin hops omit authorization headers;
 *   - Response bodies have a maximum size limit, aborting immediately if exceeded; overall requests
 *     have a timeout.
 *
 * Two usage modes: in-process `request()`; subprocesses (downloader, browser) egress via a forward
 * proxy spawned by `startProxy()` bound strictly to loopback. The proxy performs the same checks on
 * every target: subprocesses that resolve and connect on their own rely on system-level restrictions
 * during deployment as a fallback (described in deployment instructions).
 *
 * Test exceptions: `testAllow` is a set of "IP:port" pairs, provided only by probes and unit tests;
 * when provided, logs a line `agent.egress.test-allow`, also reported by the status endpoint.
 * Production does not set this environment variable (`PROMPTCUT_AGENT_EGRESS_TEST_ALLOW`),
 * defaulting to empty.
 *
 * Pure Node, does not import `src/` or third-party packages.
 */
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';

export const EGRESS_DEFAULTS = Object.freeze({
  /** Permitted ports */
  ports: Object.freeze([80, 443, 8080, 8443]),
  maxRedirects: 5,
  /** Limit for a single response body */
  maxBytes: 512 * 1024 * 1024,
  /** Timeout for a request (including all hops) */
  timeoutMs: 60_000,
  /** How long to cache local network interface addresses */
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
  ['::', 127], // :: and ::1
  ['64:ff9b::', 96], ['64:ff9b:1::', 48], // NAT64: last 32 bits are IPv4, entire range disallowed
  ['100::', 64], ['2001::', 32], // Discard range, Teredo
  ['2001:db8::', 32], ['2002::', 16], // Documentation range, 6to4
  ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
];

function buildBlockList() {
  const list = new net.BlockList();
  for (const [a, p] of V4_BLOCKED) list.addSubnet(a, p, 'ipv4');
  for (const [a, p] of V6_BLOCKED) list.addSubnet(a, p, 'ipv6');
  return list;
}
const STATIC_BLOCK = buildBlockList();

/** Notation wrapping IPv4 inside IPv6 like `::ffff:a.b.c.d`, `::a.b.c.d` → inner IPv4; otherwise returns null */
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

/** Strip IPv6 square brackets and trailing dots from hostname */
const bareHost = (h) => String(h ?? '').replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

/**
 * @param {object} [o]
 * @param {readonly number[]} [o.ports]
 * @param {readonly string[]} [o.testAllow] "IP:port" pairs; testing only
 * @param {(hostname: string) => Promise<Array<{ address: string, family: number }>>} [o.resolve]
 *   Resolve function (replaceable for testing)
 * @param {() => string[]} [o.localAddresses] Local network interface addresses (replaceable for testing)
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
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failure does not affect decision */ } };
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
    } catch { /* Rely solely on static table if network interfaces cannot be read */ }
    ifaceSet = out;
    return out;
  }

  /** Whether an IP can be connected to; returns reason if not, null if allowed */
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
   * Verify a target (host + port), returning pinned connection address
   * `{ address, family, hostname, port }`; throws `EgressError` if disallowed.
   * Logs contain only reason code and port, recording nothing beyond raw address (hostname is
   * model-provided and may contain user data, so only length is logged).
   */
  async function admit(hostnameIn, port) {
    const hostname = bareHost(hostnameIn);
    if (!hostname) throw refuse('unresolved', 'The address has no hostname');
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw refuse('port', `Port ${port} is invalid`);
    let addrs;
    if (net.isIP(hostname)) addrs = [{ address: hostname, family: net.isIP(hostname) }];
    else {
      try { addrs = await resolve(hostname); } catch { addrs = []; }
      addrs = (Array.isArray(addrs) ? addrs : []).filter((a) => a && net.isIP(a.address));
      if (!addrs.length) throw refuse('unresolved', `Cannot resolve this hostname`, { port });
    }
    // Test exception: valid only if every resolved result is in the exception table (only for
    // "test-only external addresses" created by probes on local loopback)
    if (allow.size && addrs.every((a) => allow.has(`${a.address.toLowerCase()}:${port}`))) {
      stats.allowed += 1;
      return { address: addrs[0].address, family: addrs[0].family, hostname, port, testAllowed: true };
    }
    if (!portSet.has(port)) throw refuse('port', `The Cloud Agent is not allowed to access port ${port}`, { port });
    for (const a of addrs) {
      if (addressRefusal(a.address)) {
        throw refuse('blocked-address', 'The Cloud Agent is not allowed to access the node itself, internal networks or reserved addresses', { port });
      }
    }
    stats.allowed += 1;
    return { address: addrs[0].address, family: addrs[0].family, hostname, port, testAllowed: false };
  }

  /** Verify an address (string or URL); returns `{ url, target }` */
  async function admitUrl(input) {
    let url;
    try { url = input instanceof URL ? input : new URL(String(input)); } catch { throw refuse('protocol', 'The address is invalid'); }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw refuse('protocol', 'The Cloud Agent may only access http / https addresses');
    if (url.username || url.password) throw refuse('credentials', 'The address must not contain a username or password');
    const port = url.port ? Number(url.port) : (url.protocol === 'https:' ? 443 : 80);
    const target = await admit(url.hostname, port);
    return { url, target };
  }

  /** `lookup` pinning resolution results (recognizes both legacy and modern Node callback signatures) */
  const pinnedLookup = (target) => (_hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const all = typeof options === 'object' && options?.all === true;
    if (all) cb(null, [{ address: target.address, family: target.family }]);
    else cb(null, target.address, target.family);
  };

  /** Send a single hop without following redirects. Returns `{ res, req }`, where `res` is the unread response stream */
  function hop(url, target, { method = 'GET', headers = {}, body = null, signal } = {}) {
    return new Promise((resolvePromise, reject) => {
      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request({
        protocol: url.protocol,
        // Pass hostname as is (used by TLS SNI and certificate verification); actual connection target
        // is pinned by lookup. IP literals bypass lookup as they are already verified
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
      req.once('error', (err) => reject(err?.egress ? err : new EgressError(err?.name === 'AbortError' ? 'timeout' : 'network', `Cannot connect: ${String(err?.code ?? err?.message ?? err).slice(0, 120)}`)));
      if (body !== null && body !== undefined) req.end(body); else req.end();
    });
  }

  /**
   * In-process request. Follows redirects (re-checking each hop), limits size, limits time.
   * @param {string | URL} input
   * @param {object} [o]
   * @param {string} [o.method]
   * @param {Record<string, string>} [o.headers]
   * @param {Buffer | string | null} [o.body]
   * @param {number} [o.maxBytes] Limit for this response body (does not exceed gate limit)
   * @param {number} [o.timeoutMs]
   * @param {(chunk: Buffer) => void | Promise<void>} [o.onChunk] If provided, streams chunk by chunk instead of
   *   accumulating in memory (for downloading to disk)
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
          if (hops >= maxRedirects) throw refuse('redirects', `More than ${maxRedirects} redirects`);
          let next;
          try { next = new URL(res.headers.location, url); } catch { throw refuse('protocol', 'The redirect address is invalid'); }
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
          throw refuse('too-large', `Response body exceeds the limit (${cap} bytes)`);
        }
        const chunks = [];
        let bytes = 0;
        for await (const chunk of res) {
          bytes += chunk.length;
          if (bytes > cap) {
            res.destroy();
            throw refuse('too-large', `Response body exceeds the limit (${cap} bytes)`);
          }
          if (typeof o.onChunk === 'function') await o.onChunk(chunk);
          else chunks.push(chunk);
        }
        return { status, headers: res.headers, url: url.href, body: typeof o.onChunk === 'function' ? null : Buffer.concat(chunks), bytes, hops };
      }
    } catch (err) {
      if (err?.egress) throw err;
      if (ctl.signal.aborted) throw new EgressError('timeout', `The request did not complete within ${Math.round(limitMs / 1000)} seconds`);
      throw new EgressError('network', `Request failed: ${String(err?.code ?? err?.message ?? err).slice(0, 120)}`);
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener?.('abort', onOuterAbort);
    }
  }

  /**
   * Forward proxy for subprocesses (bound only to loopback, random port). Every target of CONNECT
   * and plaintext HTTP passes `admit` and connects to the pinned address.
   * Returns `{ url, port, close }`.
   */
  async function startProxy({ host = '127.0.0.1' } = {}) {
    const sockets = new Set();
    const server = http.createServer((req, res) => {
      // Plaintext HTTP: request line contains absolute URL
      void (async () => {
        try {
          const { url, target } = await admitUrl(req.url ?? '');
          if (url.protocol !== 'http:') throw refuse('protocol', 'The proxy\'s plaintext channel only accepts http addresses');
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
          if (!m) throw refuse('protocol', 'The CONNECT target is invalid');
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
          up.once('error', () => { try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* Already disconnected */ } });
          client.once('close', () => up.destroy());
        } catch (err) {
          try { client.end(`HTTP/1.1 403 Forbidden\r\nx-egress-refused: ${String(err?.code ?? 'error')}\r\n\r\n`); } catch { /* Already disconnected */ }
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
        for (const s of sockets) { try { s.destroy(); } catch { /* Already closed */ } }
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
    /** Whether test exceptions are enabled (reported by status endpoint; must be false in production) */
    testAllowActive: allow.size > 0,
    describe: () => ({ ...stats, testAllow: allow.size > 0, ports: [...portSet] }),
  };
}

/** Test exceptions from environment variable: comma-separated "IP:port" pairs. Only literal IPs are recognized */
export function parseTestAllow(text) {
  return String(text ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => {
    const m = /^(\[[^\]]+\]|[^:]+):(\d{1,5})$/.exec(s);
    return !!m && net.isIP(m[1].replace(/^\[|\]$/g, '')) !== 0;
  }).map((s) => s.replace(/^\[([^\]]+)\]:/, '$1:'));
}
