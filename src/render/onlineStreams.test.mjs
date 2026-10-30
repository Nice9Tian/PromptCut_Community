/**
 * 在线页面读轨道流(`snapshotSource.ts` 的 `OnlineSnapshotSource`;`docs/plan/browser-stream-task.md` 第六处):
 * 读层表的 `streams` 表 → 按播放头附近的分段取流清单(`render-manifest`)→ 清单里的块按哈希从素材服务取到本页 →
 * 字节到了的分段合成就绪区间,照 C3 的 `layer` 消息(`kind: 'stream'`)交给订阅方;`streamPlane` 给父页发流平面时带的清单与字节。
 * 跑:node --test src/render/onlineStreams.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  OnlineSnapshotSource, parseLayerMap, parseLayerStreams, streamSpansInWindow, applyReadyMessage, BlockLru,
  LAYER_MAP_PREFIX, MANIFEST_POLL_MS, STREAM_RETRY_MS, LAYER_MAP_POLL_MS,
  browserDecodeSupport, SPARSE_STREAM_CACHE_MAX_BYTES, STREAM_CACHE_MAX_BYTES,
} from './snapshotSource.ts';
import { streamPlanesFor, SEGMENT_FRAMES } from './streamPlayer.ts';
import { streamInputSig } from './streamInputSig.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const RK = (n) => n.toString(16).padStart(64, '0');
const bytesOf = (text) => new TextEncoder().encode(text);

/** 一台假内容库 + 假素材服务(带一个可以走的钟、一张可以换的票据) */
function world() {
  const w = {
    content: new Map(), requests: [], fetches: [], bytes: new Map(), now: 1_000_000, ticket: 'T1', accepts: () => true,
  };
  w.deps = {
    async request(msg) {
      w.requests.push(msg);
      if (msg.type !== 'content.get') throw new Error('只认 content.get');
      if (!w.content.has(msg.key)) return { type: 'content.item', kind: msg.kind, key: msg.key, missing: true };
      return { type: 'content.item', kind: msg.kind, key: msg.key, body: structuredClone(w.content.get(msg.key)), hash: 'x' };
    },
    assetBase: () => 'https://h.example/media/api/asset/',
    authHeaders: async () => ({ Authorization: `Bearer ${w.ticket}` }),
    async fetch(url, init) {
      const auth = init?.headers?.Authorization;
      w.fetches.push({ url, auth });
      const fail = (status) => ({ ok: false, status, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) });
      if (!w.accepts(auth)) return fail(401);
      const hash = url.split('/').pop();
      if (!w.bytes.has(hash)) return fail(404);
      const b = w.bytes.get(hash);
      return { ok: true, status: 200, headers: { get: () => 'video/mp4' }, arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
    },
    now: () => w.now,
    setTimer: () => 0,
    clearTimer: () => {},
  };
  /** 往素材服务放一块,回它的哈希 */
  w.block = (text) => { const b = bytesOf(text); const h = sha(b); w.bytes.set(h, b); return h; };
  /** 往内容库放一份流清单;`segs` 是这份清单里有的分段号(缺省全有) */
  w.putStream = (rk, from, to, { segs = null, stride = 1, tag = 'v1', clipIds = ['c1'], kind = 'card', upload = true } = {}) => {
    const initBytes = bytesOf(`init ${rk.slice(-4)} ${tag}`);
    const initHash = sha(initBytes);
    if (upload) w.bytes.set(initHash, initBytes);
    const id = initHash.slice(0, 16);
    const segments = {};
    const hashes = {};
    for (let n = from; n <= to; n++) {
      if (segs && !segs.includes(n)) continue;
      const body = bytesOf(`seg ${rk.slice(-4)} ${n} ${tag}`);
      const hash = sha(body);
      if (upload) w.bytes.set(hash, body);
      hashes[n] = hash;
      segments[n] = { hash, bytes: body.length, init: id, stride, samples: Math.ceil(SEGMENT_FRAMES / stride), sig: null, encoder: 'libx264' };
    }
    w.content.set(`${rk}:${from}-${to}`, {
      v: 1, kind: 'stream', resultKey: rk, range: { from, to },
      header: { kind, plane: kind === 'group' ? 'stage' : 'local', clipIds, fps: 30, bound: { x: -32, y: -32, w: 704, h: 424 }, offset: { x: 640, y: 360 }, tight: null },
      inits: { [id]: { hash: initHash, bytes: initBytes.length, codec: 'avc1.640028', width: 704, height: 864, timescale: 15360, rect: { x: -32, y: -32, w: 704, h: 424 }, encoder: 'libx264' } },
      segments,
    });
    return { initHash, id, hashes };
  };
  w.putMap = (streams, { layers = [], v = 3 } = {}) => {
    w.content.set(`${LAYER_MAP_PREFIX}p1`, { v, kind: 'layer-map', projectId: 'p1', entryKey: 'e', fps: 30, span: 60, at: 1, layers, ...(streams ? { streams } : {}) });
  };
  w.source = (opts = { tier: 'original' }) => {
    const src = new OnlineSnapshotSource(w.deps, opts);
    const messages = [];
    src.subscribeReady('online', 0, (m) => messages.push(m));
    src.setProject('p1');
    return { src, messages, streamMessages: () => messages.filter((m) => m.type === 'layer' && m.kind === 'stream') };
  };
  /** 走一轮:取层表、清单、块,等落定 */
  w.settle = async (src) => { await src.tickNow(); await src.idle(); await src.tickNow(); await src.idle(); };
  return w;
}

