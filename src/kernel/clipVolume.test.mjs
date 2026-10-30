import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { buildAudioPlan } from "../../server/bakery/mux-audio.mjs";
import { tools } from "../../server/mcp-tools.mjs";

test("clip volume: independent gain, validation, undo, split, separation and export", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { actions, getState } = await server.ssrLoadModule("/src/store/project.ts");
    const { createEmptyProject, audioClipsAt, videoLayersAt } = await server.ssrLoadModule("/src/kernel/project.ts");
    const p = createEmptyProject();
    p.media = [{ id: "v", kind: "video", name: "clip.mp4", url: "/media/clip.mp4", duration: 20 }];
    p.tracks = [{ id: "t", name: "video", clips: [{ id: "c", cardId: "", params: {}, mediaId: "v", start: 0, end: 10, opacity: 0.8, fadeIn: 2 }] }];
    actions.loadProject(p);
    assert.equal(buildAudioPlan(getState().project, ".", () => true)[0].volume, 0.8);
    assert.equal(actions.setClipVolume("c", 0.25).ok, true);
    assert.equal(getState().project.tracks[0].clips[0].opacity, 0.8);
    assert.equal(videoLayersAt(getState().project, 1)[0].opacity, 0.4);
    assert.equal(buildAudioPlan(getState().project, ".", () => true)[0].volume, 0.2);
    for (const value of [-1, 1.1, NaN, Infinity, "0.5", null]) assert.equal(actions.setClipVolume("c", value).ok, false);
    assert.equal(actions.setClipVolume("missing", 1).ok, false);
    actions.undo();
    assert.equal(getState().project.tracks[0].clips[0].audioVolume, undefined);
    actions.redo();
    const split = actions.splitClip("c", 5);
    assert.equal(split.audioVolume, 0.25);
    actions.undo();
    const separated = actions.separateAudio("c");
    assert.equal(separated.ok, true);
    assert.equal(getState().project.tracks[1].clips[0].audioVolume, 0.25);
    assert.equal(audioClipsAt(getState().project, 1)[0].volume, 0.1);
    assert.equal(actions.setClipVolume(separated.audioClipId, 0).ok, true);
    assert.equal(audioClipsAt(getState().project, 3)[0].volume, 0);
    assert.equal(buildAudioPlan(getState().project, ".", () => true)[0].volume, 0);
    actions.updateTrack(separated.trackId, { muted: true });
    assert.equal(actions.setClipVolume(separated.audioClipId, 1).muted, true);
    assert.equal(audioClipsAt(getState().project, 3).length, 0);
    actions.updateTrack(separated.trackId, { locked: true });
    assert.equal(actions.setClipVolume(separated.audioClipId, 0.5).ok, false);
    p.media[0].kind = "image";
    actions.loadProject(p);
    assert.equal(actions.setClipVolume("c", 0.5).ok, false);
    const spec = tools.find((tool) => tool.name === "set_clip_volume");
    assert.deepEqual(spec.inputSchema.required, ["clipId", "volume"]);
  } finally {
    await server.close();
  }
});
