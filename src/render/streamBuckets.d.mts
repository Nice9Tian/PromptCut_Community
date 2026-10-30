export const STREAM_BUCKET_SEGMENTS: number;
export function streamLastSegmentOf(span: { originFrame?: unknown; lastFrame?: unknown } | null | undefined): number | null;
export function streamBucketRanges(from: number, to: number, lastSegment?: number | null): Array<{ from: number; to: number }>;
export function streamBucketManifest<T extends object>(
  manifest: T, bucket: { from: number; to: number },
): T & { range: { from: number; to: number }; segments: Record<string, unknown>; inits: Record<string, unknown> };
