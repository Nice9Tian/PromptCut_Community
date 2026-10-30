import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("打字的源偏移贯穿时间轴与舞台；不改变其它卡片本地时间", async () => {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { flattenOverlay } = await server.ssrLoadModule("/src/kernel/project.ts");
    const registry = await server.ssrLoadModule("/src/kernel/registry.ts");
    const { Stage } = await server.ssrLoadModule("/src/render/Stage.tsx");
    registry.resetCards();
    const seen = [];
    const Component = ({ t, sourceOffset }) => {
      seen.push({ t, sourceOffset });
      return React.createElement("i", { "data-source-time": t + (sourceOffset ?? 0) });
    };
    for (const frameMode of ["direct", "stateful"]) {
      registry.resetCards();
      registry.registerCards([{ id: "mu-typing", name: "typing", defaults: {}, controls: [], frameMode, Component }]);
      const project = { width: 640, height: 360, fps: 30, duration: 4, media: [], tracks: [{ id: "t", clips: [
        { id: "c", cardId: "mu-typing", start: 1, end: 4, mediaOffset: 1.125, params: {} },
        { id: "other", cardId: "other", start: 1, end: 4, mediaOffset: 2, params: {} },
      ] }] };
      const timeline = flattenOverlay(project);
      assert.equal(timeline.clips[0].sourceOffset, 1.125);
      assert.equal("sourceOffset" in timeline.clips[1], false);
      seen.length = 0;
      const html = renderToStaticMarkup(React.createElement(Stage, { timeline, t: 1.5, playToken: 1 }));
      assert.equal(seen.length, 1);
      assert.equal(seen[0].t, 0.5);
      assert.equal(seen[0].sourceOffset, 1.125);
      assert.match(html, /data-source-time="1.625"/);
    }
  } finally { await server.close(); }
});
