import type { ClipFrame } from "./types";

export type FrameExprKey =
  | "x"
  | "y"
  | "w"
  | "h"
  | "scale"
  | "rotate"
  | "rotateX"
  | "rotateY"
  | "translateZ";

export type FrameExprMap = Partial<Record<FrameExprKey, string>>;

export const FRAME_EXPR_KEYS: readonly FrameExprKey[];

export function validateFrameExpr(raw: unknown, key?: FrameExprKey | string): string;
export function normalizeFrameExprMap(input: unknown): FrameExprMap | undefined;
export function mergeFrameExpr(
  prev: FrameExprMap | undefined,
  patch: Partial<Record<FrameExprKey, string | null | undefined>> | null | undefined,
  clearKeys?: readonly FrameExprKey[],
): FrameExprMap | undefined;
export function hasFrameExpr(frameExpr: FrameExprMap | null | undefined): boolean;
export function has3DFrameExpr(frameExpr: FrameExprMap | null | undefined): boolean;
export function hasAnimatedFrameSize(frameExpr: FrameExprMap | null | undefined): boolean;
export function stripOuterFrameExpr(frameExpr: FrameExprMap | null | undefined): FrameExprMap | undefined;
export function resolveClipFrameAt(
  frame: ClipFrame | undefined,
  frameExpr: FrameExprMap | undefined,
  localT: number,
  clipDuration: number,
): ClipFrame | undefined;
