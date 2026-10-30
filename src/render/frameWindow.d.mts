export const CARD_MOUNT_LEAD: number;
export function cardMountedAt(clip: { start: number; end: number }, t: number): boolean;
export function mountFrameOf(clip: { start: number; end: number }, fps: number): number;
type WindowClip = { id: string; cardId?: string; start: number; end: number };
export type FrameWindow = { startFrame: number; endFrame: number; clipIds: string[]; replayClipIds: string[]; ranges: [number, number][] };
export function planFrameWindow<T extends WindowClip>(clips: T[], targetFrames: Iterable<number>, fps: number, modeOf?: (clip: T) => import('../kernel/frameMode.mjs').FrameModeInput): FrameWindow;
export function framesInWindow(ranges: Iterable<[number, number]>): Generator<number>;
