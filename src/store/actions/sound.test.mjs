import "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
const { actions, getState } = await import("../project.ts");
const { createNotificationRecipe, createTypingSoundRecipe } = await import("../../kernel/soundEffects.ts");
const { soundEffectReuseDigest } = await import("../../audio/soundGeneration.ts");
const { findClip } = await import("../../kernel/project.ts");
const { serializeProc, parseProc } = await import("../../editor/io/proc.ts");
const { DocSync } = await import("../docsync.ts");
import { MemDocService } from "../../testing/memDocService.mjs";

const recipe = createNotificationRecipe();
const reuseKey = await soundEffectReuseDigest(recipe);
function fresh() { actions.newProject("sound"); return getState().project; }
function spec(extra = {}) { const p = getState().project; return { projectId: p.id, cutId: p.activeCutId,
  asset: { kind: "audio", name: "sound.wav", hash: "a".repeat(64), url: `/@media/${"a".repeat(64)}`, ext: "wav", duration: recipe.frames / recipe.sampleRate, soundEffect: { recipe, reuseKey } },
  link: { recipe, reuseKey, requestId: "request-one" }, start: 1, ...extra }; }

test("commit is immutable and atomic, persisted clip retries never duplicate", () => {
  const before = fresh();
  const result = actions.commitSoundEffect(spec());
  const after = getState().project;
  assert.notEqual(after, before); assert.equal(before.media.length, 0); assert.equal(before.tracks.flatMap(t => t.clips).length, 0);
  assert.equal(after.media.length, 1); assert.equal(after.tracks.flatMap(t => t.clips).length, 1);
  assert.deepEqual(actions.commitSoundEffect(spec()), { ...result, reused: true });
  const clip = findClip(after, result.clipId).clip;
  assert.equal(clip.nodeId, undefined); assert.equal(clip.cardId, ""); assert.equal(clip.mediaOffset, 0);
  actions.undo(); assert.equal(getState().project.media.length, 0);
});

test(".proc serialization/reopen and docsync preserve recipes with no local paths", () => {
  fresh(); const result = actions.commitSoundEffect(spec());
  const saved = serializeProc();
  assert.doesNotMatch(saved, /blob:|[A-Z]:\\\\/);
  const parsed = parseProc(saved); const old = getState().project;
  actions.loadProject(parsed);
  assert.deepEqual(getState().project.media[0].soundEffect, old.media[0].soundEffect);
  assert.deepEqual(findClip(getState().project, result.clipId).clip.soundEffect, findClip(old, result.clipId).clip.soundEffect);
  assert.equal(actions.commitSoundEffect(spec()).clipId, result.clipId);
  const initial = fresh();
  const svc = new MemDocService({ project: structuredClone(initial), rev: 0 });
  let conn;
  const ds = new DocSync(initial, { projectId: "P", session: "A", send: m => conn.send(m) });
  conn = svc.connect("A", msg => ds.receive(msg)); ds.connect(); svc.drain();
  actions.commitSoundEffect(spec()); ds.commit(getState().project); svc.drain();
  assert.deepEqual(svc.project.media[0].soundEffect, getState().project.media[0].soundEffect);
  assert.deepEqual(svc.project.tracks[0].clips[0].soundEffect, getState().project.tracks[0].clips[0].soundEffect);
});

test("regeneration replaces one reference only, retaining range/offset/gain and old asset", () => {
  fresh(); const result = actions.commitSoundEffect(spec());
  actions.setClipVolume(result.clipId, .4);
  const before = getState().project, oldClip = findClip(before, result.clipId).clip;
  const nextRecipe = createNotificationRecipe({ frequency: 440 });
  const regen = spec({ replaceClipId: result.clipId, expectedClip: JSON.stringify(oldClip), link: { recipe: nextRecipe, reuseKey: "new", requestId: "regen" } });
  regen.asset = { ...regen.asset, hash: "b".repeat(64), soundEffect: { recipe: nextRecipe, reuseKey: "new" } };
  const after = actions.commitSoundEffect(regen);
  assert.equal(after.clipId, result.clipId); assert.notEqual(after.mediaId, result.mediaId);
  assert.equal(getState().project.media.length, 2);
  const clip = findClip(getState().project, result.clipId).clip;
  assert.equal(clip.audioVolume, .4); assert.equal(clip.start, oldClip.start); assert.equal(clip.end, oldClip.end);
  assert.equal(before.media.length, 1); assert.equal(oldClip.mediaId, result.mediaId);
  assert.throws(() => actions.commitSoundEffect(regen), /已改变/);
});

