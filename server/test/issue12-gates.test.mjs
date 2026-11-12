import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createVite } from "vite";

import { applyCardDefinition, detachCardNode } from "../../src/kernel/cardAuthoring.mjs";
import { checkCardSource, checkMonolithCard } from "../vite-plugin-cards.ts";
import { loadSsrHost } from "../agent/ssr-host.mjs";
import { CLOUD_TOOL_PLAN } from "../agent/service/cloud-tools.mjs";

const ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const MOCK_CARDS = {
  "cam-rig-overlay": {
    id: "cam-rig-overlay",
    name: "Camera Rig Pre-Overlay",
    overlay: "pre",
    defaults: { dolly: 200 },
  },
  "scene-3d": {
    id: "scene-3d",
    name: "3D Scene",
    Component: () => null,
    defaults: {},
  },
  "title-card": {
    id: "title-card",
    name: "Title Card",
    Component: () => null,
    defaults: {},
  },
};

const getMockCard = (id) => MOCK_CARDS[id];

test("applyCardDefinition rejects pre-overlay cards on non-scene hosts and attaches cleanly to scene-3d or 3D cut segments", () => {
  const project = {
    version: 1,
    id: "p-pre",
    name: "Pre-overlay gate",
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 6,
    themeId: "editorial-dark",
    media: [{ id: "vid-1", name: "v.mp4", type: "video", src: "/v.mp4", duration: 6 }],
    cuts: [
      { id: "cut-main", name: "Main", kind: "2d" },
      { id: "cut-2d-sub", name: "Sub 2D", kind: "2d", tracks: [], duration: 6, transitions: [] },
      { id: "cut-3d-sub", name: "Sub 3D", kind: "3d", tracks: [], duration: 6, transitions: [] },
    ],
    activeCutId: "cut-main",
    tracks: [
      {
        id: "t1",
        name: "Track 1",
        clips: [
          { id: "c-dom", cardId: "title-card", start: 0, end: 4, params: {} },
          { id: "c-media", mediaId: "vid-1", start: 0, end: 4, params: {} },
          { id: "c-cut2d", cutId: "cut-2d-sub", start: 0, end: 4, params: {} },
          { id: "c-cut3d", cutId: "cut-3d-sub", start: 0, end: 4, params: {} },
          { id: "c-scene3d", cardId: "scene-3d", start: 0, end: 4, params: {} },
        ],
      },
    ],
  };

  // Missing clipId rejected
  assert.throws(
    () => applyCardDefinition(project, { cardId: "cam-rig-overlay" }, getMockCard),
    /requires clipId targeting an existing scene host/i,
  );

  // Ordinary DOM card rejected with actionable camera lane guidance
  assert.throws(
    () => applyCardDefinition(project, { cardId: "cam-rig-overlay", clipId: "c-dom" }, getMockCard),
    /only attach to a scene host.*add_camera/i,
  );

  // Media clip rejected
  assert.throws(
    () => applyCardDefinition(project, { cardId: "cam-rig-overlay", clipId: "c-media" }, getMockCard),
    /not a media clip.*add_camera/i,
  );

  // 2D cut segment rejected
  assert.throws(
    () => applyCardDefinition(project, { cardId: "cam-rig-overlay", clipId: "c-cut2d" }, getMockCard),
    /not a 2D cut segment.*add_camera/i,
  );

  // scene-3d host succeeds
  const onScene = applyCardDefinition(
    project,
    { cardId: "cam-rig-overlay", clipId: "c-scene3d", params: { dolly: 450 } },
    getMockCard,
  );
  const sceneClip = onScene.project.tracks[0].clips.find((c) => c.id === "c-scene3d");
  assert.equal(sceneClip.preOverlays.length, 1);
  assert.equal(sceneClip.preOverlays[0].params.dolly, 450);

  // 3D cut segment host succeeds and detaches cleanly via detachCardNode
  const onCut3D = applyCardDefinition(
    onScene.project,
    { cardId: "cam-rig-overlay", clipId: "c-cut3d", params: { dolly: 800 } },
    getMockCard,
  );
  const cut3dClip = onCut3D.project.tracks[0].clips.find((c) => c.id === "c-cut3d");
  assert.equal(cut3dClip.preOverlays.length, 1);
  const detached = detachCardNode(onCut3D.project, "c-cut3d", getMockCard, onCut3D.nodeId);
  const afterDetach = detached.project.tracks[0].clips.find((c) => c.id === "c-cut3d");
  assert.equal(afterDetach.preOverlays, undefined);
});

