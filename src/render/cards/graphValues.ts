/** 素材效果卡写 `card()` 时用的三个构造器。它们只是把参数拼成 `CardGpuValue`,
 * 不做任何编译、也不碰 GPU —— 执行在宿主的 `CardGpuExecutor` 里。
 *
 * 之所以给这三个包一层而不是让卡片自己写字面量:值的形状是执行器和卡片之间的契约,
 * 卡片写错一个键只会在 WebGL 那一层报「Unknown GPU value」,离出错的地方已经很远了。
 */
import type { BitmapValue, CardGpuValue, DrawValue, Expr, GlslValue, SourceValue } from "./gpuExecutor";

/**
 * 一段片元着色器。`inputs` 按顺序绑到 `u_input0`、`u_input1`…,
 * `uniforms` 是普通数字 / 数组(素材效果卡在页面里跑,时间直接算成数字,不写符号表达式)。
 *
 * 着色器必须显式声明用到的每个 uniform;编译诊断会经 frameReady 原样传到看帧结果里。
 */
export function glsl(
  fragment: string,
  inputs: CardGpuValue[] = [],
  uniforms: Record<string, number | number[]> = {},
): GlslValue {
  return { type: "glsl", fragment, inputs, uniforms: uniforms as Record<string, Expr | Expr[]> };
}

/** 纯色 / 矩形。给不需要着色器的简单画面用。 */
export function draw(commands: DrawValue["commands"]): DrawValue {
  return { type: "draw", commands };
}

/** CPU 像素算法的出口:把一张已经算好的位图直接上传成这一层的结果。 */
export function bitmap(image: ImageBitmap | ImageData | OffscreenCanvas): BitmapValue {
  return { type: "bitmap", image };
}

export type { CardGpuValue, SourceValue };

/** 默认输入查询沿当前卡片源时钟走，GPU 执行器不会把它误当作裁切后的局部时间。 */
export function sourceValueAt(ref: { nodeId: string; offset?: number; rate?: number }, sourceTime: number, requestedTime?: number): SourceValue {
  return { type: "source", nodeId: ref.nodeId, offset: ref.offset ?? 0, rate: ref.rate ?? 1, time: requestedTime ?? sourceTime };
}
