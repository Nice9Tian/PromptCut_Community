/**
 * 只读开关（`viewOnly.ts`）：`?observe` 之外，项目只给了只读权限（游客进别人的项目）也算只读。
 *
 * 跑：npm test -- src/editor/io/viewOnly.test.mjs
 */
import '../../testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const { isViewOnly, projectAccessNow, setProjectAccess, viewOnlyReason, viewOnlyText } = await import('./viewOnly.ts');

test('只读权限的项目按只读算，读写的不算；离开项目回到不知道', () => {
  setProjectAccess(null);
  assert.equal(isViewOnly(), false, 'Node 里没有 location，也没进项目，不该是只读');
  assert.equal(viewOnlyReason(), null);

  setProjectAccess('r');
  assert.equal(isViewOnly(), true);
  assert.equal(viewOnlyReason(), 'read-only-member');
  assert.equal(projectAccessNow(), 'r');
  assert.match(viewOnlyText(), /只能查看/);

  setProjectAccess('rw');
  assert.equal(isViewOnly(), false);
  assert.equal(viewOnlyReason(), null);

  // 乱传的当没进项目,不要悄悄留在上一个项目的只读状态里
  setProjectAccess('nonsense');
  assert.equal(projectAccessNow(), null);
  assert.equal(isViewOnly(), false);
  setProjectAccess(null);
});

test('两种只读说的话不一样：自己用只读方式打开 vs 这个项目没给你写的权限', () => {
  setProjectAccess('r');
  const member = viewOnlyText();
  setProjectAccess(null);
  const observe = viewOnlyText();
  assert.notEqual(member, observe);
  assert.match(observe, /只读查看模式/);
});
