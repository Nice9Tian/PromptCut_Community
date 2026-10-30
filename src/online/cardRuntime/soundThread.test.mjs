/**
 * 在线执行用户卡与素材效果卡 · 声音线程(`docs/plan/online-card-exec-contract.md` 3.5、第 6 节)。跑:
 *   node --experimental-test-module-mocks --test src/online/cardRuntime/soundThread.test.mjs
 *
 *   OCE-A-01 占位模块:引进来、取上面的名字、一路点下去都不报错;调用、`new` 才抛「声音代码里不能用 <名字>」;真的载入不了就给占位
 *   OCE-A-02 声音线程:载入同步来的卡(与舞台同一个加载器)、报回哪些卡的声音能合成;求一块采样与编辑页面按同一配方算的逐样本相同;
 *            顶层调用了占位的卡载入不成并说明原因,只是引了占位的卡照常合成;`audio()` 里用了占位、要读素材采样、上游不是载入的卡、
 *            没有这一版项目,各回各的错;换代后按新代码求值
 *   OCE-A-03 舞台一侧的宿主:起线程、载入、求块、项目只发一次;时限按「每秒声音 2 秒墙钟、最少 10 秒」;到时掐掉线程、在途请求失败、
 *            下次重起并重新载入;同一个节点连着两次超时不再试;取消;关掉
 *   OCE-A-04 编辑页面的分派(`cardAudio.ts`):内置卡在页面里求值,同步来的卡只交给隔离的声音宿主;没有宿主、载入不成、要读素材、
 *            两种卡串在一起的合成不了并说明原因;宿主回的坏块不要;编辑页面里同步卡的替身一调就抛;桌面运行环境不变
 *   OCE-A-05 轻重与生成:同步来的卡的声音照 B 的规则测量(只经宿主拿采样块,不建音频上下文、不播)、判轻合成、判重不合成;
 *            生成持久产物的采样全部来自宿主(原来按档不测不合成的那条 2026-10-07 撤销)
 *   OCE-A-06 守门:编辑页面、导出页、声音适配层的源码不引加载器与声音线程;声音线程的包名与白名单一致;线程入口放开用户卡的声音
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");
const require = createRequire(import.meta.url);

const T = await import(srcUrl("online/cardRuntime/transpile.ts"));
const ST = await import(srcUrl("online/cardRuntime/soundStub.ts"));
const TH = await import(srcUrl("online/cardRuntime/soundThread.ts"));
const SH = await import(srcUrl("online/cardRuntime/soundHost.ts"));
const SE = await import(srcUrl("online/cardRuntime/soundEngine.ts"));
const PR = await import(srcUrl("online/cardRuntime/protocol.ts"));
const K = await import(srcUrl("kernel/soundEffects.ts"));
const R = await import(srcUrl("kernel/registry.ts"));
const CA = await import(srcUrl("audio/cardAudio.ts"));
const AS = await import(srcUrl("render/cards/audioSources.ts"));
const SC = await import(srcUrl("audio/soundCost.ts"));
const J = await import(srcUrl("editor/io/onlineSoundJudge.ts"));

const RUNTIME = "ocr1:sucrase@test:tailwindcss@test";
const U = "src/cards/user/";
const hashOf = (body) => createHash("sha256").update(JSON.stringify(body.replace(/\r\n/g, "\n")), "utf8").digest("hex");
const lib = (files) => {
  const m = new Map(Object.entries(files).map(([k, body]) => [k, { body, hash: hashOf(body) }]));
  return { read: (k) => m.get(k) ?? null, set: (k, body) => m.set(k, { body, hash: hashOf(body) }) };
};
const BUILTINS = new Set(["src/kernel/soundEffects.ts", "src/cards/native/hud.tsx"]);
const bundleOf = async (files, entry) => {
  const out = await T.bundleCard({ runtime: RUNTIME, entry, read: files.read, hasBuiltin: (p) => BUILTINS.has(p) });
  assert.equal(out.ok, true, JSON.stringify(out.state ?? null));
  return out.bundle;
};
/** 声音线程的模块表(测试用):形状同 `soundModules.ts` —— 纯计算的给真的,要 DOM 的给占位 */
const soundHost = () => ({
  packages: {
    react: () => require("react"), "react/jsx-runtime": () => require("react/jsx-runtime"),
    "lottie-web": () => ST.createSoundStub("lottie-web"), "@tsparticles/engine": () => ST.createSoundStub("@tsparticles/engine"),
  },
  builtin: (p) => (p === "src/kernel/soundEffects.ts" ? () => K : p === "src/cards/native/hud.tsx" ? () => ST.createSoundStub(p) : null),
});