test("checkMonolithCard and checkCardSource reject embedded camera rigs and multi-scene film schedules while allowing clean cards", () => {
  const monolithCamSource = `
import type { CardDef } from "../../kernel/types";
const CAM_KEYS = [
  { t: 0, camX: 0, camY: 0, camZ: 1200 },
  { t: 4, camX: 300, camY: 0, camZ: 600 },
  { t: 8, camX: 0, camY: 0, camZ: -200 },
];
export const wholeFilmCard: CardDef<any> = {
  id: "whole-film",
  name: "Whole Film",
  category: "hero",
  frameMode: "direct",
  description: "Full film walkthrough",
  useWhen: "Hero walkthrough",
  defaults: { title: "Hello" },
  controls: [{ key: "title", label: "Title", kind: "text" }],
  Component: ({ params, t }) => <div>{params.title} {t} {CAM_KEYS.length}</div>,
};
`;
  const camCheck = checkCardSource("whole-film", monolithCamSource, [], { mode: "author", before: "" });
  assert.equal(camCheck.ok, false);
  assert.ok(camCheck.errors.some((e) => /\[monolith\].*camera lane/i.test(e)));

  const monolithScenesSource = `
import type { CardDef } from "../../kernel/types";
const SCENES = [
  { start: 0, end: 4, label: "Intro" },
  { start: 4, end: 9, label: "Feature 1" },
  { start: 9, end: 15, label: "Feature 2" },
  { start: 15, end: 22, label: "Outro" },
];
export const multiSceneCard: CardDef<any> = {
  id: "multi-scene",
  name: "Multi Scene",
  category: "hero",
  frameMode: "direct",
  description: "Four chapters in one card",
  useWhen: "Show four chapters",
  defaults: { accent: "#38bdf8" },
  controls: [{ key: "accent", label: "Accent", kind: "color" }],
  Component: ({ t }) => {
    const active = SCENES.find((s) => t >= s.start && t < s.end) ?? SCENES[0];
    return <div>{active.label}</div>;
  },
};
`;
  const sceneCheck = checkCardSource("multi-scene", monolithScenesSource, [], { mode: "author", before: "" });
  assert.equal(sceneCheck.ok, false);
  assert.ok(sceneCheck.errors.some((e) => /\[monolith\].*multiple scenes/i.test(e)));

  const cleanSingleSubjectCard = `
import "../../kernel/remotionStyle";
import type { CardDef } from "../../kernel/types";
export const metricBadgeCard: CardDef<any> = {
  id: "metric-badge",
  name: "Metric Badge",
  category: "data",
  frameMode: "direct",
  description: "Single animated KPI badge",
  useWhen: "Highlighting one metric on a board",
  defaults: { label: "ARR", value: "2.4M" },
  controls: [
    { key: "label", label: "Label", kind: "text" },
    { key: "value", label: "Value", kind: "text" },
  ],
  Component: ({ params, t }) => {
    const opacity = Math.min(1, t / 0.4);
    return <div style={{ opacity }}>{params.label}: {params.value}</div>;
  },
};
`;
  assert.deepEqual(checkMonolithCard(cleanSingleSubjectCard), []);
  const cleanCheck = checkCardSource("metric-badge", cleanSingleSubjectCard, [], { mode: "author", before: "" });
  assert.equal(cleanCheck.ok, true, cleanCheck.errors.join("\n"));
});