/**
 * 层表的一行:这条流从项目的第 30 帧开始(`originFrame`),分段从它自己的第一帧起数,0～18(第 30～314 帧)。
 * 行里不写 `firstSegment`(恒为 0);清单按「从 0 起每 8 段一份」分:`0-7`、`8-15`、`16-18`。
 */
const row = (over = {}) => ({ topClipId: 'c1', clipIds: ['c1'], kind: 'card', plane: 'local', contentKey: 'sk-1',
  candidates: [{ envFingerprint: 'fp-a', resultKey: RK(0xa) }], originFrame: 30, lastSegment: 18, segmentsPerTask: 8, ...over });
const last = (list) => list[list.length - 1];

test('清单的切法:从 firstSegment 起每 segmentsPerTask 段一份,最后一份到 lastSegment', () => {
  const r = { firstSegment: 2, lastSegment: 20, segmentsPerTask: 8 };
  assert.deepEqual(streamSpansInWindow(r, 0, 100), [[2, 9], [10, 17], [18, 20]]);
  assert.deepEqual(streamSpansInWindow(r, 0, 4), [[2, 9]]);
  assert.deepEqual(streamSpansInWindow(r, 9, 10), [[2, 9], [10, 17]]);
  assert.deepEqual(streamSpansInWindow(r, 18, 18), [[18, 20]]);
  assert.deepEqual(streamSpansInWindow(r, 21, 30), []);
  assert.deepEqual(streamSpansInWindow(r, 0, 1), []);
});

test('解析 streams 表:形状不对的行跳过;v 2 以下的层表不读这张表', () => {
  const good = row();
  // 改分段规则之前的节点写的行:带 `firstSegment`、没有 `originFrame`(分段按项目帧号数)。照现在的换算贴上去会错位,不认
  const { originFrame: _origin, ...oldShape } = good;
  const parsed = parseLayerStreams([good, null, { ...good, clipIds: [] }, { ...good, kind: 'x' }, { ...good, candidates: [] }, { ...good, candidates: [{ envFingerprint: 'f' }] },
    { ...good, lastSegment: -1 }, { ...good, segmentsPerTask: 0 }, { ...good, contentKey: '' }, { ...good, topClipId: undefined, inputSig: 's1-abc' },
    { ...oldShape, firstSegment: 2, lastSegment: 20 }, { ...good, originFrame: -1 }, { ...good, originFrame: 1.5 }, { ...good, originFrame: '30' }]);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { ...good, firstSegment: 0 }, '分段号恒从 0 起');
  assert.equal(parsed[0].originFrame, 30);
  assert.equal(parsed[1].topClipId, 'c1', '没写 topClipId 取最后一个成员');
  assert.equal(parsed[1].inputSig, 's1-abc');
  assert.deepEqual(parseLayerStreams(undefined), []);
  const base = { kind: 'layer-map', projectId: 'p1', fps: 30, span: 60, layers: [], streams: [good] };
  assert.equal(parseLayerMap({ ...base, v: 3 }).streams.length, 1);
  assert.deepEqual(parseLayerMap({ ...base, v: 2 }).streams, []);
  assert.deepEqual(parseLayerMap({ kind: 'layer-map', v: 3, layers: [] }).streams, [], '旧节点写的层表没有 streams:空表');
});

test('旧形状的层表(没有 streams):不取流清单、不发流的层,快照那一半照旧', async () => {
  const w = world();
  const layer = { clipId: 'c1', kind: 'html', key: 'k1', tier: 'shared', resultKey: 'r1', dirKey: 'r1', entryKey: null, firstFrame: 0, count: 60, contentKey: 'ck1', envFingerprint: 'fp-a',
    candidates: [{ envFingerprint: 'fp-a', resultKey: 'r1', key: 'k1', dirKey: 'r1' }] };
  const snap = w.block('<div>snap</div>');
  w.content.set('r1:0-59', { v: 1, kind: 'snapshot', tier: 'shared', resultKey: 'r1', dirKey: 'r1', range: { from: 0, to: 59 }, frames: [[0, snap, 10]] });
  w.putMap(null, { layers: [layer] });
  const { src, messages, streamMessages } = w.source();
  await w.settle(src);
  assert.equal(w.requests.some((r) => r.kind === 'render-manifest'), false);
  assert.deepEqual(streamMessages(), []);
  assert.equal(src.streamPlane(RK(0xa)), null);
  assert.deepEqual(last(messages.filter((m) => m.type === 'layer')), { type: 'layer', clipId: 'c1', kind: 'html', key: 'k1', ranges: [[0, 0]] }, '快照层照旧发');
  assert.equal(src.debug().streams.length, 0);
  src.stop();
});

