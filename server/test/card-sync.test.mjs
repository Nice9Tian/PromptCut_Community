/**
 * 卡片源码同步(C6.6 设计稿 `docs/plan/c66-design.md` 第 5 节、验收 T8;`cloud-task.md` A6、B2)。
 *
 * 两个「编辑器进程」各有自己的项目根(临时目录),各起一个 `server/card-sync.mjs` 的同步实例,文件操作用
 * `server/vite-plugin-cards.ts` 的真实装卡路径(installSyncedFile:审查、写文件)与备份(backupBeforeEdit),
 * 经真实 WebSocket 连同一个文档服务的内容库(`contentModule`)。「重测、重排预渲染」的触发点就是编辑器里
 * 装卡之后发的卡片源码变更通知(`card-overrides.mjs` 的 emitCardSourceChange,渲染 worker 据此扔掉备用页,
 * 页面据 HMR 提示重排探针),这里装卡适配器照样发,用例盯这条通知。
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
const { createWsEndpoint } = await import('../render-node/ws-transport.mjs');
const { createCardSync, sourceHash, isSyncablePath } = await import('../card-sync.mjs');
const { emitCardSourceChange, onCardSourceChange } = await import('../card-overrides.mjs');
const cards = await import('../vite-plugin-cards.ts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 5000, what = '条件') {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`等 ${what} 超时(${ms} ms)`);
    await sleep(20);
  }
}

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
const USER_KEY = 'src/cards/user/price-tag.tsx';
const BUILTIN_KEY = 'src/cards/native/odo.tsx';
const BUILTIN = `import type { CardDef } from "../../kernel/types";
export const odo: CardDef<{ n: number }> = {
  id: "odo", name: "odo", description: "d", source: "native",
  frameMode: "direct",
  defaults: { n: 1 },
  controls: [],
  Component: () => null,
};
`;

/** 文档服务(内容库一个模块);身份按查询串给:?user=&dev= → page 角色 */
async function startDoc(t) {
  const service = createDocService({
    log: () => {},
    authenticate: (req) => {
      const q = new URL(req.url ?? '/', 'http://localhost').searchParams;
      return { userId: q.get('user') ?? 'u', deviceId: q.get('dev') ?? 'd', role: 'page', tenantId: 't-c66' };
    },
    modules: [contentModule({ store: createMemoryStore() })],
  });
  const { port } = await service.listen(0, '127.0.0.1');
  t.after(() => service.close());
  return { port, url: (user) => `ws://127.0.0.1:${port}/?user=${user}&dev=dev-${user}` };
}

/** 一个「编辑器进程」:自己的项目根、同步实例、收到的通知与变更通知 */
function editor(t, name, { builtin = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pc-c66-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src', 'cards', 'user'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'cards', 'native'), { recursive: true });
  if (builtin) fs.writeFileSync(path.join(root, BUILTIN_KEY), BUILTIN);
  const notices = [];
  const changes = [];
  const off = onCardSourceChange((file) => {
    if (path.resolve(file).startsWith(path.resolve(root) + path.sep)) changes.push({ at: Date.now(), rel: path.relative(root, file).split(path.sep).join('/') });
  });
  t.after(off);
  const edited = new Set();
  const sync = createCardSync({
    stateDir: path.join(root, '.pc-work', 'card-sync'),
    files: {
      read: (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } },
      changed: (rel) => rel.startsWith('src/cards/user/') ? fs.existsSync(path.join(root, rel)) : edited.has(rel),
      backup: (rel, content) => cards.backupBeforeEdit(root, rel, content),
      install: (rel, source) => {
        const r = cards.installSyncedFile({ root, historyDir: path.join(root, '.pc-work', 'card-history'), rel, source, existingIds: ['odo'] });
        // 编辑器里装完照 edit_card 的做法发变更通知(热更新、渲染 worker 扔备用页、页面重排探针)
        if (r.ok && r.abs && r.status !== 'unchanged') emitCardSourceChange(r.abs);
        return { ok: r.ok, error: r.error };
      },
    },
    connect: ({ url, protocols }) => createWsEndpoint({ url, protocols, backoff: { baseMs: 50, maxMs: 200 } }),
    notify: (e) => notices.push(e),
    retryMs: 200,
  });
  t.after(() => sync.close());
  const write = (rel, content) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  };
  return {
    name, root, sync, notices, changes, edited, write,
    read: (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } },
    /** 本机保存一次(edit_card / create_card 落盘后插件调 saved) */
    save(rel, content) {
      write(rel, content);
      if (!rel.startsWith('src/cards/user/')) edited.add(rel);
      return sync.saved(rel);
    },
    bindShared(doc, projectId, keys = []) {
      return sync.bind({ projectId, url: doc.url(name), local: false, keys, protocols: () => ['promptcut.v1'] });
    },
  };
}

