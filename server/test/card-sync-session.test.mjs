/**
 * Card source sync goes through the session layer (M8 plan D9 / L14; HT-a contract
 * `docs/plan/http-transport-contract.md` Section 9, Section 17.1 item 3;
 * semantics `docs/semantics/product/document-service.md` "Session and transport").
 *
 * The default connection in `server/card-sync.mjs` is `createDocEndpoint` (session). Here, a
 * controllable TCP proxy (`createTcpProxy` in `fake-ws-kit.mjs`) severs transport on one side to
 * verify:
 *   CS-1 The reading side has transport severed once: session resumes after detach (does not create
 *        a new session, does not resubscribe, does not re-reconcile); card edit notifications from
 *        others during disconnection catch up after resume, installing the card exactly once;
 *   CS-2 The writing side has transport severed once: saves (`content.put`) during disconnection
 *        stay in the session and are resent after resume; version number on service increments only
 *        by one, and the other side installs exactly once;
 *   CS-3 Legacy server (no session layer, `startLegacyFront` in `session-gateway-kit.mjs`): endpoint
 *        degrades, disconnecting once ends the session; after reconnection, catches up via
 *        reconciliation and still installs exactly once.
 * File operations on both ends use the same set as `card-sync.test.mjs` (real card installation
 * path `installSyncedFile`, backup `backupBeforeEdit`).
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

async function waitFor(fn, ms = 5000, what = 'condition') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`Timed out waiting for ${what} (${ms} ms)`);
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
  id: "price-tag", name: "Price", description: "d", source: "user",
  frameMode: "stateful",
  defaults: { text: "${text}" },
  controls: [{ key: "text", label: "Text", type: "text" }],
  Component: C,
};
`;

/** Document service (a content store module, with session layer); identity given via query string */
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

/** An "editor process"; `port` is its connected port (direct to document service, or via proxy) */
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
    // Same endpoint as default (createDocEndpoint), only with shorter backoff; uses module default
    // connection on defaultConnect
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

/** A connects directly, B via proxy; A enters the shared project with v1, B installs v1 */
async function pair(t, projectId, { front = null } = {}) {
  const doc = await startDoc(t);
  const target = front ? (await front(doc)).port : doc.port;
  const proxy = await createTcpProxy({ target });
  t.after(() => proxy.close());
  const A = editor(t, 'a', doc.port);
  const B = editor(t, 'b', proxy.port);
  A.write(USER_KEY, cardSource('v1'));
  A.bind(projectId, [USER_KEY]);
  await waitFor(() => A.sync.status().connected, 3000, 'A connected');
  await A.sync.idle();
  B.bind(projectId);
  await waitFor(() => /v1/.test(B.read(USER_KEY) ?? ''), 5000, 'B installs v1');
  await B.sync.idle();
  return { doc, proxy, A, B };
}

test('CS-0 the default connection is a session: connect is not injected; after one transport drop it resumes, which is not counted as a disconnect and is not rebuilt', async (t) => {
  const doc = await startDoc(t);
  const proxy = await createTcpProxy({ target: doc.port });
  t.after(() => proxy.close());
  const A = editor(t, 'a', proxy.port, { defaultConnect: true });
  A.write(USER_KEY, cardSource('v1'));
  A.bind('cs0', [USER_KEY]);
  await waitFor(() => A.sync.status().connected, 3000, 'A connected');
  await A.sync.idle();
  proxy.cutAll();
  await waitFor(() => A.sync.status().resumes === 1, 5000, 'resumed');
  const st = A.sync.status();
  console.log(JSON.stringify({ case: 'CS-0', opens: st.opens, resumes: st.resumes, link: st.link }));
  assert.equal(st.opens, 1);
  assert.equal(st.link.legacy, false);
  assert.ok(A.logs.includes('doc.session.detach') && A.logs.includes('doc.session.resume'), 'endpoint logs are forwarded into the sync log with the doc. prefix');
  assert.ok(!A.logs.includes('cards.sync.close'));
});