test('分段号 → 就绪区间:只取播放头附近的清单与块,字节到了本页的分段才算就绪', async () => {
  const w = world();
  const rk = RK(0xa);
  const a = w.putStream(rk, 0, 7);
  w.putStream(rk, 8, 15);
  w.putStream(rk, 16, 18);
  w.putMap([row()]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  // 播放头在 0:窗口是项目的第 0～60 帧(往前 2 秒)。这条流从第 30 帧开始,落在窗口里的是它的第 0～2 段(第 30～74 帧),都在第一份清单里
  const asked = w.requests.filter((r) => r.kind === 'render-manifest').map((r) => r.key);
  assert.deepEqual(asked, [`${rk}:0-7`], '只取了窗口落到的那一份清单');
  assert.deepEqual(last(streamMessages()), { type: 'layer', clipId: 'c1', kind: 'stream', key: rk, ranges: [[0, 2]], originFrame: 30 }, '就绪消息带着这条流的第一帧');
  const fetched = w.fetches.map((f) => f.url);
  assert.ok(fetched.every((u) => u.startsWith('https://h.example/media/api/asset/px/')), '块从 px/ 取');
  assert.deepEqual(new Set(fetched.map((u) => u.split('/').pop())), new Set([a.initHash, a.hashes[0], a.hashes[1], a.hashes[2]]), '开头文件 + 窗口里的三段,各取一次');
  assert.equal(fetched.length, 4);
  assert.ok(w.fetches.every((f) => f.auth === 'Bearer T1'), '带只读票据');
  // 播放头挪到 3 秒(第 90 帧,这条流的第 4 段):窗口是它的第 3～8 段,跨到第二份清单
  src.focus(3, 30);
  await w.settle(src);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 8]], '先前取到的 0..2 还在本页,接上新取的 3..8');
  assert.ok(w.requests.some((r) => r.kind === 'render-manifest' && r.key === `${rk}:8-15`));
  assert.equal(w.requests.some((r) => r.key === `${rk}:16-18`), false, '窗口没到的那一份不取');
  // 满的清单不再取
  const before = w.requests.length;
  w.now += MANIFEST_POLL_MS * 3;
  await w.settle(src);
  assert.equal(w.requests.filter((r, i) => i >= before && r.kind === 'render-manifest' && r.key === `${rk}:0-7`).length, 0);
  // 就绪消息进了就绪索引,父页的纯算就能合成流平面(snapshotFeed 一行不改)
  const index = new Map();
  for (const m of streamMessages()) applyReadyMessage(index, m);
  const layers = [...index].map(([clipId, byKind]) => ({ clipId, ...byKind.get('stream') }));
  assert.deepEqual(streamPlanesFor(layers, new Set(['c1']), 90), [{ clipIds: ['c1'], key: rk, ranges: [[0, 8]], originFrame: 30 }]);
  assert.deepEqual(streamPlanesFor(layers, new Set(['c1']), 30 + 8 * 15 + 14).length, 1, '第 8 段的最后一帧(第 164 帧)');
  assert.deepEqual(streamPlanesFor(layers, new Set(['c1']), 30 + 9 * 15), [], '第 9 段(第 165 帧起)还没取到:这一拍没有流平面(这一层照旧换快照)');
  assert.deepEqual(streamPlanesFor(layers, new Set(['c1']), 29), [], '第 29 帧在这条流的第一帧之前:没有分段');
  const d = src.debug();
  assert.equal(d.streams[0].ready, 9);
  assert.equal(d.streamFetches, 4 + 6);
  src.stop();
});

test('清单没满时重取:缺的分段补上之后区间跟着长;稀疏段换成满密度之后换文件', async () => {
  const w = world();
  const rk = RK(0xa);
  w.putStream(rk, 0, 7, { segs: [0, 1] });
  w.putMap([row()]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 1]]);
  const count = () => w.requests.filter((r) => r.key === `${rk}:0-7`).length;
  const n0 = count();
  await w.settle(src);
  assert.equal(count(), n0, `不到 ${MANIFEST_POLL_MS} ms 不重取`);
  // 节点又产了第 2 段(稀疏的)
  const sparse = w.putStream(rk, 0, 7, { segs: [0, 1, 2], tag: 'v1' });
  const body = w.content.get(`${rk}:0-7`);
  const sparseBytes = bytesOf('seg sparse 2');
  body.segments[2] = { ...body.segments[2], hash: sha(sparseBytes), stride: 3, samples: 5 };
  w.bytes.set(sha(sparseBytes), sparseBytes);
  w.now += MANIFEST_POLL_MS;
  await w.settle(src);
  assert.ok(count() > n0, '到点重取');
  assert.deepEqual(last(streamMessages()).ranges, [[0, 2]]);
  assert.equal(src.streamPlane(rk).manifest.segments['2'].stride, 3);
  assert.equal(src.streamPlane(rk).manifest.segments['2'].file, sha(sparseBytes));
  const revSparse = src.streamRev;
  // 稀疏段被满密度的换掉:就绪区间一个字不变,文件换了,streamRev 跟着变(父页据此重发流平面)
  w.putStream(rk, 0, 7, { segs: [0, 1, 2] });
  w.now += MANIFEST_POLL_MS;
  await w.settle(src);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 2]]);
  assert.equal(src.streamPlane(rk).manifest.segments['2'].stride, 1);
  assert.equal(src.streamPlane(rk).manifest.segments['2'].file, sparse.hashes[2]);
  assert.ok(src.streamRev > revSparse);
  src.stop();
});

