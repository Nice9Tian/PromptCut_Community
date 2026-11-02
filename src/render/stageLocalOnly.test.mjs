/**
 * Cards that this device cannot run on the stage (`Stage.tsx`) (C10 contract section 9, user
 * changed semantics, 2026-09-29). Server-side render HTML to verify; run:
 *   node --test src/render/stageLocalOnly.test.mjs
 *
 *   SL-01 Online browser mode: user cards bundled at build time mount components as usual
 *         (user decision, 2026-10-21: "render exact frame when paused", no longer blocking cards
 *         executable on this page by tier); synced user cards without definitions do not mount
 *         components, and wrapper layers mount stream planes and suppression placeholders like
 *         built-in heavy cards (no snapshot plane after snapshot removal); placeholder slots
 *         default to `hidden` (entering visibility scheduling) and are always hourglasses
 *         (`awaiting`), with no "Requires local PC rendering assistance" no matter how small the
 *         preview zooms (removed by user decision, 2026-10-21); hourglasses compensate for preview
 *         zoom (`fit`); ids missing on both sides are not drawn
 *   SL-02 Mode disabled (desktop, export, prerender): user cards and media effect cards mount
 *         components as usual, sync table has no effect, no `unsupported`
 */
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function withStage(fn) {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const R = await server.ssrLoadModule("/src/kernel/registry.ts");
    const H = await server.ssrLoadModule("/src/render/placeholderHost.ts");
    const P = await server.ssrLoadModule("/src/kernel/project.ts");
    const S = await server.ssrLoadModule("/src/render/Stage.tsx");
    const marker = (id) => function Marker() { return React.createElement("i", { "data-test-component": id }); };
    R.resetCards();
    R.registerCards([
      { id: "builtin", name: "Built-in", defaults: {}, controls: [], frameMode: "direct", Component: marker("builtin") },
      { id: "mine", name: "Build-time user card", defaults: {}, controls: [], frameMode: "direct", Component: marker("mine") },
    ]);
    R.setUserCardSources({ mine: "" }, { mine: "mine" });
    R.setSyncedUserCards([{ id: "synced-card", name: "Synced card" }, { id: "synced-two", name: "Synced card two" }]);
    const clips = [["b", "builtin"], ["u", "mine"], ["s", "synced-card"], ["v", "synced-two"], ["x", "unknown-card"]].map(([id, cardId]) => ({ id, cardId, start: 0, end: 4, params: {} }));
    const project = { version: 1, id: "p", name: "p", width: 640, height: 360, fps: 30, duration: 4, media: [], tracks: clips.map((c, i) => ({ id: `t${i}`, name: "t", clips: [c] })) };
    const timeline = P.flattenOverlay(project);
    const render = (props = {}) => renderToStaticMarkup(React.createElement(S.Stage, { timeline, t: 1, playToken: 1, ...props }));
    await fn({ R, H, render, marker });
  } finally {
    await server.close();
  }
}

/** Wrapper layer for a clip (up to the next wrapper layer) */
const wrapOf = (html, id) => html.match(new RegExp(`<div data-pc-clip="${id}"[\\s\\S]*?(?=<div data-pc-clip=|$)`))?.[0] ?? null;

