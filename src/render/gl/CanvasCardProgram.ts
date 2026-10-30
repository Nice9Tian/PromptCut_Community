/**
 * canvas 卡的共享 WebGL 渲染器(R9)—— 契约与消息的类型。
 *
 * # 为什么拆两半(M1)
 *
 * Worker 是独立的 JS 运行环境,`postMessage` 传不了函数。所以契约拆开:
 *   - **可序列化的一半**是 `CardDef.canvas`(下面的 `CanvasContract`),主线程读它决定
 *     `Stage` 要不要多渲一个 `[data-pc-gl-plane]` 兄弟平面、`beat` 里带哪些卡;
 *   - **函数的一半**放在卡文件同目录的 `<id>.gl.ts`,导出 `program`(下面的 `CanvasCardProgram`),
 *     **不 import React、不碰 DOM**。注册表是 `programs.ts`,Worker 和主线程退路 import 同一张。
 *
 * 三种进 Worker 的形状(`gl` / `three` / `2d`)共用一条规矩:**只收 `t`(本地秒)、params 和 `reset`**,
 * 不读 rAF / `performance.now` / `Date.now` —— Worker 里没有舞台的虚拟时钟,时间只能由主线程给。
 * 第四种 `dom2d` 不带函数、不进 Worker(粒子卡):卡的 `Component` 自己在 effect 里按 `t` 画。
 *
 * `CardDef` 的字段用接口合并挂上(见文件末尾):`CardDef` 在 `kernel/types.ts`,这一步不动那个文件。
 */

import type * as ThreeNs from "three";

/** 纹理从哪来。`mediaId` 走项目素材(只用小尺寸的素材取 `tiers.small`),`url` 是写死的地址,`param` 是「地址在这个参数里」 */
export interface CanvasTextureSpec {
  name: string;
  mediaId?: string;
  url?: string;
  /** 地址取自这个参数的值(空串 = 这张纹理不用)。`scene-3d` 的 `texture` 参数就是这种 */
  param?: string;
}

/** `CardDef.canvas`:可序列化的那一半(M1)。有这个字段的卡就是 canvas 卡 */
export interface CanvasContract {
  kind: "gl" | "three" | "2d" | "dom2d";
  /** `programs.ts` 里的键;缺省 = 卡 id */
  programId?: string;
  textures?: CanvasTextureSpec[];
  /** M6 的声明位:纯片元卡将来可以合并成 uber-shader。本任务不实现,只留位置 */
  fragmentOnly?: boolean;
}

/** `build` / `draw` 的第三个参数里,除了纹理还有画布尺寸和舞台信息(相机要用) */
export interface CanvasProgramContext {
  /** 画布像素宽高(= 片段实体框) */
  width: number;
  height: number;
  /** 舞台画幅与三维相机的 fov(`CardProps.stage` 同一份) */
  stage: { width: number; height: number; camera3dFov?: number };
}

/** `gl`:一段着色器 + 每拍的 uniform */
export interface GlProgram {
  kind: "gl";
  vertex: string;
  fragment: string;
  uniforms(t: number, params: Record<string, unknown>): Record<string, number | number[]>;
  /** 缺省 `quad`:铺满区域的一个三角形条,顶点属性 `aPos`(−1..1) */
  geometry?: "quad" | { vertices: number[]; indices?: number[] };
  extensions?: string[];
}

export interface ThreeBuilt {
  scene: ThreeNs.Scene;
  camera: ThreeNs.Camera;
  update(t: number, opts: { reset: boolean }): void;
  dispose?(): void;
}

/** `three`:渲染器由共享上下文建一次,各卡的 scene 各画各的、画进图集自己的区域 */
export interface ThreeProgram {
  kind: "three";
  build(THREE: typeof ThreeNs, params: Record<string, any>, ctx: CanvasProgramContext & { textures: Record<string, ThreeNs.Texture> }): ThreeBuilt;
}

