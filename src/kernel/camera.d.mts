import type { StageSize, WorldPoint } from "./space3d.ts";

export type CutKind = "2d" | "3d";
export type NumOrExpr = number | string;

export interface Camera2DParams {
  x?: NumOrExpr;
  y?: NumOrExpr;
  zoom?: NumOrExpr;
  rotate?: NumOrExpr;
}

export interface Camera3DParams {
  x?: NumOrExpr;
  y?: NumOrExpr;
  z?: NumOrExpr;
  rx?: NumOrExpr;
  ry?: NumOrExpr;
  rz?: NumOrExpr;
  fovDeg?: NumOrExpr;
}

export type CameraClipParams = Camera2DParams & Camera3DParams;

export interface CameraClip {
  id: string;
  name?: string;
  /** 0-based lane row; higher row overrides lower row when active ranges overlap. */
  row?: number;
  start: number;
  end: number;
  enabled?: boolean;
  params: CameraClipParams;
}

export interface ResolvedCamera2D {
  x: number;
  y: number;
  zoom: number;
  rotate: number;
  activeClipId: string | null;
}

export interface ResolvedCamera3D {
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  fovDeg: number;
  position: WorldPoint;
  right: WorldPoint;
  forward: WorldPoint;
  up: WorldPoint;
  near: number;
  far: number;
  distance: number;
  activeClipId: string | null;
}

export const CUT_KINDS: readonly CutKind[];
export const CAMERA_2D_KEYS: readonly ("x" | "y" | "zoom" | "rotate")[];
export const CAMERA_3D_KEYS: readonly ("x" | "y" | "z" | "rx" | "ry" | "rz" | "fovDeg")[];

export function cameraDistanceForStage(height: number, fovDeg?: number): number;
export function cutKindOf(cut: { kind?: unknown } | null | undefined): CutKind;
export function activeCutEntry<C extends { id: string }>(
  project: { cuts?: readonly C[]; activeCutId?: string } | null | undefined,
): C | undefined;
export function activeCutKind(
  project: { cuts?: readonly { id: string; kind?: unknown }[]; activeCutId?: string } | null | undefined,
): CutKind;
export function effectiveCamera3dFov(
  project: { camera3dFov?: number; cuts?: readonly { id: string; kind?: unknown; camera3dFov?: number }[]; activeCutId?: string } | null | undefined,
  cut?: { kind?: unknown; camera3dFov?: number } | null,
): number | undefined;
export function defaultCutFovDeg(
  project: { camera3dFov?: number; cuts?: readonly { id: string; kind?: unknown; camera3dFov?: number }[]; activeCutId?: string } | null | undefined,
  cut?: { kind?: unknown; camera3dFov?: number } | null,
): number;
export function cutSpaceSize(
  project: { width?: number; height?: number; cuts?: readonly { id: string; spaceWidth?: number; spaceHeight?: number }[]; activeCutId?: string } | null | undefined,
  cut?: { spaceWidth?: number; spaceHeight?: number } | null,
): StageSize;
export function validateCameraParams(
  params: unknown,
  kind?: CutKind,
  opts?: { partial?: boolean },
): Record<string, NumOrExpr | null>;
export function mergeCameraParams(
  prev: CameraClipParams | undefined,
  patch: unknown,
  kind?: CutKind,
): CameraClipParams;
export function assertCameraLaneNoOverlap(
  cameras: readonly CameraClip[] | undefined,
  candidate: { start: number; end: number; row?: number; name?: string },
  ignoreId?: string,
): void;
export function sortCameraClips(cameras: readonly CameraClip[] | undefined): CameraClip[];
export function activeCameraClipAt(cameras: readonly CameraClip[] | undefined, t: number): CameraClip | null;
export function resolveCamera2DAt(cameras: readonly CameraClip[] | undefined, t: number): ResolvedCamera2D;
export function isIdentityCamera2D(cam: ResolvedCamera2D | null | undefined): boolean;
export function camera2DCssTransform(
  cam: ResolvedCamera2D | null | undefined,
  stage: StageSize,
): { transformOrigin: string; transform: string } | null;
export function resolveCamera3DAt(
  cameras: readonly CameraClip[] | undefined,
  stage: StageSize,
  t: number,
  defaultFovDeg?: number,
): ResolvedCamera3D;
export function defaultCamera2D(): { x: number; y: number; zoom: number; rotate: number };
export function defaultCamera3D(
  project: { height?: number; camera3dFov?: number; cuts?: readonly { id: string; kind?: unknown; camera3dFov?: number }[]; activeCutId?: string } | null | undefined,
  cut?: { kind?: unknown; camera3dFov?: number } | null,
): { x: number; y: number; z: number; rx: number; ry: number; rz: number; fovDeg: number };
