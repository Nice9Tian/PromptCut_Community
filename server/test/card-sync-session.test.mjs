/**
 * 卡片源码同步走会话层（M8 计划 D9 / L14；HT-a 契约 `docs/plan/http-transport-contract.md` 第 9 节、第 17.1 节第 3 条；
 * 语义 `docs/semantics/product/document-service.md`「会话与传输」）。
 *
 * `server/card-sync.mjs` 缺省的连接是 `createDocEndpoint`（会话）。这里经一个可控的 TCP 代理（`fake-ws-kit.mjs` 的
 * `createTcpProxy`）掐断一方的传输，核对：
 *   CS-1 看的一方传输断一次：会话脱开后接续（不建新会话、不重订阅、不重对账），断开期间别人的改卡通知接续后补到，
 *        装卡恰好一次；
 *   CS-2 写的一方传输断一次：断开期间的保存（`content.put`）留在会话里，接续后补发，服务上的版本号只加一，
 *        另一方恰好装一次；
 *   CS-3 旧服务端（没有会话层，`session-gateway-kit.mjs` 的 `startLegacyFront`）：端点退化，断一次就是会话结束，
 *        重连后按对账补上，照样恰好装一次。
 * 两端的文件操作与 `card-sync.test.mjs` 同一套（真实装卡路径 `installSyncedFile`、备份 `backupBeforeEdit`）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

delete process.env.PROMPTCUT_CARD_OVERRIDES;
delete process.env.PROMPTCUT_DATA_DIR;

const { createDocService } = await import('../docservice/service.mjs');
const { contentModule } = await import('../docservice/modules/content.mjs');
const { createMemoryStore } = await import('../docservice/store/index.mjs');
const { createDocEndpoint } = await import('../render-node/session-link.mjs');
const { createCardSync } = await import('../card-sync.mjs');
const { emitCardSourceChange, onCardSourceChange } = await import('../card-overrides.mjs');
const { createTcpProxy, sleep } = await import('./fake-ws-kit.mjs');
const { startLegacyFront } = await import('./session-gateway-kit.mjs');
const cards = await import('../vite-plugin-cards.ts');

async function waitFor(fn, ms = 5000, what = '条件') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时(${ms} ms)`);
    await sleep(20);
  }
}

const USER_KEY = 'src/cards/user/price-tag.tsx';
const cardSource = (text) => `import { motion } from "motion/react";
import type { CardDef, CardProps } from "../../kernel/types";
interface Params { text: string }
function C({ params }: CardProps<Params>) {
  return <motion.div animate={{ opacity: 1 }}>{params.text}</motion.div>;
}
export const priceTag: CardDef<Params> = {
  id: "price-tag", name: "价格", description: "d", source: "user",
  frameMode: "stateful",
  defaults: { text: "${text}" },
  controls: [{ key: "text", label: "文字", type: "text" }],
  Component: C,
};
`;

/** 文档服务（内容库一个模块，自带会话层）；身份按查询串给 */
async function startDoc(t) {
  const service = createDocService({
    log: () => {},
    authenticate: (req) => {
      const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
      return { userId: q.get('user') ?? 'u', deviceId: q.get('dev') ?? 'd', role: 'page', tenantId: 't-cs' };
    },
    modules: [contentModule({ store: createMemoryStore() })],
  });
  const { port } = await service.listen(0, '127.0.0.1');
  t.after(() => service.close());
  return { port, url: `ws://127.0.0.1:${port}` };
}

/** 一个「编辑器进程」；`port` 是它连的端口（直连文档服务，或经代理） */
function editor(t, name, port, { defaultConnect = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pc-cs-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src', 'cards', 'user'), { recursive: true });
  const notices = [];
  const changes = [];
  const logs = [];
  const off = onCardSourceChange((file) => {
    if (path.resolve(file).startsWith(path.resolve(root) + path.sep)) changes.push(path.relative(root, file).split(path.sep).join('/'));
  });
  t.after(off);
  let protocolCalls = 0;
  const sync = createCardSync({
    stateDir: null,
    files: {
      read: (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } },
      changed: (rel) => rel.startsWith('src/cards/user/') && fs.existsSync(path.join(root, rel)),
      backup: (rel, content) => cards.backupBeforeEdit(root, rel, content),
      install: (rel, source) => {
        const r = cards.installSyncedFile({ root, historyDir: path.join(root, '.pc-work', 'card-history'), rel, source, existingIds: [] });
        if (r.ok && r.abs && r.status !== 'unchanged') emitCardSourceChange(r.abs);
        return { ok: r.ok, error: r.error };
      },
    },
    // 与缺省同一个端点（createDocEndpoint），只把退避调短；defaultConnect 时用模块缺省的连接
    connect: defaultConnect ? null : ({ url, protocols }) => createDocEndpoint({ url, protocols, transport: 'ws', backoff: { baseMs: 30, maxMs: 120, jitter: 0 }, log: (event) => logs.push(event) }),
    notify: (e) => notices.push(e),
    log: (event) => logs.push(event),
    retryMs: 200,
  });
  t.after(() => sync.close());
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  return {
    name, root, sync, notices, changes, logs, write,
    get protocolCalls() { return protocolCalls; },
    read: (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } },
    save(rel, content) { write(rel, content); return sync.saved(rel); },
    bind(projectId, keys = []) {
      return sync.bind({ projectId, url: `ws://127.0.0.1:${port}/?user=${name}&dev=dev-${name}`, local: false, keys, protocols: () => { protocolCalls += 1; return ['promptcut.v1']; } });
    },
  };
}

