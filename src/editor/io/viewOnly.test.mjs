/**
 * Read-only switch (`viewOnly.ts`): besides `?observe`, having only read-only permissions in a
 * project (guest entering someone else's project) also counts as read-only.
 *
 * Run: npm test -- src/editor/io/viewOnly.test.mjs
 */
import '../../testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

const { isViewOnly, projectAccessNow, setProjectAccess, viewOnlyReason, viewOnlyText } = await import('./viewOnly.ts');

test('A project with read-only permission counts as read-only, a read-write one does not; leaving the project returns to unknown', () => {
  setProjectAccess(null);
  assert.equal(isViewOnly(), false, 'Node has no location and no project was entered, so it should not be read-only');
  assert.equal(viewOnlyReason(), null);

  setProjectAccess('r');
  assert.equal(isViewOnly(), true);
  assert.equal(viewOnlyReason(), 'read-only-member');
  assert.equal(projectAccessNow(), 'r');
  assert.match(viewOnlyText(), /You can only view this project/);

  setProjectAccess('rw');
  assert.equal(isViewOnly(), false);
  assert.equal(viewOnlyReason(), null);

  // Invalid inputs are treated as not entering project; do not quietly stay in read-only state of
  // previous project
  setProjectAccess('nonsense');
  assert.equal(projectAccessNow(), null);
  assert.equal(isViewOnly(), false);
  setProjectAccess(null);
});

test('The two kinds of read-only say different things: opened read-only by yourself vs this project did not give you write permission', () => {
  setProjectAccess('r');
  const member = viewOnlyText();
  setProjectAccess(null);
  const observe = viewOnlyText();
  assert.notEqual(member, observe);
  assert.match(observe, /read-only view mode/);
});
