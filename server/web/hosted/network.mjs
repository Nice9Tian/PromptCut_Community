/**
 * How Cloud Agent's browser accesses the network (W1 package of plan `docs/plan/cloud-agent-tools-implementation.md`;
 * contract `docs/plan/cloud-agent-contract.md` Section 9.6).
 *
 * The browser is driven by the model: where it goes is determined by web pages, and web pages are untrusted.
 * Therefore, **all** egress from the browser has only one path left: the forward proxy started by this
 * file and bound only to loopback. The proxy checks every target against the egress gate
 * (`admit` / `admitUrl` in `server/agent/service/egress.mjs`) and connects to the verified address.
 * The remaining routes are blocked one by one in startup parameters (`hostedNetworkArgs`), each with
 * a test in `server/test/cloud-tools-w1-egress.test.mjs`:
 *
 *   | Proxy bypass route                                     | How it is blocked                                                                     |
 *   |--------------------------------------------------------|---------------------------------------------------------------------------------------|
 *   | Loopback, link-local addresses (including 169.254.169.254) | Chrome **bypasses proxy by default** for these two; `--proxy-bypass-list=<-loopback>` removes this default, proxy rejects |
 *   | Intranet, corresponding IPv6 ranges, embedded IPv4 prefixes | All go to proxy, rejected by egress gate denylist                                     |
 *   | Browser resolves hostname itself (including DNS prefetch) | `--host-resolver-rules=MAP * ~NOTFOUND`: browser cannot resolve any names; names only resolved by proxy |
 *   | DNS rebinding                                          | Proxy re-resolves, verifies, and connects to verified address for each request (plaintext) / tunnel (CONNECT); browser does not resolve, so no second resolution to spoof |
 *   | Redirects to intranet                                  | Every hop followed by browser is a new proxy request, likewise rejected               |
 *   | WebSocket                                              | CONNECT via proxy, likewise passes through the gate                                   |
 *   | WebRTC (UDP direct connection, leaking local address)  | `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`: never sends non-proxied UDP, collects no local address |
 *   | QUIC / HTTP3 (UDP)                                     | `--disable-quic`                                                                      |
 *   | `file:` and other non-http(s) protocols               | Tool entry points only accept http(s); requests in page are dropped by protocol interception in `session.mjs`; landed address is verified once more |
 *   | Downloads                                              | `session.mjs` uses `Browser.setDownloadBehavior { behavior: 'deny' }`, no disk writes |
 *   | Debug port                                             | Connect to browser via pipe (`pipe: true`), no debug port opened, unreachable by pages |
 *
 * This code layer governs what "exits through it"; if the browser process has direct connection routes
 * not blocked by this file, system-level outbound restrictions on the node serve as fallback (written in
 * deployment notes, same as residual surface in 9.4d).
 * External links inside cards do not pass through here: that is the concern of the render service and online stage.
 *
 * Pure Node, no imports from `src/`, no third-party packages.
 */
import http from 'node:http';
import net from 'node:net';

/** Protocols permitted in browser address bar and page requests. `about:`, `data:`, `blob:` do not egress; kept for page use */
const PAGE_SCHEMES = new Set(['http:', 'https:', 'about:', 'data:', 'blob:']);

/** Headers not forwarded upstream during cleartext proxy forwarding */
const HOP_HEADERS = /^(proxy-.*|connection|keep-alive|te|trailer|upgrade)$/i;

/** Whether a request in the page is allowed to be sent based on its protocol */
export function pageRequestAllowed(url) {
  const m = /^([a-z][a-z0-9+.-]*:)/i.exec(String(url ?? ''));
  return !!m && PAGE_SCHEMES.has(m[1].toLowerCase());
}

/** Whether an address is http(s) (used to verify the landed address) */
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
 * Address provided by the model → http(s) address to open. Those without a protocol are filled
 * with https (consistent with the desktop app);
 * Those with other protocols (`file:`, `chrome:`, `view-source:`, `data:`, `javascript:`, etc.)
 * are rejected outright, without filling or guessing.
 */
