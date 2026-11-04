/**
 * Shared project and production steps for the two R8 track stream probes (`stream-produce-probe.mjs` /
 * `stream-play-probe.mjs`).
 *
 * Three heavy cards (all are stateful cards marked `independent` in review table; enter prerender set
 * by declaration when there are no cost records):
 *   - Particle background filling full screen (bottommost layer), 0-5 seconds: 10 segments, relied on
 *     for "continuous production of 10 segments pays only one page turn";
 *   - Punchline pill, 640×360 box centered in frame, overlapping with particles: relied on for isolation
 *     (pill is a solid pill in theme blue, blue should not appear in green particle stream); its box is
 *     smaller than the frame, also relied on for tight rectangle;
 *   - Entity chips (`entity-chips`, 800×450 box), 0.5-2 seconds: in point not on segment boundary;
 *     (originally used generic Lottie card; after Lottie was changed to remotion-style
 *     [`frameMode: "direct"`] it is declared as light card and does not enter prerender set without
 *     cost records, so replaced with `entity-chips` which still declares `stateful` and is
 *     `independent` in review table);
 *   - Odometer (frosted-glass HUD, `belowDependent`) pressed on bottom-left of particle background,
 *     0-5 seconds: relied on for "frosted-glass card overlaid on stream `<canvas>` blurs correctly":
 *     it live renders as usual during playback, blurring the stream canvas below.
 *     **It does not enter streams in these two probes**: below-dependent cards have their own stream
 *     (`kind: below`) when classified as heavy, whereas what is needed here is precisely "it live renders,
 *     pressed over another card's stream" (as in production when classified as light), so disable such
 *     streams below (`PROMPTCUT_TEST_BELOW_STREAMS=0`, affects only probe processes importing this file).
 *     Producing and pasting this kind of stream is verified in `stream-below-probe.mjs` and
 *     `stream-below-stage-probe.mjs`.
 *
 * **Did not use two particle cards**: when two particle cards are mounted at the same time, the one
 * mounted later will have `tsParticles.load` destroy the container of the earlier one as the same id
 * (container id comes from engine's shared random number; testing showed as soon as the later one mounts,
 * `<canvas>` of the earlier one is detached by `CanvasManager.destroy`): this is an existing issue in
 * `particles.tsx`, same in export, unrelated to track streams, see report.
 */
import '../lib/no-user-dirs.mjs'; // First import: does not inherit external PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR; outputs do not land in the user's Videos\PromptCut
import { FramePipeline } from '../../server/frame-pipeline.mjs';

// See file header: frosted-glass card does not enter streams in these two probes (live renders
// pressed on streams)
process.env.PROMPTCUT_TEST_BELOW_STREAMS = '0';

export const PROJECT = {
  id: 'r8-stream-probe', name: 'R8 track stream probe', width: 1920, height: 1080, fps: 30, duration: 5,
  themeId: 'dark', media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {},
  tracks: [
    { id: 'tr-glass', name: 'glass', hidden: false, clips: [
      { id: 'clip-glass', kind: 'card', cardId: 'odometer', start: 0, end: 5, params: {}, frame: { x: 80, y: 600, w: 760, h: 420 } },
    ] },
    { id: 'tr-pill', name: 'pill', hidden: false, clips: [
      { id: 'clip-pill', kind: 'card', cardId: 'punch-pill', start: 0, end: 2, params: { text: '轨道流' }, frame: { x: 960, y: 540, w: 640, h: 360, anchor: [0.5, 0.5] } },
    ] },
    { id: 'tr-red', name: 'chips', hidden: false, clips: [
      { id: 'clip-red', kind: 'card', cardId: 'entity-chips', start: 0.5, end: 2, params: {}, frame: { x: 300, y: 200, w: 800, h: 450 } },
    ] },
    { id: 'tr-bg', name: 'bg', hidden: false, clips: [
      { id: 'clip-bg', kind: 'card', cardId: 'particles', start: 0, end: 5, params: { color: '#30ff60', quantity: 120, speed: 1.5, size: 4, links: 'yes', seed: 3 } },
    ] },
  ],
};

export async function until(fails, label, fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let value = null;
    try { value = await fn(); } catch { value = null; }
    if (value) return value;
    if (Date.now() > deadline) { fails.push(`Timeout: ${label}`); return null; }
    await new Promise(r => setTimeout(r, everyMs));
  }
}

/**
 * Spins up a `FramePipeline` in this process (same code as prerender process), feeds project, and
 * waits for all streams to reach full density.
 * Returns `{ pipeline, producer, layers, produceMs }`; `layers` are `kind: 'stream'` layers emitted
 * by ready index.
 */
export async function produceStreams({ origin, root, project = PROJECT, fails }) {
  const pipeline = new FramePipeline({ root, origin: () => origin, interactive: true, playhead: () => null });
  // Segment bytes are served by probe's own HTTP server (`handleStreamRequest`), meaning read endpoint
  // is connected
  pipeline.streamProducer().attachRoute();
  const layers = [];
  pipeline.readyIndex.subscribe(message => { if (message.type === 'layer' && message.kind === 'stream') layers.push(message); });
  const started = Date.now();
  await pipeline.preload(project);
  const producer = await until(fails, 'producer is up', () => pipeline._streams?.streams.size ? pipeline._streams : null, 120000);
  if (!producer) return { pipeline, producer: null, layers, produceMs: Date.now() - started };
  const done = await until(fails, 'all segments at full density', () => {
    const status = producer.status();
    if (!status.streams.length) return null;
    for (const s of status.streams) {
      for (let n = s.firstSegment; n <= s.lastSegment; n++) if (s.segments[n]?.stride !== 1) return null;
    }
    return !producer.workers.size && !producer.encoding.size ? status : null;
  }, 600000, 1000);
  return { pipeline, producer: done ? producer : null, layers, produceMs: Date.now() - started };
}

/** Last `stream` layer for each clipId in ready index */
export function latestLayers(layers) {
  const byClip = new Map();
  for (const m of layers) byClip.set(m.clipId, m);
  return [...byClip.values()];
}
