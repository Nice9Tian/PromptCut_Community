/**
 * **CLI entry point** for frame-by-frame export (`npm run export`).
 *
 * The render engine itself is no longer here: the entire suite (locating ffmpeg, opening
 * prerender rooms, frame-by-frame rendering, chunking, asset parsing, full-video arrangement,
 * in-Chrome audio mixing) moved into `server/bakery/`; see `server/bakery/index.mjs`.
 * This file only does two things: parse arguments and pass them to `exportFrames`.
 *
 * The `export *` line below is a compatibility re-export kept for legacy callers outside the
 * repository: inside the repository, always import `server/bakery/...` directly instead of
 * going through here.
 */
import { fileURLToPath } from 'url';
import { exportFrames } from '../server/bakery/index.mjs';

export * from '../server/bakery/index.mjs';

const isMain = import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  // Chunk by machine resources by default; explicit --workers 1 reproduces the single-process path.
  const opts = { noVideo: false, workers: 'auto' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--url') opts.url = args[++i];
    else if (args[i] === '--workers') opts.workers = args[++i];
    else if (args[i] === '--media') opts.media = args[++i];
    else if (args[i] === '--audio') opts.audio = args[++i]; // ffmpeg: does not use Chrome audio mixing (no audio effects), used to reconcile
    else if (args[i] === '--out') opts.out = args[++i];
    else if (args[i] === '--frames') opts.frames = args[++i];
    else if (args[i] === '--fps') opts.fps = parseFloat(args[++i]);
    else if (args[i] === '--warm') opts.warm = parseInt(args[++i], 10);
    else if (args[i] === '--no-video') opts.noVideo = true;
    else if (args[i] === '--format') opts.format = args[++i];
    else if (args[i] === '--quality') opts.quality = parseInt(args[++i], 10);
    else if (args[i] === '--static-skip') opts.staticSkip = true;
    else if (args[i] === '--dom-cache') opts.domCache = true;
    else if (args[i] === '--target-frames') opts.targetFrames = args[++i].split(',').map(Number).filter(Number.isFinite);
  }
  exportFrames(opts).catch(e => {
    console.error(e);
    process.exit(1);
  });
}
