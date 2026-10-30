// filters.mjs 的类型。实现写成纯 JS 是为了 node 直接跑的服务端合成也能 import,见那边的头注释。

export type FilterKind = "brightness" | "contrast" | "saturate" | "hue" | "grayscale" | "sepia" | "invert" | "blur";

export interface FilterKindSpec {
  label: string;
  min: number;
  max: number;
  neutral: number;
  unit?: string;
  hint: string;
}

export interface FilterParamSpec {
  default: number;
  min?: number;
  max?: number;
  label?: string;
}

export type TableFilterKind = "curves" | "matrix";

/** 一步:数字,或随时间变化的表达式字符串(变量 t / d / p + 声明的参数) */
export interface ScalarFilterOp {
  kind: FilterKind;
  value: number | string;
}
/** 曲线:每通道一张 0~1 的取样表(2~33 点,线性插值)。存进工程的是补齐后的三张表 */
export interface CurvesOp {
  kind: "curves";
  r: number[];
  g: number[];
  b: number[];
}
/** 颜色矩阵:values 行优先 3×3,offset 在混色截断之后每通道再加 */
export interface MatrixOp {
  kind: "matrix";
  values: number[];
  offset: number[];
}
export type FilterOp = ScalarFilterOp | CurvesOp | MatrixOp;

/** 滤镜库里的一条(project.filters),素材库「转场/滤镜」页列的就是它 */
export interface FilterDef {
  id: string;
  name: string;
  description?: string;
  params?: Record<string, FilterParamSpec>;
  ops: FilterOp[];
  createdBy?: "agent" | "user";
  createdAt?: number;
}

/** 片段上挂的滤镜:引用库里的一条 + 逐段覆盖参数 */
export interface ClipFilter {
  id: string;
  params?: Record<string, number>;
  /** 停用:挂载和逐段参数都留着,这一段上不生效。闸门在 `filterOfClip` */
  off?: boolean;
}

export interface ResolvedScalarOp {
  kind: FilterKind;
  value: number;
}
export type ResolvedOp = ResolvedScalarOp | CurvesOp | MatrixOp;

export interface FfmpegStage {
  filter: "lutrgb" | "colorchannelmixer" | "gblur";
  opts: Record<string, number | string>;
  linear?: { slope: number; icpt: number };
  /** 查表 / 矩阵的步骤:不随时间变,sendcmd 不重发 */
  fixed?: boolean;
}

export const FILTER_KINDS: Record<FilterKind, FilterKindSpec>;
export const TABLE_KINDS: Record<TableFilterKind, { label: string; hint: string }>;
export const MAX_TABLE_POINTS: number;
export const MAX_CURVES_OPS: number;
export function isTableKind(kind: unknown): kind is TableFilterKind;
export function isNeutralOp(op: ResolvedOp): boolean;
export function svgFilterId(op: CurvesOp | MatrixOp): string;
export function svgFilterMarkup(op: CurvesOp | MatrixOp): string;
export function ensureSvgFilter(op: CurvesOp | MatrixOp, doc?: Document | null): string;
export function tableLutExpr(table: number[]): string;
export const MAX_OPS: number;
export const MAX_PARAMS: number;
export const MAX_EXPR_LEN: number;
export const BASE_VARS: string[];
export const EXPR_HELP: string;
export class FilterExprError extends Error {}

export const RESERVED: Set<string>;
export function normalizeParamDecls(rawParams: unknown, extraReserved?: Set<string>): Record<string, FilterParamSpec>;
export function compiledOf(src: string, vars: string[]): { fn: (env: Record<string, number>) => number; uses: Set<string>; ast?: ExprNode };
export function compileExpr(src: string, vars?: string[]): { fn: (env: Record<string, number>) => number; uses: Set<string>; ast: ExprNode };

/** 表达式语法树:像素映射的分类器和 GLSL 翻译按形状看,所以是数据不是闭包 */
export type ExprNode =
  | { t: "num"; v: number }
  | { t: "var"; name: string }
  | { t: "neg"; a: ExprNode }
  | { t: "bin"; op: "+" | "-" | "*" | "/" | "%" | "^"; a: ExprNode; b: ExprNode }
  | { t: "call"; name: string; args: ExprNode[] };
export function parseExpr(src: string, vars?: string[]): { ast: ExprNode; uses: Set<string> };
export function astToFn(ast: ExprNode): (env: Record<string, number>) => number;
export const FUNC_ARITY: Readonly<Record<string, number>>;
export function sampleTable(table: number[], v: number): number;
export function applyTableOp(op: CurvesOp | MatrixOp, rgb: number[]): number[];
export function applyTableOps(ops: ResolvedOp[], rgb: number[]): number[];
export function normalizeFilterDef(input: unknown): Omit<FilterDef, "id" | "createdBy" | "createdAt">;
export function normalizeClipParams(def: FilterDef, input: unknown): Record<string, number> | undefined;
export function resolveOps(def: Pick<FilterDef, "ops" | "params">, clipParams: Record<string, number> | undefined, t: number, d: number): ResolvedOp[];
export function isAnimated(def: Pick<FilterDef, "ops" | "params">): boolean;
export function describeFilter(def: Pick<FilterDef, "ops">): string;
export function cssFilter(ops: ResolvedOp[], pxScale?: number): string;
export function colorMatrix(kind: FilterKind, v: number): number[] | null;
export function ffmpegStages(ops: ResolvedOp[], blurScale?: number): FfmpegStage[];
export function blurPadOf(sigma: number): number;
export function ffmpegChain(stages: FfmpegStage[], tag?: string, blurPad?: number): string;
export function ffmpegStaticChain(ops: ResolvedOp[], blurScale?: number): string;
export function sendcmdScript(
  def: Pick<FilterDef, "ops" | "params">,
  clipParams: Record<string, number> | undefined,
  d: number,
  frames: { ts: number; t: number }[],
  tag: string,
  blurScale?: number,
  fps?: number,
): { script: string; blurPad: number };
export function filterOfClip(project: { filters?: FilterDef[] }, clip: { filter?: ClipFilter } | null | undefined): FilterDef | null;
export function clipFilterOpsAt(project: { filters?: FilterDef[] }, clip: { filter?: ClipFilter; start: number; end: number }, T: number): ResolvedOp[] | null;
