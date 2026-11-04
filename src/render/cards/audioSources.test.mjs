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

/** Fake server for /@media/<hash>/pcm: records each query string, returns count × 2 × 4 bytes */
function stubFetch(log) {
  globalThis.fetch = async (url) => {
    const query = new URL(url, "http://local").searchParams;
    log.push({ url: String(url), start: Number(query.get("start")), count: Number(query.get("count")), sampleRate: Number(query.get("sampleRate")), ch: Number(query.get("ch")) });
    const count = Number(query.get("count"));
    const samples = new Float32Array(count * 2).fill(Number(query.get("start")));
    return new Response(samples.buffer, { status: 200 });
  };
}

/** A trimmed asset (mediaOffset = 2 seconds) + an audio media effect card connected to it */
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

test("media input: clip.mediaOffset + edge.offset are converted only once in the page, folded into start", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  const log = []; stubFetch(log); clearAudioBlockCache();
  const ctx = { graph: nodes, project, getCard: () => undefined, sampleRate: SR };
  const out = await blockOf(ctx, { clipId: "src", offset: 0.5, rate: 1 }, 100, 480);
  assert.equal(out.length, 960, "interleaved stereo: count × 2");
  assert.equal(log.length, 1);
  // 100 + 0.5×48000 + 2×48000 = 100 + 24000 + 96000
  assert.equal(log[0].start, 120100);
  assert.equal(log[0].count, 480);
  assert.equal(log[0].sampleRate, SR);
  assert.equal(log[0].ch, 2);
  assert.equal(log[0].url.startsWith(`/@media/${HASH}/pcm?`), true, "route carries the hash, no offset parameter");
}));

test("media input: negative start is passed to the server as is (padding silence at the front is done by the server)", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  const log = []; stubFetch(log); clearAudioBlockCache();
  const ctx = { graph: nodes, project: { ...project, tracks: [{ id: "t", clips: [{ id: "src", mediaId: "m", mediaOffset: 0, start: 0, end: 4 }] }] }, getCard: () => undefined, sampleRate: SR };
  await blockOf(ctx, { clipId: "src" }, -240, 480);
  assert.equal(log[0].start, -240);
}));

test("chunk cache hits by (hash, position, count), limit 32 chunks", async () => withSources(async ({ blockOf, clearAudioBlockCache, AUDIO_BLOCK_CACHE_LIMIT }) => {
  const log = []; stubFetch(log); clearAudioBlockCache();
  const ctx = { graph: nodes, project, getCard: () => undefined, sampleRate: SR };
  await blockOf(ctx, { clipId: "src" }, 0, 480);
  await blockOf(ctx, { clipId: "src" }, 0, 480);
  assert.equal(log.length, 1, "the same (hash, position, count) is fetched only once");
  await blockOf(ctx, { clipId: "src" }, 480, 480);
  assert.equal(log.length, 2, "a different position is a different chunk");

  assert.equal(AUDIO_BLOCK_CACHE_LIMIT, 32);
  // Feed another 32 chunks to push out the earliest two chunks
  for (let i = 1; i <= AUDIO_BLOCK_CACHE_LIMIT; i++) await blockOf(ctx, { clipId: "src" }, i * 10000, 480);
  const before = log.length;
  await blockOf(ctx, { clipId: "src" }, 0, 480);
  assert.equal(log.length, before + 1, "old chunks beyond the limit are evicted and must be fetched again");
}));

test("playback rate ≠ 1 on an edge throws an error in the first version", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  const log = []; stubFetch(log); clearAudioBlockCache();
  const ctx = { graph: nodes, project, getCard: () => undefined, sampleRate: SR };
  await assert.rejects(() => blockOf(ctx, { clipId: "src", rate: 2 }, 0, 480), /not supported in the first version/);
  await assert.rejects(() => blockOf(ctx, { nodeId: "n1", rate: 0.5 }, 0, 480), /not supported in the first version/);
  assert.equal(log.length, 0);
}));

test("media effect card input recursively calls its audio(), instance parameters follow the H2 convention (clip.params override the node that clip.nodeId points to)", async () => withSources(async ({ blockOf, evaluateCardAudio, clearAudioBlockCache }) => {
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
  assert.deepEqual(seen.map((s) => s.card), ["mix", "gain"], "n2 → n1 → media");
  // n1 is referenced by clip "gain" (clip.nodeId === 'n1'), parameters take clip.params as
  // authoritative: 3, not 1 on the node
  assert.equal(seen.find((s) => s.card === "gain").params.gain, 3);
  // The asset hop: 0 + 0.5×48000 + 2×48000
  assert.equal(log[0].start, 120000);
  assert.equal(out[0], 120000 * 3);

  // Jumping directly from n1 is also the same (blockOf evaluates media effect card nodes recursively)
  const direct = await blockOf(ctx, { nodeId: "n1" }, 4, 4);
  assert.equal(direct.length, 8);
}));

test("media effect card audio() throws an error if the returned sample count is not an integer multiple of count", async () => withSources(async ({ evaluateCardAudio, clearAudioBlockCache }) => {
  stubFetch([]); clearAudioBlockCache();
  const ctx = { graph: nodes, project, getCard: () => ({ id: "gain", defaults: {}, audio: (_s, range) => new Float32Array(range.count * 2 - 1) }), sampleRate: SR };
  await assert.rejects(() => evaluateCardAudio(ctx, "n1", { start: 0, count: 4, sampleRate: SR }), /not a whole number of channels/);
}));

