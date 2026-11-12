import test from "node:test";
import assert from "node:assert/strict";

import { planPipelines, pipelineAt } from "./pipelinePlan.mjs";
import { streamEligible, soloStreamKind } from "./streamPlanRules.mjs";
import { projectHash, changedClips } from "./changedClips.mjs";

function sampleProject(cutKind = "2d") {
  return {
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 6,
    cuts: [{ id: "cut-1", name: "Cut 1", kind: cutKind }],
    activeCutId: "cut-1",
    media: [{ id: "m-vid", name: "bg.mp4", type: "video", src: "/bg.mp4", duration: 6 }],
    tracks: [
      {
        id: "t1",
        name: "Track 1",
        clips: [
          { id: "card-light", cardId: "title-card", start: 0, end: 6, params: {} },
          { id: "card-cap", cardId: "caption-track", start: 0, end: 6, params: {} },
          { id: "media-bg", mediaId: "m-vid", start: 0, end: 6, params: {} },
        ],
      },
    ],
  };
}

const COSTS = [
  { identityKey: "k-title", stepMs: 0.5, kind: "random" },
  { identityKey: "k-cap", stepMs: 0.3, kind: "random" },
];
const PLAN_OPTS = {
  identityKeys: { "card-light": "k-title", "card-cap": "k-cap" },
  frameModes: { "card-light": "direct", "card-cap": "direct" },
};

test("planPipelines in a 2D cut keeps fast light cards in the live pipeline", () => {
  const proj2d = sampleProject("2d");
  const plan2d = planPipelines(proj2d, COSTS, 30, PLAN_OPTS);
  assert.deepEqual([...plan2d.prerenderSet], []);
  assert.equal(pipelineAt(plan2d, "card-light", 2), "light");
  assert.equal(pipelineAt(plan2d, "card-cap", 2), "light");
});

test("planPipelines in a 3D cut pins all standalone card clips into per-card streams while excluding pure media clips", () => {
  const proj3d = sampleProject("3d");
  const plan3d = planPipelines(proj3d, COSTS, 30, PLAN_OPTS);

  // Card clips enter prerenderSet even without view3d UI toggle; media-bg does not
  assert.deepEqual([...plan3d.prerenderSet], ["card-cap", "card-light"]);
  assert.equal(plan3d.prerenderSet.has("media-bg"), false);
});

test("streamPlanRules classifies cards in a 3D cut as solo spatial streams rather than group-eligible planar streams", () => {
  const proj2d = sampleProject("2d");
  const proj3d = sampleProject("3d");
  const control = { clipId: "card-light", count: 180, capabilities: { compositing: "independent" } };
  const clip = proj3d.tracks[0].clips[0];
  const track = proj3d.tracks[0];

  assert.equal(streamEligible(control, clip, track, proj2d), true);
  assert.equal(soloStreamKind(control, clip, track, proj2d), null);

  assert.equal(streamEligible(control, clip, track, proj3d), false);
  assert.equal(soloStreamKind(control, clip, track, proj3d), "spatial");
});

test("changedClips and projectHash detect frameExpr and camera lane edits", () => {
  const base = sampleProject("3d");
  const withExpr = {
    ...base,
    tracks: [
      {
        ...base.tracks[0],
        clips: [
          { ...base.tracks[0].clips[0], frameExpr: { x: "400 * p" } },
          ...base.tracks[0].clips.slice(1),
        ],
      },
    ],
  };
  assert.notEqual(projectHash(base), projectHash(withExpr));
  assert.equal(changedClips(base, withExpr).kind, "tracks");

  const withCam = {
    ...base,
    cuts: [{ ...base.cuts[0], cameras: [{ id: "cam-1", row: 0, start: 0, end: 6, params: { z: 900 } }] }],
  };
  assert.notEqual(projectHash(base), projectHash(withCam));
});