/** 一张有声用户卡:画面是组件,声音按提示音配方合成(与 `av-pulse` 同一种写法) */
const AV = (id, { top = "", inAudio = "", hz = "params.frequency" } = {}) => `import type { CardDef } from "../../kernel/types";
import lottie from "lottie-web";
import { hud } from "../native/hud";
import { createNotificationRecipe, renderSoundEffectBlock } from "../../kernel/soundEffects";
${top}
const Box = (lottie as any).something;
export const card: CardDef<{ frequency: number }> = {
  id: "${id}", name: "有声 ${id}", defaults: { frequency: 660 }, controls: [], kind: "animation", inputs: {},
  Component: () => <div className={String(hud)} />,
  audio: (_sources, range, params) => {
    ${inAudio}
    return renderSoundEffectBlock(createNotificationRecipe({ frequency: ${hz}, gain: 0.5, duration: 0.2 }), { start: range.start, count: range.count });
  },
};
`;
const clip = (id, cardId, extra = {}) => ({ id, cardId, start: 0, end: 0.5, params: {}, ...extra });
const projectOf = (clips, extra = {}) => ({ version: 1, id: "p", name: "p", width: 640, height: 360, fps: 30, duration: 2, media: [], tracks: [{ id: "t", name: "t", clips }], ...extra });
const expected = (hz, start, count) => K.renderSoundEffectBlock(K.createNotificationRecipe({ frequency: hz, gain: 0.5, duration: 0.2 }), { start, count });

/** 线程加一个收消息的口 */
function threadOf() {
  const out = [];
  const thread = TH.createSoundThread({ runtime: RUNTIME, host: soundHost(), post: (m) => out.push(m) });
  const last = (t) => out.filter((m) => m.t === t).at(-1);
  return { thread, out, last };
}

test("OCE-A-01 占位模块:引进来、取名字不报错,调用与 new 才抛;真的载入不了给占位", async () => {
  const stub = ST.createSoundStub("lottie-web");
  assert.equal(stub.__esModule, true);
  const { default: lottie, loadAnimation } = stub;
  assert.equal(typeof lottie, "function");
  assert.equal(typeof loadAnimation, "function");
  const deep = stub.a.b.c;
  assert.equal(typeof deep, "function", "一路点下去都还是占位");
  assert.equal(`${stub}`.includes("lottie-web"), true, "拼进字符串不抛");
  assert.equal(await Promise.resolve(stub).then(() => "ok"), "ok", "被 await 不当成 thenable");
  assert.throws(() => loadAnimation({}), /声音代码里不能用 lottie-web/);
  assert.throws(() => new lottie.Thing(), /声音代码里不能用 lottie-web/);
  assert.throws(() => stub(), /声音代码里不能用 lottie-web/);
  assert.equal(ST.isSoundStubError(new Error(ST.soundStubMessage("three"))), true);
  assert.equal(ST.isSoundStubError(new Error("别的错")), false);
  // 真的载入得了用真的;载入抛了(模块顶层碰了 document)给占位
  assert.equal(await ST.realOrStub("x", async () => ({ real: 1 }))().then((m) => m.real), 1);
  const fallback = await ST.realOrStub("motion", async () => { throw new ReferenceError("document is not defined"); })();
  assert.throws(() => fallback.animate(), /声音代码里不能用 motion/);
});