/** 另开一条连接直接看内容库 */
async function peek(doc, kind, key) {
  const ws = new WebSocket(doc.url('peek'), ['promptcut.v1']);
  await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
  const reply = await new Promise((resolve) => {
    ws.addEventListener('message', (e) => { const m = JSON.parse(e.data); if (m.reqId === 'p1') resolve(m); });
    ws.send(JSON.stringify(key ? { type: 'content.get', kind, key, reqId: 'p1' } : { type: 'content.list', kind, reqId: 'p1' }));
  });
  ws.close();
  return reply;
}

test('T8-0 范围:只认卡片 / 部件目录下的源码与样式,测试文件、路径穿越不认', () => {
  assert.equal(isSyncablePath(USER_KEY), true);
  assert.equal(isSyncablePath('src/parts/a/b.css'), true);
  assert.equal(isSyncablePath('src/cards/user/_scopes.json'), false);
  assert.equal(isSyncablePath('src/cards/user/x.test.ts'), false);
  assert.equal(isSyncablePath('src/kernel/project.ts'), false);
  assert.equal(isSyncablePath('src/cards/../kernel/x.ts'), false);
  assert.equal(isSyncablePath('src\\cards\\user\\x.tsx'), false);
  // 内容哈希与内容库同一算法,且不因换行风格不同而不同
  assert.equal(sourceHash('a\r\nb'), sourceHash('a\nb'));
});

test('T8-1 A 改了一张用户卡,B 5 s 内装上新版并重测(发变更通知);B 第一次打开就装上 A 带来的卡', async (t) => {
  const doc = await startDoc(t);
  const A = editor(t, 'a');
  const B = editor(t, 'b');
  A.write(USER_KEY, cardSource('¥1'));
  A.bindShared(doc, 'p1', [USER_KEY]);
  await waitFor(() => A.sync.status().connected, 3000, 'A 连上');
  await A.sync.idle();
  const first = await peek(doc, 'card-source', USER_KEY);
  assert.equal(first.rev, 1, 'A 打开共享项目时把项目用到的用户卡传上去');

  // B 打开同一个共享项目:本机没有这张卡 → 装上
  B.bindShared(doc, 'p1');
  await waitFor(() => B.read(USER_KEY) !== null, 5000, 'B 装上 A 的卡');
  assert.match(B.read(USER_KEY), /¥1/);
  await B.sync.idle();
  assert.equal(B.sync.status().records[USER_KEY].rev, 1);

  // A 改卡(edit_card 落盘后 saved) → B 5 s 内装上新版,并发出变更通知(重测、重排预渲染的触发点)
  const changesBefore = B.changes.length;
  const t0 = Date.now();
  A.save(USER_KEY, cardSource('¥2'));
  await waitFor(() => /¥2/.test(B.read(USER_KEY) ?? ''), 5000, 'B 装上新版');
  const installedMs = Date.now() - t0;
  const change = await waitFor(() => B.changes.slice(changesBefore).find((c) => c.rel === USER_KEY), 5000, 'B 的变更通知');
  assert.ok(installedMs <= 5000, `B 装上新版用了 ${installedMs} ms`);
  assert.ok(change.at - t0 <= 5000);
  await B.sync.idle();
  assert.equal(B.sync.status().records[USER_KEY].rev, 2);
  const inst = B.notices.find((n) => n.type === 'installed' && n.rev === 2);
  assert.ok(inst, 'B 有「已装上」的通知');
  assert.equal(inst.backup, undefined, 'B 本机没改过:直接换,不备份');
  assert.equal(inst.actor.userId, 'a', '通知里带写入者');
  assert.equal(B.notices.some((n) => n.type === 'overwritten'), false);
  // A 自己那份不被自己的回声打扰
  assert.equal(A.notices.filter((n) => n.type === 'installed').length, 0);
  console.log(JSON.stringify({ case: 'T8-1', installedMs, changeMs: change.at - t0 }));
});