export function normalizeWebTarget(input) {
  const raw = String(input ?? '').trim();
  if (!raw) throw new WebTargetError('empty', 'url is required');
  if (raw.length > 4096) throw new WebTargetError('too-long', 'Address too long');
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new WebTargetError('protocol', 'Address contains invalid characters');
  if (/^https?:\/\//i.test(raw)) return raw;
  // "name:port/path" is not a protocol: the name contains a dot (or is localhost), and the colon
  // is immediately followed by digits. Things like `tel:123` do not count. All other strings
  // with a "protocol:" prefix are not http(s).
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (scheme && !/^([^/:]+\.[^/:]+|localhost):\d{1,5}(\/|$|\?|#)/i.test(raw)) {
    throw new WebTargetError('protocol', `The Cloud Agent's browser only opens http / https addresses, not ${scheme[1].toLowerCase()}: addresses.`);
  }
  if (raw.startsWith('//') || raw.startsWith('\\\\')) throw new WebTargetError('protocol', 'The Cloud Agent\'s browser only opens http / https addresses.');
  return `https://${raw}`;
}

/** Egress gate reason code → one-line message for the model */
export function egressRefusalText(code) {
  switch (code) {
    case 'blocked-address': return 'This address points to the cloud node itself, the internal network or a reserved address, and the Cloud Agent\'s browser is not allowed to access it.';
    case 'port': return 'The Cloud Agent\'s browser may only access ports 80, 443, 8080 and 8443.';
    case 'protocol': return 'The Cloud Agent\'s browser only opens http / https addresses.';
    case 'credentials': return 'The address must not contain a username or password.';
    case 'unresolved': return 'This host name cannot be resolved.';
    default: return 'This address was rejected by the cloud\'s egress restrictions.';
  }
}

/**
 * Whether the address provided by the model can be opened: first accept only literal http(s),
 * then pass through the egress gate.
 * Returns `{ ok: true, target }`, or `{ ok: false, result }` (`result` is the rejection returned
 * to the model). Errors outside the egress gate are thrown as usual.
 */
export async function admitWebTarget(gate, input) {
  let target;
  try { target = normalizeWebTarget(input); } catch (err) {
    if (!(err instanceof WebTargetError)) throw err;
    return { ok: false, result: { ok: false, error: err.code === 'empty' ? err.message : `Not opened: ${err.message}`, refused: err.code } };
  }
  try {
    // Passed to the browser is the address resolved and normalized by the egress gate (lowercased
    // hostname, decimal IP restored to dotted-decimal, etc.), not the original string provided by
    // the model: the verified address and the opened address are the same.
    const { url } = await gate.admitUrl(target);
    return { ok: true, target: url.href };
  } catch (err) {
    if (!err?.egress) throw err;
    return { ok: false, result: { ok: false, error: `Not opened: ${egressRefusalText(err.code)}`, egress: err.code } };
  }
}

/**
 * The group of browser launch arguments related to egress. `proxyUrl` is the address returned
 * by `startBrowserProxy`.
 * Order does not matter; the caller places them after its own arguments and before the arguments
 * appended by the deployer.
 */
export function hostedNetworkArgs(proxyUrl) {
  return [
    `--proxy-server=${proxyUrl}`,
    // By default, Chrome does not route loopback and link-local addresses through the proxy.
    // Removing this default ensures they reach the proxy and get rejected; 169.254.169.254 is
    // in link-local.
    '--proxy-bypass-list=<-loopback>',
    // The browser itself cannot resolve any hostname (DNS prefetching and any requests not routed
    // through the proxy will fail); the proxy address is a literal IP, which is unaffected.
    '--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--webrtc-ip-handling-policy=disable_non_proxied_udp',
    '--disable-quic',
    // Background requests initiated by the browser itself (component updates, sync, Safe Browsing,
    // metrics): disable them; any that cannot be fully disabled can only go through the proxy.
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
 * Launch arguments that the deployer can append: **allowlist, kept only on exact match**. List
 * only the few genuinely needed for deployment that do not touch egress or isolation:
 *
 *   - `--no-sandbox`, `--disable-setuid-sandbox`: When running as root on a node, or when the
 *     kernel disallows unprivileged user namespaces, the browser's own sandbox cannot start;
 *   - `--no-zygote`: The zygote cannot start in certain containers (can only be used with
 *     `--no-sandbox`);
 *   - `--disable-dev-shm-usage`: When /dev/shm in the container is too small, shared memory is
 *     moved to the temporary directory;
 *   - `--disable-gpu`, `--disable-software-rasterizer`: Omit the GPU process on nodes without
 *     graphics cards;
 *   - `--disable-field-trial-config`: The leading one on this machine's Chrome for Testing (see
 *     `HOSTED_BROWSER_ARG_PREFIX` in `session.mjs`).
 *
 * Cannot be blocked with a blocklist: the browser has thousands of flags; more than a dozen or
 * two can modify the proxy, change the cache directory, relax certificate verification, disable
 * site isolation, or write network logs and TLS keys to disk, and they increase with each version.
 * Anything outside the list is discarded (logged in a single line, counting only the total).
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

/** Appended launch arguments (from deployer and the leading ones): keep those in the allowlist, return `{ args, dropped }` */
export function filterExtraArgs(extra) {
  const args = [];
  const dropped = [];
  for (const a of Array.isArray(extra) ? extra : []) {
    if (typeof a === 'string' && ALLOWED_EXTRA_ARGS.includes(a)) { if (!args.includes(a)) args.push(a); } else dropped.push(String(a));
  }
  return { args, dropped };
}

/**
 * Forward proxy for a single browser (bound only to loopback, random port). Each destination
 * passes through the egress gate and connects to the verified address.
 *
 * Does the same thing as `startProxy` in `egress.mjs`, plus three additional things needed by the
 * browser: per-connection records (for rejection explanations, probes, and test evidence),
 * a limit on concurrent open tunnels, and returning "whether all connections were closed" upon
 * closing.
 *
 * @param {object} o
 * @param {{ admit(hostname: string, port: number): Promise<{ address: string, family: number, port: number }>, admitUrl(input: string): Promise<{ url: URL, target: { address: string, family: number, port: number } }> }} o.gate
 * @param {number} [o.maxTunnels] Maximum number of concurrent open tunnels (CONNECT)
 * @param {number} [o.maxJournal] Number of connection records to retain
 * @param {(event: string, fields?: object) => void} [o.log] Service log: reason code and port only, does not record hostname
 * @returns {Promise<{ url: string, port: number, journal(): object[], stats(): object, close(): Promise<{ closed: boolean }> }>}
 */
export async function startBrowserProxy({ gate, host = '127.0.0.1', maxTunnels = 64, maxJournal = 400, log = () => {}, now = () => Date.now() } = {}) {
  if (typeof gate?.admit !== 'function' || typeof gate?.admitUrl !== 'function') throw new Error('browser proxy needs an egress gate');
  const say = (event, fields = {}) => { try { log(event, fields); } catch { /* Logging failure does not affect decision */ } };
  const sockets = new Set();
  const entries = [];
  const counts = { allowed: 0, refused: 0, tunnels: 0 };
  let seq = 0;

  /** Record an entry: hostname remains only in this in-memory record (for model explanation, test evidence); not in service log */
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
    // Cleartext HTTP: the request line contains an absolute URL. Each request is verified
    // individually (changing destinations on the same connection to the proxy cannot bypass it).
    void (async () => {
      let hostname = '';
      let port = 0;
      try {
        try { const u = new URL(req.url ?? ''); hostname = u.hostname; port = u.port ? Number(u.port) : 80; } catch { /* Handed to admitUrl to report */ }
        const { url, target } = await gate.admitUrl(req.url ?? '');
        if (url.protocol !== 'http:') throw Object.assign(new Error('plain channel is http only'), { egress: true, code: 'protocol' });
        record('http', url.hostname, target.port, { ok: true, address: target.address });
        const headers = {};
        for (const [k, v] of Object.entries(req.headers)) if (!HOP_HEADERS.test(k)) headers[k] = v;
        // Connect to that verified address (cleartext has no certificate to match names against;
        // providing the IP directly achieves "no secondary resolution").
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
        up.once('error', () => { try { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); } catch { /* Already disconnected */ } });
        up.once('close', () => { release(); client.destroy(); });
        client.once('close', () => { release(); up.destroy(); });
      } catch (err) {
        const code = err?.egress ? String(err.code ?? 'error') : 'error';
        record('connect', hostname, port, { ok: false, code });
        try { client.end(`HTTP/1.1 403 Forbidden\r\nx-egress-refused: ${code}\r\ncontent-length: 0\r\n\r\n`); } catch { /* Already disconnected */ }
      }
    })();
  });
  server.on('clientError', (_err, socket) => {
    try { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\ncontent-length: 0\r\n\r\n'); else socket.destroy(); } catch { /* Already disconnected */ }
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
    /** Replica of connection records (oldest first) */
    journal: () => entries.map((e) => ({ ...e })),
    /** Rejection records with sequence number greater than `after` */
    refusedSince: (after) => entries.filter((e) => e.seq > after && !e.ok).map((e) => ({ ...e })),
    get seq() { return seq; },
    stats: () => ({ ...counts, open: sockets.size }),
    close() {
      closing ??= (async () => {
        for (const s of sockets) { try { s.destroy(); } catch { /* Already closed */ } }
        await new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
        // Wait until all connections are truly closed (it is asynchronous after destroy)
        const end = Date.now() + 3_000;
        while (sockets.size && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
        return { closed: sockets.size === 0 };
      })();
      return closing;
    },
  };
}
