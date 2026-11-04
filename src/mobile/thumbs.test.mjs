/**
 * Queue and cache for mobile app thumbnails (`thumbs.ts`): on-demand, rate limiting, caching,
 * cancellation, failures not recorded, no refetching on ticket rotation.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThumbLoader, thumbKey, seekTarget, fitSize, urlHash, fetchableNow } from './thumbs.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Mock decoding: records each call; the test determines when it succeeds / fails */
function fakeGrab() {
  const calls = [];
  const grab = (url, kind, t) => new Promise((resolve, reject) => calls.push({ url, kind, t, resolve, reject }));
  return { calls, grab };
}

test('TH1 cache key strips the ticket query string; video includes the frame-grab time, image does not', () => {
  assert.equal(thumbKey('/media-s/a/media/abc?t=T1', 'video', 0), thumbKey('/media-s/a/media/abc?t=T2', 'video', 0));
  assert.notEqual(thumbKey('/m/abc?t=1', 'video', 0), thumbKey('/m/abc?t=1', 'video', 1.5));
  assert.equal(thumbKey('/m/img?t=1', 'image', 3), '/m/img');
});

test('TH2 frame-grab time is clamped within the asset duration, 0 is replaced by a tiny positive number', () => {
  assert.equal(seekTarget(0, 10), 0.001);
  assert.equal(seekTarget(-3, 10), 0.001);
  assert.equal(seekTarget(4, 10), 4);
  assert.ok(seekTarget(99, 10) < 10);
  assert.equal(seekTarget(2, NaN), 2);
});

test('TH3 thumbnails keep the aspect ratio and are never upscaled', () => {
  assert.deepEqual(fitSize(1920, 1080, 224), { w: 224, h: 126 });
  assert.deepEqual(fitSize(100, 50, 224), { w: 100, h: 50 });
  assert.deepEqual(fitSize(0, 50, 224), { w: 0, h: 0 });
});

test('TH4 at most maxActive decode at once, the rest queue; as one finishes, the next starts', async () => {
  const g = fakeGrab();
  const L = createThumbLoader({ grab: g.grab, maxActive: 2 });
  const got = [];
  for (let i = 0; i < 5; i++) L.request(`/m/${i}?t=x`, 'video', 0, (v) => got.push([i, v]));
  assert.equal(g.calls.length, 2);
  assert.deepEqual(L.stats(), { queued: 3, active: 2, cached: 0 });
  g.calls[0].resolve('data:0');
  await tick(); await tick();
  assert.equal(g.calls.length, 3);
  assert.deepEqual(got, [[0, 'data:0']]);
});

test('TH5 cached items are returned directly without decoding again; still a hit after the ticket changes', async () => {
  const g = fakeGrab();
  const L = createThumbLoader({ grab: g.grab, maxActive: 1 });
  let a = null;
  L.request('/m/x?t=old', 'image', 0, (v) => { a = v; });
  g.calls[0].resolve('data:x');
  await tick(); await tick();
  assert.equal(a, 'data:x');
  let b = null;
  L.request('/m/x?t=new', 'image', 0, (v) => { b = v; });
  assert.equal(b, 'data:x');
  assert.equal(g.calls.length, 1);
});

test('TH6 still queued and nobody wants it anymore (scrolled out of the viewport): cancel without decoding', async () => {
  const g = fakeGrab();
  const L = createThumbLoader({ grab: g.grab, maxActive: 1 });
  L.request('/m/a', 'video', 0, () => {});
  const cancel = L.request('/m/b', 'video', 0, () => assert.fail('A cancelled request must not call back'));
  cancel();
  assert.equal(L.stats().queued, 0);
  g.calls[0].resolve('data:a');
  await tick(); await tick();
  assert.equal(g.calls.length, 1, 'Cancelled b was not decoded');
});

