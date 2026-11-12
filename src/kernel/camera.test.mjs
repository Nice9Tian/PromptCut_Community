import test from "node:test";
import assert from "node:assert/strict";

import {
  cutKindOf,
  activeCutKind,
  effectiveCamera3dFov,
  cameraDistanceForStage,
  validateCameraParams,
  assertCameraLaneNoOverlap,
  resolveCamera2DAt,
  resolveCamera3DAt,
  camera2DCssTransform,
  isIdentityCamera2D,
} from "./camera.mjs";
import { createEmptyProject, flattenBoards3D } from "./project.ts";
import {
  addCut,
  switchCut,
  listCuts,
  setCutKindInProject,
  addCameraToCut,
  updateCameraInCut,
  listCamerasInCut,
} from "./cuts.ts";
import { contentEndOf, effectiveDuration } from "./duration.ts";
import { cameraFor, DEFAULT_FOV_DEG } from "./space3d.ts";
import { frameIdentity } from "../../server/frame-identity.mjs";

test("cutKindOf defaults to 2d and is never guessed from 3D clips on tracks", () => {
  const p = createEmptyProject("Test");
  p.tracks[0].clips.push({
    id: "c3d",
    cardId: "title-card",
    start: 0,
    end: 5,
    params: {},
    frame: { x: 0, y: 0, translateZ: -500, rotateY: 25 },
  });
  assert.equal(cutKindOf(undefined), "2d");
  assert.equal(cutKindOf({ id: "cut-1", name: "Cut 1" }), "2d");
  assert.equal(activeCutKind(p), "2d");
  assert.equal(effectiveCamera3dFov(p), undefined);
});

test("contentEndOf ignores cut.cameras completely so camera clips never inflate project duration", () => {
  const p = createEmptyProject("Duration check");
  p.cuts = [
    {
      id: "cut-1",
      name: "Cut 1",
      kind: "3d",
      cameras: [{ id: "cam-long", start: 0, end: 60, row: 0, params: { z: "1500 - 1000 * p" } }],
    },
  ];
  p.activeCutId = "cut-1";
  p.tracks[0].clips = [{ id: "c1", cardId: "title-card", start: 0, end: 4, params: {} }];
  assert.equal(contentEndOf(p.tracks), 4);
  assert.equal(effectiveDuration(contentEndOf(p.tracks), 10, null), 4);

  // Deleting all track clips shrinks contentEndOf to 0 even when camera spans 0..60
  p.tracks[0].clips = [];
  assert.equal(contentEndOf(p.tracks), 0);
});

test("resolveCamera2DAt evaluates expressions, honors half-open [start, end), and lets upper row override lower row", () => {
  const cameras = [
    { id: "cam-base", row: 0, start: 0, end: 10, params: { x: "1000 * p", y: 50, zoom: 1, rotate: 0 } },
    { id: "cam-override", row: 1, start: 4, end: 6, params: { x: 200, y: -40, zoom: "1 + 0.5 * p", rotate: 10 } },
    { id: "cam-disabled", row: 2, start: 0, end: 10, enabled: false, params: { x: 9999 } },
  ];

  // At t = 2: row 0 active (p = 0.2 -> x = 200)
  const at2 = resolveCamera2DAt(cameras, 2);
  assert.equal(at2.activeClipId, "cam-base");
  assert.equal(at2.x, 200);
  assert.equal(at2.y, 50);
  assert.equal(at2.zoom, 1);

  // At t = 5: row 1 overrides row 0 (local p = (5 - 4) / 2 = 0.5 -> zoom = 1.25)
  const at5 = resolveCamera2DAt(cameras, 5);
  assert.equal(at5.activeClipId, "cam-override");
  assert.equal(at5.x, 200);
  assert.equal(at5.y, -40);
  assert.equal(at5.zoom, 1.25);
  assert.equal(at5.rotate, 10);

  // At t = 6 (half-open end of row 1): falls back cleanly to row 0 (p = 0.6 -> x = 600)
  const at6 = resolveCamera2DAt(cameras, 6);
  assert.equal(at6.activeClipId, "cam-base");
  assert.equal(at6.x, 600);

  // At t = 10 (uncovered): returns exact identity camera
  const at10 = resolveCamera2DAt(cameras, 10);
  assert.deepEqual(at10, { x: 0, y: 0, zoom: 1, rotate: 0, activeClipId: null });
  assert.equal(isIdentityCamera2D(at10), true);
  assert.equal(camera2DCssTransform(at10, { width: 1920, height: 1080 }), null);

  // Non-identity 2D camera generates deterministic stage-center CSS transform
  const css = camera2DCssTransform({ x: 960, y: 0, zoom: 1.5, rotate: 0 }, { width: 1920, height: 1080 });
  assert.deepEqual(css, {
    transformOrigin: "960px 540px",
    transform: "scale(1.5) translate(-960px, 0px)",
  });
});

