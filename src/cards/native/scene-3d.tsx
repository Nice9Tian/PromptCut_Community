import type { CardDef } from "../../kernel/types";
import type { Scene3DParams } from "./scene3dObject";

/**
 * 3D scene (layer B): a 3D object drawn with three.js, transparent background, overlays with other cards.
 *
 * # Visual output is not drawn in this file after R9
 *
 * This card carries the `canvas: { kind: 'three' }` contract: `Stage` renders a `[data-pc-gl-plane]`
 * in the wrapper layer, and visuals are drawn in the GL Worker by the shared WebGL renderer
 * (`render/gl/`), returning bitmaps frame by frame. The function half is in `scene-3d.gl.ts` in the
 * same directory (how scene and camera are created, how poses are set each tick), while geometry /
 * materials / lighting / poses still come exclusively from `scene3dObject.ts`. Previously, this file
 * instantiated `THREE.WebGLRenderer` with `preserveDrawingBuffer`, one context per card; Chrome keeps
 * ~16 live contexts per page and drops the oldest when exceeded. Now the entire stage uses only that
 * single context in the Worker.
 *
 * # Determinism is the only challenge for this card
 *
 * This project exports frame by frame; exporting the same timeline twice must be byte-for-byte
 * identical (see server/bakery/). The conventional usage of three.js is
 * `renderer.setAnimationLoop(...)`: running rAF internally and accumulating over delta. **That approach
 * is wrong here**: delta accumulation means "what frame 30 looks like" depends on how long each
 * previous frame took to advance, and scrubbing the playhead back has no "rewind". Therefore, this card
 * never registers rAF. **The visual output is a pure function of t**:
 *
 *     rotation.y = t · spinY · 2π
 *
 * Given the same t, you get the exact same frame: playing forward, scrubbing back, or seeking all yield
 * identical results. (Particle card particles.tsx takes another path: it has physics accumulation and
 * must advance step by step. 3D has no physics, avoiding that trouble.)
 *
 * # The camera is identical to layer A
 *
 * Camera parameters are taken from kernel/space3d.ts, using the same formula and unit as the stage CSS
 * `perspective`. Thus "one pixel" in cards (layer A, DOM) and this card (layer B) has the same size
 * and perspective intensity, requiring no calibration when stacked. fov **follows the project by
 * default** (`params.fov = 0`, taken from `CardProps.stage.camera3dFov`, brought into Worker by `Stage`
 * via the gl plane): giving this card its own fov and relying on humans remembering to match
 * `set_camera3d` is a design doomed to mismatch. Only fill in a positive number to use a dedicated angle.
 *
 * # WebGL requires a toggle in export
 *
 * The Chrome flags for export disable GPU for determinism, which also disables WebGL completely
 * (getContext returns null without error). In server/bakery/chrome.mjs, `--enable-unsafe-swiftshader`
 * was added to enable software WebGL: the `OffscreenCanvas` context in the Worker relies on it too.
 * If that flag is removed, this card turns into an empty canvas during export.
 */

type Params = Scene3DParams;

/**
 * The card still requires a `Component` (`Stage`'s `<C>` branch and `isCardDef` both recognize it),
 * but visuals are on the gl plane, rendering nothing here.
 */
function Scene3DCard() {
  return null;
}

