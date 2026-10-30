// 音频效果库工具(list/create/update/remove/apply_audio_fx)和 store 的连带清理。
// 跑法:node --test src/editor/right/audioFxTools.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { tools } from "../../../server/mcp-tools.mjs";

test("音频效果库:建、挂、改、删,门槛、撤销、跨剪辑清理、音画分离跟着走", async () => {
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
      { id: "t1", name: "画面", clips: [{ id: "c1", cardId: "", params: {}, mediaId: "v", start: 0, end: 5 }, { id: "c2", cardId: "", params: {}, mediaId: "v", start: 5, end: 10 }] },
      { id: "t2", name: "卡片", clips: [{ id: "k1", cardId: "caption-track", params: {}, start: 0, end: 5 }] },
      { id: "t3", name: "声音", muted: true, clips: [{ id: "s1", cardId: "", params: {}, mediaId: "a", start: 0, end: 5 }] },
      { id: "t4", name: "图", clips: [{ id: "i1", cardId: "", params: {}, mediaId: "i", start: 0, end: 5 }] },
      { id: "t5", name: "锁住的", locked: true, clips: [{ id: "c3", cardId: "", params: {}, mediaId: "v", start: 0, end: 5 }] },
    ];
    actions.loadProject(p);

    const kinds = at.listAudioFx();
    assert.ok(kinds.kinds.gain && kinds.presets.length > 0 && kinds.expressions);

    // 建 + 顺手挂;片段不合规时什么都不建
    assert.throws(() => at.createAudioFx({ name: "x", ops: [{ kind: "gain", db: -6 }], clipId: "k1" }), /卡片/);
    assert.throws(() => at.createAudioFx({ name: "x", ops: [{ kind: "gain", db: -6 }], clipId: "i1" }), /图片/);
    assert.throws(() => at.createAudioFx({ name: "x", ops: [{ kind: "gain", db: -6 }], clipId: "c3" }), /锁定/);
    assert.equal(getState().project.audioFx, undefined, "校验没过不能留下半个效果");
    const made = at.createAudioFx({
      name: "压低", params: { amount: { default: -12, min: -40, max: 0 } },
      ops: [{ kind: "gain", db: "amount" }], clipId: "c1", clipParams: { amount: 5 },
    });
    const fid = made.fxId;
    assert.match(fid, /^afx-/);
    assert.equal(made.effect.animated, false);
    assert.deepEqual(getState().project.tracks[0].clips[0].audioFx, { id: fid, params: { amount: 0 } }); // 夹到 max
    assert.equal(timelineDigest(getState().project).tracks[0].clips[0].audioFxId, fid);
    // 建 + 挂是一步撤销
    actions.undo();
    assert.equal(getState().project.audioFx?.length ?? 0, 0);
    assert.equal(getState().project.tracks[0].clips[0].audioFx, undefined);
    actions.redo();
    assert.equal(getState().project.tracks[0].clips[0].audioFx.id, fid);

    // 挂到声音段(序列静音要提醒)、换参数、摘掉
    assert.match(at.applyAudioFx({ clipId: "s1", fxId: fid }).warning, /静音/);
    assert.equal(at.applyAudioFx({ clipId: "c2", fxId: fid }).fxId, fid);
    assert.throws(() => at.applyAudioFx({ clipId: "c2", fxId: fid, params: { nope: 1 } }), /没有参数 nope/);
    assert.throws(() => at.applyAudioFx({ clipId: "c2", fxId: "afx-none" }), /音频效果库里没有 afx-none.*压低/);
    assert.equal(at.listAudioFx().effects[0].usedBy.length, 3);
    assert.equal(at.applyAudioFx({ clipId: "c2", fxId: "" }).removed, true);
    assert.equal("audioFx" in getState().project.tracks[0].clips[1], false, "摘掉要把字段整个拿掉");
    actions.undo();
    assert.equal(getState().project.tracks[0].clips[1].audioFx.id, fid);

    // 音画分离:分出来的声音段带着效果,原视频段不再带
    const sep = actions.separateAudio("c1");
    assert.equal(sep.ok, true);
    const q1 = getState().project;
    const sepClip = q1.tracks.flatMap((t) => t.clips).find((c) => c.id === sep.audioClipId);
    assert.equal(sepClip.audioFx.id, fid);

    // 改:挂着的都跟着变;删掉了声明的参数要提醒
    const upd = at.updateAudioFx({ fxId: fid, params: {}, ops: [{ kind: "lowpass", freq: "lerp(400, 8000, p)" }] });
    assert.match(upd.note, /段都跟着变/);
    assert.match(upd.warning, /c1/);
    assert.throws(() => at.updateAudioFx({ fxId: fid, ops: [{ kind: "gain", db: 99 }] }), /-60~24/);

    // 删:挂着要 force + reason;停放剪辑里挂着的也要摘
    const other = actions.addCut("剪辑备份", { switchTo: false });
    const q = getState().project;
    actions.loadProject({
      ...q,
      cuts: q.cuts.map((c) => (c.id === other.id ? { ...c, tracks: [{ id: "tp", name: "p", clips: [{ id: "cp", cardId: "", params: {}, mediaId: "v", start: 0, end: 3, audioFx: { id: fid } }] }] } : c)),
    });
    assert.throws(() => at.removeAudioFx({ fxId: fid }), /还挂在 \d 段上.*剪辑备份 的 cp/);
    assert.throws(() => at.removeAudioFx({ fxId: fid, force: true }), /reason/);
    const rm = at.removeAudioFx({ fxId: fid, force: true, reason: "用户不要了" });
    assert.ok(rm.detached.length >= 4);
    const after = getState().project;
    assert.deepEqual(after.audioFx, []);
    for (const t of after.tracks) for (const c of t.clips) assert.equal(c.audioFx, undefined);
    for (const cut of after.cuts) for (const t of cut.tracks ?? []) for (const c of t.clips) assert.equal(c.audioFx, undefined, "停放剪辑里也要摘干净");
  } finally {
    await server.close();
  }
});

test("音频效果工具的声明:必填项", () => {
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const n of ["list_audio_fx", "create_audio_fx", "update_audio_fx", "remove_audio_fx", "apply_audio_fx", "measure_audio"]) assert.equal(byName[n]?.side, "agent", n);
  assert.deepEqual(byName.create_audio_fx.inputSchema.required, ["name", "ops"]);
  assert.deepEqual(byName.apply_audio_fx.inputSchema.required, ["clipId", "fxId"]);
  assert.equal(byName.create_audio_fx.inputSchema.properties.ops.items.properties.kind.enum.length, 11);
});
