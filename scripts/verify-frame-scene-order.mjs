/**
 * Browser integration acceptance for mixed same-track FrameScene layers.
 * It deliberately uses the real prerender Vite server, the real card registry and
 * beginFrame capture rather than a DOM/unit-test stand-in. Evidence lives under
 * work/frame-scene-order and is safe to keep between runs.
 *
 * 仓库里没有「注册」函数，素材效果卡只能是文件：脚本先把那张不透明红色素材效果卡写成临时文件
 * `src/cards/user/__probe-opaque-red.tsx`（**写在 createServer 之前**，别和 vite 的
 * 文件发现抢时间），再用 `server.ssrLoadModule` 加载、包成 `getCard` 传给
 * `applyCardDefinition`（`ssrLoadModule` 回的是模块命名空间，不是函数）。跑完删掉。
 */
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { PNG } from "pngjs";
import { createServer } from "vite";
import { openBakery, bakeFrames } from "../server/bakery/index.mjs";
import { applyCardDefinition } from "../src/kernel/cardAuthoring.mjs";

const CARD_ID = "__probe-opaque-red";
const root = process.cwd();
const cardFile = path.join(root, "src", "cards", "user", `${CARD_ID}.tsx`);
const CARD_SOURCE = `import type { CardDef } from "../../kernel/types";
import { glsl } from "../../render/cards/graphValues";

/** 验证脚本的临时卡:整幅不透明红(225,20,30),用来看层序是按 tr.clips 走的。 */
export const opaqueRed: CardDef<Record<string, never>> = {
  id: "${CARD_ID}",
  name: "不透明红",
  description: "整幅不透明红色的素材效果卡,只给 verify-frame-scene-order 用",
  source: "user",
  kind: "animation",
  frameMode: "direct",
  defaults: {},
  controls: [],
  card: () => glsl("void main(){outColor=vec4(225./255.,20./255.,30./255.,1.);}"),
};
`;

fsSync.mkdirSync(path.dirname(cardFile), { recursive: true });
fsSync.writeFileSync(cardFile, CARD_SOURCE);

process.env.PROMPTCUT_ROLE = "prerender";
// 端口可以用 PC_VERIFY_PORT 换掉:同一台机器上并行跑几个验证脚本时别互相抢
const port = Number(process.env.PC_VERIFY_PORT) || 5203, origin = `http://127.0.0.1:${port}`;
const output = path.join(root, "work", "frame-scene-order");
await fs.mkdir(output, { recursive: true });
const base = { id: "frame-scene-order", name: "frame scene order", width: 640, height: 360, fps: 10, duration: 2,
  themeId: "default", media: [], style: {}, tracks: [{ id: "main", name: "main", clips: [] }] };
