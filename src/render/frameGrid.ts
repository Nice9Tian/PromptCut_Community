/**
 * Align a timestamp to **the batch of frames that export will actually render**.
 *
 * Export is advanced frame by frame: the timestamp of frame i is simply i/fps, and intermediate
 * timestamps do not exist at all. Therefore, "when a card mounts" can only be some i/fps during
 * export, rather than a continuous value like `start - LEAD`. If preview mounts using a continuous
 * value, the card's time origin differs from the final video by less than a frame: for "play upon
 * mount" cards (the vast majority), this small discrepancy falls on the steepest section of the
 * entrance animation, making it visible on screen.
 *
 * Actual test (mu-circular-progress, 1.2s easeOut cubic, in point 1.0s, 30fps, same t=1.0):
 * export 6%, preview before alignment 9%, after alignment 6%: identical frame by frame thereafter.
 */

/**
 * Returns the timestamp of **which frame** sec falls on.
 *
 * "When to mount" is answered by mountFrameOf in frameWindow.mjs (the first frame not earlier than
 * it); this answers "which frame is on screen at this moment": in the final video, frame i covers
 * [i/fps, (i+1)/fps), so it floors.
 *
 * Used by the playhead: the final video is fps frames, whereas preview advances continuous time at
 * the monitor refresh rate, causing preview to stop at a timestamp that **does not exist at all**
 * in the final video. The difference is less than one frame, but the 3D side displays prerendered
 * full frames, revealing the discrepancy when comparing the two views.
 *
 * ⚠ Direction of tolerance: `29/30 * 30` is 28.999999999999996 in floating point; directly flooring
 * falls back to frame 28, inadvertently classifying a timestamp on the frame grid into the previous
 * frame.
 */
export function atFrameGrid(sec: number, fps: number): number {
  const f = Math.max(1, fps);
  const n = Math.floor(sec * f + 1e-6);
  return n <= 0 ? 0 : n / f;
}
