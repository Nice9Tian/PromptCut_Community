import { normalizeFrameMode } from '../kernel/frameMode.mjs';

// Shared with Stage: include the pre-mount frame so Motion's animation anchor
// is identical to a sequential render. Clip start/end remain absolute.
export const CARD_MOUNT_LEAD = 0.05;
export const cardMountedAt = (clip, t) => t >= clip.start - CARD_MOUNT_LEAD && t < clip.end;

/** The frame at which Stage mounts this clip: the first frame n with n / fps >= start - lead.
 * Exact comparisons only (no 1e-6 tolerance): at a 1 ulp boundary preview and export
 * both mount one frame late, which keeps them identical. This is the single mount formula;
 * preview, shard planning and the frame window all derive from it. */
export function mountFrameOf(clip, fps) {
  const lead = clip.start - CARD_MOUNT_LEAD;
  let n = Math.max(0, Math.ceil(lead * fps));
  while (n > 0 && (n - 1) / fps >= lead) n--;
  while (n / fps < lead) n++;
  return n;
}

/** Only animation cards visible at one of the requested frames need history.
 * Video/image offsets are direct seeks and never extend the replay window.
 * A batch keeps one forward pass; later cards mount at their own boundaries.
 */
export function planFrameWindow(clips, targetFrames, fps, modeOf = () => 'stateful') {
  const frames = [...new Set(targetFrames)].sort((a, b) => a - b);
  if (!frames.length || !Number.isFinite(fps) || fps <= 0 || frames.some(n => !Number.isSafeInteger(n) || n < 0)) throw new Error('Invalid frame window');
  const selected = (clips || []).filter(clip => (clip.cardId || clip.nodeId) && frames.some(n => cardMountedAt(clip, n / fps)));
  const replayClips = selected.filter(clip => normalizeFrameMode(modeOf(clip)) !== 'direct');
  const ranges = frames.map(frame => [frame, frame]);
  for (const clip of replayClips) {
    // Same comparison as Stage, including floating-point boundaries (e.g. 10.05 - 0.05).
    const n = mountFrameOf(clip, fps);
    ranges.push([n, Math.max(...frames.filter(frame => cardMountedAt(clip, frame / fps)))]);
  }
  const merged = [];
  for (const range of ranges.sort((a, b) => a[0] - b[0])) {
    const prev = merged.at(-1);
    if (prev && range[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], range[1]);
    else merged.push([...range]);
  }
  return { startFrame: merged[0][0], endFrame: frames.at(-1), clipIds: selected.map(clip => clip.id),
    replayClipIds: replayClips.map(clip => clip.id), ranges: merged };
}
/** No expanding a long timeline into a huge in-memory array. Direct-only gaps
 * are skipped; every frame needed by a stateful card is retained.
 */
export function* framesInWindow(ranges) {
  for (const [start, end] of ranges) for (let frame = start; frame <= end; frame++) yield frame;
}