test('T8-2 两端同时改同一张卡:后写的赢,先写的一方有备份与提示,后写的一方知道自己覆盖了谁', async (t) => {
  const doc = await startDoc(t);
  const A = editor(t, 'a');
  const B = editor(t, 'b');
  A.write(USER_KEY, cardSource('v1'));
  A.bindShared(doc, 'p2', [USER_KEY]);
  await waitFor(() => A.sync.status().connected, 3000, 'A 连上');
  await A.sync.idle();
  B.bindShared(doc, 'p2');
  await waitFor(() => /v1/.test(B.read(USER_KEY) ?? ''), 5000, 'B 同步到 v1');
  await B.sync.idle();

  // 同时改:两边几乎同一时刻落盘、上传
  A.save(USER_KEY, cardSource('from-A'));
  B.save(USER_KEY, cardSource('from-B'));
  await waitFor(async () => {
    const it = await peek(doc, 'card-source', USER_KEY);
    return it.rev === 3;
  }, 5000, '两次上传都落地');
  const final = await peek(doc, 'card-source', USER_KEY);
  const winner = /from-A/.test(final.body) ? A : B;
  const loser = winner === A ? B : A;
  const winText = winner === A ? 'from-A' : 'from-B';
  const loseText = winner === A ? 'from-B' : 'from-A';

  // 两端最后都是后写的那一版
  await waitFor(() => new RegExp(winText).test(loser.read(USER_KEY) ?? ''), 5000, '先写方换成后写的版本');
  await A.sync.idle();
  await B.sync.idle();
  assert.match(winner.read(USER_KEY), new RegExp(winText));
  assert.match(loser.read(USER_KEY), new RegExp(winText));

  // 先写方:覆盖提示 + 备份里是自己那份
  const ow = loser.notices.find((n) => n.type === 'overwritten');
  assert.ok(ow, `先写方(${loser.name})有覆盖提示;通知:${JSON.stringify(loser.notices)}`);
  assert.equal(ow.actor.userId, winner.name, '提示里是覆盖方');
  assert.ok(ow.backup && fs.existsSync(path.join(loser.root, ow.backup)), '备份文件在');
  assert.match(fs.readFileSync(path.join(loser.root, ow.backup), 'utf8'), new RegExp(loseText), '备份里是先写方自己那份');
  // 后写方:没被覆盖,知道自己覆盖了谁
  assert.equal(winner.notices.some((n) => n.type === 'overwritten'), false);
  const wrote = await waitFor(() => winner.notices.find((n) => n.type === 'overwrote' && n.rev === 3), 3000, '覆盖方的回执');
  assert.equal(wrote.previousActor.userId, loser.name);
  console.log(JSON.stringify({ case: 'T8-2', winner: winner.name, backup: ow.backup }));
});

