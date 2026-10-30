import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

const withAudio = async (fn) => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try { await fn(await server.ssrLoadModule("/src/audio/cardAudio.ts")); }
  finally { await server.close(); }
};

/** 一份最小的音频素材效果卡项目:一个 adapter:'card' / kind:'audio' 的节点,没有输入 */
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
    // 定义直接 mock 掉:块不再走 HTTP,`audio()` 就是求值本身
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

  // 拼完的块整条删掉(一块立体声 8 MB,不删就在 project 存活期内常驻):再要一次得重新求值
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
        // 回包没有 url,只校验 samples.length % count === 0
        if (mode === "short") return new Float32Array(range.count * 2 - 1);
        if (mode === "throw") throw new Error("card blew up");
        return new Float32Array(range.count * 2).fill(0.5);
      },
    },
  });
  await assert.rejects(() => requestCardAudio({ project, nodeId: "n", start: 0, count: 10, sampleRate: 48000 }), /not a whole number of channels|invalid card audio descriptor/);

  // 取消:求值前就抛 AbortError,`audio()` 一次都不该跑
  const controller = new AbortController(); controller.abort();
  const before = calls;
  await assert.rejects(() => requestCardAudio({ project, nodeId: "n", start: 10, count: 10, sampleRate: 48000 }, controller.signal), /aborted/);
  assert.equal(calls, before, "an already-aborted request never evaluates the card");

  // audio() 抛错 → pending.catch 把键删掉,下一次照样能算出来(缓存没被毒化)
  mode = "throw";
  await assert.rejects(() => requestCardAudio({ project, nodeId: "n", start: 10, count: 10, sampleRate: 48000 }), /card blew up/);
  mode = "ok";
  const good = await requestCardAudio({ project, nodeId: "n", start: 10, count: 10, sampleRate: 48000 });
  assert.equal(good.frames, 10);
  assert.equal(good.channels, 2);
  assert.equal(good.samples.length, 20);
  assert.equal(good.samples[0], 0.5);
  assert.equal(good.url, undefined, "块留在内存里,只有预览的租约才编一份 blob: WAV");

  // 同一个键第二次直接命中缓存,不再求值
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
  assert.equal(calls, 2, "改了素材效果卡源码之后 project 对象不变,旧采样块不能一直用");
}));