/** `2d`:同一个 Worker 里各自的 `OffscreenCanvas` 2D 上下文(不占 WebGL 上下文) */
export interface TwoDProgram {
  kind: "2d";
  draw(ctx: OffscreenCanvasRenderingContext2D, t: number, params: Record<string, any>, opts: CanvasProgramContext & { images: Record<string, ImageBitmap>; reset: boolean }): void;
}

export type CanvasCardProgram = GlProgram | ThreeProgram | TwoDProgram;

/* ------------------------------------------------------------------ 消息 */

/** 一张卡在这一份布局里的样子(`layout` 消息的一行) */
export interface GlLayoutCard {
  clipId: string;
  programId: string;
  kind: "gl" | "three" | "2d";
  w: number;
  h: number;
  /** 已按参数 / 素材解析好的**绝对**地址(Worker 按它缓存解码后的位图) */
  textures: Array<{ name: string; url: string }>;
  stage: CanvasProgramContext["stage"];
}

/** `beat` 里的一张卡(M3):`t` 一律是本地秒;`params` 只在变了时带 */
export interface GlBeatCard {
  clipId: string;
  t: number;
  params?: Record<string, unknown>;
  reset?: boolean;
}

export type GlToWorker =
  /** 路线 1 / 主线程退路:探能力、建上下文 */
  | { type: "init"; compact: boolean }
  /** 路线 2:父页把一个舞台的端口交给 Worker */
  | { type: "connect"; stageId: string; port: MessagePort }
  | { type: "layout"; stageId: string; cards: GlLayoutCard[] }
  | {
    type: "beat"; stageId: string; seq: number; t: number; cards: GlBeatCard[];
    /** 等编译 / 纹理就绪再画(导出、探针、生成快照);缺省 = 没好的卡这一拍留空 */
    strict?: boolean;
    /** 顺带量每张卡的 GPU 时间(M4) */
    measure?: boolean;
    /** 验收用:Worker 故意睡这么久再回 `done`(K4「慢帧就等」的验收) */
    debugSleepMs?: number;
  }
  | { type: "release"; stageId: string }
  /** 探针用:报诊断 */
  | { type: "diag"; stageId: string; seq: number };

export type GlFromWorker =
  | { type: "ready"; ok: boolean; error?: string; renderer?: string; samples?: number }
  | { type: "regions"; stageId: string; pages: Array<{ w: number; h: number }>; regions: Record<string, { page: number; x: number; y: number; w: number; h: number }> }
  | {
    type: "done"; stageId: string; seq: number; t: number;
    bitmaps: Map<string, ImageBitmap>;
    /** 这一拍每张卡的 GPU 时间(毫秒;`measure` 时才有) */
    gpuMs?: Record<string, number>;
    /** 这一拍没画出来的卡(编译 / 纹理还没好)和原因 */
    skipped?: Record<string, string>;
    error?: string;
  }
  | { type: "diag"; stageId: string; seq: number; diag: GlWorkerDiag };

export interface GlWorkerDiag {
  /** 这个 Worker 里活着的 WebGL 上下文数(验收:恰好一个) */
  contexts: number;
  stages: string[];
  programs: number;
  /** 纹理缓存里的位图 / GL 纹理 / THREE.Texture 数与累计上传次数 */
  bitmaps: number;
  glTextures: number;
  threeTextures: number;
  uploads: number;
  atlas: Record<string, Array<{ w: number; h: number }>>;
  contextLost: number;
  renderer: string;
}

/* ------------------------------------------------------------------ CardDef.canvas */

declare module "../../kernel/types" {
  interface CardDef<P = Record<string, unknown>> {
    /**
     * canvas 卡的可序列化契约(R9 M1)。**不用顶层 `kind`**:那个名字被素材效果卡的类别占了。
     * 有这个字段的卡就是 canvas 卡:`Stage` 在包裹层里多渲一个 `[data-pc-gl-plane]`(`dom2d` 除外),
     * 卡的 `Component` 不再自己渲 `<canvas>`;函数的那一半在同目录的 `<id>.gl.ts`。
     */
    canvas?: CanvasContract;
  }
}
