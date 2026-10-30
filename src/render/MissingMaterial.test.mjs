import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const ROOT = new URL("../../", import.meta.url).pathname.replace(/^\/(\w:)/, "$1");

test("shared missing-material visual shows the original display name as the text card", async () => {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const M = await server.ssrLoadModule("/src/render/MissingMaterial.tsx");
    const html = renderToStaticMarkup(createElement(M.MissingMaterial, { name: "素材.mp4" }));
    assert.match(html, /data-pc-missing-material="1"/);
    assert.match(html, /找不到素材素材\.mp4/);
    assert.match(html, /role="img"/);
  } finally { await server.close(); }
});

test("FrameScene uses the same text proxy for export frames while retaining the clip layer", async () => {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const M = await server.ssrLoadModule("/src/render/FrameScene.tsx");
    const media = { id: "missing", kind: "video", name: "original.mp4", url: "/@media/original", hash: "h1", missingMaterial: {
      v: 1, mediaId: "missing", original: { kind: "video", name: "original.mp4", url: "/@media/original", hash: "h1" }, reason: "confirmed-missing", visual: true, audio: true,
    } };
    const clip = { id: "clip", mediaId: "missing", start: 0, end: 2, frame: { x: 10, y: 20, w: 120, h: 90, anchor: [0, 0], scale: 1, rotate: 0 }, fadeIn: .25 };
    const project = { width: 320, height: 180, fps: 30, duration: 2, media: [media], tracks: [{ id: "video", clips: [clip] }] };
    const html = renderToStaticMarkup(createElement(M.FrameScene, { project, t: .1, playToken: 0 }));
    assert.match(html, /data-pc-confirmed-missing="1"/);
    assert.match(html, /找不到素材original\.mp4/);
    assert.match(html, /data-pc-clip="clip"/);
    assert.doesNotMatch(html, /data-pc-media-src="\/\@media\/original"/);
    assert.match(html, /opacity:0\.4/);
  } finally { await server.close(); }
});

test("FrameScene confirmed-missing pixelMap renders only the filtered proxy, never the pixel decoder", async () => {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const M = await server.ssrLoadModule("/src/render/FrameScene.tsx");
    const media = { id: "pixel-lost", kind: "video", name: "pixel.mp4", url: "/@media/pixel", missingMaterial: {
      v: 1, mediaId: "pixel-lost", original: { kind: "video", name: "pixel.mp4", url: "/@media/pixel" }, reason: "confirmed-missing", visual: true, audio: true,
    } };
    const clip = { id: "pixel-clip", mediaId: media.id, start: 0, end: 2, pixelMap: { id: "map" }, filter: { id: "f", params: {} }, emphasis: { kind: "outline", size: 3 }, opacity: .7,
      frame: { x: 10, y: 20, w: 120, h: 90, anchor: [0, 0], scale: 1, rotate: 0 } };
    const project = { width: 320, height: 180, fps: 30, duration: 2, media: [media], pixelMaps: [{ id: "map", name: "white", where: "a", to: { kind: "color", value: "#fff" } }], tracks: [{ id: "video", clips: [clip] }] };
    const html = renderToStaticMarkup(createElement(M.FrameScene, { project, t: .5, mediaT: .5, mediaMode: "live", playToken: 0 }));
    assert.match(html, /data-pc-confirmed-missing="1"/);
    assert.match(html, /drop-shadow/);
    assert.doesNotMatch(html, /data-pc-pixel-map=/);
    assert.doesNotMatch(html, /data-pc-media-src="\/\@media\/pixel"/);
  } finally { await server.close(); }
});

test("VideoTrack previews the confirmed-missing visual without loading its original source", async () => {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const M = await server.ssrLoadModule("/src/render/VideoTrack.tsx");
    const media = { id: "missing", kind: "image", name: "still.png", url: "/@media/original", missingMaterial: {
      v: 1, mediaId: "missing", original: { kind: "image", name: "still.png", url: "/@media/original" }, reason: "confirmed-missing", visual: true, audio: false,
    } };
    const clip = { id: "clip", mediaId: "missing", start: 0, end: 2, frame: { x: 4, y: 5, w: 120, h: 80 }, opacity: .7 };
    const html = renderToStaticMarkup(createElement(M.VideoTrack, { project: { width: 320, height: 180, fps: 30 }, cur: { clip, media, opacity: .7, trackId: "t" }, next: null,
      t: .5, playing: false, scrubbing: false, muted: true, stage: { width: 320, height: 180 } }));
    assert.match(html, /data-pc-confirmed-missing="1"/);
    assert.match(html, /找不到素材still\.png/);
    assert.doesNotMatch(html, /src="\/\@media\/original"/);
  } finally { await server.close(); }
});
