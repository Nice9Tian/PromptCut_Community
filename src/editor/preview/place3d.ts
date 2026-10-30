import { frameBox, resolveFrame, type Size } from "../../kernel/layout.ts";
import { stageToWorld } from "../../kernel/space3d.ts";
import type { ClipFrame } from "../../kernel/types";

/**
 * 一张卡在 3D 视图里该摆成什么样。
 *
 * 单独抽出来是因为**这里的正负号是全项目最容易写反、又最难发现的一处**:
 * CSS 的 y 轴朝下、three 的朝上,于是
 *   - 绕 y 两边的矩阵完全相同(x' = x·cosθ + z·sinθ),**原样用**;
 *   - 绕 x 和绕 z 要**取反**;
 *   - translateZ 两边都是"正值朝观众",原样用。
 * 写反了不会报错,画面只是"看着别扭"。所以做成纯函数 + 单测:
 * 拿 kernel 那边已经和真浏览器逐位对过账的 visualBox 当基准,两边算出来的投影框必须一致。
 *
 * 变换顺序照抄 frameCss:`translateZ · rotateX · rotateY · scale · rotate`(最右先作用),
 * 所以从里到外是 roll → scale → spin → tilt → 平移。
 */
export interface Placement3D {
  /** 锚点的世界坐标(变换原点) */
  pivot: [number, number, number];
  /** 板子中心相对锚点的偏移(世界坐标) */
  meshOffset: [number, number, number];
  /** 板子尺寸(就是 frame 的框) */
  size: { width: number; height: number };
  /** 绕 x,弧度。已经取过反 */
  tiltX: number;
  /** 绕 y,弧度。和 CSS 同号 */
  spinY: number;
  /** 绕 z,弧度。已经取过反 */
  rollZ: number;
  scale: number;
  /** 沿深度平移,世界单位 = 舞台像素,正值朝观众 */
  translateZ: number;
}

const RAD = Math.PI / 180;

export function placeClip3D(frame: ClipFrame | undefined, stage: Size): Placement3D {
  const f = resolveFrame(frame, stage);
  const box = frameBox(frame, stage);
  const [ax, ay] = stageToWorld({ x: f.x, y: f.y, z: 0 }, stage);
  const cx = box.left + box.width / 2;
  const cy = box.top + box.height / 2;
  return {
    pivot: [ax, ay, 0],
    // y 取反:舞台坐标向下增长,世界坐标向上
    meshOffset: [cx - f.x, -(cy - f.y), 0],
    size: { width: box.width, height: box.height },
    tiltX: -f.rotateX * RAD,
    spinY: f.rotateY * RAD,
    rollZ: -f.rotate * RAD,
    scale: f.scale,
    translateZ: f.translateZ,
  };
}
