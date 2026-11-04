import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

const withAudio = async (fn) => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try { await fn(await server.ssrLoadModule("/src/audio/cardAudio.ts")); }
  finally { await server.close(); }
};

/** Minimal audio media effect card project: one adapter:'card' / kind:'audio' node, no inputs */
const audioProject = (nodeId = "generated") => ({
  media: [], tracks: [],
  cardNodes: [{ id: nodeId, adapter: "card", cardId: "beep", kind: "audio", inputs: {}, params: {} }],
});

const fakeBuffer = (channels, length, sampleRate, value) => {
  const data = Array.from({ length: channels }, () => new Float32Array(length).fill(value));
  return { numberOfChannels: channels, length, sampleRate, getChannelData: (c) => data[c] };
};
const fakeCtx = () => ({ createBuffer: (channels, frames, sampleRate) => fakeBuffer(channels, frames, sampleRate, 0) });

test("card audio splits a long local range, asks exact sample blocks in page, and joins exact frames", async () => withAudio(async ({ CARD_AUDIO_MAX_BLOCK_FRAMES, configureCardAudio, decodeCardAudioClip }) => {
  const requests = [];
  configureCardAudio({
    sourceVersionOf: () => "v1",
    // Mock the definition directly: chunks no longer go over HTTP, `audio()` is the evaluation itself
    getCard: (id) => id !== "beep" ? undefined : {
      id, defaults: {},
      audio: (_sources, range) => {
        requests.push({ start: range.start, count: range.count, sampleRate: range.sampleRate });
        return new Float32Array(range.count * 2).fill(range.start === 0 ? 0 : 1);
      },
    },
  });
  const project = audioProject();
  const output = await decodeCardAudioClip(fakeCtx(), { project, nodeId: "generated", frames: CARD_AUDIO_MAX_BLOCK_FRAMES + 13 });
  assert.deepEqual(requests.map(({ start, count }) => ({ start, count })), [{ start: 0, count: CARD_AUDIO_MAX_BLOCK_FRAMES }, { start: CARD_AUDIO_MAX_BLOCK_FRAMES, count: 13 }]);
  assert.equal(requests.every((r) => r.sampleRate === 48000), true);
  assert.equal(output.length, CARD_AUDIO_MAX_BLOCK_FRAMES + 13);
  assert.equal(output.getChannelData(0)[0], 0);
  assert.equal(output.getChannelData(1)[CARD_AUDIO_MAX_BLOCK_FRAMES], 1);

  // Delete assembled chunks entirely (one stereo chunk is 8 MB; if not deleted it stays resident
  // for the project lifetime): requesting it again requires re-evaluation
  await decodeCardAudioClip(fakeCtx(), { project, nodeId: "generated", frames: 13 });
  assert.equal(requests.length, 3, "blocks are dropped after concatenation, so the next clip re-evaluates");
}));

test("card audio rejects a block that is not a whole number of channels and a throwing audio() does not poison the cache", async () => withAudio(async ({ configureCardAudio, requestCardAudio }) => {
  const project = audioProject("n");
  let mode = "short", calls = 0;
  configureCardAudio({
    sourceVersionOf: () => "v1",
    getCard: (id) => id !== "beep" ? undefined : {
      id, defaults: {},
      audio: (_sources, range) => {
        calls++;
        // The response has no url; only validate samples.length % count === 0
        if (mode === "short") return new Float32Array(range.count * 2 - 1);
        if (mode === "throw") throw new Error("card blew up");
        return new Float32Array(range.count * 2).fill(0.5);
      },
    },
  });
  await assert.rejects(() => requestCardAudio({ project, nodeId: "n", start: 0, count: 10, sampleRate: 48000 }), /not a whole number of channels|invalid card audio descriptor/);

  // Cancellation: throw AbortError before evaluation; `audio()` should not run even once
  const controller = new AbortController(); controller.abort();
  const before = calls;
  await assert.rejects(() => requestCardAudio({ project, nodeId: "n", start: 10, count: 10, sampleRate: 48000 }, controller.signal), /aborted/);
  assert.equal(calls, before, "an already-aborted request never evaluates the card");

  // audio() throws → pending.catch deletes the key; next time it still computes (cache not poisoned)
  mode = "throw";
  await assert.rejects(() => requestCardAudio({ project, nodeId: "n", start: 10, count: 10, sampleRate: 48000 }), /card blew up/);
  mode = "ok";
  const good = await requestCardAudio({ project, nodeId: "n", start: 10, count: 10, sampleRate: 48000 });
  assert.equal(good.frames, 10);
  assert.equal(good.channels, 2);
  assert.equal(good.samples.length, 20);
  assert.equal(good.samples[0], 0.5);
  assert.equal(good.url, undefined, "Blocks stay in memory; only a preview lease builds a blob: WAV");

  // The same key hits the cache directly the second time and is not re-evaluated
  const after = calls;
  await requestCardAudio({ project, nodeId: "n", start: 10, count: 10, sampleRate: 48000 });
  assert.equal(calls, after);
}));

