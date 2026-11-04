/**
 * Online execution of user cards and media effect cards · sound thread
 * (`docs/plan/online-card-exec-contract.md` 3.5, section 6). Run:
 *   node --experimental-test-module-mocks --test src/online/cardRuntime/soundThread.test.mjs
 *
 *   OCE-A-01 Placeholder module: importing it, accessing names on it, chaining accesses down never
 *            throws; invoking or `new` throws "Cannot use <name> in sound code"; provide placeholder
 *            if it truly cannot load
 *   OCE-A-02 Sound thread: loads synced cards (same loader as stage), reports back which cards'
 *            sound can be synthesized; evaluating a sample chunk matches sample-by-sample with what
 *            editor computes per the same recipe; cards calling placeholders at top level fail to
 *            load with reasons, cards only importing placeholders synthesize normally; using
 *            placeholders in `audio()`, needing to read media samples, upstream not a loaded card,
 *            missing this project revision each return their respective errors; evaluate with new
 *            code after a generation change
 *   OCE-A-03 Stage-side host: spawns thread, loads, computes chunks, sends project only once; time
 *            limit is "2 seconds wall-clock per second of audio, minimum 10 seconds"; kills thread
 *            on timeout, in-flight requests fail, restarts and reloads on next use; do not retry
 *            after two consecutive timeouts on the same node; cancel; shut down
 *   OCE-A-04 Editor dispatch (`cardAudio.ts`): built-in cards evaluate in page, synced cards only
 *            handed to isolated sound host; without host, load failure, needing to read media, or
 *            two cards chained together cannot synthesize and state reasons; discard bad chunks
 *            returned by host; synced card stubs in editor throw immediately when called; desktop
 *            runtime environment unchanged
 *   OCE-A-05 Light/heavy classification and generation: sound of synced cards is measured per B's
 *            rules (only retrieves sample chunks via host, no audio context created, no playback),
 *            classify as light synthesizes, classify as heavy does not; samples for generating
 *            persistent artifacts come entirely from host (the previous rule of not measuring and
 *            not synthesizing by tier revoked on 2026-10-07)
 *   OCE-A-06 Gatekeeper: source code of editor, export page, and sound adapter layer does not import
 *            loader or sound thread; sound thread package names match allowlist; thread entry
 *            enables user card audio
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
/**
 * Sound thread module table (for testing): same shape as `soundModules.ts`: real for pure
 * computation, placeholders for DOM
 */
const soundHost = () => ({
  packages: {
    react: () => require("react"), "react/jsx-runtime": () => require("react/jsx-runtime"),
    "lottie-web": () => ST.createSoundStub("lottie-web"), "@tsparticles/engine": () => ST.createSoundStub("@tsparticles/engine"),
  },
  builtin: (p) => (p === "src/kernel/soundEffects.ts" ? () => K : p === "src/cards/native/hud.tsx" ? () => ST.createSoundStub(p) : null),
});

/**
 * Audio user card: visuals are a component, sound is synthesized per notification sound recipe
 * (same approach as `av-pulse`)
 */