test('CS-1 the transport of the viewing side drops once: the session resumes, card-change notifications from the drop period are caught up, the card is installed exactly once, and the session is neither rebuilt nor reconciled again', async (t) => {
  const { proxy, A, B } = await pair(t, 'cs1');
  assert.equal(B.sync.status().opens, 1);
  assert.equal(B.sync.status().link.legacy, false, 'it is a session on the new server');
  const callsBefore = B.protocolCalls;
  const changesBefore = B.changes.length;

  // Sever B's transport, and do not let it reconnect until A's card edit is persisted
  proxy.mode = 'reject';
  proxy.cutAll();
  await waitFor(() => B.sync.status().link.detached, 3000, 'the session of B is detached');
  A.save(USER_KEY, cardSource('v2-while-cut'));
  await A.sync.idle();
  await sleep(150);
  assert.match(B.read(USER_KEY), /v1/, 'B has not installed it during the drop');
  assert.equal(B.sync.status().connected, true, 'detaching is not counted as a disconnect');

  proxy.mode = 'pass';
  await waitFor(() => /v2-while-cut/.test(B.read(USER_KEY) ?? ''), 5000, 'B installs v2 after resuming');
  await B.sync.idle();
  await sleep(300); // Leave time for possible duplicate notifications
  const st = B.sync.status();
  console.log(JSON.stringify({ case: 'CS-1', opens: st.opens, resumes: st.resumes, link: st.link, installsRev2: installsOf(B, 2).length, changes: B.changes.length - changesBefore }));
  assert.equal(st.opens, 1, 'no new session was created (onOpen was called only once)');
  assert.ok(st.resumes >= 1, 'has resumed');
  assert.equal(B.protocolCalls, callsBefore, 'resuming does not re-fetch credentials');
  assert.equal(installsOf(B, 2).length, 1, 'v2 is installed exactly once');
  assert.equal(B.changes.length - changesBefore, 1, 'exactly one change notification');
  assert.equal(st.records[USER_KEY].rev, 2);
  assert.ok(!B.logs.includes('cards.sync.close'), 'card sync did not disconnect');
});

test('CS-2 the transport of the writing side drops once: saves made during the drop are re-sent within the session, the version number on the service increases by only one, and the other side installs exactly once', async (t) => {
  const doc = await startDoc(t);
  const proxy = await createTcpProxy({ target: doc.port });
  t.after(() => proxy.close());
  const A = editor(t, 'a', proxy.port);
  const B = editor(t, 'b', doc.port);
  A.write(USER_KEY, cardSource('v1'));
  A.bind('cs2', [USER_KEY]);
  await waitFor(() => A.sync.status().connected, 3000, 'A connected');
  await A.sync.idle();
  B.bind('cs2');
  await waitFor(() => /v1/.test(B.read(USER_KEY) ?? ''), 5000, 'B installs v1');
  await B.sync.idle();

  proxy.mode = 'reject';
  proxy.cutAll();
  await waitFor(() => A.sync.status().link.detached, 3000, 'the session of A is detached');
  A.save(USER_KEY, cardSource('v2-saved-while-cut'));
  await sleep(200);
  assert.equal((await peek(doc, USER_KEY)).rev, 1, 'not yet on the service during the drop');

  proxy.mode = 'pass';
  await waitFor(async () => (await peek(doc, USER_KEY)).rev === 2, 5000, 'the re-sent save lands after resuming');
  await A.sync.idle();
  await waitFor(() => /v2-saved-while-cut/.test(B.read(USER_KEY) ?? ''), 5000, 'B installs v2');
  await B.sync.idle();
  await sleep(300);
  const got = await peek(doc, USER_KEY);
  const st = A.sync.status();
  console.log(JSON.stringify({ case: 'CS-2', serverRev: got.rev, opens: st.opens, resumes: st.resumes, pending: st.pending, bInstallsRev2: installsOf(B, 2).length }));
  assert.equal(got.rev, 2, 'uploaded only once');
  assert.equal(st.opens, 1);
  assert.ok(st.resumes >= 1);
  assert.deepEqual(st.pending, [], 'pending uploads cleared');
  assert.equal(st.records[USER_KEY].rev, 2);
  assert.equal(installsOf(B, 2).length, 1, 'B installs exactly once');
  assert.equal(installsOf(A).length, 0, 'A does not install its own echo');
});

test('CS-3 old server (no session layer): the endpoint degrades, one drop ends the session, reconciliation catches up after reconnecting, and it still installs exactly once', async (t) => {
  const { proxy, A, B } = await pair(t, 'cs3', {
    front: async (doc) => {
      const f = await startLegacyFront({ upstream: `${doc.url}/` });
      t.after(() => f.close());
      return f;
    },
  });
  assert.equal(B.sync.status().link.legacy, true, 'degrades against the old server');
  const callsBefore = B.protocolCalls;

  proxy.mode = 'reject';
  proxy.cutAll();
  await waitFor(() => B.logs.includes('cards.sync.close'), 3000, 'B disconnects (on the old server the session ends with the transport)');
  A.save(USER_KEY, cardSource('v2-legacy'));
  await A.sync.idle();
  proxy.mode = 'pass';
  await waitFor(() => /v2-legacy/.test(B.read(USER_KEY) ?? ''), 5000, 'B reconciles and installs v2 after reconnecting');
  await B.sync.idle();
  await sleep(300);
  const st = B.sync.status();
  console.log(JSON.stringify({ case: 'CS-3', opens: st.opens, resumes: st.resumes, link: st.link, installsRev2: installsOf(B, 2).length }));
  assert.equal(st.opens, 2, 'recreated once (old behavior)');
  assert.equal(st.resumes, 0);
  assert.ok(B.protocolCalls > callsBefore, 'credentials are re-fetched on recreation');
  assert.equal(installsOf(B, 2).length, 1, 'v2 is installed exactly once');
});