test('候选切换:task.done 认定活着的那一份优先;superseded 作废的那一份不用', async () => {
  const w = world();
  const rkA = RK(0xa), rkB = RK(0xb);
  w.putStream(rkA, 0, 7, { segs: [0] });
  w.putStream(rkB, 0, 7, { segs: [0, 1, 2], tag: 'browser' });
  w.putMap([row({ candidates: [{ envFingerprint: 'fp-a', resultKey: rkA }, { envFingerprint: 'fp-b', resultKey: rkB }] })]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  assert.equal(last(streamMessages()).key, rkA, '都没认定时取第一个候选');
  assert.deepEqual(last(streamMessages()).ranges, [[0, 0]]);
  // 浏览器节点那一份报完成(细任务 id:stream:<结果键>:<起>-<止>)
  src.noteQueueEvent({ type: 'task.done', id: `stream:${rkB}:0-7` });
  await w.settle(src);
  assert.equal(last(streamMessages()).key, rkB, '整条换成活着的那个候选');
  assert.deepEqual(last(streamMessages()).ranges, [[0, 2]]);
  assert.equal(src.debug().streams[0].envFingerprint, 'fp-b');
  assert.equal(src.streamPlane(rkA), null, '没选中的候选不给舞台');
  src.stop();

  // 另一台页面:只收到「A 那一份作废了」
  const w2 = world();
  w2.putStream(rkA, 0, 7, { segs: [0] });
  w2.putStream(rkB, 0, 7, { segs: [0, 1], tag: 'browser' });
  w2.putMap([row({ candidates: [{ envFingerprint: 'fp-a', resultKey: rkA }, { envFingerprint: 'fp-b', resultKey: rkB }] })]);
  const two = w2.source();
  // 稀疏流任务的 id 末尾多一段 `:sparse`,同样认得出结果键
  two.src.noteQueueEvent({ type: 'task.failed', id: `stream:${rkA}:0-7:sparse`, error: 'superseded' });
  await w2.settle(two.src);
  assert.equal(last(two.streamMessages()).key, rkB);
  two.src.stop();
});

test('过期签名:行里的 inputSig 与页面按当前项目算的对不上,这条流撤掉、不再取;对回来了照发', async () => {
  const w = world();
  const rk = RK(0xa);
  const project = (text) => ({ id: 'p1', width: 1920, height: 1080, fps: 30, duration: 10, tracks: [{ id: 't', clips: [{ id: 'c1', cardId: 'punch-pill', start: 1, end: 9, params: { text } }] }] });
  const v1 = project('one');   // 片段从第 1 秒(第 30 帧)开始,正是这一行的 originFrame
  w.putStream(rk, 0, 7);
  w.putMap([row({ inputSig: streamInputSig(v1, { clipIds: ['c1'], kind: 'card' }) })]);
  const { src, streamMessages } = w.source();
  src.setInputs(v1);
  await w.settle(src);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 2]]);
  // 页面改了参数:旧流马上撤(发空层)
  src.setInputs(project('two'));
  assert.deepEqual(last(streamMessages()), { type: 'layer', clipId: 'c1', kind: 'stream', key: rk, ranges: [] });
  assert.equal(src.streamPlane(rk), null);
  assert.deepEqual(src.debug().staleStreams, ['c1']);
  const asked = w.requests.length, got = w.fetches.length;
  src.focus(3, 30);
  await w.settle(src);
  assert.equal(w.requests.filter((r, i) => i >= asked && r.kind === 'render-manifest').length, 0, '过期的流不再取清单');
  assert.equal(w.fetches.length, got, '也不再取块');
  // 片段整帧平移同样算过期:片段在时间轴上的位置仍在输入签名里(「挪动以后流不失效」记了待办,这次不做)
  src.setInputs({ ...v1, tracks: [{ id: 't', clips: [{ ...v1.tracks[0].clips[0], start: 2, end: 10 }] }] });
  assert.equal(src.streamPlane(rk), null);
  // 改回原来的:照发
  src.setInputs(project('one'));
  assert.equal(last(streamMessages()).key, rk);
  assert.ok(last(streamMessages()).ranges.length > 0);
  // 没带签名的行(算不出签名的节点写的):照播
  w.putMap([row()]);
  w.now += LAYER_MAP_POLL_MS;
  src.setInputs(project('three'));
  await w.settle(src);
  assert.ok(last(streamMessages()).ranges.length > 0);
  src.stop();
});

test('缺块:素材服务上没有的分段不算就绪,过一会儿再取;补上之后接上', async () => {
  const w = world();
  const rk = RK(0xa);
  const a = w.putStream(rk, 0, 7);
  const lost = w.bytes.get(a.hashes[1]);
  w.bytes.delete(a.hashes[1]);
  w.putMap([row()]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 0], [2, 2]], '第 1 段取不到:区间断在这里');
  assert.equal(Object.keys(src.streamPlane(rk).manifest.segments).join(), '0,2', '给舞台的清单也不列它');
  assert.ok(src.debug().streamFailures >= 1);
  const tries = () => w.fetches.filter((f) => f.url.endsWith(a.hashes[1])).length;
  const n0 = tries();
  await w.settle(src);
  assert.equal(tries(), n0, `失败之后不到 ${STREAM_RETRY_MS} ms 不重取`);
  w.bytes.set(a.hashes[1], lost);
  w.now += STREAM_RETRY_MS;
  await w.settle(src);
  assert.ok(tries() > n0);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 2]]);
  src.stop();
});

test('开头文件取不到:用它的分段都不算就绪', async () => {
  const w = world();
  const rk = RK(0xa);
  const a = w.putStream(rk, 0, 7);
  w.bytes.delete(a.initHash);
  w.putMap([row()]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  assert.deepEqual(streamMessages(), [], '一段都没就绪:不发流的层');
  assert.equal(src.streamPlane(rk), null);
  src.stop();
});

test('票据过期:取块被拒之后按新票据重取', async () => {
  const w = world();
  const rk = RK(0xa);
  w.putStream(rk, 0, 7, { segs: [0] });
  w.putMap([row()]);
  w.accepts = (auth) => auth === 'Bearer T2';   // 素材服务只认新票据,页面手里还是旧的
  const { src, streamMessages } = w.source();
  await w.settle(src);
  assert.deepEqual(streamMessages(), []);
  assert.ok(w.fetches.length >= 2 && w.fetches.every((f) => f.auth === 'Bearer T1'));
  w.ticket = 'T2';   // 票据续上了(页面里是 `assetAuthHeaders` 自己续)
  w.now += STREAM_RETRY_MS;
  await w.settle(src);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 0]]);
  assert.ok(w.fetches.some((f) => f.auth === 'Bearer T2'));
  src.stop();
});

