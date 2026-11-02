/**
 * 页面的 `SyncLink`（`src/editor/sync/link.ts`）讲会话（HT-a，契约 `docs/plan/http-transport-contract.md` 第 9 节）：
 * 对着真的共享文档服务，中间挡会话网关（`session-gateway-kit.mjs`，服务端会话层合入前的测试桩）与可断的 TCP 代理。
 * 跑：node --test server/test/session-link-page.test.mjs
 *
 *   - 传输被掐断：DocSync 不离线、不重新 open、不重放；断开期间的修改接续后按序落地，文档服务的版本号 = 提交次数；
 *   - `dropFor(ms)`：结束会话（长时间断网）：DocSync 离线，回来后建新会话、重新 open，修改照样落地；
 *   - 对着没有会话层的旧服务端：照旧能用（一条传输一个会话）。
 * 页面代码经 vite 的 ssrLoadModule 载入（同 `agent-c65.test.mjs`）。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer as createVite } from 'vite';
import { createSharedDocService } from '../docservice/shared-service.mjs';
import { createTcpProxy, wsClient, waitFor, sleep } from './fake-ws-kit.mjs';
import { startSessionGateway, startLegacyFront } from './session-gateway-kit.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

async function startEnv(t, { gateway = true, direct = false } = {}) {
  const server = http.createServer((req, res) => { res.statusCode = 404; res.end(); });
  const built = createSharedDocService({ mode: 'lan', dataDir: null, store: null, server, path: '/docservice', isLoopback: () => true, localDevice: { deviceId: 'pc-test-device-0001', deviceName: 'test' }, log: () => {} });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const docUrl = `ws://127.0.0.1:${server.address().port}/docservice`;
  // direct：服务端会话层已合入（HT-a 集成），页面经代理直连真服务，不挡网关
  const gw = gateway && !direct ? await startSessionGateway({ upstream: docUrl }) : null;
  // 没有网关时挡一层「旧服务端」前端：去掉会话项，服务端把页面当旧客户端（服务端会话层合入前后都成立）
  const front = gw || direct ? null : await startLegacyFront({ upstream: docUrl });
  const proxy = await createTcpProxy({ target: gw ? gw.port : direct ? server.address().port : front.port });
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  const links = [];
  t.after(async () => {
    for (const l of links) l.stop();
    await proxy.close();
    await gw?.close();
    await front?.close();
    await vite.close();
    await built.service.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const { SyncLink } = await vite.ssrLoadModule('/src/editor/sync/link.ts');
  const { createEmptyProject } = await vite.ssrLoadModule('/src/kernel/project.ts');
  const url = `ws://127.0.0.1:${proxy.port}/${direct ? 'docservice' : ''}`;

  function page(projectId) {
    const initial = createEmptyProject('page-test');
    initial.id = projectId;
    const events = { opens: 0, resumes: 0, closes: [], statuses: [] };
    const link = new SyncLink({
      url,
      protocols: () => ['promptcut.v1'],
      projectId,
      session: 'page-sl',
      initial,
      onOpen: () => { events.opens += 1; },
      onResume: () => { events.resumes += 1; },
      onClosed: (info) => events.closes.push(info),
      reconnect: { minMs: 30, maxMs: 200 },
    });
    link.ds.on('status', (s) => events.statuses.push(s));
    links.push(link);
    link.start();
    return { link, events };
  }

  /** 文档服务里这个项目的真身：另开一条旧式连接 project.open */
  async function body(projectId) {
    const c = wsClient(docUrl, ['promptcut.v1']);
    await c.opened;
    c.send({ type: 'project.open', projectId });
    const st = await c.next((m) => m.type === 'project.state', 3000);
    c.close();
    return st;
  }

  return { gw, proxy, page, body, service: built.service };
}

