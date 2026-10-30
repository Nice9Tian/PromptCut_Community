/**
 * 舞台端口的闸(`server/stage-gate.mjs` + `server/vite-plugin-stage-ports.ts`):从舞台端口来的请求缺省全拒,只放行白名单。
 *
 * 舞台窗口里跑的是卡片代码(含用户自己写的、别的成员写的),舞台端口对它是同源。这里钉三件事:
 *   1. 判据:白名单里的放行;各类本机接口、项目根下的文件、想跳出前缀的写法一律不放行;
 *      服务端源码里写着的每一条 `/api/…` 路由,除白名单点名的那几条只读的以外,从舞台端口来都不放行(新加的接口缺省就是拒的)。
 *   2. 代理:真的起两个舞台端口的代理,不在白名单里的请求当场 403、编辑器进程一个字节都没收到;WebSocket 升级同理。
 *   3. 编辑器端口:直连的请求不经过这道闸,原样往下走;带着舞台端口那个头的,编辑器进程自己再拒一次。
 *
 * 跑法:npm test -- server/test/stage-gate.test.mjs
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
import { stageRequestAllowed, STAGE_ALLOW } from '../stage-gate.mjs';
import { STAGE_CLIENT_HEADER } from '../http-guard.mjs';
import { freePortRange } from './free-ports.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const HMR = { upgrade: true, headers: { 'sec-websocket-protocol': 'vite-hmr' } };

/* ------------------------------------------------------------------ 1. 判据 */

test('白名单里的:舞台页面与脚本、素材、动效素材目录、两条只读接口、热更新的升级', () => {
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
  for (const [m, u] of allowed) assert.equal(stageRequestAllowed(m, u), true, `${m} ${u} 应该放行`);
  assert.equal(stageRequestAllowed('GET', '/?token=abc', HMR), true, '热更新的 WebSocket');
  assert.equal(stageRequestAllowed('GET', '/', { upgrade: true, headers: { 'sec-websocket-protocol': 'vite-ping' } }), true);
});

test('白名单每一条都写了谁用、为什么要,而且全部只读', () => {
  assert.ok(STAGE_ALLOW.length > 0);
  for (const rule of STAGE_ALLOW) {
    assert.ok(typeof rule.who === 'string' && rule.who && typeof rule.why === 'string' && rule.why, `缺说明:${JSON.stringify(rule)}`);
    assert.ok((rule.exact === undefined) !== (rule.prefix === undefined), `exact / prefix 二选一:${JSON.stringify(rule)}`);
    if (rule.prefix !== undefined) assert.ok(rule.prefix.startsWith('/') && rule.prefix.endsWith('/') && rule.prefix.length > 1, `前缀要写到斜杠为止,不能是整个根:${rule.prefix}`);
    assert.ok(rule.methods.every((m) => m === 'GET' || m === 'HEAD'), `白名单里不许有写方法:${JSON.stringify(rule)}`);
  }
});

