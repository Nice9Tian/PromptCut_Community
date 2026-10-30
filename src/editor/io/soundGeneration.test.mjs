import "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
const { actions, getState } = await import("../../store/project.ts");
const { findClip } = await import("../../kernel/project.ts");
const { startSoundGeneration, waitSoundGeneration, cancelSoundGeneration } = await import("./soundGeneration.ts");

/** Real browser upload client and store, with the asset-service wire contract as the only fake. */
function service({ holdComplete } = {}) {
  const real = globalThis.fetch, stored = new Set(), calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const match = /^\/api\/asset\/media\/([a-f0-9]{64})\/(chunks|complete|\d+)$/.exec(String(url));
    assert.ok(match, `unexpected fetch ${url}`); calls.push({ url: String(url), method: init.method });
    const [, hash, action] = match;
    if (action === "chunks") return Response.json({ complete: stored.has(hash), received: [] });
    if (action === "complete") { if (holdComplete) await holdComplete(); stored.add(hash); return Response.json({ ok: true }); }
    assert.equal(init.headers["X-Media-Ext"], "wav"); assert.ok(init.body.byteLength > 44);
    return Response.json({ ok: true });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}
const fresh = () => { actions.newProject("音效集成"); return getState().project; };
const finished = async options => waitSoundGeneration(startSoundGeneration(options).id);
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 1)); } throw new Error("timeout"); }

test("Agent/editor generation uses normal hash-based service upload and no audio node; undo then identical add works", async () => {
  const f = service();
  try {
    fresh();
    const first = await finished({ preset: "notification", start: 1 });
    assert.equal(first.state, "succeeded");
    const clip = findClip(getState().project, first.result.clipId).clip;
    const media = getState().project.media.find(m => m.id === clip.mediaId);
    assert.match(media.hash, /^[a-f0-9]{64}$/); assert.equal(media.path, undefined); assert.equal(media.url, `/@media/${media.hash}`);
    assert.equal(clip.nodeId, undefined); assert.equal(clip.cardId, "");
    const uploadCalls = f.calls.length;
    actions.undo();
    const again = await finished({ preset: "notification", start: 1 });
    assert.equal(again.state, "succeeded"); assert.ok(findClip(getState().project, again.result.clipId));
    assert.ok(f.calls.length > uploadCalls);
  } finally { f.restore(); }
});

test("regenerating notification duration/notes rebuilds frames, and A-B-A-B does not reuse wrong result", async () => {
  const f = service();
  try {
    fresh();
    const first = await finished({ preset: "notification", start: 1, requestId: "first" });
    const clipId = first.result.clipId;
    const a = { clipId, params: { frequency: 440, duration: .4, notes: [0], interval: .12 }, requestId: "a" };
    const b = { clipId, params: { frequency: 880, duration: .9, notes: [0, 7], interval: .3 }, requestId: "b" };
    await finished(a);
    const resultB = await finished(b);
    assert.equal(findClip(getState().project, clipId).clip.end, 2.2);
    assert.equal(findClip(getState().project, clipId).clip.soundEffect.recipe.events[1].frame, 14400);
    await finished(a);
    await finished(b);
    assert.equal(findClip(getState().project, clipId).clip.mediaId, resultB.result.mediaId);
    assert.equal(findClip(getState().project, clipId).clip.end, 2.2);
  } finally { f.restore(); }
});

test("same project reopened during upload is stale; cancel ignores late completion", async () => {
  let release;
  const f = service({ holdComplete: () => new Promise(resolve => { release = resolve; }) });
  try {
    const p = fresh();
    const job = startSoundGeneration({ preset: "notification", start: 1, requestId: "reopen" });
    await until(() => release);
    actions.loadProject(structuredClone(p)); release();
    assert.equal((await waitSoundGeneration(job.id)).state, "stale");
    assert.equal(getState().project.media.length, 0);
    release = undefined;
    const next = startSoundGeneration({ preset: "notification", params: { frequency: 700 }, start: 1, requestId: "cancel" });
    await until(() => release); cancelSoundGeneration(next.id); release();
    assert.equal((await waitSoundGeneration(next.id)).state, "cancelled");
    await new Promise(r => setTimeout(r, 5)); assert.equal(getState().project.media.length, 0);
  } finally { f.restore(); }
});

