import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

const withSources = async (fn) => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try { await fn(await server.ssrLoadModule("/src/render/cards/audioSources.ts")); }
  finally { await server.close(); }
};

const HASH = "a".repeat(64);
const SR = 48000;

/** /@media/<hash>/pcm 的假服务端:记下每次的查询串,回 count × 2 × 4 字节 */
function stubFetch(log) {
  globalThis.fetch = async (url) => {
    const query = new URL(url, "http://local").searchParams;
    log.push({ url: String(url), start: Number(query.get("start")), count: Number(query.get("count")), sampleRate: Number(query.get("sampleRate")), ch: Number(query.get("ch")) });
    const count = Number(query.get("count"));
    const samples = new Float32Array(count * 2).fill(Number(query.get("start")));
    return new Response(samples.buffer, { status: 200 });
  };
}

/** 一段裁过的素材(mediaOffset = 2 秒)+ 一张接它的音频素材效果卡 */
const project = {
  media: [{ id: "m", kind: "video", name: "clip.mp4", url: `/@media/${HASH}`, hash: HASH }],
  tracks: [{ id: "t", clips: [
    { id: "src", cardId: "", mediaId: "m", mediaOffset: 2, start: 0, end: 4 },
    { id: "gain", cardId: "", nodeId: "n1", start: 0, end: 4, params: { gain: 3 } },
  ] }],
};
const nodes = [
  { id: "n1", adapter: "card", cardId: "gain", kind: "audio", params: { gain: 1 }, inputs: { source: { nodeId: "@clip/src/source", offset: 0.5, rate: 1 } } },
  { id: "n2", adapter: "card", cardId: "mix", kind: "audio", params: {}, inputs: { source: { nodeId: "n1" } } },
];

test("媒体输入:clip.mediaOffset + 边.offset 只在页面折算一次,折进 start", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  const log = []; stubFetch(log); clearAudioBlockCache();
  const ctx = { graph: nodes, project, getCard: () => undefined, sampleRate: SR };
  const out = await blockOf(ctx, { clipId: "src", offset: 0.5, rate: 1 }, 100, 480);
  assert.equal(out.length, 960, "交错立体声:count × 2");
  assert.equal(log.length, 1);
  // 100 + 0.5×48000 + 2×48000 = 100 + 24000 + 96000
  assert.equal(log[0].start, 120100);
  assert.equal(log[0].count, 480);
  assert.equal(log[0].sampleRate, SR);
  assert.equal(log[0].ch, 2);
  assert.equal(log[0].url.startsWith(`/@media/${HASH}/pcm?`), true, "路由带哈希,没有 offset 参数");
}));

test("媒体输入:负的 start 原样传给服务端(前面补静音由服务端做)", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  const log = []; stubFetch(log); clearAudioBlockCache();
  const ctx = { graph: nodes, project: { ...project, tracks: [{ id: "t", clips: [{ id: "src", mediaId: "m", mediaOffset: 0, start: 0, end: 4 }] }] }, getCard: () => undefined, sampleRate: SR };
  await blockOf(ctx, { clipId: "src" }, -240, 480);
  assert.equal(log[0].start, -240);
}));

test("块缓存按 (hash, position, count) 命中,上限 32 块", async () => withSources(async ({ blockOf, clearAudioBlockCache, AUDIO_BLOCK_CACHE_LIMIT }) => {
  const log = []; stubFetch(log); clearAudioBlockCache();
  const ctx = { graph: nodes, project, getCard: () => undefined, sampleRate: SR };
  await blockOf(ctx, { clipId: "src" }, 0, 480);
  await blockOf(ctx, { clipId: "src" }, 0, 480);
  assert.equal(log.length, 1, "同一个 (hash, position, count) 只取一次");
  await blockOf(ctx, { clipId: "src" }, 480, 480);
  assert.equal(log.length, 2, "换了位置就是另一块");

  assert.equal(AUDIO_BLOCK_CACHE_LIMIT, 32);
  // 再灌 32 块把最早那两块挤出去
  for (let i = 1; i <= AUDIO_BLOCK_CACHE_LIMIT; i++) await blockOf(ctx, { clipId: "src" }, i * 10000, 480);
  const before = log.length;
  await blockOf(ctx, { clipId: "src" }, 0, 480);
  assert.equal(log.length, before + 1, "超过上限的旧块被淘汰,要重新取");
}));

test("边上的播放速率 ≠ 1 第一版报错", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  const log = []; stubFetch(log); clearAudioBlockCache();
  const ctx = { graph: nodes, project, getCard: () => undefined, sampleRate: SR };
  await assert.rejects(() => blockOf(ctx, { clipId: "src", rate: 2 }, 0, 480), /第一版不支持/);
  await assert.rejects(() => blockOf(ctx, { nodeId: "n1", rate: 0.5 }, 0, 480), /第一版不支持/);
  assert.equal(log.length, 0);
}));