test("OCE-A-02 声音线程:载入、报回能合成的卡、求块与页面逐样本相同;各种合成不了各回各的错;换代", async () => {
  const files = lib({
    [`${U}good.tsx`]: AV("good"),
    [`${U}top.tsx`]: AV("top", { top: "lottie.loadAnimation({});" }),
    [`${U}inaudio.tsx`]: AV("inaudio", { inAudio: "lottie.loadAnimation({});" }),
    [`${U}mute.tsx`]: `export const card = { id: "mute", name: "无声", defaults: {}, controls: [], Component: () => null };`,
  });
  const { thread, last } = threadOf();
  const bundles = [await bundleOf(files, `${U}good.tsx`), await bundleOf(files, `${U}top.tsx`), await bundleOf(files, `${U}inaudio.tsx`), await bundleOf(files, `${U}mute.tsx`)];
  await thread.handle({ t: "load", seq: 1, bundles });
  const loaded = last("loaded");
  assert.equal(loaded.seq, 1);
  assert.deepEqual(loaded.audioCards, ["good", "inaudio"], "只有载入成功、写了 audio() 的卡;没有 audio() 的不算");
  assert.deepEqual(Object.keys(loaded.blocked), [`${U}top.tsx`], "文件顶层调用了占位的卡载入不成");
  assert.match(loaded.blocked[`${U}top.tsx`], /声音代码里不能用 lottie-web/);

  const project = projectOf([clip("c1", "good", { params: { frequency: 880 } }), clip("c2", "inaudio"), clip("c3", "mute"),
    clip("c4", "good", { nodeId: "n4" }), clip("m", "", { mediaId: "media-1", cardId: undefined })], {
    media: [{ id: "media-1", kind: "audio", name: "a.wav", url: "/x", hash: "a".repeat(64) }],
    cardNodes: [{ id: "n4", adapter: "card", cardId: "good", kind: "animation", embeddedAudio: true, inputs: { source: { nodeId: "@clip/m/source" } }, params: {} }],
  });
  await thread.handle({ t: "project", key: "k1", project });
  // 求一块:参数取片段上的(880),与编辑页面按同一配方算的逐样本相同
  const messages = [];
  const t2 = TH.createSoundThread({ runtime: RUNTIME, host: soundHost(), post: (m, transfer) => messages.push({ m, transfer }) });
  await t2.handle({ t: "load", seq: 1, bundles });
  await t2.handle({ t: "project", key: "k1", project });
  const ask = async (nodeId, start = 0, count = 4096, key = "k1") => {
    const before = messages.length;
    await t2.handle({ t: "render", id: messages.length + 1, key, nodeId, start, count, sampleRate: 48000 });
    assert.equal(messages.length, before + 1, "每个请求回一条");
    return messages.at(-1);
  };
  const a = await ask("@clip/c1/card", 0, 4096);
  assert.equal(a.m.t, "block");
  assert.ok(a.m.samples instanceof Float32Array);
  assert.deepEqual([...a.m.samples], [...expected(880, 0, 4096)], "与页面按同一配方算的逐样本相同");
  assert.equal(a.transfer?.[0], a.m.samples.buffer, "缓冲区转移出去,不复制");
  assert.ok(a.m.samples.some((v) => v !== 0), "不是静音");
  const b = await ask("@clip/c1/card", 4096, 1000);
  assert.deepEqual([...b.m.samples], [...expected(880, 4096, 1000)], "后面的块接得上");

  // audio() 里用了占位:这一块合成不了,说明原因
  const c = await ask("@clip/c2/card");
  assert.equal(c.m.t, "error");
  assert.match(c.m.message, /声音代码里不能用 lottie-web/);
  // 要读素材采样的(上游是素材节点):本期不在线合成
  const d = await ask("n4");
  assert.equal(d.m.t, "error");
  assert.equal(d.m.message, SE.SOUND_NEEDS_MEDIA);
  // 没有 audio() 的卡、图里没有的节点、没发过的项目、范围不对
  assert.equal((await ask("@clip/c3/card")).m.t, "error");
  assert.match((await ask("nope")).m.message, /找不到节点/);
  assert.match((await ask("@clip/c1/card", 0, 4096, "k-unknown")).m.message, /没有这一版项目/);
  assert.match((await ask("@clip/c1/card", 0, 0)).m.message, /范围不对/);

  // 换代:源码改了(固定 440 Hz),同一份项目按新代码求值
  files.set(`${U}good.tsx`, AV("good", { hz: "440" }));
  await t2.handle({ t: "load", seq: 2, bundles: [await bundleOf(files, `${U}good.tsx`)] });
  assert.deepEqual(messages.at(-1).m.audioCards, ["good"], "不在这一组里的撤下");
  const e = await ask("@clip/c1/card", 0, 2048);
  assert.deepEqual([...e.m.samples], [...expected(440, 0, 2048)]);
  assert.equal((await ask("@clip/c2/card")).m.t, "error", "撤下的卡求不了");
});

/** 进程内的假线程:把宿主发来的消息交给真的 `createSoundThread`;`stall` 为真时不回 `render`(模拟死循环) */
function fakeWorkers() {
  const made = [];
  /** 之后起的线程也都不回 `render` */
  const state = { stallAll: false };
  const spawn = () => {
    const w = { onmessage: null, onerror: null, terminated: false, received: [], stall: false };
    const thread = TH.createSoundThread({ runtime: RUNTIME, host: soundHost(), post: (m) => { if (!w.terminated) queueMicrotask(() => w.onmessage?.({ data: m })); } });
    w.postMessage = (m) => { w.received.push(m); if (w.terminated || ((w.stall || state.stallAll) && m.t === "render")) return; void thread.handle(m); };
    w.terminate = () => { w.terminated = true; };
    made.push(w);
    return w;
  };
  return { spawn, made, state };
}
function fakeTimers() {
  const timers = new Map();
  let seq = 0;
  return { setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { fn, ms }); return id; }, clearTimer: (id) => { timers.delete(id); },
    pending: () => [...timers.values()].map((t) => t.ms), fire() { const [id, t] = [...timers][timers.size - 1]; timers.delete(id); t.fn(); } };
}

