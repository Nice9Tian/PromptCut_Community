/**
 * 侧栏的本机整理(`src/start/vibeOrg.ts`)。跑:npm test -- src/start/vibeOrg.test.mjs
 *
 * 盯三件事:项目一律以云端列表为准(本机整理不凭空造项目、取不到列表时不丢整理信息);
 * 本机存的东西坏了不白屏;**别人的私有对话不列出来**(`product/agent.md`,创建者只读例外)。
 *
 * 2026-10-23 分本地、云端两套之后:整理信息带 `realm`、项目清单的每一项带 `realm`。这里的用例都在云端那一套上跑(`emptyOrg('cloud')`、
 * 项目标 `realm: 'cloud'`),只改了这几处样子,断言没动;两套之间的规矩(只收同一套、跨套放不进、键互不覆盖)在 `orgRealm.test.mjs`。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { addGroup, emptyOrg, mergeChats, mergeProjects, moveProject, parseOrg, viewableChats, withChats, withGroups, withProjects } from './vibeOrg.ts';

const EMPTY_ORG = emptyOrg('cloud');
const cloud = [
  { id: 'p1', name: '一', role: 'owned', realm: 'cloud' },
  { id: 'p2', name: '二', role: 'owned', realm: 'cloud' },
  { id: 'p3', name: '三', role: 'joined', realm: 'cloud' },
];
const C = 'cloud';

test('VORG-01 with no organization data: the manifest is just the cloud list, nothing is placed in a group, and unknown aspect ratio, duration and thumbnail are null', () => {
  const list = mergeProjects(EMPTY_ORG, cloud);
  assert.deepEqual(list.map((p) => p.id), ['p1', 'p2', 'p3']);
  assert.ok(list.every((p) => p.groupId === null && p.ratio === null && p.duration === null && p.thumb === null));
  assert.equal(list[2].role, 'joined');
});

test('VORG-02 the order, groups and pins recorded on this machine are applied as is; projects not in the list do not appear out of nowhere', () => {
  let org = addGroup(EMPTY_ORG, 'Brand', () => 'aaa').org;
  org = withProjects(org, [
    { id: 'p3', realm: C, groupId: 'g-aaa', pinned: true },
    { id: 'gone', realm: C, groupId: null },
    { id: 'p1', realm: C, groupId: null, archived: true },
  ]);
  const list = mergeProjects(org, cloud);
  // p2 是新出现的,排最前;gone 不在云端列表里,不出现
  assert.deepEqual(list.map((p) => p.id), ['p2', 'p3', 'p1']);
  assert.equal(list[1].groupId, 'g-aaa');
  assert.equal(list[1].pinned, true);
  assert.equal(list[2].archived, true);
});

test('VORG-03 writing back organization data: entries missing from this manifest are kept as is (not lost when the list is temporarily unavailable)', () => {
  const org = withProjects(EMPTY_ORG, [{ id: 'a', realm: C, groupId: null }, { id: 'b', realm: C, groupId: null }]);
  const next = withProjects(org, [{ id: 'b', realm: C, groupId: null, pinned: true }]);
  assert.deepEqual(next.projects.map((p) => p.id), ['b', 'a']);
  assert.equal(next.projects[0].pinned, true);
  assert.notEqual(next, org, '换新对象,不原地改');
  assert.equal(org.projects[1].pinned, undefined);
});

test('VORG-04 deleting a group: its projects return to ungrouped; moving to a nonexistent group also counts as moving out', () => {
  let { org, id } = addGroup(EMPTY_ORG, '  ');
  assert.equal(org.groups[0].name, 'New group');
  const p1 = { id: 'p1', realm: C };
  org = moveProject(org, p1, id).org;
  assert.equal(org.projects[0].groupId, id);
  org = withGroups(org, []);
  assert.equal(org.projects[0].groupId, null);
  org = moveProject(org, p1, 'nope').org;
  assert.equal(org.projects[0].groupId, null);
});

test('VORG-05 data stored on this machine is corrupted: treated as never recorded, no throw', () => {
  assert.deepEqual(parseOrg('{not json', C), EMPTY_ORG);
  assert.deepEqual(parseOrg(null, C), EMPTY_ORG);
  const odd = parseOrg(JSON.stringify({ groups: [{ id: 'g', name: 'x' }, { id: 3 }], projects: [{ id: 'p', groupId: 'missing', pinned: 'yes' }], chats: [{ id: 'c' }] }), C);
  assert.deepEqual(odd.groups, [{ id: 'g', name: 'x' }]);
  assert.deepEqual(odd.projects, [{ id: 'p', groupId: null }]);
  assert.deepEqual(odd.chats, []);
});

test('VORG-06 other people\'s private chats are not listed; the creator can view them read-only; your own private chats are listed as usual', () => {
  const items = [
    { id: 'c1', title: 'shared', state: 'idle', visibility: 'shared', ownerAccountId: 'bob' },
    { id: 'c2', title: 'My private', state: 'idle', visibility: 'private', ownerAccountId: 'me' },
    { id: 'c3', title: 'bob\'s private', state: 'running', visibility: 'private', ownerAccountId: 'bob' },
    { id: 'c4', title: '', state: 'failed' },
  ];
  const member = viewableChats(items, { accountId: 'me', creator: false }, 'p1');
  assert.deepEqual(member.map((c) => c.id), ['c1', 'c2', 'c4']);
  assert.ok(member.every((c) => !c.readOnly));
  assert.equal(member[2].name, 'Cloud chat');
  const creator = viewableChats(items, { accountId: 'me', creator: true }, 'p1');
  assert.deepEqual(creator.map((c) => c.id), ['c1', 'c2', 'c3', 'c4']);
  assert.equal(creator.find((c) => c.id === 'c3').readOnly, true);
  const nobody = viewableChats(items, { accountId: null, creator: false }, 'p1');
  assert.deepEqual(nobody.map((c) => c.id), ['c1', 'c4'], 'When the account could not be fetched, other people\'s private chats are never listed');
});

test('VORG-07 chat pins and archives are recorded separately per project', () => {
  const chats = viewableChats([{ id: 'a', title: 'A', state: 'idle' }, { id: 'b', title: 'B', state: 'idle' }], { accountId: 'me', creator: false }, 'p1');
  let org = withChats(EMPTY_ORG, 'p1', [{ id: 'b', pinned: true }, { id: 'a', archived: true }]);
  org = withChats(org, 'p2', [{ id: 'a', pinned: true }]);
  const merged = mergeChats(org, 'p1', chats);
  assert.deepEqual(merged.map((c) => [c.id, !!c.pinned, !!c.archived]), [['b', true, false], ['a', false, true]]);
});
