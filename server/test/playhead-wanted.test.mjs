/**
 * Unit test on the mirror store side for C4's `wanted` (playhead gap hint).
 * Run: node --test server/test/playhead-wanted.test.mjs
 *
 * "Must change in four places; miss one and `wanted` is silently dropped": this covers the first
 * place (the `setPlayhead` whitelist). The forwarder is in `vite-plugin-mirror.ts`, the two on the
 * page side are in `dataMirror.ts`, and the end-to-end pass is in
 * `scripts/probes/ready-index-probe.mjs`.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMirrorStore, MAX_WANTED } from '../mirror-store.mjs';

const PROJECT = { id: 'p', name: 'demo', width: 1920, height: 1080, fps: 30, duration: 10, tracks: [] };

test('setPlayhead accepts wanted, at most 8 entries, bad entries are dropped', () => {
  const store = createMirrorStore();
  store.pushFull({ session: 's1', localRev: 1, project: PROJECT });

  const head = store.setPlayhead('s1', 1.5, true, [{ clipId: 'a', frame: 45 }, { clipId: 'b', frame: 45 }]);
  assert.deepEqual(head.wanted, [{ clipId: 'a', frame: 45 }, { clipId: 'b', frame: 45 }]);
  assert.deepEqual(store.latestPlayhead().wanted, head.wanted);

  // Drop bad entries directly so a single NaN does not invalidate the entire hint (it is a hint, not a queue)
  const cleaned = store.setPlayhead('s1', 1.5, true, [
    { clipId: 'a', frame: 1.5 }, { clipId: '', frame: 3 }, { clipId: 'b', frame: -1 },
    { clipId: 'c', frame: 3 }, null,
  ]);
  assert.deepEqual(cleaned.wanted, [{ clipId: 'c', frame: 3 }]);

  // C4 original: at most 8 entries
  assert.equal(MAX_WANTED, 8);
  const many = store.setPlayhead('s1', 1.5, true, Array.from({ length: 20 }, (_, i) => ({ clipId: `c${i}`, frame: i })));
  assert.equal(many.wanted.length, MAX_WANTED);
  assert.deepEqual(many.wanted.at(-1), { clipId: 'c7', frame: 7 });
});

test('The existing playhead push path behaves unchanged and does not wipe the previous hint', () => {
  const store = createMirrorStore();
  store.pushFull({ session: 's1', localRev: 1, project: PROJECT });
  store.setPlayhead('s1', 1.5, true, [{ clipId: 'a', frame: 45 }]);
  // The pass without wanted (reporting the current time once upon pausing) remains as before
  const plain = store.setPlayhead('s1', 2.5, false);
  assert.equal(plain.t, 2.5);
  assert.equal(plain.playing, false);
  // During scrubbing the two paths send alternately; if wiped, prerender will never read the hint
  assert.deepEqual(plain.wanted, [{ clipId: 'a', frame: 45 }]);
  assert.deepEqual(store.setPlayhead('s1', 0, false, []).wanted, [{ clipId: 'a', frame: 45 }], 'An empty array is treated as "not reported this time"');
  // A session that has never reported wanted is undefined, not an empty array
  store.pushFull({ session: 's2', localRev: 1, project: PROJECT });
  assert.equal(store.setPlayhead('s2', 0, false).wanted, undefined);
  assert.throws(() => store.setPlayhead('', 0, false), /session/);
});
