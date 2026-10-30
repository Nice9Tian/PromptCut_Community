import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginFrameWork, waitForFrameWork, frameWorkStatus } from './frameReady.ts';

test('the frame gate waits for every async control and includes newly registered work', async () => {
  const first = beginFrameWork('first');
  let done = false;
  const gate = waitForFrameWork().then(() => { done = true; });
  await Promise.resolve(); assert.equal(done, false);
  const second = beginFrameWork('second');
  first.ready();
  await Promise.resolve(); assert.equal(done, false);
  second.ready(); await gate;
  assert.deepEqual(frameWorkStatus(), []);
});
test('failed controls report a readable error; unmounted controls no longer block', async () => {
  const failed = beginFrameWork('Lottie');
  failed.fail(new Error('bad JSON'));
  await assert.rejects(waitForFrameWork(), /Lottie.*bad JSON/);
  failed.dispose();
  const old = beginFrameWork('old clip');
  const gate = waitForFrameWork(); old.dispose(); await gate;
  assert.deepEqual(frameWorkStatus(), []);
});