test("card audio refuses to evaluate before the registry injects its hooks", async () => withAudio(async ({ requestCardAudio, getCardAudioEpoch, configureCardAudio, subscribeCardAudioEpoch }) => {
  await assert.rejects(() => requestCardAudio({ project: audioProject("n"), nodeId: "n", start: 0, count: 4, sampleRate: 48000 }), /card audio hooks not configured/);
  const seen = [];
  const stop = subscribeCardAudioEpoch(() => seen.push(getCardAudioEpoch()));
  const before = getCardAudioEpoch();
  configureCardAudio({ getCard: () => undefined, sourceVersionOf: () => "v" });
  assert.equal(getCardAudioEpoch(), before + 1, "每调一次 configureCardAudio 版本号 +1");
  assert.deepEqual(seen, [before + 1]);
  stop();
  configureCardAudio({ getCard: () => undefined, sourceVersionOf: () => "v" });
  assert.equal(seen.length, 1, "退订之后不再收到通知");
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
    // 只看节点:kind 不是 audio 的素材效果卡节点不算音频卡(Node 侧的 mux-audio.mjs 用同一条判据)
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
 * 声画一体卡挂在变速素材段上(2026-10-23 用户定「出声。」,推翻〔裁〕V21-28)
 * ------------------------------------------------------------------ */

/** /@media/<hash>/pcm 的假服务端:回一条斜坡,第 k 帧(素材上的绝对帧号)两个声道都是 k(线性插值在斜坡上是精确的) */
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
/** 声画一体卡:左声道交出卡片时钟(audio() 拿到的 range.start 那一格),右声道交出读自己这段素材的那一路 */
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
/** 和 store 的 splitClip 同一个做法:后半段的素材起点按倍率推进(mediaOffsetAfter),节点按 cloneCardClipInstance 复制 */
async function splitAt(project, d) {
  const { mediaOffsetAfter } = await import("../kernel/clipTime.mjs");
  const { cloneCardClipInstance } = await import("../kernel/cardAuthoring.mjs");
  const clip = project.tracks[0].clips[0];
  const cloned = cloneCardClipInstance(project, clip.id, "r", clip.nodeId, d);
  const left = { ...clip, end: d }, right = { ...clip, id: "r", start: d, mediaOffset: mediaOffsetAfter(clip, d), nodeId: cloned.nodeId };
  return { ...cloned.project, tracks: [{ id: "t", clips: [left, right] }] };
}
const SR = 48000;

test("变速素材段上的声画一体卡:预览照常出声;卡片时钟 = mediaOffset ÷ 倍率 + 片段内时间,读素材随倍率变速", async () => withAudio(async ({ configureCardAudio, cardAudioBlockRenderer, generatedCardAudioClipsAt }) => {
  rampFetch();
  configureCardAudio({ getCard: (id) => (id === "av-probe" ? avProbe : undefined), sourceVersionOf: () => "v1" });
  for (const speed of [1, 2, 0.5]) {
    const p = avProject(speed);
    assert.deepEqual(generatedCardAudioClipsAt(p, 1).map((x) => x.clip.id), ["c"], `${speed} 倍:预览的声音层里有这一段`);
    const block = await cardAudioBlockRenderer(p, "avn")(10, 4);
    for (let i = 0; i < 4; i++) {
      assert.equal(block[2 * i], (1 / speed) * SR + 10 + i, `${speed} 倍:卡片时钟`);
      assert.ok(Math.abs(block[2 * i + 1] - (SR + (10 + i) * speed)) < 1e-3, `${speed} 倍:读的素材 = mediaOffset + 片段内采样 × 倍率`);
    }
  }
}));

test("变速素材段上的声画一体卡:切开后卡片时钟与读素材的位置都和切开前同一时刻接得上(2 倍、0.5 倍)", async () => withAudio(async ({ configureCardAudio, cardAudioBlockRenderer }) => {
  rampFetch();
  configureCardAudio({ getCard: (id) => (id === "av-probe" ? avProbe : undefined), sourceVersionOf: () => "v1" });
  for (const speed of [2, 0.5, 1]) {
    const whole = avProject(speed);
    const before = await cardAudioBlockRenderer(whole, "avn")(1.5 * SR, 8);
    const split = await splitAt(whole, 1.5);
    const rightNode = split.tracks[0].clips[1].nodeId;
    const after = await cardAudioBlockRenderer(split, rightNode)(0, 8);
    for (let i = 0; i < 16; i++) assert.ok(Math.abs(after[i] - before[i]) < 1e-3, `${speed} 倍:第 ${i} 格 ${after[i]} ≠ 切开前 ${before[i]}`);
  }
}));

test("变速素材段上的声画一体卡:已生成的声音切开、裁剪后照旧覆盖、不判过期,偏移按时间轴秒推进", async () => withAudio(async ({ configureCardAudio, persistentCardAudio, assertProjectCardAudio }) => {
  configureCardAudio({ getCard: (id) => (id === "av-probe" ? avProbe : undefined), sourceVersionOf: () => "v1" });
  const { cardAudioIdentity, cardAudioSourceOffset } = await import("../kernel/cardAudioRendition.mjs");
  const hooks = { getCard: (id) => (id === "av-probe" ? avProbe : undefined), sourceVersionOf: () => "v1" };
  for (const speed of [2, 0.5]) {
    const whole = avProject(speed);
    const clip = whole.tracks[0].clips[0];
    // 和 cardAudioGeneration.ts 记的一样:区间起点 = 生成时的源时钟,长度 = 片段的时间轴长度
    const cardAudio = { version: 1, cardId: "av-probe", mediaId: "wav", sampleRate: SR, frames: 4 * SR, channels: 2,
      sourceOffset: cardAudioSourceOffset(whole, clip), identity: cardAudioIdentity(whole, clip, hooks) };
    assert.equal(cardAudio.sourceOffset, 1 / speed, "变速段的源时钟 = mediaOffset ÷ 倍率");
    const withWav = (p) => ({ ...p, media: [...p.media, { id: "wav", kind: "audio", url: `/@media/${"c".repeat(64)}`, hash: "c".repeat(64) }],
      tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => ({ ...c, cardAudio })) })) });
    const generated = withWav(whole);
    assert.equal(persistentCardAudio(generated, generated.tracks[0].clips[0]).offset, 0);
    assertProjectCardAudio(generated);
    const split = withWav(await splitAt(whole, 1.5));
    const [left, right] = split.tracks[0].clips;
    assert.equal(persistentCardAudio(split, left).offset, 0, `${speed} 倍:前半段从头放`);
    assert.ok(Math.abs(persistentCardAudio(split, right).offset - 1.5) < 1e-9, `${speed} 倍:后半段从第 1.5 秒放(以前 2 倍时判「未覆盖」、0.5 倍时错放到第 0.75 秒)`);
    assertProjectCardAudio(split);
  }
}));