async function peek(doc, key) {
  const ws = new WebSocket(`${doc.url}/?user=peek`, ['promptcut.v1']);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const reply = await new Promise((resolve) => {
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.reqId === 'p1') resolve(m); });
    ws.send(JSON.stringify({ type: 'content.get', kind: 'card-source', key, reqId: 'p1' }));
  });
  ws.close();
  return reply;
}

const installsOf = (ed, rev) => ed.notices.filter((n) => n.type === 'installed' && (rev === undefined || n.rev === rev));

/** A 直连、B 经代理，A 带着 v1 进共享项目，B 装上 v1 */
async function pair(t, projectId, { front = null } = {}) {
  const doc = await startDoc(t);
  const target = front ? (await front(doc)).port : doc.port;
  const proxy = await createTcpProxy({ target });
  t.after(() => proxy.close());
  const A = editor(t, 'a', doc.port);
  const B = editor(t, 'b', proxy.port);
  A.write(USER_KEY, cardSource('v1'));
  A.bind(projectId, [USER_KEY]);
  await waitFor(() => A.sync.status().connected, 3000, 'A 连上');
  await A.sync.idle();
  B.bind(projectId);
  await waitFor(() => /v1/.test(B.read(USER_KEY) ?? ''), 5000, 'B 装上 v1');
  await B.sync.idle();
  return { doc, proxy, A, B };
}

test('CS-0 缺省连接就是会话：不注入 connect，传输断一次后接续，不算断线、不重建', async (t) => {
  const doc = await startDoc(t);
  const proxy = await createTcpProxy({ target: doc.port });
  t.after(() => proxy.close());
  const A = editor(t, 'a', proxy.port, { defaultConnect: true });
  A.write(USER_KEY, cardSource('v1'));
  A.bind('cs0', [USER_KEY]);
  await waitFor(() => A.sync.status().connected, 3000, 'A 连上');
  await A.sync.idle();
  proxy.cutAll();
  await waitFor(() => A.sync.status().resumes === 1, 5000, '接续');
  const st = A.sync.status();
  console.log(JSON.stringify({ case: 'CS-0', opens: st.opens, resumes: st.resumes, link: st.link }));
  assert.equal(st.opens, 1);
  assert.equal(st.link.legacy, false);
  assert.ok(A.logs.includes('doc.session.detach') && A.logs.includes('doc.session.resume'), '端点日志以 doc. 前缀转进同步日志');
  assert.ok(!A.logs.includes('cards.sync.close'));
});

test('CS-1 看的一方传输断一次：会话接续，断开期间的改卡通知补到，装卡恰好一次，不重建会话、不重对账', async (t) => {
  const { proxy, A, B } = await pair(t, 'cs1');
  assert.equal(B.sync.status().opens, 1);
  assert.equal(B.sync.status().link.legacy, false, '新服务端上是会话');
  const callsBefore = B.protocolCalls;
  const changesBefore = B.changes.length;

  // 掐断 B 的传输，并且在 A 改卡落地之前不让它接回来
  proxy.mode = 'reject';
  proxy.cutAll();
  await waitFor(() => B.sync.status().link.detached, 3000, 'B 的会话脱开');
  A.save(USER_KEY, cardSource('v2-while-cut'));
  await A.sync.idle();
  await sleep(150);
  assert.match(B.read(USER_KEY), /v1/, '断开期间 B 还没装');
  assert.equal(B.sync.status().connected, true, '脱开不算断线');

  proxy.mode = 'pass';
  await waitFor(() => /v2-while-cut/.test(B.read(USER_KEY) ?? ''), 5000, 'B 接续后装上 v2');
  await B.sync.idle();
  await sleep(300); // 给可能的重复通知留时间
  const st = B.sync.status();
  console.log(JSON.stringify({ case: 'CS-1', opens: st.opens, resumes: st.resumes, link: st.link, installsRev2: installsOf(B, 2).length, changes: B.changes.length - changesBefore }));
  assert.equal(st.opens, 1, '没有建新会话（onOpen 只调过一次）');
  assert.ok(st.resumes >= 1, '接续过');
  assert.equal(B.protocolCalls, callsBefore, '接续不重取凭证');
  assert.equal(installsOf(B, 2).length, 1, 'v2 恰好装一次');
  assert.equal(B.changes.length - changesBefore, 1, '变更通知恰好一次');
  assert.equal(st.records[USER_KEY].rev, 2);
  assert.ok(!B.logs.includes('cards.sync.close'), '卡片同步没有断线');
});