test("OCE-A-03 舞台一侧的宿主:起线程、载入、求块;时限;超时掐掉、重起;连着两次超时不再试;取消;关掉", async () => {
  assert.equal(SH.soundTimeoutMs(4096, 48000), 10_000, "不到 5 秒的声音:最少 10 秒");
  assert.equal(SH.soundTimeoutMs(48000 * 30, 48000), 60_000, "30 秒声音:60 秒墙钟");
  assert.equal(SH.soundTimeoutMs(100, 0), 10_000);

  const files = lib({ [`${U}good.tsx`]: AV("good"), [`${U}top.tsx`]: AV("top", { top: "lottie.loadAnimation({});" }) });
  const bundles = [await bundleOf(files, `${U}good.tsx`), await bundleOf(files, `${U}top.tsx`)];
  const project = projectOf([clip("c1", "good")]);
  const workers = fakeWorkers(), timers = fakeTimers();
  const host = SH.createSoundHost({ spawn: workers.spawn, ...timers });
  const outcome = await host.setBundles(bundles);
  assert.deepEqual(outcome.audioCards, ["good"]);
  assert.match(outcome.blocked[`${U}top.tsx`], /声音代码里不能用/);
  assert.equal(workers.made.length, 1, "起了一个线程");
  assert.equal((await host.setBundles(bundles)).audioCards.length, 1, "同一组包不重新载入");
  assert.equal(workers.made[0].received.filter((m) => m.t === "load").length, 1);

  const req = (extra = {}) => ({ projectKey: "k1", project, nodeId: "@clip/c1/card", start: 0, count: 4096, sampleRate: 48000, ...extra });
  const s1 = await host.render(req());
  assert.deepEqual([...s1], [...expected(660, 0, 4096)]);
  await host.render(req({ start: 4096 }));
  assert.equal(workers.made[0].received.filter((m) => m.t === "project").length, 1, "同一版项目只发一次");
  await host.render(req({ projectKey: "k2" }));
  assert.equal(workers.made[0].received.filter((m) => m.t === "project").length, 2);
  assert.deepEqual(timers.pending(), [], "回来了就撤掉计时");

  // 超时:线程不回(死循环)→ 到时掐掉,在途的请求都失败
  workers.made[0].stall = true;
  const p1 = host.render(req({ count: 48000 * 8 }));
  const p2 = host.render(req({ nodeId: "@clip/c1/card", start: 9999, count: 100 }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(timers.pending().sort((a, b) => a - b), [10_000, 16_000], "8 秒声音给 16 秒,短块给 10 秒");
  timers.fire();
  await assert.rejects(p1, new RegExp(SH.SOUND_TIMEOUT_MESSAGE));
  await assert.rejects(p2, new RegExp(SH.SOUND_TIMEOUT_MESSAGE));
  assert.equal(workers.made[0].terminated, true, "线程被 terminate 掐掉");
  assert.equal(host.stats().timeouts, 1);
  assert.equal(host.stats().pending, 0);

  // 下一次要用:重起一个线程,把手里的包重新载入、项目重新发
  const s2 = await host.render(req());
  assert.deepEqual([...s2], [...expected(660, 0, 4096)]);
  assert.equal(workers.made.length, 2);
  assert.equal(workers.made[1].received.filter((m) => m.t === "load").length, 1);
  assert.equal(workers.made[1].received.filter((m) => m.t === "project").length, 1);

  // 同一个节点连着两次超时:第三次不再试
  workers.state.stallAll = true;
  for (let i = 0; i < 2; i++) {
    const p = host.render(req());
    await new Promise((r) => setTimeout(r, 5));
    timers.fire();
    await assert.rejects(p, new RegExp(SH.SOUND_TIMEOUT_MESSAGE));
  }
  workers.state.stallAll = false;
  const spawnedBefore = workers.made.length;
  await assert.rejects(host.render(req()), new RegExp(SH.SOUND_TIMEOUT_MESSAGE));
  assert.equal(workers.made.length, spawnedBefore, "不再为它起线程");

  // 取消:只撤这一个请求
  const host2 = SH.createSoundHost({ spawn: workers.spawn, ...fakeTimers() });
  await host2.setBundles(bundles);
  workers.made.at(-1).stall = true;
  const controller = new AbortController();
  const p3 = host2.render(req(), controller.signal);
  await new Promise((r) => setTimeout(r, 0));
  controller.abort();
  await assert.rejects(p3, { name: "AbortError" });
  assert.equal(workers.made.at(-1).terminated, false, "取消不掐线程");
  assert.equal(host2.stats().pending, 0);
  // 关掉
  host2.dispose();
  assert.equal(workers.made.at(-1).terminated, true);
  await assert.rejects(host2.render(req()), /已经关了/);
  host.dispose();
});

/* ------------------------------------------------------------------ 编辑页面的分派 */

let pageEvaluations = 0;
const builtinAv = { id: "b-av", name: "内置有声卡", source: "native", defaults: { value: 0.25 }, controls: [], frameMode: "direct", kind: "animation", inputs: {}, Component() {},
  audio: (_s, range, p) => { pageEvaluations++; return new Float32Array(range.count * 2).fill(p.value); } };
const builtinAudio = { id: "b-audio", name: "内置音频卡", source: "native", defaults: { value: 0.5 }, controls: [], kind: "audio", inputs: {},
  audio: (_s, range, p) => { pageEvaluations++; return new Float32Array(range.count).fill(p.value); } };
const defs = new Map([builtinAv, builtinAudio].map((d) => [d.id, d]));
const SYNCED = [
  { id: "s-av", name: "同步有声卡", source: `${U}s-av.tsx`, embeddedAudio: true, audioSourceVersion: "asv-1", defaults: { frequency: 660 } },
  { id: "s-bad", name: "载入不成的", source: `${U}s-bad.tsx`, embeddedAudio: true, audioSourceVersion: "asv-2", defaults: {} },
  { id: "s-mute", name: "同步无声卡", source: `${U}s-mute.tsx`, defaults: {} },
];
/** 假的隔离宿主:记下每次请求,回固定值的块 */
function fakeIsolated({ value = 0.125, channels = 1, bad = null } = {}) {
  const calls = [];
  return { calls,
    runnable: (id) => id === "s-av" || id === "s-node",
    blocker: (id) => (id === "s-bad" ? "声音代码里不能用 lottie-web" : null),
    versionOf: (id) => `gen-${id}`,
    render: async (request) => {
      calls.push({ nodeId: request.nodeId, start: request.start, count: request.count, sampleRate: request.sampleRate });
      if (bad === "nan") return new Float32Array(request.count).fill(NaN);
      if (bad === "shape") return new Float32Array(request.count + 1);
      if (bad === "type") return [0, 0];
      return new Float32Array(request.count * channels).fill(value);
    } };
}
function editorSetup({ online = true } = {}) {
  R.resetCards();
  R.registerCards([builtinAv, builtinAudio]);
  R.setSyncedUserCards(SYNCED);
  CA.configureCardAudio({ getCard: (id) => defs.get(id), sourceVersionOf: () => "v1" });
  CA.setIsolatedCardAudioHost(null);
  if (online) globalThis.__pcOnlinePage = true; else delete globalThis.__pcOnlinePage;
  pageEvaluations = 0;
}
function editorCleanup() {
  delete globalThis.__pcOnlinePage;
  CA.setIsolatedCardAudioHost(null);
  R.setSyncedUserCards([]);
}
const editorProject = () => projectOf([clip("b", "b-av"), clip("s", "s-av"), clip("x", "s-bad"), clip("q", "s-mute"),
  clip("n", "", { cardId: undefined, nodeId: "n-audio" }), clip("mix", "", { cardId: undefined, nodeId: "n-mix" }), clip("med", "", { cardId: undefined, mediaId: "media-1", nodeId: "n-media" })], {
  media: [{ id: "media-1", kind: "audio", name: "a.wav", url: "/x", hash: "a".repeat(64) }],
  cardNodes: [
    { id: "n-audio", adapter: "card", cardId: "s-node", kind: "audio", inputs: {}, params: {} },
    { id: "n-up", adapter: "card", cardId: "b-audio", kind: "audio", inputs: {}, params: {} },
    { id: "n-mix", adapter: "card", cardId: "s-node", kind: "audio", inputs: { source: { nodeId: "n-up" } }, params: {} },
    { id: "n-media", adapter: "card", cardId: "s-node", kind: "audio", inputs: { source: { nodeId: "@clip/med/source" } }, params: {} },
  ] });

test("OCE-A-04 编辑页面的分派:内置卡在页面里求值,同步来的卡只交给隔离的声音宿主;合成不了的说明原因", async () => {
  editorSetup();
  try {
    const p = editorProject();
    const node = (id) => CA.cardAudioNodeOf(p, p.tracks[0].clips.find((c) => c.id === id));
    assert.equal(node("s"), "@clip/s/card", "同步来的有声用户卡:片段有音频节点");
    assert.equal(node("q"), null, "同步来的无声卡没有");
    // 没接宿主:内置卡照旧在页面里;同步来的合成不了
    assert.deepEqual(CA.cardAudioRoute(p, node("b")), { route: "page" });
    assert.deepEqual(CA.cardAudioRoute(p, node("s")), { route: null, reason: CA.ONLINE_AUDIO_NO_THREAD });
    assert.equal(CA.onlineCardAudioSynthesizable(p, node("s")), false);
    await assert.rejects(CA.requestCardAudio({ project: p, nodeId: node("s"), start: 0, count: 64, sampleRate: 48000 }), new RegExp(CA.ONLINE_AUDIO_NO_THREAD.slice(0, 12)));

    // 接上宿主
    const iso = fakeIsolated();
    CA.setIsolatedCardAudioHost(iso);
    assert.deepEqual(CA.cardAudioRoute(p, node("s")), { route: "isolated" });
    assert.deepEqual(CA.cardAudioRoute(p, "n-audio"), { route: "isolated" }, "同步来的音频素材效果卡(不读素材)");
    assert.deepEqual(CA.cardAudioRoute(p, node("x")), { route: null, reason: "声音代码里不能用 lottie-web" }, "线程里载入不成:原因照搬");
    assert.deepEqual(CA.cardAudioRoute(p, "n-mix"), { route: null, reason: CA.ONLINE_AUDIO_MIXED });
    assert.deepEqual(CA.cardAudioRoute(p, "n-media"), { route: null, reason: CA.ONLINE_AUDIO_NEEDS_MEDIA }, "要读素材采样的音频素材效果卡不在线合成");
    assert.equal(CA.onlineCardAudioBlocker(p, "n-media"), CA.ONLINE_AUDIO_NEEDS_MEDIA);
    assert.equal(CA.onlineCardAudioBlocker(p, node("s")), null);

    const reply = await CA.requestCardAudio({ project: p, nodeId: node("s"), start: 0, count: 64, sampleRate: 48000 });
    assert.equal(reply.frames, 64);
    assert.equal(reply.channels, 1);
    assert.equal(reply.samples[0], 0.125);
    assert.deepEqual(iso.calls, [{ nodeId: "@clip/s/card", start: 0, count: 64, sampleRate: 48000 }], "采样块来自隔离宿主");
    assert.equal(pageEvaluations, 0, "编辑页面里没有求值");
    // 内置卡:照旧在页面里,不去宿主
    const builtinReply = await CA.requestCardAudio({ project: p, nodeId: node("b"), start: 0, count: 64, sampleRate: 48000 });
    assert.equal(builtinReply.samples[0], 0.25);
    assert.equal(pageEvaluations, 1);
    assert.equal(iso.calls.length, 1);

    // 编辑页面里同步卡的替身:一调就抛,真的声音代码不在这里
    const standIn = CA.cardAudioGraphCard("s-av");
    assert.equal(R.getCard("s-av"), undefined, "注册表里没有它的定义");
    assert.deepEqual(standIn.defaults, { frequency: 660 });
    assert.throws(() => standIn.audio({}, { start: 0, count: 1, sampleRate: 48000 }, {}), new RegExp(CA.SYNCED_AUDIO_NOT_HERE));
    assert.equal(CA.cardAudioGraphCard("s-mute"), undefined, "无声的同步卡没有替身");
    assert.equal(CA.cardAudioGraphCard("b-av"), builtinAv, "页面里有定义的用定义");
    const G = await import(srcUrl("kernel/cardGraph.mjs"));
    await assert.rejects(AS.evaluateCardAudio({ graph: G.projectCardGraph(p, CA.cardAudioGraphCard), project: p, getCard: CA.cardAudioGraphCard, sampleRate: 48000 }, "@clip/s/card", { start: 0, count: 8, sampleRate: 48000 }),
      /声音代码|不在编辑页面里执行/, "就算有人拿替身直接求值,也执行不到同步卡的代码");

    // 宿主回的坏块不要(声音线程回来的东西当不可信输入)
    for (const bad of ["nan", "shape", "type"]) {
      CA.setIsolatedCardAudioHost(fakeIsolated({ bad }));
      await assert.rejects(CA.requestCardAudio({ project: { ...p }, nodeId: "@clip/s/card", start: 0, count: 64, sampleRate: 48000 }), /声音线程回的采样块/, bad);
    }

    // 桌面运行环境:不看宿主,同步表为空时与原来相同
    editorSetup({ online: false });
    R.setSyncedUserCards([]);
    CA.setIsolatedCardAudioHost(fakeIsolated());
    const desk = editorProject();
    assert.equal((await CA.requestCardAudio({ project: desk, nodeId: "@clip/b/card", start: 0, count: 32, sampleRate: 48000 })).samples[0], 0.25);
    assert.equal(pageEvaluations, 1);
  } finally { editorCleanup(); }
});

test("OCE-A-05 轻重与生成:测量只经宿主拿采样块(不出声),判轻合成、判重不合成;持久产物的采样来自宿主", async () => {
  editorSetup();
  const audioLog = [];
  const realAC = globalThis.AudioContext, realURL = globalThis.URL.createObjectURL;
  globalThis.AudioContext = class { constructor() { audioLog.push("AudioContext"); } };
  globalThis.URL.createObjectURL = (...a) => { audioLog.push("createObjectURL"); return realURL ? realURL.apply(globalThis.URL, a) : "blob:x"; };
  const store = SC.createMemorySoundCostStore();
  const restore = J.configureOnlineSoundJudge({ online: () => true, store: () => store, device: () => "test-device" });
  try {
    const p = editorProject();
    const s = p.tracks[0].clips.find((c) => c.id === "s"), x = p.tracks[0].clips.find((c) => c.id === "x");
    // 没接宿主:跑不了,说明里写原因
    let d = await J.decideClipSound(p, s);
    assert.deepEqual([d.synth, d.reason, d.message], [false, "not-runnable", CA.ONLINE_AUDIO_NO_THREAD]);
    const iso = fakeIsolated();
    CA.setIsolatedCardAudioHost(iso);
    assert.equal(J.clipSoundRunnable(p, s), true);
    assert.equal(J.clipSoundRunnable(p, x), false);
    assert.equal((await J.decideClipSound(p, x)).message, "声音代码里不能用 lottie-web", "载入不成的:原因照搬到说明里");
    // 第一次要用:测量(经宿主),判轻
    d = await J.decideClipSound(p, s);
    assert.equal(d.synth, true);
    assert.ok(iso.calls.length >= 1, "测量的采样块来自隔离宿主");
    assert.equal(pageEvaluations, 0, "编辑页面里没有执行任何 audio()");
    assert.deepEqual(audioLog, [], "测量不出声:没有新建音频上下文、没有可播放地址");
    const measured = iso.calls.length;
    // 记录在:再问不重测
    assert.equal((await J.decideClipSound(p, s)).synth, true);
    assert.equal(iso.calls.length, measured, "复用记录,不重测");
    // 判重(按真实的记录形状写一条每块 200 ms):不合成
    const key = J.soundTargetOf(p, s).soundKey;
    await store.putCost(SC.soundCostStoreKey(key, "test-device"), { soundKey: key, kind: "card", device: "test-device", blockMs: 200, blockMaxMs: 220, blockFrames: 4096, sampleRate: 48000, samples: 16, measuredAt: 1 });
    J.configureOnlineSoundJudge({})();
    const restore2 = J.configureOnlineSoundJudge({ online: () => true, store: () => store, device: () => "test-device" });
    d = await J.decideClipSound(p, s);
    assert.deepEqual([d.synth, d.reason], [false, "heavy"]);
    restore2();

    // 生成持久产物:整段采样来自宿主,WAV 的声道数、帧数对
    const iso2 = fakeIsolated({ value: 0.5, channels: 2 });
    CA.setIsolatedCardAudioHost(iso2);
    const p3 = editorProject();
    const s3 = p3.tracks[0].clips.find((c) => c.id === "s");
    const wav = await CA.renderEmbeddedCardWav(p3, s3, new AbortController().signal);
    assert.equal(wav.frames, 24000);
    assert.equal(wav.channels, 2);
    assert.equal(iso2.calls.reduce((n, c) => n + c.count, 0), 24000, "一段不落、不重");
    assert.equal(new DataView(wav.wav.buffer).getFloat32(44, true), 0.5);
    assert.equal(pageEvaluations, 0);
    // 合成不了的:生成直接报原因
    await assert.rejects(CA.renderEmbeddedCardWav(p3, p3.tracks[0].clips.find((c) => c.id === "x"), new AbortController().signal), /声音代码里不能用 lottie-web/);
  } finally {
    restore();
    globalThis.AudioContext = realAC;
    globalThis.URL.createObjectURL = realURL;
    editorCleanup();
  }
});

test("OCE-A-06 守门:编辑页面、导出页、声音适配层不引加载器与声音线程;包名与白名单一致;线程入口放开用户卡的声音", () => {
  const forbidden = /cardRuntime\/(loader|soundThread|soundEngine|soundModules|soundWorker|soundHost|soundSpawn|stageRuntime|hostModules)/;
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const offenders = [];
  for (const dir of ["src/editor", "src/export", "src/audio", "src/store"]) {
    for (const file of walk(path.join(ROOT, dir))) {
      if (!/\.(ts|tsx|mjs)$/.test(file) || /\.test\./.test(file)) continue;
      if (forbidden.test(fs.readFileSync(file, "utf8"))) offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], "这些文件在编辑页面的源里,不能引执行卡片代码的模块");
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  // 声音线程的包表:名字与白名单一一对应;要 DOM 的三样是占位
  const modules = read("src/online/cardRuntime/soundModules.ts");
  const names = [...modules.matchAll(/^  "([^"]+)": (realOrStub|stub)\(/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(names.map((n) => n[0]).sort(), [...PR.CARD_PACKAGES].sort());
  assert.deepEqual(names.filter((n) => n[1] === "stub").map((n) => n[0]).sort(), ["@tsparticles/engine", "@tsparticles/slim", "lottie-web", "react-dom"]);
  // 线程入口:这里就是隔离环境,放开用户卡的声音;用同一个加载器
  const worker = read("src/online/cardRuntime/soundWorker.ts");
  assert.match(worker, /setOnlineUserCardAudioGate\(\(\) => true\)/);
  assert.match(worker, /createSoundThread\(/);
  assert.match(read("src/online/cardRuntime/soundThread.ts"), /createCardLoader\(/, "与舞台同一个加载器");
  // 编辑页面这一侧不放开:`soundPolicy.ts` 的接口只在线程入口里调
  // A3 之后闭源的那几摊在 cloud/ 下（公开仓库里没有这个目录）；这道检查原来就管着它们，搬走以后也要接着管
  const pageDirs = [path.join(ROOT, "src"), ...[path.join(ROOT, "cloud", "src"), path.join(ROOT, "cloud", "online")].filter((d) => fs.existsSync(d))];
  const callers = pageDirs.flatMap(walk).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) && /setOnlineUserCardAudioGate\(/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, "/")).sort();
  assert.deepEqual(callers, ["src/online/cardRuntime/soundWorker.ts", "src/online/soundPolicy.ts"]);
});

test("OCE-A-07 整条链路(不含舞台 RPC):编辑页面要一块 → 隔离宿主 → 舞台的声音这一半 → 线程里执行同步卡的 audio() → 采样块回来", async () => {
  const SS = await import(srcUrl("online/cardRuntime/stageSound.ts"));
  const IS = await import(srcUrl("editor/io/isolatedSound.ts"));
  const files = lib({ [`${U}s-av.tsx`]: AV("s-av"), [`${U}s-bad.tsx`]: AV("s-bad", { top: "lottie.loadAnimation({});" }) });
  const bundles = [await bundleOf(files, `${U}s-av.tsx`), await bundleOf(files, `${U}s-bad.tsx`)];
  const workers = fakeWorkers();
  const reported = [];
  const sound = SS.createStageSound({ spawn: workers.spawn, ...fakeTimers(), onState: (s) => reported.push(s),
    entryCards: (entry) => SYNCED.filter((c) => c.source === entry).map((c) => c.id) });
  const rpc = [];
  // 舞台 RPC 的替身:结构化克隆一遍(跨文档传的就是克隆)
  const link = IS.createIsolatedSoundLink({ render: (request, signal) => { rpc.push({ ...request, project: request.project === undefined ? undefined : "有" }); return sound.render(structuredClone(request), signal); } });
  editorSetup();
  try {
    const state = await sound.setBundles(bundles);
    assert.deepEqual(Object.keys(state.ready), ["s-av"]);
    assert.match(state.blocked["s-bad"], /声音代码里不能用 lottie-web/);
    assert.deepEqual(reported.at(-1), state);
    link.setState(state);
    assert.equal(CA.isolatedCardAudioHost(), link.host());
    const p = projectOf([clip("s", "s-av", { params: { frequency: 990 } }), clip("x", "s-bad")]);
    assert.deepEqual(CA.cardAudioRoute(p, "@clip/s/card"), { route: "isolated" });
    assert.match(CA.cardAudioRoute(p, "@clip/x/card").reason, /声音代码里不能用 lottie-web/);
    const reply = await CA.requestCardAudio({ project: p, nodeId: "@clip/s/card", start: 0, count: 2048, sampleRate: 48000 });
    assert.deepEqual([...reply.samples], [...expected(990, 0, 2048)], "编辑页面拿到的就是线程里那张卡按片段参数算出来的采样");
    await CA.requestCardAudio({ project: p, nodeId: "@clip/s/card", start: 2048, count: 512, sampleRate: 48000 });
    assert.deepEqual(rpc.map((r) => r.project), ["有", undefined], "项目每个版本只发一次");
    assert.equal(pageEvaluations, 0);

    // 舞台那头重起过(状态重报):之前发过的项目重新带上
    link.setState(await sound.setBundles(bundles));
    await CA.requestCardAudio({ project: p, nodeId: "@clip/s/card", start: 4096, count: 64, sampleRate: 48000 });
    assert.equal(rpc.at(-1).project, "有");

    // 换代:签名变了,块缓存不串(同一个项目、同一段,按新代码)
    const v1 = link.host().versionOf("s-av");
    files.set(`${U}s-av.tsx`, AV("s-av", { hz: "330" }));
    link.setState(await sound.setBundles([await bundleOf(files, `${U}s-av.tsx`)]));
    assert.notEqual(link.host().versionOf("s-av"), v1);
    const again = await CA.requestCardAudio({ project: p, nodeId: "@clip/s/card", start: 0, count: 2048, sampleRate: 48000 });
    assert.deepEqual([...again.samples], [...expected(330, 0, 2048)]);

    // 舞台报来的状态当不可信输入
    assert.equal(IS.sanitizeSoundState("x"), null);
    assert.deepEqual(IS.sanitizeSoundState({ ready: { a: "1", b: 2, "": "x" }, blocked: { c: "原因".repeat(200) } }), { ready: { a: "1" }, blocked: { c: "原因".repeat(200).slice(0, 240) } });
    // 线程没了:撤下宿主,同步来的卡回到「合成不了」
    link.setState(null);
    assert.equal(CA.isolatedCardAudioHost(), null);
    assert.deepEqual(CA.cardAudioRoute(p, "@clip/s/card"), { route: null, reason: CA.ONLINE_AUDIO_NO_THREAD });
  } finally {
    link.dispose();
    sound.dispose();
    editorCleanup();
  }
});
