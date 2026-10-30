import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CardTaskScheduler, CARD_PRIORITY as P } from '../card-scheduler.mjs';
const defer = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { resolve, promise }; };
test('required work interrupts speculative scene work at a safe frame boundary', async () => {
  const release = defer(), started = defer(), published = [];
  const queue = new CardTaskScheduler();
  const scene = queue.submit({ key: 'scene', owner: 'p', revision: '1', priority: P.scene,
    run: async function* () { started.resolve(); await release.promise; yield 'scene-0'; yield 'scene-1'; }, publish: async x => { published.push(x); } });
  await started.promise;
  const control = queue.submit({ key: 'control', owner: 'p', revision: '1', priority: P.control,
    run: async function* () { yield 'control'; }, publish: async x => { published.push(x); } });
  const required = queue.submit({ key: 'required', owner: 'p', revision: '1', priority: P.required,
    run: async function* () { yield 'required'; }, publish: async x => { published.push(x); } });
  release.resolve(); await Promise.all([scene, control, required]);
  assert.deepEqual(published, ['scene-0', 'required', 'control', 'scene-1']);
  await queue.close();
});
test('an old worker result cannot publish after the project revision changes', async () => {
  const release = defer(), started = defer(), published = [];
  const queue = new CardTaskScheduler();
  const old = queue.submit({ key: 'old', owner: 'p', revision: '1', priority: P.required,
    run: async function* () { started.resolve(); await release.promise; yield 'stale'; }, publish: async x => { published.push(x); } });
  const rejected = assert.rejects(old, { code: 'CARD_CANCELLED' });
  await started.promise; queue.setRevision('p', '2'); release.resolve(); await rejected;
  await queue.submit({ key: 'new', owner: 'p', revision: '2', priority: P.required,
    run: async function* () { yield 'fresh'; }, publish: async x => { published.push(x); } });
  assert.deepEqual(published, ['fresh']); await queue.close();
});
test('independent workers can execute concurrently within the bounded pool', async () => {
  const release = defer(), two = defer(); let active = 0, peak = 0;
  const queue = new CardTaskScheduler({ concurrency: 2 });
  const jobs = [1, 2, 3].map(n => queue.submit({ key: String(n), owner: 'p', revision: '1', priority: P.control,
    run: async function* () { active++; peak = Math.max(peak, active); if (active === 2) two.resolve(); await release.promise; active--; yield n; } }));
  await two.promise; assert.equal(peak, 2); release.resolve(); await Promise.all(jobs); assert.equal(peak, 2); await queue.close();
});
test('a same-owner required stage waits for a low stage safe yield even in a wide pool', async () => {
  const release = defer(), lowStarted = defer(), order = [];
  const queue = new CardTaskScheduler({ concurrency: 2 });
  const low = queue.submit({ key: 'low', owner: 'one', revision: '1', priority: P.scene,
    run: async function* () { lowStarted.resolve(); await release.promise; yield 'boundary'; order.push('low-resumed'); },
    publish: async () => order.push('low-boundary') });
  await lowStarted.promise;
  const required = queue.submit({ key: 'required', owner: 'one', revision: '1', priority: P.required,
    run: async function* () { order.push('required-run'); yield 'required'; }, publish: async () => order.push('required-published') });
  await Promise.resolve();
  assert.deepEqual(order, []);
  release.resolve(); await Promise.all([low, required]);
  assert.deepEqual(order, ['low-boundary', 'required-run', 'required-published', 'low-resumed']);
  await queue.close();
});