export const scene3dCard: CardDef<Params> = {
  id: "scene-3d",
  name: "3D object",
  description: "A spinning 3D object (cube / sphere / torus / knot / cone / cylinder / crystal) on a transparent background, can be overlaid on other cards",
  useWhen:
    "需要一个真正立体的东西当视觉锚点时用:片头的旋转标志物、讲抽象概念时的一个几何体、产品段落的陪衬。" +
    "它是**装饰**不是信息 —— 数字用 odometer、要点用清单卡,别指望这张卡说清楚什么。" +
    "透明底,通常叠在背景之上、文字之下(放到靠下的序列里)。" +
    "转速用圈/秒,0 就是不转、停在 tilt 那个角度;负数反着转。" +
    "**它和用 set_camera3d 打开的三维默认就是同一台相机**(fov 留 0 即可),所以它和摆进空间的卡片透视强度一致、叠起来不用调。只有想让它单独用一个视角时才填 fov。",
  tags: ["three-dimensional", "3D", "solid", "model", "rotation", "geometry", "canvas", "webgl"],
  source: "native",
  // Frame mode: fixed by the audit (A0.1). The value = the return value of
  // cardFrameMode(def, def.defaults) before it was fixed.
  frameMode: "stateful",
  defaults: {
    shape: "knot", color: "#8ab4ff", metal: 0.6, rough: 0.25, size: 0.55,
    spinY: 0.15, spinX: 0, tilt: -18, light: "studio", fov: 0, wire: "no", texture: "",
  },
  controls: [
    { key: "shape", label: "Shape", type: "select", options: [
      { value: "knot", label: "Knot" }, { value: "cube", label: "Cube" }, { value: "sphere", label: "Sphere" },
      { value: "torus", label: "Torus" }, { value: "cone", label: "Cone" }, { value: "cylinder", label: "Cylinder" },
      { value: "crystal", label: "Crystal" },
    ] },
    { key: "color", label: "Color", type: "color" },
    { key: "metal", label: "Metalness", type: "number", min: 0, max: 1, step: 0.05, hint: "0 = plastic/ceramic, 1 = metal. At high metalness the color comes mainly from reflections; looks best with studio lighting" },
    { key: "rough", label: "Roughness", type: "number", min: 0, max: 1, step: 0.05, hint: "0 = mirror, 1 = fully matte" },
    { key: "size", label: "Size", type: "number", min: 0.05, max: 1, step: 0.05, hint: "Fraction of the canvas height. 0.55 is about half the screen height" },
    { key: "spinY", label: "Horizontal spin speed", type: "number", min: -3, max: 3, step: 0.05, hint: "Turns/second, around the vertical axis. 0.15 is a calm slow spin; negative reverses it" },
    { key: "spinX", label: "Tumble speed", type: "number", min: -3, max: 3, step: 0.05, hint: "Turns/second, around the horizontal axis. Set both to roll diagonally" },
    { key: "tilt", label: "Initial tilt", type: "number", min: -90, max: 90, step: 1, hint: "Degrees, around the horizontal axis. When spin speed is 0, this decides the angle it rests at" },
    { key: "light", label: "Lighting", type: "select", options: [
      { value: "studio", label: "Studio (strong depth)" }, { value: "soft", label: "Soft light (flat)" }, { value: "rim", label: "Backlight (silhouette)" },
    ] },
    { key: "fov", label: "Field of view (deg)", type: "number", min: 0, max: 120, step: 1, hint: "0 = follow the project camera (default, recommended); a positive value = this card uses its own field of view, so it no longer shares a space with other cards" },
    { key: "wire", label: "Wireframe", type: "select", options: [{ value: "no", label: "entity" }, { value: "yes", label: "Wireframe" }] },
    { key: "texture", label: "Texture", type: "text", hint: "Image URL. The most direct way is to render a card to a transparent PNG with bake_card and apply it here; images from the media library also work. Leave empty = solid color" },
  ],
  parts: [{ id: "object", label: "Object", role: "media", params: ["shape", "color", "metal", "rough", "size", "spinY", "spinX", "tilt", "light", "fov", "wire", "texture"] }],
  // No entrance animation: it is in its final form as soon as mounted, and keeps spinning afterwards
  lifecycle: { after: "evolve", exit: ["fade"] },
  /*
   * R9: the `three` contract of the shared WebGL renderer. Texture URL is in the `texture` parameter
   * (usually `/@media/xxx.png` prerendered by bake_card): Worker caches the decoded bitmap and the
   * same `THREE.Texture` by URL; multiple cards using the same texture only upload once.
   */
  canvas: { kind: "three", programId: "scene-3d", textures: [{ name: "map", param: "texture" }] },
  Component: Scene3DCard,
};