test("refreshSource rebuilds changed typing speed and grows uncropped audio within source/out point", async () => {
  const f = service();
  try {
    const p = fresh();
    const source = { id: "type", cardId: "mu-typing", start: 1, end: 5, params: { text: "中，文", duration: 120 } };
    actions.loadProject({ ...p, tracks: [{ ...p.tracks[0], clips: [source] }, p.tracks[1]] });
    const first = await finished({ preset: "keyboard", sourceClipId: "type", requestId: "typing" });
    assert.equal(first.state, "succeeded");
    const oldEnd = findClip(getState().project, first.result.clipId).clip.end;
    actions.setClipParams("type", { duration: 300 });
    const next = await finished({ clipId: first.result.clipId, refreshSource: true, requestId: "typing-speed" });
    assert.equal(next.state, "succeeded");
    const clip = findClip(getState().project, first.result.clipId).clip;
    assert.ok(clip.end > oldEnd); assert.equal(clip.end, 1.975);
    assert.equal(clip.soundEffect.recipe.typingSource.source.duration, 300);
  } finally { f.restore(); }
});

test("orphan sound regenerates saved events after visual source removal; refreshSource fails explicitly", async () => {
  const f = service();
  try {
    const p = fresh(); const source = { id: "type", cardId: "mu-typing", start: 1, end: 5, params: { text: "hello", duration: 120 } };
    actions.loadProject({ ...p, tracks: [{ ...p.tracks[0], clips: [source] }, p.tracks[1]] });
    const first = await finished({ preset: "keyboard", sourceClipId: "type", requestId: "source" });
    actions.removeClip("type");
    const job = await finished({ clipId: first.result.clipId, params: { gain: .2 }, requestId: "orphan" });
    assert.equal(job.state, "succeeded");
    const clip = findClip(getState().project, first.result.clipId).clip;
    assert.equal(clip.soundEffect.recipe.typingSource.source.text, "hello"); assert.equal(clip.soundEffect.sourceClipId, undefined);
    assert.throws(() => startSoundGeneration({ clipId: clip.id, refreshSource: true }), /sourceClipId/);
  } finally { f.restore(); }
});

test("sound-only edits preserve custom sample ranges and events; natural timing changes still rebuild", async () => {
  const f = service();
  try {
    const { createNotificationRecipe, createTypingSoundRecipe } = await import("../../kernel/soundEffects.ts");
    for (const cropped of [createNotificationRecipe({}, { frames: 4800 }), createTypingSoundRecipe({ text: "abc", duration: 120 }, {}, { frames: 4800 })]) {
      fresh();
      const first = await finished({ recipe: cropped, start: 1, requestId: "custom" });
      const gain = await finished({ clipId: first.result.clipId, params: { gain: .2 }, requestId: "gain" });
      assert.equal(gain.state, "succeeded");
      let current = findClip(getState().project, first.result.clipId).clip;
      assert.equal(current.end, 1.1); assert.equal(current.soundEffect.recipe.frames, 4800);
      assert.deepEqual(current.soundEffect.recipe.events, cropped.events);
      await finished({ clipId: current.id, params: { duration: .2 }, requestId: "duration" });
      current = findClip(getState().project, current.id).clip;
      assert.equal(current.soundEffect.recipe.frames, 4800, "intentional source crop survives duration edit");
    }
    fresh();
    const custom = createNotificationRecipe({}, { frames: 24000 });
    custom.events = [{ ...custom.events[0], id: 17, frame: 3200, velocity: .5 }];
    const first = await finished({ recipe: custom, start: 1, requestId: "custom-events" });
    await finished({ clipId: first.result.clipId, params: { frequency: 660, waveform: "sine" }, requestId: "tone" });
    const current = findClip(getState().project, first.result.clipId).clip;
    assert.deepEqual(current.soundEffect.recipe.events, custom.events);
    assert.equal(current.soundEffect.recipe.frames, 24000);
  } finally { f.restore(); }
});
