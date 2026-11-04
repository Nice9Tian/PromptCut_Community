/**
 * Browser integration acceptance for mixed same-track FrameScene layers.
 * It deliberately uses the real prerender Vite server, the real card registry and
 * beginFrame capture rather than a DOM/unit-test stand-in. Evidence lives under
 * work/frame-scene-order and is safe to keep between runs.
 *
 * There is no "register" function in the repository, so media effect cards can only be files: the
 * script first writes that opaque red media effect card to a temporary file
 * `src/cards/user/__probe-opaque-red.tsx` (**written before createServer** to avoid racing vite's
 * file discovery), then loads it with `server.ssrLoadModule`, wraps it into `getCard`, and passes it
 * to `applyCardDefinition` (`ssrLoadModule` returns a module namespace, not a function). Deleted
 * after the run.
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

/** Temporary card for the verify script: a fully opaque red (225,20,30), to check that layer order follows tr.clips. */
export const opaqueRed: CardDef<Record<string, never>> = {
  id: "${CARD_ID}",
  name: "Opaque red",
  description: "A media effect card that is fully opaque red, used only by verify-frame-scene-order",
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
// Port can be overridden with PC_VERIFY_PORT: avoid collisions when running multiple verification
// scripts in parallel on the same machine
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
  // ssrLoadModule returns a module namespace, not a function: extract CardDef inside and wrap it as getCard
  const definition = Object.values(mod).find((value) => value && typeof value === "object" && value.id === CARD_ID);
  assert.ok(definition, `The temporary media effect card does not export a CardDef with id ${CARD_ID}`);
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

  // A media effect card clip must stay below a DOM card when ordered before it. In reverse, it must
  // be opaque red: layer order comes from tr.clips, not a fixed bucket like "media effect cards are
  // always ordered in front of Stage".
  const graphFirst = makeGraph("graph-first");
  graphFirst.tracks[0].clips.push(native);
  const first = center(await capture("graph-before-native", graphFirst));
  assert.ok(!same(first, red), `native card was not above prior media effect card clip: ${first}`);
  const graphLast = makeGraph("graph-last");
  graphLast.tracks[0].clips.unshift(native);
  const last = center(await capture("native-before-graph", graphLast));
  assert.ok(same(last, red), `media effect card clip was not above prior native card: ${last}`);

  // Cached controls are a full-stage image. Verify both ordering directions;
  // an opaque cache after native must cover it, while one before native must not.
  const cachedLast = { ...base, _cardRender: { frames: { cache: { 10: solidPng(blue) } } }, tracks: [{ ...base.tracks[0], clips: [native, { id: "cache", cardId: "caption-track", start: 0, end: 2, params: {} }] }] };
  const cacheOnTop = center(await capture("native-before-cache", cachedLast));
  assert.ok(same(cacheOnTop, blue), `cached full-stage PNG was not above native: ${cacheOnTop}`);
  const cachedFirst = { ...cachedLast, tracks: [{ ...base.tracks[0], clips: [{ id: "cache", cardId: "caption-track", start: 0, end: 2, params: {} }, native] }] };
  const cacheBelow = center(await capture("cache-before-native", cachedFirst));
  assert.ok(!same(cacheBelow, blue), `native card was not above earlier cache: ${cacheBelow}`);

  /*
   * Perspective of 3D media effect cards is attached to the **parent element of the wrapper layer**,
   * not on the wrapper layer itself: `Stage` writes perspective at the `AnimClock` layer
   * (`<AnimClock style={{ perspective }}>` in `Stage.tsx`), and `[data-pc-clip]` is its child.
   * perspective is not inherited, so measuring the wrapper layer itself always yields "none".
   */
  const threeD = makeGraph("graph-3d", { x: 320, y: 180, w: 260, h: 160, anchor: [0.5, 0.5], rotateY: 35 });
  threeD.camera3dFov = 40;
  await capture("graph-3d", threeD);
  const perspective = await bakery.page.evaluate(() => {
    const wrapper = document.querySelector("[data-pc-clip='graph-3d']");
    if (!wrapper) return "missing";
    return { own: getComputedStyle(wrapper).perspective, parent: getComputedStyle(wrapper.parentElement).perspective };
  });
  assert.notEqual(perspective, "missing", "3-D media effect card clip did not appear on the stage");
  assert.notEqual(perspective.parent, "none", "media effect card 3-D parent did not receive CSS perspective");
  const evidence = { frame: 10, graphBeforeNative: first, nativeBeforeGraph: last, nativeBeforeCache: cacheOnTop, cacheBeforeNative: cacheBelow, graph3dPerspective: perspective };
  await fs.writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log("PASS FrameScene mixed ordering", JSON.stringify(evidence));
} finally {
  await bakery?.close();
  await server.close();
  fsSync.rmSync(cardFile, { force: true });
}