const timelineUrl = (project) => `${origin}/?export=1&timeline=${encodeURIComponent(`data:application/json,${encodeURIComponent(JSON.stringify(project))}`)}`;
const native = { id: "native", cardId: "punch-pill", start: 0, end: 2, params: { text: "NATIVE", position: "center" } };
const center = (bytes) => { const p = PNG.sync.read(bytes), n = (Math.floor(p.height / 2) * p.width + Math.floor(p.width / 2)) * 4; return [...p.data.subarray(n, n + 4)]; };
const same = (rgba, expected) => rgba.every((value, index) => Math.abs(value - expected[index]) <= 2);
const solidPng = (color) => {
  const png = new PNG({ width: 640, height: 360 });
  for (let i = 0; i < png.data.length; i += 4) png.data.set(color, i);
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
};
const red = [225, 20, 30, 255], blue = [15, 70, 235, 255];
const server = await createServer({ configFile: path.join(root, "vite.prerender.config.ts"), server: { host: "127.0.0.1", port, strictPort: true } });
let bakery;
try {
  await server.listen();
  const mod = await server.ssrLoadModule(`/src/cards/user/${CARD_ID}.tsx`);
  // ssrLoadModule 回的是模块命名空间,不是函数 —— 取出里面那个 CardDef 再包成 getCard
  const definition = Object.values(mod).find((value) => value && typeof value === "object" && value.id === CARD_ID);
  assert.ok(definition, `临时素材效果卡没有导出 id 为 ${CARD_ID} 的 CardDef`);
  const getCard = (id) => (id === definition.id ? definition : undefined);
  const makeGraph = (id, frame = undefined) =>
    applyCardDefinition(base, { cardId: CARD_ID, trackId: "main", start: 0, end: 2, newClipId: id, nodeId: `${id}-node`, ...(frame ? { frame } : {}) }, getCard).project;

  bakery = await openBakery({ url: timelineUrl(base) });
  const capture = async (name, project) => {
    await bakery.reset(project, timelineUrl(project), { deferCards: true });
    let bytes;
    await bakeFrames(bakery, { out: output, targetFrames: [10], fullFrame: true, writeFrames: false, onFrame: (_frame, png) => { bytes = png; } });
    assert.ok(bytes, `${name}: capture returned no PNG`);
    await fs.writeFile(path.join(output, `${name}.png`), bytes);
    return bytes;
  };

  // 素材效果卡片段排在 DOM 卡之前时必须待在它下面。反过来必须是不透明的红 ——
  // 层序来自 tr.clips,不是「素材效果卡一律排在 Stage 前面」那种固定桶。
  const graphFirst = makeGraph("graph-first");
  graphFirst.tracks[0].clips.push(native);
  const first = center(await capture("graph-before-native", graphFirst));
  assert.ok(!same(first, red), `native card was not above prior 素材效果卡 clip: ${first}`);
  const graphLast = makeGraph("graph-last");
  graphLast.tracks[0].clips.unshift(native);
  const last = center(await capture("native-before-graph", graphLast));
  assert.ok(same(last, red), `素材效果卡 clip was not above prior native card: ${last}`);

  // Cached controls are a full-stage image. Verify both ordering directions;
  // an opaque cache after native must cover it, while one before native must not.
  const cachedLast = { ...base, _cardRender: { frames: { cache: { 10: solidPng(blue) } } }, tracks: [{ ...base.tracks[0], clips: [native, { id: "cache", cardId: "caption-track", start: 0, end: 2, params: {} }] }] };
  const cacheOnTop = center(await capture("native-before-cache", cachedLast));
  assert.ok(same(cacheOnTop, blue), `cached full-stage PNG was not above native: ${cacheOnTop}`);
  const cachedFirst = { ...cachedLast, tracks: [{ ...base.tracks[0], clips: [{ id: "cache", cardId: "caption-track", start: 0, end: 2, params: {} }, native] }] };
  const cacheBelow = center(await capture("cache-before-native", cachedFirst));
  assert.ok(!same(cacheBelow, blue), `native card was not above earlier cache: ${cacheBelow}`);

  /*
   * 三维素材效果卡的透视挂在**包裹层的父元素**上,不在包裹层自己身上:`Stage` 把 perspective
   * 写在 `AnimClock` 那一层(`Stage.tsx` 的 `<AnimClock style={{ perspective }}>`),
   * `[data-pc-clip]` 是它的孩子。perspective 不继承,所以量包裹层自己恒为 "none"。
   */
  const threeD = makeGraph("graph-3d", { x: 320, y: 180, w: 260, h: 160, anchor: [0.5, 0.5], rotateY: 35 });
  threeD.camera3dFov = 40;
  await capture("graph-3d", threeD);
  const perspective = await bakery.page.evaluate(() => {
    const wrapper = document.querySelector("[data-pc-clip='graph-3d']");
    if (!wrapper) return "missing";
    return { own: getComputedStyle(wrapper).perspective, parent: getComputedStyle(wrapper.parentElement).perspective };
  });
  assert.notEqual(perspective, "missing", "3-D 素材效果卡片段没有出现在舞台上");
  assert.notEqual(perspective.parent, "none", "素材效果卡 3-D parent did not receive CSS perspective");
  const evidence = { frame: 10, graphBeforeNative: first, nativeBeforeGraph: last, nativeBeforeCache: cacheOnTop, cacheBeforeNative: cacheBelow, graph3dPerspective: perspective };
  await fs.writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log("PASS FrameScene mixed ordering", JSON.stringify(evidence));
} finally {
  await bakery?.close();
  await server.close();
  fsSync.rmSync(cardFile, { force: true });
}
