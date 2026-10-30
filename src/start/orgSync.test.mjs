/**
 * 云端分组的同步引擎(`src/start/orgSync.ts`)。跑:npm test -- src/start/orgSync.test.mjs
 * 网络、存储、计时器都是注入的:这里用一个内存里的假云端(语义和 `cloud/docservice/modules/account-org.mjs` 一样:
 * 版本号比较并替换,冲突带回云端当前那份)和一个手动拨的计时器。
 *
 *   SYNC-01 第一次连上:云端什么都没存过、本机已有内容 → 整份传上去
 *   SYNC-02 云端比本机新、本机没有没传的改动 → 直接采用云端的
 *   SYNC-03 改动先防抖再传;连着几次改只传一次;计时器没到不传
 *   SYNC-04 另一台设备先写了:先拉到、三方合并后一次传上去,两边的改动都在
 *   SYNC-04b 拉和传之间另一台设备又写了(409):带回来的那份三方合并、重传,两边的改动都在
 *   SYNC-05 离线:标待同步、改动留在本机、间隔逐次加倍;联网后补上
 *   SYNC-06 老服务端(没有这条路由):不报错、不重试、改动留本机;之后支持了再 refresh 就补上
 *   SYNC-07 传的过程中又有新改动:传完仍标待同步并再传一次
 *   SYNC-08 云端比本机记的版本还旧(云端被重置):以云端为出发点,把本机整份再传上去
 *   SYNC-10 两台设备各自在存储接上之前做过分组、第一次连云端:取并集,谁的都不丢
 *   SYNC-11 同步记录坏了读出来当没记过;存下去读回来一致
 *   SYNC-12 服务端限流(429 带 Retry-After):标待同步、改动留着、不早于它说的时间再试,不报错
 *   SYNC-09 stop 之后不再排任务、不再回调
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { OrgUnsupportedError, createOrgSync, parseSyncMeta, syncMetaKey } from './orgSync.ts';
import { emptyOrg } from './vibeOrg.ts';

const org = (o = {}) => ({ v: 1, realm: 'cloud', groups: [], projects: [], chats: [], ...o });
const tick = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
const names = (o) => o.groups.map((g) => g.name);

/** 内存里的假云端:和服务端同一套规矩 */
function fakeServer() {
  const s = { version: 0, org: null, puts: 0, gets: 0, down: false, unsupported: false };
  const guard = () => {
    if (s.unsupported) throw new OrgUnsupportedError();
    if (s.down) throw new Error('network');
  };
  s.transport = {
    async get() { s.gets++; guard(); return { version: s.version, org: s.org }; },
    async put(baseVersion, o) {
      s.puts++; guard();
      if (baseVersion !== s.version) return { conflict: true, version: s.version, org: s.org };
      s.version += 1; s.org = structuredClone(o);
      return { conflict: false, version: s.version, org: s.org };
    },
  };
  return s;
}

function harness({ server = fakeServer(), local = emptyOrg('cloud'), meta = null, transport = null, ...rest } = {}) {
  const state = { org: local, meta, statuses: [], applied: 0 };
  const timers = [];
  const schedule = (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return () => { t.live = false; }; };
  const sync = createOrgSync({
    transport: transport ?? server.transport,
    getOrg: () => state.org,
    applyOrg: (o) => { state.org = o; state.applied++; },
    loadMeta: () => state.meta,
    saveMeta: (m) => { state.meta = m; },
    onStatus: (s) => state.statuses.push(s),
    schedule,
    ...rest,
  });
  /** 本地改动:界面换新的、再通知引擎(和 useCloudOrg 里 setOrg 做的一样) */
  const edit = (next) => { state.org = next; sync.changed(); };
  const live = () => timers.filter((t) => t.live);
  const fire = async () => { const t = live()[0]; assert.ok(t, '该有一个排着的任务'); t.live = false; t.fn(); await tick(); return t.ms; };
  return { server, state, sync, timers, live, fire, edit };
}

test('SYNC-01 第一次连上:云端什么都没存过、本机已有内容 → 整份传上去', async () => {
  const local = org({ groups: [{ id: 'g1', name: '云端存储接上之前做的' }] });
  const h = harness({ local });
  await h.sync.refresh();
  assert.equal(h.server.puts, 1);
  assert.deepEqual(h.server.org, local);
  assert.deepEqual([h.state.meta.version, h.state.meta.dirty], [1, false]);
  assert.equal(h.sync.status(), 'synced');
  // 本机什么都没有、云端也没有:什么都不传
  const h2 = harness();
  await h2.sync.refresh();
  assert.equal(h2.server.puts, 0);
  assert.equal(h2.sync.status(), 'synced');
});

