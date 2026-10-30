export type ReadyRange = [number, number];
export type ReadyKind = 'html' | 'local' | 'stream';
export type ReadyLayer = { clipId: string; kind: ReadyKind; key: string; ranges: ReadyRange[]; groupClipIds?: string[] };
export type PickedSnapshot = { kind: ReadyKind; key: string; localFrame: number };

export function latestReadyAtOrBefore(ranges: ReadyRange[] | undefined, frame: number): number | null;
export function anchorFrames(clips: { start: number; end: number }[] | undefined, fps: number): number[];
export function segmentStartOf(anchors: Iterable<number> | undefined, frame: number): number;
export function pickSnapshotFrame(input: { ranges?: ReadyRange[]; localFrame: number; segmentStart?: number }): number | null;
export function localWindowOf(input: { globalFrame: number; firstFrame?: number; count?: number; anchors?: number[] }):
  { localFrame: number; segmentStart: number } | null;
export function pickLayerSnapshot(input: { layer?: ReadyLayer | null; globalFrame: number; firstFrame?: number; count?: number; anchors?: number[] }):
  PickedSnapshot | null;
