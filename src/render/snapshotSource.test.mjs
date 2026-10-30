/**
 * J3 快照来源接口的单测。跑:node --test src/render/snapshotSource.test.mjs
 *
 * 这一层是「页面怎么取快照」的唯一出口,所以钉住三件容易错的事:
 * 1. 本地档的 `key` 自带一个斜杠,URL 要**按段**编码(整编会变成 %2F,路由就配不上);
 * 2. `layer` 是全量语义 —— 应用到页面的表时整层替换,不能和旧区间合并;
 * 3. LRU 上限是 64 条,淘汰最久没用的那一条。
 *
 * 这个文件不跑 `HttpSnapshotSource` 的 SSE(浏览器 API),只测纯函数和缓存;
 * 端到端那一半在 `scripts/probes/ready-index-probe.mjs`。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyReadyMessage, layerOf, snapshotPath, RECONNECT_BACKOFF_MS, SNAPSHOT_CACHE_MAX } from './snapshotSource.ts';

test('snapshotPath encodes per segment so the local key keeps its slash', () => {
  assert.equal(snapshotPath('html', 'abc123', 7), '/api/frames/snapshot/html/abc123/7');
  // 本地档:`<entry.key>/<共享键>`,那个斜杠是路径分隔,不是键的一部分
  assert.equal(snapshotPath('local', 'ENTRY/SHARED', 0), '/api/frames/snapshot/local/ENTRY/SHARED/0');
  assert.notEqual(snapshotPath('local', 'ENTRY/SHARED', 0), '/api/frames/snapshot/local/ENTRY%2FSHARED/0');
  // 段里真有怪字符时照样编码
  assert.equal(snapshotPath('local', 'a b/c#d', 1), '/api/frames/snapshot/local/a%20b/c%23d/1');
});

test('applyReadyMessage: reset clears, layer replaces the whole table', () => {
  const index = new Map();
  applyReadyMessage(index, { type: 'layer', clipId: 'a', kind: 'html', key: 'K1', ranges: [[0, 3]] });
  applyReadyMessage(index, { type: 'layer', clipId: 'a', kind: 'stream', key: 'S1', ranges: [[0, 1]] });
  // 同一张卡两张表并存、互不覆盖
  assert.deepEqual(layerOf(index, 'a', 'html'), { clipId: 'a', kind: 'html', key: 'K1', ranges: [[0, 3]] });
  assert.deepEqual(layerOf(index, 'a', 'stream'), { clipId: 'a', kind: 'stream', key: 'S1', ranges: [[0, 1]] });
  // 全量语义:换键之后旧区间不许赖着
  applyReadyMessage(index, { type: 'layer', clipId: 'a', kind: 'html', key: 'K2', ranges: [[9, 9]] });
  assert.deepEqual(layerOf(index, 'a', 'html'), { clipId: 'a', kind: 'html', key: 'K2', ranges: [[9, 9]] });
  assert.equal(layerOf(index, 'b', 'html'), null);
  applyReadyMessage(index, { type: 'reset', localRev: 3 });
  assert.equal(index.size, 0);
  // 不认识的消息不动表
  applyReadyMessage(index, { type: 'done', localRev: 3 });
  assert.equal(index.size, 0);
});

test('fetchSnapshot caches by kind/key/frame, dedupes in-flight, and evicts LRU at 64', async () => {
  const { HttpSnapshotSource } = await import('./snapshotSource.ts');
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return { ok: true, status: 200, text: async () => `<i>${url}</i>` };
  };
  try {
    const source = new HttpSnapshotSource(async () => 'http://127.0.0.1:1234');
    const first = await source.fetchSnapshot('html', 'K', 0);
    assert.equal(first, '<i>http://127.0.0.1:1234/api/frames/snapshot/html/K/0</i>');
    await source.fetchSnapshot('html', 'K', 0);
    assert.equal(calls.length, 1, '命中缓存就不再飞');
    // 同一帧同时被两处要到时只飞一次
    calls.length = 0;
    await Promise.all([source.fetchSnapshot('html', 'K', 1), source.fetchSnapshot('html', 'K', 1)]);
    assert.equal(calls.length, 1);
    // 上限 64:灌满之后最早那一条被淘汰
    for (let n = 0; n < SNAPSHOT_CACHE_MAX + 4; n++) await source.fetchSnapshot('local', 'E/K', n);
    assert.equal(source.cacheSize, SNAPSHOT_CACHE_MAX);
    calls.length = 0;
    await source.fetchSnapshot('local', 'E/K', 0);
    assert.equal(calls.length, 1, '被淘汰的那一条要重新取');
    // 缺帧抛,不是回空串 —— 那一层按缺料处理
    globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '' });
    await assert.rejects(source.fetchSnapshot('html', 'MISSING', 0), /还没就绪/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('reconnect backoff is 1s / 2s / 4s / 8s and stays capped at 8s', () => {
  assert.deepEqual(RECONNECT_BACKOFF_MS, [1000, 2000, 4000, 8000]);
  const at = n => RECONNECT_BACKOFF_MS[Math.min(n, RECONNECT_BACKOFF_MS.length - 1)];
  assert.deepEqual([0, 1, 2, 3, 4, 20].map(at), [1000, 2000, 4000, 8000, 8000, 8000]);
});