test("card audio cache key follows the card source version", async () => withAudio(async ({ configureCardAudio, requestCardAudio }) => {
  let version = "v1", calls = 0;
  configureCardAudio({
    sourceVersionOf: () => version,
    getCard: (id) => ({ id, defaults: {}, audio: (_s, range) => { calls++; return new Float32Array(range.count * 2); } }),
  });
  const project = audioProject("n");
  await requestCardAudio({ project, nodeId: "n", start: 0, count: 4, sampleRate: 48000 });
  await requestCardAudio({ project, nodeId: "n", start: 0, count: 4, sampleRate: 48000 });
  assert.equal(calls, 1);
  version = "v2";
  await requestCardAudio({ project, nodeId: "n", start: 0, count: 4, sampleRate: 48000 });
  assert.equal(calls, 2, "After the media effect card source is edited the project object is unchanged, but the old sample block must not stay in use");
}));

test("card audio refuses to evaluate before the registry injects its hooks", async () => withAudio(async ({ requestCardAudio, getCardAudioEpoch, configureCardAudio, subscribeCardAudioEpoch }) => {
  await assert.rejects(() => requestCardAudio({ project: audioProject("n"), nodeId: "n", start: 0, count: 4, sampleRate: 48000 }), /card audio hooks not configured/);
  const seen = [];
  const stop = subscribeCardAudioEpoch(() => seen.push(getCardAudioEpoch()));
  const before = getCardAudioEpoch();
  configureCardAudio({ getCard: () => undefined, sourceVersionOf: () => "v" });
  assert.equal(getCardAudioEpoch(), before + 1, "The version number +1 on every configureCardAudio call");
  assert.deepEqual(seen, [before + 1]);
  stop();
  configureCardAudio({ getCard: () => undefined, sourceVersionOf: () => "v" });
  assert.equal(seen.length, 1, "No notifications are received after unsubscribing");
}));

test("preview selects generated-only and video-backed audio once and mutes their native video track", async () => withAudio(async ({ generatedCardAudioClipsAt, shouldMuteNativeAudio, isCardAudioNode }) => {
    const project = {
      media: [{ id: "v", kind: "video", url: "/@media/v.mp4" }, { id: "a", kind: "audio", url: "/@media/a.wav" }],
      cardNodes: [
        { id: "video-node", adapter: "card", cardId: "beep", kind: "audio" },
        { id: "bare-node", adapter: "card", cardId: "beep", kind: "audio" },
        { id: "visual-node", adapter: "card", cardId: "blur", kind: "filter" },
      ],
      tracks: [{ id: "t", clips: [
        { id: "video-backed", cardId: "", nodeId: "video-node", mediaId: "v", start: 0, end: 4 },
        { id: "generated-only", cardId: "", nodeId: "bare-node", start: 0, end: 4 },
        { id: "ordinary", cardId: "", mediaId: "a", start: 0, end: 4 },
        { id: "visual", cardId: "blur", nodeId: "visual-node", mediaId: "v", start: 0, end: 4 },
      ] }],
    };
    const generated = generatedCardAudioClipsAt(project, 1);
    assert.deepEqual(generated.map(x => x.clip.id), ["video-backed", "generated-only"]);
    assert.equal(generated.find(x => x.clip.id === "generated-only").media, undefined);
    assert.equal(shouldMuteNativeAudio(project, project.tracks[0].clips[0]), true);
    assert.equal(shouldMuteNativeAudio(project, project.tracks[0].clips[2]), false);
    // Only look at nodes: media effect card nodes whose kind is not audio do not count as audio cards
    // (Node side mux-audio.mjs uses the same criterion)
    assert.equal(isCardAudioNode(project, "visual-node"), false);
    assert.equal(isCardAudioNode(project, "bare-node"), true);
}));