test("MCP SSR host executes 2D/3D cut, camera lane, and frameExpr tools end-to-end", { timeout: 120_000 }, async () => {
  const vite = await createVite({
    configFile: false,
    root: ROOT,
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom",
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const host = await loadSsrHost((id) => vite.ssrLoadModule(id));
    for (const tool of [
      "set_cut_kind",
      "prerender_cut_to_2d",
      "add_camera",
      "update_camera",
      "remove_camera",
      "list_cameras",
    ]) {
      assert.ok(CLOUD_TOOL_PLAN[tool], `${tool} has a classification in CLOUD_TOOL_PLAN`);
    }

    host.resetStore();
    const addedCut = await host.callRoute("add_cut", {
      name: "3D One-Take",
      kind: "3d",
      camera3dFov: 45,
    });
    assert.equal(addedCut.ok, true);
    assert.equal(addedCut.cut.kind, "3d");

    // Switch active cut-1 from 2D to 3D via set_cut_kind
    const kindRes = await host.callRoute("set_cut_kind", {
      kind: "3d",
      camera3dFov: 45,
    });
    assert.equal(kindRes.ok, true);
    assert.equal(kindRes.kind, "3d");

    const cutsInfo = await host.callRoute("list_cuts", {});
    assert.equal(cutsInfo.activeCutKind, "3d");

    // Add a card clip and animate its 3D placement with set_position expressions
    const clipRes = await host.callRoute("add_clip", {
      cardId: "blur-text",
      start: 0,
      duration: 6,
      params: { text: "Board 1" },
    });
    assert.ok(clipRes.id);

    const posRes = await host.callRoute("set_position", {
      clipId: clipRes.id,
      x: "200 * p",
      translateZ: -600,
      frameExpr: { rotateY: "-15 + 30 * p" },
    });
    assert.equal(posRes.ok, true);
    assert.deepEqual(posRes.layout.frameExpr, { x: "200 * p", rotateY: "-15 + 30 * p" });
    assert.equal(posRes.layout.local.translateZ, -600);

    // Envelope round-trip via get_clip + set_clip preserves and updates frameExpr
    const envBefore = await host.callRoute("get_clip", { clipId: clipRes.id });
    assert.deepEqual(envBefore.frame.expr, { x: "200 * p", rotateY: "-15 + 30 * p" });
    await host.callRoute("set_clip", {
      clipId: clipRes.id,
      envelope: { frame: { expr: { x: "320 * p", rotateY: null } } },
    });
    const envAfter = await host.callRoute("get_clip", { clipId: clipRes.id });
    assert.deepEqual(envAfter.frame.expr, { x: "320 * p" });

    // Add a 3D dolly camera + upper-row override camera
    const cam0 = await host.callRoute("add_camera", {
      name: "Main Dolly",
      row: 0,
      start: 0,
      end: 6,
      params: { z: "1500 - 2000 * p" },
    });
    assert.equal(cam0.ok, true);
    assert.ok(cam0.cameraId);

    // Same-row overlap fails
    await assert.rejects(
      () => host.callRoute("add_camera", { row: 0, start: 2, end: 5, params: { z: 800 } }),
      /overlapping/i,
    );

    // Upper row 1 override succeeds
    const cam1 = await host.callRoute("add_camera", {
      name: "Close-up Override",
      row: 1,
      start: 2,
      end: 4,
      params: { x: 120, z: 300, fovDeg: 35 },
    });
    assert.equal(cam1.ok, true);
    assert.ok(cam1.cameraId);

    await host.callRoute("update_camera", {
      cameraId: cam1.cameraId,
      params: { x: "120 * (1 - p)" },
    });

    const listed = await host.callRoute("list_cameras", {});
    assert.equal(listed.cutKind, "3d");
    assert.equal(listed.cameras.length, 2);

    await host.callRoute("remove_camera", { cameraId: cam1.cameraId });
    const afterRemove = await host.callRoute("list_cameras", {});
    assert.equal(afterRemove.cameras.length, 1);
  } finally {
    await vite.close();
  }
});