test("overlap, locked and stale project validation does not add an asset", () => {
  const p = fresh(); const result = actions.commitSoundEffect(spec({ duration: 1 }));
  const count = getState().project.media.length;
  assert.throws(() => actions.commitSoundEffect(spec({ start: 1.2, trackId: p.tracks[0].id, link: { recipe, reuseKey, requestId: "other" } })), /重叠/);
  assert.equal(getState().project.media.length, count);
  actions.updateTrack(p.tracks[0].id, { locked: true });
  assert.throws(() => actions.commitSoundEffect(spec({ replaceClipId: result.clipId, expectedClip: JSON.stringify(findClip(getState().project, result.clipId).clip) })), /解锁/);
  assert.throws(() => actions.commitSoundEffect(spec({ projectId: "old" })), /切换/);
});

test("split and trim retain canonical source offsets; linked sounds move and split in sync", async () => {
  const p = fresh();
  const source = { id: "typing", cardId: "mu-typing", start: 2, end: 5, params: { text: "测试", duration: 120 }, mediaOffset: 0 };
  actions.loadProject({ ...p, tracks: [{ ...p.tracks[0], clips: [source] }, p.tracks[1]] });
  const soundRecipe = createTypingSoundRecipe({ text: "测试", duration: 120 }, {}, { frames: 144000 });
  const soundKey = await soundEffectReuseDigest(soundRecipe);
  const s = spec({ start: 2, duration: 3, link: { recipe: soundRecipe, reuseKey: soundKey, requestId: "typed", sourceClipId: "typing" }, expectedSource: JSON.stringify(source) });
  s.asset = { ...s.asset, duration: 3, soundEffect: { recipe: soundRecipe, reuseKey: soundKey } };
  const result = actions.commitSoundEffect(s);
  actions.moveClip("typing", { start: 4, end: 7 });
  let sound = findClip(getState().project, result.clipId).clip;
  assert.equal(sound.start, 4); assert.equal(sound.end, 7); assert.equal(sound.mediaOffset, 0);
  actions.moveClip("typing", { start: 4.5 });
  sound = findClip(getState().project, result.clipId).clip;
  assert.equal(sound.start, 4.5); assert.equal(sound.mediaOffset, .5);
  assert.equal(findClip(getState().project, "typing").clip.mediaOffset, .5);
  const right = actions.splitClip("typing", 5.5);
  assert.equal(right.mediaOffset, 1.5);
  const companion = getState().project.tracks.flatMap(t => t.clips).find(c => c.soundEffect?.sourceClipId === right.id);
  assert.equal(companion.start, 5.5); assert.equal(companion.mediaOffset, 1.5);
  assert.equal(companion.end, right.end);
});

test("regeneration extends uncropped sound tails and preserves explicit right trim", async () => {
  fresh(); const result = actions.commitSoundEffect(spec());
  const original = findClip(getState().project, result.clipId).clip;
  const longer = createNotificationRecipe({ duration: 1.2 });
  const longerKey = await soundEffectReuseDigest(longer);
  const regen = () => spec({ replaceClipId: result.clipId, expectedClip: JSON.stringify(findClip(getState().project, result.clipId).clip),
    asset: { ...spec().asset, duration: 1.2, hash: "b".repeat(64), soundEffect: { recipe: longer, reuseKey: longerKey } },
    link: { recipe: longer, reuseKey: longerKey, requestId: "longer" } });
  actions.commitSoundEffect(regen());
  assert.equal(findClip(getState().project, result.clipId).clip.end, original.start + 1.2);
  actions.moveClip(result.clipId, { end: 1.7 });
  actions.commitSoundEffect(regen());
  assert.equal(findClip(getState().project, result.clipId).clip.end, 1.7);
});

