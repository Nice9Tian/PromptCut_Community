/**
 * Audio of cut segments enters export mix (the ffmpeg path): expanded clips carry the cut segment's
 * envelope, with one afade for fade-in and fade-out on each layer.
 * See src/kernel/cutAudio.mjs for rules; unit tests for expansion itself are in
 * src/kernel/cutSegments.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAudioPlan, buildFfmpegArgs } from '../bakery/mux-audio.mjs';

const project = {
  version: 1, name: 't', width: 1280, height: 720, fps: 30, duration: 20, themeId: 'midnight',
  media: [{ id: 'm1', kind: 'audio', name: 'm', url: '/@media/m.wav', duration: 60 }],
  tracks: [{ id: 'ta', name: 'ta', clips: [{ id: 's1', cardId: '', cutId: 'B', start: 10, end: 14, fadeIn: 2, params: {} }] }],
  cuts: [
    { id: 'A', name: 'A' },
    { id: 'B', name: 'B', tracks: [{ id: 'tb', name: 'tb', clips: [{ id: 'v1', cardId: '', mediaId: 'm1', mediaOffset: 1, start: 0, end: 4, fadeOut: 1, params: {} }] }], duration: 10, transitions: [] },
  ],
  activeCutId: 'A',
};

test('Audio inside a cut segment: shifted onto the segment, with the envelope becoming afade', () => {
  const plan = buildAudioPlan(project, 'out', () => true, () => 'm.wav');
  assert.equal(plan.length, 1);
  const p = plan[0];
  assert.equal(p.clipId, 's1/v1');
  assert.deepEqual([p.start, p.dur, p.offset], [10, 4, 1]);
  const args = buildFfmpegArgs('v.mp4', plan, 'out.mp4', 20);
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /afade=t=in:st=10\.000:d=2/, 'Fade-in of the segment');
  assert.match(graph, /afade=t=out:st=13\.000:d=1/, 'Fade-out of the sub-clip itself at its original start and end');
});

test('The part where the referenced cut is muted: produces no sound', () => {
  const muted = structuredClone(project);
  muted.tracks[0].clips[0].audioMuted = true;
  assert.equal(buildAudioPlan(muted, 'out', () => true, () => 'm.wav').length, 0);
});
