/**
 * 本机仿 nginx 的代理:把在线构建与本机托管组合摆成与托管端同样的三个源(编辑器页 + 两个舞台),探针与本机隔离托管组合用。
 * 与 `server/hosted/deploy/nginx-site-promptcut*.conf` 等价;**策略头、`/media-s/` 的判定都取自 `src/online/stagePolicy.mjs`**
 * (nginx 的两个片段由同一个文件生成),不在这里另抄一份。
 *
 *   import { startHostedProxy } from './hosted-proxy.mjs';
 *   const proxy = await startHostedProxy({ dist, basePort: 5750, docPort, assetPort });
 *   proxy.editorOrigin / proxy.stageOrigins / proxy.grants / proxy.requests / await proxy.close()
 *
 * 源(都只绑 127.0.0.1;Chrome 把 `*.localhost` 解析到回环,所以不用改 hosts):
 *   编辑器页 `http://pc.localhost:<base>`,舞台 `http://s1.pc.localhost:<base+1>`、`http://s2.pc.localhost:<base+2>`。
 *   三者同站(`pc.localhost`)跨源,cookie 按主机名分开 —— 不能像旧探针那样三个源都用 `127.0.0.1` 换端口(cookie 不分端口,
 *   那样编辑器页的 cookie 舞台也看得见,测不出隔离)。
 *
 * 路由(舞台源只给下面带 * 的):
 *   /hosted…            → 文档服务(含 WebSocket 升级,去掉前缀)
 *   /media…           * → 素材服务(去掉前缀;旧办法 `?t=` 走这里)
 *   /media-s/<sid>/…  * → `mediaSRoute`:`_grant` 把票据换成 HttpOnly cookie;`media/<哈希>` 把 cookie 换成 Authorization 头转给素材服务
 *   /editor/_iso/ok、/editor/_iso/redirect * → 舞台自检用(204、302 到前者)
 *   /editor/stage.html * → 在线构建的舞台入口
 *   /editor、/editor/…  * → 在线构建(`assets/` 长缓存,其余落到 index.html)
 *   /editor/runtime-config.json → `{ v: 1, stageOrigins, onlineCardExec? }`
 *   /catalog/…        * → 在线构建里的动效素材目录
 *
 * 选项 `policy`:
 *   - `"full"`(缺省):新 nginx —— 舞台源每个响应带 `stageSecurityHeaders`,编辑器页带 `frame-src`;
 *   - `"legacy"`:旧 nginx —— 没有策略头、没有 `/media-s/` 与 `_iso/`(落到 index.html),只有 `Origin-Agent-Cluster` 等原有三条。
 *     用来核对「新页面在旧 nginx 下自检不过、自动不执行」;
 *   - `"none"`:对照组 —— 路由同 `full`,但舞台源不带内容安全策略,舞台入口也回不带 `<meta>` 的 index.html(验证缺少策略时自检拒绝)。
 *   - `"csp-only"`:兼容旧选项名，当前与 full 相同；无出口白名单也执行。
 *
 * 直接运行(本机隔离托管组合,不连任何远端):
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

/** 三个源的地址。`host` 是编辑器页的主机名(舞台是它的 s1. / s2. 子域) */
export function proxyOrigins(basePort, host = 'pc.localhost') {
  return { editor: `http://${host}:${basePort}`, stages: [`http://s1.${host}:${basePort + 1}`, `http://s2.${host}:${basePort + 2}`] };
}

