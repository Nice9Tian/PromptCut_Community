/**
 * `scene-3d` 那个立体物件到底长什么样 —— **唯一的一份构造**。
 *
 * 两个地方要造同一个东西:
 *   1. 卡片本身(`scene-3d.tsx`),画在自己的 canvas 上,进预览和导出;
 *   2. 3D 检视视图(`src/editor/preview/Scene3DView.tsx`),把它当**真的立体物件**摆进场景里。
 *
 * 第二处一开始是拿一张预渲染出来的贴图糊在平板上的 —— 那是错的:绕着转它还是一张画,
 * 而这个视图存在的理由就是"看清楚东西在空间里是怎么摆的"。三维的东西在三维视图里就得是三维的。
 *
 * 所以几何、材质、灯光、姿势全部收在这里,两边都从这儿取。分开写的话两边迟早长得不一样,
 * 而且不会报错 —— 只是"检视里看到的和成片里的不是一个东西",那比没有检视更糟。
 */

export type ThreeMod = typeof import("three");

export const SHAPES = ["cube", "sphere", "torus", "knot", "cone", "cylinder", "crystal"] as const;
export type Shape = (typeof SHAPES)[number];

export interface Scene3DParams {
  shape: string;
  color: string;
  metal: number;
  rough: number;
  size: number;
  spinY: number;
  spinX: number;
  tilt: number;
  light: string;
  fov: number;
  wire: string;
  texture: string;
}

const TAU = Math.PI * 2;

/** 参数里的 shape 不认识就退回方块,别让一个拼错的词把整张卡搞黑 */
export function shapeOf(raw: string): Shape {
  return (SHAPES as readonly string[]).includes(raw) ? (raw as Shape) : "cube";
}

/**
 * 物件的"半径",单位是世界单位(= 舞台像素)。
 * `size` 是占画布高度的比例,所以半径 = size × 高 / 2 —— 卡片和检视视图必须用同一个式子,
 * 否则同一张卡在两处大小不一样。
 */
export function radiusFor(params: Scene3DParams, canvasHeight: number): number {
  return (Math.min(Math.max(params.size, 0.05), 1) * canvasHeight) / 2;
}

/** 每种形状的几何体。`r` 见 radiusFor */
export function geometryOf(THREE: ThreeMod, shape: Shape, r: number) {
  switch (shape) {
    case "sphere":
      return new THREE.SphereGeometry(r, 64, 48);
    case "torus":
      return new THREE.TorusGeometry(r * 0.72, r * 0.28, 32, 96);
    case "knot":
      return new THREE.TorusKnotGeometry(r * 0.68, r * 0.22, 160, 32);
    case "cone":
      return new THREE.ConeGeometry(r, r * 1.8, 64);
    case "cylinder":
      return new THREE.CylinderGeometry(r * 0.72, r * 0.72, r * 1.6, 64);
    case "crystal":
      return new THREE.IcosahedronGeometry(r, 0);
    case "cube":
    default:
      return new THREE.BoxGeometry(r * 1.5, r * 1.5, r * 1.5);
  }
}

export function materialOf(THREE: ThreeMod, params: Scene3DParams) {
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(params.color),
    metalness: Math.min(Math.max(params.metal, 0), 1),
    roughness: Math.min(Math.max(params.rough, 0), 1),
    wireframe: params.wire === "yes",
  });
}

/**
 * 灯光预设。三档都是"环境光 + 主光 + 补光"的老套路,区别只在强弱和方向 ——
 * 让 Agent 挑一个词,比让它填三个光源的位置靠谱得多。
 *
 * 光加到 `target` 上(卡片里是整个 scene,检视视图里是这个物件自己的 group)。
 * 加到 group 上的好处是灯跟着物件走:检视视图里同屏可能有好几个 scene-3d,
 * 各自带各自的灯,每一个才和它在成片里的样子对得上。
 */
export function addLights(THREE: ThreeMod, target: any, preset: string, d: number) {
  const key = new THREE.DirectionalLight(0xffffff, 1);
  const fill = new THREE.DirectionalLight(0xffffff, 1);
  let ambient = 0.5;
  if (preset === "rim") {
    // 逆光:主光从后上方压过来,只留一条亮边,适合剪影感
    ambient = 0.18;
    key.position.set(-0.4, 0.9, -1).multiplyScalar(d);
    key.intensity = 3.2;
    fill.position.set(0.6, -0.2, 0.8).multiplyScalar(d);
    fill.intensity = 0.35;
  } else if (preset === "soft") {
    // 柔光:大环境光 + 弱方向光,几乎没有硬阴影
    ambient = 1.1;
    key.position.set(0.5, 0.8, 1).multiplyScalar(d);
    key.intensity = 0.9;
    fill.position.set(-0.7, 0.1, 0.5).multiplyScalar(d);
    fill.intensity = 0.5;
  } else {
    // studio:标准三点光的前两点,金属质感最出彩
    ambient = 0.45;
    key.position.set(0.7, 1, 0.8).multiplyScalar(d);
    key.intensity = 2.4;
    fill.position.set(-0.9, -0.2, 0.6).multiplyScalar(d);
    fill.intensity = 0.8;
  }
  const amb = new THREE.AmbientLight(0xffffff, ambient);
  target.add(amb, key, fill);
  return [amb, key, fill];
}

/**
 * 姿势只由 t 和几个参数决定 —— 这是「画面是 t 的纯函数」的全部实现。
 * 没有 delta 累积,所以顺着播、往回拖、跳着截都是同一帧(理由见 scene-3d.tsx 开头)。
 * `t` 是**相对这张卡起点**的秒数。
 */
export function poseMesh(mesh: any, params: Scene3DParams, t: number) {
  mesh.rotation.set(
    (params.tilt * Math.PI) / 180 + t * params.spinX * TAU,
    t * params.spinY * TAU,
    0,
  );
}

/**
 * 贴图。URL 通常是 `bake_card` 预渲染出来的 `/@media/xxx.png`。
 * 加载是异步的,拿到之后要调 `onReady` 让调用方重画一帧 —— 那时 t 不一定变,
 * 不能指望渲染循环自己跟上。
 */
export function applyTexture(
  THREE: ThreeMod,
  material: any,
  url: string,
  onReady: (tex: any) => void,
  onError?: (error: unknown) => void,
): any {
  return new THREE.TextureLoader().load(
    url,
    (tex: any) => {
      // 颜色空间要标对,否则贴上去整体偏暗(three 默认按线性解释)
      tex.colorSpace = THREE.SRGBColorSpace;
      material.map = tex;
      // 预渲染出来的卡是透明底,不开 transparent 的话四周会变成黑块
      material.transparent = true;
      material.needsUpdate = true;
      onReady(tex);
    },
    undefined,
    error => { console.warn("[scene-3d] 纹理加载失败:", url); onError?.(error); },
  );
}
