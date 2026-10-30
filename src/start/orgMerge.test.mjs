/**
 * 云端分组的三方合并(`src/start/orgMerge.ts`,裁定 V22-08)。跑:npm test -- src/start/orgMerge.test.mjs
 *
 *   ORGM-01 两边各加一个分组:都留着
 *   ORGM-02 两边改同一个项目的归属:我这边的赢;改的是不同字段:两边都留
 *   ORGM-03 一边删一边改:改过的留下;没改过的才算删;删分组连带项目回到没放进分组
 *   ORGM-04 顺序:我动过用我的,没动过用对方的;另一边新增的插在原来前一个邻居后面
 *   ORGM-05 没有 base(第一次、缓存丢了):两边内容取并集
 *   ORGM-06 对话条目按「项目 + 对话」对齐,置顶归档照合
 *   ORGM-07 回包丢了、原样重传:云端那份就是我刚写的,合出来不变(幂等);输入不被原地改
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeList, mergeOrg } from './orgMerge.ts';

const org = (o = {}) => ({ v: 1, realm: 'cloud', groups: [], projects: [], chats: [], ...o });
const deepFreeze = (x) => { if (x && typeof x === 'object') { Object.values(x).forEach(deepFreeze); Object.freeze(x); } return x; };
const ids = (list) => list.map((x) => x.id);
const byId = (list, id) => list.find((x) => x.id === id);

test('ORGM-01 两边各加一个分组:都留着,原来的还在', () => {
  const base = org({ groups: [{ id: 'g1', name: '原有' }] });
  const mine = org({ groups: [{ id: 'g1', name: '原有' }, { id: 'gM', name: '我加的' }] });
  const theirs = org({ groups: [{ id: 'g1', name: '原有' }, { id: 'gT', name: '对方加的' }] });
  const out = mergeOrg(base, mine, theirs);
  assert.deepEqual(ids(out.groups).sort(), ['g1', 'gM', 'gT']);
  assert.equal(ids(out.groups)[0], 'g1');
  assert.equal(out.realm, 'cloud');
  // 两边各自新增了同一个编号:整条听我的
  const clash = mergeOrg(base, org({ groups: [{ id: 'g1', name: '原有' }, { id: 'gX', name: '我的叫法' }] }), org({ groups: [{ id: 'g1', name: '原有' }, { id: 'gX', name: '对方的叫法' }] }));
  assert.equal(byId(clash.groups, 'gX').name, '我的叫法');
});

test('ORGM-02 两边改同一个项目的归属:我这边的赢;改不同字段两边都留;没写 false 的不凭空多出标记', () => {
  const groups = [{ id: 'gA', name: 'A' }, { id: 'gB', name: 'B' }];
  const base = org({ groups, projects: [{ id: 'p1', groupId: null }, { id: 'p2', groupId: null }] });
  const mine = org({ groups, projects: [{ id: 'p1', groupId: 'gA' }, { id: 'p2', groupId: null, pinned: true }] });
  const theirs = org({ groups, projects: [{ id: 'p1', groupId: 'gB' }, { id: 'p2', groupId: null, archived: true }] });
  const out = mergeOrg(base, mine, theirs);
  assert.equal(byId(out.projects, 'p1').groupId, 'gA', '同一字段两边都改:我的赢');
  assert.deepEqual(byId(out.projects, 'p2'), { id: 'p2', groupId: null, pinned: true, archived: true }, '不同字段:两边都留');
  // 只对方改了归属、我没动:听对方的
  const only = mergeOrg(base, base, org({ groups, projects: [{ id: 'p1', groupId: 'gB' }, { id: 'p2', groupId: null }] }));
  assert.equal(byId(only.projects, 'p1').groupId, 'gB');
  assert.deepEqual(byId(only.projects, 'p2'), { id: 'p2', groupId: null });
  // 我取消了置顶、对方没动:取消生效,且不留 pinned: false
  const unpin = mergeOrg(org({ projects: [{ id: 'p', groupId: null, pinned: true }] }), org({ projects: [{ id: 'p', groupId: null }] }), org({ projects: [{ id: 'p', groupId: null, pinned: true }] }));
  assert.deepEqual(unpin.projects, [{ id: 'p', groupId: null }]);
});

test('ORGM-03 一边删一边改:改过的留下;没改过才算删;删分组连带项目回到没放进分组', () => {
  const base = org({ groups: [{ id: 'g1', name: '旧名' }, { id: 'g2', name: '另一个' }, { id: 'g3', name: '第三个' }], projects: [{ id: 'p1', groupId: 'g1' }, { id: 'p2', groupId: 'g2' }] });
  // 我删了 g1,对方在这之后改了它的名字 → 留下,带着对方的新名字
  let out = mergeOrg(base, org({ groups: base.groups.filter((g) => g.id !== 'g1'), projects: base.projects }), org({ groups: [{ id: 'g1', name: '对方改的名' }, base.groups[1], base.groups[2]], projects: base.projects }));
  assert.equal(byId(out.groups, 'g1').name, '对方改的名');
  assert.equal(byId(out.projects, 'p1').groupId, 'g1');
  // 我删了 g2,对方没改 → 真删;里面的项目回到没放进分组
  out = mergeOrg(base, org({ groups: base.groups.filter((g) => g.id !== 'g2'), projects: base.projects }), base);
  assert.deepEqual(ids(out.groups), ['g1', 'g3']);
  assert.equal(byId(out.projects, 'p2').groupId, null);
  // 对方删了 g3,我在这之后给它置顶 → 留下,带着我的置顶
  out = mergeOrg(base, org({ groups: [base.groups[0], base.groups[1], { id: 'g3', name: '第三个', pinned: true }], projects: base.projects }), org({ groups: base.groups.slice(0, 2), projects: base.projects }));
  assert.deepEqual(byId(out.groups, 'g3'), { id: 'g3', name: '第三个', pinned: true });
  // 对方删了项目、我没改 → 真删;我改了(归档)的留下
  const withP = org({ projects: [{ id: 'a', groupId: null }, { id: 'b', groupId: null }] });
  out = mergeOrg(withP, org({ projects: [{ id: 'a', groupId: null }, { id: 'b', groupId: null, archived: true }] }), org({ projects: [] }));
  assert.deepEqual(out.projects, [{ id: 'b', groupId: null, archived: true }]);
  // 两边都删了:没了
  assert.deepEqual(mergeOrg(withP, org(), org()).projects, []);
  // 对方删了分组、我这边正好把项目放进了它(分组本身我没改):分组真删,项目回到没放进分组
  out = mergeOrg(base, org({ groups: base.groups, projects: [{ id: 'p1', groupId: 'g3' }, base.projects[1]] }), org({ groups: base.groups.slice(0, 2), projects: base.projects }));
  assert.equal(byId(out.projects, 'p1').groupId, null);
});

test('ORGM-04 顺序:我动过用我的;没动过用对方的;另一边新增的插在原来前一个邻居后面', () => {
  const a = { id: 'a' }, b = { id: 'b' }, c = { id: 'c' }, d = { id: 'd' };
  const spec = { key: (x) => x.id, fields: [] };
  // 我把 c 挪到最前;对方新加了 d(在 b 后面)
  assert.deepEqual(ids(mergeList([a, b, c], [c, a, b], [a, b, d, c], spec)), ['c', 'a', 'b', 'd']);
  // 我没动顺序;对方挪了 c 到最前:听对方的
  assert.deepEqual(ids(mergeList([a, b, c], [a, b, c], [c, a, b], spec)), ['c', 'a', 'b']);
  // 我没动顺序,但新加了 d(末尾);对方挪了顺序:用对方的,我的 d 插在 c 后面(我这边它在 c 后面)
  assert.deepEqual(ids(mergeList([a, b, c], [a, b, c, d], [c, b, a], spec)), ['c', 'd', 'b', 'a']);
  // 新增排最前的约定(项目)保持:我这边新项目在最前,对方没动顺序 → 仍在最前
  assert.deepEqual(ids(mergeList([a, b], [d, a, b], [a, b], spec)), ['d', 'a', 'b']);
  // 分组「新建在最后」的约定保持
  assert.deepEqual(ids(mergeList([a, b], [a, b, d], [a, b], spec)), ['a', 'b', 'd']);
});

test('ORGM-05 没有 base(第一次、缓存丢了):两边内容取并集,同编号听我的', () => {
  const mine = org({ groups: [{ id: 'g1', name: '我的' }], projects: [{ id: 'p1', groupId: 'g1', pinned: true }] });
  const theirs = org({ groups: [{ id: 'g1', name: '对方的' }, { id: 'g2', name: '对方另有' }], projects: [{ id: 'p1', groupId: null }, { id: 'p2', groupId: 'g2' }] });
  const out = mergeOrg(null, mine, theirs);
  assert.deepEqual(ids(out.groups).sort(), ['g1', 'g2']);
  assert.equal(byId(out.groups, 'g1').name, '我的');
  assert.deepEqual(ids(out.projects).sort(), ['p1', 'p2']);
  assert.deepEqual(byId(out.projects, 'p1'), { id: 'p1', groupId: 'g1', pinned: true });
});

test('ORGM-06 对话条目按「项目 + 对话」对齐:同一个对话编号在两个项目里互不干扰', () => {
  const base = org({ chats: [{ id: 'c', projectId: 'p1' }, { id: 'c', projectId: 'p2' }] });
  const mine = org({ chats: [{ id: 'c', projectId: 'p1', pinned: true }, { id: 'c', projectId: 'p2' }] });
  const theirs = org({ chats: [{ id: 'c', projectId: 'p1' }, { id: 'c', projectId: 'p2', archived: true }] });
  const out = mergeOrg(base, mine, theirs);
  assert.deepEqual(out.chats.find((x) => x.projectId === 'p1'), { id: 'c', projectId: 'p1', pinned: true });
  assert.deepEqual(out.chats.find((x) => x.projectId === 'p2'), { id: 'c', projectId: 'p2', archived: true });
});

test('ORGM-07 回包丢了、原样重传:云端那份就是我刚写的,合出来不变;输入不被原地改', () => {
  const base = org({ groups: [{ id: 'g1', name: '原' }] });
  const mine = org({ groups: [{ id: 'g1', name: '改了' }, { id: 'g2', name: '新的' }], projects: [{ id: 'p', groupId: 'g2', pinned: true }], chats: [{ id: 'c', projectId: 'p', archived: true }] });
  deepFreeze(base); deepFreeze(mine);
  const out = mergeOrg(base, mine, mine);
  assert.deepEqual(out, mine);
  // 没有任何改动:合出来就是对方的
  const theirs = deepFreeze(org({ groups: [{ id: 'g9', name: '别人的' }] }));
  assert.deepEqual(mergeOrg(theirs, theirs, theirs), theirs);
});
