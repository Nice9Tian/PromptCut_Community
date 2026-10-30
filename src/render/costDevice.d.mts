import type { PipelineTuning, PipelineTuningOverrides } from './pipelineTuning.mjs';

export const COST_DEVICE_SEPARATOR: string;

export type GlRoute = 'perDocument' | 'shared';

export const COST_DEVICE_COMPACT_FIELD: string;

export function resolveGlRoute(glRoute: string | null | undefined, fallback?: GlRoute): GlRoute;

export interface CostDeviceParts {
  ua: string;
  renderer: string;
  compact: boolean;
  offscreenGl: boolean;
  glRoute?: string | null;
  mode: 'dev' | 'build' | string;
  tuning?: PipelineTuning | PipelineTuningOverrides | null;
}

export function costDeviceString(parts: CostDeviceParts): string;

export function readGpuRenderer(doc?: Document | null): string;
