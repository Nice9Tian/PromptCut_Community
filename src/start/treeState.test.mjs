/**
 * 侧栏那棵树的排序、置顶、归档、改名、删除(`src/start/treeState.ts`)。
 * 跑:node --test src/start/treeState.test.mjs
 *
 * 重点是「**置顶和排序都只在自己同级里生效**」这一条(用户 2026-10-23 定):TREE-04 和 TREE-08 盯的就是它。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ordered, visible, reorder, togglePin, setArchived, rename, removeById } from './treeState.ts';

/** 项目:同级按所属分组算,没放进分组的自成一级 */
const sibOf = (p) => `project:${p.groupId ?? 'loose'}`;

const projects = () => [
  { id: 'a', name: 'A', groupId: 'g1' },
  { id: 'b', name: 'B', groupId: 'g1' },
  { id: 'c', name: 'C', groupId: 'g2' },
  { id: 'd', name: 'D', groupId: 'g2' },
  { id: 'e', name: 'E', groupId: null },
];

const ids = (list) => list.map((x) => x.id);

test('TREE-01 ordered: pinned items come first, and each of the two parts keeps its original order', () => {
  const list = [
    { id: 'a' }, { id: 'b', pinned: true }, { id: 'c' }, { id: 'd', pinned: true },
  ];
  assert.deepEqual(ids(ordered(list)), ['b', 'd', 'a', 'c']);
  // 一个都没置顶时顺序原样
  assert.deepEqual(ids(ordered([{ id: 'a' }, { id: 'b' }])), ['a', 'b']);
});

test('TREE-02 visible: archived items stay out of the tree', () => {
  const list = [{ id: 'a' }, { id: 'b', archived: true }, { id: 'c', archived: false }];
  assert.deepEqual(ids(visible(list)), ['a', 'c']);
});

test('TREE-03 reorder: among siblings, items land by before / after', () => {
  // g1 里把 b 挪到 a 前面
  assert.deepEqual(ids(reorder(projects(), sibOf, 'b', 'a', 'before')), ['b', 'a', 'c', 'd', 'e']);
  // g2 里把 c 挪到 d 后面
  assert.deepEqual(ids(reorder(projects(), sibOf, 'c', 'd', 'after')), ['a', 'b', 'd', 'c', 'e']);
});

test('TREE-04 reorder: items at different levels are never moved (ordering only within the same level)', () => {
  const before = projects();
  // a 在 g1、c 在 g2:跨分组不接
  assert.deepEqual(ids(reorder(before, sibOf, 'a', 'c', 'before')), ids(before));
  // 没放进分组的 e 和 g1 里的 a 也不是同级
  assert.deepEqual(ids(reorder(before, sibOf, 'e', 'a', 'after')), ids(before));
  // 拖到自己身上、拖一个不存在的 id,都原样返回
  assert.deepEqual(ids(reorder(before, sibOf, 'a', 'a', 'before')), ids(before));
  assert.deepEqual(ids(reorder(before, sibOf, 'zzz', 'a', 'before')), ids(before));
});

test('TREE-05 togglePin: toggles back and forth, and does not mutate the original object in place', () => {
  const before = projects();
  const once = togglePin(before, 'b');
  assert.equal(once.find((x) => x.id === 'b').pinned, true);
  assert.equal(before.find((x) => x.id === 'b').pinned, undefined, 'Objects in the original array must not be modified');
  assert.notEqual(once, before);
  assert.equal(togglePin(once, 'b').find((x) => x.id === 'b').pinned, false);
});

test('TREE-06 rename: trims leading and trailing whitespace; a blank name is rejected', () => {
  assert.equal(rename(projects(), 'a', '  New name  ').find((x) => x.id === 'a').name, '新名字');
  // 全是空白时原样返回(界面上按「取消」处理)
  const before = projects();
  assert.deepEqual(rename(before, 'a', '   ').map((x) => x.name), before.map((x) => x.name));
});

test('TREE-07 setArchived / removeById', () => {
  const archived = setArchived(projects(), 'c', true);
  assert.equal(archived.find((x) => x.id === 'c').archived, true);
  assert.deepEqual(ids(visible(archived)), ['a', 'b', 'd', 'e']);
  assert.equal(setArchived(archived, 'c', false).find((x) => x.id === 'c').archived, false);
  assert.deepEqual(ids(removeById(projects(), 'c')), ['a', 'b', 'd', 'e']);
});

test('TREE-08 pinning only applies within its own level: pinning a project in a group affects neither other groups nor the group level', () => {
  const all = togglePin(projects(), 'd'); // d 在 g2
  const inG1 = ordered(all.filter((p) => p.groupId === 'g1'));
  const inG2 = ordered(all.filter((p) => p.groupId === 'g2'));
  const loose = ordered(all.filter((p) => p.groupId === null));
  assert.deepEqual(ids(inG2), ['d', 'c'], 'd moved to the top in g2');
  assert.deepEqual(ids(inG1), ['a', 'b'], 'g1 is completely unchanged');
  assert.deepEqual(ids(loose), ['e'], 'The ungrouped level is unchanged too');

  // 分组这一层自己排序,和项目的置顶互不相干
  const groups = [{ id: 'g1' }, { id: 'g2', pinned: true }];
  assert.deepEqual(ids(ordered(groups)), ['g2', 'g1']);
});
