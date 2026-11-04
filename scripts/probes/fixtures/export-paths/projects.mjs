/**
 * Two fixture projects used by export-paths-measure.mjs (Xin: measure both desktop app export paths
 * once each).
 *
 * The project is not hand-written JSON, but a "recipe": the probe builds it in the editor page
 * according to the recipe using store actions (newProject followed by addClipOnNewTrack, setClipParams),
 * so card default parameters, clip fields, and asset fields are all written by the app itself and do
 * not become stale across versions. The assembled project JSON is then handed simultaneously to the
 * desktop path (persisted as export-<id>/project.json) and the online path (loadProject in the page).
 *
 *   demo   Demo project for pixel baseline. The recipe comes from the table in Section 1 of
 *          docs/archive/topics/export-baseline-compare.md (the repository lacks the original
 *          make-fixture.mjs, rebuilt here from the table): 1280x720, 30 fps, 8 seconds (240 frames),
 *          text layer (punch-pill 0-2.5 / odometer 2.5-5 / mu-word-rotate 5-8), resident layer
 *          chapter-bar 0-8, chart layer growth-curve 2-6, 3D layer scene-3d 1-5, particle layer
 *          particles 0-8, asset layer (320x180 testsrc2 video, fill) 0-8.
 *   heavy  Project with heavy cards and canvas cards: same size and duration, a video layer as base,
 *          stacked with a canvas card (particles, max count capped at 400, with connecting lines),
 *          two WebGL cards (scene-3d, terminal-3d), and growth-curve, rank-bars, chapter-bar,
 *          punch-pill. Particle cards and 3D cards are stateful (the kind pushed from scratch each
 *          frame), making them the most expensive cards in prerender and export. Only one particle
 *          card is included: putting two particle cards in the same project (even with different
 *          seeds and counts) causes desktop export to wait indefinitely for "ready" on warmup
 *          frames, reporting "Controls, fonts, or images not ready within 20 seconds" after 20
 *          seconds (measured on 2026-10-12, see docs/archive/agent-reports/AGENT-rr-export-measure.md).
 *
 * Recipe layers are stacked bottom to top (written first is on bottom). `params` specifies only the
 * keys to override; the rest use card defaults.
 */

export const FIXTURE_VIDEO = { name: 'pc-export-paths-fixture.mp4', width: 320, height: 180, fps: 30, seconds: 8 };

const W = 1280, H = 720, FPS = 30, DURATION = 8;

export const PROJECTS = {
  demo: {
    name: 'export-paths-demo',
    note: 'Demo project for the pixel baseline (rebuilt per section 1 of docs/archive/topics/export-baseline-compare.md)',
    width: W, height: H, fps: FPS, duration: DURATION,
    layers: [
      { media: true, start: 0, end: 8 },
      { cardId: 'particles', start: 0, end: 8 },
      { cardId: 'scene-3d', start: 1, end: 5 },
      { cardId: 'growth-curve', start: 2, end: 6 },
      { cardId: 'chapter-bar', start: 0, end: 8 },
      { cardId: 'mu-word-rotate', start: 5, end: 8 },
      { cardId: 'odometer', start: 2.5, end: 5 },
      { cardId: 'punch-pill', start: 0, end: 2.5 },
    ],
  },
  heavy: {
    name: 'export-paths-heavy',
    note: 'Project with a heavy card (WebGL, stateful) and a canvas card (particles)',
    width: W, height: H, fps: FPS, duration: DURATION,
    layers: [
      { media: true, start: 0, end: 8 },
      { cardId: 'particles', start: 0, end: 8, params: { quantity: 400, speed: 2.4, size: 3, links: 'yes', color: '#8ab4ff', seed: 7 } },
      { cardId: 'scene-3d', start: 0, end: 8 },
      { cardId: 'terminal-3d', start: 1, end: 7 },
      { cardId: 'growth-curve', start: 2, end: 6 },
      { cardId: 'rank-bars', start: 3, end: 8 },
      { cardId: 'chapter-bar', start: 0, end: 8 },
      { cardId: 'punch-pill', start: 0, end: 2.5 },
    ],
  },
};