test("resolveCamera3DAt returns straight-on pinhole default on uncovered moments and animates dolly moves", () => {
  const stage = { width: 1920, height: 1080 };
  const expectedDefaultZ = cameraFor(stage, DEFAULT_FOV_DEG).distance;
  assert.ok(Math.abs(cameraDistanceForStage(stage.height, DEFAULT_FOV_DEG) - expectedDefaultZ) < 1e-6);

  const uncovered = resolveCamera3DAt([], stage, 1.5, DEFAULT_FOV_DEG);
  assert.equal(uncovered.activeClipId, null);
  assert.equal(uncovered.x, 0);
  assert.equal(uncovered.y, 0);
  assert.ok(Math.abs(uncovered.z - expectedDefaultZ) < 1e-5);
  assert.equal(uncovered.rx, 0);
  assert.equal(uncovered.ry, 0);
  assert.equal(uncovered.rz, 0);
  assert.equal(uncovered.fovDeg, DEFAULT_FOV_DEG);

  const cams = [
    {
      id: "dolly",
      row: 0,
      start: 0,
      end: 5,
      params: { z: "1500 - 2200 * p", ry: "-10 + 20 * p", fovDeg: 50 },
    },
  ];
  const mid = resolveCamera3DAt(cams, stage, 2.5, DEFAULT_FOV_DEG);
  assert.equal(mid.activeClipId, "dolly");
  assert.equal(mid.z, 400);
  assert.equal(mid.ry, 0);
  assert.equal(mid.fovDeg, 50);
});

test("assertCameraLaneNoOverlap rejects same-row overlaps while allowing end-to-start adjacency and multi-row overlap", () => {
  const existing = [{ id: "c1", name: "Shot 1", row: 0, start: 0, end: 4, params: {} }];

  // Adjacent touching end === start on row 0 is allowed
  assert.doesNotThrow(() =>
    assertCameraLaneNoOverlap(existing, { row: 0, start: 4, end: 8 }),
  );

  // Overlapping on row 1 is allowed
  assert.doesNotThrow(() =>
    assertCameraLaneNoOverlap(existing, { row: 1, start: 2, end: 6 }),
  );

  // Overlapping on row 0 is rejected
  assert.throws(
    () => assertCameraLaneNoOverlap(existing, { row: 0, start: 3.5, end: 6 }),
    /overlapping/i,
  );
});

test("validateCameraParams enforces 2D vs 3D parameter sets and zoom/fovDeg bounds", () => {
  assert.throws(() => validateCameraParams({ z: 500 }, "2d"), /does not recognize "z" for a 2D cut/i);
  assert.throws(() => validateCameraParams({ zoom: 2 }, "3d"), /does not recognize "zoom" for a 3D cut/i);
  assert.throws(() => validateCameraParams({ zoom: 0 }, "2d"), /zoom must be greater than 0/i);
  assert.throws(() => validateCameraParams({ fovDeg: 170 }, "3d"), /fovDeg must be between/i);
});

