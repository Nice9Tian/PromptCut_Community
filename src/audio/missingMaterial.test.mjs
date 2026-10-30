import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");

async function withModule(fn) {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try { await fn(await server.ssrLoadModule("/src/audio/missingMaterial.ts")); }
  finally { await server.close(); }
}

test("missing-material voice starts at clip start once and never loops or shifts by source offset", () => withModule((M) => {
  const clip = { start: 8, end: 12, mediaOffset: 47 };
  assert.equal(M.missingMaterialSourceTime(clip, 8), 0);
  assert.equal(M.missingMaterialSourceTime(clip, 8.5), .5);
  assert.equal(M.missingMaterialSourceTime(clip, 11), 1.37);
  assert.equal(M.missingMaterialAudibleDuration(clip), 1.37);
  assert.match(M.MISSING_MATERIAL_WAV_URL, /missing-material\.wav/);
}));

test("a short clip crops the built-in voice to its duration", () => withModule((M) => {
  const clip = { start: 3, end: 3.4, mediaOffset: 92 };
  assert.ok(Math.abs(M.missingMaterialAudibleDuration(clip) - .4) < 1e-9);
  assert.ok(M.missingMaterialSourceTime(clip, 3.4) < M.MISSING_MATERIAL_WAV_SECONDS);
}));