test("old media without a content hash gets an actionable error message", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  stubFetch([]); clearAudioBlockCache();
  const legacy = { media: [{ id: "m", kind: "video", name: "old.mp4", url: "/@media/old.mp4" }], tracks: project.tracks };
  const ctx = { graph: nodes, project: legacy, getCard: () => undefined, sampleRate: SR };
  await assert.rejects(() => blockOf(ctx, { clipId: "src" }, 0, 480), /re-?import/);
}));

test('audio-visual in the same clip uses the source clock and the explicit input offset is converted only once', async () => withSources(async ({ evaluateCardAudio, clearAudioBlockCache }) => {
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
  assert.equal(logs[0].start, 168007, 'Source time 2.5 s + explicit upstream offset 1 s must not add mediaOffset twice');
}));

/* ------------------------------------------------------------------ *
 * Speed-changed media clip as audio input (user decision, 2026-10-23: "Allow."):
 * speed and pitch change with rate
 * ------------------------------------------------------------------ */

/**
 * Returns a ramp: both channels at frame k (absolute frame number on asset) are k.
 * Linear interpolation is exact on a ramp, allowing sample-by-sample checking
 */
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

test("Speed-changed media clip (clip input): downstream sample i = media sample mediaOffset + (start + edge.offset + i) × rate", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  for (const speed of [2, 0.5, 1.25]) {
    const log = []; rampFetch(log); clearAudioBlockCache();
    const ctx = { graph: nodes, project: sped(speed), getCard: () => undefined, sampleRate: SR };
    const out = await blockOf(ctx, { clipId: "src", offset: 0.5, rate: 1 }, 100, 480);
    assert.equal(out.length, 960);
    const local = 100 + 0.5 * SR, mediaStart = 2 * SR;
    assert.equal(log.length, 1, "one request");
    assert.equal(log[0].start, Math.floor(mediaStart + local * speed));
    // Read asset of length "duration × rate" (1-2 extra frames for interpolation)
    assert.ok(Math.abs(log[0].count - 480 * speed) <= 2, `fetched ${log[0].count} frames, expected about ${480 * speed}`);
    for (const i of [0, 1, 7, 239, 479]) {
      const want = mediaStart + (local + i) * speed;
      assert.ok(Math.abs(out[2 * i] - want) < 0.05, `speed ${speed} sample ${i} ${out[2 * i]} ≠ ${want}`);
      assert.equal(out[2 * i + 1], out[2 * i], "both channels are processed the same way");
    }
  }
}));

test("Speed-changed media clip: fetching by chunk gives the same samples as fetching at once (seamless chunk boundaries)", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  rampFetch([]); clearAudioBlockCache();
  const ctx = { graph: nodes, project: sped(1.37), getCard: () => undefined, sampleRate: SR };
  const whole = await blockOf(ctx, { clipId: "src" }, 3, 3000);
  const parts = [await blockOf(ctx, { clipId: "src" }, 3, 1000), await blockOf(ctx, { clipId: "src" }, 1003, 1000), await blockOf(ctx, { clipId: "src" }, 2003, 1000)];
  const joined = new Float32Array(6000); parts.forEach((p, k) => joined.set(p, k * 2000));
  assert.deepEqual(joined, whole);
}));

test("Speed-changed media clip (composited media node): rate on the node takes priority, otherwise look up the clip speed by clipId; 1x is unchanged", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
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
  // 1x: still that same original request, exact position and length without difference
  const log = []; rampFetch(log); clearAudioBlockCache();
  const plain = { ...project, cardNodes: nodes };
  await blockOf({ graph: projectCardGraph(plain), project: plain, getCard: () => undefined, sampleRate: SR }, { nodeId: "@clip/src/source" }, 10, 100);
  assert.deepEqual(log, [{ start: 2 * SR + 10, count: 100 }]);
}));

test("Speed-changed media clip: an audio media effect card attached to it is evaluated recursively and also changes speed (the clip's own nodeId points to the card)", async () => withSources(async ({ evaluateCardAudio, clearAudioBlockCache }) => {
  const { projectCardGraph } = await import("../../kernel/cardGraph.mjs");
  const log = []; rampFetch(log); clearAudioBlockCache();
  const def = { id: "gain", defaults: {}, kind: "audio", audio: (sources, range) => sources.source.block(range.start, range.count) };
  const p = { media: [{ id: "m", kind: "video", hash: HASH }],
    tracks: [{ id: "t", clips: [{ id: "c", cardId: "", mediaId: "m", nodeId: "fx", mediaOffset: 1, speed: 0.5, start: 0, end: 2, params: {} }] }],
    cardNodes: [{ id: "fx", adapter: "card", cardId: "gain", kind: "audio", inputs: { source: { nodeId: "@clip/c/source" } } }] };
  const out = await evaluateCardAudio({ graph: projectCardGraph(p, () => def), project: p, getCard: () => def, sampleRate: SR }, "fx", { start: 0, count: 4, sampleRate: SR });
  assert.deepEqual([...out].filter((_, k) => k % 2 === 0), [SR, SR + 0.5, SR + 1, SR + 1.5]);
}));

test("Speed-changed media clip + rate ≠ 1 on the edge: the edge rate is still unsupported in the first version", async () => withSources(async ({ blockOf, clearAudioBlockCache }) => {
  rampFetch([]); clearAudioBlockCache();
  const ctx = { graph: nodes, project: sped(2), getCard: () => undefined, sampleRate: SR };
  await assert.rejects(() => blockOf(ctx, { clipId: "src", rate: 2 }, 0, 480), /not supported in the first version/);
}));
