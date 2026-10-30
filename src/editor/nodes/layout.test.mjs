import test from "node:test";
import assert from "node:assert/strict";
import { graphOf } from "./layout.ts";

const p = { width: 1920, height: 1080, duration: 4, fps: 30, media: [{ id: "m", name: "视频", kind: "video", url: "x" }], tracks: [{ id: "t", name: "轨道", clips: [{ id: "c", mediaId: "m", start: 0, end: 2, params: {}, pixelMap: { id: "pm" } }] }], pixelMaps: [{ id: "pm", name: "换色", source: { stage: "origin" }, where: "1", to: { kind: "color", value: "#fff" }, mode: "continuous" }] };

test("node graph lays layers without overlap and highlights active path", () => {
  const g = graphOf(p, 1);
  assert.equal(g.nodes.find((n) => n.id === "out")?.kind, "out");
  assert.ok(g.edges.some((e) => e.active));
  for (let i = 0; i < g.nodes.length; i++) for (let j = i + 1; j < g.nodes.length; j++) {
    const a = g.nodes[i], b = g.nodes[j];
    const overlap = a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    assert.equal(overlap, false, `${a.id} overlaps ${b.id}`);
  }
});