test('virtual AV nodes use current params and source version for repeated block requests', async () => withAudio(async ({ configureCardAudio, requestCardAudio }) => {
  let source = 'v1', calls = 0;
  const def = { id: 'av', defaults: { gain: 1 }, Component() {}, audio(_s, range, p) { calls++; return new Float32Array(range.count).fill(p.gain); } };
  configureCardAudio({ getCard: id => id === 'av' ? def : undefined, sourceVersionOf: () => source });
  const project = { media: [], tracks: [{ id: 't', clips: [{ id: 'c', cardId: 'av', start: 0, end: 1, params: { gain: 2 } }] }] };
  const req = { project, nodeId: '@clip/c/card', start: 0, count: 4, sampleRate: 48000 };
  assert.equal((await requestCardAudio(req)).samples[0], 2);
  project.tracks[0].clips[0].params.gain = 3;
  assert.equal((await requestCardAudio(req)).samples[0], 3);
  source = 'v2'; await requestCardAudio(req);
  assert.equal(calls, 3);
}));

/* ------------------------------------------------------------------ *
 * Audio-visual card attached to speed-changed media clip
 * (user decision, 2026-10-23: "Produce sound.", overruling [ruling] V21-28)
 * ------------------------------------------------------------------ */

/**
 * Mock server for /@media/<hash>/pcm: returns a ramp where frame k (absolute frame number on the
 * asset) has k in both channels (linear interpolation is exact on a ramp)
 */
function rampFetch() {
  globalThis.fetch = async (url) => {
    const query = new URL(url, "http://local").searchParams;
    const start = Number(query.get("start")), count = Number(query.get("count"));
    const samples = new Float32Array(count * 2);
    for (let i = 0; i < count; i++) samples[2 * i] = samples[2 * i + 1] = start + i;
    return new Response(samples.buffer, { status: 200 });
  };
}

const AV_HASH = "b".repeat(64);
/**
 * Audio-visual card: left channel outputs card clock (the tick at range.start received by audio()),
 * right channel outputs the stream reading its own section of the asset
 */
const avProbe = { id: "av-probe", defaults: {}, kind: "animation", Component() {},
  async audio(sources, range) {
    const input = await sources.source.block(range.start, range.count);
    const out = new Float32Array(range.count * 2);
    for (let i = 0; i < range.count; i++) { out[2 * i] = range.start + i; out[2 * i + 1] = input[2 * i]; }
    return out;
  } };
const avProject = (speed, mediaOffset = 1) => ({
  media: [{ id: "m", kind: "video", url: `/@media/${AV_HASH}`, hash: AV_HASH }],
  cardNodes: [{ id: "avn", adapter: "card", cardId: "av-probe", kind: "animation", embeddedAudio: true, params: {}, inputs: { source: { nodeId: "@clip/c/source" } } }],
  tracks: [{ id: "t", clips: [{ id: "c", cardId: "av-probe", mediaId: "m", nodeId: "avn", embeddedAudio: true, mediaOffset, start: 0, end: 4, params: {}, ...(speed === 1 ? {} : { speed }) }] }],
});
/**
 * Same approach as splitClip in store: the second half's asset start point advances by playback
 * rate (mediaOffsetAfter), and the node is cloned via cloneCardClipInstance
 */
async function splitAt(project, d) {
  const { mediaOffsetAfter } = await import("../kernel/clipTime.mjs");
  const { cloneCardClipInstance } = await import("../kernel/cardAuthoring.mjs");
  const clip = project.tracks[0].clips[0];
  const cloned = cloneCardClipInstance(project, clip.id, "r", clip.nodeId, d);
  const left = { ...clip, end: d }, right = { ...clip, id: "r", start: d, mediaOffset: mediaOffsetAfter(clip, d), nodeId: cloned.nodeId };
  return { ...cloned.project, tracks: [{ id: "t", clips: [left, right] }] };
}
const SR = 48000;

