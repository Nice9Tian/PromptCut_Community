import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const missing = (id, kind) => ({ id, kind, name: `${id}.wav`, url: `/@media/original-${id}`, missingMaterial: {
  v: 1, mediaId: id, original: { kind, name: `${id}.wav`, url: `/@media/original-${id}` }, reason: "confirmed-missing", visual: kind !== "audio", audio: kind !== "image",
} });

test("MediaLayers previews only confirmed missing audio from the bundled one-shot WAV", async () => {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const M = await server.ssrLoadModule("/src/editor/preview/MediaLayers.tsx");
    const media = missing("audio", "audio");
    const project = { width: 320, height: 180, fps: 30, duration: 5, media: [media], tracks: [{ id: "a", clips: [{ id: "lost", mediaId: media.id, start: 1, end: 5, mediaOffset: 60 }] }] };
    const html = renderToStaticMarkup(createElement(M.MediaLayers, { project, t: 2, playing: false, audioOnly: true }));
    assert.match(html, /<audio[^>]+src="[^"]*missing-material[^\"]*\.wav/);
    assert.doesNotMatch(html, /original-audio/);
  } finally { await server.close(); }
});

test("MediaLayers never adds a voice to an image, even when original source is confirmed missing", async () => {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const M = await server.ssrLoadModule("/src/editor/preview/MediaLayers.tsx");
    const media = missing("image", "image");
    const project = { width: 320, height: 180, fps: 30, duration: 2, media: [media], tracks: [{ id: "i", clips: [{ id: "image-clip", mediaId: media.id, start: 0, end: 2 }] }] };
    const html = renderToStaticMarkup(createElement(M.MediaLayers, { project, t: 1, playing: false, audioOnly: true }));
    assert.doesNotMatch(html, /<audio/);
  } finally { await server.close(); }
});
