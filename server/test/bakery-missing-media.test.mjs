import test from "node:test";
import assert from "node:assert/strict";
import { planMedia } from "../bakery/media.mjs";

test("bakery skips the original URL only for a structurally matching confirmed-missing visual", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const project = {
    width: 320, height: 180, fps: 30, duration: 2,
    media: [{ id: "lost", kind: "video", name: "scene.mp4", url: "https://assets.invalid/asset", hash: "a".repeat(64),
      missingMaterial: { v: 1, mediaId: "lost", original: { kind: "video", name: "scene.mp4", url: "https://assets.invalid/asset", hash: "a".repeat(64) }, reason: "confirmed-missing", visual: true, audio: true } }],
    tracks: [{ id: "v", clips: [{ id: "c", mediaId: "lost", start: 0, end: 2 }] }],
  };
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    return Response.json(project);
  };
  try {
    const result = await planMedia({ url: "https://site.invalid/export?timeline=%2Fproject.json" }, ".", "ffmpeg");
    assert.equal(result.layers.length, 1);
    assert.equal(result.layers[0].src, null);
    assert.equal(result.layers[0].missingMaterial, true);
    assert.equal(result.layers[0].media.url, "https://assets.invalid/asset", "original reference stays on the project media");
    assert.deepEqual(requests, ["https://site.invalid/project.json"], "the confirmed missing source URL is not retried by the bakery");
  } finally { globalThis.fetch = originalFetch; }
});
