import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const media = (extra = {}) => ({ id: "m1", kind: "video", name: "scene.mp4", url: "/@media/original", hash: "a".repeat(64),
  missingMaterial: { v: 1, mediaId: "m1", original: { kind: "video", name: "scene.mp4", url: "/@media/original", hash: "a".repeat(64) }, reason: "confirmed-missing", visual: true, audio: true }, ...extra });

test("only a matching explicit confirmed-missing record enables the proxy", async () => {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
  const M = await server.ssrLoadModule("/src/editor/io/missingMaterials.ts");
  assert.equal(M.confirmedMissing(media()), true);
  assert.equal(M.confirmedMissing(media({ missingMaterial: undefined })), false);
  assert.equal(M.confirmedMissing(media({ missingMaterial: { ...media().missingMaterial, mediaId: "other" } })), false);
  assert.equal(M.confirmedMissing(media({ missingMaterial: { ...media().missingMaterial, reason: "decode-error" } })), false);
  assert.equal(M.confirmedMissing(media({ missingMaterial: { ...media().missingMaterial, original: { ...media().missingMaterial.original, kind: "image" } } })), false);
  } finally { await server.close(); }
});

test("visual/audio flags honor image silence and preserve the original display name", async () => {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
  const M = await server.ssrLoadModule("/src/editor/io/missingMaterials.ts");
  const m = media();
  assert.equal(M.confirmedMissingVisual(m), true);
  assert.equal(M.confirmedMissingAudio(m), true);
  assert.equal(M.missingMaterialLabel(m), "scene.mp4");
  assert.equal(M.confirmedMissingAudio(media({ kind: "image", missingMaterial: { ...media().missingMaterial, original: { ...media().missingMaterial.original, kind: "image" } } })), false);
  const video = media({ id: "source", kind: "video", missingMaterial: { ...media().missingMaterial, mediaId: "source" } });
  const derived = { id: "source-sound", kind: "audio", name: "scene · 声音", url: video.url, soundOf: "source" };
  assert.equal(M.confirmedMissingAudio(derived, { media: [video, derived] }), true, "a separated sound asset inherits only the source video's confirmed audio-missing state");
  } finally { await server.close(); }
});
