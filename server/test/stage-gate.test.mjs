/**
 * Stage port gate (`server/stage-gate.mjs` + `server/vite-plugin-stage-ports.ts`): requests from
 * stage ports are all rejected by default, only whitelisted requests are allowed.
 *
 * The stage window runs card code (including what the user writes and what other members write),
 * and the stage port is same-origin to it. Pin down three things here:
 *   1. Criteria: allow those on the whitelist; disallow all local endpoints, files under the
 *      project root, and patterns attempting to escape the prefix; every `/api/…` route written
 *      in the server source code is disallowed when coming from stage ports, except for the few
 *      read-only routes explicitly named on the whitelist (newly added endpoints are rejected by
 *      default).
 *   2. Proxies: actually start two stage port proxies; requests not on the whitelist receive 403
 *      on the spot, and the editor process does not receive a single byte; the same applies to
 *      WebSocket upgrades.
 *   3. Editor port: direct connection requests bypass this gate and proceed as-is; for requests
 *      carrying the stage port header, the editor process itself rejects them once more.
 *
 * Run: npm test -- server/test/stage-gate.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { registerStageAllow, stageRequestAllowed, STAGE_ALLOW } from '../stage-gate.mjs';
import { STAGE_CLIENT_HEADER } from '../http-guard.mjs';
import { freePortRange } from './free-ports.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const HMR = { upgrade: true, headers: { 'sec-websocket-protocol': 'vite-hmr' } };

/* ------------------------------------------------------------------ 1. Criteria */

test('On the allowlist: stage pages and scripts, media, the motion graphics asset catalog, two read-only endpoints, hot-reload upgrades', () => {
  const allowed = [
    ['GET', '/?stage=1&id=A&preview=stage&dual=1'],
    ['GET', '/'],
    ['GET', '/src/main.tsx'],
    ['GET', '/src/cards/user/my-card.tsx?t=1791924305109'],
    ['GET', '/src/index.css?direct'],
    ['GET', '/server/stage-ports.mjs'],
    ['GET', '/server/catalog/particles/snow.json?import'],
    ['GET', '/node_modules/.vite/deps/react.js?v=43723146'],
    ['GET', '/@fs/C:/Users/someone/repo/node_modules/katex/dist/katex.min.css'],
    ['GET', '/@vite/client'],
    ['GET', '/@react-refresh'],
    ['GET', `/@media/${'a'.repeat(64)}`],
    ['HEAD', `/@media/${'a'.repeat(64)}.mp4`],
    ['GET', `/@media/${'a'.repeat(64)}/pcm?start=0&count=4800&sampleRate=48000&ch=2`],
    ['GET', '/@media/%E4%B8%AD%E6%96%87.mp4'],
    ['GET', '/api/media/file?path=C%3A%5CUsers%5Csomeone%5CVideos%5CPromptCut%5Cmedia%5Ca.mp4'],
    ['HEAD', '/api/media/file?path=x'],
    ['GET', '/catalog/lottie/bodymovin.json'],
    ['GET', '/api/cards/scopes'],
    ['GET', '/api/prerender/info'],
  ];
  for (const [m, u] of allowed) assert.equal(stageRequestAllowed(m, u), true, `${m} ${u} should be allowed`);
  assert.equal(stageRequestAllowed('GET', '/?token=abc', HMR), true, 'hot-reload WebSocket');
  assert.equal(stageRequestAllowed('GET', '/', { upgrade: true, headers: { 'sec-websocket-protocol': 'vite-ping' } }), true);
});

test('every allowlist entry says who uses it and why it is needed, and all of them are read-only', () => {
  assert.ok(STAGE_ALLOW.length > 0);
  for (const rule of STAGE_ALLOW) {
    assert.ok(typeof rule.who === 'string' && rule.who && typeof rule.why === 'string' && rule.why, `missing explanation: ${JSON.stringify(rule)}`);
    assert.ok((rule.exact === undefined) !== (rule.prefix === undefined), `exactly one of exact / prefix: ${JSON.stringify(rule)}`);
    if (rule.prefix !== undefined) assert.ok(rule.prefix.startsWith('/') && rule.prefix.endsWith('/') && rule.prefix.length > 1, `a prefix must end at a slash and cannot be the entire root: ${rule.prefix}`);
    assert.ok(rule.methods.every((m) => m === 'GET' || m === 'HEAD'), `write methods are not allowed in the allowlist: ${JSON.stringify(rule)}`);
  }
});

