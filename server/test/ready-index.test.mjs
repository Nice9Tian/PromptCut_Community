/**
 * C3 就绪索引的单测。跑:node --test server/test/ready-index.test.mjs
 *
 * 消息形状是这一层唯一的对外契约(页面照它建 `readyIndex`),所以三种消息的字段
 * 逐字钉死;「每次发全量、不发增量」也在这里保住 —— 发成增量的话,一条消息丢了
 * 页面那张表就永远缺一段,而 SSE 没有补发机制。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createReadyIndex, kindOfTier, READY_KINDS, wireSnapshotKey } from '../ready-index.mjs';

const collect = index => { const seen = []; const off = index.subscribe(m => seen.push(m)); return { seen, off }; };

test('tier names map onto the wire kinds (three-way synonym)', () => {
  assert.equal(kindOfTier('shared'), 'html');
  assert.equal(kindOfTier('local'), 'local');
  assert.equal(kindOfTier('none'), null);
  assert.equal(kindOfTier(undefined), null);
  // 'stream' 是 R8 的,类型里留位即可
  assert.deepEqual(READY_KINDS, ['html', 'local', 'stream']);
  // 线上的 key:共享档就是共享键;本地档自带一个斜杠(`<entry.key>/<共享键>`)
  assert.equal(wireSnapshotKey('shared', 'ENTRY', 'KEY'), 'KEY');
  assert.equal(wireSnapshotKey('local', 'ENTRY', 'KEY'), 'ENTRY/KEY');
  assert.equal(wireSnapshotKey('local', undefined, 'KEY'), null);
  assert.equal(wireSnapshotKey('none', 'ENTRY', 'KEY'), null);
});

test('a new subscriber gets reset first, then one full layer message per layer', () => {
  const index = createReadyIndex();
  index.localRev = 7;
  index.addFrames({ clipId: 'a', kind: 'html', key: 'KA', frames: [[0, 3]] });
  index.addFrames({ clipId: 'b', kind: 'local', key: 'KB', frames: [0] });
  const { seen } = collect(index);
  assert.equal(seen[0].type, 'reset');
  assert.equal(seen[0].localRev, 7);
  assert.deepEqual(seen.slice(1).map(m => m.type), ['layer', 'layer'], '先 reset 再 layer');
  assert.deepEqual(seen[1], { type: 'layer', clipId: 'a', kind: 'html', key: 'KA', ranges: [[0, 3]] });
  assert.deepEqual(seen[2], { type: 'layer', clipId: 'b', kind: 'local', key: 'KB', ranges: [[0, 0]] });
});

test('layer messages are always the full range table, and ranges grow as frames land', () => {
  const index = createReadyIndex();
  const { seen } = collect(index);
  index.addFrames({ clipId: 'a', kind: 'html', key: 'KA', frames: [0, 1, 2, 3] });
  index.addFrames({ clipId: 'a', kind: 'html', key: 'KA', frames: [4, 5, 6, 7] });
  // 第二条不是「新增 4~7」,是「现在有 0~7」—— 丢了第一条也不会永远缺一段
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'a', kind: 'html', key: 'KA', ranges: [[0, 7]] });
  index.addFrames({ clipId: 'a', kind: 'html', key: 'KA', frames: [[12, 13]] });
  assert.deepEqual(seen.at(-1).ranges, [[0, 7], [12, 13]], '真的洞留着');
  // 同一张卡的 stream 表和 html 表并存、互不覆盖
  index.addFrames({ clipId: 'a', kind: 'stream', key: 'SA', frames: [[0, 2]] });
  assert.deepEqual(index.list().map(l => `${l.clipId}/${l.kind}`).sort(), ['a/html', 'a/stream']);
  // 键变了(卡的参数改了)就从头记,不把旧键的区间接上去
  index.addFrames({ clipId: 'a', kind: 'html', key: 'KA2', frames: [[0, 1]] });
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'a', kind: 'html', key: 'KA2', ranges: [[0, 1]] });
});

test('reset clears the table and tells the page to clear its own; done is sent once', () => {
  const index = createReadyIndex();
  index.addFrames({ clipId: 'a', kind: 'html', key: 'KA', frames: [[0, 3]] });
  const { seen } = collect(index);
  seen.length = 0;
  index.reset(9);
  assert.deepEqual(seen, [{ type: 'reset', localRev: 9 }]);
  assert.deepEqual(index.list(), []);
  index.markDone();
  index.markDone();
  assert.deepEqual(seen.at(-1), { type: 'done', localRev: 9 });
  assert.equal(seen.filter(m => m.type === 'done').length, 1);
  // reset 之后 done 重新武装
  index.reset(10);
  index.markDone();
  assert.deepEqual(seen.at(-1), { type: 'done', localRev: 10 });
});

test('F5: disk scan stages key → ranges, and nothing is published until the card plan lands', () => {
  const index = createReadyIndex();
  const { seen } = collect(index);
  seen.length = 0;
  // 扫盘只得到「键 → 区间」:目录名是剥掉 clipId 的共享键
  index.stageByKey({ kind: 'html', key: 'SHARED-KEY', ranges: [[0, 40]] });
  index.stageByKey({ kind: 'local', key: 'ENTRY/BLUR-KEY', ranges: [[0, 4], [9, 9]] });
  assert.deepEqual(seen, [], '项目没到之前一条 layer 都不发');
  assert.deepEqual(index.list(), []);
  // 项目到位 → 重算 card plan → 用 control.clipId ↔ control.snapshotKey 反查
  const claimed = index.claim([
    { clipId: 'clip-1', kind: 'html', key: 'SHARED-KEY' },
    { clipId: 'clip-2', kind: 'local', key: wireSnapshotKey('local', 'ENTRY', 'BLUR-KEY') },
    { clipId: 'clip-3', kind: 'html', key: 'NOT-ON-DISK' },
    { clipId: 'clip-4', kind: null, key: 'SHARED-KEY' },
  ], 12);
  assert.equal(claimed, 2, '盘上没有的键和不产快照的档都不认领');
  // 先一条 reset,再对每一层发一条全量 layer(C3 本来就是全量语义,不加新端点)
  assert.deepEqual(seen[0], { type: 'reset', localRev: 12 });
  assert.deepEqual(seen.slice(1), [
    { type: 'layer', clipId: 'clip-1', kind: 'html', key: 'SHARED-KEY', ranges: [[0, 40]] },
    { type: 'layer', clipId: 'clip-2', kind: 'local', key: 'ENTRY/BLUR-KEY', ranges: [[0, 4], [9, 9]] },
  ]);
  // 之后新连上来的页面直接拿到重建好的那份
  const later = collect(index);
  assert.deepEqual(later.seen.map(m => m.type), ['reset', 'layer', 'layer']);
});

test('setLayer publishes a whole table (the group-stream shape carries groupClipIds)', () => {
  const index = createReadyIndex();
  const { seen } = collect(index);
  index.setLayer({ clipId: 'a', kind: 'stream', key: 'S1', ranges: [3, [0, 1]], groupClipIds: ['a', 'b'] });
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'a', kind: 'stream', key: 'S1', ranges: [[0, 1], [3, 3]], groupClipIds: ['a', 'b'] });
  assert.equal(index.addFrames({ clipId: '', kind: 'html', key: 'K', frames: [0] }), null);
  assert.equal(index.addFrames({ clipId: 'a', kind: 'nope', key: 'K', frames: [0] }), null);
  assert.equal(index.addFrames({ clipId: 'a', kind: 'html', key: '', frames: [0] }), null);
});

test('unsubscribing stops delivery and a throwing subscriber cannot block the others', () => {
  const index = createReadyIndex();
  const good = [];
  index.subscribe(() => { throw new Error('这个订阅者断了'); });
  const off = index.subscribe(m => good.push(m));
  index.addFrames({ clipId: 'a', kind: 'html', key: 'K', frames: [0] });
  assert.equal(good.at(-1).type, 'layer');
  off();
  index.addFrames({ clipId: 'a', kind: 'html', key: 'K', frames: [1] });
  assert.equal(good.at(-1).ranges.length, 1);
  assert.deepEqual(good.at(-1).ranges, [[0, 0]], '退订之后不再收');
});

test('依赖下层的流的层带着 streamKind 与 inputSig 发出去;别的层、别的档位不带;认领没带时留着同键原来那一层的', () => {
  const index = createReadyIndex();
  const { seen } = collect(index);
  // 发层:四个口子都原样带出去
  index.setLayer({ clipId: 'g', kind: 'stream', key: 'B1', ranges: [[0, 2]], originFrame: 55, streamKind: 'below', inputSig: 's1-abc' });
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'g', kind: 'stream', key: 'B1', ranges: [[0, 2]], originFrame: 55, streamKind: 'below', inputSig: 's1-abc' });
  index.addFrames({ clipId: 'g', kind: 'stream', key: 'B1', frames: [3], originFrame: 55, streamKind: 'below', inputSig: 's1-abc' });
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'g', kind: 'stream', key: 'B1', ranges: [[0, 3]], originFrame: 55, streamKind: 'below', inputSig: 's1-abc' });
  // 没有签名的只带种类;不认识的种类、不是流的档位都不带
  index.setLayer({ clipId: 'h', kind: 'stream', key: 'B2', ranges: [[0, 0]], originFrame: 0, streamKind: 'below' });
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'h', kind: 'stream', key: 'B2', ranges: [[0, 0]], originFrame: 0, streamKind: 'below' });
  index.setLayer({ clipId: 'c', kind: 'stream', key: 'C1', ranges: [[0, 0]], originFrame: 0, streamKind: 'card', inputSig: 's1-zzz' });
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'c', kind: 'stream', key: 'C1', ranges: [[0, 0]], originFrame: 0 });
  index.setLayer({ clipId: 'g', kind: 'html', key: 'H1', ranges: [[0, 0]], streamKind: 'below', inputSig: 's1-abc' });
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'g', kind: 'html', key: 'H1', ranges: [[0, 0]] });

  // 认领(不 reset 的那一种):带了就用认领表的;没带、键没变就留着原来的;签名换了算变了、要重发
  index.stageByKey({ kind: 'stream', key: 'B1', ranges: [[0, 5]] });
  const before = seen.length;
  assert.equal(index.absorb([{ clipId: 'g', kind: 'stream', key: 'B1', originFrame: 55 }]), 1);
  assert.deepEqual(seen.at(-1), { type: 'layer', clipId: 'g', kind: 'stream', key: 'B1', ranges: [[0, 5]], originFrame: 55, streamKind: 'below', inputSig: 's1-abc' });
  assert.equal(index.absorb([{ clipId: 'g', kind: 'stream', key: 'B1', originFrame: 55, streamKind: 'below', inputSig: 's1-abc' }]), 0, '什么都没变:不重发');
  assert.equal(index.absorb([{ clipId: 'g', kind: 'stream', key: 'B1', originFrame: 55, streamKind: 'below', inputSig: 's1-new' }]), 1);
  assert.equal(seen.at(-1).inputSig, 's1-new');
  assert.equal(seen.length, before + 2);

  // 认领(先 reset 的那一种)
  const fresh = createReadyIndex();
  fresh.stageByKey({ kind: 'stream', key: 'B1', ranges: [[0, 1]] });
  const got = collect(fresh);
  assert.equal(fresh.claim([{ clipId: 'g', kind: 'stream', key: 'B1', originFrame: 55, streamKind: 'below', inputSig: 's1-abc' }]), 1);
  assert.deepEqual(got.seen.at(-1), { type: 'layer', clipId: 'g', kind: 'stream', key: 'B1', ranges: [[0, 1]], originFrame: 55, streamKind: 'below', inputSig: 's1-abc' });
});
