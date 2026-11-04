import { mediaTierPolicy, remoteMediaUrl } from "../mediaTier";

/**
 * Media URL referenced by the card itself: as is on desktop (`/@media/<hash>`); online browser mode
 * lacks a local editor process, replaced with original size on the remote asset service
 * (with a read-only ticket; drawing cards to canvas and export both require original size).
 * When the remote URL is not ready, return `""`, which fails decoding immediately without requests.
 * (When media effect cards cannot run in online preview, they do not crash and are produced by render
 * nodes; this handles remaining calls that reach this path.)
 */
function cardMediaUrl(url: string): string {
  const p = mediaTierPolicy();
  if (!p.online) return url;
  return p.remote ? remoteMediaUrl(url, p.remote) : "";
}

/**
 * The seek target is slightly later (in seconds) than the desired time t. The rule is "take the
 * last frame in the media with a timestamp not exceeding t; when t falls exactly on a frame boundary,
 * take the frame on that boundary": setting t directly to `currentTime`, for t falling on a frame
 * boundary (common in slow motion, speed changes, or clip starts not at 0), floating-point error
 * and browser truncation to microseconds can make it less than 1 microsecond earlier than that frame's
 * timestamp, retrieving the previous frame: whether it gets the previous or current frame fluctuates
 * with error, making slow-motion clips stutter.
 * Uniformly add 2 ms without relying on media frame rate: less than one frame of any common media
 * (under 500 fps), and the same number as in `src/render/frameMedia.ts`.
 */
export const CARD_SEEK_LEAD = 0.002;

/** Value actually set to `currentTime` when fetching the frame at `time`: adds `CARD_SEEK_LEAD`,
 * clamped to [0, duration − 0.1 ms] (upper bound omitted when duration is unknown). */
export function cardSeekTarget(time: number, duration: number): number {
  const target = Math.max(0, time) + CARD_SEEK_LEAD;
  return Number.isFinite(duration) ? Math.min(target, Math.max(0, duration - .0001)) : target;
}

/** Waiting after seek for the new frame to become the element's current frame: recheck interval (ms)
 * and maximum wait per frame (ms). See comment on `CardMediaSource.frame`. */
const SETTLE_POLL_MS = 1;
const SETTLE_LIMIT_MS = 500;
/**
 * If the same asset fails to match after waiting the full `SETTLE_LIMIT_MS` for this many consecutive
 * frames, pause waiting (fall back to only waiting for seeked) until a frame matches on the spot,
 * then resume. For example, when the video track is shorter than asset duration and the target
 * falls after the last frame: the frame slot always holds the last frame and never matches, so it
 * should not wait in vain on every frame. */
const SETTLE_GIVE_UP = 2;

/**
 * Whether the video element's "current frame" at this moment (the frame obtained by
 * `createImageBitmap(video)`) is the frame where `currentTime` resides.
 * Frame start and end are taken from `new VideoFrame(video)` `timestamp` / `duration` (microseconds);
 * `currentTime` is truncated to microseconds following Chrome's practice, leaving 1 µs on each side
 * for rounding. Returns true / false; when unable to determine (no WebCodecs, cannot read frames from
 * the element, frame has no duration and timestamp is not later than target), returns null and callers
 * treat it as "matched", falling back to the legacy behavior of only waiting for seeked.
 */
export function currentFrameCovers(video: HTMLVideoElement): boolean | null {
  if (typeof VideoFrame === "undefined") return null;
  let frame: VideoFrame;
  try { frame = new VideoFrame(video); } catch { return null; }
  try {
    const at = Math.trunc(video.currentTime * 1e6);
    const start = frame.timestamp, length = frame.duration;
    if (start > at + 1) return false;
    if (!length) return null;
    return at < start + length + 1;
  } finally { frame.close(); }
}

/** A decoder belongs to one card canvas. Seeking it never touches a timeline
 * media element or another card's source cursor. GPU registration can therefore
 * sample video locally without a server round trip or per-frame PNG transfer. */
