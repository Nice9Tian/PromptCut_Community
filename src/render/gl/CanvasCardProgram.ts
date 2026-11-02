/**
 * Shared WebGL renderer for canvas cards (R9): Types for contracts and messages.
 *
 * # Why split into two halves (M1)
 *
 * Worker is an isolated JS runtime environment; `postMessage` cannot transfer functions.
 * So the contract is split:
 *   - **The serializable half** is `CardDef.canvas` (`CanvasContract` below); the main thread
 *     reads it to determine whether `Stage` needs to render an extra `[data-pc-gl-plane]` sibling
 *     plane and which cards to include in `beat`;
 *   - **The function half** is located in `<id>.gl.ts` in the same directory as the card file,
 *     exporting `program` (`CanvasCardProgram` below), **without importing React or touching the
 *     DOM**. The registry is `programs.ts`; Worker and the main thread fallback import the same copy.
 *
 * The three shapes entering Worker (`gl` / `three` / `2d`) share one rule: **accept only `t` (local
 * seconds), params, and `reset`**, and never read rAF / `performance.now` / `Date.now`: Worker has
 * no stage virtual clock, so time can only be provided by the main thread. The fourth shape `dom2d`
 * has no functions and does not enter Worker (particle cards): the card's `Component` draws by `t`
 * in an effect itself.
 *
 * `CardDef` fields are attached via interface merging (see end of file): `CardDef` lives in
 * `kernel/types.ts`, and this step leaves that file untouched.
 */

import type * as ThreeNs from "three";

/** Where texture comes from: `mediaId` uses project assets (`tiers.small` for small-size only), `url` is fixed, `param` means "URL in this param" */
export interface CanvasTextureSpec {
  name: string;
  mediaId?: string;
  url?: string;
  /** URL from value of this param (empty string = texture unused). `texture` param of `scene-3d` is this kind */
  param?: string;
}

/** `CardDef.canvas`: The serializable half (M1). Cards with this field are canvas cards */
export interface CanvasContract {
  kind: "gl" | "three" | "2d" | "dom2d";
  /** Key in `programs.ts`; default = card id */
  programId?: string;
  textures?: CanvasTextureSpec[];
  /** M6 declaration flag: Pure fragment cards can merge into uber-shader in the future. Reserved only */
  fragmentOnly?: boolean;
}

/** In third parameter of `build` / `draw`, includes canvas size and stage info (used by camera) besides textures */
export interface CanvasProgramContext {
  /** Canvas pixel width and height (= clip entity box) */
  width: number;
  height: number;
  /** Stage aspect ratio and 3D camera fov (same copy as `CardProps.stage`) */
  stage: { width: number; height: number; camera3dFov?: number };
}

/** `gl`: A shader snippet + uniforms per tick */
export interface GlProgram {
  kind: "gl";
  vertex: string;
  fragment: string;
  uniforms(t: number, params: Record<string, unknown>): Record<string, number | number[]>;
  /** Default `quad`: a triangle strip filling the region, vertex attribute `aPos`(-1..1) */
  geometry?: "quad" | { vertices: number[]; indices?: number[] };
  extensions?: string[];
}

export interface ThreeBuilt {
  scene: ThreeNs.Scene;
  camera: ThreeNs.Camera;
  update(t: number, opts: { reset: boolean }): void;
  dispose?(): void;
}

/** `three`: renderer is created once from the shared context; each card's scene renders independently into its own region of the atlas */
export interface ThreeProgram {
  kind: "three";
  build(THREE: typeof ThreeNs, params: Record<string, any>, ctx: CanvasProgramContext & { textures: Record<string, ThreeNs.Texture> }): ThreeBuilt;
}

/** `2d`: respective `OffscreenCanvas` 2D contexts in the same Worker (does not occupy WebGL context) */
export interface TwoDProgram {
  kind: "2d";
  draw(ctx: OffscreenCanvasRenderingContext2D, t: number, params: Record<string, any>, opts: CanvasProgramContext & { images: Record<string, ImageBitmap>; reset: boolean }): void;
}

export type CanvasCardProgram = GlProgram | ThreeProgram | TwoDProgram;

/* ------------------------------------------------------------------ Messages */

/** Appearance of a card in this layout (one row of the `layout` message) */
export interface GlLayoutCard {
  clipId: string;
  programId: string;
  kind: "gl" | "three" | "2d";
  w: number;
  h: number;
  /** Resolved **absolute** address based on parameters / assets (Worker caches decoded bitmaps by it) */
  textures: Array<{ name: string; url: string }>;
  stage: CanvasProgramContext["stage"];
}

/** A card in `beat` (M3): `t` is always local seconds; `params` is only included when changed */
export interface GlBeatCard {
  clipId: string;
  t: number;
  params?: Record<string, unknown>;
  reset?: boolean;
}

export type GlToWorker =
  /** Route 1 / main thread fallback: probe capabilities, create context */
  | { type: "init"; compact: boolean }
  /** Route 2: parent page hands over a stage port to the Worker */
  | { type: "connect"; stageId: string; port: MessagePort }
  | { type: "layout"; stageId: string; cards: GlLayoutCard[] }
  | {
    type: "beat"; stageId: string; seq: number; t: number; cards: GlBeatCard[];
    /** Wait for compilation / textures to be ready before rendering (export, probe, generate snapshots); default = leave unready cards blank for this tick */
    strict?: boolean;
    /** Also measure GPU time for each card (M4) */
    measure?: boolean;
    /** For acceptance check: Worker deliberately sleeps this long before returning `done` (acceptance check for K4 "wait on slow frames") */
    debugSleepMs?: number;
  }
  | { type: "release"; stageId: string }
  /** For probe: report diagnostics */
  | { type: "diag"; stageId: string; seq: number };

export type GlFromWorker =
  | { type: "ready"; ok: boolean; error?: string; renderer?: string; samples?: number }
  | { type: "regions"; stageId: string; pages: Array<{ w: number; h: number }>; regions: Record<string, { page: number; x: number; y: number; w: number; h: number }> }
  | {
    type: "done"; stageId: string; seq: number; t: number;
    bitmaps: Map<string, ImageBitmap>;
    /** GPU time for each card on this tick (milliseconds; only present during `measure`) */
    gpuMs?: Record<string, number>;
    /** Cards not rendered in this tick (compilation / textures not ready yet) and reasons */
    skipped?: Record<string, string>;
    error?: string;
  }
  | { type: "diag"; stageId: string; seq: number; diag: GlWorkerDiag };

export interface GlWorkerDiag {
  /** Number of live WebGL contexts in this Worker (acceptance check: exactly one) */
  contexts: number;
  stages: string[];
  programs: number;
  /** Counts of bitmaps / GL textures / THREE.Texture in texture cache and cumulative upload count */
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
     * Serializable contract for canvas cards (R9 M1). **Do not use top-level `kind`**: that name
     * is taken by media effect card categories. Cards with this field are canvas cards: `Stage`
     * renders an extra `[data-pc-gl-plane]` in wrapper layer (except `dom2d`), and the card's
     * `Component` no longer renders `<canvas>` itself; the function half is in `<id>.gl.ts` in the
     * same directory.
     */
    canvas?: CanvasContract;
  }
}
