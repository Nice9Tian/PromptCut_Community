// Active screening for pixel map tools: reject whole-frame color grading (A) and return equivalent ops,
// accept per-pixel (B), reject untranslatable (C).
// Run: node --test src/mcp/tools/pixelMapTools.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";
import { normalizeFilterDef, applyTableOps } from "../../kernel/filters.mjs";
import { normalizePixelMapDef, mapRgba } from "../../kernel/pixelMap.mjs";

const green = "smoothstep(0.35,0.8,g-r)*(1-smoothstep(0.15,0.45,b))";

function fakeStore() {
  const project = {
    width: 1920, height: 1080, fps: 30, duration: 4,
    media: [{ id: "A", kind: "video", name: "a.mp4", url: "/a.mp4" }, { id: "B", kind: "video", name: "b.mp4", url: "/b.mp4" }],
    tracks: [{ id: "tr1", name: "V1", clips: [{ id: "c1", mediaId: "A", start: 0, end: 4 }] }],
    filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  };
  const clip = (id) => project.tracks[0].clips.find((x) => x.id === id);
  return {
    project,
    getState: () => ({ project }),
    actions: {
      addPixelMap(def, attach) { project.pixelMaps.push(def); if (attach) clip(attach.clipId).pixelMap = attach.pixelMap; },
      updatePixelMap(id, def) { project.pixelMaps = project.pixelMaps.map((x) => x.id === id ? def : x); },
      removePixelMap(id) { project.pixelMaps = project.pixelMaps.filter((x) => x.id !== id); },
      setClipPixelMap(id, pm) { clip(id).pixelMap = pm ?? undefined; return true; },
    },
  };
}

test("Pixel map tools: A is rejected with equivalent ops returned, B is accepted and returns webgl, C explains which part cannot be translated", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { createPixelMapTools } = await server.ssrLoadModule("/src/mcp/tools/pixelMapTools.ts");
    const toolsOf = () => { const s = fakeStore(); return { s, tools: createPixelMapTools(s) }; };

    /* --- A Whole-frame color grading: reject; ops in error can feed directly into create_filter and is per-pixel equivalent --- */
    {
      const { s, tools } = toolsOf();
      const raw = { name: "Brighten", where: "1", to: { kind: "expr", r: "r^0.8", g: "g^0.8", b: "b^0.8", a: "a" } };
      let err;
      try { tools.createPixelMap(raw); } catch (e) { err = e; }
      assert.ok(err, "Whole-frame color grading should be rejected");
      assert.match(err.message, /whole-frame color grading/);
      assert.equal(s.project.pixelMaps.length, 0, "A rejected definition must not be stored");

      const tail = err.message.slice(err.message.indexOf("\ncreate_filter ") + "\ncreate_filter ".length);
      const def = normalizeFilterDef(JSON.parse(tail.slice(0, tail.indexOf("\n"))));
      assert.equal(def.name, "Brighten");
      const pm = normalizePixelMapDef(raw);
      let worst = 0;
      for (let i = 0; i < 256; i++) {
        const v = i / 255;
        const ref = mapRgba(pm, [v, v, v, 1]);
        const got = applyTableOps(def.ops, [v, v, v]);
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(Math.round(ref[k] * 255) - Math.round(got[k] * 255)));
      }
      assert.ok(worst <= 1, `ops in the response differ from the original definition by ${worst} levels`);
    }

    /* --- B Per-pixel: accepted, response includes backend --- */
    {
      const { s, tools } = toolsOf();
      const r = tools.createPixelMap({ name: "Key out green", where: green, to: "transparent", clipId: "c1" });
      assert.equal(r.ok, true);
      assert.equal(r.backend, "webgl");
      assert.equal(s.project.pixelMaps.length, 1);
      assert.equal(s.project.tracks[0].clips[0].pixelMap.id, r.pixelMapId);
      assert.equal(tools.createPixelMap({ name: "Swap background", where: "1-step(0.5,luma)", to: { kind: "media", mediaId: "B", stage: "origin" } }).backend, "webgl");
    }

    /* --- C Cannot translate --- */
    {
      const { s, tools } = toolsOf();
      assert.throws(() => tools.createPixelMap({ name: "Bad", where: "(r-g)^0.5", to: "transparent" }), /cannot be translated into a shader[\s\S]*pow is undefined for a negative base/);
      assert.equal(s.project.pixelMaps.length, 0);
    }

    /* --- update also passes through the same gate; if rejected, entry in library remains unchanged --- */
    {
      const { s, tools } = toolsOf();
      const r = tools.createPixelMap({ name: "Key out green", where: green, to: "transparent" });
      assert.throws(() => tools.updatePixelMap({ pixelMapId: r.pixelMapId, where: "1", to: { kind: "expr", r: "luma", g: "luma", b: "luma", a: "a" } }), /create_filter/);
      assert.equal(s.project.pixelMaps[0].where, green);
      const u = tools.updatePixelMap({ pixelMapId: r.pixelMapId, where: "smoothstep(0.4,0.9,g-r)" });
      assert.equal(u.backend, "webgl");
      assert.equal(s.project.pixelMaps[0].where, "smoothstep(0.4,0.9,g-r)");
    }
  } finally {
    await server.close();
  }
});
