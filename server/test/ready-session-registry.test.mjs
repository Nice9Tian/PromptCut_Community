/**
 * Item 4 Option A: Session version registration for the editor process, and preload replay after
 * prerender process restart.
 * Run: node --test server/test/ready-session-registry.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadySessionRegistry, replayReadySessions, READY_REGISTRY_MAX } from '../ready-session-registry.mjs';

test('registration: for one session only the largest localRev is kept (out-of-order reports do not go backwards); the default session and ones without a localRev are not registered', () => {
  const registry = createReadySessionRegistry();
  assert.equal(registry.record('s', 3), true);
  assert.equal(registry.record('s', 2), false, 'a late-arriving old version does not go backwards');
  assert.equal(registry.record('s', 5), true);
  assert.equal(registry.record('', 9), false, 'the default session has no mirror and cannot be replayed');
  assert.equal(registry.record('t', undefined), false);
  assert.equal(registry.record('t', 'x'), false);
  assert.deepEqual(registry.list().map(({ session, localRev }) => [session, localRev]), [['s', 5]]);
});

test('registration: the most recently reported goes first; when over the limit, the one untouched the longest is dropped', () => {
  let now = 0;
  const registry = createReadySessionRegistry({ max: 3, now: () => ++now });
  for (const id of ['a', 'b', 'c']) registry.record(id, 1);
  registry.record('a', 2);                                   // a was just active
  registry.record('d', 1);                                   // Exceeded limit: drop b, which has been inactive the longest
  assert.deepEqual(registry.list().map(item => item.session), ['d', 'a', 'c']);
  assert.equal(READY_REGISTRY_MAX, 64);
});

test('replay: serial, only one preload in flight at a time; the most recently active first; those not in the mirror are skipped, and ones that slid out of the window fall back to the latest version', async () => {
  const registry = createReadySessionRegistry();
  registry.record('old', 4);
  registry.record('gone', 1);
  registry.record('fresh', 7);
  const mirror = { fresh: [5, 6, 7], old: [9, 10] };          // The 4 recorded in old has already slid out of the window
  let flying = 0, peak = 0;
  const sent = [];
  const results = await replayReadySessions({
    sessions: registry.list(),
    resolve: (session, localRev) => {
      const revs = mirror[session];
      if (!revs) return null;
      return revs.includes(localRev) ? localRev : revs.at(-1);
    },
    preload: async ({ session, localRev }) => {
      flying++; peak = Math.max(peak, flying);
      await new Promise(resolve => setTimeout(resolve, 5));
      sent.push([session, localRev]);
      flying--;
      return { ok: true, status: 'queued' };
    },
  });
  assert.equal(peak, 1, 'no concurrency: a freshly started prerender process is not flooded all at once');
  assert.deepEqual(sent, [['fresh', 7], ['old', 10]]);
  assert.deepEqual(results.map(r => r.skipped ?? r.ok), [true, 'no-mirror', true]);
});

test('replay: one session failing does not affect the ones after it; stops when the prerender process has restarted again', async () => {
  const sessions = [{ session: 'a', localRev: 1 }, { session: 'b', localRev: 1 }, { session: 'c', localRev: 1 }];
  let current = true;
  const sent = [];
  const results = await replayReadySessions({
    sessions,
    resolve: (_s, localRev) => localRev,
    preload: async ({ session }) => {
      sent.push(session);
      if (session === 'a') throw new Error('409');
      current = false;                                         // After sending b, it crashed again
      return { ok: true };
    },
    isCurrent: () => current,
  });
  assert.deepEqual(sent, ['a', 'b']);
  assert.deepEqual(results.map(r => r.skipped ?? r.ok), [false, true, 'superseded']);
});

test('replay cap: only the few most recently active sessions are replayed (tabs closed long ago do not waste background work)', async () => {
  const { READY_REPLAY_MAX } = await import('../ready-session-registry.mjs');
  let now = 0;
  const registry = createReadySessionRegistry({ now: () => ++now });
  for (let i = 0; i < READY_REPLAY_MAX + 3; i++) registry.record(`s${i}`, 1);
  const sent = [];
  await replayReadySessions({ sessions: registry.list(), resolve: (_s, r) => r, preload: async ({ session }) => { sent.push(session); return { ok: true }; } });
  assert.equal(sent.length, READY_REPLAY_MAX);
  assert.equal(sent[0], `s${READY_REPLAY_MAX + 2}`, 'the most recently active first');
});
