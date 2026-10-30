export const STREAM_SEGMENT_FRAMES: number;
export function isStreamOrigin(value: unknown): value is number;
export function streamSegmentOf(frame: number, originFrame: number): number;
export function streamSegmentFirstFrame(segment: number, originFrame: number): number;
export function streamSegmentLastFrame(segment: number, originFrame: number, lastFrame?: number): number;
export function streamSegmentFrameCount(segment: number, originFrame: number, lastFrame?: number): number;
export function streamFirstFrameOf(frame: number, originFrame: number): number;
export function streamSampleOf(frame: number, originFrame: number): number;
export function streamSegmentSpan(firstFrame: number, lastFrame: number): { originFrame: number; firstSegment: number; lastSegment: number };