test('SYNC-02 云端比本机新、本机没有没传的改动 → 直接采用云端的(换设备能看到)', async () => {
  const server = fakeServer();
  server.version = 3;
  server.org = org({ groups: [{ id: 'g-cloud', name: '另一台设备建的' }] });
  const h = harness({ server });
  await h.sync.refresh();
  assert.deepEqual(names(h.state.org), ['另一台设备建的']);
  assert.equal(h.server.puts, 0, '没有改动,不传');
  assert.deepEqual([h.state.meta.version, h.state.meta.dirty], [3, false]);
  assert.equal(h.sync.status(), 'synced');
  // 再拉一次、云端没变:不重复应用
  const applied = h.state.applied;
  await h.sync.refresh();
  assert.equal(h.state.applied, applied);
});

test('SYNC-03 改动先防抖再传;连着几次改只传一次;计时器没到不传', async () => {
  const h = harness();
  await h.sync.refresh();
  h.edit(org({ groups: [{ id: 'a', name: '一' }] }));
  h.edit(org({ groups: [{ id: 'a', name: '一' }, { id: 'b', name: '二' }] }));
  h.edit(org({ groups: [{ id: 'a', name: '一' }, { id: 'b', name: '二' }, { id: 'c', name: '三' }] }));
  await tick();
  assert.equal(h.server.puts, 0, '防抖期间不传');
  assert.equal(h.live().length, 1, '只排着一个任务');
  assert.equal(h.live()[0].ms, 1000);
  assert.equal(h.state.meta.dirty, true, '改动一发生就记下「有没传的」(存在本机,关页面也不丢)');
  assert.equal(h.sync.status(), 'pending');
  await h.fire();
  assert.equal(h.server.puts, 1);
  assert.deepEqual(names(h.server.org), ['一', '二', '三']);
  assert.equal(h.sync.status(), 'synced');
  assert.equal(h.state.meta.dirty, false);
});

test('SYNC-04 冲突:另一台设备先写了 → 三方合并、重传,两边的改动都在', async () => {
  const server = fakeServer();
  const base = org({ groups: [{ id: 'g1', name: '原有' }], projects: [{ id: 'p1', groupId: null }] });
  server.version = 1; server.org = base;
  const h = harness({ server });
  await h.sync.refresh(); // 采用 base,版本 1
  // 另一台设备改了:加分组 gT、把 p1 置顶 → 云端版本 2
  server.version = 2;
  server.org = org({ groups: [{ id: 'g1', name: '原有' }, { id: 'gT', name: '另一台加的' }], projects: [{ id: 'p1', groupId: null, pinned: true }] });
  // 这台设备在不知情时:加分组 gM、给 g1 改名
  h.edit(org({ groups: [{ id: 'g1', name: '我改的名' }, { id: 'gM', name: '这台加的' }], projects: [{ id: 'p1', groupId: null }] }));
  await h.fire();
  assert.equal(h.server.puts, 1, '传之前先拉到了云端的新版本,合并后一次就成');
  assert.equal(h.server.version, 3);
  assert.deepEqual(h.server.org.groups.map((g) => g.id).sort(), ['g1', 'gM', 'gT']);
  assert.equal(h.server.org.groups.find((g) => g.id === 'g1').name, '我改的名');
  assert.equal(h.server.org.projects[0].pinned, true, '对方的置顶也在');
  assert.deepEqual(h.state.org, h.server.org, '界面上的就是合并后的');
  assert.deepEqual([h.state.meta.version, h.state.meta.dirty], [3, false]);
  assert.equal(h.sync.status(), 'synced');
});