test('T8-3 未改的内置卡不同步;改过的内置卡与用户卡同步', async (t) => {
  const doc = await startDoc(t);
  const A = editor(t, 'a');
  const B = editor(t, 'b');
  A.write(USER_KEY, cardSource('¥1'));
  // 项目用到一张内置卡(没改过)和一张用户卡:要带上的只有用户卡
  const changed = (rel) => rel.startsWith('src/cards/user/') ? fs.existsSync(path.join(A.root, rel)) : A.edited.has(rel);
  const keys = cards.cardSyncKeys(A.root, ['odo', 'price-tag', 'no-such-card'], changed);
  assert.deepEqual(keys, [USER_KEY]);
  A.bindShared(doc, 'p3', keys);
  B.bindShared(doc, 'p3', cards.cardSyncKeys(B.root, ['odo'], (rel) => rel.startsWith('src/cards/user/')));
  await waitFor(() => A.sync.status().connected && B.sync.status().connected, 3000, '连上');
  await A.sync.idle();
  await B.sync.idle();
  let listing = await peek(doc, 'card-source');
  assert.deepEqual(listing.items.map((i) => i.key), [USER_KEY], '内容库里只有用户卡,两端都没传未改的内置卡');

  // A 改了内置卡(edit_card 改内置文件)→ 同步;B 本机的是未改的底版,直接换,不备份不提示
  const edited = BUILTIN.replace('n: 1', 'n: 2');
  A.save(BUILTIN_KEY, edited);
  await waitFor(() => /n: 2/.test(B.read(BUILTIN_KEY) ?? ''), 5000, 'B 装上改过的内置卡');
  await B.sync.idle();
  listing = await peek(doc, 'card-source');
  assert.deepEqual(listing.items.map((i) => i.key).sort(), [BUILTIN_KEY, USER_KEY].sort());
  assert.equal(B.notices.some((n) => n.type === 'overwritten'), false);
  assert.equal(fs.existsSync(path.join(B.root, 'out', 'card-edits')), false, '未改的底版不算本机的改动,不备份');
  // 改过之后它就算「改过的内置卡」:再算一次要带上的文件,它在里面
  assert.deepEqual(cards.cardSyncKeys(A.root, ['odo', 'price-tag'], changed), [BUILTIN_KEY, USER_KEY].sort());
});

test('T8-4 本机项目(local 空间):只上传,cardRev 照常自增;同步那一半是空操作', async (t) => {
  const doc = await startDoc(t);
  const A = editor(t, 'a');
  A.write(USER_KEY, cardSource('¥1'));
  A.sync.bind({ local: true, url: doc.url('a'), protocols: () => ['promptcut.v1'] });
  await waitFor(() => A.sync.status().connected, 3000, '连上');
  A.save(USER_KEY, cardSource('¥2'));
  await A.sync.idle();
  A.save(USER_KEY, cardSource('¥3'));
  await A.sync.idle();
  const it = await peek(doc, 'card-source', USER_KEY);
  assert.equal(it.rev, 2, '每次保存 cardRev 加一');
  assert.match(it.body, /¥3/);
  assert.equal(A.sync.status().records[USER_KEY].rev, 2);
  assert.equal(A.sync.status().spaceId, 'local');

  // 别人往这个空间写了一版:本机项目不装(不订阅、不对账)
  const ws = new WebSocket(doc.url('other'), ['promptcut.v1']);
  await new Promise((r) => ws.addEventListener('open', r));
  ws.send(JSON.stringify({ type: 'content.put', kind: 'card-source', key: USER_KEY, body: cardSource('¥9'), reqId: 'x' }));
  await sleep(300);
  ws.close();
  assert.match(A.read(USER_KEY), /¥3/);
  assert.equal(A.notices.length, 0);
});