/** A representative batch of local endpoints: [method, url]. None are allowed from stage ports */
const DENIED = [
  // Agent binding and chat
  ['POST', '/api/agent/bind'], ['POST', '/api/agent/unbind'], ['POST', '/api/agent/ticket'], ['GET', '/api/agent/status'], ['GET', '/api/agent/inbox'],
  ['POST', '/api/agent/editing'], ['GET', '/api/agent/tabs'], ['POST', '/api/agent/spawned'],
  ['POST', '/api/ai/chat'], ['POST', '/api/ai/abort'], ['GET', '/api/ai/config'], ['POST', '/api/ai/config'], ['POST', '/api/ai/config/clear-key'], ['GET', '/api/ai/providers'],
  ['GET', '/api/ai/auth-state'], ['POST', '/api/ai/setup'], ['POST', '/api/ai/install'], ['GET', '/api/ai/machine-code'], ['POST', '/api/ai/diagnostics/save'], ['GET', '/api/ai/visual/x.png'],
  ['GET', '/api/chats/list'], ['GET', '/api/chats/get?id=x'], ['POST', '/api/chats/save'], ['POST', '/api/chats/delete'], ['POST', '/api/chats/attach/import'], ['POST', '/api/chats/attach/upload?name=x'],
  // Data mirror, cost record
  ['GET', '/api/data/project'], ['PUT', '/api/data/project'], ['POST', '/api/data/diff'], ['POST', '/api/data/playhead'], ['GET', '/api/data/ready-session'], ['GET', '/api/data/costs'], ['PUT', '/api/data/costs'],
  // Project write
  ['GET', '/api/projects'], ['GET', '/api/projects/x'], ['PUT', '/api/projects/x'], ['DELETE', '/api/projects/x'], ['GET', '/api/project-backups'], ['POST', '/api/project-backups/x/restore'],
  // Asset writes (reads only allow the single route /api/media/file)
  ['POST', '/api/media/upload/x.mp4'], ['POST', '/api/media/adopt'], ['GET', '/api/media/local?hashes=a'], ['GET', '/api/media/originals'], ['POST', '/api/media/prefetch'], ['GET', '/api/media/remote'],
  ['GET', '/api/media/tiers'], ['POST', '/api/media/tiers/backfill'], ['GET', '/api/media/upload-queue'], ['POST', '/api/media/upload-queue/enqueue'], ['POST', '/api/media/upload-queue/target'],
  ['POST', '/api/media/file?path=x'], ['PUT', `/@media/${'a'.repeat(64)}`], ['DELETE', `/@media/${'a'.repeat(64)}`],
  ['PUT', `/api/asset/media/${'a'.repeat(64)}`], ['GET', `/api/asset/media/${'a'.repeat(64)}`], ['POST', `/api/asset/snap/${'a'.repeat(64)}/complete`],
  // Write endpoints for frames, prerender, and export
  ['POST', '/api/frames/preload'], ['POST', '/api/frames/yield'], ['POST', '/api/frames/render-node'], ['POST', '/api/frames/render-node/unbind'], ['GET', '/api/frames/ready'],
  ['GET', '/api/frames/snapshot/html/k/0'], ['GET', '/api/frames/stream/k/manifest'], ['POST', '/api/frames/export'],
  ['POST', '/api/export'], ['GET', '/api/export/x/status'], ['POST', '/api/export/media/x'], ['POST', '/api/export/audio-mix/x'], ['GET', '/api/exports'], ['DELETE', '/api/exports/x'],
  ['GET', '/api/storage'], ['POST', '/api/storage/cap'], ['POST', '/api/storage/clear-cache'], ['GET', '/api/prerender/health'], ['POST', '/api/prerender/info'],
  ['POST', '/api/vision/bake'], ['POST', '/api/vision/bake-batch'], ['POST', '/api/vision/snapshot'], ['POST', '/api/vision/sheet'], ['POST', '/api/ui-render/bake-batch'], ['GET', '/api/ui-render/status'],
  // MCP, Skill, and filesystem categories
  ['POST', '/api/mcp/call'], ['GET', '/api/mcp/events'], ['POST', '/api/mcp/result'], ['GET', '/api/mcp/status'],
  ['POST', '/api/skill/open-path'], ['POST', '/api/skill/desktop-register'], ['GET', '/api/skill'], ['POST', '/api/skill-mode/open'], ['GET', '/api/skill-mode'], ['POST', '/api/skill-lock/release'], ['GET', '/api/skill-lock'],
  // Card write and sync, render nodes
  ['POST', '/api/cards/create'], ['POST', '/api/cards/edit'], ['GET', '/api/cards/source?id=x'], ['POST', '/api/cards/install'], ['POST', '/api/cards/dom'], ['POST', '/api/cards/audio'], ['GET', '/api/cards/guide'],
  ['POST', '/api/cards/layout'], ['POST', '/api/cards/scopes'], ['GET', '/api/cards/scopes/x'],
  ['POST', '/api/cards/sync/bind'], ['POST', '/api/cards/sync/unbind'], ['POST', '/api/cards/sync/ticket'], ['GET', '/api/cards/sync/status'],
  ['POST', '/api/render-node/bind'], ['POST', '/api/render-node/unbind'], ['POST', '/api/render-node/ticket'], ['POST', '/api/render-node/ticket-request'], ['GET', '/api/render-node/status'],
  // Collection, web tools, speech-to-text, shots, keying, tracking, voiceover, sound measurement
  ['GET', '/api/collect/cookies'], ['POST', '/api/collect/download'], ['POST', '/api/collect/login'], ['GET', '/api/collect/qr/svg'], ['POST', '/api/web/open'], ['POST', '/api/web/type'], ['GET', '/api/web/view'],
  ['POST', '/api/stt/transcribe'], ['POST', '/api/stt/upload/j/x.wav'], ['GET', '/api/stt/status'], ['POST', '/api/shots/detect'], ['POST', '/api/subject/detect'], ['POST', '/api/track/track'],
  ['GET', '/api/voice/config'], ['POST', '/api/voice/generate'], ['POST', '/api/voice/clear-key'], ['POST', '/api/audio/measure'],
  // Document service, collaboration, stage port's own query endpoint
  ['GET', '/api/docservice/device'], ['GET', '/api/docservice/healthz'], ['GET', '/api/docservice/lan-discover'], ['POST', '/api/collaboration/move-hosted'], ['POST', '/docservice/shared/create'], ['GET', '/docservice'],
  ['GET', '/api/stage/ports'],
  // Export page, internal URLs for viewing video
  ['GET', '/@cards-dom/abc/project.json'], ['GET', '/@export/abc/project.json'], ['GET', '/__open-in-editor?file=src/main.tsx'], ['GET', '/@id/__x00__virtual:x'],
  // Files under the project root (dev server static service serves by path)
  ['GET', '/package.json'], ['GET', '/vite.config.ts'], ['GET', '/index.html'], ['GET', '/docs/local.md'], ['GET', '/out/cookies/bilibili.txt'], ['GET', '/out/docservice/x'], ['GET', '/.pc-chats/x.json'],
  ['GET', '/.pc-projects/x.proc'], ['GET', '/.env'], ['GET', '/.git/config'], ['GET', '/desktop/src-tauri/tauri.conf.json'], ['GET', '/scripts/test-suite.mjs'],
  // /@fs/: Any file not containing /node_modules/
  ['GET', '/@fs/C:/Windows/win.ini'], ['GET', '/@fs/C:/Users/someone/repo/docs/local.md'], ['GET', '/@fs/C:/Users/someone/AppData/Local/PromptCut/ai.json'],
  // Write methods on whitelisted paths
  ['POST', '/'], ['POST', '/src/main.tsx'], ['PUT', '/server/stage-gate.mjs'], ['DELETE', '/node_modules/x'], ['POST', '/catalog/lottie/x.json'], ['OPTIONS', '/api/cards/scopes'], ['PATCH', '/api/prerender/info'],
];

