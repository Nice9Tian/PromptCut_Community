/**
 * 本地分组与云端分组(`src/start/vibeOrg.ts`)。跑:npm test -- src/start/orgRealm.test.mjs
 *
 * 用户 2026-10-23 定:「分本地分组(桌面版的本地 Agent)和云端分组。云端分组存云端,本地分组存本地。
 * 本地项目放不进云端的分组(反之云端也放不进本地)」。这里盯四件事:
 *   ORGR-01/02 本地分组只收本机项目、云端分组只收云端项目;
 *   ORGR-03/04 跨着放被拦住,并给出说明(整理信息原样不动);右键菜单里另一套的分组置灰并说明;
 *   ORGR-05/06/07 两套分组的存储键互不覆盖,内容里的标记对不上就不认,分套之前的老键认一次;
 *   ORGR-08 游客没有云端那一份:没有范围就读不到也存不了;
 *   ORGR-09/10 云端分组的说法(接上云端、老服务端改口)与清理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOUD_ORG_IN_CLOUD, LOCAL_ORG_SCOPE, addGroup, cloudOrgScope, emptyOrg, groupNoteText, groupsOf, loadOrg, mergeProjects, moveProject,
  moveRefusal, moveTargetsFor, orgKey, orgWhereText, parseOrg, pruneOrg, saveOrg, withGroups, withProjects,
} from './vibeOrg.ts';

/** 一个最小的 localStorage:node 里没有,用例自己装一个,每条用例换一份干净的 */
function installStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
  return map;
}

const localDrafts = [
  { id: '20261023-aaaaaa', name: '本机草稿甲', role: 'owned', realm: 'local' },
  { id: '20261023-bbbbbb', name: '本机草稿乙', role: 'owned', realm: 'local' },
];
const cloudProjects = [
  { id: 'cloudproj01', name: '云端项目一', role: 'owned', realm: 'cloud' },
  { id: 'cloudproj02', name: '云端项目二', role: 'joined', realm: 'cloud' },
];
const mixed = [...localDrafts, ...cloudProjects];

test('ORGR-01 本地分组只收本机项目:清单里混进云端项目也不出现,放进本地分组的只有本机项目', () => {
  const { org, id } = addGroup(emptyOrg('local'), '素材', () => 'l1');
  assert.equal(org.realm, 'local');
  const list = mergeProjects(org, mixed);
  assert.deepEqual(list.map((p) => p.id), ['20261023-aaaaaa', '20261023-bbbbbb']);
  assert.ok(list.every((p) => p.realm === 'local'));
  // 本机项目放进本地分组:成功
  const out = moveProject(org, list[0], id);
  assert.equal(out.refused, null);
  assert.equal(out.org.projects[0].groupId, id);
  // 云端项目哪怕有人硬塞进写回清单,也进不了本地那一份
  const cloudList = mergeProjects(addGroup(emptyOrg('cloud'), 'x').org, cloudProjects);
  const stuffed = withProjects(out.org, [...list, ...cloudList]);
  assert.deepEqual(stuffed.projects.map((p) => p.id).sort(), ['20261023-aaaaaa', '20261023-bbbbbb']);
});

test('ORGR-02 云端分组只收云端项目:清单里混进本机草稿也不出现,放进云端分组的只有云端项目', () => {
  const { org, id } = addGroup(emptyOrg('cloud'), '客户', () => 'c1');
  assert.equal(org.realm, 'cloud');
  const list = mergeProjects(org, mixed);
  assert.deepEqual(list.map((p) => p.id), ['cloudproj01', 'cloudproj02']);
  assert.ok(list.every((p) => p.realm === 'cloud'));
  const out = moveProject(org, list[1], id);
  assert.equal(out.refused, null);
  assert.equal(out.org.projects[0].groupId, id);
  // 本地那一套的分组也不会被云端这一份收下
  assert.deepEqual(withGroups(org, [{ id: 'gx', name: '本地来的', realm: 'local' }]).groups, []);
});

test('ORGR-03 跨着放被拦住并给出说明:本地项目不进云端分组,云端项目不进本地分组;整理信息原样不动', () => {
  const cloudOrg = addGroup(emptyOrg('cloud'), '客户', () => 'c1');
  const localOrg = addGroup(emptyOrg('local'), '素材', () => 'l1');

  const a = moveProject(cloudOrg.org, { id: '20261023-aaaaaa', realm: 'local' }, cloudOrg.id);
  assert.equal(a.refused, '本地项目不能放进云端分组：本地分组装本机的项目，云端分组装云端的项目。');
  assert.equal(a.org, cloudOrg.org, '拒绝时返回同一个对象:什么都没改');
  assert.deepEqual(a.org.projects, []);

  const b = moveProject(localOrg.org, { id: 'cloudproj01', realm: 'cloud' }, localOrg.id);
  assert.equal(b.refused, '云端项目不能放进本地分组：云端分组装云端的项目，本地分组装本机的项目。');
  assert.equal(b.org, localOrg.org);

  // 「移出分组」(groupId = null)对跨套的项目也一样不许碰这一份
  assert.ok(moveProject(cloudOrg.org, { id: '20261023-aaaaaa', realm: 'local' }, null).refused);

  // 说明那一句只由两套是否相同决定
  assert.equal(moveRefusal('cloud', 'cloud'), null);
  assert.equal(moveRefusal('local', 'local'), null);
  assert.ok(moveRefusal('local', 'cloud') && moveRefusal('cloud', 'local'));
  assert.notEqual(moveRefusal('local', 'cloud'), moveRefusal('cloud', 'local'));
});

