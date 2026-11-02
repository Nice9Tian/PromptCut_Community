/**
 * Local nginx-mocking proxy for probes: arranges the online build and local document and asset
 * services into three production-like origins (editor page + two stages).
 * **Policy headers and `/media-s/` decisions are both taken from `src/online/stagePolicy.mjs`**
 * (the two nginx fragments are generated from the same file), not duplicated here.
 *
 *   import { startHostedProxy } from './hosted-proxy.mjs';
 *   const proxy = await startHostedProxy({ dist, basePort: 5750, docPort, assetPort });
 *   proxy.editorOrigin / proxy.stageOrigins / proxy.grants / proxy.requests / await proxy.close()
 *
 * Origins (all bound only to 127.0.0.1; Chrome resolves `*.localhost` to loopback, so no hosts
 * file changes needed):
 *   Editor page `http://pc.localhost:<base>`, stages `http://s1.pc.localhost:<base+1>`,
 *   `http://s2.pc.localhost:<base+2>`.
 *   All three are same-site (`pc.localhost`) cross-origin, cookies separated by hostname: cannot
 *   use `127.0.0.1` with different ports for all three origins like the old probe (cookies do not
 *   isolate by port, which would let stages see editor page cookies and fail to test isolation).
 *
 * Routes (stage origins only serve routes marked with * below):
 *   /hosted…            → document service (including WebSocket upgrade, prefix stripped)
 *   /media…           * → asset service (prefix stripped; legacy `?t=` approach goes here)
 *   /media-s/<sid>/…  * → `mediaSRoute`: `_grant` exchanges ticket for HttpOnly cookie; `media/<hash>` exchanges cookie for Authorization header forwarded to asset service
 *   /editor/_iso/ok, /editor/_iso/redirect * → for stage self-check (204, 302 to the former)
 *   /editor/stage.html * → stage entry point for online build
 *   /editor, /editor/…  * → online build (long cache for `assets/`, rest falls back to index.html)
 *   /editor/runtime-config.json → `{ v: 1, stageOrigins, onlineCardExec? }`
 *   /catalog/…        * → motion graphics asset catalog in online build
 *
 * Option `policy`:
 *   - `"full"` (default): new nginx: each stage origin response carries `stageSecurityHeaders`,
 *     editor page carries `frame-src`;
 *   - `"legacy"`: legacy nginx: no policy headers, no `/media-s/` or `_iso/` (falls back to
 *     index.html), only the original three headers including `Origin-Agent-Cluster`. Used to
 *     verify "new page fails self-check and automatically does not execute under legacy nginx";
 *   - `"none"`: control group: same routes as `full`, but stage origins carry no Content Security
 *     Policy, and stage entry point returns index.html without `<meta>` (verifies self-check
 *     rejection when policy is missing).
 *   - `"csp-only"`: legacy option name compatibility, currently identical to `full`; executes
 *     even without egress allowlist.
 *
 * Run directly (local services + proxy, without connecting to any remote host):
 *   node scripts/probes/lib/hosted-proxy.mjs --dist dist-online [--base-port 5750] [--doc-port 8780] [--asset-port 8781] [--policy full]
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { editorSecurityHeaders, mediaSRoute, stageSecurityHeaders } from '../../../src/online/stagePolicy.mjs';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.wasm': 'application/wasm' };
const LEGACY_HEADERS = Object.freeze({ 'origin-agent-cluster': '?1', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });

/** Addresses of the three origins. `host` is the editor page hostname (stages are its s1. / s2. subdomains). */
export function proxyOrigins(basePort, host = 'pc.localhost') {
  return { editor: `http://${host}:${basePort}`, stages: [`http://s1.${host}:${basePort + 1}`, `http://s2.${host}:${basePort + 2}`] };
}

/**
 * @param {object} o
 * @param {string} o.dist            Online build directory (artifact of `npx vite build --mode online`)
 * @param {number} o.basePort        Editor page port; the two stages are +1, +2
 * @param {number} o.docPort         Document service port (127.0.0.1)
 * @param {number} o.assetPort       Asset service port (127.0.0.1)
 * @param {"full"|"legacy"|"none"|"csp-only"} [o.policy]
 * @param {boolean} [o.onlineCardExec]  Master switch in runtime config; only written to config when explicitly false
 * @param {boolean} [o.runtimeConfig]   When false, does not serve runtime config (404): page cannot read stage origins, falls back to same-origin single stage (simulating deployments without stage subdomains)
 * @param {(info: { role: "editor"|"stageA"|"stageB", req: http.IncomingMessage, url: URL }) => (void | { status: number, body?: string | Buffer, headers?: Record<string, string | number> } | { delayMs: number })} [o.intercept]
 *        Probe hook: return `{ status, body?, headers? }` to respond directly (`body` can be bytes, `headers` overrides default text/plain and policy headers); return `{ delayMs }` to hold this request before processing normally
 * @param {(info: { role: "editor"|"stageA"|"stageB", req: http.IncomingMessage, url: URL }) => (void | Record<string, string>)} [o.responseHeaders]
 *        Probe hook: append to / override response headers for forwarded responses (document service, asset service) (e.g. adding `cache-control: no-store` to asset bytes)
 */
