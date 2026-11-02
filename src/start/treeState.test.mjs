/**
 * Sorting, pinning, archiving, renaming, and deleting in the sidebar tree (`src/start/treeState.ts`).
 * Run: node --test src/start/treeState.test.mjs
 *
 * The key point is "**pinning and sorting only take effect within their own level**" (user
 * decision, 2026-10-23): TREE-04 and TREE-08 track this.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ordered, visible, reorder, togglePin, setArchived, rename, removeById } from './treeState.ts';

/** Projects: same level is determined by group; items not in a group form their own level */
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
  // When none is pinned, order remains as is
  assert.deepEqual(ids(ordered([{ id: 'a' }, { id: 'b' }])), ['a', 'b']);
});

test('TREE-02 visible: archived items stay out of the tree', () => {
  const list = [{ id: 'a' }, { id: 'b', archived: true }, { id: 'c', archived: false }];
  assert.deepEqual(ids(visible(list)), ['a', 'c']);
});

test('TREE-03 reorder: among siblings, items land by before / after', () => {
  // In g1, move b before a
  assert.deepEqual(ids(reorder(projects(), sibOf, 'b', 'a', 'before')), ['b', 'a', 'c', 'd', 'e']);
  // In g2, move c after d
  assert.deepEqual(ids(reorder(projects(), sibOf, 'c', 'd', 'after')), ['a', 'b', 'd', 'c', 'e']);
});

test('TREE-04 reorder: items at different levels are never moved (ordering only within the same level)', () => {
  const before = projects();
  // a in g1, c in g2: cross-group not accepted
  assert.deepEqual(ids(reorder(before, sibOf, 'a', 'c', 'before')), ids(before));
  // e not in a group and a in g1 are not at the same level either
  assert.deepEqual(ids(reorder(before, sibOf, 'e', 'a', 'after')), ids(before));
  // Drag onto itself, drag a nonexistent id: both return as is
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
  assert.equal(rename(projects(), 'a', '  New name  ').find((x) => x.id === 'a').name, 'New name');
  // When all whitespace, return as is (handled as "Cancel" in UI)
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
  const all = togglePin(projects(), 'd'); // d in g2
  const inG1 = ordered(all.filter((p) => p.groupId === 'g1'));
  const inG2 = ordered(all.filter((p) => p.groupId === 'g2'));
  const loose = ordered(all.filter((p) => p.groupId === null));
  assert.deepEqual(ids(inG2), ['d', 'c'], 'd moved to the top in g2');
  assert.deepEqual(ids(inG1), ['a', 'b'], 'g1 is completely unchanged');
  assert.deepEqual(ids(loose), ['e'], 'The ungrouped level is unchanged too');

  // Groups sort within their own level, independent of project pinning
  const groups = [{ id: 'g1' }, { id: 'g2', pinned: true }];
  assert.deepEqual(ids(ordered(groups)), ['g2', 'g1']);
});