test('SYNC-04b 拉和传之间另一台设备又写了(409):带回来的那份三方合并、重传,两边的改动都在', async () => {
  const server = fakeServer();
  const base = org({ groups: [{ id: 'g1', name: '原有' }] });
  server.version = 1; server.org = base;
  let raced = false;
  const racing = {
    get: server.transport.get,
    async put(v, o) {
      if (!raced) { // 这台设备的 get 之后、put 之前,另一台设备写了
        raced = true;
        server.version = 2;
        server.org = org({ groups: [{ id: 'g1', name: '原有' }, { id: 'gT', name: '另一台加的' }] });
      }
      return server.transport.put(v, o);
    },
  };
  const h = harness({ server, transport: racing });
  await h.sync.refresh();
  h.edit(org({ groups: [{ id: 'g1', name: '原有' }, { id: 'gM', name: '这台加的' }] }));
  await h.fire();
  assert.equal(server.puts, 2, '第一次 409,合并后第二次成');
  assert.deepEqual(server.org.groups.map((g) => g.id).sort(), ['g1', 'gM', 'gT']);
  assert.deepEqual(h.state.org, server.org);
  assert.equal(h.state.meta.version, 3);
  assert.equal(h.sync.status(), 'synced');
});

test('SYNC-05 离线:标待同步、改动留在本机、间隔逐次加倍;联网后补上', async () => {
  const h = harness();
  await h.sync.refresh();
  h.server.down = true;
  h.edit(org({ groups: [{ id: 'a', name: '离线时建的' }] }));
  await h.fire(); // 防抖到了,传不出去
  assert.equal(h.sync.status(), 'pending');
  assert.equal(h.state.meta.dirty, true);
  assert.deepEqual(names(h.state.org), ['离线时建的'], '本机的改动还在');
  assert.equal(h.live()[0].ms, 2000);
  await h.fire(); // 又失败
  assert.equal(h.live()[0].ms, 4000, '间隔加倍');
  await h.fire();
  assert.equal(h.live()[0].ms, 8000);
  h.server.down = false;
  await h.fire();
  assert.equal(h.sync.status(), 'synced');
  assert.deepEqual(names(h.server.org), ['离线时建的']);
  assert.equal(h.state.meta.dirty, false);
  assert.equal(h.live().length, 0, '补上之后不再排任务');
  // 重启(换一个引擎、读回本机记录):没传的改动还在、联网后仍能补上
  const server = fakeServer();
  const local = org({ groups: [{ id: 'z', name: '关页面前没传出去的' }] });
  const h2 = harness({ server, local, meta: { version: 0, base: null, dirty: true } });
  await h2.sync.refresh();
  assert.deepEqual(names(server.org), ['关页面前没传出去的']);
});

test('SYNC-06 老服务端(没有这条路由):不报错、不重试、改动留本机;之后支持了再 refresh 就补上', async () => {
  const server = fakeServer();
  server.unsupported = true;
  const h = harness({ server });
  await h.sync.refresh();
  assert.equal(h.sync.status(), 'unsupported');
  assert.equal(h.live().length, 0, '不重试');
  h.edit(org({ groups: [{ id: 'a', name: '只在本机' }] }));
  await tick();
  assert.equal(h.live().length, 0, '改动也不排传输');
  assert.equal(h.state.meta.dirty, true);
  assert.deepEqual(names(h.state.org), ['只在本机']);
  assert.equal(server.puts, 0);
  // 服务端升级了:下次打开页面(refresh)就补上
  server.unsupported = false;
  await h.sync.refresh();
  assert.equal(h.sync.status(), 'synced');
  assert.deepEqual(names(server.org), ['只在本机']);
});

test('SYNC-07 传的过程中又有新改动:传完仍标待同步并再传一次', async () => {
  const server = fakeServer();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slow = { get: server.transport.get, async put(v, o) { await gate; return server.transport.put(v, o); } };
  const h = harness({ server, transport: slow });
  await h.sync.refresh();
  h.edit(org({ groups: [{ id: 'a', name: '第一笔' }] }));
  const firing = h.fire(); // 防抖到了,put 卡在 gate 上
  await tick();
  h.edit(org({ groups: [{ id: 'a', name: '第一笔' }, { id: 'b', name: '传的时候又改的' }] }));
  release();
  await firing;
  assert.equal(h.state.meta.dirty, true, '第二笔还没传出去');
  assert.equal(h.live().length, 1);
  await h.fire();
  assert.deepEqual(names(server.org), ['第一笔', '传的时候又改的']);
  assert.equal(h.state.meta.dirty, false);
  assert.equal(h.sync.status(), 'synced');
});