test('ORGR-04 右键「移到分组」:同一套的分组能点,另一套的分组也列出来、置灰并说明;归档的、已在的不列;已在分组里多一项移出', () => {
  const groups = [
    { id: 'gl', name: '本地一', realm: 'local' },
    { id: 'gc', name: '云端一', realm: 'cloud' },
    { id: 'gcc', name: '云端旧', realm: 'cloud', archived: true },
  ];
  const localProject = { realm: 'local', groupId: null };
  const t = moveTargetsFor(localProject, groups);
  assert.deepEqual(t.map((x) => x.id), ['gl', 'gc']);
  assert.equal(t[0].blocked, undefined);
  assert.equal(t[1].blocked, moveRefusal('local', 'cloud'));

  const cloudProject = { realm: 'cloud', groupId: 'gc' };
  const t2 = moveTargetsFor(cloudProject, groups);
  assert.deepEqual(t2.map((x) => x.id), ['gl', null]);
  assert.equal(t2[0].blocked, moveRefusal('cloud', 'local'));
  assert.equal(t2[1].blocked, undefined, '移出分组不受限');
});

test('ORGR-05 两套分组的存储键互不覆盖:前缀不同,任何范围名都撞不到对面去;各写各的,读回来各是各的', () => {
  const store = installStorage();
  // 键:前缀分开,哪怕范围名被取成对面的样子
  assert.notEqual(orgKey('local', 'x'), orgKey('cloud', 'x'));
  assert.notEqual(orgKey('local', 'cloud.x'), orgKey('cloud', 'x'));
  assert.notEqual(orgKey('local', LOCAL_ORG_SCOPE), orgKey('cloud', LOCAL_ORG_SCOPE));
  assert.ok(orgKey('local', 'z').startsWith('pc.start.org.local.'));
  assert.ok(orgKey('cloud', 'z').startsWith('pc.start.org.cloud.'));

  // 同一个范围名各存一份:谁也没盖掉谁
  const l = addGroup(emptyOrg('local'), '本地组', () => 'l1').org;
  const c = addGroup(emptyOrg('cloud'), '云端组', () => 'c1').org;
  saveOrg('same', l);
  saveOrg('same', c);
  assert.equal(store.size, 2);
  assert.deepEqual(loadOrg('local', 'same').groups.map((g) => g.name), ['本地组']);
  assert.deepEqual(loadOrg('cloud', 'same').groups.map((g) => g.name), ['云端组']);

  // 真实的两个范围:桌面版固定一份,云端按账号各一份
  const a1 = cloudOrgScope('acc_000000000000000000000001');
  const a2 = cloudOrgScope('acc_000000000000000000000002');
  saveOrg(LOCAL_ORG_SCOPE, addGroup(emptyOrg('local'), 'D', () => 'd1').org);
  saveOrg(a1, addGroup(emptyOrg('cloud'), 'A1', () => 'a1').org);
  saveOrg(a2, addGroup(emptyOrg('cloud'), 'A2', () => 'a2').org);
  assert.deepEqual(loadOrg('local', LOCAL_ORG_SCOPE).groups.map((g) => g.name), ['D']);
  assert.deepEqual(loadOrg('cloud', a1).groups.map((g) => g.name), ['A1']);
  assert.deepEqual(loadOrg('cloud', a2).groups.map((g) => g.name), ['A2']);
  // 存下去的内容带着自己是哪一套
  assert.equal(JSON.parse(store.get(orgKey('local', LOCAL_ORG_SCOPE))).realm, 'local');
  assert.equal(JSON.parse(store.get(orgKey('cloud', a1))).realm, 'cloud');
});