export async function startHostedProxy({ dist, basePort, docPort, assetPort, policy = 'full', host = 'pc.localhost', onlineCardExec, runtimeConfig: withRuntimeConfig = true, intercept, responseHeaders }) {
  const DIST = path.resolve(dist);
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`No index.html in the online build directory: ${DIST}`);
  const origins = proxyOrigins(basePort, host);
  const runtimeConfig = JSON.stringify({ v: 1, stageOrigins: origins.stages, ...(onlineCardExec === false ? { onlineCardExec: false } : {}) });
  /** Handed-over tickets (kept only in memory for probe comparison, not printed). */
  const grants = [];
  /** One entry per request: { role, method, path, status }. */
  const requests = [];
  /** Raw URL of each request (including query string; records both HTTP and WebSocket upgrades): used by probes to verify "tickets do not appear in any URL". Do not print directly in logs. */
  const urls = [];
  const noteUrl = (u) => { urls.push(u); if (urls.length > 50_000) urls.shift(); };
  const servers = [];
  /** Active WebSocket pairs (used by `cutWs` to sever). */
  const wsPairs = new Set();
  /** Switches that probes can modify directly: `blockWs` rejects new WebSocket upgrades; `blockMedia` makes `/media/…` unreachable (the legacy path, excluding `/media-s/`). */
  const api = { blockWs: false, blockMedia: false };

  const headersFor = (role) => {
    if (role === 'editor') return policy === 'legacy' ? { ...LEGACY_HEADERS } : { ...LEGACY_HEADERS, ...editorSecurityHeaders(origins.stages) };
    if (policy === 'legacy') return { ...LEGACY_HEADERS };
    const all = stageSecurityHeaders(origins.editor);
    if (policy === 'none') { delete all['content-security-policy']; delete all['connection-allowlist']; }
    if (policy === 'csp-only') delete all['connection-allowlist'];
    return all;
  };

  function make(role, port) {
    const origin = role === 'editor' ? origins.editor : origins.stages[role === 'stageA' ? 0 : 1];
    const sec = headersFor(role);
    const isStage = role !== 'editor';
    const note = (req, url, status) => { requests.push({ role, method: req.method, path: url.pathname + (url.search ? '?…' : ''), status }); if (requests.length > 20_000) requests.splice(0, 5_000); };
    const end = (req, url, res, status, headers = {}, body = '') => { note(req, url, status); res.writeHead(status, { ...sec, ...headers }); res.end(body); };
    const forward = (req, url, res, upstreamPort, upstreamPath, headers = req.headers) => {
      const up = http.request({ host: '127.0.0.1', port: upstreamPort, method: req.method, path: upstreamPath, headers }, (r) => {
        note(req, url, r.statusCode ?? 502);
        res.writeHead(r.statusCode ?? 502, { ...r.headers, ...sec, ...(responseHeaders?.({ role, req, url }) ?? {}) });
        r.pipe(res);
      });
      up.on('error', () => { if (!res.headersSent) end(req, url, res, 502, {}, 'bad gateway'); else res.destroy(); });
      req.pipe(up);
    };
    const sendFile = (req, url, res, file, cache) => {
      note(req, url, 200);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': cache, ...sec });
      fs.createReadStream(file).pipe(res);
    };
    const handle = (req, res) => {
      const url = new URL(req.url, origin);
      const p = url.pathname;
      if (api.blockMedia && (p === '/media' || p.startsWith('/media/'))) return req.socket.destroy();
      if (!isStage && (p === '/hosted' || p.startsWith('/hosted/'))) return forward(req, url, res, docPort, (p.slice('/hosted'.length) || '/') + url.search);
      if (p === '/media' || p.startsWith('/media/')) return forward(req, url, res, assetPort, (p.slice('/media'.length) || '/') + url.search);
      if (isStage && policy !== 'legacy') {
        const route = mediaSRoute({ method: req.method, pathname: p, origin: req.headers.origin ?? null, authorization: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null }, { editorOrigin: origins.editor, secure: false });
        if (route.kind === 'reject') return end(req, url, res, route.status);
        if (route.kind === 'preflight') return end(req, url, res, 204, route.headers);
        if (route.kind === 'grant') {
          const ticket = /^Bearer[ \t]+(\S+)$/i.exec(String(req.headers.authorization ?? '').trim())?.[1] ?? '';
          grants.push({ role, sid: /^\/media-s\/([^/]+)\//.exec(p)?.[1] ?? '', ticket, at: Date.now() });
          return end(req, url, res, 204, route.headers);
        }
        if (route.kind === 'proxy') {
          const headers = { ...req.headers, authorization: route.authorization };
          delete headers.cookie;
          return forward(req, url, res, assetPort, route.path, headers);
        }
        if (p === '/editor/_iso/ok') return end(req, url, res, 204, { 'cache-control': 'no-store' });
        if (p === '/editor/_iso/redirect') return end(req, url, res, 302, { 'cache-control': 'no-store', location: '/editor/_iso/ok' });
      }
      if (!isStage && p === '/editor/runtime-config.json') return withRuntimeConfig ? end(req, url, res, 200, { 'content-type': 'application/json', 'cache-control': 'no-store' }, runtimeConfig) : end(req, url, res, 404, { 'content-type': 'text/plain' }, 'not found');
      const index = path.join(DIST, 'index.html');
      if (p === '/editor' || p === '/editor/' || p === '/editor/index.html') return sendFile(req, url, res, index, 'no-store');
      if (p === '/editor/stage.html') {
        const f = path.join(DIST, 'stage.html');
        return sendFile(req, url, res, policy !== 'none' && fs.existsSync(f) ? f : index, 'no-store');
      }
      if (p.startsWith('/editor/assets/')) {
        const f = path.join(DIST, decodeURIComponent(p.slice('/editor/'.length)));
        if (!f.startsWith(DIST) || !fs.existsSync(f)) return end(req, url, res, 404, {}, 'not found');
        return sendFile(req, url, res, f, 'public, max-age=31536000, immutable');
      }
      if (/^\/catalog\/(lottie|particles)\/[A-Za-z0-9-]+\.json$/.test(p)) {
        const f = path.join(DIST, p.slice(1));
        if (!fs.existsSync(f)) return end(req, url, res, 404, {}, 'not found');
        return sendFile(req, url, res, f, 'no-cache');
      }
      if (p.startsWith('/editor/')) return sendFile(req, url, res, index, 'no-store');
      return end(req, url, res, 404, { 'content-type': 'text/plain' }, 'not found');
    };
    const server = http.createServer((req, res) => {
      noteUrl(req.url);
      const verdict = intercept?.({ role, req, url: new URL(req.url, origin) });
      if (verdict && 'status' in verdict) { res.writeHead(verdict.status, { 'content-type': 'text/plain', ...sec, ...(verdict.headers ?? {}) }); return res.end(verdict.body ?? ''); }
      if (verdict && 'delayMs' in verdict) { const t = setTimeout(() => handle(req, res), verdict.delayMs); req.on('close', () => clearTimeout(t)); return; }
      handle(req, res);
    });
    server.on('upgrade', (req, socket, head) => {
      noteUrl(req.url);
      const url = new URL(req.url, origin);
      if (isStage || api.blockWs || !(url.pathname === '/hosted' || url.pathname.startsWith('/hosted/'))) return socket.destroy();
      const target = (url.pathname.slice('/hosted'.length) || '/') + url.search;
      const pair = { socket, up: null };
      const up = net.connect(docPort, '127.0.0.1', () => {
        const lines = [`${req.method} ${target} HTTP/1.1`];
        for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
        up.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head?.length) up.write(head);
        up.pipe(socket);
        socket.pipe(up);
      });
      pair.up = up;
      wsPairs.add(pair);
      const drop = () => wsPairs.delete(pair);
      socket.on('close', drop); up.on('close', drop);
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
    });
    servers.push(server);
    return new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  }
  await Promise.all([make('editor', basePort), make('stageA', basePort + 1), make('stageB', basePort + 2)]);

  return Object.assign(api, {
    policy,
    editorOrigin: origins.editor,
    stageOrigins: origins.stages,
    docPublicUrl: `ws://${host}:${basePort}/hosted/`,
    assetPublicUrl: `${origins.editor}/media/api/asset`,
    grants,
    requests,
    urls,
    /** Disconnect WebSockets on this proxy instance: sever existing ones, reject new ones (allow again once `blockWs = false`). Only severs this proxy; other proxies operate normally. */
    cutWs() { api.blockWs = true; for (const p of wsPairs) { p.socket.destroy(); p.up?.destroy(); } wsPairs.clear(); },
    async close() {
      for (const p of wsPairs) { p.socket.destroy(); p.up?.destroy(); }
      for (const s of servers) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r())); }
    },
  });
}

/* ------------------------------------------------------------------ Run directly: local services + proxy */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const basePort = Number(arg('--base-port', 5750)), docPort = Number(arg('--doc-port', 8780)), assetPort = Number(arg('--asset-port', 8781));
  const os = await import('node:os');
  const { randomBytes } = await import('node:crypto');
  const { startProbeServices } = await import('./probe-services.mjs');
  const dataDir = arg('--data-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hosted-proxy-')));
  const o = proxyOrigins(basePort);
  // Same as the hosted side, do not trust loopback: all requests incoming through the proxy verify tickets
  await startProbeServices({ dataDir, docPort, assetPort, host: '127.0.0.1', trustLoopback: false, clusterToken: randomBytes(32).toString('base64url'),
    docPublicUrl: `ws://pc.localhost:${basePort}/hosted/`, assetPublicUrl: `${o.editor}/media/api/asset`, log: () => {} });
  const proxy = await startHostedProxy({ dist: arg('--dist', path.join(ROOT, 'dist-online')), basePort, docPort, assetPort, policy: arg('--policy', 'full') });
  console.log(JSON.stringify({ editor: `${proxy.editorOrigin}/editor`, stages: proxy.stageOrigins, policy: proxy.policy, dataDir }));
}
