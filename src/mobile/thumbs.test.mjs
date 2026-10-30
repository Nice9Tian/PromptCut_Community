/**
 * 手机版缩略图的队列与缓存(`thumbs.ts`):按需、限流、缓存、撤销、失败不记、票据轮换不重取。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createThumbLoader, thumbKey, seekTarget, fitSize, urlHash, fetchableNow } from './thumbs.ts';

const tick = () => new Promise((r) => setTimeout(r, 0));

/** 假的解码:每次调用记下来,由测试决定什么时候成功 / 失败 */
function fakeGrab() {
  const calls = [];
  const grab = (url, kind, t) => new Promise((resolve, reject) => calls.push({ url, kind, t, resolve, reject }));
  return { calls, grab };
}

test('TH1 缓存键去掉票据查询串;视频带取帧时刻,图片不带', () => {
  assert.equal(thumbKey('/media-s/a/media/abc?t=T1', 'video', 0), thumbKey('/media-s/a/media/abc?t=T2', 'video', 0));
  assert.notEqual(thumbKey('/m/abc?t=1', 'video', 0), thumbKey('/m/abc?t=1', 'video', 1.5));
  assert.equal(thumbKey('/m/img?t=1', 'image', 3), '/m/img');
});

test('TH2 取帧时刻钳在素材时长里,0 换成极小正数', () => {
  assert.equal(seekTarget(0, 10), 0.001);
  assert.equal(seekTarget(-3, 10), 0.001);
  assert.equal(seekTarget(4, 10), 4);
  assert.ok(seekTarget(99, 10) < 10);
  assert.equal(seekTarget(2, NaN), 2);
});

test('TH3 缩图保持比例、不放大', () => {
  assert.deepEqual(fitSize(1920, 1080, 224), { w: 224, h: 126 });
  assert.deepEqual(fitSize(100, 50, 224), { w: 100, h: 50 });
  assert.deepEqual(fitSize(0, 50, 224), { w: 0, h: 0 });
});

test('TH4 同时最多解码 maxActive 个,其余排队;做完一个补一个', async () => {
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

test('TH5 已缓存的直接给,不再解码;票据换了照样命中', async () => {
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

test('TH6 还在排队就没人要了(滑出视口):撤掉不解码', async () => {
  const g = fakeGrab();
  const L = createThumbLoader({ grab: g.grab, maxActive: 1 });
  L.request('/m/a', 'video', 0, () => {});
  const cancel = L.request('/m/b', 'video', 0, () => assert.fail('撤掉的不该回调'));
  cancel();
  assert.equal(L.stats().queued, 0);
  g.calls[0].resolve('data:a');
  await tick(); await tick();
  assert.equal(g.calls.length, 1, '撤掉的 b 没去解码');
});

test('TH7 两处要同一张只解码一次;一处撤了另一处照样拿到', async () => {
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

test('TH8 失败给 null、不记缓存,下次再要会重试', async () => {
  const g = fakeGrab();
  const L = createThumbLoader({ grab: g.grab, maxActive: 1 });
  let a = 'unset';
  L.request('/m/bad', 'video', 0, (v) => { a = v; });
  g.calls[0].reject(new Error('解不了'));
  await tick(); await tick();
  assert.equal(a, null);
  assert.equal(L.stats().cached, 0);
  L.request('/m/bad', 'video', 0, () => {});
  assert.equal(g.calls.length, 2, '失败后再要会重新解码');
});

test('TH9 缓存超过上限按最近使用淘汰', async () => {
  const g = fakeGrab();
  const L = createThumbLoader({ grab: g.grab, maxActive: 3, cacheMax: 2 });
  for (const k of ['a', 'b']) L.request(`/m/${k}`, 'image', 0, () => {});
  g.calls[0].resolve('data:a'); g.calls[1].resolve('data:b');
  await tick(); await tick();
  assert.equal(L.peek('/m/a'), 'data:a'); // a 变成最近用过
  L.request('/m/c', 'image', 0, () => {});
  g.calls[2].resolve('data:c');
  await tick(); await tick();
  assert.equal(L.stats().cached, 2);
  assert.equal(L.peek('/m/b'), null, '最久没用的 b 被淘汰');
  assert.equal(L.peek('/m/a'), 'data:a');
});

test('TH10 别处取到了同一张,等着它的也收到(先失败的那处不用等重试)', async () => {
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
  assert.deepEqual(seen, ['data:v'], '退订后不再回调');
});

test('TH11 没收全的素材先不取:判据只问素材服务的已收全集合', () => {
  const h = 'a'.repeat(64), g = 'b'.repeat(64);
  const url = `/media-s/s1/media/${h}?t=tk`;
  assert.equal(urlHash(url), h);
  assert.equal(urlHash(`/@media/${g}.mp4`), g);
  assert.equal(urlHash('/assets/x.png'), null);
  assert.equal(fetchableNow(url, ['@known:remote', g], false), false, '问过了而它不在集合里:不取');
  assert.equal(fetchableNow(url, ['@known:remote', h], true), true, '在集合里就取(pending 不管)');
  assert.equal(fetchableNow(url, [], true), false, '还没问过、还在入库:等');
  assert.equal(fetchableNow(url, [], false), true, '还没问过、不在入库:先取');
  assert.equal(fetchableNow('/assets/x.png', ['@known:remote'], true), true, '不是按哈希寻址的老素材照取');
  assert.equal(fetchableNow(url, ['@known:remote', g], false, g.toUpperCase()), true, '取的是小尺寸、原尺寸已收全:取');
});