/** 在当前项目上改一处：第 i 条轨道的名字 */
function edit(link, i) {
  const p = link.ds.project;
  const next = { ...p, tracks: [...(p.tracks ?? []), { id: `sl-${i}`, name: `Track ${i}`, clips: [] }] };
  link.ds.commit(next);
}

test('SL-page-cut page transport cut: the session resumes, edits made while disconnected are neither lost nor replayed; DocSync stays online and does not re-open', async (t) => {
  const env = await startEnv(t);
  const { link, events } = env.page('p-page-cut');
  await waitFor(() => link.ds.status === 'online', 8000, 'page sync connected');
  await link.ds.whenSettled({ timeoutMs: 5000 });
  const rev0 = link.ds.rev;
  edit(link, 1);
  await link.ds.whenSettled({ timeoutMs: 5000 });
  env.proxy.cutAll();
  edit(link, 2);
  edit(link, 3);
  await sleep(50);
  edit(link, 4);
  await waitFor(() => events.resumes === 1, 5000, 'resumed');
  const settled = await link.ds.whenSettled({ timeoutMs: 5000 });
  assert.equal(settled.rev, rev0 + 4, `Each of the 4 commits landed once: ${rev0} → ${settled.rev}`);
  assert.equal(events.opens, 1, 'No second session was created');
  assert.deepEqual(events.closes, [], 'No disconnect');
  assert.ok(!events.statuses.includes('offline'), `DocSync never went offline: ${JSON.stringify(events.statuses)}`);
  assert.equal(env.gw.stats.opened, 1);
  assert.ok(env.gw.stats.resumed >= 1);
  const st = await env.body('p-page-cut');
  assert.equal(st.rev, settled.rev);
  assert.deepEqual(st.project.tracks.map((tr) => tr.id).filter((id) => id.startsWith('sl-')), ['sl-1', 'sl-2', 'sl-3', 'sl-4']);
  assert.deepEqual(JSON.parse(JSON.stringify(link.ds.project)), st.project, 'The page copy matches the original');
  const stats = link.stats();
  assert.equal(stats.transport, 'ws');
  assert.equal(stats.resumes, 1);
  assert.equal(stats.legacy, false);
});

test('SL-page-cut-inline cutTransport() likewise: only the transport is cut, the session resumes', async (t) => {
  const env = await startEnv(t);
  const { link, events } = env.page('p-page-cut2');
  await waitFor(() => link.ds.status === 'online', 8000, 'page sync connected');
  await link.ds.whenSettled({ timeoutMs: 5000 });
  const rev0 = link.ds.rev;
  assert.equal(link.cutTransport(), true);
  edit(link, 1);
  await waitFor(() => events.resumes === 1, 5000, 'resumed');
  const settled = await link.ds.whenSettled({ timeoutMs: 5000 });
  assert.equal(settled.rev, rev0 + 1);
  assert.equal(events.opens, 1);
});

test('SL-page-drop dropFor(ms) ends the session: DocSync goes offline, and after coming back a new session is created and re-opened, and edits made while offline land', async (t) => {
  const env = await startEnv(t);
  const { link, events } = env.page('p-page-drop');
  await waitFor(() => link.ds.status === 'online', 8000, 'page sync connected');
  await link.ds.whenSettled({ timeoutMs: 5000 });
  const rev0 = link.ds.rev;
  link.dropFor(300);
  await waitFor(() => link.ds.status === 'offline', 2000, 'offline');
  edit(link, 1);
  await waitFor(() => events.opens === 2, 5000, 'New session');
  const settled = await link.ds.whenSettled({ timeoutMs: 5000 });
  assert.equal(settled.rev, rev0 + 1);
  assert.equal(env.gw.stats.opened, 2);
  assert.equal(events.closes.length, 1);
});