test('字节与哈希对不上:不收,不算就绪', async () => {
  const w = world();
  const rk = RK(0xa);
  const a = w.putStream(rk, 0, 7, { segs: [0, 1] });
  w.bytes.set(a.hashes[1], bytesOf('不是这一段的字节'));
  w.putMap([row()]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 0]]);
  src.stop();
});

test('streamPlane:给舞台的清单只列字节在本页的分段,分段的 file 是哈希,开头文件带 hash;blocks 正好是用到的块', async () => {
  const w = world();
  const rk = RK(0xa);
  const a = w.putStream(rk, 0, 7);
  w.putMap([row()]);
  const { src } = w.source();
  await w.settle(src);
  const plane = src.streamPlane(rk);
  assert.equal(plane.manifest.streamKey, rk);
  assert.equal(plane.manifest.kind, 'card');
  assert.equal(plane.manifest.plane, 'local');
  assert.deepEqual(plane.manifest.clipIds, ['c1']);
  assert.equal(plane.manifest.fps, 30);
  assert.equal(plane.manifest.segmentFrames, SEGMENT_FRAMES);
  assert.equal(plane.manifest.originFrame, 30, '清单里的第一帧取层表那一行的(按当前项目给的)');
  assert.deepEqual(plane.manifest.bound, { x: -32, y: -32, w: 704, h: 424 });
  assert.equal(plane.manifest.tight, null);
  assert.deepEqual(plane.manifest.inits, { [a.id]: { codec: 'avc1.640028', width: 704, height: 864, rect: { x: -32, y: -32, w: 704, h: 424 }, hash: a.initHash } });
  assert.deepEqual(plane.manifest.segments, Object.fromEntries([0, 1, 2].map((n) => [n, { init: a.id, file: a.hashes[n], stride: 1, samples: 15 }])));
  assert.deepEqual(new Set(plane.blocks.keys()), new Set([a.initHash, a.hashes[0], a.hashes[1], a.hashes[2]]));
  assert.deepEqual([...plane.blocks.get(a.hashes[1])], [...w.bytes.get(a.hashes[1])], '字节原样');
  assert.equal(src.streamPlane(rk), plane, '没变时回同一份(不每拍重建)');
  assert.equal(src.streamPlane(RK(0xdead)), null);
  src.stop();
});

