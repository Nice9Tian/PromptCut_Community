/**
 * 疑点 F:页面换到下一版之后,**旧 entry** 攒着的那一批才交完 —— 照发的话页面刚清完表,
 * 又收到旧键的层,同一个 clipId 的新层被旧层整层替换(C3 是全量语义)。
 * Item 4 之后由 `publishLayer` 的闸门统一拦:只进当前版本正是这个 entry 的会话。
 * 跑:node --test server/test/ready-stale-flush.test.mjs
 *
 * 真的:`ready-index.mjs` 的 hub、`FramePipeline.prototype` 上的 `adoptSession` / `adoptCardPlan` /
 * `recordCardPlan` / `claimSessions` / `publishLayer` / `flushSnapshots`。
 * 假的:快照库的批(`close()` 直接回一份 index),不碰 Chrome、不碰盘。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { FramePipeline } from '../frame-pipeline.mjs';
import { createReadyHub } from '../ready-index.mjs';

const control = (clipId, snapshotKey) => ({ clipId, snapshotKey, tier: 'shared', capabilities: { frameMode: 'stateful', compositing: 'independent' } });
const fakeBatch = (clipId, key) => ({ clipId, key, tier: 'shared', entryKey: undefined, written: true, close: async () => ({ frames: [[0, 9]] }) });

function pipeline() {
  const p = Object.create(FramePipeline.prototype);
  p.ready = createReadyHub();
  p.root = undefined;
  return p;
}

test('换了一版项目之后,旧 entry 攒着的那一批不再发布到就绪索引', async () => {
  const p = pipeline();
  const seen = [];
  p.ready.subscribe('s', (m) => seen.push(m));

  // 第一版:卡 h 的共享键 KA,后台正在攒一批
  const entryA = { key: 'E1', project: { fps: 30 } };
  p.adoptSession('s', entryA, 1);
  p.adoptCardPlan(entryA, [control('h', 'KA')]);
  entryA.snapshotPending = new Map([['a', fakeBatch('h', 'KA')]]);

  // 用户改了卡的参数:第二版,h 的共享键换成 KB,页面清表并收到新层
  const entryB = { key: 'E2', project: { fps: 30 } };
  p.adoptSession('s', entryB, 2);
  p.adoptCardPlan(entryB, [control('h', 'KB')]);
  p.publishLayer(entryB, control('h', 'KB'), 'shared', [[0, 4]]);
  seen.length = 0;

  // 旧 entry 的那一批这时才交完
  await p.flushSnapshots(entryA);
  const stale = seen.filter((m) => m.type === 'layer' && m.key === 'KA');
  assert.deepEqual(stale, [], `旧版的层不该在 reset 之后再发出去:${JSON.stringify(seen)}`);
  assert.equal(p.ready.peek('s').index.list().find((l) => l.clipId === 'h')?.key, 'KB', '就绪索引里 h 仍是新版的键');
});

test('当前这一版自己的批照常发布', async () => {
  const p = pipeline();
  const entry = { key: 'E1', project: { fps: 30 } };
  p.adoptSession('s', entry, 1);
  p.adoptCardPlan(entry, [control('h', 'KA')]);
  entry.snapshotPending = new Map([['a', fakeBatch('h', 'KA')]]);
  await p.flushSnapshots(entry);
  assert.deepEqual(p.ready.peek('s').index.list().find((l) => l.clipId === 'h')?.ranges, [[0, 9]]);
});
