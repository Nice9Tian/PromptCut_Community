/** Three constructors used when media effect cards write `card()`. They merely assemble parameters
 * into `CardGpuValue`, doing no compilation and touching no GPU: execution runs in the host's
 * `CardGpuExecutor`.
 *
 * The reason for wrapping these three instead of letting cards write literals directly: the shape
 * of the value is a contract between the executor and cards; if a card mistypes a key, it would
 * only report "Unknown GPU value" at the WebGL layer, far from where the error occurred.
 */
import type { BitmapValue, CardGpuValue, DrawValue, Expr, GlslValue, SourceValue } from "./gpuExecutor";

/**
 * A fragment shader. `inputs` are bound in order to `u_input0`, `u_input1`..., and `uniforms`
 * are plain numbers / arrays (media effect cards run in the page, with time computed directly
 * as numbers, without symbolic expressions).
 *
 * Shaders must explicitly declare every uniform used; compilation diagnostics are passed as is
 * via frameReady into the inspect-frame results.
 */
export function glsl(
  fragment: string,
  inputs: CardGpuValue[] = [],
  uniforms: Record<string, number | number[]> = {},
): GlslValue {
  return { type: "glsl", fragment, inputs, uniforms: uniforms as Record<string, Expr | Expr[]> };
}

/** Solid color / rectangle. For simple visuals that do not need a shader. */
export function draw(commands: DrawValue["commands"]): DrawValue {
  return { type: "draw", commands };
}

/** Exit point for CPU pixel algorithms: directly uploads a precomputed bitmap as the result
 * for this layer. */
export function bitmap(image: ImageBitmap | ImageData | OffscreenCanvas): BitmapValue {
  return { type: "bitmap", image };
}

export type { CardGpuValue, SourceValue };

/** Default input queries follow the current card's source clock; the GPU executor will not
 * mistake it for trimmed local time. */
export function sourceValueAt(ref: { nodeId: string; offset?: number; rate?: number }, sourceTime: number, requestedTime?: number): SourceValue {
  return { type: "source", nodeId: ref.nodeId, offset: ref.offset ?? 0, rate: ref.rate ?? 1, time: requestedTime ?? sourceTime };
}
