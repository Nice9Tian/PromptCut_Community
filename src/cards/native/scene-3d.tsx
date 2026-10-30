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
  name: "三维物件",
  description: "一个会转的立体物件(方块 / 球 / 圆环 / 纽结 / 锥 / 柱 / 晶体),透明底,可以叠在别的卡上",
  useWhen:
    "需要一个真正立体的东西当视觉锚点时用:片头的旋转标志物、讲抽象概念时的一个几何体、产品段落的陪衬。" +
    "它是**装饰**不是信息 —— 数字用 odometer、要点用清单卡,别指望这张卡说清楚什么。" +
    "透明底,通常叠在背景之上、文字之下(放到靠下的序列里)。" +
    "转速用圈/秒,0 就是不转、停在 tilt 那个角度;负数反着转。" +
    "**它和用 set_camera3d 打开的三维默认就是同一台相机**(fov 留 0 即可),所以它和摆进空间的卡片透视强度一致、叠起来不用调。只有想让它单独用一个视角时才填 fov。",
  tags: ["三维", "3D", "立体", "模型", "旋转", "几何", "canvas", "webgl"],
  source: "native",
  // 帧模式:审计固化(A0.1)。值 = 固化前 cardFrameMode(def, def.defaults) 的返回值。
  frameMode: "stateful",
  defaults: {
    shape: "knot", color: "#8ab4ff", metal: 0.6, rough: 0.25, size: 0.55,
    spinY: 0.15, spinX: 0, tilt: -18, light: "studio", fov: 0, wire: "no", texture: "",
  },
  controls: [
    { key: "shape", label: "形状", type: "select", options: [
      { value: "knot", label: "纽结" }, { value: "cube", label: "方块" }, { value: "sphere", label: "球" },
      { value: "torus", label: "圆环" }, { value: "cone", label: "锥" }, { value: "cylinder", label: "柱" },
      { value: "crystal", label: "晶体" },
    ] },
    { key: "color", label: "颜色", type: "color" },
    { key: "metal", label: "金属感", type: "number", min: 0, max: 1, step: 0.05, hint: "0 = 塑料/陶瓷,1 = 金属。金属感高时颜色主要来自反光,配 studio 打光最好看" },
    { key: "rough", label: "粗糙度", type: "number", min: 0, max: 1, step: 0.05, hint: "0 = 镜面,1 = 全哑光" },
    { key: "size", label: "大小", type: "number", min: 0.05, max: 1, step: 0.05, hint: "占画布高度的比例。0.55 大约是半屏高" },
    { key: "spinY", label: "水平转速", type: "number", min: -3, max: 3, step: 0.05, hint: "圈/秒,绕竖轴。0.15 是从容的慢转;负数反向" },
    { key: "spinX", label: "翻滚转速", type: "number", min: -3, max: 3, step: 0.05, hint: "圈/秒,绕横轴。两个都给就是斜着滚" },
    { key: "tilt", label: "初始倾斜", type: "number", min: -90, max: 90, step: 1, hint: "度,绕横轴。转速为 0 时就靠它决定停在什么角度" },
    { key: "light", label: "打光", type: "select", options: [
      { value: "studio", label: "棚拍(立体感强)" }, { value: "soft", label: "柔光(平)" }, { value: "rim", label: "逆光(剪影)" },
    ] },
    { key: "fov", label: "视角(度)", type: "number", min: 0, max: 120, step: 1, hint: "0 = 跟着项目的相机走(默认,推荐);填正数 = 这张卡单独用一个视角,和别的卡就不在同一个空间里了" },
    { key: "wire", label: "线框", type: "select", options: [{ value: "no", label: "实体" }, { value: "yes", label: "线框" }] },
    { key: "texture", label: "贴图", type: "text", hint: "图片 URL。用 bake_card 把一张卡渲染成透明底 PNG 再贴上来最直接;素材库里的图片也行。留空 = 纯色" },
  ],
  parts: [{ id: "object", label: "物件", role: "media", params: ["shape", "color", "metal", "rough", "size", "spinY", "spinX", "tilt", "light", "fov", "wire", "texture"] }],
  // 没有进场动画:它一挂载就是最终形态,之后一直转
  lifecycle: { after: "evolve", exit: ["fade"] },
  /*
   * R9:共享 WebGL 渲染器的 `three` 契约。贴图地址在 `texture` 参数里(通常是 bake_card 预渲染出来的
   * `/@media/xxx.png`):Worker 按地址缓存解码后的位图和同一个 `THREE.Texture`,几张卡贴同一张图只上传一次。
   */
  canvas: { kind: "three", programId: "scene-3d", textures: [{ name: "map", param: "texture" }] },
  Component: Scene3DCard,
};
