/**
 * 图卡产出的 GPU 描述的**类型**。只有类型,没有一行运行时代码 ——
 * 执行它们的 WebGL 执行器在 src/render/cards/gpuExecutor.ts,那是渲染层的事。
 *
 * 分出这个文件是为了拆掉一条反向边:CardDef(kernel/types.ts)的 `card()` 要声明
 * 自己返回什么,以前写的是 `import('../render/cards/gpuExecutor').CardGpuValue`,
 * 于是 kernel 在类型上依赖 render。现在反过来 —— gpuExecutor 从这里 import 类型
 * 再原样 re-export,老的 `from "./gpuExecutor"` 一个都不用改。
 */

/** Explicit GPU descriptions. No Python or string-expression compilation occurs here. */
export type Expr = number | { type: "expr"; op: "time" | "add" | "sub" | "mul" | "div" | "neg" | "sin" | "cos" | "min" | "max"; args?: Expr[] };
export type SourceValue = { type: "source"; nodeId: string; time?: Expr; offset?: number; rate?: number };
export type PixelsValue = { type: "pixels"; url?: string; width: number; height: number };
export type DrawValue = { type: "draw"; commands: Array<{ type: "solid" | "rect"; color: [number, number, number, number]; x?: number; y?: number; width?: number; height?: number }> };
export type GlslValue = { type: "glsl"; fragment: string; inputs?: CardGpuValue[]; uniforms?: Record<string, Expr | Expr[]> };
/** 已经算好的一张位图(CPU 像素算法的出口)。宿主直接上传,不再解析任何输入。 */
export type BitmapValue = { type: "bitmap"; image: ImageBitmap | ImageData | OffscreenCanvas };
export type CardGpuValue = SourceValue | PixelsValue | DrawValue | GlslValue | BitmapValue;
export type ValueResolver = (value: SourceValue | PixelsValue, time: number, signal?: AbortSignal) => Promise<TexImageSource | null>;