test('组流:就绪消息带 groupClipIds,挂在最上面那张卡上', async () => {
  const w = world();
  const rk = RK(0xc);
  w.putStream(rk, 0, 7, { clipIds: ['c1', 'c2'], kind: 'group' });
  w.putMap([row({ topClipId: 'c2', clipIds: ['c1', 'c2'], kind: 'group', plane: 'stage', candidates: [{ envFingerprint: 'fp-a', resultKey: rk }], originFrame: 0, lastSegment: 7 })]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  assert.deepEqual(last(streamMessages()), { type: 'layer', clipId: 'c2', kind: 'stream', key: rk, ranges: [[0, 4]], originFrame: 0, groupClipIds: ['c1', 'c2'] });
  assert.equal(src.streamPlane(rk).manifest.kind, 'group');
  assert.equal(src.streamPlane(rk).manifest.plane, 'stage');
  // 父页的纯算:两个成员都被抑制才有这条平面
  const index = new Map();
  for (const m of streamMessages()) applyReadyMessage(index, m);
  const layers = [...index].map(([clipId, byKind]) => ({ clipId, ...byKind.get('stream') }));
  assert.deepEqual(streamPlanesFor(layers, new Set(['c1', 'c2']), 0).map((p) => p.clipIds), [['c1', 'c2']]);
  assert.deepEqual(streamPlanesFor(layers, new Set(['c2']), 0), []);
  src.stop();
});

test('新订阅方:先 reset,再把手里已有的流的层全量发一遍;层表里撤掉的流发空层', async () => {
  const w = world();
  const rk = RK(0xa);
  w.putStream(rk, 0, 7);
  w.putMap([row()]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  const late = [];
  src.subscribeReady('online', 0, (m) => late.push(m));
  assert.deepEqual(late, [{ type: 'reset', localRev: 0 }, { type: 'layer', clipId: 'c1', kind: 'stream', key: rk, ranges: [[0, 2]], originFrame: 30 }]);
  // 渲染节点重写了层表,不再有这条流(这张卡改判轻了)
  w.putMap([]);
  w.now += LAYER_MAP_POLL_MS;
  await w.settle(src);
  assert.deepEqual(last(streamMessages()), { type: 'layer', clipId: 'c1', kind: 'stream', key: rk, ranges: [] });
  assert.equal(src.streamPlane(rk), null);
  src.stop();
});

test('最低一档、浏览器没有 VideoDecoder:不消费流 —— streams 表在,也不取流清单、不发流的层(照没有流办)', async () => {
  const w = world();
  const rk = RK(0xa);
  w.putStream(rk, 0, 7);
  w.putMap([row()]);
  // Node 里没有 VideoDecoder,缺省的 `browserDecodeSupport` 回「没有」;再显式注入一次同样的
  assert.equal(browserDecodeSupport.available(), false);
  assert.equal(await browserDecodeSupport.supports({ codec: 'avc1.640028', codedWidth: 704, codedHeight: 864 }), false);
  for (const opts of [{ tier: 'small' }, { tier: 'small', decodeSupport: { available: () => false, supports: async () => true } }]) {
    const before = w.requests.length;
    const { src, streamMessages } = w.source(opts);
    await w.settle(src);
    assert.equal(w.requests.slice(before).some((r) => r.kind === 'render-manifest'), false);
    assert.deepEqual(streamMessages(), []);
    assert.equal(w.fetches.length, 0);
    assert.deepEqual(src.debug().streams, []);
    src.stop();
  }
});

test('最低一档、浏览器解得了:照别的档的路取流(层表、清单、分段),发同样的就绪消息;流字节的内存上限用小的那一个', async () => {
  const w = world();
  const rk = RK(0xa);
  const put = w.putStream(rk, 0, 7);
  w.putMap([row()]);
  const asked = [];
  const decodeSupport = { available: () => true, supports: async (c) => { asked.push(c); return true; } };
  const low = w.source({ tier: 'small', decodeSupport });
  low.src.focus(1, 30);   // 播放头在第 30 帧 = 这条流的第 0 段
  await w.settle(low.src);
  await w.settle(low.src);
  const msg = last(low.streamMessages());
  assert.equal(msg.key, rk);
  assert.equal(msg.originFrame, 30);
  assert.ok(msg.ranges.length && msg.ranges[0][0] === 0, '播放头附近的分段就绪');
  assert.deepEqual(asked, [{ codec: 'avc1.640028', codedWidth: 704, codedHeight: 864 }], '每个开头文件只问一次浏览器');
  const plane = low.src.streamPlane(rk);
  assert.ok(plane && plane.blocks.has(put.initHash) && plane.blocks.has(put.hashes[0]));
  assert.equal(plane.manifest.segments['0'].file, put.hashes[0], '分段整段取(块按哈希存取)');
  // 和别的档取到的是同一批东西
  const w2 = world();
  w2.putStream(rk, 0, 7);
  w2.putMap([row()]);
  const normal = w2.source();
  normal.src.focus(1, 30);
  await w2.settle(normal.src);
  await w2.settle(normal.src);
  assert.deepEqual(last(low.streamMessages()), last(normal.streamMessages()));
  assert.deepEqual(w.fetches.map((f) => f.url).sort(), w2.fetches.map((f) => f.url).sort());
  assert.ok(SPARSE_STREAM_CACHE_MAX_BYTES < STREAM_CACHE_MAX_BYTES);
  low.src.stop();
  normal.src.stop();
});

test('最低一档、这条流的编码配置浏览器不支持:清单照取,但分段的字节不取、不算就绪(父页照没有流办:落到占位符)', async () => {
  const w = world();
  const rk = RK(0xa);
  const put = w.putStream(rk, 0, 7);
  w.putMap([row()]);
  for (const supports of [async () => false, async () => { throw new Error('boom'); }]) {
    const before = w.fetches.length;
    const { src, streamMessages } = w.source({ tier: 'small', decodeSupport: { available: () => true, supports } });
    src.focus(1, 30);
    await w.settle(src);
    await w.settle(src);
    assert.deepEqual(streamMessages().filter((m) => m.ranges.length), [], '没有就绪的分段');
    assert.equal(src.streamPlane(rk), null);
    assert.equal(w.fetches.slice(before).some((f) => f.url.endsWith(put.hashes[0])), false, '解不了的流不取字节');
    src.stop();
  }
});

test('BlockLru:按字节计,挤掉最久没用的,回被挤掉的键', () => {
  const lru = new BlockLru(10);
  assert.deepEqual(lru.set('a', new Uint8Array(4)), []);
  assert.deepEqual(lru.set('b', new Uint8Array(4)), []);
  lru.get('a');
  assert.deepEqual(lru.set('c', new Uint8Array(4)), ['b'], 'a 刚用过,挤掉的是 b');
  assert.equal(lru.total, 8);
  assert.equal(lru.has('a') && lru.has('c') && !lru.has('b'), true);
  assert.deepEqual(lru.set('big', new Uint8Array(64)), ['a', 'c'], '单块就超上限:留它一块');
  assert.equal(lru.size, 1);
});

test('取哪几段按每条流自己的第一帧算:播放头还没到这条流时不取;两条流在同一个播放头下各取各的分段', async () => {
  const w = world();
  const far = RK(0xf1), near = RK(0xf2);
  // far 从第 400 帧开始(不是 15 的倍数),near 从第 7 帧开始
  w.putStream(far, 0, 7, { clipIds: ['c1'] });
  w.putStream(near, 0, 7, { clipIds: ['c2'] });
  w.putMap([
    row({ candidates: [{ envFingerprint: 'fp-a', resultKey: far }], originFrame: 400, lastSegment: 7 }),
    row({ topClipId: 'c2', clipIds: ['c2'], contentKey: 'sk-2', candidates: [{ envFingerprint: 'fp-a', resultKey: near }], originFrame: 7, lastSegment: 7 }),
  ]);
  const { src, streamMessages } = w.source();
  await w.settle(src);
  const lastOf = (key) => last(streamMessages().filter((m) => m.key === key));
  // 播放头在第 0 帧:窗口是第 0～60 帧。near(第 7 帧起)落进它的第 0～3 段(第 7～66 帧);far 还远,一段都不取
  assert.deepEqual(lastOf(near), { type: 'layer', clipId: 'c2', kind: 'stream', key: near, ranges: [[0, 3]], originFrame: 7 });
  assert.equal(lastOf(far), undefined, '播放头往前 2 秒也够不着第 400 帧:不取、不发');
  assert.equal(w.requests.some((r) => r.key === `${far}:0-7`), false);
  // 播放头到第 405 帧:far 的第 0 段(第 400～414 帧)第 5 个样本;窗口是它的第 0～4 段(到第 465 帧)。near 早就播完了
  src.focus(405 / 30, 30);
  await w.settle(src);
  assert.deepEqual(lastOf(far), { type: 'layer', clipId: 'c1', kind: 'stream', key: far, ranges: [[0, 4]], originFrame: 400 });
  const index = new Map();
  for (const m of streamMessages()) applyReadyMessage(index, m);
  const layers = [...index].map(([clipId, byKind]) => ({ clipId, ...byKind.get('stream') }));
  assert.deepEqual(streamPlanesFor(layers, new Set(['c1', 'c2']), 405).map((p) => [p.clipIds[0], p.originFrame]), [['c1', 400]]);
  assert.deepEqual(streamPlanesFor(layers, new Set(['c1', 'c2']), 399).map((p) => p.clipIds[0]), [], '第 399 帧:far 还没开始,near 的第 26 段不存在');
  assert.deepEqual(streamPlanesFor(layers, new Set(['c1', 'c2']), 7 + 3 * 15 + 14).map((p) => p.clipIds[0]), ['c2'], 'near 的第 3 段的最后一帧(第 66 帧)');
  src.stop();
});

/* ---------------- 依赖下层的流(`kind: 'below'`;任务书 `render-refactor-task.md`「戊二」的「下层四」) ---------------- */

/** 三条序列(第一条在最上面):标题、毛玻璃卡 `glass`(第 30 帧起)、下面一张会动的卡 */
const belowProject = (edit = (p) => p) => edit({ id: 'p1', width: 1920, height: 1080, fps: 30, duration: 20, media: [], tracks: [
  { id: 'top', clips: [{ id: 'title', cardId: 'c', start: 0, end: 10, params: { text: '标题' } }] },
  { id: 'mid', clips: [{ id: 'glass', cardId: 'c', start: 1, end: 9, params: {}, frame: { x: 100, y: 100, w: 600, h: 300 } }] },
  { id: 'low', clips: [{ id: 'mover', cardId: 'c', start: 0, end: 10, params: { speed: 1 } }] },
] });
const belowRow = (p, over = {}) => row({ topClipId: 'glass', clipIds: ['glass'], kind: 'below', plane: 'stage', contentKey: 'sk-below',
  ...(p ? { inputSig: streamInputSig(p, { clipIds: ['glass'], kind: 'below' }) } : {}), ...over });

test('BO-parse 解析 streams 表:依赖下层的流的行认下来(一个成员、舞台坐标);形状不对的跳过', () => {
  const good = belowRow(null);
  const parsed = parseLayerStreams([good, { ...good, plane: 'local' }, { ...good, clipIds: ['glass', 'mover'] }, { ...good, inputSig: 's1-x' }]);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { ...good, firstSegment: 0 });
  assert.equal(parsed[0].kind, 'below');
  assert.equal(parsed[0].plane, 'stage');
  assert.equal(parsed[1].inputSig, 's1-x');
});

test('BO-ready 依赖下层的流:就绪消息带 streamKind: below 和层表那一行的签名;给舞台的清单 kind 是 below、plane 是 stage;父页合成的流平面带 plane: stage', async () => {
  const w = world();
  const rk = RK(0xb);
  const p = belowProject();
  const sig = streamInputSig(p, { clipIds: ['glass'], kind: 'below' });
  assert.ok(sig);
  w.putStream(rk, 0, 7, { clipIds: ['glass'], kind: 'below' });
  w.content.get(`${rk}:0-7`).header.plane = 'stage';
  w.putMap([belowRow(p, { candidates: [{ envFingerprint: 'fp-a', resultKey: rk }] })]);
  const { src, streamMessages } = w.source();
  src.setInputs(p);
  await w.settle(src);
  // 和桌面预渲染进程发的那一层同一个形状(`server/frame-stream.mjs` 的 `belowLayerMark`;`src/editor/snapshotFeedBelow.test.mjs` 喂给父页的就是它)
  assert.deepEqual(last(streamMessages()), { type: 'layer', clipId: 'glass', kind: 'stream', key: rk, ranges: [[0, 2]], originFrame: 30, streamKind: 'below', inputSig: sig });
  const plane = src.streamPlane(rk);
  assert.equal(plane.manifest.kind, 'below');
  assert.equal(plane.manifest.plane, 'stage');
  assert.deepEqual(plane.manifest.clipIds, ['glass']);
  assert.equal(plane.manifest.originFrame, 30);
  // 父页的纯算:就绪索引里那一层带着 streamKind,合成的流平面带 plane: stage(舞台把画布挂在舞台根下)
  const index = new Map();
  for (const m of streamMessages()) applyReadyMessage(index, m);
  const layer = index.get('glass').get('stream');
  assert.equal(layer.streamKind, 'below');
  assert.equal(layer.inputSig, sig);
  const planes = streamPlanesFor([{ clipId: 'glass', ...layer, plane: 'stage' }], new Set(['glass']), 40);
  assert.deepEqual(planes, [{ clipIds: ['glass'], key: rk, ranges: [[0, 2]], originFrame: 30, plane: 'stage' }]);
  assert.equal(src.debug().streams[0].kind, 'below');
  // 没带签名的行:消息里不带 inputSig(父页不比,照贴)
  const w2 = world();
  w2.putStream(rk, 0, 7, { clipIds: ['glass'], kind: 'below' });
  w2.putMap([belowRow(null, { candidates: [{ envFingerprint: 'fp-a', resultKey: rk }] })]);
  const two = w2.source();
  two.src.setInputs(p);
  await w2.settle(two.src);
  assert.deepEqual(last(two.streamMessages()), { type: 'layer', clipId: 'glass', kind: 'stream', key: rk, ranges: [[0, 2]], originFrame: 30, streamKind: 'below' });
  src.stop(); two.src.stop();
});

test('BO-stale 依赖下层的流过期:下层或目标卡改了,旧流撤掉、不再取;上面的层怎么改都不算;改回来照发', async () => {
  const w = world();
  const rk = RK(0xb);
  const p = belowProject();
  w.putStream(rk, 0, 7, { clipIds: ['glass'], kind: 'below' });
  w.putMap([belowRow(p, { candidates: [{ envFingerprint: 'fp-a', resultKey: rk }] })]);
  const { src, streamMessages } = w.source();
  src.setInputs(p);
  await w.settle(src);
  assert.deepEqual(last(streamMessages()).ranges, [[0, 2]]);
  const stale = {
    '下层改了一个参数': (q) => { q.tracks[2].clips[0].params = { speed: 2 }; return q; },
    '下层挪了位置': (q) => { q.tracks[2].clips[0].frame = { x: 10, y: 0, w: 1920, h: 1080 }; return q; },
    '下层多了一层': (q) => { q.tracks.push({ id: 'bg', clips: [{ id: 'bg', cardId: 'c', start: 0, end: 10, params: {} }] }); return q; },
    '下层少了一层': (q) => { q.tracks.pop(); return q; },
    '目标卡自己挪了位置': (q) => { q.tracks[1].clips[0].frame = { x: 300, y: 100, w: 600, h: 300 }; return q; },
  };
  for (const [what, edit] of Object.entries(stale)) {
    src.setInputs(belowProject(edit));
    assert.deepEqual(last(streamMessages()), { type: 'layer', clipId: 'glass', kind: 'stream', key: rk, ranges: [] }, what);
    assert.equal(src.streamPlane(rk), null, what);
    assert.deepEqual(src.debug().staleStreams, ['glass'], what);
    src.setInputs(belowProject());
    assert.deepEqual(last(streamMessages()).ranges, [[0, 2]], `${what}:改回来照发`);
    assert.equal(last(streamMessages()).streamKind, 'below');
  }
  // 过期的这段时间里不取清单、不取块
  src.setInputs(belowProject(stale['下层改了一个参数']));
  const asked = w.requests.length, got = w.fetches.length;
  src.focus(3, 30);
  await w.settle(src);
  assert.equal(w.requests.filter((r, i) => i >= asked && r.kind === 'render-manifest').length, 0);
  assert.equal(w.fetches.length, got);
  src.setInputs(belowProject());
  // 上面的层怎么改都不算过期
  const before = streamMessages().length;
  src.setInputs(belowProject((q) => { q.tracks[0].clips[0].params = { text: '别的' }; q.tracks[0].clips[0].frame = { x: 5, y: 5, w: 100, h: 100 }; return q; }));
  src.setInputs(belowProject((q) => { q.tracks.shift(); return q; }));
  src.setInputs(belowProject((q) => { q.tracks.unshift({ id: 'over', clips: [{ id: 'over', cardId: 'c', start: 0, end: 10, params: {} }] }); return q; }));
  assert.ok(last(streamMessages()).ranges.length > 0);
  assert.equal(streamMessages().slice(before).some((m) => m.ranges.length === 0), false, '没有撤过');
  assert.deepEqual(src.debug().staleStreams, []);
  src.stop();
});

test('BO-lowest 最低一档:浏览器没有 VideoDecoder 时不消费依赖下层的流;解得了就照别的档同一套(带 streamKind 与输入签名)', async () => {
  const w = world();
  const rk = RK(0xb);
  w.putStream(rk, 0, 7, { clipIds: ['glass'], kind: 'below' });
  w.putMap([belowRow(null, { candidates: [{ envFingerprint: 'fp-a', resultKey: rk }] })]);
  const none = w.source({ tier: 'small' });
  await w.settle(none.src);
  assert.deepEqual(none.streamMessages(), []);
  assert.equal(w.requests.some((r) => r.kind === 'render-manifest'), false);
  none.src.stop();
  const low = w.source({ tier: 'small', decodeSupport: { available: () => true, supports: async () => true } });
  await w.settle(low.src);
  await w.settle(low.src);
  const normal = w.source();
  await w.settle(normal.src);
  await w.settle(normal.src);
  const a = last(low.streamMessages()), b = last(normal.streamMessages());
  assert.ok(a && a.ranges.length, '最低一档取到了依赖下层的流');
  assert.equal(a.streamKind, 'below');
  assert.deepEqual(a, b, '和别的档发的是同一条就绪消息');
  low.src.stop();
  normal.src.stop();
});