test("素材效果卡输入递归调它的 audio(),实例参数按 H2 的口径(clip.params 覆盖 clip.nodeId 指向的那个节点)", async () => withSources(async ({ blockOf, evaluateCardAudio, clearAudioBlockCache }) => {
  const log = []; stubFetch(log); clearAudioBlockCache();
  const seen = [];
  const cards = {
    gain: { id: "gain", defaults: { gain: 1 }, audio: async (sources, range, params) => {
      seen.push({ card: "gain", params: { ...params }, start: range.start });
      const input = await sources.source.block(range.start, range.count);
      return input.map((v) => v * Number(params.gain));
    } },
    mix: { id: "mix", defaults: {}, audio: async (sources, range, params) => {
      seen.push({ card: "mix", params: { ...params }, start: range.start });
      return sources.source.block(range.start, range.count);
    } },
  };
  const ctx = { graph: nodes, project, getCard: (id) => cards[id], sampleRate: SR };
  const out = await evaluateCardAudio(ctx, "n2", { start: 0, count: 4, sampleRate: SR });
  assert.equal(out.length, 8);
  assert.deepEqual(seen.map((s) => s.card), ["mix", "gain"], "n2 → n1 → 素材");
  // n1 被片段 "gain" 指着(clip.nodeId === 'n1'),参数以 clip.params 为准:3,不是节点上的 1
  assert.equal(seen.find((s) => s.card === "gain").params.gain, 3);
  // 素材那一跳:0 + 0.5×48000 + 2×48000
  assert.equal(log[0].start, 120000);
  assert.equal(out[0], 120000 * 3);

  // 直接从 n1 起跳也一样(blockOf 对素材效果卡节点就是递归求值)
  const direct = await blockOf(ctx, { nodeId: "n1" }, 4, 4);
  assert.equal(direct.length, 8);
}));

test("素材效果卡 audio() 回的采样数不是 count 的整数倍就报错", async () => withSources(async ({ evaluateCardAudio, clearAudioBlockCache }) => {
  stubFetch([]); clearAudioBlockCache();
  const ctx = { graph: nodes, project, getCard: () => ({ id: "gain", defaults: {}, audio: (_s, range) => new Float32Array(range.count * 2 - 1) }), sampleRate: SR };
  await assert.rejects(() => evaluateCardAudio(ctx, "n1", { start: 0, count: 4, sampleRate: SR }), /not a whole number of channels/);
}));

test("没有内容哈希的老素材给一句能照做的报错", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  stubFetch([]); clearAudioBlockCache();
  const legacy = { media: [{ id: "m", kind: "video", name: "old.mp4", url: "/@media/old.mp4" }], tracks: project.tracks };
  const ctx = { graph: nodes, project: legacy, getCard: () => undefined, sampleRate: SR };
  await assert.rejects(() => blockOf(ctx, { clipId: "src" }, 0, 480), /重新导入/);
}));

test('声画同片段使用源时钟且显式输入偏移只折算一次', async () => withSources(async ({ evaluateCardAudio, clearAudioBlockCache }) => {
  const { projectCardGraph } = await import('../../kernel/cardGraph.mjs');
  const logs = []; stubFetch(logs); clearAudioBlockCache();
  const seen = [];
  const def = { id: 'av', defaults: {}, Component() {}, audio: (sources, range) => {
    seen.push(range.start); return sources.source.block(range.start, range.count);
  } };
  const p = { media: [{ id: 'm', kind: 'video', hash: HASH }],
    tracks: [{ id: 't', clips: [{ id: 'c', cardId: 'av', mediaId: 'm', nodeId: 'n', mediaOffset: 2.5, start: 0, end: 1, params: {} }] }],
    cardNodes: [{ id: 'n', adapter: 'card', cardId: 'av', embeddedAudio: true, timeOffset: .5, inputs: { source: { nodeId: '@clip/c/source', offset: .5 } } }] };
  const graph = projectCardGraph(p, () => def);
  await evaluateCardAudio({ graph, project: p, getCard: () => def, sampleRate: SR }, 'n', { start: 7, count: 10, sampleRate: SR });
  assert.equal(seen[0], 120007);
  assert.equal(logs[0].start, 168007, '源时间2.5秒+显式上游偏移1秒，不能重复加mediaOffset');
}));

/* ------------------------------------------------------------------ *
 * 变速的素材段当声音输入(2026-10-23 用户定「放开。」):随倍率变速变调
 * ------------------------------------------------------------------ */

/** 回一条斜坡:第 k 帧(素材上的绝对帧号)两个声道都是 k。线性插值在斜坡上是精确的,可以逐个采样对数 */
function rampFetch(log) {
  globalThis.fetch = async (url) => {
    const query = new URL(url, "http://local").searchParams;
    const start = Number(query.get("start")), count = Number(query.get("count"));
    log.push({ start, count });
    const samples = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) samples[2 * i] = samples[2 * i + 1] = start + i;
    return new Response(samples.buffer, { status: 200 });
  };
}

const sped = (speed) => ({ ...project, tracks: [{ id: "t", clips: [{ ...project.tracks[0].clips[0], speed }, project.tracks[0].clips[1]] }] });