test('SYNC-08 云端比本机记的版本还旧(云端被重置):以云端为出发点,把本机整份再传上去', async () => {
  const server = fakeServer(); // 版本 0
  const local = org({ groups: [{ id: 'g', name: '本机留着的' }] });
  const h = harness({ server, local, meta: { version: 7, base: local, dirty: false } });
  await h.sync.refresh();
  assert.equal(server.version, 1);
  assert.deepEqual(names(server.org), ['本机留着的']);
  assert.equal(h.sync.status(), 'synced');
});

test('SYNC-09 stop 之后不再排任务、不再回调', async () => {
  const h = harness();
  await h.sync.refresh();
  const seen = h.state.statuses.length;
  h.edit(org({ groups: [{ id: 'a', name: 'x' }] }));
  h.sync.stop();
  assert.equal(h.live().length, 0, '排着的任务被取消');
  h.edit(org({ groups: [{ id: 'a', name: 'y' }] }));
  assert.equal(h.live().length, 0);
  assert.ok(h.state.statuses.length <= seen + 1);
});

test('SYNC-10 两台设备各自在存储接上之前做过分组、第一次连云端:取并集,谁的都不丢', async () => {
  const server = fakeServer();
  const d1 = harness({ server, local: org({ groups: [{ id: 'g1', name: '设备一的' }] }) });
  await d1.sync.refresh(); // 设备一先连:整份传上去
  const d2 = harness({ server, local: org({ groups: [{ id: 'g2', name: '设备二的' }] }) }); // 设备二第一次连,云端已有设备一的
  await d2.sync.refresh();
  assert.deepEqual(server.org.groups.map((g) => g.id).sort(), ['g1', 'g2']);
  assert.deepEqual(d2.state.org.groups.map((g) => g.id).sort(), ['g1', 'g2']);
  // 设备二本机什么都没有:直接采用云端的,不多传
  const puts = server.puts;
  const d3 = harness({ server });
  await d3.sync.refresh();
  assert.equal(server.puts, puts);
  assert.deepEqual(d3.state.org.groups.map((g) => g.id).sort(), ['g1', 'g2']);
});

test('SYNC-11 同步记录坏了读出来当没记过;存下去读回来一致', () => {
  assert.equal(parseSyncMeta(null), null);
  assert.equal(parseSyncMeta('{not json'), null);
  assert.equal(parseSyncMeta(JSON.stringify({ version: -1, dirty: true })), null);
  assert.equal(parseSyncMeta(JSON.stringify({ version: 'x' })), null);
  const base = org({ groups: [{ id: 'g', name: 'x' }] });
  assert.deepEqual(parseSyncMeta(JSON.stringify({ version: 4, base, dirty: true })), { version: 4, base, dirty: true });
  assert.deepEqual(parseSyncMeta(JSON.stringify({ version: 2 })), { version: 2, base: null, dirty: false });
  // base 标着 local 的当成不认(不会把本地那一套混进云端的同步记录)
  const local = parseSyncMeta(JSON.stringify({ version: 1, base: { v: 1, realm: 'local', groups: [{ id: 'g', name: 'x' }], projects: [], chats: [] }, dirty: false }));
  assert.deepEqual(local.base, emptyOrg('cloud'));
  assert.match(syncMetaKey('acc:x'), /^pc\.start\.orgsync\.cloud\./);
});

test('SYNC-12 服务端限流(429 带 Retry-After):标待同步、改动留着、不早于它说的时间再试,不报错', async () => {
  const server = fakeServer();
  const limited = Object.assign(new Error('org-rate-limited'), { status: 429, code: 'org-rate-limited', retryAfterSec: 30 });
  let limit = true;
  const transport = { get: server.transport.get, async put(v, o) { if (limit) throw limited; return server.transport.put(v, o); } };
  const h = harness({ server, transport });
  await h.sync.refresh();
  h.edit(org({ groups: [{ id: 'a', name: '限流时改的' }] }));
  await h.fire(); // 防抖到了,被限流
  assert.equal(h.sync.status(), 'pending');
  assert.equal(h.state.meta.dirty, true, '改动没丢');
  assert.deepEqual(names(h.state.org), ['限流时改的']);
  assert.equal(h.live()[0].ms, 30_000, '按服务端说的时间再试(比自己的 2 秒退避长)');
  limit = false;
  await h.fire();
  assert.equal(h.sync.status(), 'synced');
  assert.deepEqual(names(server.org), ['限流时改的']);
});