test('A representative set of local endpoints is never allowed from a stage port', () => {
  for (const [m, u] of DENIED) assert.equal(stageRequestAllowed(m, u), false, `${m} ${u} should not be allowed`);
});

test('Case changes, repeated slashes, dot segments, and encoded dots and slashes: none of them get past it', () => {
  const sneaky = [
    ['POST', '/aPi/agent/bind'], ['POST', '/API/AGENT/BIND'], ['POST', '//api/agent/bind'], ['POST', '/api//agent/bind'],
    ['GET', '/src/../package.json'], ['GET', '/src/../out/cookies/bilibili.txt'], ['GET', '/src/..'], ['GET', '/@media/../../docs/local.md'], ['GET', '/catalog/../api/agent/status'],
    ['GET', '/src/%2e%2e/package.json'], ['GET', '/src/%2E%2E/package.json'], ['GET', '/src/..%2fpackage.json'], ['GET', '/src/..%5cpackage.json'], ['GET', '/src\\..\\package.json'],
    ['GET', '/@fs/C:/repo/node_modules/../docs/local.md'], ['GET', '/@fs/C:/repo/node_modules/%2e%2e/docs/local.md'], ['GET', '/@fs/C:/repo/x?/node_modules/'],
    ['GET', '/src/a.ts%00.png'], ['GET', 'http://127.0.0.1:5190/api/agent/status'], ['GET', 'src/main.tsx'],
    ['GET', '/api/cards/scopes/'], ['GET', '/api/prerender/info/x'], ['GET', '/api/media/files'], ['GET', '/srcx/main.tsx'], ['GET', '/@react-refreshx'],
  ];
  for (const [m, u] of sneaky) assert.equal(stageRequestAllowed(m, u), false, `${m} ${JSON.stringify(u)} should not be allowed`);
  // Empty path is treated as "/" by Node: that is the stage document, GET allowed, other methods disallowed
  assert.equal(stageRequestAllowed('POST', undefined), false);
});