test("变速的素材段(片段输入):下游第 i 个采样 = 素材第 mediaOffset + (start + 边.offset + i) × 倍率 个采样", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  for (const speed of [2, 0.5, 1.25]) {
    const log = []; rampFetch(log); clearAudioBlockCache();
    const ctx = { graph: nodes, project: sped(speed), getCard: () => undefined, sampleRate: SR };
    const out = await blockOf(ctx, { clipId: "src", offset: 0.5, rate: 1 }, 100, 480);
    assert.equal(out.length, 960);
    const local = 100 + 0.5 * SR, mediaStart = 2 * SR;
    assert.equal(log.length, 1, "一次请求");
    assert.equal(log[0].start, Math.floor(mediaStart + local * speed));
    // 读「时长 × 倍率」那么长的素材(多 1~2 帧给插值)
    assert.ok(Math.abs(log[0].count - 480 * speed) <= 2, `取了 ${log[0].count} 帧,应约 ${480 * speed}`);
    for (const i of [0, 1, 7, 239, 479]) {
      const want = mediaStart + (local + i) * speed;
      assert.ok(Math.abs(out[2 * i] - want) < 0.05, `speed ${speed} 第 ${i} 个采样 ${out[2 * i]} ≠ ${want}`);
      assert.equal(out[2 * i + 1], out[2 * i], "两个声道同样处理");
    }
  }
}));

test("变速的素材段:按块取与一次取逐个采样相同(块缝无缝)", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  rampFetch([]); clearAudioBlockCache();
  const ctx = { graph: nodes, project: sped(1.37), getCard: () => undefined, sampleRate: SR };
  const whole = await blockOf(ctx, { clipId: "src" }, 3, 3000);
  const parts = [await blockOf(ctx, { clipId: "src" }, 3, 1000), await blockOf(ctx, { clipId: "src" }, 1003, 1000), await blockOf(ctx, { clipId: "src" }, 2003, 1000)];
  const joined = new Float32Array(6000); parts.forEach((p, k) => joined.set(p, k * 2000));
  assert.deepEqual(joined, whole);
}));

test("变速的素材段(合成过的素材节点):节点上的 rate 优先,没有时按 clipId 查片段速度;1 倍不变", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  const { projectCardGraph } = await import("../../kernel/cardGraph.mjs");
  const { withMediaRates } = await import("../../kernel/clipTime.mjs");
  const p = { ...sped(2), cardNodes: nodes };
  for (const graph of [projectCardGraph(p), withMediaRates(p, projectCardGraph(p))]) {
    const log = []; rampFetch(log); clearAudioBlockCache();
    const out = await blockOf({ graph, project: p, getCard: () => undefined, sampleRate: SR }, { nodeId: "@clip/src/source" }, 10, 100);
    assert.equal(log[0].start, 2 * SR + 20);
    assert.equal(out[0], 2 * SR + 20);
    assert.equal(out[2 * 99], 2 * SR + 2 * 109);
  }
  // 1 倍:还是原来那一次请求,位置、长度一个不差
  const log = []; rampFetch(log); clearAudioBlockCache();
  const plain = { ...project, cardNodes: nodes };
  await blockOf({ graph: projectCardGraph(plain), project: plain, getCard: () => undefined, sampleRate: SR }, { nodeId: "@clip/src/source" }, 10, 100);
  assert.deepEqual(log, [{ start: 2 * SR + 10, count: 100 }]);
}));

test("变速的素材段:接在它上面的音频素材效果卡递归求值也变速(片段自己的 nodeId 指向卡)", async () => withSources(async ({ evaluateCardAudio, clearAudioBlockCache }) => {
  const { projectCardGraph } = await import("../../kernel/cardGraph.mjs");
  const log = []; rampFetch(log); clearAudioBlockCache();
  const def = { id: "gain", defaults: {}, kind: "audio", audio: (sources, range) => sources.source.block(range.start, range.count) };
  const p = { media: [{ id: "m", kind: "video", hash: HASH }],
    tracks: [{ id: "t", clips: [{ id: "c", cardId: "", mediaId: "m", nodeId: "fx", mediaOffset: 1, speed: 0.5, start: 0, end: 2, params: {} }] }],
    cardNodes: [{ id: "fx", adapter: "card", cardId: "gain", kind: "audio", inputs: { source: { nodeId: "@clip/c/source" } } }] };
  const out = await evaluateCardAudio({ graph: projectCardGraph(p, () => def), project: p, getCard: () => def, sampleRate: SR }, "fx", { start: 0, count: 4, sampleRate: SR });
  assert.deepEqual([...out].filter((_, k) => k % 2 === 0), [SR, SR + 0.5, SR + 1, SR + 1.5]);
}));

test("变速的素材段 + 边上的 rate ≠ 1:边的速率仍是第一版不支持", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  rampFetch([]); clearAudioBlockCache();
  const ctx = { graph: nodes, project: sped(2), getCard: () => undefined, sampleRate: SR };
  await assert.rejects(() => blockOf(ctx, { clipId: "src", rate: 2 }, 0, 480), /第一版不支持/);
}));
