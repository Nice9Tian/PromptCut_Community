/**
 * Prerender bakery (bakery): unified export point for the frame-by-frame rendering engine.
 *
 * Originally, the entire codebase was crammed into `scripts/export-frames.mjs` (nominally a CLI
 * script, but actually imported by a bunch of modules under `server/`, creating a bidirectional
 * `server ↔ scripts` dependency). Now the library is here, leaving `scripts/` with only the CLI
 * entry point. Dependency direction is one-way: `scripts/` → `server/bakery/`, not vice versa.
 *
 * Module breakdown:
 *   `ffmpeg.mjs`         : Locate ffmpeg / ffprobe, stream-encode PNGs, read ffmpeg progress
 *   `chrome.mjs`         : Launch args for chrome-headless-shell, frame-controlled page, prerender bakery lifecycle
 *   `environment.mjs`    : Probe prerender Chrome environment (OS, GPU category, Chrome major version), compute environment fingerprint
 *   `bake.mjs`           : Advance frame-by-frame and take screenshots on a prerender bakery
 *   `shards.mjs`         : Shard splitting strategy and concurrency
 *   `media.mjs`          : Media source resolution, media layer planning, frosted-glass mask padding
 *   `export.mjs`         : Full-video export arrangement (card layers → media composition → audio tracks)
 *   `audio-mix.mjs`      : Offline audio mixing inside Chrome
 *   `export-unified.mjs` : Unified pipeline: each shard directly streams out the video
 * Additional components for frame-by-frame capture / readiness determination: `capture-frame.mjs`,
 * `capture-snapshot.mjs`, `frame-ready.mjs`, `frame-media.mjs`, `chrome-health.mjs`,
 * `png-integrity.mjs`, `browser-loss.mjs`, `frame-video.mjs`, `mux-audio.mjs`. These are imported
 * directly by file name, not re-exported from here.
 */
export { findFfmpeg, streamPngVideo } from './ffmpeg.mjs';
export { openBakery } from './chrome.mjs';
export { probeBrowserEnvironment } from './environment.mjs';
export { bakeFrames } from './bake.mjs';
export { balancedShards, resolveWorkers } from './shards.mjs';
export { mediaSourceOf } from './media.mjs';
export { exportFrames } from './export.mjs';
export { mixAudioInChrome } from './audio-mix.mjs';