test('TH7 two places requesting the same image decode it only once; if one cancels, the other still gets it', async () => {
  const g = fakeGrab();
  const L = createThumbLoader({ grab: g.grab, maxActive: 1 });
  L.request('/m/busy', 'video', 0, () => {});
  const c1 = L.request('/m/same', 'video', 0, () => {});
  let got = null;
  L.request('/m/same?t=2', 'video', 0, (v) => { got = v; });
  c1();
  g.calls[0].resolve('data:busy');
  await tick(); await tick();
  assert.equal(g.calls.length, 2);
  g.calls[1].resolve('data:same');
  await tick(); await tick();
  assert.equal(got, 'data:same');
});

test('TH8 failure gives null and is not cached, the next request retries', async () => {
  const g = fakeGrab();
  const L = createThumbLoader({ grab: g.grab, maxActive: 1 });
  let a = 'unset';
  L.request('/m/bad', 'video', 0, (v) => { a = v; });
  g.calls[0].reject(new Error('cannot decode'));
  await tick(); await tick();
  assert.equal(a, null);
  assert.equal(L.stats().cached, 0);
  L.request('/m/bad', 'video', 0, () => {});
  assert.equal(g.calls.length, 2, 'Requesting again after a failure decodes again');
});

test('TH9 cache beyond the limit evicts by least recent use', async () => {
  const g = fakeGrab();
  const L = createThumbLoader({ grab: g.grab, maxActive: 3, cacheMax: 2 });
  for (const k of ['a', 'b']) L.request(`/m/${k}`, 'image', 0, () => {});
  g.calls[0].resolve('data:a'); g.calls[1].resolve('data:b');
  await tick(); await tick();
  assert.equal(L.peek('/m/a'), 'data:a'); // a becomes most recently used
  L.request('/m/c', 'image', 0, () => {});
  g.calls[2].resolve('data:c');
  await tick(); await tick();
  assert.equal(L.stats().cached, 2);
  assert.equal(L.peek('/m/b'), null, 'The least recently used b was evicted');
  assert.equal(L.peek('/m/a'), 'data:a');
});

test('TH10 when the same image is obtained elsewhere, those waiting for it also receive it (the one that failed first need not wait for a retry)', async () => {
  const g = fakeGrab();
  const L = createThumbLoader({ grab: g.grab, maxActive: 1 });
  const seen = [];
  const off = L.watch(thumbKey('/m/v?t=1', 'video', 0), (v) => seen.push(v));
  L.request('/m/v?t=2', 'video', 0, () => {});
  g.calls[0].resolve('data:v');
  await tick(); await tick();
  assert.deepEqual(seen, ['data:v']);
  off();
  L.request('/m/w', 'video', 0, () => {});
  g.calls[1].resolve('data:w');
  await tick(); await tick();
  assert.deepEqual(seen, ['data:v'], 'No more callbacks after unsubscribing');
});

test('TH11 assets not fully received are not fetched yet: the criterion only consults the asset service\'s fully-received set', () => {
  const h = 'a'.repeat(64), g = 'b'.repeat(64);
  const url = `/media-s/s1/media/${h}?t=tk`;
  assert.equal(urlHash(url), h);
  assert.equal(urlHash(`/@media/${g}.mp4`), g);
  assert.equal(urlHash('/assets/x.png'), null);
  assert.equal(fetchableNow(url, ['@known:remote', g], false), false, 'Asked and it is not in the set: do not fetch');
  assert.equal(fetchableNow(url, ['@known:remote', h], true), true, 'In the set, so fetch (pending is ignored)');
  assert.equal(fetchableNow(url, [], true), false, 'Not asked yet and still being ingested: wait');
  assert.equal(fetchableNow(url, [], false), true, 'Not asked yet and not being ingested: fetch first');
  assert.equal(fetchableNow('/assets/x.png', ['@known:remote'], true), true, 'Old assets not addressed by hash are fetched as usual');
  assert.equal(fetchableNow(url, ['@known:remote', g], false, g.toUpperCase()), true, 'Fetching the small size and the original size is fully received: fetch');
});