test('ORGR-06 内容里的标记对不上就不认:云端那份被拷到本地的键、或反过来,读出来是空的,不会把一套当成另一套', () => {
  const cloudBlob = JSON.stringify(addGroup(emptyOrg('cloud'), '云端组', () => 'c1').org);
  const localBlob = JSON.stringify(addGroup(emptyOrg('local'), '本地组', () => 'l1').org);
  installStorage({
    [orgKey('local', LOCAL_ORG_SCOPE)]: cloudBlob, // 云端的内容躺在本地的键里
    [orgKey('cloud', 'acc:me')]: localBlob, // 本地的内容躺在云端的键里
  });
  assert.deepEqual(loadOrg('local', LOCAL_ORG_SCOPE), emptyOrg('local'));
  assert.deepEqual(loadOrg('cloud', 'acc:me'), emptyOrg('cloud'));
  assert.deepEqual(parseOrg(cloudBlob, 'local'), emptyOrg('local'));
  assert.deepEqual(parseOrg(localBlob, 'cloud'), emptyOrg('cloud'));
  assert.equal(parseOrg(cloudBlob, 'cloud').groups[0].name, '云端组');
  // 每个分组的标记由整份的套给:读出来的分组都带着这一套的 realm
  assert.ok(groupsOf(parseOrg(localBlob, 'local')).every((g) => g.realm === 'local'));
});

test('ORGR-07 分套之前写的老键(pc.start.org.<范围>,没有套的标记)认一次:桌面版按本地、云端按账号;之后只写新键', () => {
  const legacy = JSON.stringify({ v: 1, groups: [{ id: 'g-old', name: '老分组' }], projects: [{ id: 'p', groupId: 'g-old' }], chats: [] });
  const store = installStorage({ 'pc.start.org.desktop': legacy, 'pc.start.org.acc:me': legacy });
  const l = loadOrg('local', LOCAL_ORG_SCOPE);
  const c = loadOrg('cloud', 'acc:me');
  assert.equal(l.realm, 'local');
  assert.equal(c.realm, 'cloud');
  assert.deepEqual(l.groups.map((g) => g.name), ['老分组']);
  assert.deepEqual(c.groups.map((g) => g.name), ['老分组']);
  saveOrg(LOCAL_ORG_SCOPE, l);
  assert.ok(store.has(orgKey('local', LOCAL_ORG_SCOPE)));
  assert.equal(store.get('pc.start.org.desktop'), legacy, '老键不动');
  // 新键有了就以新键为准,不再回头读老键
  saveOrg(LOCAL_ORG_SCOPE, addGroup(l, '新的', () => 'n1').org);
  assert.deepEqual(loadOrg('local', LOCAL_ORG_SCOPE).groups.map((g) => g.name), ['老分组', '新的']);
});

test('ORGR-08 游客没有云端那一份:没有范围就读不到、也存不了(游客不会把整理信息写进任何一套的键)', () => {
  const store = installStorage();
  assert.deepEqual(loadOrg('cloud', null), emptyOrg('cloud'));
  saveOrg(null, addGroup(emptyOrg('cloud'), '不该存', () => 'g1').org);
  assert.equal(store.size, 0);
});

test('ORGR-09 云端分组说话:接上云端是「存在云端,换设备也能看到」;探到老服务端改口成只记在这台浏览器里;本地分组不受影响', () => {
  assert.equal(CLOUD_ORG_IN_CLOUD, true);
  assert.equal(orgWhereText('cloud'), '存在云端，换设备也能看到');
  assert.equal(orgWhereText('cloud', false), '暂时只记在这台浏览器里');
  assert.equal(orgWhereText('local'), '只记在这台机器上');
  assert.equal(orgWhereText('local', true), '只记在这台机器上');
  assert.equal(groupNoteText('cloud'), '云端分组：存在云端，换设备也能看到，只能放云端的项目。');
  assert.equal(groupNoteText('cloud', false), '云端分组：暂时只记在这台浏览器里，只能放云端的项目。');
  assert.equal(groupNoteText('local'), '本地分组：只记在这台机器上，只能放本机的项目。');
});

test('ORGR-10 清理:列表里已经没有的项目,没有任何整理信息的条目去掉、对话跟着去掉;有整理信息的留着;列表没取到不清', () => {
  const org = {
    ...emptyOrg('cloud'),
    groups: [{ id: 'g', name: '组' }],
    projects: [
      { id: 'live', groupId: null },
      { id: 'gone-plain', groupId: null },
      { id: 'gone-grouped', groupId: 'g' },
      { id: 'gone-pinned', groupId: null, pinned: true },
      { id: 'gone-archived', groupId: null, archived: true },
    ],
    chats: [{ id: 'c1', projectId: 'live' }, { id: 'c2', projectId: 'gone-plain' }, { id: 'c3', projectId: 'gone-pinned', pinned: true }],
  };
  const out = pruneOrg(org, new Set(['live']));
  assert.deepEqual(out.projects.map((p) => p.id), ['live', 'gone-grouped', 'gone-pinned', 'gone-archived']);
  assert.deepEqual(out.chats.map((c) => c.id), ['c1', 'c3']);
  assert.equal(pruneOrg(org, null), org, '列表没取到:不动');
  assert.equal(pruneOrg(out, new Set(['live'])), out, '没有要清的:返回原对象');
});