test('CS-2 写的一方传输断一次：断开期间的保存在会话里补发，服务上版本号只加一，另一方恰好装一次', async (t) => {
  const doc = await startDoc(t);
  const proxy = await createTcpProxy({ target: doc.port });
  t.after(() => proxy.close());
  const A = editor(t, 'a', proxy.port);
  const B = editor(t, 'b', doc.port);
  A.write(USER_KEY, cardSource('v1'));
  A.bind('cs2', [USER_KEY]);
  await waitFor(() => A.sync.status().connected, 3000, 'A 连上');
  await A.sync.idle();
  B.bind('cs2');
  await waitFor(() => /v1/.test(B.read(USER_KEY) ?? ''), 5000, 'B 装上 v1');
  await B.sync.idle();

  proxy.mode = 'reject';
  proxy.cutAll();
  await waitFor(() => A.sync.status().link.detached, 3000, 'A 的会话脱开');
  A.save(USER_KEY, cardSource('v2-saved-while-cut'));
  await sleep(200);
  assert.equal((await peek(doc, USER_KEY)).rev, 1, '断开期间还没到服务上');

  proxy.mode = 'pass';
  await waitFor(async () => (await peek(doc, USER_KEY)).rev === 2, 5000, '接续后补发落地');
  await A.sync.idle();
  await waitFor(() => /v2-saved-while-cut/.test(B.read(USER_KEY) ?? ''), 5000, 'B 装上 v2');
  await B.sync.idle();
  await sleep(300);
  const got = await peek(doc, USER_KEY);
  const st = A.sync.status();
  console.log(JSON.stringify({ case: 'CS-2', serverRev: got.rev, opens: st.opens, resumes: st.resumes, pending: st.pending, bInstallsRev2: installsOf(B, 2).length }));
  assert.equal(got.rev, 2, '只上传了一次');
  assert.equal(st.opens, 1);
  assert.ok(st.resumes >= 1);
  assert.deepEqual(st.pending, [], '待上传清空');
  assert.equal(st.records[USER_KEY].rev, 2);
  assert.equal(installsOf(B, 2).length, 1, 'B 恰好装一次');
  assert.equal(installsOf(A).length, 0, 'A 不装自己的回声');
});

test('CS-3 旧服务端（没有会话层）：端点退化，断一次就是会话结束，重连后对账补上，照样恰好装一次', async (t) => {
  const { proxy, A, B } = await pair(t, 'cs3', {
    front: async (doc) => {
      const f = await startLegacyFront({ upstream: `${doc.url}/` });
      t.after(() => f.close());
      return f;
    },
  });
  assert.equal(B.sync.status().link.legacy, true, '对旧服务端退化');
  const callsBefore = B.protocolCalls;

  proxy.mode = 'reject';
  proxy.cutAll();
  await waitFor(() => B.logs.includes('cards.sync.close'), 3000, 'B 断线（旧服务端上会话随传输结束）');
  A.save(USER_KEY, cardSource('v2-legacy'));
  await A.sync.idle();
  proxy.mode = 'pass';
  await waitFor(() => /v2-legacy/.test(B.read(USER_KEY) ?? ''), 5000, 'B 重连后对账装上 v2');
  await B.sync.idle();
  await sleep(300);
  const st = B.sync.status();
  console.log(JSON.stringify({ case: 'CS-3', opens: st.opens, resumes: st.resumes, link: st.link, installsRev2: installsOf(B, 2).length }));
  assert.equal(st.opens, 2, '重新建了一次（旧行为）');
  assert.equal(st.resumes, 0);
  assert.ok(B.protocolCalls > callsBefore, '重建时重新取凭证');
  assert.equal(installsOf(B, 2).length, 1, 'v2 恰好装一次');
});
