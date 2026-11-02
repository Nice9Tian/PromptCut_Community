import type { CardDef } from "../../kernel/types";
import type { Scene3DParams } from "./scene3dObject";

/**
 * 三维场景(B 层):three.js 画的一个立体物件,透明底,能和别的卡叠。
 *
 * # R9 之后画面不在这个文件里画
 *
 * 这张卡带 `canvas: { kind: 'three' }` 契约:`Stage` 在包裹层里渲一个 `[data-pc-gl-plane]`,
 * 画面由共享 WebGL 渲染器(`render/gl/`)在 GL Worker 里画、按帧交回位图。函数那一半在同目录的
 * `scene-3d.gl.ts`(scene 和相机怎么造、每拍怎么摆),几何 / 材质 / 灯光 / 姿势仍只有 `scene3dObject.ts`
 * 那一份。以前这里自建 `THREE.WebGLRenderer`、开 `preserveDrawingBuffer`,每张卡一个上下文,
 * Chrome 一页约 16 个活的上下文,多了就丢最早的;现在整个舞台只有 Worker 里那一个。
 *
 * # 确定性是这张卡唯一的难点
 *
 * 这个项目逐帧导出,同一个时间轴导两遍必须逐字节相同(见 server/bakery/)。
 * three.js 的常规用法是 `renderer.setAnimationLoop(...)` —— 自己跑 rAF、按 delta 累积。
 * **那条路在这里是错的**:delta 累积意味着"第 30 帧长什么样"取决于前面每一帧各推了多久,
 * 往回拖播放头也没有"倒带"。所以这张卡一次 rAF 都不注册。**画面是 t 的纯函数**:
 *
 *     rotation.y = t · spinY · 2π
 *
 * 给同一个 t 就得到同一帧,顺着播、往回拖、跳着截,结果都一样。
 * (粒子卡 particles.tsx 走的是另一条路:它有物理累积,只能一步步推。三维没有物理,不用受那个罪。)
 *
 * # 相机和 A 层是同一台
 *
 * 相机参数从 kernel/space3d.ts 取,和舞台 CSS 的 `perspective` 同一个公式、同一个单位,
 * 所以卡片(A 层,DOM)和这张卡(B 层)里的"一个像素"一样大、透视一样强,叠起来不用做任何标定。
 * fov **默认跟着项目走**(`params.fov = 0`,从 `CardProps.stage.camera3dFov` 取,由 `Stage` 经 gl 平面带进 Worker):
 * 让这张卡自带一个 fov、靠人记得填成和 `set_camera3d` 一样的数是必然会对不上的设计。想让它单独用一个视角才填正数。
 *
 * # WebGL 在导出里要一个开关
 *
 * 导出那套 Chrome 参数为了确定性关掉了 GPU,连带把 WebGL 关死(getContext 返回 null、不报错)。
 * server/bakery/chrome.mjs 里加了 `--enable-unsafe-swiftshader` 把软件 WebGL 打开 —— Worker 里的
 * `OffscreenCanvas` 上下文同样靠它。那个标志要是被谁删了,这张卡在导出里会变成一张空画布。
 */

type Params = Scene3DParams;

/**
 * 卡的 `Component` 仍然要有(`Stage` 的 `<C>` 分支、`isCardDef` 都认它),但画面在 gl 平面上,
 * 这里什么都不渲。
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
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
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
  // 没有进场动画:它一挂载就是最终形态,之后一直转
  lifecycle: { after: "evolve", exit: ["fade"] },
  /*
   * R9:共享 WebGL 渲染器的 `three` 契约。贴图地址在 `texture` 参数里(通常是 bake_card 预渲染出来的
   * `/@media/xxx.png`):Worker 按地址缓存解码后的位图和同一个 `THREE.Texture`,几张卡贴同一张图只上传一次。
   */
  canvas: { kind: "three", programId: "scene-3d", textures: [{ name: "map", param: "texture" }] },
  Component: Scene3DCard,
};