test("cut kind conversion: 2D -> 3D is lossless; direct 3D -> 2D overwrite is rejected; camera CRUD round-trips across cut switches", () => {
  let p = createEmptyProject("Conversion test");
  const added = addCut(p, "Walkthrough", { kind: "3d", camera3dFov: 45 });
  p = added.project;
  assert.equal(listCuts(p).find((c) => c.id === added.cut.id)?.kind, "3d");

  // Switch active cut-1 from 2d to 3d losslessly
  p = setCutKindInProject(p, "cut-1", "3d");
  assert.equal(activeCutKind(p), "3d");

  // Direct 3D -> 2D overwrite is rejected to prevent silent loss of 3D placement and camera data
  assert.throws(() => setCutKindInProject(p, "cut-1", "2d"), /prerender_cut_to_2d/i);

  // Add camera to cut-1 and verify switching between cuts round-trips cut kind, cameras, and camera3dFov
  const withCam = addCameraToCut(p, "cut-1", {
    id: "cam1",
    row: 0,
    start: 0,
    end: 5,
    params: { z: "1200 - 400 * p" },
  });
  p = updateCameraInCut(withCam.project, "cut-1", "cam1", { name: "Dolly In" }).project;

  const switched = switchCut(p, added.cut.id, 0);
  assert.equal(activeCutKind(switched.project), "3d");
  assert.equal(listCamerasInCut(switched.project, "cut-1").cameras.length, 1);

  const back = switchCut(switched.project, "cut-1", 0);
  assert.equal(back.project.cuts[0].cameras.length, 1);
  assert.equal(back.project.cuts[0].cameras[0].name, "Dolly In");
});

test("flattenBoards3D gathers both card clips and image/video media clips in a 3D cut while skipping audio and captions", () => {
  const p = createEmptyProject("3D Boards");
  p.cuts = [{ id: "cut-1", name: "Cut 1", kind: "3d" }];
  p.activeCutId = "cut-1";
  p.media = [
    { id: "vid-1", name: "clip.mp4", kind: "video", url: "/v.mp4", duration: 10, width: 1920, height: 1080 },
    { id: "img-1", name: "photo.png", kind: "image", url: "/i.png", duration: 10, width: 800, height: 600 },
    { id: "aud-1", name: "bgm.mp3", kind: "audio", url: "/a.mp3", duration: 10 },
  ];
  p.tracks = [
    {
      id: "t1",
      name: "Track 1",
      clips: [
        { id: "b-card", cardId: "title-card", start: 0, end: 5, params: {}, frame: { x: 0, y: 0, translateZ: 0 } },
        { id: "b-vid", mediaId: "vid-1", cardId: "", start: 0, end: 5, params: {}, frame: { x: 200, y: 0, translateZ: -600 } },
        { id: "b-img", mediaId: "img-1", cardId: "", start: 0, end: 5, params: {}, frame: { x: -200, y: 0, translateZ: -1200 } },
        { id: "b-aud", mediaId: "aud-1", cardId: "", start: 0, end: 5, params: {} },
        { id: "b-cap", cardId: "caption-track", start: 0, end: 5, params: {} },
      ],
    },
  ];

  const boards = flattenBoards3D(p);
  assert.deepEqual(
    boards.map((b) => b.id),
    ["b-card", "b-vid", "b-img"],
  );
  assert.equal(boards[1].media?.kind, "video");
  assert.equal(boards[2].media?.kind, "image");

  // Changing camera lane invalidates frameIdentity
  const pWithCam = structuredClone(p);
  pWithCam.cuts[0].cameras = [{ id: "c1", row: 0, start: 0, end: 5, params: { z: 900 } }];
  assert.notEqual(frameIdentity(p), frameIdentity(pWithCam));
});