test("Audio-visual card on a speed-changed media clip: preview still plays sound; card clock = mediaOffset ÷ speed + time within the clip, and the media is read at the changed speed", async () => withAudio(async ({ configureCardAudio, cardAudioBlockRenderer, generatedCardAudioClipsAt }) => {
  rampFetch();
  configureCardAudio({ getCard: (id) => (id === "av-probe" ? avProbe : undefined), sourceVersionOf: () => "v1" });
  for (const speed of [1, 2, 0.5]) {
    const p = avProject(speed);
    assert.deepEqual(generatedCardAudioClipsAt(p, 1).map((x) => x.clip.id), ["c"], `${speed}x: the preview's sound layer contains this clip`);
    const block = await cardAudioBlockRenderer(p, "avn")(10, 4);
    for (let i = 0; i < 4; i++) {
      assert.equal(block[2 * i], (1 / speed) * SR + 10 + i, `${speed}x: card clock`);
      assert.ok(Math.abs(block[2 * i + 1] - (SR + (10 + i) * speed)) < 1e-3, `${speed}x: media read = mediaOffset + in-clip samples × speed`);
    }
  }
}));

test("Audio-visual card on a speed-changed media clip: after a split, the card clock and the media read position both line up with the pre-split values at the same moment (2x, 0.5x)", async () => withAudio(async ({ configureCardAudio, cardAudioBlockRenderer }) => {
  rampFetch();
  configureCardAudio({ getCard: (id) => (id === "av-probe" ? avProbe : undefined), sourceVersionOf: () => "v1" });
  for (const speed of [2, 0.5, 1]) {
    const whole = avProject(speed);
    const before = await cardAudioBlockRenderer(whole, "avn")(1.5 * SR, 8);
    const split = await splitAt(whole, 1.5);
    const rightNode = split.tracks[0].clips[1].nodeId;
    const after = await cardAudioBlockRenderer(split, rightNode)(0, 8);
    for (let i = 0; i < 16; i++) assert.ok(Math.abs(after[i] - before[i]) < 1e-3, `${speed}x: cell ${i} ${after[i]} ≠ pre-split ${before[i]}`);
  }
}));

test("Audio-visual card on a speed-changed media clip: generated sound still covers after split and trim, is not judged stale, and the offset advances in timeline seconds", async () => withAudio(async ({ configureCardAudio, persistentCardAudio, assertProjectCardAudio }) => {
  configureCardAudio({ getCard: (id) => (id === "av-probe" ? avProbe : undefined), sourceVersionOf: () => "v1" });
  const { cardAudioIdentity, cardAudioSourceOffset } = await import("../kernel/cardAudioRendition.mjs");
  const hooks = { getCard: (id) => (id === "av-probe" ? avProbe : undefined), sourceVersionOf: () => "v1" };
  for (const speed of [2, 0.5]) {
    const whole = avProject(speed);
    const clip = whole.tracks[0].clips[0];
    // Same as recorded in cardAudioGeneration.ts: range start = source clock at generation time,
    // length = clip's timeline length
    const cardAudio = { version: 1, cardId: "av-probe", mediaId: "wav", sampleRate: SR, frames: 4 * SR, channels: 2,
      sourceOffset: cardAudioSourceOffset(whole, clip), identity: cardAudioIdentity(whole, clip, hooks) };
    assert.equal(cardAudio.sourceOffset, 1 / speed, "Source clock of a speed-changed clip = mediaOffset ÷ speed");
    const withWav = (p) => ({ ...p, media: [...p.media, { id: "wav", kind: "audio", url: `/@media/${"c".repeat(64)}`, hash: "c".repeat(64) }],
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, cardAudio })) })) });
    const generated = withWav(whole);
    assert.equal(persistentCardAudio(generated, generated.tracks[0].clips[0]).offset, 0);
    assertProjectCardAudio(generated);
    const split = withWav(await splitAt(whole, 1.5));
    const [left, right] = split.tracks[0].clips;
    assert.equal(persistentCardAudio(split, left).offset, 0, `${speed}x: the first half plays from the start`);
    assert.ok(Math.abs(persistentCardAudio(split, right).offset - 1.5) < 1e-9, `${speed}x: the second half plays from 1.5 s (it used to be judged "not covered" at 2x and wrongly played from 0.75 s at 0.5x)`);
    assertProjectCardAudio(split);
  }
}));