test("SL-01 online: cards that cannot run on this page get no component, but still get the stream plane and the suppressed placeholder, and the placeholder is always an hourglass; runnable user cards mount as usual; unknown ids are not drawn", () => withStage(async ({ R, H, render, marker }) => {
  H.setOnlineBrowserMode(true);
  H.setPlaceholdersEnabled(true);
  try {
    const props = { snapshots: new Map([["s", "<p>snap-s</p>"]]), suppressed: new Set(["u", "s", "v"]), streamPlanes: [{ clipIds: ["v"] }], awaiting: new Set(), settling: new Map() };
    const html = render(props);
    const b = wrapOf(html, "b"), s = wrapOf(html, "s"), v = wrapOf(html, "v");
    assert.match(b, /data-test-component="builtin"/, "Built-in cards mount their component as usual");
    // 2026-10-06 (online-card-exec-contract.md section 6): user cards bundled at build time are page's
    // own code and mount components like built-in cards
    assert.match(wrapOf(html, "u"), /data-test-component="mine"/, "Build-time user cards mount their component as usual");
    // From 2026-10-21, do not block user cards runnable on this page by tier (must draw exact frames
    // when paused); the original tier-based switch was removed on 2026-10-22
    const lowHtml = render(props);
    // Synced cards loaded successfully in stage (defined in runtime registry): mount components as
    // usual; unloaded ones (v) do not mount as before
    R.setRuntimeCards([{ id: "synced-card", name: "Synced card", defaults: {}, controls: [], frameMode: "direct", Component: marker("synced") }]);
    const live = render({ snapshots: new Map(), suppressed: new Set(), awaiting: new Set(), settling: new Map() });
    assert.match(wrapOf(live, "s"), /data-test-component="synced"/, "Synced cards that loaded successfully mount their component");
    assert.doesNotMatch(wrapOf(live, "v"), /data-test-component/, "Synced cards that did not load do not mount a component");
    R.setRuntimeCards([]);
    assert.doesNotMatch(v, /data-test-component/, "Synced cards with no definition do not mount a component");
    assert.match(v, /data-pc-stream-plane=""/, "Cards that cannot run still get the stream plane");
    // After snapshot removal: synced cards without streams (no definitions) are taken over by
    // suppressed placeholders and no longer mount snapshot planes
    assert.doesNotMatch(s, /data-pc-snapshot-plane/, "Synced cards have the snapshot plane removed");
    assert.match(s, /class="pc-suppressed"/, "Synced cards (no definition) are taken over by the suppressed placeholder");
    for (const w of [s, v]) {
      assert.match(w, /data-pc-placeholder-slot="" hidden=""/, "The slot is hidden by default and toggled by the show/hide scheduler");
      assert.doesNotMatch(w, /data-pc-placeholder-fixed/, "Not a permanent slot");
      assert.match(w, /data-pc-placeholder-reason="awaiting"/, "Cards that cannot run show an hourglass (the result comes from the render node)");
    }
    // Preview scale 25%: hourglass maintains original size on screen (28 × 4 stage pixels);
    // "Requires local PC rendering assistance" is absent in all cases
    H.setPlaceholderViewScale(0.25);
    const html2 = render(props);
    for (const id of ["s", "v", "b"]) {
      const w = wrapOf(html2, id);
      assert.match(w, /data-pc-placeholder-kind="badge"[^>]*width:28px;height:28px;transform:scale\(4\)/, `The hourglass of ${id} is compensated for the preview scale`);
    }
    for (const doc of [html, lowHtml, html2]) assert.doesNotMatch(doc, /unsupported|requires local PC render helper/);
    H.setPlaceholderViewScale(1);
    assert.equal(wrapOf(html, "x"), null, "An id that exists on neither side is not drawn");
    // Background stage (placeholders disabled): still mounts no components and has no slots
    H.setPlaceholdersEnabled(false);
    const back = render({ snapshots: new Map(), suppressed: new Set() });
    assert.doesNotMatch(wrapOf(back, "v"), /data-test-component|data-pc-placeholder-slot/);
  } finally {
    H.setPlaceholderViewScale(1);
    R.setRuntimeCards([]);
    H.setOnlineBrowserMode(false);
    H.setPlaceholdersEnabled(false);
  }
}));

test("SL-02 mode off: user cards mount their component as usual, the sync table has no effect, no unsupported", () => withStage(async ({ H, render }) => {
  H.setOnlineBrowserMode(false);
  for (const placeholders of [false, true]) {
    H.setPlaceholdersEnabled(placeholders);
    const html = render(placeholders ? { snapshots: new Map(), suppressed: new Set(["u"]) } : {});
    assert.match(wrapOf(html, "u"), /data-test-component="mine"/);
    assert.equal(wrapOf(html, "s"), null, "Synced card with no definition on this machine: the desktop app does not draw it");
    assert.doesNotMatch(html, /unsupported/);
  }
  // Desktop preview also compensates hourglass by preview zoom (~28 pixels on screen), without
  // compensating this layer's own scale
  H.setPlaceholdersEnabled(true);
  H.setPlaceholderViewScale(0.5);
  try {
    const html = render({ snapshots: new Map(), suppressed: new Set(["u"]) });
    assert.match(wrapOf(html, "u"), /data-pc-placeholder-kind="badge"[^>]*width:28px;height:28px;transform:scale\(2\)/);
  } finally {
    H.setPlaceholderViewScale(1);
    H.setPlaceholdersEnabled(false);
  }
}));
