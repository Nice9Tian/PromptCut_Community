// Audio effects library tools (list/create/update/remove/apply_audio_fx) and cascading cleanup
// for store.
// Run: node --test src/editor/right/audioFxTools.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { tools } from "../../../server/mcp-tools.mjs";

test("Audio effects library: create, attach, edit, delete; gate, undo, cross-cut cleanup, and audio-visual separation follows along", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { actions, getState } = await server.ssrLoadModule("/src/store/project.ts");
    const { createEmptyProject } = await server.ssrLoadModule("/src/kernel/project.ts");
    const { createAudioFxTools } = await server.ssrLoadModule("/src/editor/right/audioFxTools.ts");
    const { timelineDigest } = await server.ssrLoadModule("/src/mcp/tools/toolEcho.ts");
    const at = createAudioFxTools({ getState, actions });
    const p = createEmptyProject();
    p.media = [
      { id: "v", kind: "video", name: "v.mp4", url: "/media/v.mp4", duration: 20 },
      { id: "a", kind: "audio", name: "a.mp3", url: "/media/a.mp3", duration: 20 },
      { id: "i", kind: "image", name: "i.jpg", url: "/media/i.jpg" },
    ];
    p.tracks = [
      { id: "t1", name: "Video", clips: [{ id: "c1", cardId: "", params: {}, mediaId: "v", start: 0, end: 5 }, { id: "c2", cardId: "", params: {}, mediaId: "v", start: 5, end: 10 }] },
      { id: "t2", name: "Cards", clips: [{ id: "k1", cardId: "caption-track", params: {}, start: 0, end: 5 }] },
      { id: "t3", name: "Audio", muted: true, clips: [{ id: "s1", cardId: "", params: {}, mediaId: "a", start: 0, end: 5 }] },
      { id: "t4", name: "Image", clips: [{ id: "i1", cardId: "", params: {}, mediaId: "i", start: 0, end: 5 }] },
      { id: "t5", name: "Locked", locked: true, clips: [{ id: "c3", cardId: "", params: {}, mediaId: "v", start: 0, end: 5 }] },
    ];
    actions.loadProject(p);

    const kinds = at.listAudioFx();
    assert.ok(kinds.kinds.gain && kinds.presets.length > 0 && kinds.expressions);

    // Create + attach together; create nothing if clip is invalid
    assert.throws(() => at.createAudioFx({ name: "x", ops: [{ kind: "gain", db: -6 }], clipId: "k1" }), /card clips have no sound/);
    assert.throws(() => at.createAudioFx({ name: "x", ops: [{ kind: "gain", db: -6 }], clipId: "i1" }), /image with no sound/);
    assert.throws(() => at.createAudioFx({ name: "x", ops: [{ kind: "gain", db: -6 }], clipId: "c3" }), /is locked/);
    assert.equal(getState().project.audioFx, undefined, "A failed validation must not leave half an effect behind");
    const made = at.createAudioFx({
      name: "Lower", params: { amount: { default: -12, min: -40, max: 0 } },
      ops: [{ kind: "gain", db: "amount" }], clipId: "c1", clipParams: { amount: 5 },
    });
    const fid = made.fxId;
    assert.match(fid, /^afx-/);
    assert.equal(made.effect.animated, false);
    assert.deepEqual(getState().project.tracks[0].clips[0].audioFx, { id: fid, params: { amount: 0 } }); // Clamp to max
    assert.equal(timelineDigest(getState().project).tracks[0].clips[0].audioFxId, fid);
    // Create + attach is a single undo step
    actions.undo();
    assert.equal(getState().project.audioFx?.length ?? 0, 0);
    assert.equal(getState().project.tracks[0].clips[0].audioFx, undefined);
    actions.redo();
    assert.equal(getState().project.tracks[0].clips[0].audioFx.id, fid);

    // Attach to audio clip (warn on track mute), change parameters, detach
    assert.match(at.applyAudioFx({ clipId: "s1", fxId: fid }).warning, /is currently muted/);
    assert.equal(at.applyAudioFx({ clipId: "c2", fxId: fid }).fxId, fid);
    assert.throws(() => at.applyAudioFx({ clipId: "c2", fxId: fid, params: { nope: 1 } }), /no parameter nope/);
    assert.throws(() => at.applyAudioFx({ clipId: "c2", fxId: "afx-none" }), /The audio effects library has no afx-none.*Lower/);
    assert.equal(at.listAudioFx().effects[0].usedBy.length, 3);
    assert.equal(at.applyAudioFx({ clipId: "c2", fxId: "" }).removed, true);
    assert.equal("audioFx" in getState().project.tracks[0].clips[1], false, "Detaching must remove the field entirely");
    actions.undo();
    assert.equal(getState().project.tracks[0].clips[1].audioFx.id, fid);

    // Separate audio: split audio clip keeps effects, original video clip no longer has them
    const sep = actions.separateAudio("c1");
    assert.equal(sep.ok, true);
    const q1 = getState().project;
    const sepClip = q1.tracks.flatMap((t) => t.clips).find((c) => c.id === sep.audioClipId);
    assert.equal(sepClip.audioFx.id, fid);

    // Update: attached ones update accordingly; warn if declared parameters are removed
    const upd = at.updateAudioFx({ fxId: fid, params: {}, ops: [{ kind: "lowpass", freq: "lerp(400, 8000, p)" }] });
    assert.match(upd.note, /have all changed with it/);
    assert.match(upd.warning, /c1/);
    assert.throws(() => at.updateAudioFx({ fxId: fid, ops: [{ kind: "gain", db: 99 }] }), /-60~24/);

    // Delete: requires force + reason if attached; attached ones in parked cuts must also be detached
    const other = actions.addCut("Cut backup", { switchTo: false });
    const q = getState().project;
    actions.loadProject({
      ...q,
      cuts: q.cuts.map((c) => (c.id === other.id ? { ...c, tracks: [{ id: "tp", name: "p", clips: [{ id: "cp", cardId: "", params: {}, mediaId: "v", start: 0, end: 3, audioFx: { id: fid } }] }] } : c)),
    });
    assert.throws(() => at.removeAudioFx({ fxId: fid }), /is still attached to \d clips.*cp of Cut backup/);
    assert.throws(() => at.removeAudioFx({ fxId: fid, force: true }), /reason/);
    const rm = at.removeAudioFx({ fxId: fid, force: true, reason: "The user no longer wants it" });
    assert.ok(rm.detached.length >= 4);
    const after = getState().project;
    assert.deepEqual(after.audioFx, []);
    for (const t of after.tracks) for (const c of t.clips) assert.equal(c.audioFx, undefined);
    for (const cut of after.cuts) for (const t of cut.tracks ?? []) for (const c of t.clips) assert.equal(c.audioFx, undefined, "Must be fully detached in parked cuts too");
  } finally {
    await server.close();
  }
});

test("Audio effect tool declaration: required fields", () => {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of ["list_audio_fx", "create_audio_fx", "update_audio_fx", "remove_audio_fx", "apply_audio_fx", "measure_audio"]) assert.equal(byName[n]?.side, "agent", n);
  assert.deepEqual(byName.create_audio_fx.inputSchema.required, ["name", "ops"]);
  assert.deepEqual(byName.apply_audio_fx.inputSchema.required, ["clipId", "fxId"]);
  assert.equal(byName.create_audio_fx.inputSchema.properties.ops.items.properties.kind.enum.length, 11);
});