const AV = (id, { top = "", inAudio = "", hz = "params.frequency" } = {}) => `import type { CardDef } from "../../kernel/types";
import lottie from "lottie-web";
import { hud } from "../native/hud";
import { createNotificationRecipe, renderSoundEffectBlock } from "../../kernel/soundEffects";
${top}
const Box = (lottie as any).something;
export const card: CardDef<{ frequency: number }> = {
  id: "${id}", name: "With sound ${id}", defaults: { frequency: 660 }, controls: [], kind: "animation", inputs: {},
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

/** Add an incoming message port to the thread */
function threadOf() {
  const out = [];
  const thread = TH.createSoundThread({ runtime: RUNTIME, host: soundHost(), post: (m) => out.push(m) });
  const last = (t) => out.filter((m) => m.t === t).at(-1);
  return { thread, out, last };
}

test("OCE-A-01 placeholder module: importing it and reading names does not throw, only calling and new throw; if it truly cannot be loaded, a placeholder is given", async () => {
  const stub = ST.createSoundStub("lottie-web");
  assert.equal(stub.__esModule, true);
  const { default: lottie, loadAnimation } = stub;
  assert.equal(typeof lottie, "function");
  assert.equal(typeof loadAnimation, "function");
  const deep = stub.a.b.c;
  assert.equal(typeof deep, "function", "Following the chain all the way down is still a placeholder");
  assert.equal(`${stub}`.includes("lottie-web"), true, "does not throw when concatenated into a string");
  assert.equal(await Promise.resolve(stub).then(() => "ok"), "ok", "not treated as a thenable when awaited");
  assert.throws(() => loadAnimation({}), /Sound code cannot use lottie-web/);
  assert.throws(() => new lottie.Thing(), /Sound code cannot use lottie-web/);
  assert.throws(() => stub(), /Sound code cannot use lottie-web/);
  assert.equal(ST.isSoundStubError(new Error(ST.soundStubMessage("three"))), true);
  assert.equal(ST.isSoundStubError(new Error("other error")), false);
  // Use real module if it loads; provide placeholder if loading throws (top level touched document)
  assert.equal(await ST.realOrStub("x", async () => ({ real: 1 }))().then((m) => m.real), 1);
  const fallback = await ST.realOrStub("motion", async () => { throw new ReferenceError("document is not defined"); })();
  assert.throws(() => fallback.animate(), /Sound code cannot use motion/);
});

test("OCE-A-02 sound thread: load, report the cards that can be synthesized, requested chunks match the page sample by sample; each kind of non-synthesizable card returns its own error; generation change", async () => {
  const files = lib({
    [`${U}good.tsx`]: AV("good"),
    [`${U}top.tsx`]: AV("top", { top: "lottie.loadAnimation({});" }),
    [`${U}inaudio.tsx`]: AV("inaudio", { inAudio: "lottie.loadAnimation({});" }),
    [`${U}mute.tsx`]: `export const card = { id: "mute", name: "Silent", defaults: {}, controls: [], Component: () => null };`,
  });
  const { thread, last } = threadOf();
  const bundles = [await bundleOf(files, `${U}good.tsx`), await bundleOf(files, `${U}top.tsx`), await bundleOf(files, `${U}inaudio.tsx`), await bundleOf(files, `${U}mute.tsx`)];
  await thread.handle({ t: "load", seq: 1, bundles });
  const loaded = last("loaded");
  assert.equal(loaded.seq, 1);
  assert.deepEqual(loaded.audioCards, ["good", "inaudio"], "only cards that loaded successfully and define audio(); cards without audio() do not count");
  assert.deepEqual(Object.keys(loaded.blocked), [`${U}top.tsx`], "a card that calls a placeholder at file top level fails to load");
  assert.match(loaded.blocked[`${U}top.tsx`], /Sound code cannot use lottie-web/);

  const project = projectOf([clip("c1", "good", { params: { frequency: 880 } }), clip("c2", "inaudio"), clip("c3", "mute"),
    clip("c4", "good", { nodeId: "n4" }), clip("m", "", { mediaId: "media-1", cardId: undefined })], {
    media: [{ id: "media-1", kind: "audio", name: "a.wav", url: "/x", hash: "a".repeat(64) }],
    cardNodes: [{ id: "n4", adapter: "card", cardId: "good", kind: "animation", embeddedAudio: true, inputs: { source: { nodeId: "@clip/m/source" } }, params: {} }],
  });
  await thread.handle({ t: "project", key: "k1", project });
  // Compute a chunk: params from clip (880), identical sample-by-sample to editor with the same recipe
  const messages = [];
  const t2 = TH.createSoundThread({ runtime: RUNTIME, host: soundHost(), post: (m, transfer) => messages.push({ m, transfer }) });
  await t2.handle({ t: "load", seq: 1, bundles });
  await t2.handle({ t: "project", key: "k1", project });
  const ask = async (nodeId, start = 0, count = 4096, key = "k1") => {
    const before = messages.length;
    await t2.handle({ t: "render", id: messages.length + 1, key, nodeId, start, count, sampleRate: 48000 });
    assert.equal(messages.length, before + 1, "one reply per request");
    return messages.at(-1);
  };
  const a = await ask("@clip/c1/card", 0, 4096);
  assert.equal(a.m.t, "block");
  assert.ok(a.m.samples instanceof Float32Array);
  assert.deepEqual([...a.m.samples], [...expected(880, 0, 4096)], "matches, sample by sample, what the page computes with the same recipe");
  assert.equal(a.transfer?.[0], a.m.samples.buffer, "buffer is transferred, not copied");
  assert.ok(a.m.samples.some((v) => v !== 0), "not silence");
  const b = await ask("@clip/c1/card", 4096, 1000);
  assert.deepEqual([...b.m.samples], [...expected(880, 4096, 1000)], "later chunks line up");

  // Placeholder used in audio(): this chunk cannot be synthesized, explain the reason
  const c = await ask("@clip/c2/card");
  assert.equal(c.m.t, "error");
  assert.match(c.m.message, /Sound code cannot use lottie-web/);
  // Needing to read media samples (upstream is media node): no online synthesis in this iteration
  const d = await ask("n4");
  assert.equal(d.m.t, "error");
  assert.equal(d.m.message, SE.SOUND_NEEDS_MEDIA);
  // Cards without audio(), nodes not in graph, unsent projects, invalid ranges
  assert.equal((await ask("@clip/c3/card")).m.t, "error");
  assert.match((await ask("nope")).m.message, /Node nope not found/);
  assert.match((await ask("@clip/c1/card", 0, 4096, "k-unknown")).m.message, /does not have this project revision/);
  assert.match((await ask("@clip/c1/card", 0, 0)).m.message, /Sound request is out of range/);

  // Generation change: source code changed (fixed 440 Hz), evaluate same project with new code
  files.set(`${U}good.tsx`, AV("good", { hz: "440" }));
  await t2.handle({ t: "load", seq: 2, bundles: [await bundleOf(files, `${U}good.tsx`)] });
  assert.deepEqual(messages.at(-1).m.audioCards, ["good"], "cards not in this set are withdrawn");
  const e = await ask("@clip/c1/card", 0, 2048);
  assert.deepEqual([...e.m.samples], [...expected(440, 0, 2048)]);
  assert.equal((await ask("@clip/c2/card")).m.t, "error", "a withdrawn card cannot be requested");
});

/**
 * In-process fake thread: forwards host messages to real `createSoundThread`; does not reply
 * `render` when `stall` is true (simulating infinite loop)
 */
function fakeWorkers() {
  const made = [];
  /** Threads spawned later also do not reply with `render` */
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

test("OCE-A-03 stage-side host: spawn thread, load, request chunks; time limit; kill on timeout and restart; no retry after two consecutive timeouts; cancel; close", async () => {
  assert.equal(SH.soundTimeoutMs(4096, 48000), 10_000, "sound under 5 seconds: 10 seconds minimum");
  assert.equal(SH.soundTimeoutMs(48000 * 30, 48000), 60_000, "30-second sound: 60-second wall clock");
  assert.equal(SH.soundTimeoutMs(100, 0), 10_000);

  const files = lib({ [`${U}good.tsx`]: AV("good"), [`${U}top.tsx`]: AV("top", { top: "lottie.loadAnimation({});" }) });
  const bundles = [await bundleOf(files, `${U}good.tsx`), await bundleOf(files, `${U}top.tsx`)];
  const project = projectOf([clip("c1", "good")]);
  const workers = fakeWorkers(), timers = fakeTimers();
  const host = SH.createSoundHost({ spawn: workers.spawn, ...timers });
  const outcome = await host.setBundles(bundles);
  assert.deepEqual(outcome.audioCards, ["good"]);
  assert.match(outcome.blocked[`${U}top.tsx`], /Sound code cannot use/);
  assert.equal(workers.made.length, 1, "one thread was spawned");
  assert.equal((await host.setBundles(bundles)).audioCards.length, 1, "Same set of bundles is not reloaded");
  assert.equal(workers.made[0].received.filter((m) => m.t === "load").length, 1);

  const req = (extra = {}) => ({ projectKey: "k1", project, nodeId: "@clip/c1/card", start: 0, count: 4096, sampleRate: 48000, ...extra });
  const s1 = await host.render(req());
  assert.deepEqual([...s1], [...expected(660, 0, 4096)]);
  await host.render(req({ start: 4096 }));
  assert.equal(workers.made[0].received.filter((m) => m.t === "project").length, 1, "the same project version is sent only once");
  await host.render(req({ projectKey: "k2" }));
  assert.equal(workers.made[0].received.filter((m) => m.t === "project").length, 2);
  assert.deepEqual(timers.pending(), [], "timers are cleared once replies return");

  // Timeout: thread does not reply (infinite loop) → killed on timeout, all in-flight requests fail
  workers.made[0].stall = true;
  const p1 = host.render(req({ count: 48000 * 8 }));
  const p2 = host.render(req({ nodeId: "@clip/c1/card", start: 9999, count: 100 }));
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(timers.pending().sort((a, b) => a - b), [10_000, 16_000], "8-second sound gets 16 seconds, short chunk gets 10 seconds");
  timers.fire();
  await assert.rejects(p1, new RegExp(SH.SOUND_TIMEOUT_MESSAGE));
  await assert.rejects(p2, new RegExp(SH.SOUND_TIMEOUT_MESSAGE));
  assert.equal(workers.made[0].terminated, true, "thread is killed via terminate");
  assert.equal(host.stats().timeouts, 1);
  assert.equal(host.stats().pending, 0);

  // Next use: restart a thread, reload held packages, and resend the project
  const s2 = await host.render(req());
  assert.deepEqual([...s2], [...expected(660, 0, 4096)]);
  assert.equal(workers.made.length, 2);
  assert.equal(workers.made[1].received.filter((m) => m.t === "load").length, 1);
  assert.equal(workers.made[1].received.filter((m) => m.t === "project").length, 1);

  // Two consecutive timeouts on the same node: do not retry a third time
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
  assert.equal(workers.made.length, spawnedBefore, "no more threads are spawned for it");

  // Cancel: abort only this request
  const host2 = SH.createSoundHost({ spawn: workers.spawn, ...fakeTimers() });
  await host2.setBundles(bundles);
  workers.made.at(-1).stall = true;
  const controller = new AbortController();
  const p3 = host2.render(req(), controller.signal);
  await new Promise((r) => setTimeout(r, 0));
  controller.abort();
  await assert.rejects(p3, { name: "AbortError" });
  assert.equal(workers.made.at(-1).terminated, false, "cancel does not kill the thread");
  assert.equal(host2.stats().pending, 0);
  // Shut down
  host2.dispose();
  assert.equal(workers.made.at(-1).terminated, true);
  await assert.rejects(host2.render(req()), /already been closed/);
  host.dispose();
});

/* ------------------------------------------------------------------ Editor dispatch */

let pageEvaluations = 0;
const builtinAv = { id: "b-av", name: "Built-in AV card", source: "native", defaults: { value: 0.25 }, controls: [], frameMode: "direct", kind: "animation", inputs: {}, Component() {},
  audio: (_s, range, p) => { pageEvaluations++; return new Float32Array(range.count * 2).fill(p.value); } };
const builtinAudio = { id: "b-audio", name: "Built-in audio card", source: "native", defaults: { value: 0.5 }, controls: [], kind: "audio", inputs: {},
  audio: (_s, range, p) => { pageEvaluations++; return new Float32Array(range.count).fill(p.value); } };
const defs = new Map([builtinAv, builtinAudio].map((d) => [d.id, d]));
const SYNCED = [
  { id: "s-av", name: "Synced card with sound", source: `${U}s-av.tsx`, embeddedAudio: true, audioSourceVersion: "asv-1", defaults: { frequency: 660 } },
  { id: "s-bad", name: "Fails to load", source: `${U}s-bad.tsx`, embeddedAudio: true, audioSourceVersion: "asv-2", defaults: {} },
  { id: "s-mute", name: "Synced silent card", source: `${U}s-mute.tsx`, defaults: {} },
];
/** Fake isolated host: records each request, returns fixed-value chunks */
function fakeIsolated({ value = 0.125, channels = 1, bad = null } = {}) {
  const calls = [];
  return { calls,
    runnable: (id) => id === "s-av" || id === "s-node",
    blocker: (id) => (id === "s-bad" ? "Sound code cannot use lottie-web" : null),
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

test("OCE-A-04 editor page dispatch: built-in cards are evaluated in the page, synced cards go only to the isolated sound host; cards that cannot be synthesized state the reason", async () => {
  editorSetup();
  try {
    const p = editorProject();
    const node = (id) => CA.cardAudioNodeOf(p, p.tracks[0].clips.find((c) => c.id === id));
    assert.equal(node("s"), "@clip/s/card", "synced user card with sound: the clip has an audio node");
    assert.equal(node("q"), null, "synced silent card has none");
    // No host connected: built-in cards stay in page as before; synced cards cannot synthesize
    assert.deepEqual(CA.cardAudioRoute(p, node("b")), { route: "page" });
    assert.deepEqual(CA.cardAudioRoute(p, node("s")), { route: null, reason: CA.ONLINE_AUDIO_NO_THREAD });
    assert.equal(CA.onlineCardAudioSynthesizable(p, node("s")), false);
    await assert.rejects(CA.requestCardAudio({ project: p, nodeId: node("s"), start: 0, count: 64, sampleRate: 48000 }), new RegExp(CA.ONLINE_AUDIO_NO_THREAD.slice(0, 12)));

    // Connect host
    const iso = fakeIsolated();
    CA.setIsolatedCardAudioHost(iso);
    assert.deepEqual(CA.cardAudioRoute(p, node("s")), { route: "isolated" });
    assert.deepEqual(CA.cardAudioRoute(p, "n-audio"), { route: "isolated" }, "synced audio media effect card (does not read media)");
    assert.deepEqual(CA.cardAudioRoute(p, node("x")), { route: null, reason: "Sound code cannot use lottie-web" }, "fails to load in the thread: reason is copied verbatim");
    assert.deepEqual(CA.cardAudioRoute(p, "n-mix"), { route: null, reason: CA.ONLINE_AUDIO_MIXED });
    assert.deepEqual(CA.cardAudioRoute(p, "n-media"), { route: null, reason: CA.ONLINE_AUDIO_NEEDS_MEDIA }, "audio media effect cards that need to read media samples are not synthesized online");
    assert.equal(CA.onlineCardAudioBlocker(p, "n-media"), CA.ONLINE_AUDIO_NEEDS_MEDIA);
    assert.equal(CA.onlineCardAudioBlocker(p, node("s")), null);

    const reply = await CA.requestCardAudio({ project: p, nodeId: node("s"), start: 0, count: 64, sampleRate: 48000 });
    assert.equal(reply.frames, 64);
    assert.equal(reply.channels, 1);
    assert.equal(reply.samples[0], 0.125);
    assert.deepEqual(iso.calls, [{ nodeId: "@clip/s/card", start: 0, count: 64, sampleRate: 48000 }], "sample chunk comes from the isolated host");
    assert.equal(pageEvaluations, 0, "no evaluation in the editor page");
    // Built-in cards: stay in page as before, do not go to host
    const builtinReply = await CA.requestCardAudio({ project: p, nodeId: node("b"), start: 0, count: 64, sampleRate: 48000 });
    assert.equal(builtinReply.samples[0], 0.25);
    assert.equal(pageEvaluations, 1);
    assert.equal(iso.calls.length, 1);

    // Synced card stub in editor: throws immediately when called; real sound code is not here
    const standIn = CA.cardAudioGraphCard("s-av");
    assert.equal(R.getCard("s-av"), undefined, "the registry has no definition for it");
    assert.deepEqual(standIn.defaults, { frequency: 660 });
    assert.throws(() => standIn.audio({}, { start: 0, count: 1, sampleRate: 48000 }, {}), new RegExp(CA.SYNCED_AUDIO_NOT_HERE));
    assert.equal(CA.cardAudioGraphCard("s-mute"), undefined, "a silent sync card has no stand-in");
    assert.equal(CA.cardAudioGraphCard("b-av"), builtinAv, "use the definition when the page has one");
    const G = await import(srcUrl("kernel/cardGraph.mjs"));
    await assert.rejects(AS.evaluateCardAudio({ graph: G.projectCardGraph(p, CA.cardAudioGraphCard), project: p, getCard: CA.cardAudioGraphCard, sampleRate: 48000 }, "@clip/s/card", { start: 0, count: 8, sampleRate: 48000 }),
      /sound code|not executed in the editor page/, "even if someone evaluates the stand-in directly, the sync card's code cannot run");

    // Discard bad chunks returned by host (treat sound thread responses as untrusted input)
    for (const bad of ["nan", "shape", "type"]) {
      CA.setIsolatedCardAudioHost(fakeIsolated({ bad }));
      await assert.rejects(CA.requestCardAudio({ project: { ...p }, nodeId: "@clip/s/card", start: 0, count: 64, sampleRate: 48000 }), /Sample chunk returned by the audio thread/, bad);
    }

    // Desktop runtime environment: ignores host; identical to original when sync table is empty
    editorSetup({ online: false });
    R.setSyncedUserCards([]);
    CA.setIsolatedCardAudioHost(fakeIsolated());
    const desk = editorProject();
    assert.equal((await CA.requestCardAudio({ project: desk, nodeId: "@clip/b/card", start: 0, count: 32, sampleRate: 48000 })).samples[0], 0.25);
    assert.equal(pageEvaluations, 1);
  } finally { editorCleanup(); }
});

test("OCE-A-05 light/heavy and generation: measurement gets sample blocks only through the host (silent), light is synthesized, heavy is not; samples for persistent output come from the host", async () => {
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
    // No host connected: cannot run, explain reason in description
    let d = await J.decideClipSound(p, s);
    assert.deepEqual([d.synth, d.reason, d.message], [false, "not-runnable", CA.ONLINE_AUDIO_NO_THREAD]);
    const iso = fakeIsolated();
    CA.setIsolatedCardAudioHost(iso);
    assert.equal(J.clipSoundRunnable(p, s), true);
    assert.equal(J.clipSoundRunnable(p, x), false);
    assert.equal((await J.decideClipSound(p, x)).message, "Sound code cannot use lottie-web", "if loading fails: copy the reason into the message as is");
    // First use: measure (via host), classify as light
    d = await J.decideClipSound(p, s);
    assert.equal(d.synth, true);
    assert.ok(iso.calls.length >= 1, "the measured sample blocks come from the isolated host");
    assert.equal(pageEvaluations, 0, "no audio() was executed in the editor page");
    assert.deepEqual(audioLog, [], "measurement makes no sound: no new audio context, no playable URL");
    const measured = iso.calls.length;
    // Record exists: do not re-measure on subsequent queries
    assert.equal((await J.decideClipSound(p, s)).synth, true);
    assert.equal(iso.calls.length, measured, "reuse the record, no re-measurement");
    // Classify as heavy (write a 200 ms/chunk entry matching real record shape): do not synthesize
    const key = J.soundTargetOf(p, s).soundKey;
    await store.putCost(SC.soundCostStoreKey(key, "test-device"), { soundKey: key, kind: "card", device: "test-device", blockMs: 200, blockMaxMs: 220, blockFrames: 4096, sampleRate: 48000, samples: 16, measuredAt: 1 });
    J.configureOnlineSoundJudge({})();
    const restore2 = J.configureOnlineSoundJudge({ online: () => true, store: () => store, device: () => "test-device" });
    d = await J.decideClipSound(p, s);
    assert.deepEqual([d.synth, d.reason], [false, "heavy"]);
    restore2();

    // Generate persistent artifact: entire range of samples from host; WAV channels and frames match
    const iso2 = fakeIsolated({ value: 0.5, channels: 2 });
    CA.setIsolatedCardAudioHost(iso2);
    const p3 = editorProject();
    const s3 = p3.tracks[0].clips.find((c) => c.id === "s");
    const wav = await CA.renderEmbeddedCardWav(p3, s3, new AbortController().signal);
    assert.equal(wav.frames, 24000);
    assert.equal(wav.channels, 2);
    assert.equal(iso2.calls.reduce((n, c) => n + c.count, 0), 24000, "no segment skipped, none repeated");
    assert.equal(new DataView(wav.wav.buffer).getFloat32(44, true), 0.5);
    assert.equal(pageEvaluations, 0);
    // Cannot synthesize: generation directly reports the reason
    await assert.rejects(CA.renderEmbeddedCardWav(p3, p3.tracks[0].clips.find((c) => c.id === "x"), new AbortController().signal), /Sound code cannot use lottie-web/);
  } finally {
    restore();
    globalThis.AudioContext = realAC;
    globalThis.URL.createObjectURL = realURL;
    editorCleanup();
  }
});

test("OCE-A-06 gatekeeper: the editor page, export page and sound adapter layer do not import the loader or the sound thread; package names match the allowlist; the thread entry allows user card sound", () => {
  const forbidden = /cardRuntime\/(loader|soundThread|soundEngine|soundModules|soundWorker|soundHost|soundSpawn|stageRuntime|hostModules)/;
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  const offenders = [];
  for (const dir of ["src/editor", "src/export", "src/audio", "src/store"]) {
    for (const file of walk(path.join(ROOT, dir))) {
      if (!/\.(ts|tsx|mjs)$/.test(file) || /\.test\./.test(file)) continue;
      if (forbidden.test(fs.readFileSync(file, "utf8"))) offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], "these files are in the editor page's sources and must not import modules that execute card code");
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
  // Sound thread package table: names match allowlist 1:1; three items requiring DOM are placeholders
  const modules = read("src/online/cardRuntime/soundModules.ts");
  const names = [...modules.matchAll(/^  "([^"]+)": (realOrStub|stub)\(/gm)].map((m) => [m[1], m[2]]);
  assert.deepEqual(names.map((n) => n[0]).sort(), [...PR.CARD_PACKAGES].sort());
  assert.deepEqual(names.filter((n) => n[1] === "stub").map((n) => n[0]).sort(), ["@tsparticles/engine", "@tsparticles/slim", "lottie-web", "react-dom"]);
  // Thread entry: isolated environment here, allow user card audio; uses the same loader
  const worker = read("src/online/cardRuntime/soundWorker.ts");
  assert.match(worker, /setOnlineUserCardAudioGate\(\(\) => true\)/);
  assert.match(worker, /createSoundThread\(/);
  assert.match(read("src/online/cardRuntime/soundThread.ts"), /createCardLoader\(/, "same loader as the stage");
  // Do not allow on editor side: `soundPolicy.ts` APIs are only called in thread entry
  // After A3, closed-source parts live under cloud/ (absent from public repo); this check originally
  // governed them, and must continue governing them after being moved
  const pageDirs = [path.join(ROOT, "src"), ...[path.join(ROOT, "cloud", "src"), path.join(ROOT, "cloud", "online")].filter((d) => fs.existsSync(d))];
  const callers = pageDirs.flatMap(walk).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) && /setOnlineUserCardAudioGate\(/.test(fs.readFileSync(f, "utf8")))
    .map((f) => path.relative(ROOT, f).replace(/\\/g, "/")).sort();
  assert.deepEqual(callers, ["src/online/cardRuntime/soundWorker.ts", "src/online/soundPolicy.ts"]);
});

test("OCE-A-07 full chain (without stage RPC): editor page requests a block → isolated host → the sound half of the stage → sync card's audio() runs in the thread → sample block comes back", async () => {
  const SS = await import(srcUrl("online/cardRuntime/stageSound.ts"));
  const IS = await import(srcUrl("editor/io/isolatedSound.ts"));
  const files = lib({ [`${U}s-av.tsx`]: AV("s-av"), [`${U}s-bad.tsx`]: AV("s-bad", { top: "lottie.loadAnimation({});" }) });
  const bundles = [await bundleOf(files, `${U}s-av.tsx`), await bundleOf(files, `${U}s-bad.tsx`)];
  const workers = fakeWorkers();
  const reported = [];
  const sound = SS.createStageSound({ spawn: workers.spawn, ...fakeTimers(), onState: (s) => reported.push(s),
    entryCards: (entry) => SYNCED.filter((c) => c.source === entry).map((c) => c.id) });
  const rpc = [];
  // Mock stage RPC: structured clone once (cross-document transfer is already a clone)
  const link = IS.createIsolatedSoundLink({ render: (request, signal) => { rpc.push({ ...request, project: request.project === undefined ? undefined : "present" }); return sound.render(structuredClone(request), signal); } });
  editorSetup();
  try {
    const state = await sound.setBundles(bundles);
    assert.deepEqual(Object.keys(state.ready), ["s-av"]);
    assert.match(state.blocked["s-bad"], /Sound code cannot use lottie-web/);
    assert.deepEqual(reported.at(-1), state);
    link.setState(state);
    assert.equal(CA.isolatedCardAudioHost(), link.host());
    const p = projectOf([clip("s", "s-av", { params: { frequency: 990 } }), clip("x", "s-bad")]);
    assert.deepEqual(CA.cardAudioRoute(p, "@clip/s/card"), { route: "isolated" });
    assert.match(CA.cardAudioRoute(p, "@clip/x/card").reason, /Sound code cannot use lottie-web/);
    const reply = await CA.requestCardAudio({ project: p, nodeId: "@clip/s/card", start: 0, count: 2048, sampleRate: 48000 });
    assert.deepEqual([...reply.samples], [...expected(990, 0, 2048)], "the editor page gets exactly the samples that card in the thread computed from the clip parameters");
    await CA.requestCardAudio({ project: p, nodeId: "@clip/s/card", start: 2048, count: 512, sampleRate: 48000 });
    assert.deepEqual(rpc.map((r) => r.project), ["present", undefined], "the project is sent only once per version");
    assert.equal(pageEvaluations, 0);

    // Stage side restarted (status re-reported): include previously sent projects again
    link.setState(await sound.setBundles(bundles));
    await CA.requestCardAudio({ project: p, nodeId: "@clip/s/card", start: 4096, count: 64, sampleRate: 48000 });
    assert.equal(rpc.at(-1).project, "present");

    // Generation change: signature changed, chunk caches do not collide (same project and clip, use new code)
    const v1 = link.host().versionOf("s-av");
    files.set(`${U}s-av.tsx`, AV("s-av", { hz: "330" }));
    link.setState(await sound.setBundles([await bundleOf(files, `${U}s-av.tsx`)]));
    assert.notEqual(link.host().versionOf("s-av"), v1);
    const again = await CA.requestCardAudio({ project: p, nodeId: "@clip/s/card", start: 0, count: 2048, sampleRate: 48000 });
    assert.deepEqual([...again.samples], [...expected(330, 0, 2048)]);

    // Treat status reported by stage as untrusted input
    assert.equal(IS.sanitizeSoundState("x"), null);
    assert.deepEqual(IS.sanitizeSoundState({ ready: { a: "1", b: 2, "": "x" }, blocked: { c: "reason".repeat(200) } }), { ready: { a: "1" }, blocked: { c: "reason".repeat(200).slice(0, 240) } });
    // Thread terminated: tear down host; synced cards revert to "cannot synthesize"
    link.setState(null);
    assert.equal(CA.isolatedCardAudioHost(), null);
    assert.deepEqual(CA.cardAudioRoute(p, "@clip/s/card"), { route: null, reason: CA.ONLINE_AUDIO_NO_THREAD });
  } finally {
    link.dispose();
    sound.dispose();
    editorCleanup();
  }
});