/** 有代表性的一批本机接口:[方法, 地址]。从舞台端口来一律不放行 */
const DENIED = [
  // Agent 绑定与对话
  ['POST', '/api/agent/bind'], ['POST', '/api/agent/unbind'], ['POST', '/api/agent/ticket'], ['GET', '/api/agent/status'], ['GET', '/api/agent/inbox'],
  ['POST', '/api/agent/editing'], ['GET', '/api/agent/tabs'], ['POST', '/api/agent/spawned'],
  ['POST', '/api/ai/chat'], ['POST', '/api/ai/abort'], ['GET', '/api/ai/config'], ['POST', '/api/ai/config'], ['POST', '/api/ai/config/clear-key'], ['GET', '/api/ai/providers'],
  ['GET', '/api/ai/auth-state'], ['POST', '/api/ai/setup'], ['POST', '/api/ai/install'], ['GET', '/api/ai/machine-code'], ['POST', '/api/ai/diagnostics/save'], ['GET', '/api/ai/visual/x.png'],
  ['GET', '/api/chats/list'], ['GET', '/api/chats/get?id=x'], ['POST', '/api/chats/save'], ['POST', '/api/chats/delete'], ['POST', '/api/chats/attach/import'], ['POST', '/api/chats/attach/upload?name=x'],
  // 数据镜像、成本记录
  ['GET', '/api/data/project'], ['PUT', '/api/data/project'], ['POST', '/api/data/diff'], ['POST', '/api/data/playhead'], ['GET', '/api/data/ready-session'], ['GET', '/api/data/costs'], ['PUT', '/api/data/costs'],
  // 项目写入
  ['GET', '/api/projects'], ['GET', '/api/projects/x'], ['PUT', '/api/projects/x'], ['DELETE', '/api/projects/x'], ['GET', '/api/project-backups'], ['POST', '/api/project-backups/x/restore'],
  // 素材写入(读只放行 /api/media/file 这一条)
  ['POST', '/api/media/upload/x.mp4'], ['POST', '/api/media/adopt'], ['GET', '/api/media/local?hashes=a'], ['GET', '/api/media/originals'], ['POST', '/api/media/prefetch'], ['GET', '/api/media/remote'],
  ['GET', '/api/media/tiers'], ['POST', '/api/media/tiers/backfill'], ['GET', '/api/media/upload-queue'], ['POST', '/api/media/upload-queue/enqueue'], ['POST', '/api/media/upload-queue/target'],
  ['POST', '/api/media/file?path=x'], ['PUT', `/@media/${'a'.repeat(64)}`], ['DELETE', `/@media/${'a'.repeat(64)}`],
  ['PUT', `/api/asset/media/${'a'.repeat(64)}`], ['GET', `/api/asset/media/${'a'.repeat(64)}`], ['POST', `/api/asset/snap/${'a'.repeat(64)}/complete`],
  // 帧、预渲染与导出的写口
  ['POST', '/api/frames/preload'], ['POST', '/api/frames/yield'], ['POST', '/api/frames/render-node'], ['POST', '/api/frames/render-node/unbind'], ['GET', '/api/frames/ready'],
  ['GET', '/api/frames/snapshot/html/k/0'], ['GET', '/api/frames/stream/k/manifest'], ['POST', '/api/frames/export'],
  ['POST', '/api/export'], ['GET', '/api/export/x/status'], ['POST', '/api/export/media/x'], ['POST', '/api/export/audio-mix/x'], ['GET', '/api/exports'], ['DELETE', '/api/exports/x'],
  ['GET', '/api/storage'], ['POST', '/api/storage/cap'], ['POST', '/api/storage/clear-cache'], ['GET', '/api/prerender/health'], ['POST', '/api/prerender/info'],
  ['POST', '/api/vision/bake'], ['POST', '/api/vision/bake-batch'], ['POST', '/api/vision/snapshot'], ['POST', '/api/vision/sheet'], ['POST', '/api/ui-render/bake-batch'], ['GET', '/api/ui-render/status'],
  // MCP、Skill、文件系统类
  ['POST', '/api/mcp/call'], ['GET', '/api/mcp/events'], ['POST', '/api/mcp/result'], ['GET', '/api/mcp/status'],
  ['POST', '/api/skill/open-path'], ['POST', '/api/skill/desktop-register'], ['GET', '/api/skill'], ['POST', '/api/skill-mode/open'], ['GET', '/api/skill-mode'], ['POST', '/api/skill-lock/release'], ['GET', '/api/skill-lock'],
  // 卡片写入与同步、渲染节点
  ['POST', '/api/cards/create'], ['POST', '/api/cards/edit'], ['GET', '/api/cards/source?id=x'], ['POST', '/api/cards/install'], ['POST', '/api/cards/dom'], ['POST', '/api/cards/audio'], ['GET', '/api/cards/guide'],
  ['POST', '/api/cards/layout'], ['POST', '/api/cards/scopes'], ['GET', '/api/cards/scopes/x'],
  ['POST', '/api/cards/sync/bind'], ['POST', '/api/cards/sync/unbind'], ['POST', '/api/cards/sync/ticket'], ['GET', '/api/cards/sync/status'],
  ['POST', '/api/render-node/bind'], ['POST', '/api/render-node/unbind'], ['POST', '/api/render-node/ticket'], ['POST', '/api/render-node/ticket-request'], ['GET', '/api/render-node/status'],
  // 采集、网页工具、听写、镜头、抠像、跟踪、配音、声音测量
  ['GET', '/api/collect/cookies'], ['POST', '/api/collect/download'], ['POST', '/api/collect/login'], ['GET', '/api/collect/qr/svg'], ['POST', '/api/web/open'], ['POST', '/api/web/type'], ['GET', '/api/web/view'],
  ['POST', '/api/stt/transcribe'], ['POST', '/api/stt/upload/j/x.wav'], ['GET', '/api/stt/status'], ['POST', '/api/shots/detect'], ['POST', '/api/subject/detect'], ['POST', '/api/track/track'],
  ['GET', '/api/voice/config'], ['POST', '/api/voice/generate'], ['POST', '/api/voice/clear-key'], ['POST', '/api/audio/measure'],
  // 文档服务、协作、舞台端口自己的查询口
  ['GET', '/api/docservice/device'], ['GET', '/api/docservice/healthz'], ['GET', '/api/docservice/lan-discover'], ['POST', '/api/collaboration/move-hosted'], ['POST', '/docservice/shared/create'], ['GET', '/docservice'],
  ['GET', '/api/stage/ports'],
  // 导出页、看画面用的内部地址
  ['GET', '/@cards-dom/abc/project.json'], ['GET', '/@export/abc/project.json'], ['GET', '/__open-in-editor?file=src/main.tsx'], ['GET', '/@id/__x00__virtual:x'],
  // 项目根下的文件(开发服务器的静态服务会按路径发)
  ['GET', '/package.json'], ['GET', '/vite.config.ts'], ['GET', '/index.html'], ['GET', '/docs/local.md'], ['GET', '/out/cookies/bilibili.txt'], ['GET', '/out/docservice/x'], ['GET', '/.pc-chats/x.json'],
  ['GET', '/.pc-projects/x.proc'], ['GET', '/.env'], ['GET', '/.git/config'], ['GET', '/desktop/src-tauri/tauri.conf.json'], ['GET', '/scripts/test-suite.mjs'],
  // /@fs/:不带 /node_modules/ 的任意文件
  ['GET', '/@fs/C:/Windows/win.ini'], ['GET', '/@fs/C:/Users/someone/repo/docs/local.md'], ['GET', '/@fs/C:/Users/someone/AppData/Local/PromptCut/ai.json'],
  // 白名单路径上的写方法
  ['POST', '/'], ['POST', '/src/main.tsx'], ['PUT', '/server/stage-gate.mjs'], ['DELETE', '/node_modules/x'], ['POST', '/catalog/lottie/x.json'], ['OPTIONS', '/api/cards/scopes'], ['PATCH', '/api/prerender/info'],
];

