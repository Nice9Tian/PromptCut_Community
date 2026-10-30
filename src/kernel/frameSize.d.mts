import type { ClipFrame } from './types';
export interface FrameSize { w: number; h: number }
export function resolveFrameSize(frame: ClipFrame | undefined, parent: { width: number; height: number }): FrameSize;