export class CardMediaSource {
  private sources = new Map<string, Promise<HTMLVideoElement | HTMLImageElement>>();
  /** One frame-fetch queue per video element: seek → fetch must exclusively occupy the element
   * throughout; interleaved fetches would grab each other's frames */
  private queues = new Map<string, Promise<unknown>>();
  /** Number of consecutive times each asset waited until the limit was reached */
  private settleMisses = new Map<string, number>();
  private disposed = false;
  /** For diagnostics (read by `scripts/probes/video-seek-race-probe.mjs`): number of extra waits
   * when the frame slot was not yet the target frame after seeked */
  settleWaits = 0;
  async frame(media: { url: string; kind?: string; type?: string; duration?: number }, time: number, signal?: AbortSignal): Promise<ImageBitmap> {
    if (this.disposed || signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (!this.sources.has(media.url)) {
      const image = media.kind === 'image' || media.type?.startsWith('image') || /\.(png|jpg|jpeg|webp|gif|svg)(?:[?#]|$)/i.test(media.url);
      const source = image ? new Image() : document.createElement('video');
      if (source instanceof HTMLVideoElement) { source.muted = true; source.preload = 'auto'; source.playsInline = true; }
      const ready = new Promise<HTMLVideoElement | HTMLImageElement>((resolve, reject) => {
        const event = image ? 'load' : 'loadeddata';
        source.addEventListener(event, () => resolve(source), { once: true });
        source.addEventListener('error', () => reject(new Error('Card media could not be decoded: ' + media.url)), { once: true });
        const src = cardMediaUrl(media.url);
        if (!src) { reject(new Error('Card media is not reachable yet: ' + media.url)); return; }
        source.src = src;
      });
      this.sources.set(media.url, ready);
    }
    const source = await this.sources.get(media.url)!;
    if (this.disposed || signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (!(source instanceof HTMLVideoElement)) return createImageBitmap(source, { premultiplyAlpha: 'none' });
    const prior = this.queues.get(media.url) ?? Promise.resolve();
    const turn = prior.catch(() => {}).then(() => this.videoFrame(media.url, source, time, signal));
    this.queues.set(media.url, turn);
    return turn;
  }
  /**
   * Set currentTime → wait for seeked → wait for new frame to become element's current frame
   * → fetch frame.
   *
   * Waiting only for seeked is not enough: in Chrome, after seek finishes, the newly decoded frame is
   * dispatched by the media thread along two paths: one posts to the frame slot used for compositing
   * (which is what `createImageBitmap(video)` reads), and the other notifies the main thread to emit
   * seeked. The two paths run on their respective threads; when the machine is busy, the main thread
   * may receive seeked first, and fetching the frame immediately still retrieves the frame from before
   * seek (roughly 1 in 10,000 under full load in `scripts/probes/video-seek-race-probe.mjs`).
   * Therefore, after seeked, use `currentFrameCovers` to verify whether the frame in the frame slot is
   * the one where currentTime resides; if not, recheck after `SETTLE_POLL_MS`. The verification only
   * reads the frame's timestamp and does not depend on the compositor emitting frames (the export page
   * controls frame output via beginFrame; waiting for compositor callbacks could deadlock with the exporter).
   */
  private async videoFrame(url: string, source: HTMLVideoElement, time: number, signal?: AbortSignal): Promise<ImageBitmap> {
    if (this.disposed || signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const target = cardSeekTarget(time, source.duration);
    // When the previous fetch was canceled, seek may still be in flight: currentTime is already
    // the target, but the new frame has not arrived yet, so still wait for seeked
    if (source.seeking || Math.abs(source.currentTime - target) > .00001) await new Promise<void>((resolve, reject) => {
      const cleanup = () => { source.removeEventListener('seeked', done); source.removeEventListener('error', failed); signal?.removeEventListener('abort', cancelled); };
      const done = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error('Card video seek failed')); };
      const cancelled = () => { cleanup(); reject(new DOMException('Cancelled', 'AbortError')); };
      source.addEventListener('seeked', done, { once: true }); source.addEventListener('error', failed, { once: true }); signal?.addEventListener('abort', cancelled, { once: true });
      if (Math.abs(source.currentTime - target) > .00001) source.currentTime = target;
    });
    const misses = this.settleMisses.get(url) ?? 0;
    let covered = currentFrameCovers(source);
    if (covered === false && misses < SETTLE_GIVE_UP) {
      this.settleWaits++;
      const start = performance.now();
      while (covered === false && performance.now() - start < SETTLE_LIMIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS));
        if (this.disposed || signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
        covered = currentFrameCovers(source);
      }
      if (covered === false) {
        this.settleMisses.set(url, misses + 1);
        if (misses + 1 >= SETTLE_GIVE_UP) console.warn(`Frame timestamps of the media effect card video source keep failing to match currentTime; pausing checks until they match again: ${url}`);
      }
    }
    // Reset to zero upon a match (still check as usual while verification is suspended,
    // and resume verification once matched)
    if (covered === true && misses) this.settleMisses.set(url, 0);
    return createImageBitmap(source, { premultiplyAlpha: 'none' });
  }
  dispose() {
    this.disposed = true;
    for (const promise of this.sources.values()) void promise.then(source => {
      if (source instanceof HTMLVideoElement) source.pause(); source.removeAttribute('src');
      if (source instanceof HTMLVideoElement) source.load();
    }, () => {});
    this.sources.clear();
    this.queues.clear();
  }
}