test('有代表性的一批本机接口从舞台端口来一律不放行', () => {
  for (const [m, u] of DENIED) assert.equal(stageRequestAllowed(m, u), false, `${m} ${u} 不该放行`);
});

test('大小写、重复斜杠、点段、编码过的点和斜杠:都绕不过去', () => {
  const sneaky = [
    ['POST', '/aPi/agent/bind'], ['POST', '/API/AGENT/BIND'], ['POST', '//api/agent/bind'], ['POST', '/api//agent/bind'],
    ['GET', '/src/../package.json'], ['GET', '/src/../out/cookies/bilibili.txt'], ['GET', '/src/..'], ['GET', '/@media/../../docs/local.md'], ['GET', '/catalog/../api/agent/status'],
    ['GET', '/src/%2e%2e/package.json'], ['GET', '/src/%2E%2E/package.json'], ['GET', '/src/..%2fpackage.json'], ['GET', '/src/..%5cpackage.json'], ['GET', '/src\\..\\package.json'],
    ['GET', '/@fs/C:/repo/node_modules/../docs/local.md'], ['GET', '/@fs/C:/repo/node_modules/%2e%2e/docs/local.md'], ['GET', '/@fs/C:/repo/x?/node_modules/'],
    ['GET', '/src/a.ts%00.png'], ['GET', 'http://127.0.0.1:5190/api/agent/status'], ['GET', 'src/main.tsx'],
    ['GET', '/api/cards/scopes/'], ['GET', '/api/prerender/info/x'], ['GET', '/api/media/files'], ['GET', '/srcx/main.tsx'], ['GET', '/@react-refreshx'],
  ];
  for (const [m, u] of sneaky) assert.equal(stageRequestAllowed(m, u), false, `${m} ${JSON.stringify(u)} 不该放行`);
  // 空地址 Node 会当成 "/":那是舞台文档,GET 放行、别的方法不放行
  assert.equal(stageRequestAllowed('POST', undefined), false);
});