/**
 * @param {object} o
 * @param {string} o.dist            在线构建目录(`npx vite build --mode online` 的产物)
 * @param {number} o.basePort        编辑器页的端口;两个舞台是 +1、+2
 * @param {number} o.docPort         文档服务端口(127.0.0.1)
 * @param {number} o.assetPort       素材服务端口(127.0.0.1)
 * @param {"full"|"legacy"|"none"|"csp-only"} [o.policy]
 * @param {boolean} [o.onlineCardExec]  运行配置里的总开关;只有明给 false 才写进配置
 * @param {boolean} [o.runtimeConfig]   给 false 就不提供运行配置(404):页面读不到舞台源,退回同源单舞台(仿没有舞台子域的部署)
 * @param {(info: { role: "editor"|"stageA"|"stageB", req: http.IncomingMessage, url: URL }) => (void | { status: number, body?: string | Buffer, headers?: Record<string, string | number> } | { delayMs: number })} [o.intercept]
 *        探针的钩子:回 `{ status, body?, headers? }` 直接应答(`body` 可以是字节,`headers` 盖过缺省的 text/plain 与策略头),回 `{ delayMs }` 压住这个请求再照常处理
 * @param {(info: { role: "editor"|"stageA"|"stageB", req: http.IncomingMessage, url: URL }) => (void | Record<string, string>)} [o.responseHeaders]
 *        探针的钩子:给转发出去的响应(文档服务、素材服务)补 / 盖响应头(例如给素材字节加 `cache-control: no-store`)
 */
export async function startHostedProxy({ dist, basePort, docPort, assetPort, policy = 'full', host = 'pc.localhost', onlineCardExec, runtimeConfig: withRuntimeConfig = true, intercept, responseHeaders }) {
  const DIST = path.resolve(dist);
  if (!fs.existsSync(path.join(DIST, 'index.html'))) throw new Error(`在线构建目录里没有 index.html:${DIST}`);
  const origins = proxyOrigins(basePort, host);
  const runtimeConfig = JSON.stringify({ v: 1, stageOrigins: origins.stages, ...(onlineCardExec === false ? { onlineCardExec: false } : {}) });
  /** 交接过来的票据(只留在内存里给探针比对,不打印) */
  const grants = [];
  /** 每个请求一条:{ role, method, path, status } */
  const requests = [];
  /** 每个请求的原样地址(含查询串;HTTP 与 WebSocket 升级都记):探针核「票据没有出现在任何地址里」用。别在日志里直接打印 */
  const urls = [];
  const noteUrl = (u) => { urls.push(u); if (urls.length > 50_000) urls.shift(); };
  const servers = [];
  /** 现有的 WebSocket 对(`cutWs` 掐断用) */
  const wsPairs = new Set();
  /** 探针可以直接改的开关:`blockWs` 拒新的 WebSocket 升级;`blockMedia` 让 `/media/…` 连不上(旧办法那条路,不含 `/media-s/`) */
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
    /** 断这一套代理上的 WebSocket:现有的掐掉、新的拒掉(`blockWs = false` 再放行)。只掐这一套,别的代理照常 */
    cutWs() { api.blockWs = true; for (const p of wsPairs) { p.socket.destroy(); p.up?.destroy(); } wsPairs.clear(); },
    async close() {
      for (const p of wsPairs) { p.socket.destroy(); p.up?.destroy(); }
      for (const s of servers) { s.closeAllConnections?.(); await new Promise((r) => s.close(() => r())); }
    },
  });
}

/* ------------------------------------------------------------------ 直接运行:本机隔离托管组合 + 代理 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const arg = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : dflt; };
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  const basePort = Number(arg('--base-port', 5750)), docPort = Number(arg('--doc-port', 8780)), assetPort = Number(arg('--asset-port', 8781));
  const os = await import('node:os');
  const { randomBytes } = await import('node:crypto');
  const { startHostedCombo } = await import('../../../cloud/server/hosted/combo.mjs');
  const dataDir = arg('--data-dir', fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hosted-proxy-')));
  const o = proxyOrigins(basePort);
  // 与托管端一样不信回环:经代理进来的请求一律核票据
  await startHostedCombo({ dataDir, docPort, assetPort, host: '127.0.0.1', trustLoopback: false, clusterToken: randomBytes(32).toString('base64url'),
    docPublicUrl: `ws://pc.localhost:${basePort}/hosted/`, assetPublicUrl: `${o.editor}/media/api/asset`, log: () => {} });
  const proxy = await startHostedProxy({ dist: arg('--dist', path.join(ROOT, 'dist-online')), basePort, docPort, assetPort, policy: arg('--policy', 'full') });
  console.log(JSON.stringify({ editor: `${proxy.editorOrigin}/editor`, stages: proxy.stageOrigins, policy: proxy.policy, dataDir }));
}
