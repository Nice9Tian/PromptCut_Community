/**
 * 剪辑段的声音进导出混音(ffmpeg 那条路):展开后的片段带着剪辑段的包络,每层的淡入淡出各一条 afade。
 * 规则见 src/kernel/cutAudio.mjs;展开本身的单测在 src/kernel/cutSegments.test.mjs。
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

test('剪辑段里的声音:平移到段上,包络变成 afade', () => {
  const plan = buildAudioPlan(project, 'out', () => true, () => 'm.wav');
  assert.equal(plan.length, 1);
  const p = plan[0];
  assert.equal(p.clipId, 's1/v1');
  assert.deepEqual([p.start, p.dur, p.offset], [10, 4, 1]);
  const args = buildFfmpegArgs('v.mp4', plan, 'out.mp4', 20);
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /afade=t=in:st=10\.000:d=2/, '段的淡入');
  assert.match(graph, /afade=t=out:st=13\.000:d=1/, '子片段自己按原起止的淡出');
});

test('被引用剪辑静音那一段:不出声', () => {
  const muted = structuredClone(project);
  muted.tracks[0].clips[0].audioMuted = true;
  assert.equal(buildAudioPlan(muted, 'out', () => true, () => 'm.wav').length, 0);
});