test('T8-5 断线期间的保存留在待上传里,重连后补传;本机在同步之后又改过而服务没变,打开时传上去', async (t) => {
  const doc = await startDoc(t);
  const A = editor(t, 'a');
  // 还没连上就保存:记成待上传
  A.write(USER_KEY, cardSource('¥1'));
  A.bindShared(doc, 'p5', []);
  A.save(USER_KEY, cardSource('offline'));
  await waitFor(() => A.sync.status().connected, 3000, '连上');
  await A.sync.idle();
  let it = await peek(doc, 'card-source', USER_KEY);
  assert.match(it.body, /offline/);
  assert.deepEqual(A.sync.status().pending, []);

  // 不经 saved 直接改了文件(比如编辑器没开着的时候):下次打开这个共享项目时,对账发现本机改过、服务没变 → 传上去
  A.sync.unbind();
  A.write(USER_KEY, cardSource('edited-while-away'));
  A.bindShared(doc, 'p5', []);
  await waitFor(async () => /edited-while-away/.test((await peek(doc, 'card-source', USER_KEY)).body), 5000, '补传');
  it = await peek(doc, 'card-source', USER_KEY);
  assert.equal(it.rev, 2);
});

test('T8-6 装不上的版本(审查不过)不装,本机原样,给提示;同一版不反复重试', async (t) => {
  const doc = await startDoc(t);
  const A = editor(t, 'a');
  const B = editor(t, 'b');
  A.write(USER_KEY, cardSource('ok'));
  A.bindShared(doc, 'p6', [USER_KEY]);
  B.bindShared(doc, 'p6');
  await waitFor(() => /ok/.test(B.read(USER_KEY) ?? ''), 5000, 'B 装上');
  await B.sync.idle();
  // A 把卡改坏(id 变了:用户卡的审查不收)
  A.save(USER_KEY, cardSource('bad').replace('id: "price-tag"', 'id: "other-id"'));
  const rej = await waitFor(() => B.notices.find((n) => n.type === 'rejected'), 5000, 'B 的拒绝提示');
  assert.ok(rej.error);
  assert.match(B.read(USER_KEY), /ok/, 'B 本机原样');
  await B.sync.idle();
  assert.equal(B.sync.status().records[USER_KEY].rejected, true);
});

test('T8-7 本机写过的那一版被别人随后改掉(不是同时改):装别人的新版前也先备份本机那份并提示;本机从没写过的直接装', async (t) => {
  const doc = await startDoc(t);
  const A = editor(t, 'a');
  const B = editor(t, 'b');
  const C = editor(t, 'c');
  A.write(USER_KEY, cardSource('v1'));
  A.bindShared(doc, 'p7', [USER_KEY]);
  await waitFor(() => A.sync.status().connected, 3000, 'A 连上');
  await A.sync.idle();
  B.bindShared(doc, 'p7');
  C.bindShared(doc, 'p7');
  await waitFor(() => /v1/.test(B.read(USER_KEY) ?? '') && /v1/.test(C.read(USER_KEY) ?? ''), 5000, 'B、C 同步到 v1');
  await B.sync.idle();
  await C.sync.idle();

  // A 写 v2,等 B、C 都装上(先后分明,不是同时改)
  A.save(USER_KEY, cardSource('v2-from-A'));
  await waitFor(() => /v2-from-A/.test(B.read(USER_KEY) ?? '') && /v2-from-A/.test(C.read(USER_KEY) ?? ''), 5000, 'B、C 装上 v2');
  await B.sync.idle();
  await C.sync.idle();
  assert.equal(A.sync.status().records[USER_KEY].mine, true);

  // B 接着改成 v3:最后一次写入者是 A 的那一版被覆盖 → A 先备份 v2-from-A 再装 v3,并提示;C 从没写过这张卡,直接装
  B.save(USER_KEY, cardSource('v3-from-B'));
  await waitFor(() => /v3-from-B/.test(A.read(USER_KEY) ?? '') && /v3-from-B/.test(C.read(USER_KEY) ?? ''), 5000, 'A、C 装上 v3');
  await A.sync.idle();
  await C.sync.idle();
  const ow = A.notices.find((n) => n.type === 'overwritten');
  assert.ok(ow, `A 有覆盖提示;通知:${JSON.stringify(A.notices)}`);
  assert.equal(ow.actor.userId, 'b');
  assert.match(fs.readFileSync(path.join(A.root, ow.backup), 'utf8'), /v2-from-A/, '备份里是 A 写过的那一版');
  assert.equal(C.notices.some((n) => n.type === 'overwritten'), false, 'C 从没写过:直接装,不提示');
  assert.equal(fs.existsSync(path.join(C.root, 'out', 'card-edits')), false, 'C 不备份');
  // A 这时手上是 B 的版本(不再是自己写的):再被 C 改掉就直接装
  assert.equal(A.sync.status().records[USER_KEY].mine, false);
  const before = A.notices.length;
  C.save(USER_KEY, cardSource('v4-from-C'));
  await waitFor(() => /v4-from-C/.test(A.read(USER_KEY) ?? ''), 5000, 'A 装上 v4');
  await A.sync.idle();
  assert.equal(A.notices.slice(before).some((n) => n.type === 'overwritten'), false);
  // B 的 v3 被 C 覆盖 → B 备份并提示
  await waitFor(() => B.notices.find((n) => n.type === 'overwritten'), 5000, 'B 的覆盖提示');
});