test('WebSocket 升级:只认热更新那一条;文档服务等别的升级不放行;普通请求的白名单不适用于升级', () => {
  const proto = (p) => ({ upgrade: true, headers: p === null ? {} : { 'sec-websocket-protocol': p } });
  assert.equal(stageRequestAllowed('GET', '/docservice', proto('promptcut.v1')), false);
  assert.equal(stageRequestAllowed('GET', '/docservice', proto('vite-hmr')), false);
  assert.equal(stageRequestAllowed('GET', '/', proto(null)), false);
  assert.equal(stageRequestAllowed('GET', '/', proto('promptcut.v1')), false);
  assert.equal(stageRequestAllowed('GET', '/', proto('xvite-hmr')), false);
  assert.equal(stageRequestAllowed('GET', '/src/main.tsx', proto('vite-hmr')), false);
  assert.equal(stageRequestAllowed('GET', '/', proto('promptcut.v1, vite-hmr')), true, '子协议表里带着热更新那一个');
  // 反过来:热更新那条规则不让普通的 POST 混进来
  assert.equal(stageRequestAllowed('POST', '/', HMR), false);
});

test('服务端源码里写着的每一条 /api 路由,除白名单点名的以外,从舞台端口来都不放行', () => {
  const files = [...fs.readdirSync(path.join(ROOT, 'server')).filter((f) => /^vite-plugin-.*\.ts$/.test(f) || f === 'asset-service.ts' || f === 'asset-client.ts').map((f) => path.join(ROOT, 'server', f)),
    path.join(ROOT, 'server', 'vision', 'routes.ts')];
  const routes = new Set();
  for (const file of files) for (const m of fs.readFileSync(file, 'utf8').matchAll(/["'`](\/api\/[A-Za-z0-9/_-]+)/g)) routes.add(m[1]);
  assert.ok(routes.size > 100, `扫到的路由太少(${routes.size}),扫描的写法多半失效了`);
  const readable = new Set(['/api/media/file', '/api/cards/scopes', '/api/prerender/info']);
  const leaked = [];
  for (const route of routes) {
    for (const method of ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      const ok = stageRequestAllowed(method, route) || stageRequestAllowed(method, `${route}/x`) || stageRequestAllowed(method, `${route}?a=1`);
      const expected = readable.has(route) && (method === 'GET' || method === 'HEAD');
      if (ok !== expected) leaked.push(`${method} ${route} → ${ok}`);
    }
  }
  assert.deepEqual(leaked, [], '白名单之外的接口被放行了,或者白名单里的被拒了');
});

/* ------------------------------------------------------------------ 2、3. 真的代理 */

/** 把插件转译出来(同 `api-guard.test.mjs` 的做法),兄弟模块换成绝对地址 */
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

/** 发一个请求,回状态码、响应头与正文 */
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

/** 发一次 WebSocket 升级,回服务端答的状态行里的状态码(101 = 接上了) */
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

test('真的起两个舞台端口:白名单外的当场 403、编辑器进程没收到;白名单里的照转;编辑器端口直连不变', { timeout: 60_000 }, async (t) => {
  const { stagePortsPlugin, dir } = await loadPlugin();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const base = await freePortRange(3);

  // 「编辑器进程」:一个真的 HTTP 服务,前面挂插件注册的中间件(同 connect 的顺序),后面是记流水的业务
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
  // 等两个舞台端口的代理起来(插件在编辑器开始监听之后才起)
  const ports = JSON.parse((await send(base, { path: '/api/stage/ports' })).body);
  assert.deepEqual(ports.ports, [base + 1, base + 2], '两个舞台端口都起来了');
  seen.length = 0;
  const J = { 'content-type': 'application/json' };

  for (const stage of [base + 1, base + 2]) {
    // 白名单外:403,而且编辑器进程没收到
    const before = seen.length;
    for (const [method, url] of [['POST', '/api/agent/bind'], ['GET', '/api/agent/status'], ['POST', '/api/ai/chat'], ['PUT', '/api/data/project'], ['PUT', '/api/projects/x'],
      ['POST', '/api/media/upload/x.txt'], ['POST', '/api/frames/preload'], ['POST', '/api/export'], ['POST', '/api/mcp/call'], ['POST', '/api/skill/open-path'],
      ['POST', '/api/cards/sync/bind'], ['POST', '/api/render-node/bind'], ['GET', '/api/stage/ports'], ['GET', '/package.json'], ['GET', '/@fs/C:/Windows/win.ini'], ['POST', '/aPi/agent/bind']]) {
      const r = await send(stage, { method, path: url, headers: method === 'GET' ? {} : J, body: method === 'GET' ? undefined : '{"x":1}' });
      assert.equal(r.status, 403, `${method} ${url} 经舞台端口 ${stage} 应该 403`);
      assert.equal(r.headers['origin-agent-cluster'], '?1', '被拒的响应也带进程隔离的头(这个头要在这个源的每一个响应上)');
      assert.equal(JSON.parse(r.body).ok, false);
    }
    assert.equal(seen.length, before, '被拒的请求编辑器进程一个都没收到');

    // 白名单里:照转,带着代理写的头(请求自己伪造的同名头被盖掉)
    for (const url of ['/?stage=1&id=A', '/src/main.tsx', '/api/cards/scopes', '/api/prerender/info', `/@media/${'b'.repeat(64)}`, '/catalog/lottie/bodymovin.json']) {
      const r = await send(stage, { path: url, headers: { [STAGE_CLIENT_HEADER]: '8.8.8.8' } });
      assert.equal(r.status, 200, `GET ${url} 经舞台端口应该照转`);
      assert.equal(r.headers['origin-agent-cluster'], '?1');
      const got = seen.at(-1);
      assert.equal(got.url, url);
      assert.equal(got.stage, '127.0.0.1', '编辑器进程看到的是代理写的真实对端');
      assert.equal(got.host, `127.0.0.1:${stage}`, 'Host 原样转过去');
    }

    // 升级:热更新的接上,别的 403、编辑器进程没收到
    const upBefore = upgrades.length;
    assert.equal(await upgrade(stage, '/docservice', 'promptcut.v1'), 403);
    assert.equal(await upgrade(stage, '/', null), 403);
    assert.equal(upgrades.length, upBefore, '被拒的升级编辑器进程没收到');
    assert.equal(await upgrade(stage, '/?token=t', 'vite-hmr'), 101);
    assert.equal(upgrades.at(-1).url, '/?token=t');
  }

  // 编辑器端口直连:不带那个头,这道闸不管,原样到业务(包括上面被拒的那些)
  for (const [method, url] of [['POST', '/api/agent/bind'], ['PUT', '/api/data/project'], ['POST', '/api/mcp/call'], ['GET', '/package.json'], ['GET', '/api/cards/scopes']]) {
    const r = await send(base, { method, path: url, headers: method === 'GET' ? {} : J, body: method === 'GET' ? undefined : '{"x":1}' });
    assert.equal(r.status, 200, `${method} ${url} 直连编辑器端口照常`);
    assert.equal(seen.at(-1).url, url);
    assert.equal(seen.at(-1).stage, null);
    if (method !== 'GET') assert.equal(seen.at(-1).body, '{"x":1}', '请求体原样');
    assert.equal(r.headers['origin-agent-cluster'], undefined);
  }
  assert.equal(await upgrade(base, '/docservice', 'promptcut.v1'), 101, '编辑器端口上的文档服务升级照常');

  // 第二道:带着舞台端口那个头直连编辑器端口,白名单外的编辑器进程自己拒,白名单里的放过
  const before = seen.length;
  const forged = await send(base, { method: 'POST', path: '/api/agent/bind', headers: { ...J, [STAGE_CLIENT_HEADER]: '127.0.0.1' }, body: '{}' });
  assert.equal(forged.status, 403);
  assert.equal(seen.length, before);
  assert.equal((await send(base, { path: '/src/main.tsx', headers: { [STAGE_CLIENT_HEADER]: '127.0.0.1' } })).status, 200);
});

test('桌面版舞台锁死：来自舞台的按哈希读素材只放行当前项目 project.media 里的素材，非当前项目回 403', () => {
  const hashInProject = '1'.repeat(64);
  const hashNotInProject = '2'.repeat(64);
  const hashes = new Set([hashInProject]);

  // 当 projectMediaHashes 被配置时
  assert.equal(stageRequestAllowed('GET', `/@media/${hashInProject}`, { projectMediaHashes: hashes }), true);
  assert.equal(stageRequestAllowed('GET', `/@media/${hashInProject}.mp4`, { projectMediaHashes: hashes }), true);
  assert.equal(stageRequestAllowed('GET', `/@media/${hashInProject}/pcm`, { projectMediaHashes: hashes }), true);

  assert.equal(stageRequestAllowed('GET', `/@media/${hashNotInProject}`, { projectMediaHashes: hashes }), false);
  assert.equal(stageRequestAllowed('HEAD', `/@media/${hashNotInProject}.mp4`, { projectMediaHashes: hashes }), false);
  assert.equal(stageRequestAllowed('GET', `/@media/${hashNotInProject}/pcm`, { projectMediaHashes: hashes }), false);
});
