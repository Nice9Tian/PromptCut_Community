/**
 * Server-side accounting for playback keepalive: while the page is playing, it sends
 * `{session, t, playing: true}` (without `wanted`) every 2 seconds; the prerender process's
 * `streamBusy()` and queue node's `interactionReason()` remain busy throughout playback;
 * transitions to idle 5 seconds after keepalive stops. Do not change the server's 5-second
 * and 800 ms windows.
 * Run: node --test server/test/playhead-keepalive.test.mjs
 *
 * Clock uses `Date` from `mock.timers`: the mirror store's `setPlayhead` stamps `at` upon receipt,
 * and both busy checks read the same `at`.
 */
import test, { mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createMirrorStore } from '../mirror-store.mjs';
import { FramePipeline } from '../frame-pipeline.mjs';
import { interactionReason, PLAYING_STALE_MS } from '../queue-idle.mjs';

/** Page keepalive interval (`PLAYHEAD_KEEPALIVE_MS` in `src/render/dataMirror.ts`) */
const KEEPALIVE_MS = 2000;
const PROJECT = { id: 'p', name: 'demo', width: 1920, height: 1080, fps: 30, duration: 60, tracks: [] };

afterEach(() => { mock.timers.reset(); });

/** The few fields read only by `streamBusy` / `interactionReason` */
function fakePipeline(store) {
  return { closed: false, playback: null, backgroundYielding: false, backgroundLeaseUntil: 0, playhead: () => store.latestPlayhead(),
    streamBusy: FramePipeline.prototype.streamBusy };
}

/** Run `seconds` seconds from playback start, polling every 250 ms; send a keepalive every `KEEPALIVE_MS` before `keepaliveUntil` */
function simulate({ seconds, keepaliveUntil, wanted }) {
  mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
  const store = createMirrorStore();
  store.pushFull({ session: 's1', localRev: 1, project: PROJECT });
  const pipeline = fakePipeline(store);
  const started = Date.now();
  store.setPlayhead('s1', 0, true, wanted);
  const rows = [];
  let nextKeepalive = KEEPALIVE_MS;
  for (let elapsed = 0; elapsed <= seconds * 1000; elapsed += 250) {
    mock.timers.setTime(started + elapsed);
    if (elapsed >= nextKeepalive && elapsed <= keepaliveUntil) {
      store.setPlayhead('s1', elapsed / 1000, true); // Keepalive does not include wanted
      nextKeepalive += KEEPALIVE_MS;
    }
    const now = Date.now();
    rows.push({ elapsed, busy: pipeline.streamBusy(now), reason: interactionReason(pipeline, now), head: store.latestPlayhead() });
  }
  return { rows, store };
}

test('One keepalive every 2 seconds: during 30 seconds of playback, streamBusy and interactionReason stay busy throughout', () => {
  const { rows } = simulate({ seconds: 30, keepaliveUntil: 30_000 });
  const notBusy = rows.filter((r) => !r.busy);
  const notPlaying = rows.filter((r) => r.reason !== 'playing');
  assert.deepEqual(notBusy.map((r) => r.elapsed), [], 'streamBusy stays true throughout');
  assert.deepEqual(notPlaying.map((r) => r.elapsed), [], 'interactionReason stays playing throughout');
  assert.equal(rows.length, 30 * 4 + 1);
});

test('Control: without keepalive, it goes idle after 5 seconds (this is the bug itself)', () => {
  const { rows } = simulate({ seconds: 30, keepaliveUntil: -1 });
  assert.equal(rows.find((r) => r.elapsed === 4750).busy, true);
  assert.equal(rows.find((r) => r.elapsed === 5000).busy, false, 'The 5-second window has elapsed');
  assert.equal(rows.find((r) => r.elapsed === 5000).reason, null);
  assert.ok(rows.filter((r) => r.elapsed >= 5000).every((r) => !r.busy && r.reason === null));
});

test('Goes idle 5 seconds after keepalive stops; busy the whole time before that', () => {
  // Last keepalive at exactly 20 seconds
  const { rows } = simulate({ seconds: 30, keepaliveUntil: 20_000 });
  assert.ok(rows.filter((r) => r.elapsed <= 24_750).every((r) => r.busy && r.reason === 'playing'), 'Still busy within 5 seconds after the last keepalive');
  assert.equal(rows.find((r) => r.elapsed === 20_000 + PLAYING_STALE_MS).busy, false);
  assert.ok(rows.filter((r) => r.elapsed >= 20_000 + PLAYING_STALE_MS).every((r) => !r.busy && r.reason === null), 'Idle throughout afterwards');
});

test('Missing one keepalive tick (4 seconds of silence) does not expire it either; only two or more consecutive misses do', () => {
  mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
  const store = createMirrorStore();
  const pipeline = fakePipeline(store);
  const start = Date.now();
  store.setPlayhead('s1', 0, true);
  mock.timers.setTime(start + 4_000);
  assert.equal(pipeline.streamBusy(Date.now()), true, 'One keepalive tick missed (4-second gap)');
  store.setPlayhead('s1', 4, true);
  mock.timers.setTime(start + 9_000);
  assert.equal(pipeline.streamBusy(Date.now()), false, '5 seconds of silence');
});

test('Keepalive without wanted: reuses the previous gap hint, neither refreshing nor clearing it (same as the stop message)', () => {
  const wanted = [{ clipId: 'a', frame: 45 }];
  const { store } = simulate({ seconds: 10, keepaliveUntil: 10_000, wanted });
  const head = store.latestPlayhead();
  assert.deepEqual(head.wanted, wanted);
  assert.equal(head.playing, true);
  assert.ok(head.t > 0, 't follows the keepalive');
});

test('A stop push (playing:false) still turns into "just moved" immediately (streamBusy 800 ms, queue gate 500 ms), then goes idle', () => {
  mock.timers.enable({ apis: ['Date'], now: 5_000_000 });
  const store = createMirrorStore();
  const pipeline = fakePipeline(store);
  const start = Date.now();
  store.setPlayhead('s1', 0, true);
  mock.timers.setTime(start + 10_000);
  store.setPlayhead('s1', 10, false);
  mock.timers.setTime(start + 10_000 + 499);
  assert.equal(interactionReason(pipeline, Date.now()), 'scrub', 'The queue node gate is 500 ms');
  mock.timers.setTime(start + 10_000 + 799);
  assert.equal(pipeline.streamBusy(Date.now()), true);
  mock.timers.setTime(start + 10_000 + 800);
  assert.equal(pipeline.streamBusy(Date.now()), false);
});