test('WebSocket upgrade: only the hot-reload one is recognized; other upgrades such as the document service are not allowed; the allowlist for ordinary requests does not apply to upgrades', () => {
  const proto = (p) => ({ upgrade: true, headers: p === null ? {} : { 'sec-websocket-protocol': p } });
  assert.equal(stageRequestAllowed('GET', '/docservice', proto('promptcut.v1')), false);
  assert.equal(stageRequestAllowed('GET', '/docservice', proto('vite-hmr')), false);
  assert.equal(stageRequestAllowed('GET', '/', proto(null)), false);
  assert.equal(stageRequestAllowed('GET', '/', proto('promptcut.v1')), false);
  assert.equal(stageRequestAllowed('GET', '/', proto('xvite-hmr')), false);
  assert.equal(stageRequestAllowed('GET', '/src/main.tsx', proto('vite-hmr')), false);
  assert.equal(stageRequestAllowed('GET', '/', proto('promptcut.v1, vite-hmr')), true, 'the hot-reload one is in the subprotocol list');
  // Conversely: the hot reload rule does not allow regular POST to slip in
  assert.equal(stageRequestAllowed('POST', '/', HMR), false);
});

test('Every /api route written in the server source, except those named in the allowlist, is not allowed from a stage port', () => {
  const files = [...fs.readdirSync(path.join(ROOT, 'server')).filter((f) => /^vite-plugin-.*\.ts$/.test(f) || f === 'asset-service.ts' || f === 'asset-client.ts').map((f) => path.join(ROOT, 'server', f)),
    path.join(ROOT, 'server', 'vision', 'routes.ts')];
  const routes = new Set();
  for (const file of files) for (const m of fs.readFileSync(file, 'utf8').matchAll(/["'`](\/api\/[A-Za-z0-9/_-]+)/g)) routes.add(m[1]);
  assert.ok(routes.size > 100, `too few routes found (${routes.size}), the scanning pattern has probably stopped working`);
  const readable = new Set(['/api/media/file', '/api/cards/scopes', '/api/prerender/info']);
  const leaked = [];
  for (const route of routes) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const ok = stageRequestAllowed(method, route) || stageRequestAllowed(method, `${route}/x`) || stageRequestAllowed(method, `${route}?a=1`);
      const expected = readable.has(route) && (method === 'GET' || method === 'HEAD');
      if (ok !== expected) leaked.push(`${method} ${route} → ${ok}`);
    }
  }
  assert.deepEqual(leaked, [], 'an endpoint outside the allowlist was allowed, or one on the allowlist was rejected');
});

/* ------------------------------------------------------------------ 2, 3. Real proxies */

/** Transpile the plugin (same approach as `api-guard.test.mjs`), replace sibling modules with absolute paths */
async function loadPlugin() {
  const ts = createRequire(import.meta.url)('typescript');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-stage-gate-test-'));
  let src = fs.readFileSync(path.join(ROOT, 'server', 'vite-plugin-stage-ports.ts'), 'utf8');
  for (const name of ['stage-ports.mjs', 'http-guard.mjs', 'stage-gate.mjs']) src = src.split(`from "./${name}"`).join(`from "${pathToFileURL(path.join(ROOT, 'server', name)).href}"`);
  const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
  const file = path.join(out, 'stage-ports.mjs');
  fs.writeFileSync(file, js);
  return { ...(await import(pathToFileURL(file).href)), dir: out };
}

/** Send a request, return status code, response headers, and body */
function send(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers, agent: false }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Send a WebSocket upgrade, return the status code in the server response status line (101 = connected) */
function upgrade(port, p, protocol) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([`GET ${p} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: Upgrade', 'Upgrade: websocket', 'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', ...(protocol ? [`Sec-WebSocket-Protocol: ${protocol}`] : []), '', ''].join('\r\n'));
    });
    let text = '';
    const done = () => { socket.destroy(); resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(text)?.[1] ?? 0)); };
    socket.on('data', (c) => { text += c; if (text.includes('\r\n\r\n')) done(); });
    socket.on('close', done);
    socket.on('error', done);
    setTimeout(done, 5000).unref();
  });
}

test('Start two real stage ports: anything outside the allowlist gets 403 on the spot and the editor process never receives it; anything on the allowlist is forwarded as usual; direct connections to the editor port are unchanged', { timeout: 60_000 }, async (t) => {
  const { stagePortsPlugin, dir } = await loadPlugin();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = await freePortRange(3);

  // "Editor process": a real HTTP server, fronted by middleware registered by the plugin
  // (same order as connect), followed by activity-logging business logic
  const seen = [], upgrades = [];
  const stack = [];
  const business = (req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, stage: req.headers[STAGE_CLIENT_HEADER] ?? null, host: req.headers.host, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
  };
  const editor = http.createServer((req, res) => {
    let i = 0;
    const next = () => {
      const layer = stack[i++];
      if (!layer) return business(req, res);
      if (layer.route && !String(req.url).toLowerCase().startsWith(layer.route)) return next();
      layer.handle(req, res, next);
    };
    next();
  });
  editor.on('upgrade', (req, socket) => {
    upgrades.push({ url: req.url, stage: req.headers[STAGE_CLIENT_HEADER] ?? null });
    socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
  });
  const plugin = stagePortsPlugin();
  const viteServer = {
    middlewares: { use(a, b) { stack.push(typeof a === 'string' ? { route: a, handle: b } : { route: '', handle: a }); } },
    httpServer: editor,
    config: { logger: { warn() {}, info() {} } },
    close: async () => {},
  };
  plugin.configureServer(viteServer);
  await new Promise((resolve) => editor.listen(base, '127.0.0.1', resolve));
  t.after(async () => { await viteServer.close(); await new Promise((resolve) => { editor.close(resolve); editor.closeAllConnections?.(); }); });
  // Wait for the two stage port proxies to start up (the plugin starts them only after the editor starts listening)
  const ports = JSON.parse((await send(base, { path: '/api/stage/ports' })).body);
  assert.deepEqual(ports.ports, [base + 1, base + 2], 'both stage ports are up');
  seen.length = 0;
  const J = { 'content-type': 'application/json' };

  for (const stage of [base + 1, base + 2]) {
    // Outside whitelist: 403, and the editor process receives nothing
    const before = seen.length;
    for (const [method, url] of [['POST', '/api/agent/bind'], ['GET', '/api/agent/status'], ['POST', '/api/ai/chat'], ['PUT', '/api/data/project'], ['PUT', '/api/projects/x'],
      ['POST', '/api/media/upload/x.txt'], ['POST', '/api/frames/preload'], ['POST', '/api/export'], ['POST', '/api/mcp/call'], ['POST', '/api/skill/open-path'],
      ['POST', '/api/cards/sync/bind'], ['POST', '/api/render-node/bind'], ['GET', '/api/stage/ports'], ['GET', '/package.json'], ['GET', '/@fs/C:/Windows/win.ini'], ['POST', '/aPi/agent/bind']]) {
      const r = await send(stage, { method, path: url, headers: method === 'GET' ? {} : J, body: method === 'GET' ? undefined : '{"x":1}' });
      assert.equal(r.status, 403, `${method} ${url} via stage port ${stage} should get 403`);
      assert.equal(r.headers['origin-agent-cluster'], '?1', 'rejected responses also carry the process isolation header (this header must be on every response from this origin)');
      assert.equal(JSON.parse(r.body).ok, false);
    }
    assert.equal(seen.length, before, 'the editor process received none of the rejected requests');

    // Inside whitelist: forwarded as-is, with headers written by the proxy
    // (headers forged by the request with the same name are overwritten)
    for (const url of ['/?stage=1&id=A', '/src/main.tsx', '/api/cards/scopes', '/api/prerender/info', `/@media/${'b'.repeat(64)}`, '/catalog/lottie/bodymovin.json']) {
      const r = await send(stage, { path: url, headers: { [STAGE_CLIENT_HEADER]: '8.8.8.8' } });
      assert.equal(r.status, 200, `GET ${url} via the stage port should be forwarded as usual`);
      assert.equal(r.headers['origin-agent-cluster'], '?1');
      const got = seen.at(-1);
      assert.equal(got.url, url);
      assert.equal(got.stage, '127.0.0.1', 'the editor process sees the real peer written by the proxy');
      assert.equal(got.host, `127.0.0.1:${stage}`, 'Host is forwarded unchanged');
    }

    // Upgrade: hot reload connected, others 403, editor process receives nothing
    const upBefore = upgrades.length;
    assert.equal(await upgrade(stage, '/docservice', 'promptcut.v1'), 403);
    assert.equal(await upgrade(stage, '/', null), 403);
    assert.equal(upgrades.length, upBefore, 'the editor process did not receive the rejected upgrade');
    assert.equal(await upgrade(stage, '/?token=t', 'vite-hmr'), 101);
    assert.equal(upgrades.at(-1).url, '/?token=t');
  }

  // Editor port direct connection: without that header, this gate does not intervene,
  // passes as-is to business logic (including those rejected above)
  for (const [method, url] of [['POST', '/api/agent/bind'], ['PUT', '/api/data/project'], ['POST', '/api/mcp/call'], ['GET', '/package.json'], ['GET', '/api/cards/scopes']]) {
    const r = await send(base, { method, path: url, headers: method === 'GET' ? {} : J, body: method === 'GET' ? undefined : '{"x":1}' });
    assert.equal(r.status, 200, `${method} ${url} directly to the editor port works as usual`);
    assert.equal(seen.at(-1).url, url);
    assert.equal(seen.at(-1).stage, null);
    if (method !== 'GET') assert.equal(seen.at(-1).body, '{"x":1}', 'request body unchanged');
    assert.equal(r.headers['origin-agent-cluster'], undefined);
  }
  assert.equal(await upgrade(base, '/docservice', 'promptcut.v1'), 101, 'document service upgrades on the editor port work as usual');

  // Second barrier: connecting directly to editor port with the stage port header,
  // editor process rejects outside whitelist itself, allows whitelist
  const before = seen.length;
  const forged = await send(base, { method: 'POST', path: '/api/agent/bind', headers: { ...J, [STAGE_CLIENT_HEADER]: '127.0.0.1' }, body: '{}' });
  assert.equal(forged.status, 403);
  assert.equal(seen.length, before);
  assert.equal((await send(base, { path: '/src/main.tsx', headers: { [STAGE_CLIENT_HEADER]: '127.0.0.1' } })).status, 200);
});

test('Desktop app stage lockdown: reading media by hash from the stage is allowed only for media listed in the current project\'s project.media, and media outside the current project gets 403', () => {
  const hashInProject = '1'.repeat(64);
  const hashNotInProject = '2'.repeat(64);
  const hashes = new Set([hashInProject]);

  // When projectMediaHashes is configured
  assert.equal(stageRequestAllowed('GET', `/@media/${hashInProject}`, { projectMediaHashes: hashes }), true);
  assert.equal(stageRequestAllowed('GET', `/@media/${hashInProject}.mp4`, { projectMediaHashes: hashes }), true);
  assert.equal(stageRequestAllowed('GET', `/@media/${hashInProject}/pcm`, { projectMediaHashes: hashes }), true);

  assert.equal(stageRequestAllowed('GET', `/@media/${hashNotInProject}`, { projectMediaHashes: hashes }), false);
  assert.equal(stageRequestAllowed('HEAD', `/@media/${hashNotInProject}.mp4`, { projectMediaHashes: hashes }), false);
  assert.equal(stageRequestAllowed('GET', `/@media/${hashNotInProject}/pcm`, { projectMediaHashes: hashes }), false);
});

test('registerStageAllow: extra rules supplied by the build manifest count, and clearing them returns to the default', () => {
  const url = '/extra/mod.ts';
  assert.equal(stageRequestAllowed('GET', url), false);
  registerStageAllow([{ methods: ['GET'], prefix: '/extra/', who: '测试', why: '测试' }]);
  assert.equal(stageRequestAllowed('GET', url), true);
  assert.equal(stageRequestAllowed('POST', url), false, 'the method is judged by the rule');
  registerStageAllow([]);
  assert.equal(stageRequestAllowed('GET', url), false);
});
