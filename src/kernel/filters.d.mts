// Types for filters.mjs. Written in pure JS so server-side composition running directly in Node
// can also import it; see the header comment there.

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

/** One step: number, or time-varying expression string (variables t / d / p + declared parameters) */
export interface ScalarFilterOp {
  kind: FilterKind;
  value: number | string;
}
/** Curve: 0~1 sample table per channel (2~33 points, linear interpolation). Three padded tables saved */
export interface CurvesOp {
  kind: "curves";
  r: number[];
  g: number[];
  b: number[];
}
/** Color matrix: values row-major 3×3, offset added per channel after blend clamping */
export interface MatrixOp {
  kind: "matrix";
  values: number[];
  offset: number[];
}
export type FilterOp = ScalarFilterOp | CurvesOp | MatrixOp;

/** An entry in filter library (project.filters), listed on media library "Transitions/Filters" tab */
export interface FilterDef {
  id: string;
  name: string;
  description?: string;
  params?: Record<string, FilterParamSpec>;
  ops: FilterOp[];
  createdBy?: "agent" | "user";
  createdAt?: number;
}

/** Filter on clip: references an entry in the library + per-clip override parameters */
export interface ClipFilter {
  id: string;
  params?: Record<string, number>;
  /** Disabled: attachment and per-clip params kept, inactive on this clip. Gate in `filterOfClip` */
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
  /** Lookup table / matrix steps: time-invariant, sendcmd does not re-send */
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

/** Expression AST: pixel map classifier and GLSL translation inspect shape, so it is data, not a closure */
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
