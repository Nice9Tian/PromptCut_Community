/**
 * C6.6 卡片源码同步（`docs/plan/c66-design.md` 第 5 节；验收 T8 的单进程部分）。
 * 跑：node --test server/test/c66-cards.test.mjs
 *
 * 只照设计稿写，没看实现。同步模块的名字与依赖注入的形状是假设 K5（见 `c66-kit.mjs` 文件头）。
 * 内容库用假件（`fakeContentService`，行为照 `server/docservice/modules/content.mjs`：card-source 按键发 rev、
 * 每次 put 加一、后写的赢），A、B 两端各拿一个以自己身份写的视图、共享同一份存储。
 * 本机文件、装卡（`/api/cards/install`）、备份、覆盖提示都由 `fakeCardHost` 记下来。
 * 「装上后重测、重排预渲染」走现有规则，不在本文件。
 *
 * 冲突的判定依据：设计稿第 5 节「本机改过、服务上也改过 → 最后写的赢，本机先备份再装、给提示」，
 * 以及语义 `document-service.md`「冲突」：「被覆盖的一方在换成最新版本之前，先把自己那份存成本地备份」。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir, fakeContentService, fakeCardHost, loadCardSync, waitFor, sleep } from './c66-kit.mjs';

const DIR = tempDir('pc-c66-cards-');
after(() => fs.rmSync(DIR, { recursive: true, force: true }));
let seq = 0;
const stateFile = () => path.join(DIR, `card-sync-${++seq}.json`);

const KIND = 'card-source';
const USER = 'src/cards/user/lower-third.tsx';
const USER2 = 'src/cards/user/title-bar.tsx';
const BUILTIN = 'src/cards/builtin/punch-pill.tsx';
const src = (tag) => `export default function Card() { return <div>${tag}</div>; }\n`;

const ofType = (host, type) => host.events.filter((e) => e.type === type);

// ------------------------------------------------------------------ 写

test('C66-T8-01 保存用户卡 → content.put(card-source, 仓库相对路径, 源码)，每存一次 cardRev 加一', async () => {
  const create = await loadCardSync();
  const svc = fakeContentService();
  const host = fakeCardHost({ stateFile: stateFile() });
  const sync = create({ content: svc.as('B'), host });
  await sync.open();
  await sync.save(USER, src('v1'));
  await sync.save(USER, src('v2'));
  const puts = svc.puts.filter((p) => p.key === USER);
  assert.deepEqual(puts.map((p) => [p.kind, p.body, p.rev]), [[KIND, src('v1'), 1], [KIND, src('v2'), 2]]);
  await sync.close();
});

test('C66-T8-02 范围：用户卡、改过的内置卡同步；未改的内置卡不同步', async () => {
  const create = await loadCardSync();
  const svc = fakeContentService();
  const MOD = 'src/cards/builtin/glass-card.tsx';
  const host = fakeCardHost({ stateFile: stateFile(), scopes: { [BUILTIN]: 'builtin', [MOD]: 'builtin-modified', [USER]: 'user' } });
  const sync = create({ content: svc.as('B'), host });
  await sync.open();
  await sync.save(USER, src('u'));
  await sync.save(MOD, src('m'));
  await sync.save(BUILTIN, src('b'));
  const keys = svc.puts.map((p) => p.key);
  assert.ok(keys.includes(USER), '用户卡要同步');
  assert.ok(keys.includes(MOD), '改过的内置卡（改动层里有）要同步');
  assert.ok(!keys.includes(BUILTIN), '未改的内置卡不同步');
  await sync.close();
});

// ------------------------------------------------------------------ 读：打开项目

test('C66-T8-03 打开项目：本机没有的卡 → 拉下来装上（带 cardRev），不备份、不提示', async () => {
  const create = await loadCardSync();
  const svc = fakeContentService();
  await svc.as('A').put(KIND, USER, src('A1'));
  await svc.as('A').put(KIND, USER2, src('A-title'));
  const host = fakeCardHost({ stateFile: stateFile() });
  const sync = create({ content: svc.as('B'), host });
  await sync.open();
  await waitFor(() => ofType(host, 'install').length >= 2, { what: '两张卡装上' });
  const inst = Object.fromEntries(ofType(host, 'install').map((e) => [e.key, e]));
  assert.equal(inst[USER].body, src('A1'));
  assert.equal(inst[USER].rev, 1);
  assert.equal(inst[USER2].body, src('A-title'));
  assert.deepEqual(ofType(host, 'backup'), [], '本机没有的卡不用备份');
  assert.deepEqual(ofType(host, 'notify'), [], '也不提示覆盖');
  await sync.close();
});

test('C66-T8-04 本机没改过、服务上的 cardRev 更新了 → 装新版，不备份；「上次同步到的 cardRev 与哈希」重启后还在', async () => {
  const create = await loadCardSync();
  const svc = fakeContentService();
  const sf = stateFile();
  const host = fakeCardHost({ stateFile: sf });
  // B 存过一次（rev 1），关掉
  const b1 = create({ content: svc.as('B'), host });
  await b1.open();
  await b1.save(USER, src('B1'));
  await b1.close();
  // 期间 A 在 B 那一版的基础上改（rev 2）；B 本机文件没动
  await svc.as('A').put(KIND, USER, src('A2'));
  // B 重新打开（新实例、同一个状态文件）
  const b2 = create({ content: svc.as('B'), host });
  await b2.open();
  await waitFor(() => ofType(host, 'install').length >= 1, { what: '装上 A 的新版' });
  const inst = ofType(host, 'install');
  assert.equal(inst.length, 1);
  assert.equal(inst[0].body, src('A2'));
  assert.equal(inst[0].rev, 2);
  assert.equal(host.local.get(USER), src('A2'));
  // 本机那份没改过：不算冲突
  assert.deepEqual(ofType(host, 'backup').filter((e) => e.key === USER && e.body !== src('B1')), [], '没有多余的备份');
  // 再开一次：已经是最新，不重装
  await b2.close();
  const b3 = create({ content: svc.as('B'), host });
  await b3.open();
  await sleep(100);
  assert.equal(ofType(host, 'install').length, 1, '已同步到最新的卡不重装');
  await b3.close();
});

// 2026-10-22 用户定(`workflow/editing.md`「撤销、重做」、`product/document-service.md`「冲突」):断网期间的改动与云端冲突时进「冲突合并」,
// 一张卡一条。原来「后写的赢 + 覆盖提示」改成:先备份本机那份、装上服务上的,发 conflict(带两份源码)交给冲突合并窗口(conflict-merge 报告)
test('C66-T8-05 本机改过（没同步出去）、服务上也改过 → 先备份本机那份，再装服务上的，交给冲突合并（带两份源码）', async () => {
  const create = await loadCardSync();
  const svc = fakeContentService();
  const sf = stateFile();
  const host = fakeCardHost({ stateFile: sf });
  const b1 = create({ content: svc.as('B'), host });
  await b1.open();
  await b1.save(USER, src('base'));
  await b1.close();
  // B 离线改了本机文件（没经同步），A 同时改了服务上的（rev 2）
  host.local.set(USER, src('B-local'));
  await svc.as('A').put(KIND, USER, src('A-remote'));
  const b2 = create({ content: svc.as('B'), host });
  await b2.open();
  await waitFor(() => ofType(host, 'install').length >= 1, { what: '装上服务上的版本' });
  const seqOf = (type) => host.events.findIndex((e) => e.type === type && e.key === USER);
  const bi = seqOf('backup'), ii = seqOf('install');
  assert.ok(bi >= 0, '本机那份要备份');
  assert.equal(host.events[bi].body, src('B-local'), '备份的是本机改过的那份');
  assert.ok(bi < ii, '先备份、再装');
  assert.equal(host.events[ii].body, src('A-remote'), '本机先换成服务上的（我的在冲突合并里）');
  const c = ofType(host, 'notify').find((e) => e.key === USER);
  assert.ok(c, '给出提示');
  assert.equal(c.notifyType, 'card-conflict', '是冲突(进冲突合并),不是「被覆盖」');
  assert.equal(c.mine, src('B-local'));
  assert.equal(c.cloud, src('A-remote'));
  await b2.close();
});

test('C66-T8-06 订阅：A 改了一张卡，B 5 s 内按规则当场装上（本机没改 → 直接装）', async () => {
  const create = await loadCardSync();
  const svc = fakeContentService();
  const host = fakeCardHost({ stateFile: stateFile() });
  const b = create({ content: svc.as('B'), host });
  await b.open();
  await b.save(USER, src('B1'));
  const t0 = Date.now();
  await svc.as('A').put(KIND, USER, src('A2'));
  await waitFor(() => ofType(host, 'install').some((e) => e.body === src('A2')), { timeoutMs: 5000, what: 'B 装上 A 的新版' });
  assert.ok(Date.now() - t0 < 5000);
  assert.equal(host.local.get(USER), src('A2'));
  await b.close();
});

test('C66-T8-07 两端同时改同一张卡：后写的赢，先写的一方被覆盖前有备份与提示（语义「冲突」）', async () => {
  const create = await loadCardSync();
  const svc = fakeContentService();
  const hostA = fakeCardHost({ stateFile: stateFile() });
  const hostB = fakeCardHost({ stateFile: stateFile() });
  const a = create({ content: svc.as('A'), host: hostA });
  const b = create({ content: svc.as('B'), host: hostB });
  await a.open();
  await b.open();
  // B 先写，A 后写（A 没有先装 B 的那版：两边各改各的）
  await b.save(USER, src('B-first'));
  await a.save(USER, src('A-last'));
  await waitFor(() => ofType(hostB, 'install').some((e) => e.body === src('A-last')), { timeoutMs: 5000, what: 'B 装上 A 后写的版本' });
  const bi = hostB.events.findIndex((e) => e.type === 'backup' && e.body === src('B-first'));
  const ii = hostB.events.findIndex((e) => e.type === 'install' && e.body === src('A-last'));
  assert.ok(bi >= 0, '先写的一方（B）要把自己那份存成备份');
  assert.ok(bi < ii, 'B 先备份、再换成 A 的版本');
  assert.ok(ofType(hostB, 'notify').some((e) => e.key === USER), 'B 收到覆盖提示');
  assert.equal(hostB.local.get(USER), src('A-last'), '后写的赢');
  // 服务上最后是 A 的
  assert.equal((await svc.as('X').get(KIND, USER)).body, src('A-last'));
  // A 是后写方：B 那一版的通知可能先到 A（A 那时还没存，装上也合规），但最后 A 本机必须是自己后写的版本
  await sleep(150);
  assert.equal(hostA.local.get(USER), src('A-last'), 'A 不被先写的 B 版本倒回去');
  await a.close();
  await b.close();
});

test('C66-T8-08 本机改过、服务上没更新 → 不装、不备份（本机那份留着）', async () => {
  const create = await loadCardSync();
  const svc = fakeContentService();
  const sf = stateFile();
  const host = fakeCardHost({ stateFile: sf });
  const b1 = create({ content: svc.as('B'), host });
  await b1.open();
  await b1.save(USER, src('B1'));
  await b1.close();
  host.local.set(USER, src('B-local-edit'));
  const b2 = create({ content: svc.as('B'), host });
  await b2.open();
  await sleep(150);
  assert.deepEqual(ofType(host, 'install'), [], '服务上没新版，不装');
  assert.deepEqual(ofType(host, 'backup'), [], '也不备份');
  assert.equal(host.local.get(USER), src('B-local-edit'));
  await b2.close();
});