test('SL-page-legacy against an old server without a session layer: the page still syncs as before (one session per transport)', async (t) => {
  const env = await startEnv(t, { gateway: false });
  const { link, events } = env.page('p-page-legacy');
  await waitFor(() => link.ds.status === 'online', 8000, 'page sync connected');
  edit(link, 1);
  const settled = await link.ds.whenSettled({ timeoutMs: 5000 });
  assert.equal(link.stats().legacy, true);
  env.proxy.cutAll();
  await waitFor(() => events.closes.length === 1 && events.opens === 2, 5000, 'Rebuilt after disconnect');
  edit(link, 2);
  const again = await link.ds.whenSettled({ timeoutMs: 5000 });
  assert.equal(again.rev, settled.rev + 1);
});

// 〔裁〕2026-09-27 主会话（契约第 17 节）：用户看得到的行为不许因会话层而变。脱开期间项目被删，接续得 4410、reason 里带
// 原关闭码 4004：页面收到的 CloseInfo 与连着时收到 4004 相同（fatal、不重连），界面据它弹同一个「项目已删除」
// （syncManager 的 blocked 只看 CloseInfo 的 code / reason / fatal）。

/** 等服务端把这个页面的会话看成脱开，回它的 connId */
async function detachedConn(env) {
  let connId = null;
  await waitFor(() => {
    const c = env.service.describe().conns.find((x) => x.detached);
    connId = c?.connId ?? null;
    return connId !== null;
  }, 3000, 'server detached');
  return connId;
}

for (const [code, reason] of [[4004, 'deleted'], [4003, 'removed']]) {
  test(`SL-page-final ended by ${code} ${reason} while detached (real server session layer): the page receives the same CloseInfo as when connected, and does not reconnect`, async (t) => {
    const env = await startEnv(t, { direct: true });
    const { link, events } = env.page(`p-page-final-${code}`);
    await waitFor(() => link.ds.status === 'online', 8000, 'page sync connected');
    edit(link, 1);
    await link.ds.whenSettled({ timeoutMs: 5000 });
    env.proxy.mode = 'reject';
    env.proxy.cutAll();
    const connId = await detachedConn(env);
    assert.equal(env.service.closeConn(connId, code, reason), true, 'The server ended the session while detached');
    env.proxy.mode = 'pass';
    await waitFor(() => events.closes.length === 1, 5000, 'The page received the disconnect');
    assert.deepEqual(events.closes, [{ code, reason, fatal: true, neverOpened: false }]);
    await sleep(400);
    assert.equal(events.opens, 1, 'No reconnect');
    assert.equal(link.connected, false);

    // 对照：连着时收到同一个码
    const live = env.page(`p-page-final-live-${code}`);
    await waitFor(() => live.link.ds.status === 'online', 8000, 'Control page connected');
    const liveConn = env.service.describe().conns.find((x) => !x.detached && !x.legacy && x.connId !== connId)?.connId;
    assert.ok(liveConn);
    env.service.closeConn(liveConn, code, reason);
    await waitFor(() => live.events.closes.length === 1, 5000, 'Control page received the disconnect');
    assert.deepEqual(live.events.closes, events.closes, 'The page receives the same thing while detached as while connected');
  });
}

test('SL-page-4410-renew the server ends the session with a 1001 shutdown while detached: the page treats it as the reconnecting kind (not fatal), and syncs as usual after a new session is created', async (t) => {
  const env = await startEnv(t, { direct: true });
  const { link, events } = env.page('p-page-renew');
  await waitFor(() => link.ds.status === 'online', 8000, 'page sync connected');
  env.proxy.mode = 'reject';
  env.proxy.cutAll();
  const connId = await detachedConn(env);
  env.service.closeConn(connId, 1001, 'shutdown');
  env.proxy.mode = 'pass';
  await waitFor(() => events.opens === 2, 5000, 'New session created');
  assert.equal(events.closes.length, 1);
  assert.equal(events.closes[0].code, 4410);
  assert.equal(events.closes[0].fatal, false);
  edit(link, 1);
  await link.ds.whenSettled({ timeoutMs: 5000 });
});
