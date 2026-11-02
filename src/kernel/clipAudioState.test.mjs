import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildAudioPlan } from "../../server/bakery/mux-audio.mjs";
import { tools } from "../../server/mcp-tools.mjs";

async function fixture(run) {
  const server = await createServer({ configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const store = await server.ssrLoadModule("/src/store/project.ts");
    const kernel = await server.ssrLoadModule("/src/kernel/project.ts");
    const registry = await server.ssrLoadModule("/src/kernel/registry.ts");
    registry.registerCards([{ id: "av-test", name: "Audio card", source: "native", defaults: {}, controls: [], inputs: {}, Component: () => null, audio: () => new Float32Array(2) }]);
    const p = kernel.createEmptyProject();
    p.duration = 6;
    p.media = [{ id: "v", kind: "video", name: "video.mp4", url: "/media/v.mp4", duration: 8 }];
    p.tracks = [
      { id: "visual", name: "motion", clips: [{ id: "av", cardId: "av-test", params: {}, start: 0, end: 6, opacity: .75 }] },
      { id: "video", name: "video", clips: [{ id: "v1", cardId: "", mediaId: "v", params: {}, start: 0, end: 2 }, { id: "v2", cardId: "", mediaId: "v", params: {}, start: 2, end: 4 }] },
    ];
    store.actions.loadProject(p);
    await run({ ...store, ...kernel, server, p });
  } finally { await server.close(); }
}

test("Audio motion graphics and media can each be muted independently: the picture is unchanged, and undo/redo/copy/split/reopen preserve it", () => fixture(async ({ actions, getState, findClip }) => {
  for (const id of ["av", "v1"]) {
    const before = findClip(getState().project, id).clip;
    assert.equal(actions.setClipMuted(id, true).ok, true);
    const after = findClip(getState().project, id).clip;
    assert.notEqual(after, before);
    assert.equal(after.audioMuted, true);
    assert.equal(after.opacity, before.opacity);
    actions.undo();
    assert.equal(findClip(getState().project, id).clip.audioMuted, undefined);
    actions.redo();
    assert.equal(findClip(getState().project, id).clip.audioMuted, true);
  }
  assert.deepEqual(buildAudioPlan(getState().project, ".", () => true).map(e => e.clipId), ["v2"]);
  assert.equal(actions.setClipVolume("av", .3).ok, true);
  assert.equal(findClip(getState().project, "av").clip.opacity, .75);
  const right = actions.splitClip("av", 3);
  assert.equal(right.audioMuted, true);
  assert.equal(right.audioVolume, .3);
  const duplicate = actions.duplicateClip(right.id);
  assert.equal(duplicate.audioMuted, true);
  const saved = JSON.stringify(getState().project);
  actions.loadProject(JSON.parse(saved));
  assert.equal(findClip(getState().project, duplicate.id).clip.audioMuted, true);
  actions.setClipMuted("v1", false);
  assert.deepEqual(buildAudioPlan(getState().project, ".", () => true).map(e => e.clipId), ["v1", "v2"]);
}));

test("Separating audio from an embedded card fails explicitly, a multi-selection is not partially applied, and separating a regular video can still be undone in one step", () => fixture(async ({ actions, getState, findClip, server }) => {
  const before = getState().project;
  const failed = actions.separateAudio("av");
  assert.equal(failed.ok, false);
  assert.equal(failed.code, "EMBEDDED_CARD_AUDIO_UNSEPARABLE");
  assert.match(failed.error, /audio track cannot be separated/);
  assert.strictEqual(getState().project, before);
  assert.equal(actions.canUndo(), false);
  const mixed = actions.separateAudios(["v1", "av", "v2"]);
  assert.equal(mixed.ok, false);
  assert.strictEqual(getState().project, before, "Leaves no empty audio track or muted first segment");
  const { audioHandlers } = await server.ssrLoadModule("/src/mcp/handlers/audio.ts");
  const reply = audioHandlers.separateAudio({ clipIds: ["v1", "av"] });
  assert.equal(reply.ok, false);
  assert.equal(reply.code, "EMBEDDED_CARD_AUDIO_UNSEPARABLE");
  assert.strictEqual(getState().project, before);
  const done = actions.separateAudios(["v1", "v2"]);
  assert.equal(done.ok, true);
  assert.equal(done.items.length, 2);
  assert.equal(getState().project.tracks.length, before.tracks.length + 2);
  assert.equal(findClip(getState().project, "v1").clip.audioMuted, true);
  assert.equal(findClip(getState().project, "v2").clip.audioMuted, true);
  actions.undo();
  assert.strictEqual(getState().project, before);
}));

test("Mute batch validation is atomic, and a card whose source is unavailable but has an embedded marker cannot be separated either", () => fixture(async ({ actions, getState }) => {
  const before = getState().project;
  assert.equal(actions.setClipsMuted(["av", "missing"], true).ok, false);
  assert.strictEqual(getState().project, before);
  assert.equal(actions.setClipMuted("av", "true").ok, false);
  actions.updateTrack("visual", { locked: true });
  assert.equal(actions.setClipMuted("av", true).code, "TRACK_LOCKED");
  const p = structuredClone(before);
  p.cardNodes = [{ id: "n", adapter: "card", cardId: "missing-av", kind: "animation", embeddedAudio: true, inputs: {}, params: {} }];
  p.tracks[0].clips[0] = { ...p.tracks[0].clips[0], cardId: "missing-av", nodeId: "n" };
  actions.loadProject(p);
  assert.equal(actions.setClipMuted("av", true).ok, true);
  assert.equal(actions.separateAudio("av").code, "EMBEDDED_CARD_AUDIO_UNSEPARABLE");
}));

test("The mute badge is always present and accessible, a narrow clip still carries the icon and the full name, and failures are shown to the user", () => fixture(async ({ server }) => {
  const { clipMuteReason, ClipMuteBadge, reportClipAudioResult } = await server.ssrLoadModule("/src/editor/timeline/ClipMuteBadge.tsx");
  assert.equal(clipMuteReason({}, {}), null);
  assert.match(clipMuteReason({ audioMuted: true }, {}), /Clip muted/);
  assert.match(clipMuteReason({}, { muted: true }), /Track muted/);
  assert.match(clipMuteReason({ audioVolume: 0 }, {}), /Clip volume is 0/);
  for (const compact of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(ClipMuteBadge, { reason: "Clip muted", label: "Motion graphics", compact }));
    assert.match(html, /data-pc="clip-muted"/);
    assert.match(html, /aria-label="Motion graphics: Clip muted"/);
    assert.match(html, /<svg/);
    assert.match(html, /Muted/);
  }
  const messages = [];
  assert.equal(reportClipAudioResult({ ok: false, error: "Cannot separate the audio track" }, s => messages.push(s)), false);
  assert.deepEqual(messages, ["Cannot separate the audio track"]);
  assert.equal(reportClipAudioResult({ ok: true }, s => messages.push(s)), true);
  assert.equal(messages.length, 1);
  assert.deepEqual(tools.find(t => t.name === "set_clip_muted").inputSchema.required, ["clipId", "muted"]);
}));
