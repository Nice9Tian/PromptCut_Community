// 像素映射工具的主动分流:整帧调色(A)拒绝并回等价 ops、逐像素(B)接单、翻译不了(C)拒绝。
// 跑法:node --test src/mcp/tools/pixelMapTools.test.mjs
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

test("像素映射工具:A 拒绝并回等价 ops、B 接单回 webgl、C 说明翻译不了哪一处", async () => {
  const server = await createServer({ configFile: false, server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const { createPixelMapTools } = await server.ssrLoadModule("/src/mcp/tools/pixelMapTools.ts");
    const toolsOf = () => { const s = fakeStore(); return { s, tools: createPixelMapTools(s) }; };

    /* --- A 整帧调色:拒绝,错误里那份 ops 能直接喂给 create_filter 而且逐像素等价 --- */
    {
      const { s, tools } = toolsOf();
      const raw = { name: "提亮", where: "1", to: { kind: "expr", r: "r^0.8", g: "g^0.8", b: "b^0.8", a: "a" } };
      let err;
      try { tools.createPixelMap(raw); } catch (e) { err = e; }
      assert.ok(err, "整帧调色应该被拒");
      assert.match(err.message, /整帧调色/);
      assert.equal(s.project.pixelMaps.length, 0, "被拒的定义不能落库");

      const tail = err.message.slice(err.message.indexOf("create_filter ") + "create_filter ".length);
      const def = normalizeFilterDef(JSON.parse(tail.slice(0, tail.indexOf("\n"))));
      assert.equal(def.name, "提亮");
      const pm = normalizePixelMapDef(raw);
      let worst = 0;
      for (let i = 0; i < 256; i++) {
        const v = i / 255;
        const ref = mapRgba(pm, [v, v, v, 1]);
        const got = applyTableOps(def.ops, [v, v, v]);
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(Math.round(ref[k] * 255) - Math.round(got[k] * 255)));
      }
      assert.ok(worst <= 1, `回包里的 ops 和原定义差了 ${worst} 级`);
    }

    /* --- B 逐像素:接单,回包带 backend --- */
    {
      const { s, tools } = toolsOf();
      const r = tools.createPixelMap({ name: "抠绿", where: green, to: "transparent", clipId: "c1" });
      assert.equal(r.ok, true);
      assert.equal(r.backend, "webgl");
      assert.equal(s.project.pixelMaps.length, 1);
      assert.equal(s.project.tracks[0].clips[0].pixelMap.id, r.pixelMapId);
      assert.equal(tools.createPixelMap({ name: "换底", where: "1-step(0.5,luma)", to: { kind: "media", mediaId: "B", stage: "origin" } }).backend, "webgl");
    }

    /* --- C 翻译不了 --- */
    {
      const { s, tools } = toolsOf();
      assert.throws(() => tools.createPixelMap({ name: "坏", where: "(r-g)^0.5", to: "transparent" }), /翻译不成着色器[\s\S]*pow 在底数为负时无定义/);
      assert.equal(s.project.pixelMaps.length, 0);
    }

    /* --- update 也过同一道闸,拒了库里那条不变 --- */
    {
      const { s, tools } = toolsOf();
      const r = tools.createPixelMap({ name: "抠绿", where: green, to: "transparent" });
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