test('T8-8 断网期间改过、云端也被别人改过的卡:不按最后写的赢,发 conflict(带两份源码)交给冲突合并;「合并」照我这边写回、传上去', async (t) => {
  const doc = await startDoc(t);
  const A = editor(t, 'a');
  const B = editor(t, 'b');
  A.write(USER_KEY, cardSource('v1'));
  A.bindShared(doc, 'p8', [USER_KEY]);
  await waitFor(() => A.sync.status().connected, 3000, 'A 连上');
  await A.sync.idle();
  B.bindShared(doc, 'p8');
  await waitFor(() => /v1/.test(B.read(USER_KEY) ?? ''), 5000, 'B 同步到 v1');
  await B.sync.idle();
  // A 断开期间改了这张卡;B 同时在线改了它
  A.sync.unbind('offline');
  A.write(USER_KEY, cardSource('A-offline'));
  B.save(USER_KEY, cardSource('B-online'));
  await waitFor(async () => /B-online/.test((await peek(doc, 'card-source', USER_KEY)).body), 5000, 'B 的版本落地');
  // A 连回
  A.bindShared(doc, 'p8', [USER_KEY]);
  const c = await waitFor(() => A.notices.find((n) => n.type === 'conflict'), 5000, 'A 收到 conflict');
  await A.sync.idle();
  assert.equal(c.key, USER_KEY);
  assert.match(c.mine, /A-offline/, '带我这边的源码');
  assert.match(c.cloud, /B-online/, '带云端的源码');
  assert.ok(c.backup && fs.existsSync(path.join(A.root, c.backup)), '本机那份另有备份');
  assert.equal(A.notices.some((n) => n.type === 'overwritten'), false, '不再按最后写的赢说「被覆盖」');
  assert.match(A.read(USER_KEY), /B-online/, '本机先换成云端的版本(我的在冲突合并里)');
  assert.match((await peek(doc, 'card-source', USER_KEY)).body, /B-online/, '我的没被悄悄传上去');
  // 「合并」:照我这边写回、传上去,B 装上
  const r = await A.sync.takeMine(USER_KEY, c.mine);
  assert.equal(r.ok, true, JSON.stringify(r));
  await waitFor(async () => /A-offline/.test((await peek(doc, 'card-source', USER_KEY)).body), 5000, '我的版本传上去');
  await waitFor(() => /A-offline/.test(B.read(USER_KEY) ?? ''), 5000, 'B 装上我的版本');
  // 审查不过的源码:不写、不传
  const bad = await A.sync.takeMine(USER_KEY, 'not a card');
  assert.equal(bad.ok, false);
  // 「删除选中」= 什么都不做:云端现状保留(上面已核过)
});