test("transition-locked source group movement also moves linked WAV and rejects locked companions", () => {
  const p = fresh();
  const source = { id: "typing", cardId: "mu-typing", start: 1, end: 5, params: { text: "测试", duration: 120 } };
  actions.loadProject({ ...p, tracks: [{ ...p.tracks[0], clips: [source] }, p.tracks[1]], transitions: [{ id: "fade", kind: "fadeIn", aId: "typing", dur: .1 }] });
  const result = actions.commitSoundEffect(spec({ link: { recipe, reuseKey, requestId: "fade-sound", sourceClipId: "typing" }, expectedSource: JSON.stringify(source) }));
  actions.moveClip("typing", { start: 2 });
  assert.equal(findClip(getState().project, "typing").clip.start, 2);
  assert.equal(findClip(getState().project, result.clipId).clip.start, 2);
  actions.updateTrack(findClip(getState().project, result.clipId).track.id, { locked: true });
  actions.moveClip("typing", { start: 3 });
  assert.equal(findClip(getState().project, "typing").clip.start, 2);
});

test("end chime on same sequence moves with source, with and without fade transition", () => {
  for (const fade of [false, true]) {
    const p = fresh();
    const source = { id: "typing", cardId: "mu-typing", start: 0, end: 1.2, params: { text: "text", duration: 300 } };
    actions.loadProject({ ...p, tracks: [{ ...p.tracks[0], clips: [source] }, p.tracks[1]], ...(fade ? { transitions: [{ id: "fade", kind: "fadeIn", aId: "typing", dur: .1 }] } : {}) });
    const chime = actions.commitSoundEffect(spec({ start: 1.2, link: { recipe, reuseKey, requestId: "end-chime", sourceClipId: source.id }, expectedSource: JSON.stringify(source) }));
    assert.equal(findClip(getState().project, chime.clipId).track.id, findClip(getState().project, source.id).track.id);
    actions.moveClip(source.id, { start: .4, end: 1.6 });
    assert.equal(findClip(getState().project, source.id).clip.start, .4);
    assert.equal(findClip(getState().project, chime.clipId).clip.start, 1.6);
  }
});

test("left extension before source offset zero keeps original typing events aligned", () => {
  const p = fresh();
  const source = { id: "typing", cardId: "mu-typing", start: 1, end: 5, mediaOffset: 0, params: { text: "abc", duration: 120 } };
  actions.loadProject({ ...p, tracks: [{ ...p.tracks[0], clips: [source] }, p.tracks[1]] });
  const audio = actions.commitSoundEffect(spec({ start: 1, duration: 1, link: { recipe, reuseKey, requestId: "sound", sourceClipId: source.id }, expectedSource: JSON.stringify(source) }));
  actions.moveClip(source.id, { start: .5 });
  assert.equal(findClip(getState().project, source.id).clip.mediaOffset, 0);
  assert.equal(findClip(getState().project, audio.clipId).clip.start, .5);
  assert.equal(findClip(getState().project, audio.clipId).clip.mediaOffset, 0);
});

test("near-budget shared sound insertion stays entity-sized and preserves a concurrent project rename", async () => {
  const initial = fresh();
  const r = createTypingSoundRecipe({ text: "a".repeat(600), duration: 10 });
  const key = await soundEffectReuseDigest(r);
  const svc = new MemDocService({ project: structuredClone(initial), rev: 0 });
  const page = session => {
    let connection;
    const ds = new DocSync(structuredClone(initial), { projectId: "P", session, send: m => connection.send(m) });
    connection = svc.connect(session, m => ds.receive(m)); ds.connect();
    return { ds, connection };
  };
  const a = page("sound"), b = page("rename"); svc.drain();
  const saved = spec({ link: { recipe: r, reuseKey: key, requestId: "large-safe" } });
  saved.asset = { ...saved.asset, duration: r.frames / r.sampleRate, soundEffect: { recipe: r, reuseKey: key } };
  actions.commitSoundEffect(saved);
  a.ds.commit(getState().project);
  b.ds.commit({ ...b.ds.project, name: "concurrent rename" });
  svc.handle(b.connection.conn, b.connection.conn.up.shift()); // Land rename before A sees it.
  const message = a.connection.conn.up[0];
  assert.equal(message.type, "project.op");
  assert.ok(message.ops.every(op => op.path !== ""));
  assert.ok(Buffer.byteLength(JSON.stringify(message.ops)) < 224 * 1024);
  svc.handle(a.connection.conn, a.connection.conn.up.shift()); svc.drain();
  assert.equal(svc.project.name, "concurrent rename");
  assert.equal(svc.project.media.length, 1);
  assert.equal(a.ds.project.name, "concurrent rename");
});
