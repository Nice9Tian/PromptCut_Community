/**
 * Pixel work of `frame-video.mjs`, running in worker threads: PNG decoding → compositing transparent
 * areas onto checkerboard (`png-post.mjs` `shrink`, original size) → PNG encoding.
 *
 * Why not do it on the main thread: all three steps are synchronous pngjs decode / encode plus
 * pixel-by-pixel loops, taking over a hundred milliseconds for one 1080p frame. The main thread of
 * the prerender process is simultaneously the Vite server serving modules to prerender Chrome and
 * the CDP connection driving Chrome; encoding the entire preview video (hundreds of frames) on the
 * main thread caused every page switch over several minutes to wait tens of seconds, making queue
 * fine-grained tasks 5-8x slower (`docs/archive/agent-reports/AGENT-uc-latency.md`; the same class
 * of issue was noted in the header of `png-post.mjs`). Algorithm and parameters are verbatim
 * identical to before, only the thread changed.
 *
 * Messages: `{ id, data: ArrayBuffer }` → `{ id, data: ArrayBuffer }` or `{ id, error }`.
 */
import { parentPort } from 'node:worker_threads';
import { PNG } from 'pngjs';
import { shrink } from '../png-post.mjs';

/**
 * One PNG frame → opaque PNG composited onto checkerboard (identical to original main-thread code
 * in `frame-video.mjs`).
 */
export function opaqueFrame(buffer) {
  const png = PNG.sync.read(buffer);
  return PNG.sync.write(shrink(png, Math.max(png.width, png.height)).png);
}

parentPort?.on('message', ({ id, data }) => {
  try {
    const out = opaqueFrame(Buffer.from(data));
    // The encoded Buffer might reside in a shared pool: copy into an independent ArrayBuffer before
    // transfer
    const copy = out.buffer.slice(out.byteOffset, out.byteOffset + out.length);
    parentPort.postMessage({ id, data: copy }, [copy]);
  } catch (error) {
    parentPort.postMessage({ id, error: String(error?.message ?? error) });
  }
});
